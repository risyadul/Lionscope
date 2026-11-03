#!/usr/bin/env node
// Positive and negative controls for scripts/check-docs.mjs on the README split.
//
//   node scripts/check-docs-controls.mjs [--base <git ref of the pre-split README>]
//
// The base defaults to the map's `base` (97b3e01), so the controls keep working after the split is merged.
// Copies the tracked files to a temporary directory, then for each control applies one mutation, runs the
// checker as a child process and compares its exit code with the expected one (0 for a positive control,
// nonzero for a negative one). Exits 1 if any control gets an unexpected exit code.

import { execFileSync, spawnSync } from 'node:child_process';
import console from 'node:console';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const map = path.join(repo, 'scripts/docs-section-map.json');
const baseIdx = process.argv.indexOf('--base');
const base = baseIdx > 0 ? process.argv[baseIdx + 1] : JSON.parse(readFileSync(map, 'utf8')).base;
if (!base) {
  console.error('usage: node scripts/check-docs-controls.mjs [--base <git ref of the pre-split README>]');
  process.exit(2);
}

/** Replaces exactly one occurrence of `from` in `file`. */
const replace = (file, from, to) => (root) => {
  const abs = path.join(root, file);
  const text = readFileSync(abs, 'utf8');
  const n = text.split(from).length - 1;
  if (n !== 1)
    throw new Error(`control setup: ${JSON.stringify(from.slice(0, 60))} occurs ${n} times in ${file}`);
  writeFileSync(
    abs,
    text.replace(from, () => to),
  );
};

const NETWORK_PARA = 'The release build keeps the same line with `lionscope-noop`';
const paragraphOf = (root, file, start) => {
  const text = readFileSync(path.join(root, file), 'utf8');
  const i = text.indexOf(start);
  if (i < 0) throw new Error(`control setup: no ${start} in ${file}`);
  return text.slice(i, text.indexOf('\n\n', i));
};

const SAFETY_NOTE =
  '- `--allow-device-control` keeps an AI from operating a device unasked; it is not a security boundary, since\n';

const ADDED = (text) => `<!-- docs:added -->\n\n${text}\n\n<!-- /docs:added -->`;
const writeFile = (file, text) => (root) => {
  mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
  writeFileSync(path.join(root, file), text);
};
const SLUG_PROBE = '# x\n\n## x-1\n\n## x\n\n';

