import type { MemorySample } from '@lionscope/protocol';

export type MemoryBreakdown = Omit<MemorySample, 'ts'>;

const SUMMARY_FIELDS: ReadonlyArray<readonly [label: string, key: keyof MemoryBreakdown]> = [
  ['Java Heap', 'javaHeapKb'],
  ['Native Heap', 'nativeHeapKb'],
  ['Code', 'codeKb'],
  ['Stack', 'stackKb'],
  ['Graphics', 'graphicsKb'],
  ['Private Other', 'privateOtherKb'],
  ['System', 'systemKb'],
  ['TOTAL PSS', 'totalPssKb'],
];

function emptyBreakdown(): MemoryBreakdown {
  return {
    totalPssKb: 0,
    javaHeapKb: 0,
    nativeHeapKb: 0,
    codeKb: 0,
    stackKb: 0,
    graphicsKb: 0,
    privateOtherKb: 0,
    systemKb: 0,
  };
}

/**
 * Parse `dumpsys meminfo <pid>`. Prefers the "App Summary" section (PSS column); falls back to
 * the `TOTAL` row of the main table on older Android versions. Returns null when nothing usable
 * is found (e.g. "No process found for: ...").
 */
export function parseMeminfo(text: string): MemoryBreakdown | null {
  const result = emptyBreakdown();
  let found = false;

  for (const [label, key] of SUMMARY_FIELDS) {
    const match = new RegExp(`^\\s*${label}:\\s+(\\d+)`, 'm').exec(text);
    if (match?.[1]) {
      result[key] = Number(match[1]);
      found = true;
    }
  }
  if (found && result.totalPssKb > 0) return result;

  const totalRow = /^\s*TOTAL\s+(\d+)/m.exec(text);
  if (totalRow?.[1]) {
    return { ...result, totalPssKb: Number(totalRow[1]) };
  }
  return found ? result : null;
}
