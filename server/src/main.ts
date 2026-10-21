import { createAdb } from './adb/adb.ts';
import { resolveAdbPath } from './adb/resolveAdb.ts';
import { loadConfig } from './config.ts';
import { errorMessage, log } from './log.ts';
import { createLionscopeServer } from './server.ts';

async function main(): Promise<void> {
  const config = loadConfig();
  const adb = createAdb(resolveAdbPath());
  try {
    const version = await adb.exec(['version'], { timeoutMs: 5000 });
    log.info(`Using ${version.split('\n')[0]?.trim() ?? 'adb'} at ${adb.path}`);
  } catch (error) {
    log.warn(`adb not usable at "${adb.path}" (${errorMessage(error)}). Set LIONSCOPE_ADB or ANDROID_HOME.`);
  }

  const server = createLionscopeServer({
    port: config.port,
    devicePort: config.devicePort,
    adb,
    dashboardDir: config.dashboardDir,
    dev: config.dev,
  });
  try {
    const address = await server.listen();
    log.info(`Lionscope running at http://localhost:${address.port}`);
    if (server.deviceAddress) log.info(`SDK gateway on ${config.host}:${server.deviceAddress.port}`);
    if (config.dev)
      log.info('Dev mode: accepting WebSocket connections from the Vite dev server (port 5173)');
  } catch (error) {
    log.error(`Cannot listen on ${config.host}:${config.port}: ${errorMessage(error)}`);
    process.exit(1);
  }

  let shuttingDown = false;
  const shutdown = (reason: string): void => {
    if (shuttingDown) process.exit(1);
    shuttingDown = true;
    log.info(`${reason}, shutting down`);
    const force = setTimeout(() => process.exit(1), 5000);
    force.unref();
    server.close().then(
      () => process.exit(0),
      (error: unknown) => {
        log.error('Shutdown failed:', errorMessage(error));
        process.exit(1);
      },
    );
  };
  // Every exit path goes through close(), which also removes the session's `adb reverse` mapping.
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
    process.on(signal, () => shutdown(`${signal} received`));
  }
  process.on('uncaughtException', (error) => {
    log.error('Uncaught exception:', error.stack ?? error.message);
    shutdown('uncaught exception');
  });
}

main().catch((error: unknown) => {
  log.error(errorMessage(error));
  process.exit(1);
});
