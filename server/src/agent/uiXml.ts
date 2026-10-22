/**
 * A strict little parser for `uiautomator dump` XML: elements and attributes only. Entities are never
 * resolved beyond the five predefined ones and character references, and a DOCTYPE (where entity
 * declarations would live) is refused outright, so there is no external entity or expansion attack surface.
 */

export const MAX_UI_XML_BYTES = 4 * 1024 * 1024;
export const MAX_UI_NODES = 5000;

export class UiXmlError extends Error {
  override name = 'UiXmlError';
}

/** One `<node>` of the dump with its attributes as written. */
export interface RawUiNode {
  attributes: Record<string, string>;
  children: RawUiNode[];
}

export interface RawUiHierarchy {
  /** `rotation` of `<hierarchy>`: 0-3 quarter turns. */
  rotation: number;
  roots: RawUiNode[];
  /** More than MAX_UI_NODES nodes: the rest was left out. */
  truncated: boolean;
}

const PREDEFINED: Readonly<Record<string, string>> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };

/** Decodes the predefined entities and character references; anything else is kept literally. */
export function decodeEntities(value: string): string {
  return value.replace(/&(#x[0-9a-fA-F]{1,6}|#[0-9]{1,7}|[a-z]{2,4});/g, (match, ref: string) => {
    if (ref.startsWith('#')) {
      const code = ref[1] === 'x' ? parseInt(ref.slice(2), 16) : parseInt(ref.slice(1), 10);
      return code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : match;
    }
    return PREDEFINED[ref] ?? match;
  });
}

const ATTRIBUTE = /([A-Za-z_:][-\w:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;

function parseAttributes(source: string): Record<string, string> {
  const attributes: Record<string, string> = {};
  for (const match of source.matchAll(ATTRIBUTE)) {
    const name = match[1] ?? '';
    attributes[name] = decodeEntities(match[2] ?? match[3] ?? '');
  }
  return attributes;
}

/** Index of the `>` closing the tag that starts before `from`; a `>` inside a quoted value does not count. */
function tagEnd(xml: string, from: number): number {
  let quote: string | null = null;
  for (let i = from; i < xml.length; i++) {
    const char = xml[i];
    if (quote !== null) {
      if (char === quote) quote = null;
    } else if (char === '"' || char === "'") quote = char;
    else if (char === '>') return i;
  }
  return -1;
}

/** Parses a dump; throws UiXmlError on anything that is not well-formed enough to trust. */
export function parseUiXml(xml: string): RawUiHierarchy {
  if (Buffer.byteLength(xml) > MAX_UI_XML_BYTES) throw new UiXmlError('UI dump over 4 MB');
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw new UiXmlError('UI dump with a DOCTYPE refused');
  const result: RawUiHierarchy = { rotation: 0, roots: [], truncated: false };
  const stack: { name: string; node: RawUiNode | null }[] = [];
  let sawHierarchy = false;
  let count = 0;
  let at = 0;
  while (at < xml.length) {
    const open = xml.indexOf('<', at);
    if (open < 0) break;
    if (xml.startsWith('<?', open) || xml.startsWith('<!--', open)) {
      const terminator = xml.startsWith('<?', open) ? '?>' : '-->';
      const end = xml.indexOf(terminator, open);
      if (end < 0) throw new UiXmlError('unterminated declaration');
      at = end + terminator.length;
      continue;
    }
    const close = tagEnd(xml, open + 1);
    if (close < 0) throw new UiXmlError('unterminated tag');
    const body = xml.slice(open + 1, close);
    at = close + 1;
    if (body.startsWith('/')) {
      const name = body.slice(1).trim();
      if (stack.pop()?.name !== name) throw new UiXmlError(`unexpected </${name}>`);
      continue;
    }
    const selfClosing = body.endsWith('/');
    const tag = /^([A-Za-z_][-\w.]*)/.exec(body)?.[1];
    if (!tag) throw new UiXmlError('malformed tag');
    const attributes = parseAttributes(body.slice(tag.length, selfClosing ? -1 : undefined));
    let node: RawUiNode | null = null;
    if (tag === 'hierarchy') {
      sawHierarchy = true;
      result.rotation = Number(attributes.rotation ?? 0) || 0;
    } else if (tag === 'node') {
      count++;
      if (count > MAX_UI_NODES) result.truncated = true;
      else {
        node = { attributes, children: [] };
        const parent = stack.findLast((entry) => entry.node !== null)?.node;
        (parent ? parent.children : result.roots).push(node);
      }
    }
    if (!selfClosing) stack.push({ name: tag, node });
  }
  if (stack.length > 0) throw new UiXmlError(`unclosed <${stack.at(-1)?.name}>`);
  if (!sawHierarchy) throw new UiXmlError('no <hierarchy> in the UI dump');
  return result;
}
