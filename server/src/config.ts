import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { DEFAULT_DASHBOARD_PORT, DEVICE_LINK_PORT } from '@lionscope/protocol';

/** The server never listens on anything but loopback. */
export const HOST = '127.0.0.1';

/** Ring-buffer window for every metric stream. */
export const BUFFER_WINDOW_MS = 10 * 60 * 1000;

/** Replaced with `true` by the npm package build (esbuild `define`); undeclared when running from source. */
declare const __LIONSCOPE_BUNDLE__: boolean | undefined;
/** Running as the bundled `lionscope` npm package (`dist/lionscope.mjs`), not from a clone. */
export const IS_BUNDLE = typeof __LIONSCOPE_BUNDLE__ !== 'undefined' && __LIONSCOPE_BUNDLE__;

/** Origins of the Vite dev server, accepted only in dev mode. */
export const DEV_ORIGINS: readonly string[] = ['http://localhost:5173', 'http://127.0.0.1:5173'];

export interface LionscopeConfig {
  host: typeof HOST;
  port: number;
  /** In-app SDK gateway port (LIONSCOPE_DEVICE_PORT), the host side of `adb reverse`. */
  devicePort: number;
  /** Explicit dashboard dist directory from LIONSCOPE_DASHBOARD_DIR, if any. */
  dashboardDir: string | undefined;
  /** `--adb <path>`; otherwise resolveAdbPath looks it up (LIONSCOPE_ADB / ANDROID_HOME / ...). */
  adb: string | undefined;
  /** `--dev` flag or LIONSCOPE_DEV=1: also accept WebSocket connections from the Vite dev server. */
  dev: boolean;
  /** `--allow-device-control`: AI agents may take screenshots, tap, type and boot / shut down emulators. */
  allowDeviceControl: boolean;
}

const PORT_PATTERN = /^\d{1,5}$/;

export function parsePort(
  raw: string | undefined,
  name = 'LIONSCOPE_PORT',
  fallback: number = DEFAULT_DASHBOARD_PORT,
): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  // Plain decimal digits only: Number() would also take hex, exponents and surrounding whitespace.
  if (!PORT_PATTERN.test(raw) || Number(raw) > 65535) {
    throw new Error(`${name} must be an integer between 0 and 65535 (got "${raw}")`);
  }
  return Number(raw);
}

function nonEmpty(value: string | undefined): string | undefined {
  return value !== undefined && value.trim() !== '' ? value : undefined;
}

export const USAGE = `Usage: lionscope [options]
       lionscope mcp [options]
       lionscope query <tool> [--<arg> <value> ...] [--json '<arguments>'] [--port <port>]

Starts the Lionscope server, which serves the dashboard at http://localhost:<port>, an MCP endpoint for
AI agents at http://localhost:<port>/mcp and a JSON tool API for \`lionscope query\`.
Everything listens on 127.0.0.1 only.

Commands:
  mcp                   MCP server on stdin/stdout for AI agents: uses the Lionscope server running on
                        --port, or starts one in this process (the dashboard stays at http://localhost:<port>)
  query <tool>          Run one agent tool against the running server and print its JSON result
                        (\`lionscope query --list\` lists the tools)

Options:
  --port <port>         Dashboard port (LIONSCOPE_PORT, default ${DEFAULT_DASHBOARD_PORT})
  --device-port <port>  In-app SDK gateway port (LIONSCOPE_DEVICE_PORT, default ${DEVICE_LINK_PORT})
  --adb <path>          adb binary (LIONSCOPE_ADB; default: $ANDROID_HOME, the usual SDK location, then PATH)
  --allow-device-control
                        Let AI agents operate devices: screenshots, taps, swipes, text, keys, launching
                        apps, booting and shutting down emulators (off by default)
  -h, --help            Show this help
  -v, --version         Print the version
`;

/**
 * Command-line flags; they win over the matching environment variables. `--dev` (used by `npm run dev`) is
 * deliberately left out of USAGE: it widens the WebSocket origin allowlist.
 */
export interface CliArgs {
  help: boolean;
  version: boolean;
  dev: boolean;
  port: string | undefined;
  devicePort: string | undefined;
  adb: string | undefined;
  allowDeviceControl: boolean;
}

function argsError(detail: string, cause?: unknown): Error {
  return new Error(`${detail}. Run lionscope --help for the options.`, { cause });
}

/**
 * Throws on unknown or repeated flags, positionals and missing values (there is deliberately no `--host`).
 */
export function parseCliArgs(argv: readonly string[]): CliArgs {
  let parsed;
  try {
    parsed = parseArgs({
      args: [...argv],
      strict: true,
      allowPositionals: false,
      tokens: true,
      options: {
        help: { type: 'boolean', short: 'h' },
        version: { type: 'boolean', short: 'v' },
        dev: { type: 'boolean' },
        port: { type: 'string' },
        'device-port': { type: 'string' },
        adb: { type: 'string' },
        'allow-device-control': { type: 'boolean' },
      },
    });
  } catch (error) {
    // Node's messages run over several lines and sentences: keep the first sentence.
    const message = error instanceof Error ? error.message : String(error);
    const detail = (message.split('\n')[0] ?? '').split('. ')[0]?.replace(/\.$/, '') ?? '';
    throw argsError(detail, error);
  }
  const seen = new Set<string>();
  for (const token of parsed.tokens) {
    if (token.kind !== 'option') continue;
    if (seen.has(token.name)) throw argsError(`Option '--${token.name}' given more than once`);
    seen.add(token.name);
  }
  const { values } = parsed;
  return {
    help: values.help === true,
    version: values.version === true,
    dev: values.dev === true,
    port: values.port,
    devicePort: values['device-port'],
    adb: nonEmpty(values.adb?.trim()),
    allowDeviceControl: values['allow-device-control'] === true,
  };
}

/** A port flag, if given: unlike an empty environment variable, an empty flag is an error. */
function portOf(flag: string | undefined, name: string): number | undefined {
  if (flag === undefined) return undefined;
  if (flag.trim() === '') throw new Error(`${name} needs a port number`);
  return parsePort(flag, name);
}

/** Flags (see parseCliArgs) over environment variables over defaults. adb is otherwise located by resolveAdbPath. */
export function loadConfig(
  env: NodeJS.ProcessEnv = process.env,
  args: CliArgs = parseCliArgs(process.argv.slice(2)),
): LionscopeConfig {
  return {
    host: HOST,
    port: portOf(args.port, '--port') ?? parsePort(env.LIONSCOPE_PORT),
    devicePort:
      portOf(args.devicePort, '--device-port') ??
      parsePort(env.LIONSCOPE_DEVICE_PORT, 'LIONSCOPE_DEVICE_PORT', DEVICE_LINK_PORT),
    dashboardDir: nonEmpty(env.LIONSCOPE_DASHBOARD_DIR),
    adb: args.adb,
    dev: env.LIONSCOPE_DEV === '1' || args.dev,
    allowDeviceControl: args.allowDeviceControl,
  };
}

function readServerVersion(): string {
  try {
    const json: unknown = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    if (typeof json === 'object' && json !== null && 'version' in json && typeof json.version === 'string') {
      return json.version;
    }
  } catch {
    // fall through to the default below
  }
  return '0.0.0';
}

export const SERVER_VERSION = readServerVersion();
