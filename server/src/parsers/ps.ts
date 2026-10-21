/** Parse `ps -A -o PID,NAME` into name → pid (first occurrence wins). */
export function parsePs(output: string): Map<string, number> {
  const pids = new Map<string, number>();
  for (const line of output.split(/\r?\n/)) {
    const match = /^\s*(\d+)\s+(\S+)\s*$/.exec(line);
    if (!match?.[1] || !match[2]) continue;
    if (!pids.has(match[2])) pids.set(match[2], Number(match[1]));
  }
  return pids;
}
