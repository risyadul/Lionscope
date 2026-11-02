interface PsRow {
  pid: number;
  name: string;
}

/**
 * The rows of a `ps` listing in the order printed: `PID NAME` (`ps -A -o PID,NAME`) or the full table
 * (`USER PID PPID VSIZE RSS WCHAN PC S NAME` on toolbox, API 23-25), where the NAME is the last
 * column. Headers and any other line without a PID in its PID column are skipped.
 */
function psRows(output: string): PsRow[] {
  const rows: PsRow[] = [];
  for (const line of output.split(/\r?\n/)) {
    const fields = line.trim().split(/\s+/);
    const name = fields.at(-1);
    if (!name || fields.length < 2) continue;
    const pid = Number(fields.length === 2 ? fields[0] : fields[1]);
    if (Number.isInteger(pid) && pid > 0) rows.push({ pid, name });
  }
  return rows;
}

/**
 * Process name → PID of a `ps` listing. The first process printed under a name wins, whichever user
 * owns it: names are compared as a whole, so `pkg:service` and `pkg.debug` never stand for `pkg`.
 */
export function parsePs(output: string): Map<string, number> {
  const pids = new Map<string, number>();
  for (const { pid, name } of psRows(output)) {
    if (!pids.has(name)) pids.set(name, pid);
  }
  return pids;
}

/** PIDs of the processes named exactly `name` in a `ps` listing (see parsePs), in the order printed. */
export function parsePsPids(output: string, name: string): number[] {
  const pids: number[] = [];
  for (const row of psRows(output)) {
    if (row.name === name && !pids.includes(row.pid)) pids.push(row.pid);
  }
  return pids;
}
