import { readFileSync } from 'node:fs';
import { DEFAULT_DASHBOARD_PORT, DEVICE_LINK_PORT } from '@lionscope/protocol';

/** The server never listens on anything but loopback. */
export const HOST = '127.0.0.1';

/** Ring-buffer window for every metric stream. */
export const BUFFER_WINDOW_MS = 10 * 60 * 1000;

/** Origins of the Vite dev server, accepted only in dev mode. */
export const DEV_ORIGINS: readonly string[] = ['http://localhost:5173', 'http://127.0.0.1:5173'];

export interface LionscopeConfig {
  host: typeof HOST;
  port: number;
  /** In-app SDK gateway port (LIONSCOPE_DEVICE_PORT), the host side of `adb reverse`. */
  devicePort: number;
  /** Explicit dashboard dist directory from LIONSCOPE_DASHBOARD_DIR, if any. */
  dashboardDir: string | undefined;
  /** `--dev` flag or LIONSCOPE_DEV=1: also accept WebSocket connections from the Vite dev server. */
  dev: boolean;
}

export function parsePort(
  raw: string | undefined,
  name = 'LIONSCOPE_PORT',
  fallback: number = DEFAULT_DASHBOARD_PORT,
): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`${name} must be an integer between 0 and 65535 (got "${raw}")`);
  }
  return port;
}

function nonEmpty(value: string | undefined): string | undefined {
  return value !== undefined && value.trim() !== '' ? value : undefined;
}

/** adb itself is located by resolveAdbPath (LIONSCOPE_ADB / ANDROID_HOME / ...). */
export function loadConfig(
  env: NodeJS.ProcessEnv = process.env,
  argv: readonly string[] = process.argv.slice(2),
): LionscopeConfig {
  return {
    host: HOST,
    port: parsePort(env.LIONSCOPE_PORT),
    devicePort: parsePort(env.LIONSCOPE_DEVICE_PORT, 'LIONSCOPE_DEVICE_PORT', DEVICE_LINK_PORT),
    dashboardDir: nonEmpty(env.LIONSCOPE_DASHBOARD_DIR),
    dev: env.LIONSCOPE_DEV === '1' || argv.includes('--dev'),
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
