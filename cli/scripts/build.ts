/**
 * Builds the `lionscope` npm package: the server (with protocol, ws and zod) bundled into one ESM file with no
 * runtime dependencies, the built dashboard next to it, and the license files. Run after the dashboard build.
 */
import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const cliDir = fileURLToPath(new URL('..', import.meta.url));
const repoDir = path.dirname(cliDir.replace(/[\\/]$/, ''));
const dashboardDist = path.join(repoDir, 'dashboard', 'dist');
const outFile = path.join(cliDir, 'dist', 'lionscope.mjs');

// ws loads these optional native addons inside try/catch; left external, the bundle runs without them.
const OPTIONAL_NATIVE = ['bufferutil', 'utf-8-validate'];
const BANNER = [
  '#!/usr/bin/env node',
  // CommonJS dependencies (ws) call require() for Node built-ins.
  "import { createRequire as __lionscopeCreateRequire } from 'node:module';",
  'const require = __lionscopeCreateRequire(import.meta.url);',
].join('\n');

interface PackageInfo {
  name: string;
  version: string;
  license: string;
  dir: string;
}

function readPackage(dir: string): PackageInfo {
  const json = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8')) as Record<string, unknown>;
  return {
    name: String(json.name),
    version: String(json.version),
    license: typeof json.license === 'string' ? json.license : 'see package',
    dir,
  };
}

/** Node's lookup: `node_modules/<name>` in `from` and each parent directory. */
function findPackageDir(name: string, from: string): string {
  for (let dir = from; ; dir = path.dirname(dir)) {
    const candidate = path.join(dir, 'node_modules', name);
    if (existsSync(path.join(candidate, 'package.json'))) return candidate;
    if (path.dirname(dir) === dir) throw new Error(`cannot find package ${name} from ${from}`);
  }
}

/** `dir`'s production dependencies, transitively (the dashboard's runtime code), keyed by package dir. */
function productionDependencies(
  dir: string,
  found = new Map<string, PackageInfo>(),
): Map<string, PackageInfo> {
  const json = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8')) as {
    dependencies?: Record<string, string>;
  };
  for (const name of Object.keys(json.dependencies ?? {})) {
    if (name.startsWith('@lionscope/')) continue;
    const info = readPackage(findPackageDir(name, dir));
    if (found.has(info.dir)) continue;
    found.set(info.dir, info);
    productionDependencies(info.dir, found);
  }
  return found;
}

function licenseText(dir: string): string {
  const file = readdirSync(dir).find((entry) => /^(licen[cs]e|copying)(\.|$)/i.test(entry));
  return file ? readFileSync(path.join(dir, file), 'utf8').trim() : '(no license file in the package)';
}

function thirdPartyNotices(packages: Iterable<PackageInfo>): string {
  const sections = [...packages]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((info) => `${info.name}@${info.version} (${info.license})\n\n${licenseText(info.dir)}`);
  return `Third-party software bundled in the lionscope package\n\n${sections.join(`\n\n${'-'.repeat(78)}\n\n`)}\n`;
}

async function main(): Promise<void> {
  if (!existsSync(path.join(dashboardDist, 'index.html'))) {
    throw new Error(`no dashboard build in ${dashboardDist}: run \`npm run build\` first`);
  }
  for (const generated of ['dist', 'dashboard', 'LICENSE', 'NOTICE']) {
    rmSync(path.join(cliDir, generated), { recursive: true, force: true });
  }

  const result = await build({
    absWorkingDir: repoDir,
    entryPoints: [path.join(repoDir, 'server', 'src', 'main.ts')],
    outfile: outFile,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    external: OPTIONAL_NATIVE,
    banner: { js: BANNER },
    // IS_BUNDLE in server/src/config.ts: serve only the packaged dashboard, warn about --dev.
    define: { __LIONSCOPE_BUNDLE__: 'true' },
    legalComments: 'none',
    // Whitespace and syntax only: identifiers stay, so stack traces remain readable.
    minifyWhitespace: true,
    minifySyntax: true,
    metafile: true,
    logLevel: 'warning',
  });
  chmodSync(outFile, 0o755);

  // Packages whose code went into the bundle (the dashboard's are its production dependencies).
  const bundled = new Map<string, PackageInfo>();
  for (const input of Object.keys(result.metafile.inputs)) {
    // Inputs are relative to absWorkingDir; the innermost node_modules segment names the package, so nested
    // copies (`a/node_modules/b`) count as their own package.
    const packagePath = /^(.*node_modules\/(?:@[^/]+\/)?[^/]+)\//.exec(input)?.[1];
    if (!packagePath) continue;
    const info = readPackage(path.join(repoDir, packagePath));
    bundled.set(`${info.name}@${info.version}`, info);
  }
  for (const info of productionDependencies(path.join(repoDir, 'dashboard')).values()) {
    bundled.set(`${info.name}@${info.version}`, info);
  }
  writeFileSync(path.join(cliDir, 'dist', 'THIRD_PARTY_NOTICES.txt'), thirdPartyNotices(bundled.values()));

  cpSync(dashboardDist, path.join(cliDir, 'dashboard'), { recursive: true });
  for (const file of ['LICENSE', 'NOTICE']) copyFileSync(path.join(repoDir, file), path.join(cliDir, file));

  const size = (readFileSync(outFile).length / 1024).toFixed(0);
  console.info(
    `Built ${path.relative(repoDir, outFile)} (${size} KB, bundles ${[...bundled.values()].map((info) => info.name).join(', ')})`,
  );
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
