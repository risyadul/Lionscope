#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import console from 'node:console';
import process from 'node:process';
import { URL } from 'node:url';

const root = new URL('../', import.meta.url);
const read = (name) => readFileSync(new URL(name, root), 'utf8');
const json = (name) => JSON.parse(read(name));
const version = json('package.json').version;
const failures = [];
const check = (condition, label) => {
  if (!condition) failures.push(label);
};
const same = (actual, label) => check(actual === version, `${label}: expected ${version}, got ${actual}`);

check(/^\d+\.\d+\.\d+$/.test(version), 'Root version must be a stable semver release');
const lock = json('package-lock.json');
same(lock.version, 'lockfile root');
for (const dir of ['', 'protocol', 'server', 'dashboard', 'cli']) {
  const file = dir ? `${dir}/package.json` : 'package.json';
  const manifest = json(file);
  same(manifest.version, file);
  same(lock.packages[dir]?.version, `lockfile ${dir || 'workspace root'}`);
  for (const [name, dependency] of Object.entries(manifest.dependencies ?? {})) {
    if (name.startsWith('@lionscope/')) {
      same(dependency, `${file} dependency ${name}`);
      same(lock.packages[dir]?.dependencies?.[name], `lockfile ${dir} dependency ${name}`);
    }
  }
}
same(read('android-sdk/gradle.properties').match(/^lionscopeVersion=(.+)$/m)?.[1], 'Android SDK');
const server = json('server.json');
same(server.version, 'MCP registry metadata');
const npmPackages = server.packages.filter(
  (pkg) => pkg.registryType === 'npm' && pkg.identifier === 'lionscope',
);
check(npmPackages.length === 1, 'MCP metadata must contain the Lionscope npm package');
for (const pkg of npmPackages) same(pkg.version, 'MCP npm package');
for (const plugin of json('.claude-plugin/marketplace.json').plugins) {
  same(plugin.version, `plugin ${plugin.name}`);
  check(plugin.mcpServers.lionscope.args.includes(`lionscope@${version}`), `plugin ${plugin.name} npm pin`);
}
same(read('skills/lionscope/SKILL.md').match(/^ {2}version: (.+)$/m)?.[1], 'Packaged skill');

for (const file of [
  'README.md',
  'cli/README.md',
  'docs/sdk.md',
  'skills/lionscope/SKILL.md',
  'dashboard/src/components/topbar/SdkStatus.tsx',
]) {
  const text = read(file);
  const pins = [...text.matchAll(/(?:lionscope(?:-noop)?:|lionscope@)(\d+\.\d+\.\d+)/g)];
  check(pins.length > 0, `${file}: missing current installation pin`);
  for (const pin of pins) same(pin[1], `${file} installation pin`);
}
check(read('docs/development.md').includes(`default \`${version}\``), 'Development SDK default');
check(read('CHANGELOG.md').includes(`## [${version}] - `), 'Missing current changelog heading');
check(
  read('CHANGELOG.md').includes(`/compare/${version}...HEAD`),
  'Unreleased comparison must start at current version',
);

if (failures.length) {
  console.error(`Release metadata check failed:\n${failures.map((failure) => `- ${failure}`).join('\n')}`);
  process.exitCode = 1;
} else {
  console.log(`Release metadata consistent: ${version}`);
}