const controls = [
  ['positive: HEAD as committed', 0, 'migration', () => {}],
  [
    'positive: table re-padded (only cell padding changes)',
    0,
    'migration',
    replace('docs/configuration.md', '| `--port <port>`          |', '| `--port <port>` |'),
  ],
  [
    'negative: one safety note deleted',
    1,
    'migration',
    (root) => {
      const abs = path.join(root, 'docs/agents.md');
      const text = readFileSync(abs, 'utf8');
      const start = text.indexOf(SAFETY_NOTE);
      if (start < 0) throw new Error('control setup: safety note not found');
      const end = text.indexOf('\n- ', start + 1);
      const stop = end < 0 ? text.indexOf('\n\n', start) : end + 1;
      writeFileSync(abs, text.slice(0, start) + text.slice(stop));
    },
  ],
  [
    'negative: paragraph moved to another file (network → stalls)',
    1,
    'migration',
    (root) => {
      const para = paragraphOf(root, 'docs/features/network.md', NETWORK_PARA);
      replace('docs/features/network.md', `${para}\n\n`, '')(root);
      const stalls = path.join(root, 'docs/features/stalls.md');
      writeFileSync(stalls, `${readFileSync(stalls, 'utf8')}\n${para}\n`);
    },
  ],
  [
    'negative: two paragraphs swapped within a file',
    1,
    'migration',
    (root) => {
      const file = 'docs/sdk.md';
      const a = paragraphOf(root, file, '**Screen names.**');
      const b = paragraphOf(root, file, '**Navigation Compose.**');
      replace(file, `${a}\n\n${b}`, `${b}\n\n${a}`)(root);
    },
  ],
  [
    'negative: paragraph duplicated',
    1,
    'migration',
    (root) => {
      const para = paragraphOf(root, 'docs/features/network.md', NETWORK_PARA);
      replace('docs/features/network.md', para, `${para}\n\n${para}`)(root);
    },
  ],
  [
    'negative: one code line changed (trailing space)',
    1,
    'migration',
    replace('docs/development.md', 'npm run typecheck\n', 'npm run typecheck \n'),
  ],
  [
    'negative: heading level changed',
    1,
    'migration',
    replace('docs/agents.md', '## Safety notes', '### Safety notes'),
  ],
  [
    'negative: new text outside docs:added',
    1,
    'migration',
    replace('docs/security.md', '# Security model\n', '# Security model\n\nA sentence nobody reviewed.\n'),
  ],
  [
    'negative: marked docs:added region the allowlist lacks (new heading over the safety notes)',
    1,
    'migration',
    replace('docs/agents.md', '## Safety notes\n', `## Safety notes\n\n${ADDED('## Unreviewed section')}\n`),
  ],
  [
    'negative: text inside an allowlisted docs:added region edited',
    1,
    'migration',
    replace(
      'README.md',
      'See [Known limitations](docs/limitations.md).',
      'See [Limitations](docs/limitations.md).',
    ),
  ],
  [
    'negative: allowlisted docs:added region moved',
    1,
    'migration',
    (root) => {
      const abs = path.join(root, 'docs/sdk.md');
      const text = readFileSync(abs, 'utf8');
      const end = text.indexOf('<!-- /docs:added -->') + '<!-- /docs:added -->'.length;
      writeFileSync(abs, `${text.slice(end).trimStart().trimEnd()}\n\n${text.slice(0, end)}\n`);
    },
  ],
  [
    'negative: declared text rewrite not applied ("(below)" back)',
    1,
    'migration',
    replace('docs/features/layout-inspector.md', '(see [The SDK](../sdk.md))', '(below)'),
  ],
  [
    'positive: GitHub slug registry (x, x-1, x gives #x-2)',
    0,
    'links',
    writeFile('docs/slug-probe.md', `${SLUG_PROBE}[a](#x) [b](#x-1) [c](#x-2)\n`),
  ],
  [
    'negative: slug that GitHub never assigns (#x-3)',
    1,
    'links',
    writeFile('docs/slug-probe.md', `${SLUG_PROBE}[d](#x-3)\n`),
  ],
  [
    'negative: README stub "## Use with AI agents" removed',
    1,
    'migration',
    replace('README.md', '## Use with AI agents\n', '## Agents\n'),
  ],
  [
    'negative: broken #anchor',
    1,
    'links',
    replace(
      'docs/agents.md',
      '](#letting-an-agent-operate-the-device)',
      '](#letting-an-agent-operate-a-device)',
    ),
  ],
  [
    'negative: broken cross-file link',
    1,
    'links',
    replace('docs/features/layout-inspector.md', '](../security.md)', '](security.md)'),
  ],
  [
    'negative: broken <picture> srcset',
    1,
    'links',
    replace('README.md', 'srcset="docs/images/dashboard-dark.png"', 'srcset="images/dashboard-dark.png"'),
  ],
  [
    'negative: broken <img> src in a moved page',
    1,
    'links',
    replace(
      'docs/features/network.md',
      'src="../images/dashboard-network.png"',
      'src="images/dashboard-network.png"',
    ),
  ],
  [
    "negative: dashboard's docs URL points at a missing page",
    1,
    'links',
    replace(
      'dashboard/src/components/device/AgentPanel.tsx',
      'Lionscope/blob/main/docs/agents.md',
      'Lionscope/blob/main/docs/agent.md',
    ),
  ],
  [
    "negative: dashboard's docs URL points at a missing anchor",
    1,
    'links',
    replace(
      'dashboard/src/components/device/AgentPanel.tsx',
      "main/docs/agents.md'",
      "main/docs/agents.md#use-with-agents'",
    ),
  ],
];

const tmp = mkdtempSync(path.join(os.tmpdir(), 'lionscope-docs-controls-'));
try {
  const files = execFileSync('git', ['ls-files', '-z'], { cwd: repo, encoding: 'utf8' })
    .split('\0')
    .filter(Boolean);
  const copy = (rel) => {
    mkdirSync(path.dirname(path.join(tmp, rel)), { recursive: true });
    copyFileSync(path.join(repo, rel), path.join(tmp, rel));
  };
  files.forEach(copy);
  const oldReadme = path.join(tmp, '.old-README.md');
  writeFileSync(
    oldReadme,
    execFileSync('git', ['show', `${base}:README.md`], { cwd: repo, encoding: 'utf8' }),
  );
  const checker = path.join(repo, 'scripts/check-docs.mjs');

  let bad = 0;
  for (const [name, want, mode, mutate] of controls) {
    mutate(tmp);
    const args = [checker, '--root', tmp];
    if (mode === 'migration') args.push('--against', oldReadme, '--map', map);
    const r = spawnSync(process.execPath, args, { encoding: 'utf8' });
    const ok = want === 0 ? r.status === 0 : r.status !== 0 && r.status !== 2;
    if (!ok) bad++;
    const errs = r.stderr.split('\n').filter((l) => /^(link|migration): /.test(l));
    const firstError = errs
      .slice(0, 2)
      .map((l) => l.slice(0, 180))
      .join('\n       ');
    console.info(`${ok ? 'ok  ' : 'FAIL'} exit=${r.status} (want ${want === 0 ? '0' : 'nonzero'}) ${name}`);
    if (want !== 0 || !ok) console.info(`       ${firstError}`);
    files.forEach(copy); // undo the mutation
    rmSync(path.join(tmp, 'docs/slug-probe.md'), { force: true });
  }
  console.info(`${controls.length - bad}/${controls.length} controls as expected`);
  process.exitCode = bad ? 1 : 0;
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
