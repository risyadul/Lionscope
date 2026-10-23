/**
 * The agent endpoints on the dashboard HTTP server: Streamable HTTP MCP at /mcp and the JSON tool API at
 * /api/agent/<tool> (used by `lionscope query` and an attached `lionscope mcp`). Both refuse anything a browser
 * page could send: the Host must name this server on loopback (DNS rebinding) and an Origin header, when there
 * is one, must be the dashboard's own on /mcp (CSRF); the JSON API refuses any Origin at all, and requires
 * `Content-Type: application/json` and an `X-Lionscope-Agent: 1` header, which a cross-origin page can only
 * send after a CORS preflight that this server never approves.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';
import { createMcpHandler } from '@modelcontextprotocol/server';
import { buildAllowedOrigins, isAllowedOrigin } from '../http/wsGateway.ts';
import { createAgentMcpServer, MAX_MCP_SUBSCRIPTIONS } from './mcpServer.ts';
import { availableTools, callTool } from './registry.ts';
import type { ToolFailure } from './registry.ts';
import type { AgentBaseContext } from './tool.ts';

export const MCP_PATH = '/mcp';
export const AGENT_API_PREFIX = '/api/agent/';
export const AGENT_HEADER = 'x-lionscope-agent';
/** Per-request device-control opt-in, honoured by the JSON API only (it is what `lionscope mcp --allow-device-control` sends). */
export const DEVICE_CONTROL_HEADER = 'x-lionscope-device-control';
/** Per-request network-bodies opt-in, honoured by the JSON API only (what `--allow-network-bodies` clients send). */
export const NETWORK_BODIES_HEADER = 'x-lionscope-network-bodies';
export const MAX_MCP_BODY_BYTES = 1024 * 1024;
/** As large as /mcp: a set_network_mock body (up to 256 KB of text, JSON-escaped) comes through here too. */
export const MAX_AGENT_BODY_BYTES = MAX_MCP_BODY_BYTES;

const LOOPBACK_HOSTNAMES: ReadonlySet<string> = new Set(['localhost', '127.0.0.1', '[::1]']);
const TOOL_NAME = /^[a-z][a-z_]{0,63}$/;
const FAILURE_STATUS: Readonly<Record<ToolFailure, number>> = {
  unknown_tool: 404,
  forbidden: 403,
  invalid_arguments: 400,
  failed: 422,
  busy: 429,
  unreachable: 503,
};

/** The ToolOutcome code of a request refused before any tool ran. */
function failureOf(status: number): ToolFailure {
  if (status === 403) return 'forbidden';
  if (status === 404) return 'unknown_tool';
  return status < 500 ? 'invalid_arguments' : 'failed';
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** Host names this server on loopback at its own port (stricter than the dashboard's any-port check). */
export function isAgentHost(host: string | undefined, port: number): boolean {
  if (!host) return false;
  try {
    const url = new URL(`http://${host}`);
    return LOOPBACK_HOSTNAMES.has(url.hostname) && url.port === String(port);
  } catch {
    return false;
  }
}

/** `application/json`, with or without parameters. */
export function isJsonContentType(value: string | undefined): boolean {
  return value?.split(';')[0]?.trim().toLowerCase() === 'application/json';
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Length', Buffer.byteLength(text));
  res.end(text);
}

function readBody(req: IncomingMessage, maxBytes: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    req.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > maxBytes) {
        reject(new HttpError(413, `Request body over ${maxBytes} bytes`));
        // Drain the rest so the 413 reaches the client instead of a reset connection.
        req.removeAllListeners('data');
        req.resume();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function parseArguments(body: Buffer): unknown {
  if (body.length === 0) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString('utf8'));
  } catch {
    throw new HttpError(400, 'The body is not JSON');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new HttpError(400, 'The body must be a JSON object of tool arguments');
  }
  return parsed;
}

/** A Node request as a web-standard Request (what the SDK's handler takes). */
async function toWebRequest(req: IncomingMessage, signal: AbortSignal): Promise<Request> {
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(', ') : value);
  }
  const hasBody = req.method !== 'GET' && req.method !== 'HEAD';
  const body = hasBody ? await readBody(req, MAX_MCP_BODY_BYTES) : undefined;
  return new Request(`http://${req.headers.host ?? 'localhost'}${req.url ?? MCP_PATH}`, {
    method: req.method ?? 'GET',
    headers,
    ...(body ? { body } : {}),
    signal,
  });
}

