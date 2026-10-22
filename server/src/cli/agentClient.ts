/** Client of a running server's JSON tool API (`lionscope query`, and `lionscope mcp` when it attaches). */
import { HOST } from '../config.ts';
import { errorMessage } from '../log.ts';
import { AGENT_API_PREFIX, AGENT_HEADER, DEVICE_CONTROL_HEADER } from '../agent/http.ts';
import type { ToolOutcome } from '../agent/registry.ts';

export const PROBE_TIMEOUT_MS = 2000;
/** Longer than any tool may take (scroll_to: 90 s), so the server's own limits always answer first. */
export const CALL_TIMEOUT_MS = 120_000;

export type ProbeResult =
  | { kind: 'lionscope'; version: string }
  /** Nothing listens on the port. */
  | { kind: 'none' }
  /** Something answered that is not a Lionscope server with the agent API. */
  | { kind: 'other'; detail: string };

function isConnectionRefused(error: unknown): boolean {
  const cause = error instanceof Error ? (error.cause as { code?: unknown } | undefined) : undefined;
  return cause?.code === 'ECONNREFUSED';
}

async function post(port: number, tool: string, args: unknown, deviceControl: boolean, timeoutMs: number) {
  return fetch(`http://${HOST}:${port}${AGENT_API_PREFIX}${tool}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      [AGENT_HEADER]: '1',
      ...(deviceControl ? { [DEVICE_CONTROL_HEADER]: '1' } : {}),
    },
    body: JSON.stringify(args ?? {}),
    signal: AbortSignal.timeout(timeoutMs),
  });
}

function isOutcome(value: unknown): value is ToolOutcome {
  return typeof value === 'object' && value !== null && 'ok' in value && typeof value.ok === 'boolean';
}

/** Is a Lionscope server with the agent API listening on `port`? */
export async function probeServer(port: number, timeoutMs = PROBE_TIMEOUT_MS): Promise<ProbeResult> {
  let response: Response;
  try {
    response = await post(port, 'status', {}, false, timeoutMs);
  } catch (error) {
    if (isConnectionRefused(error)) return { kind: 'none' };
    return { kind: 'other', detail: `no answer from port ${port} (${errorMessage(error)})` };
  }
  const body: unknown = await response.json().catch(() => null);
  if (!isOutcome(body) || !body.ok) {
    return {
      kind: 'other',
      detail: `port ${port} answered HTTP ${response.status} but is not a Lionscope server with the agent API (an older Lionscope, or another program)`,
    };
  }
  const result = body.result as { server?: { version?: unknown } } | null;
  return { kind: 'lionscope', version: String(result?.server?.version ?? 'unknown') };
}

/** Runs a tool on the server; transport failures come back as `{ ok: false }` too. */
export async function callRemoteTool(
  port: number,
  tool: string,
  args: unknown,
  options: { deviceControl?: boolean; timeoutMs?: number } = {},
): Promise<ToolOutcome> {
  let response: Response;
  try {
    response = await post(
      port,
      tool,
      args,
      options.deviceControl ?? false,
      options.timeoutMs ?? CALL_TIMEOUT_MS,
    );
  } catch (error) {
    if (isConnectionRefused(error)) {
      return {
        ok: false,
        code: 'unreachable',
        error: `No Lionscope server on http://localhost:${port}. Start one with \`npx lionscope\` (or pass --port).`,
      };
    }
    return {
      ok: false,
      code: 'failed',
      error: `Lionscope server on port ${port} did not answer: ${errorMessage(error)}`,
    };
  }
  const body: unknown = await response.json().catch(() => null);
  if (isOutcome(body)) return body;
  return { ok: false, code: 'failed', error: `Unexpected HTTP ${response.status} answer from port ${port}` };
}
