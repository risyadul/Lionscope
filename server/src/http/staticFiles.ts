import { createReadStream, existsSync } from 'node:fs';
import type { Stats } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { IS_BUNDLE } from '../config.ts';
import { log } from '../log.ts';

const MIME_TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.wasm': 'application/wasm',
};

/**
 * The dashboard to serve: `LIONSCOPE_DASHBOARD_DIR`; else `../dashboard` next to the running module when it
 * holds an index.html, and always in the bundled npm package (`dist/lionscope.mjs` + `dashboard/`); else the
 * repo's `dashboard/dist` relative to this source file (development).
 */
export function resolveDashboardDir(
  explicit?: string,
  moduleUrl: string = import.meta.url,
  bundled: boolean = IS_BUNDLE,
): string {
  if (explicit) return path.resolve(explicit);
  const packaged = fileURLToPath(new URL('../dashboard', moduleUrl));
  if (bundled || existsSync(path.join(packaged, 'index.html'))) return packaged;
  return fileURLToPath(new URL('../../../dashboard/dist', moduleUrl));
}

/** The 503 body without a dashboard (no filesystem paths: it goes to the browser). */
export function missingDashboardMessage(bundled: boolean = IS_BUNDLE): string {
  return bundled
    ? 'The Lionscope dashboard files are missing.\nReinstall lionscope (or run `npm run build` in a clone) and reload.\n'
    : 'The Lionscope dashboard is not built.\nRun `npm run build` (or start with `npm run lionscope`) and reload.\n';
}

function sendText(res: ServerResponse, status: number, body: string): void {
  res.statusCode = status;
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Content-Length', Buffer.byteLength(body));
  res.end(res.req.method === 'HEAD' ? undefined : body);
}

interface ServableFile {
  file: string;
  info: Stats;
}

function isInside(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(root + path.sep);
}

/** Resolve symlinks and only accept regular files that really live inside `realRoot`. */
async function servableFile(realRoot: string, file: string): Promise<ServableFile | null> {
  try {
    const real = await realpath(file);
    if (!isInside(realRoot, real)) return null;
    const info = await stat(real);
    return info.isFile() ? { file: real, info } : null;
  } catch {
    return null;
  }
}

/**
 * Map a request path to a file inside `root`, or null if it would escape it. The pathname has
 * already been normalized by WHATWG URL parsing (`..` / `%2e%2e` segments resolved); decoding can
 * still produce `..%2f`-style escapes, which the containment check rejects.
 */
export function resolveSafePath(root: string, pathname: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  if (decoded.includes('\0')) return null;
  const resolved = path.resolve(root, `.${path.posix.normalize(`/${decoded}`)}`);
  return isInside(root, resolved) ? resolved : null;
}

function sendFile(res: ServerResponse, file: string, info: Stats, immutable: boolean): void {
  res.statusCode = 200;
  res.setHeader('Content-Type', MIME_TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream');
  res.setHeader('Content-Length', info.size);
  res.setHeader('Cache-Control', immutable ? 'public, max-age=31536000, immutable' : 'no-cache');
  if (res.req.method === 'HEAD') {
    res.end();
    return;
  }
  const stream = createReadStream(file);
  stream.on('error', () => res.destroy());
  stream.pipe(res);
}

/** Serves the built dashboard with SPA fallback to index.html for extension-less paths. */
export function createStaticHandler(dashboardDir: string, bundled: boolean = IS_BUNDLE) {
  const root = path.resolve(dashboardDir);
  let missingLogged = false;

  return async (req: IncomingMessage, res: ServerResponse, pathname: string): Promise<void> => {
    const realRoot = await realpath(root).catch(() => null);
    const index = realRoot ? await servableFile(realRoot, path.join(realRoot, 'index.html')) : null;
    if (!realRoot || !index) {
      if (!missingLogged) {
        missingLogged = true;
        log.warn(`Dashboard not built: no index.html in ${root}`);
      }
      sendText(res, 503, missingDashboardMessage(bundled));
      return;
    }
    missingLogged = false;

    const requested = resolveSafePath(realRoot, pathname);
    if (!requested) {
      sendText(res, 404, 'Not found\n');
      return;
    }
    const found = requested === realRoot ? null : await servableFile(realRoot, requested);
    if (found) {
      sendFile(res, found.file, found.info, pathname.startsWith('/assets/'));
      return;
    }
    if (path.extname(pathname) !== '') {
      sendText(res, 404, 'Not found\n');
      return;
    }
    sendFile(res, index.file, index.info, false);
  };
}