/** Writes a web Response, streaming its body (MCP answers with SSE streams too). */
async function sendWebResponse(res: ServerResponse, response: Response): Promise<void> {
  res.statusCode = response.status;
  response.headers.forEach((value, name) => res.setHeader(name, value));
  if (!response.body) {
    res.end();
    return;
  }
  try {
    await pipeline(Readable.fromWeb(response.body as unknown as NodeReadableStream), res);
  } catch (error) {
    // The client went away mid-stream (an SSE stream it stopped reading): nothing left to answer.
    if (!res.destroyed) throw error;
  }
}

export interface AgentHttpOptions {
  ctx: AgentBaseContext;
  /** --allow-device-control: device tools on both endpoints (the JSON API's header can also enable them). */
  deviceControl: boolean;
  /** --allow-network-bodies: HTTP body texts on both endpoints (the JSON API's header can also enable them). */
  networkBodies?: boolean;
  /** The bound dashboard port (null before listen). */
  port: () => number | null;
}

export interface AgentHttp {
  handles(pathname: string): boolean;
  handle(req: IncomingMessage, res: ServerResponse, pathname: string): Promise<void>;
  close(): Promise<void>;
}

export function createAgentHttp(options: AgentHttpOptions): AgentHttp {
  const { ctx, deviceControl } = options;
  const networkBodies = options.networkBodies ?? false;
  // Stateless per request: a fresh MCP server over the same tool layer each time.
  const mcp = createMcpHandler(
    () =>
      createAgentMcpServer({
        version: ctx.serverVersion,
        tools: availableTools(deviceControl),
        deviceControl,
        invoke: (name, args) => callTool(ctx, name, args, deviceControl, { networkBodies }),
      }),
    { maxSubscriptions: MAX_MCP_SUBSCRIPTIONS },
  );

  const refusal = (req: IncomingMessage): HttpError | null => {
    const port = options.port();
    if (port === null || !isAgentHost(req.headers.host, port)) return new HttpError(403, 'Forbidden host');
    const origin = req.headers.origin;
    if (origin !== undefined && !isAllowedOrigin(origin, buildAllowedOrigins(port, false))) {
      return new HttpError(403, 'Forbidden origin');
    }
    return null;
  };

  const handleApi = async (req: IncomingMessage, res: ServerResponse, pathname: string): Promise<void> => {
    // `lionscope query` and an attached `lionscope mcp` never send one; any page, even the dashboard's, does.
    if (req.headers.origin !== undefined) throw new HttpError(403, 'Forbidden origin');
    if (req.method !== 'POST') {
      res.setHeader('Allow', 'POST');
      throw new HttpError(405, 'Use POST');
    }
    if (!isJsonContentType(req.headers['content-type'])) {
      throw new HttpError(415, 'Content-Type must be application/json');
    }
    if (req.headers[AGENT_HEADER] !== '1')
      throw new HttpError(403, `The ${AGENT_HEADER}: 1 header is required`);
    const name = pathname.slice(AGENT_API_PREFIX.length);
    if (!TOOL_NAME.test(name)) throw new HttpError(404, 'Unknown tool');
    const args = parseArguments(await readBody(req, MAX_AGENT_BODY_BYTES));
    const allowDevice = deviceControl || req.headers[DEVICE_CONTROL_HEADER] === '1';
    const allowBodies = networkBodies || req.headers[NETWORK_BODIES_HEADER] === '1';
    const outcome = await callTool(ctx, name, args, allowDevice, { networkBodies: allowBodies });
    sendJson(res, outcome.ok ? 200 : FAILURE_STATUS[outcome.code], outcome);
  };

  const handleMcp = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const aborted = new AbortController();
    res.on('close', () => aborted.abort());
    await sendWebResponse(res, await mcp.fetch(await toWebRequest(req, aborted.signal)));
  };

  return {
    handles: (pathname) => pathname === MCP_PATH || pathname.startsWith(AGENT_API_PREFIX),
    async handle(req, res, pathname) {
      try {
        const refused = refusal(req);
        if (refused) throw refused;
        if (pathname === MCP_PATH) await handleMcp(req, res);
        else await handleApi(req, res, pathname);
      } catch (error) {
        if (!(error instanceof HttpError)) throw error;
        if (!res.headersSent)
          sendJson(res, error.status, { ok: false, code: failureOf(error.status), error: error.message });
      }
    },
    close: () => mcp.close(),
  };
}
