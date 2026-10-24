import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { z } from 'zod';
import { inputJsonSchema } from '../src/agent/registry.ts';
import type { AgentTool } from '../src/agent/tool.ts';
import { resolveTool } from '../src/cli/queryCommand.ts';

// The agent skill, the Claude Code marketplace and the MCP Registry metadata ship with each release: they must
// name tools, arguments and values that exist, and the version being released.
const root = (path: string) => fileURLToPath(new URL(`../../${path}`, import.meta.url));
const read = (path: string) => readFileSync(root(path), 'utf8').replace(/\r\n/g, '\n');
const cli = JSON.parse(read('cli/package.json')) as { version: string; mcpName: string };

const skill = read('skills/lionscope/SKILL.md');
const frontmatter = /^---\n([\s\S]*?)\n---\n/.exec(skill)?.[1] ?? '';
/** Code spans, also those wrapped over lines, as words. */
// Fenced blocks first: their backticks would pair up with the spans' and shift every span after them.
const spans = [...skill.replace(/```[\s\S]*?```/g, '').matchAll(/`([^`]+)`/g)].map((m) =>
  (m[1] ?? '').trim().split(/\s+/),
);
/** Flags of the CLI itself, valid on any call. */
const GLOBAL_FLAGS = new Set(['allowDeviceControl', 'allowNetworkBodies', 'json', 'port', 'list']);
const camel = (flag: string) => flag.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
const isPlaceholder = (value: string) => /[<>…|{}]/.test(value);

/** The tool a span calls: a tool name first, or `query <short name>` anywhere in it. */
function toolOf(words: readonly string[]): AgentTool | undefined {
  const query = words.indexOf('query');
  if (query !== -1) {
    const name = words[query + 1];
    if (name === undefined || name.startsWith('-') || isPlaceholder(name)) return undefined;
    const tool = resolveTool(name);
    expect(tool, `\`query ${name}\` names no tool`).toBeDefined();
    return tool;
  }
  const first = words[0] ?? '';
  return /^[a-z]+(?:_[a-z]+)*$/.test(first) ? resolveTool(first) : undefined;
}

/** `--name value` pairs (a bare flag has no value). */
function flagsOf(words: readonly string[]): { name: string; value: string | undefined }[] {
  const flags: { name: string; value: string | undefined }[] = [];
  words.forEach((word, i) => {
    const name = /^--([a-zA-Z-]+)$/.exec(word)?.[1];
    if (name === undefined) return;
    const next = words[i + 1];
    flags.push({ name: camel(name), value: next === undefined || next.startsWith('--') ? undefined : next });
  });
  return flags;
}

/** A flag's text typed like `lionscope query` types it (numbers and booleans from the schema). */
function coerce(raw: string, schema: { type?: string; anyOf?: { type?: string }[] } | undefined): unknown {
  const types = schema?.anyOf?.map((option) => option.type) ?? [schema?.type];
  if (types.includes('boolean') && (raw === 'true' || raw === 'false')) return raw === 'true';
  if ((types.includes('number') || types.includes('integer')) && Number.isFinite(Number(raw)))
    return Number(raw);
  return raw.replace(/^"(.*)"$/, '$1');
}

describe('agent skill', () => {
  it('is a valid Agent Skill named after its folder, at the release version', () => {
    expect(frontmatter).toMatch(/^name: lionscope$/m);
    const description = /^description: >-\n((?: {2}.*\n?)+)/m
      .exec(frontmatter)?.[1]
      ?.replace(/\s+/g, ' ')
      .trim();
    expect(description?.length).toBeGreaterThan(0);
    expect(description!.length).toBeLessThanOrEqual(1024);
    expect(frontmatter).toMatch(new RegExp(`^ {2}version: ${cli.version.replaceAll('.', '\\.')}$`, 'm'));
  });

  it('pins the npm package and the SDK to the release version', () => {
    const pins = [...skill.matchAll(/lionscope(?:-noop)?[@:](\d+\.\d+\.\d+)/g)].map((m) => m[1]);
    expect(pins.length).toBeGreaterThanOrEqual(4);
    expect(new Set(pins)).toEqual(new Set([cli.version]));
  });

  it('calls only tools, arguments and values the server has', () => {
    const called = new Set<string>();
    let last: AgentTool | undefined;
    for (const words of spans) {
      const tool = toolOf(words);
      // A span of flags alone (`--status 5xx`) belongs to the call before it.
      const target = tool ?? (words[0]?.startsWith('--') ? last : undefined);
      if (tool) {
        last = tool;
        called.add(tool.name);
      }
      if (!target) continue;
      const schema = inputJsonSchema(target) as { properties?: Record<string, { type?: string }> };
      const shape = (target.input as unknown as z.ZodObject).shape as Record<string, z.ZodType>;
      for (const { name, value } of flagsOf(words)) {
        if (GLOBAL_FLAGS.has(name)) continue;
        expect(Object.keys(schema.properties ?? {}), `${target.name} has no argument --${name}`).toContain(
          name,
        );
        if (value === undefined || isPlaceholder(value)) continue;
        const parsed = shape[name]?.safeParse(coerce(value, schema.properties?.[name]));
        expect(parsed?.success, `${target.name} --${name} ${value} is not a valid value`).toBe(true);
      }
    }
    // The playbooks reach the tools a task starts and ends with.
    for (const name of ['status', 'start_session', 'get_summary', 'get_stalls', 'revert_view_properties']) {
      expect([...called]).toContain(name);
    }
    expect([...called]).toContain('stop_session');
  });
});

describe('distribution metadata', () => {
  it('pins the Claude Code plugins to the released npm package', () => {
    const marketplace = JSON.parse(read('.claude-plugin/marketplace.json')) as {
      plugins: {
        name: string;
        version: string;
        skills: string[];
        mcpServers: Record<string, { args: string[] }>;
      }[];
    };
    expect(marketplace.plugins.map((p) => p.name)).toEqual(['lionscope', 'lionscope-device-control']);
    for (const plugin of marketplace.plugins) {
      expect(plugin.version).toBe(cli.version);
      expect(plugin.skills).toEqual(['./skills/lionscope']);
      expect(plugin.mcpServers.lionscope?.args).toContain(`lionscope@${cli.version}`);
    }
    expect(marketplace.plugins[0]!.mcpServers.lionscope!.args).not.toContain('--allow-device-control');
    expect(marketplace.plugins[1]!.mcpServers.lionscope!.args).toContain('--allow-device-control');
  });

  it('describes the npm package to the MCP Registry under the package’s mcpName', () => {
    const server = JSON.parse(read('server.json')) as {
      name: string;
      version: string;
      description: string;
      packages: { identifier: string; version: string }[];
    };
    expect(server.name).toBe(cli.mcpName);
    expect(server.version).toBe(cli.version);
    expect(server.description.length).toBeLessThanOrEqual(100);
    expect(server.packages).toEqual([
      expect.objectContaining({ identifier: 'lionscope', version: cli.version }),
    ]);
  });
});
