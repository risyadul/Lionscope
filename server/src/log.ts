/** Tiny prefixed logger. Set LIONSCOPE_LOG=silent to mute (used by the test suite). */
const PREFIX = '[lionscope]';

function isSilent(): boolean {
  return process.env.LIONSCOPE_LOG === 'silent';
}

export const log = {
  info(...args: unknown[]): void {
    if (!isSilent()) console.info(PREFIX, ...args);
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
