import { describe, expect, it } from 'vitest';
import {
  EMPTY,
  formatClock,
  formatClockShort,
  formatDuration,
  formatElapsed,
  formatFixed,
  formatInteger,
  formatMb,
  formatTick,
  kbToMb,
} from '../src/lib/format.ts';

describe('clock formatting', () => {
  const ts = new Date(2026, 9, 20, 9, 5, 7, 42).getTime();

  it('formats HH:MM:SS.mmm in local time', () => {
    expect(formatClock(ts)).toBe('09:05:07.042');
  });

  it('formats HH:MM:SS', () => {
    expect(formatClockShort(ts)).toBe('09:05:07');
  });
});

describe('numbers', () => {
  it('formatFixed renders missing values as an em dash', () => {
    expect(formatFixed(12.345, 1)).toBe('12.3');
    expect(formatFixed(null)).toBe(EMPTY);
    expect(formatFixed(undefined)).toBe(EMPTY);
    expect(formatFixed(Number.NaN)).toBe(EMPTY);
    expect(formatFixed(Number.POSITIVE_INFINITY)).toBe(EMPTY);
  });

  it('formatInteger adds separators', () => {
    expect(formatInteger(1284.4)).toBe('1,284');
    expect(formatInteger(null)).toBe(EMPTY);
  });

  it('formatMb shrinks precision as values grow', () => {
    expect(formatMb(9.844)).toBe('9.84');
    expect(formatMb(98.44)).toBe('98.4');
    expect(formatMb(984.4)).toBe('984');
    expect(formatMb(1536.2)).toBe('1,536');
    expect(formatMb(null)).toBe(EMPTY);
    expect(kbToMb(2048)).toBe(2);
  });

  it('formatTick compacts thousands', () => {
    expect(formatTick(0)).toBe('0');
    expect(formatTick(250)).toBe('250');
    expect(formatTick(2.5)).toBe('2.5');
    expect(formatTick(12.5)).toBe('13');
    expect(formatTick(1000)).toBe('1K');
    expect(formatTick(1500)).toBe('1.5K');
  });
});

describe('durations', () => {
  it('formatElapsed picks the two largest units', () => {
    expect(formatElapsed(42_400)).toBe('42 s');
    expect(formatElapsed(187_000)).toBe('3 m 07 s');
    expect(formatElapsed(3_720_000)).toBe('1 h 02 m');
    expect(formatElapsed(-5)).toBe('0 s');
  });
});

describe('formatDuration', () => {
  it('shows tenths under 10 s, whole seconds under a minute, then elapsed form', () => {
    expect(formatDuration(840)).toBe('0.8 s');
    expect(formatDuration(12_400)).toBe('12 s');
    expect(formatDuration(187_000)).toBe('3 m 07 s');
    expect(formatDuration(-1)).toBe(EMPTY);
    expect(formatDuration(Number.NaN)).toBe(EMPTY);
  });
});
