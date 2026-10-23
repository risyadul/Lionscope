/**
 * `GET /inspector/<id>.png`: the screenshot of a kept Inspector snapshot. Same rules as the dashboard's own
 * files (the caller already checked the Host), and never to another site: a cross-site request (Sec-Fetch-Site)
 * or a foreign Origin is refused, and Cross-Origin-Resource-Policy keeps other origins from embedding it.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { isAllowedOrigin } from './wsGateway.ts';

const INSPECTOR_PNG_PATH = /^\/inspector\/([0-9a-f]{16})\.png$/;
export const INSPECTOR_PATH_PREFIX = '/inspector/';

function sendText(res: ServerResponse, status: number, body: string): void {
  res.statusCode = status;
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Content-Length', Buffer.byteLength(body));
  res.end(res.req.method === 'HEAD' ? undefined : body);
}

export interface InspectorFilesOptions {
  png: (snapshotId: string) => Buffer | null;
  allowedOrigins: () => ReadonlySet<string>;
}

/** Answers a GET / HEAD under INSPECTOR_PATH_PREFIX. */
export function serveInspectorPng(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
  options: InspectorFilesOptions,
): void {
  const origin = req.headers.origin;
  const crossSite = req.headers['sec-fetch-site'] === 'cross-site';
  if (crossSite || (origin !== undefined && !isAllowedOrigin(origin, options.allowedOrigins()))) {
    sendText(res, 403, 'Forbidden\n');
    return;
  }
  const id = INSPECTOR_PNG_PATH.exec(pathname)?.[1];
  const png = id === undefined ? null : options.png(id);
  if (!png) {
    sendText(res, 404, 'Not found\n');
    return;
  }
  res.statusCode = 200;
  res.setHeader('Content-Type', 'image/png');
  res.setHeader('Content-Length', png.length);
  // Screen contents: never written to the browser's cache.
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.end(req.method === 'HEAD' ? undefined : png);
}
