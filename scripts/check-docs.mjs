#!/usr/bin/env node
// Checks the repository's Markdown docs.
//
//   node scripts/check-docs.mjs [--root <dir>]
//     Link check: every relative link, image `src`/`srcset`/`href` and `#anchor` in README.md and docs/**/*.md
//     resolves (GitHub heading slugs, with -1/-2 suffixes for repeated headings), and every
//     https://github.com/risyadul/Lionscope URL in the docs and in the dashboard, server, CLI and skill sources
//     points at a file and anchor that exist in this tree.
//
//   node scripts/check-docs.mjs --against <old README.md | git:<ref>> [--map <file>] [--root <dir>]
//     Also the migration check for splitting README.md into docs/ (scripts/docs-section-map.json): every block
//     of the old README (paragraph, list, table, HTML, code block) appears exactly once, in order, in the file
//     the map sends its section to. The only rewrites allowed are the heading level shift the map declares,
//     link targets re-pointed to the moved content, and table cell padding. Code blocks must match byte for
//     byte. New text is allowed only between `<!-- docs:added -->` and `<!-- /docs:added -->`, and only where the
//     map's `added` allowlist puts it (file, position, sha256 of the text); `textRewrites` lists the few
//     wording changes moved text needed.
//
// Exit code: 0 when everything passes, 1 when a check fails, 2 for a usage error.

import { execFileSync } from 'node:child_process';
import console from 'node:console';
import { createHash } from 'node:crypto';
import process from 'node:process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO_URL = 'https://github.com/risyadul/Lionscope';
const ADDED_OPEN = '<!-- docs:added -->';
const ADDED_CLOSE = '<!-- /docs:added -->';
const FENCE = /^\s*(`{3,}|~{3,})/;
const HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
const SOURCE_DIRS = ['dashboard/src', 'server/src', 'cli/src', 'protocol/src', 'skills'];

/** GitHub's heading anchor: lowercased, punctuation dropped, spaces to dashes. */
export function slugify(text) {
  return text
    .replace(/`([^`]*)`/g, '$1')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/<[^>]+>/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}\p{Pc} -]/gu, '')
    .replace(/ /g, '-');
}

/**
 * Splits Markdown into blocks: a heading line, a fenced code block (blank lines included), or a run of
 * non-blank lines. Blocks between the docs:added markers are flagged `added`.
 */
export function parseBlocks(md) {
  const lines = md.replace(/\r\n/g, '\n').split('\n');
  const blocks = [];
  let current = null;
  let fence = null;
  let added = false; // the region number while inside docs:added markers, else false
  let regions = 0;
  const flush = () => {
    if (current) blocks.push(current);
    current = null;
  };
  lines.forEach((line, i) => {
    const lineNo = i + 1;
    if (fence) {
      current.lines.push(line);
      const m = line.match(FENCE);
      if (m && m[1][0] === fence[0] && m[1].length >= fence.length && line.trim() === m[1]) {
        fence = null;
        flush();
      }
      return;
    }
    if (line.trim() === ADDED_OPEN || line.trim() === ADDED_CLOSE) {
      flush();
      if (line.trim() === ADDED_OPEN) {
        if (added) blocks.push({ type: 'error', message: `nested ${ADDED_OPEN}`, line: lineNo, added });
        added = ++regions;
      } else {
        if (!added)
          blocks.push({ type: 'error', message: `${ADDED_CLOSE} without ${ADDED_OPEN}`, line: lineNo });
        added = false;
      }
      return;
    }
    const fm = line.match(FENCE);
    if (fm) {
      flush();
      fence = fm[1];
      current = { type: 'code', lines: [line], line: lineNo, added };
      return;
    }
    if (line.trim() === '') {
      flush();
      return;
    }
    const hm = line.match(HEADING);
    if (hm) {
      flush();
      blocks.push({ type: 'heading', level: hm[1].length, title: hm[2], lines: [line], line: lineNo, added });
      return;
    }
    if (!current) current = { type: 'text', lines: [], line: lineNo, added };
    current.lines.push(line);
  });
  if (fence) blocks.push({ ...current, unclosed: true });
  else flush();
  if (added) blocks.push({ type: 'error', message: `unclosed ${ADDED_OPEN}`, line: lines.length, added });
  return blocks.map((b) => ({ ...b, text: b.lines ? b.lines.join('\n') : '' }));
}

