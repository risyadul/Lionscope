/**
 * Saved states per Activity object (0.12.0): the SDK's instances joined into chains across configuration changes
 * (`prevId`), each with the trend of its saves. The dashboard's State tab and `get_saved_state` share these.
 */
import type { SavedStateInstance, SavedStateSample } from '../wire.ts';
import { MAX_SAVED_STATE_INSTANCES } from '../wire.ts';

/**
 * The instances a session keeps at `now`: closed ones for `windowMs` after `closedAt`, then within
 * MAX_SAVED_STATE_INSTANCES by dropping the longest closed (live ones always stay). Order kept.
 */
export function pruneSavedStateInstances(
  instances: readonly SavedStateInstance[],
  now: number,
  windowMs: number,
): SavedStateInstance[] {
  const cutoff = now - windowMs;
  const kept = instances.filter((instance) => instance.closedAt === null || instance.closedAt >= cutoff);
  const excess = kept.length - MAX_SAVED_STATE_INSTANCES;
  if (excess <= 0) return kept;
  const dropped = new Set(
    kept
      .filter((instance) => instance.closedAt !== null)
      .sort((a, b) => (a.closedAt ?? 0) - (b.closedAt ?? 0))
      .slice(0, excess),
  );
  return kept.filter((instance) => !dropped.has(instance));
}

/** One Activity across its configuration changes: the newest instance (`head`) and those it replaced. */
export interface SavedStateChain {
  pid: number;
  head: SavedStateInstance;
  /** Newest first: the head, then the instance it replaced, and so on. */
  instances: SavedStateInstance[];
}

export interface SavedStateTrend {
  /** Saves in the range. */
  saves: number;
  /** Bytes of the oldest and newest save in the range, and the largest; null without saves. */
  firstBytes: number | null;
  lastBytes: number | null;
  maxBytes: number | null;
  lastTs: number | null;
}

const keyOf = (pid: number, id: number) => `${pid}:${id}`;

/**
 * The instances as chains (a configuration change links the new instance to the one it replaced, within a process):
 * one per instance no other replaced, oldest head first.
 */
export function instanceChains(instances: readonly SavedStateInstance[]): SavedStateChain[] {
  const byKey = new Map(instances.map((instance) => [keyOf(instance.pid, instance.id), instance]));
  const replaced = new Set<string>();
  for (const instance of instances) {
    if (instance.prevId !== null && byKey.has(keyOf(instance.pid, instance.prevId))) {
      replaced.add(keyOf(instance.pid, instance.prevId));
    }
  }
  const chains: SavedStateChain[] = [];
  for (const head of instances) {
    if (replaced.has(keyOf(head.pid, head.id))) continue;
    const chain = [head];
    const seen = new Set([head.id]);
    let current = head;
    while (current.prevId !== null && !seen.has(current.prevId)) {
      const previous = byKey.get(keyOf(current.pid, current.prevId));
      if (!previous) break;
      seen.add(previous.id);
      chain.push(previous);
      current = previous;
    }
    chains.push({ pid: head.pid, head, instances: chain });
  }
  return chains;
}

/** The chain's saves in [fromTs, toTs], newest first. */
export function chainReports(
  chain: SavedStateChain,
  reports: readonly SavedStateSample[],
  fromTs: number,
  toTs: number,
): SavedStateSample[] {
  const ids = new Set(chain.instances.map((instance) => instance.id));
  return reports
    .filter(
      (report) =>
        report.pid === chain.pid &&
        report.instanceId !== null &&
        ids.has(report.instanceId) &&
        report.ts >= fromTs &&
        report.ts <= toTs,
    )
    .sort((a, b) => b.ts - a.ts);
}

/** How the chain's saves in [fromTs, toTs] grew. */
export function chainTrend(
  chain: SavedStateChain,
  reports: readonly SavedStateSample[],
  fromTs: number,
  toTs: number,
): SavedStateTrend {
  const saves = chainReports(chain, reports, fromTs, toTs);
  const newest = saves[0];
  const oldest = saves[saves.length - 1];
  return {
    saves: saves.length,
    firstBytes: oldest?.totalBytes ?? null,
    lastBytes: newest?.totalBytes ?? null,
    maxBytes: saves.length === 0 ? null : Math.max(...saves.map((save) => save.totalBytes)),
    lastTs: newest?.ts ?? null,
  };
}

/** A chain with its saves in a range, as the State tab and `get_saved_state` list it. */
export interface SavedStateChainRow extends SavedStateTrend {
  chain: SavedStateChain;
  /** The newest save's screen name in the range, else null. */
  screen: string | null;
  /** Newest first. */
  reports: SavedStateSample[];
}

/**
 * The chains to show for [fromTs, toTs]: every live one, and a closed or ended one when it closed or saved in the
 * range. In instance order (oldest head first).
 */
export function savedStateChainRows(
  instances: readonly SavedStateInstance[],
  reports: readonly SavedStateSample[],
  fromTs: number,
  toTs: number,
): SavedStateChainRow[] {
  const rows: SavedStateChainRow[] = [];
  for (const chain of instanceChains(instances)) {
    const saves = chainReports(chain, reports, fromTs, toTs);
    const { closedAt, state } = chain.head;
    const closedInRange = closedAt !== null && closedAt >= fromTs && closedAt <= toTs;
    if (state !== 'live' && !closedInRange && saves.length === 0) continue;
    rows.push({
      chain,
      reports: saves,
      screen: saves[0]?.screen ?? null,
      ...chainTrend(chain, saves, fromTs, toTs),
    });
  }
  return rows;
}

export type SavedStateOrder = 'largest' | 'latest';

/**
 * `largest`: the newest save's size, biggest first (then the newest); `latest`: the newest save first. Rows without a
 * save in the range always come last (oldest first).
 */
export function sortChainRows(
  rows: readonly SavedStateChainRow[],
  order: SavedStateOrder,
): SavedStateChainRow[] {
  return [...rows].sort((a, b) => {
    if (a.lastTs === null || b.lastTs === null) {
      if (a.lastTs !== null) return -1;
      if (b.lastTs !== null) return 1;
      return a.chain.head.firstSeen - b.chain.head.firstSeen;
    }
    if (order === 'largest') return (b.lastBytes ?? 0) - (a.lastBytes ?? 0) || b.lastTs - a.lastTs;
    return b.lastTs - a.lastTs;
  });
}
