import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { DEFAULT_DASHBOARD_PORT, DEVICE_LINK_PORT, DEFAULT_PERMISSIONS } from '@lionscope/protocol';
import type { Permissions } from '@lionscope/protocol';
import { mergePermissions } from './permissions.ts';

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
  permissionOverrides?: Partial<Permissions>;
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
  /** `--allow-network-bodies`: AI agents may read the text of captured HTTP bodies. */
  allowNetworkBodies: boolean;
  /** `--allow-storage-read`: the storage inspector reads prefs and registered databases (dashboard and agents). */
  allowStorageRead: boolean;
  /** `--allow-storage-write`: it may edit them too (needs `--allow-storage-read`). */
  allowStorageWrite: boolean;
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
       lionscope start [options]
       lionscope stop|status [--port <port>]
       lionscope logs [--port <port>] [--follow]
       lionscope permissions [--disable-* | --allow-*] [--port <port>]
       lionscope mcp [options]
       lionscope query <tool> [--<arg> <value> ...] [--json '<arguments>'] [--port <port>]
       lionscope render-layout --module <:module> --layout <file.xml> --out <file.png>

Starts Lionscope in the background and returns the terminal. The server serves the dashboard at
http://localhost:<port>, an MCP endpoint for AI agents at http://localhost:<port>/mcp and a JSON tool API
for \`lionscope query\`.
Everything listens on 127.0.0.1 only.

Commands:
  start                 Start in background (the default); reuse an instance already running on the port
  stop                  Gracefully stop this user's managed background instance on --port
  status                Show whether the server is running and where its logs are
  logs                  Show the last 100 log lines; --follow (-f) watches new output
  permissions           Show or change saved permissions without restarting
  mcp                   MCP server on stdin/stdout for AI agents: uses the Lionscope server running on
                        --port, or starts one in this process (the dashboard stays at http://localhost:<port>)
  query <tool>          Run one agent tool against the running server and print its JSON result
                        (\`lionscope query --list\` lists the tools)
  render-layout         Render an Android layout XML to PNG locally (see render-layout --help)

Options:
  --foreground         Keep the server in this terminal; Ctrl+C stops it
  --port <port>         Dashboard port (LIONSCOPE_PORT, default ${DEFAULT_DASHBOARD_PORT})
  --device-port <port>  In-app SDK gateway port (LIONSCOPE_DEVICE_PORT, default ${DEVICE_LINK_PORT})
  --adb <path>          adb binary (LIONSCOPE_ADB; default: $ANDROID_HOME, the usual SDK location, then PATH)
  Permissions are enabled by default. Choices are saved for this server port.
  --disable-device-control  Disable agent device control
  --disable-network-bodies  Hide Network bodies from agents (dashboard capture is independent)
  --disable-storage-read    Disable Storage reads and writes in dashboard and tools
  --disable-storage-write   Keep Storage read-only
  --allow-device-control / --allow-network-bodies / --allow-storage-read / --allow-storage-write
                            Re-enable a permission. Flags also update an already running server.
  -h, --help            Show this help
  -v, --version         Print the version
`;

/**
 * Command-line flags; they win over the matching environment variables. `--dev` (used by `npm run dev`) is
 * deliberately left out of USAGE: it widens the WebSocket origin allowlist.
 */
export interface CliArgs {
  disableDeviceControl: boolean;
  disableNetworkBodies: boolean;
  disableStorageRead: boolean;
  disableStorageWrite: boolean;
  help: boolean;
  version: boolean;
  foreground: boolean;
  dev: boolean;
  port: string | undefined;
  devicePort: string | undefined;
  adb: string | undefined;
  allowDeviceControl: boolean;
  allowNetworkBodies: boolean;
  allowStorageRead: boolean;
  allowStorageWrite: boolean;
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
        foreground: { type: 'boolean' },
        dev: { type: 'boolean' },
        port: { type: 'string' },
        'device-port': { type: 'string' },
        adb: { type: 'string' },
        'allow-device-control': { type: 'boolean' },
        'allow-network-bodies': { type: 'boolean' },
        'allow-storage-read': { type: 'boolean' },
        'allow-storage-write': { type: 'boolean' },
        'disable-device-control': { type: 'boolean' },
        'disable-network-bodies': { type: 'boolean' },
        'disable-storage-read': { type: 'boolean' },
        'disable-storage-write': { type: 'boolean' },
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
  for (const name of ['device-control', 'network-bodies', 'storage-read', 'storage-write'] as const) {
    if (values[`allow-${name}`] && values[`disable-${name}`])
      throw argsError(`Conflicting permissions for ${name}`);
  }
  return {
    disableDeviceControl: values['disable-device-control'] === true,
    disableNetworkBodies: values['disable-network-bodies'] === true,
    disableStorageRead: values['disable-storage-read'] === true,
    disableStorageWrite: values['disable-storage-write'] === true,
    help: values.help === true,
    version: values.version === true,
    foreground: values.foreground === true,
    dev: values.dev === true,
    port: values.port,
    devicePort: values['device-port'],
    adb: nonEmpty(values.adb?.trim()),
    allowDeviceControl: values['allow-device-control'] === true,
    allowNetworkBodies: values['allow-network-bodies'] === true,
    allowStorageRead: values['allow-storage-read'] === true,
    allowStorageWrite: values['allow-storage-write'] === true,
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
  const overrides = permissionOverrides(args);
  const permissions = mergePermissions(DEFAULT_PERMISSIONS, overrides);
  return {
    permissionOverrides: overrides,
    host: HOST,
    port: portOf(args.port, '--port') ?? parsePort(env.LIONSCOPE_PORT),
    devicePort:
      portOf(args.devicePort, '--device-port') ??
      parsePort(env.LIONSCOPE_DEVICE_PORT, 'LIONSCOPE_DEVICE_PORT', DEVICE_LINK_PORT),
    dashboardDir: nonEmpty(env.LIONSCOPE_DASHBOARD_DIR),
    adb: args.adb,
    dev: env.LIONSCOPE_DEV === '1' || args.dev,
    allowDeviceControl: permissions.deviceControl,
    allowNetworkBodies: permissions.networkBodies,
    allowStorageRead: permissions.storageRead,
    allowStorageWrite: permissions.storageWrite,
  };
}

export function permissionOverrides(args: CliArgs): Partial<Permissions> {
  return {
    ...(args.allowDeviceControl || args.disableDeviceControl
      ? { deviceControl: !args.disableDeviceControl }
      : {}),
    ...(args.allowNetworkBodies || args.disableNetworkBodies
      ? { networkBodies: !args.disableNetworkBodies }
      : {}),
    ...(args.allowStorageRead || args.disableStorageRead ? { storageRead: !args.disableStorageRead } : {}),
    ...(args.allowStorageWrite || args.disableStorageWrite
      ? { storageWrite: !args.disableStorageWrite }
      : {}),
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