/**
 * GitHub's per-file anchor registry (github-slugger): a repeated slug gets the next free -1, -2, ...,
 * skipping suffixes another heading already took (`x`, `x-1`, `x` gives `x`, `x-1`, `x-2`).
 */
export function createSlugger() {
  const occurrences = new Map();
  return (title) => {
    const base = slugify(title);
    let slug = base;
    while (occurrences.has(slug)) {
      occurrences.set(base, occurrences.get(base) + 1);
      slug = `${base}-${occurrences.get(base)}`;
    }
    occurrences.set(slug, 0);
    return slug;
  };
}

/** Gives every heading block its GitHub anchor in this file. */
export function assignSlugs(blocks) {
  const slug = createSlugger();
  for (const b of blocks) if (b.type === 'heading') b.slug = slug(b.title);
  return blocks;
}

/** Link targets outside code blocks: Markdown `](...)` and HTML src / srcset / href attributes. */
export function linkTargets(text) {
  const out = [];
  const stripped = text.replace(/`[^`\n]*`/g, (m) => ' '.repeat(m.length));
  for (const m of stripped.matchAll(/\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g)) out.push(m[1]);
  for (const m of stripped.matchAll(/\b(?:src|href)\s*=\s*"([^"]+)"/g)) out.push(m[1]);
  for (const m of stripped.matchAll(/\bsrcset\s*=\s*"([^"]+)"/g)) {
    for (const part of m[1].split(',')) out.push(part.trim().split(/\s+/)[0]);
  }
  return out.filter(Boolean);
}

/** Applies `fn` to each link target of a text block, leaving inline code alone. */
function rewriteLinks(text, fn) {
  const parts = text.split(/(`[^`\n]*`)/);
  return parts
    .map((part, i) => {
      if (i % 2 === 1) return part;
      return part
        .replace(/(\]\(\s*<?)([^)\s>]+)/g, (_, pre, t) => pre + fn(t))
        .replace(/(\b(?:src|href)\s*=\s*")([^"]+)/g, (_, pre, t) => pre + fn(t))
        .replace(
          /(\bsrcset\s*=\s*")([^"]+)/g,
          (_, pre, set) =>
            pre +
            set
              .split(',')
              .map((p) => p.replace(/^(\s*)(\S+)/, (__, ws, t) => ws + fn(t)))
              .join(','),
        );
    })
    .join('');
}

const isExternal = (t) => /^[a-z][a-z0-9+.-]*:/i.test(t) || t.startsWith('//');

/** Table rows compare by trimmed cells, so Prettier's column padding doesn't count as a change. */
function normalizeTable(text) {
  const lines = text.split('\n');
  if (!lines.every((l) => /^\s*\|.*\|\s*$/.test(l))) return text;
  return lines
    .map((l) =>
      l
        .trim()
        .slice(1, -1)
        .split('|')
        .map((c) => {
          const cell = c.trim();
          return /^:?-+:?$/.test(cell) ? cell.replace(/-+/, '-') : cell;
        })
        .join(' | '),
    )
    .join('\n');
}

function walkMarkdown(root) {
  const files = [];
  if (existsSync(path.join(root, 'README.md'))) files.push('README.md');
  const walk = (dir) => {
    const abs = path.join(root, dir);
    if (!existsSync(abs)) return;
    for (const name of readdirSync(abs).sort()) {
      const rel = path.posix.join(dir, name);
      if (statSync(path.join(root, rel)).isDirectory()) walk(rel);
      else if (name.endsWith('.md')) files.push(rel);
    }
  };
  walk('docs');
  return files;
}

function walkSources(root) {
  const files = [];
  const walk = (dir) => {
    const abs = path.join(root, dir);
    if (!existsSync(abs)) return;
    for (const name of readdirSync(abs).sort()) {
      if (name === 'node_modules' || name === 'dist') continue;
      const rel = path.posix.join(dir, name);
      if (statSync(path.join(root, rel)).isDirectory()) walk(rel);
      else if (/\.(ts|tsx|js|mjs|md|json)$/.test(name)) files.push(rel);
    }
  };
  SOURCE_DIRS.forEach(walk);
  return files;
}

