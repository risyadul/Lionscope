/** Tiny prefixed logger. Set LIONSCOPE_LOG=silent to mute (used by the test suite). */
const PREFIX = '[lionscope]';
let infoToStderr = false;

function isSilent(): boolean {
  return process.env.LIONSCOPE_LOG === 'silent';
}

/** `lionscope mcp`: stdout carries the MCP protocol, so info lines go to stderr like the rest. */
export function logInfoToStderr(): void {
  infoToStderr = true;
}

export const log = {
  info(...args: unknown[]): void {
    if (isSilent()) return;
    if (infoToStderr) console.error(PREFIX, ...args);
    else console.info(PREFIX, ...args);
  },
  warn(...args: unknown[]): void {
    if (!isSilent()) console.warn(PREFIX, ...args);
  },
  error(...args: unknown[]): void {
    if (!isSilent()) console.error(PREFIX, ...args);
  },
};

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
