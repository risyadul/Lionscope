import { fork } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { watchFile, unwatchFile } from 'node:fs';
import { mkdir, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { parseArgs } from 'node:util';
import { z } from 'zod';
import { HOST, loadConfig, parseCliArgs, permissionOverrides, SERVER_VERSION } from '../config.ts';
import { requestPermissions } from './permissionsCommand.ts';
import type { CliArgs, LionscopeConfig } from '../config.ts';
import { DAEMON_HEADER, DAEMON_PATH } from '../http/daemonControl.ts';
import { probeServer } from './agentClient.ts';
import { exitOnShutdown, startLionscope } from './serve.ts';

const START_TIMEOUT_MS = 20_000;
const STOP_TIMEOUT_MS = 15_000;
const LOG_READ_BYTES = 256 * 1024;
const LOG_ROTATE_BYTES = 5 * 1024 * 1024;

const stateSchema = z.object({
  token: z.string().regex(/^[a-f0-9]{64}$/),
  pid: z.number().int().positive(),
  port: z.number().int().min(1).max(65535),
  devicePort: z.number().int().min(0).max(65535).nullable(),
  version: z.string().max(100),
  startedAt: z.string().max(100),
  options: z.object({
    dev: z.boolean(),
    allowDeviceControl: z.boolean(),
    allowNetworkBodies: z.boolean(),
    allowStorageRead: z.boolean(),
    allowStorageWrite: z.boolean(),
    adb: z.string().optional(),
    devicePort: z.number().int(),
  }),
});
type DaemonState = z.infer<typeof stateSchema>;

function files(port: number) {
  const dir = process.env.LIONSCOPE_STATE_DIR || path.join(homedir(), '.lionscope');
  return {
    dir,
    state: path.join(dir, `${port}.json`),
    log: path.join(dir, `${port}.log`),
  };
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

async function readState(port: number): Promise<DaemonState | null> {
  try {
    const result = stateSchema.safeParse(JSON.parse(await readFile(files(port).state, 'utf8')));
    return result.success && result.data.port === port ? result.data : null;
  } catch (error) {
    if (isMissing(error) || error instanceof SyntaxError) return null;
    throw error;
  }
}

async function forget(state: DaemonState): Promise<void> {
  if ((await readState(state.port))?.token === state.token)
    await rm(files(state.port).state, { force: true });
}

async function control(state: DaemonState, action: 'status' | 'stop'): Promise<boolean> {
  try {
    const response = await fetch(`http://${HOST}:${state.port}${DAEMON_PATH}${action}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', [DAEMON_HEADER]: state.token },
      signal: AbortSignal.timeout(2000),
    });
    const body: unknown = await response.json();
    return (
      response.ok &&
      typeof body === 'object' &&
      body !== null &&
      'pid' in body &&
      body.pid === state.pid &&
      'port' in body &&
      body.port === state.port
    );
  } catch {
    return false;
  }
}

async function managedState(port: number): Promise<DaemonState | null> {
  const state = await readState(port);
  return state && (await control(state, 'status')) ? state : null;
}

function printRunning(state: DaemonState): void {
  process.stdout.write(
    `Lionscope running in background (PID ${state.pid})\nDashboard: http://localhost:${state.port}\nLogs: ${files(state.port).log}\n`,
  );
}

async function checkRequestedOptions(state: DaemonState, args: CliArgs): Promise<void> {
  if (args.dev && !state.options.dev)
    throw new Error('The running instance has different startup mode. Stop it before changing dev mode.');
  if (
    (args.adb !== undefined && args.adb !== state.options.adb) ||
    (args.devicePort !== undefined && Number(args.devicePort) !== state.options.devicePort)
  ) {
    throw new Error('The running instance has different startup options. Stop it before changing them.');
  }
  const patch = permissionOverrides(args);
  if (Object.keys(patch).length) await requestPermissions(state.port, patch);
}

export async function startBackground(
  argv: readonly string[],
  args: CliArgs,
  config: LionscopeConfig,
): Promise<void> {
  if (config.port === 0)
    throw new Error('Background mode needs a fixed --port. Use --foreground with --port 0.');
  const start = async () => {
    const existing = await readState(config.port);
    if (existing && (await control(existing, 'status'))) {
      await checkRequestedOptions(existing, args);
      printRunning(existing);
      return;
    }
    const probe = await probeServer(config.port);
    if (probe.kind === 'other') throw new Error(probe.detail);
    if (probe.kind === 'lionscope') {
      // A concurrent launcher may have bound the port just before publishing its state.
      for (let attempt = 0; attempt < 5; attempt++) {
        const peer = await managedState(config.port);
        if (peer) {
          await checkRequestedOptions(peer, args);
          printRunning(peer);
          return;
        }
        await delay(100);
      }
      if (args.devicePort !== undefined || args.adb !== undefined || args.dev) {
        throw new Error(
          'A Lionscope instance started elsewhere already uses this port. Its startup options were not changed.',
        );
      }
      const patch = permissionOverrides(args);
      if (Object.keys(patch).length) await requestPermissions(config.port, patch);
      process.stdout.write(
        `Lionscope already running at http://localhost:${config.port} (started elsewhere).\nUse its original terminal or process manager to stop it.\n`,
      );
      return;
    }
    if (existing) await forget(existing);
    const paths = files(config.port);
    await mkdir(paths.dir, { recursive: true, mode: 0o700 });
    const previousLog = await stat(paths.log).catch(() => null);
    if (previousLog && previousLog.size >= LOG_ROTATE_BYTES) {
      await rename(paths.log, `${paths.log}.1`).catch((error) => {
        if (!isMissing(error)) throw error;
      });
    }
    const log = await open(paths.log, 'a', 0o600);
    const child = fork(process.argv[1]!, ['__daemon', ...argv], {
      detached: true,
      windowsHide: true,
      stdio: ['ignore', log.fd, log.fd, 'ipc'],
    });
    await log.close();
    const token = randomBytes(32).toString('hex');
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(
          () => finish(new Error(`Startup timed out. See ${paths.log}`)),
          START_TIMEOUT_MS,
        );
        const finish = (error?: Error) => {
          clearTimeout(timer);
          child.off('message', onMessage);
          child.off('error', onError);
          child.off('exit', onExit);
          if (error) reject(error);
          else resolve();
        };
        const onError = (error: Error) => finish(error);
        const onExit = () => finish(new Error(`Lionscope could not start. See ${paths.log}`));
        const onMessage = (value: unknown) => {
          if (value === 'boot')
            child.send({ token }, (error) => {
              if (error) finish(error);
            });
          if (value === 'ready') finish();
        };
        child.on('message', onMessage);
        child.once('error', onError);
        child.once('exit', onExit);
      });
      child.unref();
      const state = await readState(config.port);
      if (!state || state.token !== token || !(await control(state, 'status')))
        throw new Error(`Background server did not become ready. See ${paths.log}`);
      printRunning(state);
    } catch (error) {
      child.kill('SIGTERM');
      child.unref();
      // Only the OS can grant the listening port. A concurrent winner owns its own authenticated record.
      for (let attempt = 0; attempt < 10; attempt++) {
        const peer = await managedState(config.port);
        if (peer && peer.token !== token) {
          await checkRequestedOptions(peer, args);
          printRunning(peer);
          return;
        }
        await delay(100);
      }
      throw error;
    }
  };
  await start();
}

