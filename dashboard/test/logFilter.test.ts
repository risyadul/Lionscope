import { describe, expect, it } from 'vitest';
import {
  filterLogs,
  levelRank,
  LOG_LEVELS,
  matchesLog,
  normalizeQuery,
  splitMatch,
} from '../src/lib/logFilter.ts';
import { log, T0 } from './fixtures.ts';

describe('levels', () => {
  it('orders V < D < I < W < E < F', () => {
    expect(LOG_LEVELS.map(levelRank)).toEqual([0, 1, 2, 3, 4, 5]);
  });
});

describe('matchesLog', () => {
  it('filters by minimum level', () => {
    expect(matchesLog(log(T0, { level: 'V' }), { minLevel: 'D', query: '' })).toBe(false);
    expect(matchesLog(log(T0, { level: 'D' }), { minLevel: 'D', query: '' })).toBe(true);
    expect(matchesLog(log(T0, { level: 'F' }), { minLevel: 'E', query: '' })).toBe(true);
  });

  it('matches tag or message case-insensitively', () => {
    const entry = log(T0, { tag: 'OkHttp', message: 'GET /Shipments 200' });
    expect(matchesLog(entry, { minLevel: 'V', query: 'okhttp' })).toBe(true);
    expect(matchesLog(entry, { minLevel: 'V', query: '  SHIPMENTS ' })).toBe(true);
    expect(matchesLog(entry, { minLevel: 'V', query: 'rxjava' })).toBe(false);
  });
});

describe('filterLogs', () => {
  const logs = [
    log(T0, { level: 'D', message: 'one' }),
    log(T0 + 1, { level: 'E', message: 'two' }),
    log(T0 + 2, { level: 'V', message: 'three' }),
    log(T0 + 3, { level: 'W', message: 'four' }),
    log(T0 + 4, { level: 'I', message: 'five' }),
  ];

  it('keeps chronological order and counts all matches', () => {
    const result = filterLogs(logs, { minLevel: 'D', query: '' }, 10);
    expect(result.rows.map((r) => r.message)).toEqual(['one', 'two', 'four', 'five']);
    expect(result.matched).toBe(4);
  });

  it('limits to the newest matches', () => {
    const result = filterLogs(logs, { minLevel: 'V', query: '' }, 2);
    expect(result.rows.map((r) => r.message)).toEqual(['four', 'five']);
    expect(result.matched).toBe(5);
  });

  it('combines level and query', () => {
    expect(filterLogs(logs, { minLevel: 'W', query: 'o' }, 10).rows.map((r) => r.message)).toEqual([
      'two',
      'four',
    ]);
  });

  it('handles an empty buffer', () => {
    expect(filterLogs([], { minLevel: 'V', query: 'x' }, 10)).toEqual({ rows: [], matched: 0 });
  });
});

describe('splitMatch', () => {
  it('splits around the first case-insensitive match', () => {
    expect(splitMatch('ActivityManager', 'manager')).toEqual(['Activity', 'Manager', '']);
    expect(splitMatch('abc', 'zz')).toBeNull();
    expect(splitMatch('abc', '   ')).toBeNull();
  });

  it('normalizes queries', () => {
    expect(normalizeQuery('  MiXeD ')).toBe('mixed');
  });
});
