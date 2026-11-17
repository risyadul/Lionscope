import { timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { isAgentHost, isJsonContentType } from '../agent/http.ts';

export const DAEMON_PATH = '/api/daemon/';
export const DAEMON_HEADER = 'x-lionscope-daemon';

export interface DaemonControl {
  token: string;
  stop(): void;
}

/** Only the CLI owning the private state file can control a detached instance. */
export function handleDaemonControl(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
  port: number,
  control: DaemonControl,
): void {
  const supplied = req.headers[DAEMON_HEADER];
  const authenticated =
    typeof supplied === 'string' &&
    Buffer.byteLength(supplied) === Buffer.byteLength(control.token) &&
    timingSafeEqual(Buffer.from(supplied), Buffer.from(control.token));
  if (
    req.method !== 'POST' ||
    req.headers.origin !== undefined ||
    !isAgentHost(req.headers.host, port) ||
    !isJsonContentType(req.headers['content-type']) ||
    !authenticated
  ) {
    res.writeHead(403, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' });
    res.end('Forbidden\n');
    return;
  }
  if (pathname !== `${DAEMON_PATH}status` && pathname !== `${DAEMON_PATH}stop`) {
    res.writeHead(404);
    res.end();
    return;
  }
  res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  if (pathname === `${DAEMON_PATH}stop`) res.once('finish', () => control.stop());
  res.end(JSON.stringify({ pid: process.pid, port }));
}
