/** The agent tools as an MCP server (official TypeScript SDK v2), shared by the HTTP endpoint and `lionscope mcp`. */
import { McpServer } from '@modelcontextprotocol/server';
import type { CallToolResult } from '@modelcontextprotocol/server';
import type { ToolOutcome } from './registry.ts';
import type { AgentTool } from './tool.ts';
import { UNTRUSTED_DESCRIPTION } from './tool.ts';

/** Runs a tool: in this process (callTool) or on the server `lionscope mcp` attached to. */
export type ToolInvoker = (name: string, args: unknown) => Promise<ToolOutcome>;

const READ_INSTRUCTIONS = `Lionscope profiles one Android app over adb (CPU, memory, frames, logcat) and, when the app embeds the Lionscope SDK, its screens, main-thread stalls, StrictMode violations and layout inflation. Call status first: it lists devices, emulators and the session. To profile: list_apps, then start_session. Then read with get_summary and drill down (get_screens, get_stalls, get_strictmode, get_layouts, get_view_tree, search_logcat); windows are the last 1, 5 or 10 minutes. The dashboard shows the same data at the URL status gives. When the user refers to "this element", "the one I selected" or a view they picked, call get_inspector_selection: it returns the element the user selected in the dashboard's Layout Inspector (attributes, the XML layout and line of a view or the Kotlin file and line a composable is called from, owning Fragment, a cropped image of it); select_inspector_node highlights an element for the user (for a node you select yourself, get_inspector_selection returns its structure only). With SDK 0.7.0+ and Lionscope.okHttpInterceptor() in the app's OkHttpClient, get_network lists its HTTP requests (status, timings, sizes, failures) and get_network_request shows one with its headers; body texts only when Lionscope runs with --allow-network-bodies.`;
const DEVICE_INSTRUCTIONS =
  'Device control is enabled: prefer get_ui_tree with tap_element, wait_for and scroll_to (exact, element-based) over screenshot with tap (coordinates), which is the fallback for content the UI tree does not show. inspect_screen takes a Layout Inspector snapshot (with XML layout sources and the call sites of composables when the app embeds the SDK); it replaces the snapshot the user sees, so read get_inspector_selection first when they mean an element they picked. set_view_property changes a View of that snapshot live (visibility, alpha, padding, margins, size, translation, elevation, colors, TextView text and size; SDK 0.8.0+, the `editable` list of a node says what it accepts) so you can try a layout fix on the running app before editing code; edits are temporary, and revert_view_properties undoes them: revert what you changed when you are done. set_network_mock and clear_network_mocks change what the app receives from the network (made-up responses, timeouts, connection errors) for the running session: tell the user which mocks you set, and clear them when you are done.';

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
