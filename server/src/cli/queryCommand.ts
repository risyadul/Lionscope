/**
 * `lionscope query <tool>`: runs one agent tool on the running server and prints its JSON result, for agents
 * that only have a shell. Tool arguments come as `--name value` flags (kebab or camel case, typed by the
 * tool's schema) and/or `--json '{...}'`. Exit code 0 on success, 1 with a JSON error on failure.
 */
import { writeFileSync } from 'node:fs';
import { AGENT_TOOLS, findTool, inputJsonSchema } from '../agent/registry.ts';
import type { ToolOutcome } from '../agent/registry.ts';
import type { AgentTool } from '../agent/tool.ts';
import { parsePort } from '../config.ts';
import { errorMessage } from '../log.ts';
import { callRemoteTool } from './agentClient.ts';

export const QUERY_USAGE = `Usage: lionscope query <tool> [--<arg> <value> ...] [--json '<arguments>'] [options]
       lionscope query --list

Runs one Lionscope agent tool on the server running on --port and prints its JSON result
(e.g. \`lionscope query summary --window 5m\`, \`lionscope query logcat --level E --limit 50\`).
Short names work without the get_ / search_ prefix. The server must already be running.

Options:
  --list                  Print every tool with its description and input schema
  --json '<object>'       Tool arguments as JSON (flags given next to it win)
  --port <port>           Dashboard port (LIONSCOPE_PORT, default 8701)
  --allow-device-control  Allow a device-control tool for this call
  --allow-network-bodies  Return HTTP body texts (get_network_request) for this call
  --out <file>            Write a screenshot's PNG to this file instead of printing it as base64
`;

class QueryError extends Error {}

interface QueryArgs {
  list: boolean;
  help: boolean;
  tool: string | null;
  port: number;
  deviceControl: boolean;
  networkBodies: boolean;
  out: string | null;
  json: string | null;
  /** Tool argument flags as given (name → raw value, or true for a bare flag). */
  flags: Map<string, string | true>;
}

const camelCase = (name: string) =>
  name.replace(/-([a-z])/g, (_match, letter: string) => letter.toUpperCase());

/** Options of `query` itself that take a value. */
const VALUE_OPTIONS: ReadonlySet<string> = new Set(['port', 'out', 'json']);

/** The tool named on the command line: the first word that is not an option or an option's value. */
function toolWord(argv: readonly string[]): string | null {
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i] ?? '';
    if (!token.startsWith('-')) return token;
    if (!token.includes('=') && VALUE_OPTIONS.has(token.replace(/^--?/, ''))) i++;
  }
  return null;
}

/** Tool arguments that are booleans: a bare `--include-stacks` never takes the next word as its value. */
function booleanArguments(tool: AgentTool | undefined): ReadonlySet<string> {
  if (!tool) return new Set();
  const properties =
    (inputJsonSchema(tool) as { properties?: Record<string, PropertySchema> }).properties ?? {};
  return new Set(
    Object.entries(properties)
      .filter(([, schema]) => schema.type === 'boolean')
      .map(([name]) => name),
  );
}

function parseQueryArgs(argv: readonly string[], env: NodeJS.ProcessEnv): QueryArgs {
  const word = toolWord(argv);
  const booleans = booleanArguments(word === null ? undefined : resolveTool(word));
  const args: QueryArgs = {
    list: false,
    help: false,
    tool: null,
    port: parsePort(env.LIONSCOPE_PORT),
    deviceControl: false,
    networkBodies: false,
    out: null,
    json: null,
    flags: new Map(),
  };
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i] ?? '';
    if (!token.startsWith('-')) {
      if (args.tool !== null) throw new QueryError(`Unexpected argument "${token}"`);
      args.tool = token;
      continue;
    }
    const body = token.replace(/^--?/, '');
    const eq = body.indexOf('=');
    const name = eq < 0 ? body : body.slice(0, eq);
    const inline = eq < 0 ? undefined : body.slice(eq + 1);
    const next = argv[i + 1];
    const value = (): string => {
      if (inline !== undefined) return inline;
      if (next === undefined || next.startsWith('--')) throw new QueryError(`--${name} needs a value`);
      i++;
      return next;
    };
    if (name === 'list') args.list = true;
    else if (name === 'help' || name === 'h') args.help = true;
    else if (name === 'allow-device-control') args.deviceControl = true;
    else if (name === 'allow-network-bodies') args.networkBodies = true;
    else if (name === 'port') args.port = parsePort(value(), '--port');
    else if (name === 'out') args.out = value();
    else if (name === 'json') args.json = value();
    else if (inline !== undefined) args.flags.set(camelCase(name), inline);
    else if (booleans.has(camelCase(name)) && next !== 'true' && next !== 'false') {
      args.flags.set(camelCase(name), true);
    } else if (next !== undefined && !next.startsWith('--')) {
      args.flags.set(camelCase(name), next);
      i++;
    } else args.flags.set(camelCase(name), true);
  }
  return args;
}

