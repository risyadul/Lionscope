import { mkdtempSync } from 'node:fs';
import { createServer } from 'node:net';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { getDefaultEnvironment, StdioClientTransport } from '@modelcontextprotocol/client/stdio';

const SERVER_DIR = fileURLToPath(new URL('../..', import.meta.url));

/** A port nothing listens on (bound once, then released). */
export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as AddressInfo;
      probe.close(() => resolve(port));
    });
  });
}

/**
 * `lionscope mcp <args>` from source as a child process, with an MCP client on its stdio. HOME points at an
 * empty directory and there is no usable adb, so a server it starts sees no SDK, emulator or device.
 */
export async function connectStdio(
  args: readonly string[],
): Promise<{ client: Client; stderr: () => string }> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['--import', 'tsx', path.join(SERVER_DIR, 'src', 'main.ts'), 'mcp', ...args],
    cwd: SERVER_DIR,
    env: {
      ...getDefaultEnvironment(),
      HOME: mkdtempSync(path.join(tmpdir(), 'lionscope-mcp-')),
      ANDROID_HOME: '/nonexistent/sdk',
      ANDROID_SDK_ROOT: '/nonexistent/sdk',
    },
    stderr: 'pipe',
  });
  let stderr = '';
  transport.stderr?.on('data', (chunk: Buffer) => (stderr += String(chunk)));
  const client = new Client({ name: 'lionscope-test', version: '1.0.0' });
  await client.connect(transport);
  return { client, stderr: () => stderr };
}
