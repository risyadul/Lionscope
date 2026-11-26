/**
 * Wireless ADB agent tools (require enabled device-control permission).
 * Host policy restricts targets to private/LAN, link-local, IPv6 ULA, Tailscale (100.64/10),
 * mDNS serials, or a host:port the user already connected from the dashboard in this server run.
 */
import { z } from 'zod';
import { defineTool, ToolError } from './tool.ts';
import type { AgentContext } from './tool.ts';

function requireWireless(ctx: AgentContext) {
  if (!ctx.wireless) throw new ToolError('Wireless ADB is not available on this server');
  return ctx.wireless;
}

export const connectDeviceTool = defineTool({
  name: 'connect_device',
  title: 'Connect a wireless device',
  description:
    'Connects to an Android device over wireless ADB (`adb connect <host>:<port>` or an mDNS TLS serial). Only private IPv4 (10/8, 172.16/12, 192.168/16), link-local, IPv6 ULA (fc00::/7), Tailscale (100.64/10), mDNS serials, or a host:port already connected from the dashboard in this server run are allowed. Device control.',
  access: 'device',
  input: z.object({
    address: z
      .string()
      .min(1)
      .max(260)
      .describe('Wireless ADB target: <host>:<port> (IPv4 or [IPv6]:port) or an mDNS serial.'),
  }),
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  async run({ address }, ctx) {
    const result = await requireWireless(ctx).connect(address, 'agent');
    return { data: result };
  },
});

export const disconnectDeviceTool = defineTool({
  name: 'disconnect_device',
  title: 'Disconnect a wireless device',
  description:
    'Disconnects a wireless Android device (`adb disconnect <serial>`), ending any profiling session on it first. Requires an explicit wireless serial (<host>:<port> or mDNS serial) within the allowed wireless host policy. Device control.',
  access: 'device',
  input: z.object({
    serial: z
      .string()
      .min(1)
      .max(260)
      .describe('Wireless ADB serial (<host>:<port> or mDNS serial) to disconnect.'),
  }),
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  async run({ serial }, ctx) {
    const result = await requireWireless(ctx).disconnect(serial, 'agent');
    return { data: { ...result, disconnected: true } };
  },
});