/** `stalls` → get_stalls, `logcat` → search_logcat, `list-apps` → list_apps. */
export function resolveTool(name: string): AgentTool | undefined {
  const base = name.replaceAll('-', '_');
  return findTool(base) ?? findTool(`get_${base}`) ?? findTool(`search_${base}`);
}

interface PropertySchema {
  type?: string;
  anyOf?: PropertySchema[];
}

/** A flag's value typed by the tool's JSON Schema (numbers, booleans), else the string as given. */
function coerce(raw: string | true, schema: PropertySchema | undefined): unknown {
  const types = schema?.anyOf?.map((option) => option.type) ?? [schema?.type];
  if (raw === true) return true;
  if (types.includes('boolean') && (raw === 'true' || raw === 'false')) return raw === 'true';
  if (
    (types.includes('number') || types.includes('integer')) &&
    raw.trim() !== '' &&
    Number.isFinite(Number(raw))
  ) {
    return Number(raw);
  }
  return raw;
}

function toolArguments(tool: AgentTool, args: QueryArgs): Record<string, unknown> {
  let base: Record<string, unknown> = {};
  if (args.json !== null) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(args.json);
    } catch (error) {
      throw new QueryError(`--json is not valid JSON: ${errorMessage(error)}`);
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new QueryError('--json must be a JSON object');
    }
    base = parsed as Record<string, unknown>;
  }
  const properties =
    (inputJsonSchema(tool) as { properties?: Record<string, PropertySchema> }).properties ?? {};
  const flags = Object.fromEntries(
    [...args.flags].map(([name, raw]) => [name, coerce(raw, properties[name])]),
  );
  return { ...base, ...flags };
}

function listing(): unknown {
  return AGENT_TOOLS.map((tool) => ({
    name: tool.name,
    title: tool.title,
    access: tool.access,
    ...(tool.access === 'device' ? { requires: '--allow-device-control' } : {}),
    annotations: tool.annotations,
    description: tool.description,
    inputSchema: inputJsonSchema(tool),
  }));
}

function print(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

/** A screenshot's PNG goes to `--out` when given, else stays inline as base64. */
function successOutput(outcome: Extract<ToolOutcome, { ok: true }>, out: string | null): unknown {
  if (!outcome.image) return outcome.result;
  if (out === null) return { ...(outcome.result as object), image: outcome.image };
  writeFileSync(out, Buffer.from(outcome.image.data, 'base64'));
  return { ...(outcome.result as object), image: { mimeType: outcome.image.mimeType, path: out } };
}

export async function runQueryCommand(argv: readonly string[], env = process.env): Promise<number> {
  try {
    const args = parseQueryArgs(argv, env);
    if (args.help || (args.tool === null && !args.list)) {
      process.stdout.write(QUERY_USAGE);
      return args.help ? 0 : 1;
    }
    if (args.list) {
      print(listing());
      return 0;
    }
    const tool = resolveTool(args.tool ?? '');
    if (!tool) throw new QueryError(`No tool named ${args.tool}; \`lionscope query --list\` lists them`);
    const outcome = await callRemoteTool(args.port, tool.name, toolArguments(tool, args), {
      deviceControl: args.deviceControl,
      networkBodies: args.networkBodies,
    });
    if (!outcome.ok) {
      print({ ok: false, error: outcome.error });
      return 1;
    }
    print(successOutput(outcome, args.out));
    return 0;
  } catch (error) {
    print({ ok: false, error: errorMessage(error) });
    return 1;
  }
}
