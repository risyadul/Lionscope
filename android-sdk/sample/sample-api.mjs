#!/usr/bin/env node
// The sample app's network demo API (NetworkActivity). Plain Node, no dependencies, loopback only:
//   node android-sdk/sample/sample-api.mjs [--port 8745]
// An emulator reaches it at http://10.0.2.2:<port> (the host's 127.0.0.1). Every answer is made up here; nothing
// is fetched from anywhere else.
import { createServer } from 'node:http';
import { parseArgs } from 'node:util';
import { gzipSync } from 'node:zlib';

const { values } = parseArgs({ options: { port: { type: 'string', default: '8745' } } });
const port = Number(values.port);

const items = Array.from({ length: 12 }, (_, i) => ({ id: 40 + i, name: `Item ${40 + i}`, price: 3.5 + i }));
// A 1×1 transparent PNG.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'base64',
);
const MAX_REQUEST_BYTES = 1024 * 1024;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function json(res, status, value, headers = {}) {
  const body = JSON.stringify(value);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...headers });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_REQUEST_BYTES) req.destroy(new Error('request body too large'));
      else chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

const routes = {
  'GET /v1/items': (req, res, url) =>
    json(
      res,
      200,
      { page: Number(url.searchParams.get('page') ?? 1), items: items.slice(0, 5) },
      { 'Set-Cookie': 'sid=sample-session; HttpOnly', 'Cache-Control': 'no-store' },
    ),
  'GET /v1/items/42': (req, res) => json(res, 200, items[2]),
  'POST /v1/cart': async (req, res) => json(res, 201, { ok: true, received: JSON.parse((await readBody(req)) || '{}') }),
  'POST /v1/login': async (req, res) => {
    const form = new URLSearchParams(await readBody(req));
    json(res, 200, { user: form.get('user'), access_token: 'sample-access-token', expires_in: 3600 });
  },
  // Headers at once, the body later: the timing bar shows waiting and download apart.
  'GET /v1/slow': async (req, res, url) => {
    const ms = Math.min(Number(url.searchParams.get('ms') ?? 2000), 30_000);
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.write('{"slow":true,');
    await sleep(ms);
    res.end(`"waitedMs":${ms}}`);
  },
  'GET /v1/missing': (req, res) => json(res, 404, { error: 'not_found', message: 'No such thing' }),
  'GET /v1/error': (req, res) => json(res, 500, { error: 'internal', message: 'Something broke' }),
  'GET /v1/large': (req, res) =>
    json(res, 200, {
      items: Array.from({ length: 1500 }, (_, i) => ({ id: i, name: `Large item ${i}`, tags: ['a', 'b', 'c'] })),
    }),
  'GET /v1/gzip': (req, res) => {
    const body = JSON.stringify({ compressed: true, items: items.slice(0, 3) });
    res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Encoding': 'gzip' });
    res.end(gzipSync(body));
  },
  'GET /v1/image.png': (req, res) => {
    res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': PNG.length });
    res.end(PNG);
  },
  'GET /v1/events': async (req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
    for (let i = 1; i <= 3; i++) {
      res.write(`event: tick\ndata: {"n":${i}}\n\n`);
      await sleep(300);
    }
    res.end();
  },
};

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const route = routes[`${req.method} ${url.pathname}`];
  console.log(`${req.method} ${url.pathname}${url.search}`);
  try {
    if (route) await route(req, res, url);
    else json(res, 404, { error: 'no_route' });
  } catch (error) {
    if (!res.headersSent) json(res, 400, { error: 'bad_request', message: String(error.message ?? error) });
    else res.destroy();
  }
});

server.listen(port, '127.0.0.1', () => console.log(`Sample API on http://127.0.0.1:${port} (emulator: http://10.0.2.2:${port})`));