function loadDocs(root) {
  const docs = new Map();
  for (const file of walkMarkdown(root)) {
    const blocks = assignSlugs(parseBlocks(readFileSync(path.join(root, file), 'utf8')));
    docs.set(file, { blocks, slugs: new Set(blocks.filter((b) => b.slug).map((b) => b.slug)) });
  }
  return docs;
}

/** Resolves a target as seen from `fromFile` (repo-relative) to { file, anchor }, or null if external. */
function resolveTarget(fromFile, target) {
  if (target.startsWith(REPO_URL)) {
    const rest = target.slice(REPO_URL.length);
    const m = rest.match(/^(?:\/(?:blob|tree)\/main\/([^#?]*))?\/?(?:#(.*))?$/);
    if (!m) return { file: null, anchor: null, unsupported: true };
    return { file: m[1] ? decodeURIComponent(m[1]).replace(/\/$/, '') : 'README.md', anchor: m[2] ?? null };
  }
  if (isExternal(target)) return null;
  const [p, anchor] = target.split('#');
  const file = p === '' ? fromFile : path.posix.normalize(path.posix.join(path.posix.dirname(fromFile), p));
  return { file: file.replace(/\/$/, ''), anchor: anchor ?? null };
}

function checkTarget(root, docs, fromFile, target) {
  const r = resolveTarget(fromFile, target);
  if (!r) return null;
  if (r.unsupported) return `unsupported repository URL ${target}`;
  if (r.file.startsWith('..')) return `${target} leaves the repository`;
  const abs = path.join(root, r.file);
  if (!existsSync(abs)) return `${target} → ${r.file} does not exist`;
  if (r.anchor) {
    const doc = docs.get(r.file);
    if (!doc) return `${target} → ${r.file} is not a checked Markdown file, can't verify #${r.anchor}`;
    if (!doc.slugs.has(decodeURIComponent(r.anchor)))
      return `${target} → no heading #${r.anchor} in ${r.file}`;
  }
  return null;
}

export function checkLinks(root) {
  const errors = [];
  const docs = loadDocs(root);
  let count = 0;
  for (const [file, { blocks }] of docs) {
    for (const b of blocks) {
      if (b.type === 'error') errors.push(`${file}:${b.line}: ${b.message}`);
      if (b.unclosed) errors.push(`${file}:${b.line}: unclosed code fence`);
      if (b.type === 'code') continue;
      for (const t of linkTargets(b.text)) {
        count++;
        const err = checkTarget(root, docs, file, t);
        if (err) errors.push(`${file}:${b.line}: ${err}`);
      }
    }
  }
  const urlPattern = new RegExp(`${REPO_URL.replace(/[.]/g, '\\.')}[^\\s'"\`)<>]*`, 'g');
  for (const file of walkSources(root)) {
    const text = readFileSync(path.join(root, file), 'utf8');
    for (const m of text.matchAll(urlPattern)) {
      const url = m[0].replace(/[.,;]+$/, '');
      if (url === REPO_URL || url === `${REPO_URL}.git`) continue;
      count++;
      const line = text.slice(0, m.index).split('\n').length;
      const err = checkTarget(root, docs, 'README.md', url);
      if (err) errors.push(`${file}:${line}: ${err}`);
    }
  }
  return { errors, count, files: docs.size };
}

/** Old README sections: each heading with its own blocks, and its parent (the nearest higher-level heading). */
function sections(blocks) {
  const out = [];
  const stack = [];
  let current = null;
  for (const b of blocks) {
    if (b.type === 'heading') {
      while (stack.length && stack[stack.length - 1].level >= b.level) stack.pop();
      current = { slug: b.slug, level: b.level, parent: stack[stack.length - 1] ?? null, blocks: [b] };
      stack.push(current);
      out.push(current);
    } else {
      if (!current) throw new Error(`old README: block at line ${b.line} comes before the first heading`);
      current.blocks.push(b);
    }
  }
  return out;
}

/** What each target file must contain, built from the old README and the map. */
export function buildExpected(oldMd, map) {
  const errors = [];
  const oldBlocks = assignSlugs(parseBlocks(oldMd));
  const secs = sections(oldBlocks);
  const bySlug = new Map(secs.map((s) => [s.slug, s]));
  const entries = map.entries.map((e, i) => ({ ...e, index: i, blocks: [] }));
  for (const e of entries) {
    if (!bySlug.has(e.from)) errors.push(`map entry ${e.index}: no heading #${e.from} in the old README`);
    if (!e.to) errors.push(`map entry ${e.index}: no "to"`);
  }
  if (errors.length) return { errors };

  // Each old block goes to the most specific entry: its section's own entry (from `fromBlock` on, if set),
  // else its nearest mapped ancestor's.
  const entriesFor = new Map();
  for (const e of entries) {
    if (!entriesFor.has(e.from)) entriesFor.set(e.from, []);
    entriesFor.get(e.from).push(e);
  }
  const owner = (sec, blockIdx) => {
    for (let s = sec, own = true; s; s = s.parent, own = false) {
      const list = entriesFor.get(s.slug) ?? [];
      let pick = null;
      for (const e of list) {
        if (!e.fromBlock) {
          if (!pick) pick = e;
          continue;
        }
        const start = s.blocks.findIndex((b) => b.text.startsWith(e.fromBlock));
        if (start < 0) {
          errors.push(
            `map entry ${e.index}: no block starting with ${JSON.stringify(e.fromBlock)} in #${s.slug}`,
          );
          continue;
        }
        // Descendant sections come after all of this section's own blocks, so they belong to the split part.
        if (!own || blockIdx >= start) pick = e;
      }
      if (pick) return pick;
    }
    return null;
  };
  for (const s of secs) {
    s.blocks.forEach((b, i) => {
      const e = owner(s, i);
      if (!e) errors.push(`old README line ${b.line}: block not covered by any map entry`);
      else e.blocks.push(b);
    });
  }
  for (const e of entries) {
    if (!e.blocks.length) errors.push(`map entry ${e.index} (#${e.from}) gets no blocks`);
  }

  // Targets in map order; within an entry, old document order.
  const files = new Map();
  for (const e of entries) {
    if (!files.has(e.to)) files.set(e.to, []);
    for (const b of e.blocks) {
      const shift = e.shift ?? 0;
      if (b.type === 'heading' && (b.level + shift < 1 || b.level + shift > 6)) {
        errors.push(
          `map entry ${e.index}: shift ${shift} puts line ${b.line} at heading level ${b.level + shift}`,
        );
      }
      files.get(e.to).push({ old: b, shift });
    }
  }

  // Where each old heading ends up, for re-pointing anchors. Slugs are recomputed per target file.
  const moved = new Map();
  // Added headings aren't counted here; checkMigration fails if an added heading shifts a moved heading's anchor.
  for (const [file, items] of files) {
    const slugger = createSlugger();
    items.forEach((it, idx) => {
      if (it.old.type !== 'heading') return;
      const slug = slugger(it.old.title);
      const top = idx === 0 && it.old.level + it.shift === 1;
      moved.set(it.old.slug, { file, slug, top });
    });
  }
  const relative = (fromFile, toFile) => {
    const rel = path.posix.relative(path.posix.dirname(fromFile), toFile);
    return rel === '' ? path.posix.basename(toFile) : rel;
  };
  const rewriteFor = (file) => (target) => {
    if (isExternal(target)) return target;
    const [p, anchor] = target.split('#');
    if (p === '' && anchor !== undefined) {
      const m = moved.get(anchor);
      if (!m) return target; // a dead anchor stays dead; the link check reports it
      if (m.file === file) return `#${m.slug}`;
      return m.top ? relative(file, m.file) : `${relative(file, m.file)}#${m.slug}`;
    }
    const abs = path.posix.normalize(p); // old README sits at the repository root
    return relative(file, abs) + (anchor !== undefined ? `#${anchor}` : '');
  };

  const expected = new Map();
  for (const [file, items] of files) {
    const fix = rewriteFor(file);
    expected.set(
      file,
      items.map(({ old, shift }) => {
        if (old.type === 'code') return { type: 'code', text: old.text, oldLine: old.line };
        if (old.type === 'heading') {
          return {
            type: 'heading',
            text: `${'#'.repeat(old.level + shift)} ${rewriteLinks(old.title, fix)}`,
            slug: moved.get(old.slug).slug,
            oldLine: old.line,
          };
        }
        return { type: 'text', text: rewriteLinks(old.text, fix), oldLine: old.line };
      }),
    );
  }
  // Text rewrites the map declares (e.g. "(below)" that now points into another file): each `from` must occur
  // exactly once in the file's moved text, outside code blocks.
  (map.textRewrites ?? []).forEach((r, i) => {
    const blocks = (expected.get(r.file) ?? []).filter((b) => b.type !== 'code');
    const hits = blocks.reduce((n, b) => n + (b.text.split(r.from).length - 1), 0);
    if (hits !== 1) {
      errors.push(
        `map textRewrites[${i}]: ${JSON.stringify(r.from)} occurs ${hits} times in ${r.file}, not once`,
      );
      return;
    }
    const b = blocks.find((x) => x.text.includes(r.from));
    b.text = b.text.replace(r.from, () => r.to);
  });
  const oldTopSlugs = oldBlocks.filter((b) => b.type === 'heading' && b.level <= 2).map((b) => b.slug);
  return { errors, expected, oldBlockCount: oldBlocks.length, oldTopSlugs };
}

export function checkMigration(root, oldMd, map) {
  const { errors, expected, oldBlockCount, oldTopSlugs } = buildExpected(oldMd, map);
  if (errors.length) return { errors };
  const docs = loadDocs(root);
  let added = 0;
  let compared = 0;
  const cmp = (b) => (b.type === 'code' ? b.text : normalizeTable(b.text));
  for (const [file, { blocks }] of docs) {
    const want = expected.get(file) ?? [];
    added += checkAdded(file, blocks, want, map.added ?? [], errors);
    const have = blocks.filter((b) => !b.added && b.type !== 'error');
    const n = Math.max(want.length, have.length);
    for (let i = 0; i < n; i++) {
      const w = want[i];
      const h = have[i];
      if (w && h && cmp(w) === cmp(h)) {
        compared++;
        if (w.type === 'heading' && h.slug !== w.slug) {
          errors.push(`${file}:${h.line}: anchor is #${h.slug}, links were re-pointed to #${w.slug}`);
        }
        continue;
      }
      if (!h) {
        errors.push(`${file}: missing block from old README line ${w.oldLine}: ${preview(w.text)}`);
      } else if (!w) {
        errors.push(
          `${file}:${h.line}: block not in the old README (mark new text as docs:added): ${preview(h.text)}`,
        );
      } else {
        const [we, he] = [cmp(w), cmp(h)];
        let at = 0;
        while (at < we.length && we[at] === he[at]) at++;
        const from = Math.max(0, at - 30);
        errors.push(
          `${file}:${h.line}: differs from old README line ${w.oldLine} at character ${at}\n    expected: ${preview(we.slice(from))}\n    found:    ${preview(he.slice(from))}`,
        );
      }
      break; // after the first mismatch the rest of the file is out of step
    }
  }
  for (const file of expected.keys()) {
    if (!docs.has(file)) errors.push(`${file}: missing (the map sends content there)`);
  }
  const readme = docs.get('README.md');
  const keep = new Set([...oldTopSlugs, ...(map.keepReadmeAnchors ?? [])]);
  for (const slug of keep) {
    if (!readme?.slugs.has(slug))
      errors.push(`README.md: old anchor #${slug} is gone (bookmarks and released links use it)`);
  }
  return { errors, oldBlockCount, compared, added };
}

/**
 * New text is allowed only where the map's `added` allowlist says: per file, in order, each docs:added region
 * sits right after the moved block starting with `after` (or at the start when `after` is null) and its text
 * hashes to `sha256`. Returns the number of added blocks.
 */
function checkAdded(file, blocks, want, allowlist, errors) {
  const regions = [];
  let kept = 0;
  for (const b of blocks) {
    if (b.type === 'error') continue;
    if (!b.added) {
      kept++;
      continue;
    }
    let r = regions[regions.length - 1];
    if (!r || r.id !== b.added) regions.push((r = { id: b.added, after: kept, line: b.line, blocks: [] }));
    r.blocks.push(b);
  }
  const allowed = allowlist.filter((a) => a.file === file);
  const where = (k) =>
    k === 0 ? 'at the start' : `after the block from old README line ${want[k - 1]?.oldLine}`;
  const count = Math.max(regions.length, allowed.length);
  for (let i = 0; i < count; i++) {
    const r = regions[i];
    const a = allowed[i];
    if (!a) {
      errors.push(
        `${file}:${r.line}: docs:added region not in the map's allowlist (${where(r.after)}, sha256 ${sha(r)})`,
      );
      continue;
    }
    let k = 0;
    if (a.after !== null) {
      const hits = want.map((w, j) => (w.text.startsWith(a.after) ? j : -1)).filter((j) => j >= 0);
      if (hits.length !== 1) {
        errors.push(
          `map added (${file}): ${JSON.stringify(a.after)} starts ${hits.length} moved blocks, not one`,
        );
        continue;
      }
      k = hits[0] + 1;
    }
    if (!r) {
      errors.push(`${file}: allowlisted docs:added region ${where(k)} is missing (${a.summary ?? a.sha256})`);
      continue;
    }
    if (r.after !== k) {
      errors.push(
        `${file}:${r.line}: docs:added region is ${where(r.after)}; the allowlist puts it ${where(k)}`,
      );
    } else if (sha(r) !== a.sha256) {
      errors.push(
        `${file}:${r.line}: docs:added region's text differs from the allowlist (sha256 ${sha(r)})`,
      );
    }
  }
  return regions.reduce((n, r) => n + r.blocks.length, 0);
}

function sha(region) {
  return createHash('sha256')
    .update(region.blocks.map((b) => b.text).join('\n\n'))
    .digest('hex');
}

function preview(text) {
  const one = text.replace(/\s+/g, ' ').trim();
  return JSON.stringify(one.length > 100 ? `${one.slice(0, 100)}…` : one);
}

function main(argv) {
  const args = { root: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..') };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--root' || a === '--against' || a === '--map') {
      if (!argv[i + 1]) return usage(`${a} needs a value`);
      args[a.slice(2)] = argv[++i];
    } else if (a === '--help' || a === '-h') {
      return usage();
    } else return usage(`unknown argument ${a}`);
  }
  const root = path.resolve(args.root);
  let failed = false;

  const links = checkLinks(root);
  for (const e of links.errors) console.error(`link: ${e}`);
  console.info(
    `links: ${links.count} targets in ${links.files} Markdown files and the sources, ${links.errors.length} broken`,
  );
  failed ||= links.errors.length > 0;

  if (args.against) {
    let oldMd;
    try {
      oldMd = args.against.startsWith('git:')
        ? execFileSync('git', ['show', `${args.against.slice(4)}:README.md`], { cwd: root, encoding: 'utf8' })
        : readFileSync(args.against, 'utf8');
    } catch (err) {
      return usage(`can't read ${args.against}: ${err.message}`);
    }
    const mapFile = path.resolve(args.map ?? path.join(root, 'scripts/docs-section-map.json'));
    let map;
    try {
      map = JSON.parse(readFileSync(mapFile, 'utf8'));
    } catch (err) {
      return usage(`can't read map ${mapFile}: ${err.message}`);
    }
    const mig = checkMigration(root, oldMd, map);
    for (const e of mig.errors) console.error(`migration: ${e}`);
    console.info(
      `migration: ${mig.compared ?? 0}/${mig.oldBlockCount ?? '?'} old blocks matched, ${mig.added ?? 0} added blocks, ${mig.errors.length} problems`,
    );
    failed ||= mig.errors.length > 0;
  }
  return failed ? 1 : 0;
}

function usage(message) {
  if (message) console.error(message);
  console.error(
    'usage: node scripts/check-docs.mjs [--root <dir>] [--against <old README.md | git:<ref>>] [--map <file>]',
  );
  return 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exitCode = main(process.argv.slice(2));
}