export async function runDaemonChild(argv: readonly string[]): Promise<void> {
  if (!process.send) throw new Error('Internal daemon entry requires a parent CLI.');
  const incoming = once(process, 'message');
  process.send('boot');
  const bootstrap: unknown = (await incoming)[0];
  const parsed = z
    .object({ token: z.string().regex(/^[a-f0-9]{64}$/) })
    .strict()
    .parse(bootstrap);
  const config = loadConfig(process.env, parseCliArgs(argv));
  let shutdown: ((reason: string) => void) | undefined = undefined;
  let ready = false;
  process.once('disconnect', () => {
    if (!ready) {
      if (shutdown) shutdown('Launcher disconnected');
      else process.exit(1);
    }
  });
  if (!process.connected) throw new Error('The launcher disconnected before startup.');
  let stopping = false;
  const server = await startLionscope(config, {
    token: parsed.token,
    stop: () => {
      if (!stopping) {
        stopping = true;
        shutdown?.('CLI stop requested');
      }
    },
  });
  const state: DaemonState = {
    token: parsed.token,
    pid: process.pid,
    port: config.port,
    devicePort: server.deviceAddress?.port ?? null,
    version: SERVER_VERSION,
    startedAt: new Date().toISOString(),
    options: {
      dev: config.dev,
      allowDeviceControl: server.permissions.value.deviceControl,
      allowNetworkBodies: server.permissions.value.networkBodies,
      allowStorageRead: server.permissions.value.storageRead,
      allowStorageWrite: server.permissions.value.storageWrite,
      adb: config.adb,
      devicePort: config.devicePort,
    },
  };
  shutdown = exitOnShutdown(server, () => forget(state));
  const paths = files(config.port);
  const temporary = `${paths.state}.${randomBytes(8).toString('hex')}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(state), { flag: 'wx', mode: 0o600 });
    await rename(temporary, paths.state);
    ready = true;
    await new Promise<void>((resolve, reject) =>
      process.send?.('ready', (error) => (error ? reject(error) : resolve())),
    );
    process.disconnect?.();
  } catch (error) {
    await server.close();
    await forget(state);
    throw error;
  } finally {
    await rm(temporary, { force: true });
  }
}

export async function runLifecycle(command: 'stop' | 'status' | 'logs', argv: string[]): Promise<void> {
  const { values, tokens } = parseArgs({
    args: argv,
    strict: true,
    tokens: true,
    options: {
      port: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
      ...(command === 'logs' ? { follow: { type: 'boolean' as const, short: 'f' } } : {}),
    },
  });
  const seen = new Set<string>();
  for (const token of tokens) {
    if (token.kind !== 'option') continue;
    if (seen.has(token.name)) throw new Error(`Option '--${token.name}' given more than once`);
    seen.add(token.name);
  }
  if (values.help) {
    process.stdout.write(
      `Usage: lionscope ${command} [--port <port>]${command === 'logs' ? ' [--follow]' : ''}\n`,
    );
    return;
  }
  const config = loadConfig(
    process.env,
    parseCliArgs(values.port === undefined ? [] : ['--port', values.port]),
  );
  if (config.port === 0) throw new Error('Choose a fixed --port for background commands.');
  const paths = files(config.port);
  if (command === 'logs') {
    const print = async () => {
      const file = await open(paths.log, 'r');
      try {
        const size = (await file.stat()).size;
        const buffer = Buffer.alloc(Math.min(size, LOG_READ_BYTES));
        const { bytesRead } = await file.read(buffer, 0, buffer.length, Math.max(0, size - buffer.length));
        process.stdout.write(
          buffer.subarray(0, bytesRead).toString('utf8').split('\n').slice(-101).join('\n'),
        );
      } finally {
        await file.close();
      }
    };
    try {
      await print();
    } catch (error) {
      if (!isMissing(error)) throw error;
      process.stdout.write(`No log file for port ${config.port} yet.\n`);
      return;
    }
    if (values.follow) {
      let position = (await stat(paths.log)).size;
      watchFile(paths.log, { interval: 500 }, async (current, previous) => {
        const rotated = current.ino !== previous.ino;
        if (current.size === position && !rotated) return;
        const file = await open(paths.log, 'r').catch(() => null);
        if (!file) return;
        try {
          const start =
            rotated || current.size < position
              ? Math.max(0, current.size - LOG_READ_BYTES)
              : Math.max(position, current.size - LOG_READ_BYTES);
          const buffer = Buffer.alloc(current.size - start);
          const { bytesRead } = await file.read(buffer, 0, buffer.length, start);
          position = current.size;
          process.stdout.write(buffer.subarray(0, bytesRead));
        } finally {
          await file.close();
        }
      });
      const close = () => {
        unwatchFile(paths.log);
      };
      process.once('SIGINT', close);
      process.once('SIGTERM', close);
    }
    return;
  }
  const operation = async () => {
    const state = await readState(config.port);
    if (!state || !(await control(state, 'status'))) {
      const probe = await probeServer(config.port);
      if (probe.kind !== 'none') {
        if (command === 'stop')
          throw new Error(
            'This port is not owned by a managed Lionscope instance. Use its original terminal or process manager.',
          );
        process.stdout.write(
          probe.kind === 'lionscope'
            ? `Lionscope running at http://localhost:${config.port} (started elsewhere).\n`
            : `${probe.detail}\n`,
        );
      } else {
        if (state) await forget(state);
        process.stdout.write(`Lionscope is stopped on port ${config.port}.\n`);
      }
      return;
    }
    if (command === 'status') {
      const live = await requestPermissions(config.port).catch(() => null);
      const current = live
        ? {
            ...state.options,
            allowDeviceControl: live.deviceControl,
            allowNetworkBodies: live.networkBodies,
            allowStorageRead: live.storageRead,
            allowStorageWrite: live.storageWrite,
          }
        : state.options;
      printRunning(state);
      process.stdout.write(
        `Started: ${state.startedAt}\nVersion: ${state.version}\nSDK port: ${state.devicePort ?? 'unavailable'}\nDevice control: ${current.allowDeviceControl ? 'on' : 'off'}\nNetwork bodies: ${current.allowNetworkBodies ? 'on' : 'off'}\nStorage: ${current.allowStorageRead ? (current.allowStorageWrite ? 'read/write' : 'read only') : 'off'}\n`,
      );
      return;
    }
    if (!(await control(state, 'stop')))
      throw new Error('The managed instance did not accept stop. It was not signaled by PID.');
    const deadline = Date.now() + STOP_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if ((await probeServer(config.port, 500)).kind === 'none') {
        await forget(state);
        process.stdout.write(`Lionscope stopped on port ${config.port}.\n`);
        return;
      }
      await delay(100);
    }
    throw new Error('Shutdown is still in progress. Check status and logs; no force kill was sent.');
  };
  await operation();
}
