import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { appendFile, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { probeServer } from '../src/cli/agentClient.ts';
import { freePort } from './helpers/agentProcess.ts';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const MAIN = path.join(ROOT, 'server/src/main.ts');
const stateFields = z.object({ pid: z.number(), token: z.string() }).passthrough();

describe('background CLI lifecycle', () => {
  let directory: string;
  let port: number;
  let env: NodeJS.ProcessEnv;

  function command(args: string[] = []) {
    return new Promise<{ code: number; stdout: string; stderr: string }>((resolve, reject) => {
      execFile(
        process.execPath,
        ['--import', 'tsx', MAIN, ...args],
        {
          cwd: ROOT,
          env,
          encoding: 'utf8',
          timeout: 30_000,
        },
        (error, stdout, stderr) => {
          if (error) {
            if (typeof error.code !== 'number') reject(error);
            else resolve({ code: error.code, stdout, stderr });
          } else resolve({ code: 0, stdout, stderr });
        },
      );
    });
  }
  async function state() {
    const value: unknown = JSON.parse(await readFile(path.join(directory, `${port}.json`), 'utf8'));
    return stateFields.parse(value);
  }

  beforeEach(async () => {
    directory = await mkdtemp(path.join(tmpdir(), 'lionscope-daemon-'));
    port = await freePort();
    env = {
      ...process.env,
      LIONSCOPE_LOG: '',
      LIONSCOPE_STATE_DIR: directory,
      LIONSCOPE_PORT: String(port),
      LIONSCOPE_DEVICE_PORT: '0',
      LIONSCOPE_ADB: '/nonexistent/adb',
      ANDROID_HOME: '/nonexistent/sdk',
      ANDROID_SDK_ROOT: '/nonexistent/sdk',
    };
  });
  afterEach(async () => {
    await command(['stop']);
    await rm(directory, { recursive: true, force: true });
  });

  it('returns the terminal by default, reuses the server, reads logs and stops cleanly', async () => {
    const started = await command();
    expect(started).toMatchObject({ code: 0, stdout: expect.stringContaining('running in background') });
    const own = await state();
    expect(started.stdout).not.toContain(own.token);
    expect((await probeServer(port)).kind).toBe('lionscope');
    if (process.platform !== 'win32')
      expect((await stat(path.join(directory, `${port}.json`))).mode & 0o777).toBe(0o600);
    expect((await command(['start'])).code).toBe(0);
    expect((await state()).pid).toBe(own.pid);
    expect(await command(['status'])).toMatchObject({
      code: 0,
      stdout: expect.stringContaining(`PID ${own.pid}`),
    });
    expect((await command(['logs'])).stdout).toContain('Lionscope running at');
    const response = await fetch(`http://127.0.0.1:${port}/api/agent/status`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Lionscope-Agent': '1' },
      body: '{}',
    });
    expect(await response.json()).toMatchObject({
      ok: true,
      result: { server: { deviceControl: false }, devices: [] },
    });
    expect(await command(['stop'])).toMatchObject({ code: 0, stdout: expect.stringContaining('stopped') });
    expect((await probeServer(port)).kind).toBe('none');
    await expect(readFile(path.join(directory, `${port}.json`))).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await command(['stop'])).code).toBe(0);
  }, 60_000);

  it('concurrent starts have one owner and permission changes require a restart', async () => {
    const results = await Promise.all([command(), command()]);
    expect(results.map((result) => result.code)).toEqual([0, 0]);
    const own = await state();
    for (const result of results) expect(result.stdout).toContain(`PID ${own.pid}`);
    expect(await command(['--allow-storage-read'])).toMatchObject({
      code: 1,
      stderr: expect.stringContaining('different startup permissions'),
    });
    expect((await state()).pid).toBe(own.pid);
    expect((await command(['stop'])).code).toBe(0);
    expect(
      (await command(['--allow-storage-read', '--allow-storage-write', '--allow-device-control'])).code,
    ).toBe(0);
    expect((await command(['status'])).stdout).toContain('Storage: read/write');
  }, 60_000);

  it('recovers stale state after an unclean exit without signaling a PID from that state', async () => {
    expect((await command()).code).toBe(0);
    const own = await state();
    // This PID came from the test's authenticated launch, not an arbitrary stale record.
    process.kill(own.pid, 'SIGKILL');
    for (let attempt = 0; attempt < 50; attempt++) {
      if ((await probeServer(port, 200)).kind === 'none') break;
      await delay(20);
    }
    await writeFile(path.join(directory, `${port}.json`), JSON.stringify({ ...own, pid: process.pid }));
    expect((await command()).code).toBe(0);
    expect((await state()).pid).not.toBe(own.pid);
    expect((await probeServer(port)).kind).toBe('lionscope');
  }, 60_000);

  it('refuses occupied non-Lionscope ports and cannot stop an unmanaged server', async () => {
    const unrelated = createServer((_request, response) => response.end('unrelated'));
    await new Promise<void>((resolve) => unrelated.listen(port, '127.0.0.1', resolve));
    try {
      expect((await command()).code).toBe(1);
      expect((await command(['stop'])).code).toBe(1);
      expect(await (await fetch(`http://127.0.0.1:${port}`)).text()).toBe('unrelated');
    } finally {
      await new Promise<void>((resolve) => unrelated.close(() => resolve()));
    }
  }, 30_000);

  it('tails bounded log history and follows new output until interrupted', async () => {
    await writeFile(
      path.join(directory, `${port}.log`),
      Array.from({ length: 250 }, (_, index) => `entry-${index}\n`).join(''),
    );
    const history = await command(['logs']);
    expect(history.stdout).not.toContain('entry-149\n');
    expect(history.stdout).toContain('entry-150\n');
    expect(history.stdout).toContain('entry-249\n');
    const follower = spawn(process.execPath, ['--import', 'tsx', MAIN, 'logs', '--follow'], {
      cwd: ROOT,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    follower.stdout.on('data', (chunk: Buffer) => {
      output += chunk.toString();
    });
    try {
      await expect.poll(() => output, { timeout: 10_000 }).toContain('entry-249');
      // Wait for the follow cursor to be installed after the initial history is printed.
      await delay(50);
      await appendFile(path.join(directory, `${port}.log`), 'new-entry\n');
      await expect.poll(() => output, { timeout: 5000 }).toContain('new-entry');
    } finally {
      const exited = once(follower, 'exit');
      follower.kill('SIGINT');
      await exited;
    }
  }, 30_000);

  it('validates lifecycle flags and does not detach a random dashboard port', async () => {
    expect((await command(['--port', '0'])).code).toBe(1);
    expect((await command(['status', '--port', '0'])).code).toBe(1);
    expect((await command(['stop', '--port', '1', '--port', '2'])).code).toBe(1);
    expect((await command(['status', '--allow-device-control'])).code).toBe(1);
    expect((await command(['__daemon'])).code).toBe(1);
    expect((await command(['logs', '--help'])).stdout).toContain('--follow');
    expect((await probeServer(port)).kind).toBe('none');
  }, 30_000);

  it('preserves the caller logging environment in the detached process', async () => {
    env.LIONSCOPE_LOG = 'silent';
    expect((await command()).code).toBe(0);
    expect((await probeServer(port)).kind).toBe('lionscope');
    expect(await readFile(path.join(directory, `${port}.log`), 'utf8')).not.toContain('Lionscope running at');
  }, 30_000);

  it('keeps --foreground attached and removes background state on SIGTERM', async () => {
    const child = spawn(process.execPath, ['--import', 'tsx', MAIN, '--foreground'], {
      cwd: ROOT,
      env,
      stdio: 'ignore',
    });
    try {
      await expect
        .poll(async () => (await probeServer(port, 200)).kind, { timeout: 15_000 })
        .toBe('lionscope');
      expect((await command()).stdout).toContain('started elsewhere');
      expect((await command(['stop'])).code).toBe(1);
      await expect(readFile(path.join(directory, `${port}.json`))).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      const exited = once(child, 'exit');
      child.kill('SIGTERM');
      await exited;
    }
    expect((await command()).code).toBe(0);
    const own = await state();
    process.kill(own.pid, 'SIGTERM');
    await expect.poll(async () => (await probeServer(port, 200)).kind, { timeout: 15_000 }).toBe('none');
    await expect(readFile(path.join(directory, `${port}.json`))).rejects.toMatchObject({ code: 'ENOENT' });
  }, 60_000);
});
