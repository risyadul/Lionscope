/** The agent tools as an MCP server (official TypeScript SDK v2), shared by the HTTP endpoint and `lionscope mcp`. */
import { McpServer } from '@modelcontextprotocol/server';
import type { CallToolResult } from '@modelcontextprotocol/server';
import type { ToolOutcome } from './registry.ts';
import type { AgentTool } from './tool.ts';
import { UNTRUSTED_DESCRIPTION } from './tool.ts';

/** Runs a tool: in this process (callTool) or on the server `lionscope mcp` attached to. */
export type ToolInvoker = (name: string, args: unknown) => Promise<ToolOutcome>;

const READ_INSTRUCTIONS = `Lionscope profiles one Android app over adb (CPU, memory, frames, logcat) and, when the app embeds the Lionscope SDK, its screens, main-thread stalls, StrictMode violations and layout inflation. Call status first: it lists devices, emulators and the session. To profile: list_apps, then start_session. Then read with get_summary and drill down (get_screens, get_stalls, get_strictmode, get_layouts, get_view_tree, search_logcat); windows are the last 1, 5 or 10 minutes. The dashboard shows the same data at the URL status gives.`;
const DEVICE_INSTRUCTIONS =
  'Device control is enabled: prefer get_ui_tree with tap_element, wait_for and scroll_to (exact, element-based) over screenshot with tap (coordinates), which is the fallback for content the UI tree does not show.';

/** Server instructions; the device tools are only mentioned to a client that has them. */
export function mcpInstructions(deviceControl: boolean): string {
  return [READ_INSTRUCTIONS, ...(deviceControl ? [DEVICE_INSTRUCTIONS] : []), UNTRUSTED_DESCRIPTION].join(
    ' ',
  );
}

/** Streams a client may keep open (`subscriptions/listen`); Lionscope publishes no change events. */
export const MAX_MCP_SUBSCRIPTIONS = 16;

/** The MCP result of a tool outcome: JSON as text plus structuredContent; images as image content. */
export function toCallToolResult(outcome: ToolOutcome): CallToolResult {
  if (!outcome.ok) return { isError: true, content: [{ type: 'text', text: outcome.error }] };
  const text = { type: 'text' as const, text: JSON.stringify(outcome.result) };
  const structured =
    typeof outcome.result === 'object' && outcome.result !== null && !Array.isArray(outcome.result)
      ? { structuredContent: outcome.result as Record<string, unknown> }
      : {};
  const image = outcome.image
    ? [{ type: 'image' as const, data: outcome.image.data, mimeType: outcome.image.mimeType }]
    : [];
  return { content: [...image, text], ...structured };
}

export function createAgentMcpServer(options: {
  version: string;
  tools: readonly AgentTool[];
  deviceControl: boolean;
  invoke: ToolInvoker;
}): McpServer {
  const server = new McpServer(
    { name: 'lionscope', title: 'Lionscope', version: options.version },
    { capabilities: { tools: {} }, instructions: mcpInstructions(options.deviceControl) },
  );
  for (const tool of options.tools) {
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: tool.input,
        annotations: tool.annotations,
      },
      async (args: unknown) => toCallToolResult(await options.invoke(tool.name, args)),
    );
  }
  return server;
}
