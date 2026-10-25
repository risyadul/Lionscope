import type { ServerResponse } from 'node:http';

export const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "connect-src 'self' ws://localhost:* ws://127.0.0.1:*",
  // The Location panel's map: OpenStreetMap tiles, loaded only while it is open.
  "img-src 'self' data: https://tile.openstreetmap.org",
  "style-src 'self'",
  "font-src 'self'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ');

export const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  'Content-Security-Policy': CONTENT_SECURITY_POLICY,
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
};

export function applySecurityHeaders(res: ServerResponse): void {
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) res.setHeader(name, value);
}
