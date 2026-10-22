import { runMcpCommand } from './cli/mcpCommand.ts';
import { runQueryCommand } from './cli/queryCommand.ts';
import { exitOnShutdown, startLionscope } from './cli/serve.ts';
import { loadConfig, parseCliArgs, SERVER_VERSION, USAGE } from './config.ts';
import { errorMessage, log } from './log.ts';

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv[0] === 'mcp') return runMcpCommand(argv.slice(1));
  if (argv[0] === 'query') {
    process.exitCode = await runQueryCommand(argv.slice(1));
    return;
  }
  const args = parseCliArgs(argv);
  if (args.help || args.version) {
    process.stdout.write(args.help ? USAGE : `${SERVER_VERSION}\n`);
    return;
  }
  const config = loadConfig(process.env, args);
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
