/**
 * `lionscope mcp`: an MCP server on stdin/stdout. It attaches to the Lionscope server on --port (forwarding
 * tool calls to its JSON tool API) or, when none answers, starts one in this process and runs the tools
 * directly; the dashboard is then served by this process until the MCP client disconnects.
 *
 * `--allow-device-control` enables the device tools for this client only, `--allow-network-bodies` the HTTP body
 * texts: autonomy guards for the AI, not security boundaries (local processes are trusted, browsers are not).
 */
import { setTimeout as sleep } from 'node:timers/promises';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { createAgentMcpServer, MAX_MCP_SUBSCRIPTIONS } from '../agent/mcpServer.ts';
import type { ToolInvoker } from '../agent/mcpServer.ts';
import { availableTools, callTool } from '../agent/registry.ts';
import { loadConfig, parseCliArgs, SERVER_VERSION } from '../config.ts';
import type { LionscopeConfig } from '../config.ts';
import { errorMessage, log, logInfoToStderr } from '../log.ts';
import type { LionscopeServer } from '../server.ts';
import { callRemoteTool, probeServer } from './agentClient.ts';
import { exitOnShutdown, startLionscope } from './serve.ts';

export const MCP_USAGE = `Usage: lionscope mcp [--port <port>] [--device-port <port>] [--adb <path>] [--allow-device-control]
                     [--allow-network-bodies]

MCP server on stdin/stdout for AI agents (Claude Code, Cursor, VS Code, Codex, Gemini CLI, ...). Uses the
Lionscope server running on --port, or starts one in this process (dashboard at http://localhost:<port>)
that stops when the MCP client disconnects; if the server it uses goes away, it starts one. Logs go to stderr.

Options:
  --port <port>           Dashboard port (LIONSCOPE_PORT, default 8701)
  --device-port <port>    In-app SDK gateway port, when it starts a server (LIONSCOPE_DEVICE_PORT, default 8700)
  --adb <path>            adb binary, when it starts a server (LIONSCOPE_ADB)
  --allow-device-control  Offer the device tools (get_ui_tree, inspect_screen, tap_element, wait_for,
                          scroll_to, screenshot, tap, swipe, type_text, press_key, launch_app,
                          set_network_mock, clear_network_mocks, boot_emulator, shutdown_emulator) to this
                          client
  --allow-network-bodies  Let this client read captured HTTP body texts (get_network_request)
  -h, --help              Show this help
  -v, --version           Print the version
`;

function isAddressInUse(error: unknown): boolean {
  const cause = error instanceof Error ? (error.cause as { code?: unknown } | undefined) : undefined;
  return cause?.code === 'EADDRINUSE';
}

/** Another `lionscope mcp` won the race for the port: give its server a moment, then attach to it. */
const ATTACH_RETRIES = 3;
const ATTACH_RETRY_MS = 300;

/**
 * Where tool calls go: the server on the port (attached) or one this process runs. When the attached server
 * goes away, the next call takes the port over (or attaches to whoever did).
 */
class McpBackend {
  private server: LionscopeServer | null = null;
  private stop: ((reason: string) => void) | null = null;
  private reconnecting: Promise<void> | null = null;

  constructor(
    private readonly config: LionscopeConfig,
    private readonly deviceControl: boolean,
    private readonly networkBodies: boolean,
  ) {}

  async connect(): Promise<void> {
    const { port } = this.config;
    for (let attempt = 0; attempt < ATTACH_RETRIES; attempt++) {
      const probe = await probeServer(port);
      if (probe.kind === 'other') {
        throw new Error(`Cannot use port ${port}: ${probe.detail}. Pass --port to pick another.`);
      }
      if (probe.kind === 'lionscope') {
        log.info(`Attached to the Lionscope ${probe.version} server at http://localhost:${port}`);
        if (probe.version !== SERVER_VERSION) {
          log.warn(
            `That server runs Lionscope ${probe.version}, this command is ${SERVER_VERSION}: tools may differ`,
          );
        }
        return;
      }
      try {
        // Device control and bodies stay off on this server's HTTP endpoints: the flags are for this client only.
        const server = await startLionscope({
          ...this.config,
          allowDeviceControl: false,
          allowNetworkBodies: false,
        });
        this.server = server;
        this.stop = exitOnShutdown(server);
        return;
      } catch (error) {
        if (!isAddressInUse(error)) throw error;
        log.info(`Port ${port} was just taken (another lionscope mcp?): attaching instead`);
        await sleep(ATTACH_RETRY_MS);
      }
    }
    throw new Error(`Could not start or attach to a Lionscope server on port ${port}`);
  }

  readonly invoke: ToolInvoker = async (name, args) => {
    const local = this.server;
    if (local) {
      return callTool(local.agent, name, args, this.deviceControl, { networkBodies: this.networkBodies });
    }
    const outcome = await callRemoteTool(this.config.port, name, args, {
      deviceControl: this.deviceControl,
      networkBodies: this.networkBodies,
    });
    if (outcome.ok || outcome.code !== 'unreachable') return outcome;
    log.info('The Lionscope server this command used went away: reconnecting');
    try {
      await (this.reconnecting ??= this.connect().finally(() => {
        this.reconnecting = null;
      }));
    } catch (error) {
      return { ok: false, code: 'failed', error: errorMessage(error) };
    }
    return this.invoke(name, args);
  };

  shutdown(reason: string): void {
    if (this.stop) return this.stop(reason);
    log.info(`${reason}, exiting`);
    process.exit(0);
  }
}

export async function runMcpCommand(argv: readonly string[]): Promise<void> {
  logInfoToStderr();
  const args = parseCliArgs(argv);
  if (args.help || args.version) {
    process.stdout.write(args.help ? MCP_USAGE : `${SERVER_VERSION}\n`);
    return;
  }
  const config = loadConfig(process.env, args);
  const deviceControl = config.allowDeviceControl;
  const backend = new McpBackend(config, deviceControl, config.allowNetworkBodies);
  await backend.connect();

  serveStdio(
    () =>
      createAgentMcpServer({
        version: SERVER_VERSION,
        tools: availableTools(deviceControl),
        deviceControl,
        invoke: backend.invoke,
      }),
    { maxSubscriptions: MAX_MCP_SUBSCRIPTIONS },
  );
  // The MCP stdio binding: exit once the client closes our stdin.
  let gone = false;
  const onClientGone = () => {
    if (gone) return;
    gone = true;
    backend.shutdown('MCP client disconnected');
  };
  process.stdin.once('end', onClientGone);
  process.stdin.once('close', onClientGone);
}
