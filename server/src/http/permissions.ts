import type { IncomingMessage, ServerResponse } from 'node:http';
import { permissionPatchSchema } from '@lionscope/protocol';
import { isAgentHost, isJsonContentType } from '../agent/http.ts';
import type { PermissionSettings } from '../permissions.ts';

export const PERMISSIONS_PATH = '/api/permissions';
export const SETTINGS_HEADER = 'x-lionscope-settings';

export async function handlePermissions(
  req: IncomingMessage,
  res: ServerResponse,
  options: {
    port: number;
    allowedOrigins: ReadonlySet<string>;
    settings: PermissionSettings;
  },
): Promise<void> {
  const reply = (status: number, body: unknown) => {
    res.statusCode = status;
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Cache-Control', 'no-store');
    res.end(JSON.stringify(body));
  };
  if (
    !isAgentHost(req.headers.host, options.port) ||
    req.headers[SETTINGS_HEADER] !== '1' ||
    (req.headers.origin !== undefined && !options.allowedOrigins.has(req.headers.origin))
  ) {
    reply(403, { error: 'Forbidden' });
    return;
  }
  if (req.method === 'GET') {
    reply(200, options.settings.value);
    return;
  }
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST');
    reply(405, { error: 'Use GET or POST' });
    return;
  }
  if (!isJsonContentType(req.headers['content-type'])) {
    reply(415, { error: 'Content-Type must be application/json' });
    return;
  }
  const chunks: Buffer[] = [];
  let size = 0;
  req.setTimeout(3000, () => req.destroy());
  try {
    for await (const raw of req) {
      const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
      size += chunk.length;
      if (size > 4096) {
        reply(413, { error: 'Permission settings exceed 4096 bytes' });
        return;
      }
      chunks.push(chunk);
    }
  } finally {
    req.setTimeout(0);
  }
  let value: unknown;
  try {
    value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    reply(400, { error: 'Invalid JSON' });
    return;
  }
  const parsed = permissionPatchSchema.safeParse(value);
  if (!parsed.success) {
    reply(400, { error: 'Provide boolean permission fields; Storage write requires Storage read.' });
    return;
  }
  try {
    reply(200, await options.settings.update(parsed.data));
  } catch {
    reply(500, { error: 'Could not save permissions. Permissions were not changed.' });
  }
}
