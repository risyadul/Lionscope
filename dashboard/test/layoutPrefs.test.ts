import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  clampDrawerHeight,
  defaultDrawerHeight,
  drawerMaxHeight,
  LOGCAT_DEFAULT_HEIGHT,
  LOGCAT_MIN_HEIGHT,
  parseBoolean,
  parsePositiveInt,
  readStored,
  TIMELINE_MIN_HEIGHT,
  writeStored,
} from '../src/lib/layoutPrefs.ts';

afterEach(() => {
  vi.restoreAllMocks();
  window.localStorage.clear();
});

describe('layout preference storage', () => {
  it('reads back what it wrote', () => {
    writeStored('lionscope.test', 'true');
    expect(readStored('lionscope.test')).toBe('true');
    expect(readStored('lionscope.missing')).toBeNull();
  });

  it('survives storage that throws (private windows, blocked site data, full quota)', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('denied', 'SecurityError');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('full', 'QuotaExceededError');
    });
    expect(() => writeStored('lionscope.test', '1')).not.toThrow();
    expect(readStored('lionscope.test')).toBeNull();
  });

  it('parses only well-formed values', () => {
    expect(parseBoolean('true', false)).toBe(true);
    expect(parseBoolean('false', true)).toBe(false);
    expect(parseBoolean('yes', true)).toBe(true);
    expect(parseBoolean(null, false)).toBe(false);
    expect(parsePositiveInt('320', 260)).toBe(320);
    expect(parsePositiveInt('0', 260)).toBe(260);
    expect(parsePositiveInt('-5', 260)).toBe(260);
    expect(parsePositiveInt('1e9', 260)).toBe(260);
    expect(parsePositiveInt(null, 260)).toBe(260);
    expect(parsePositiveInt(null, null)).toBeNull();
  });
});

describe('defaultDrawerHeight', () => {
  it('takes a quarter of the column, between 160 and 240 px', () => {
    // 1440 × 900: the instrument column is about 840 px tall.
    expect(defaultDrawerHeight(840)).toBe(210);
    expect(defaultDrawerHeight(1400)).toBe(240);
    expect(defaultDrawerHeight(500)).toBe(160);
    expect(defaultDrawerHeight(0)).toBe(LOGCAT_DEFAULT_HEIGHT);
  });

  it('still leaves the timeline its minimum in a short column', () => {
    expect(defaultDrawerHeight(360)).toBe(360 - TIMELINE_MIN_HEIGHT);
    expect(defaultDrawerHeight(300)).toBe(LOGCAT_MIN_HEIGHT);
  });
});

describe('clampDrawerHeight', () => {
  it('keeps the drawer between its minimum and what leaves the timeline its minimum', () => {
    expect(clampDrawerHeight(40, 800)).toBe(LOGCAT_MIN_HEIGHT);
    expect(clampDrawerHeight(300, 800)).toBe(300);
    expect(clampDrawerHeight(900, 800)).toBe(800 - TIMELINE_MIN_HEIGHT);
    expect(drawerMaxHeight(800)).toBe(800 - TIMELINE_MIN_HEIGHT);
  });

  it('never goes under the minimum in a short column, and has a bound before measuring', () => {
    expect(clampDrawerHeight(300, 250)).toBe(LOGCAT_MIN_HEIGHT);
    expect(drawerMaxHeight(0)).toBe(640);
  });
});
