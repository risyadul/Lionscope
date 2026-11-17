import { runMcpCommand } from './cli/mcpCommand.ts';
import { runQueryCommand } from './cli/queryCommand.ts';
import { runDaemonChild, runLifecycle, startBackground } from './cli/daemon.ts';
import { exitOnShutdown, startLionscope } from './cli/serve.ts';
import { loadConfig, parseCliArgs, SERVER_VERSION, USAGE } from './config.ts';
import { errorMessage, log } from './log.ts';
import { runPermissionsCommand } from './cli/permissionsCommand.ts';

async function main(): Promise<void> {
  let argv = process.argv.slice(2);
  if (argv[0] === '__daemon') return runDaemonChild(argv.slice(1));
  if (argv[0] === 'mcp') return runMcpCommand(argv.slice(1));
  if (argv[0] === 'query') {
    process.exitCode = await runQueryCommand(argv.slice(1));
    return;
  }
  if (argv[0] === 'permissions') return runPermissionsCommand(argv.slice(1));
  if (argv[0] === 'stop' || argv[0] === 'status' || argv[0] === 'logs') {
    return runLifecycle(argv[0], argv.slice(1));
  }
  if (argv[0] === 'start') argv = argv.slice(1);
  const args = parseCliArgs(argv);
  if (args.help || args.version) {
    process.stdout.write(args.help ? USAGE : `${SERVER_VERSION}\n`);
    return;
  }
  const config = loadConfig(process.env, args);
  if (!args.foreground) return startBackground(argv, args, config);
  let server;
  try {
    server = await startLionscope(config);
  } catch (error) {
    log.error(errorMessage(error));
    process.exit(1);
  }
  exitOnShutdown(server);
}

main().catch((error: unknown) => {
  log.error(errorMessage(error));
  process.exit(1);
});
