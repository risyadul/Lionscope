import { HOST, loadConfig, parseCliArgs, permissionOverrides } from '../config.ts';
import { permissionsSchema } from '@lionscope/protocol';
import type { Permissions } from '@lionscope/protocol';
import { PERMISSIONS_PATH, SETTINGS_HEADER } from '../http/permissions.ts';

export async function requestPermissions(port: number, patch?: Partial<Permissions>): Promise<Permissions> {
  const response = await fetch(`http://${HOST}:${port}${PERMISSIONS_PATH}`, {
    method: patch && Object.keys(patch).length ? 'POST' : 'GET',
    headers: { [SETTINGS_HEADER]: '1', 'Content-Type': 'application/json' },
    ...(patch && Object.keys(patch).length ? { body: JSON.stringify(patch) } : {}),
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok)
    throw new Error(
      `Cannot update/read permissions (HTTP ${response.status}); check server version and settings.`,
    );
  return permissionsSchema.parse(await response.json());
}

export async function runPermissionsCommand(argv: readonly string[]): Promise<void> {
  const args = parseCliArgs(argv);
  if (args.help) {
    process.stdout.write(
      'Usage: lionscope permissions [--port <port>] [--disable-device-control] [--disable-network-bodies] [--disable-storage-read] [--disable-storage-write]\nUse the matching --allow-* flag to re-enable. Changes apply now and are saved for this server port.\n',
    );
    return;
  }
  if (args.foreground || args.dev || args.adb || args.devicePort || args.version)
    throw new Error('Use permissions --help for supported options.');
  const config = loadConfig(process.env, args);
  const permissions = await requestPermissions(config.port, permissionOverrides(args));
  process.stdout.write(`${JSON.stringify(permissions, null, 2)}\n`);
}
