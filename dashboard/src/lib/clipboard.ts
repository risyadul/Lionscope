/**
 * Desktop clipboard access for "Share clipboard". Reading needs the `clipboard-read` permission, which
 * only Chromium exposes; Firefox and Safari show a paste prompt on every read, so there it is never tried.
 * A denial is remembered for the page session so the browser is not asked again and again.
 */
import { MAX_SCREEN_CLIPBOARD_BYTES } from '@lionscope/protocol/wire';

export interface ClipboardEnv {
  clipboard: Pick<Clipboard, 'readText' | 'writeText'> | undefined;
  permissions: Pick<Permissions, 'query'> | undefined;
  hasFocus: () => boolean;
}

function browserEnv(): ClipboardEnv {
  return {
    clipboard: typeof navigator === 'undefined' ? undefined : navigator.clipboard,
    permissions: typeof navigator === 'undefined' ? undefined : navigator.permissions,
    hasFocus: () => document.hasFocus(),
  };
}

export type ReadAccess = 'unknown' | 'allowed' | 'unsupported' | 'denied';

/** Page-session memory: survives the panel collapsing and the device changing. */
let readAccess: ReadAccess = 'unknown';

export function clipboardReadAccess(): ReadAccess {
  return readAccess;
}

export function resetClipboardReadAccess(): void {
  readAccess = 'unknown';
}

/** The `clipboard-read` permission state; null where the API or the permission name is missing. */
async function readPermission(env: ClipboardEnv): Promise<PermissionState | null> {
  if (!env.clipboard?.readText || !env.permissions?.query) return null;
  try {
    const status = await env.permissions.query({ name: 'clipboard-read' as PermissionName });
    return status.state;
  } catch {
    // Firefox and Safari don't know the permission name.
    return null;
  }
}

/** Whether the clipboard may be read, worked out once without reading it (a permission query never prompts). */
export async function resolveClipboardReadAccess(env: ClipboardEnv = browserEnv()): Promise<ReadAccess> {
  if (readAccess === 'unknown') {
    const state = await readPermission(env);
    readAccess = state === null ? 'unsupported' : state === 'denied' ? 'denied' : 'allowed';
  }
  return readAccess;
}

/** True only when a read can't show a prompt: for reads that no user gesture asked for. */
export async function isClipboardReadGranted(env: ClipboardEnv = browserEnv()): Promise<boolean> {
  if (readAccess === 'unsupported' || readAccess === 'denied') return false;
  return (await readPermission(env)) === 'granted';
}

/** The desktop clipboard's text, or null when it can't (or may no longer) be read. Never throws. */
export async function readDesktopClipboard(env: ClipboardEnv = browserEnv()): Promise<string | null> {
  if ((await resolveClipboardReadAccess(env)) !== 'allowed' || !env.clipboard) return null;
  try {
    return await env.clipboard.readText();
  } catch {
    // Chromium also refuses while the page isn't focused; only a refusal in focus is a denial.
    if (env.hasFocus()) readAccess = 'denied';
    return null;
  }
}

/** Puts text on the desktop clipboard; false when the browser refuses (not focused, no user gesture…). */
export async function writeDesktopClipboard(
  text: string,
  env: ClipboardEnv = browserEnv(),
): Promise<boolean> {
  if (!env.clipboard?.writeText) return false;
  try {
    await env.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/** The paste shortcut as the viewer's keyboard labels it. */
export function pasteShortcut(
  nav: Pick<Navigator, 'platform'> | undefined = globalThis.navigator,
): '⌘V' | 'Ctrl+V' {
  const uaData = (nav as { userAgentData?: { platform?: string } } | undefined)?.userAgentData;
  const platform = uaData?.platform || nav?.platform || '';
  return /^(mac|iphone|ipad|ipod)/i.test(platform) ? '⌘V' : 'Ctrl+V';
}

/** Bytes a character takes inside a JSON string (escapes included), so the socket frame stays in bounds. */
function jsonBytes(char: string): number {
  const code = char.codePointAt(0) ?? 0;
  if (char === '"' || char === '\\') return 2;
  if (code < 0x20) return '\b\f\n\r\t'.includes(char) ? 2 : 6;
  // A lone surrogate is escaped as \uXXXX.
  if (code >= 0xd800 && code <= 0xdfff) return 6;
  return code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
}

/**
 * The longest prefix of whole code points that stays within `maxBytes` — counted as encoded in the JSON
 * message, which is never less than its UTF-8 size, so both the text and the frame limit hold.
 */
export function limitClipboardText(
  text: string,
  maxBytes = MAX_SCREEN_CLIPBOARD_BYTES,
): { text: string; isTruncated: boolean } {
  let bytes = 0;
  let end = 0;
  for (const char of text) {
    const size = jsonBytes(char);
    if (bytes + size > maxBytes) return { text: text.slice(0, end), isTruncated: true };
    bytes += size;
    end += char.length;
  }
  return { text, isTruncated: false };
}
