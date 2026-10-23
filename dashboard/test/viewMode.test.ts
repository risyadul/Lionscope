import { describe, expect, it } from 'vitest';
import { initialViewMode, parseViewMode, searchWithViewMode } from '../src/lib/viewMode.ts';

describe('parseViewMode', () => {
  it('accepts the three modes and nothing else', () => {
    expect(parseViewMode('profile')).toBe('profile');
    expect(parseViewMode('inspect')).toBe('inspect');
    expect(parseViewMode('device')).toBe('device');
    expect(parseViewMode('Inspect')).toBeNull();
    expect(parseViewMode('')).toBeNull();
    expect(parseViewMode(null)).toBeNull();
    expect(parseViewMode('constructor')).toBeNull();
  });
});

describe('initialViewMode', () => {
  it('prefers the URL, then the remembered mode, then the profiler', () => {
    expect(initialViewMode('?view=device', 'inspect')).toBe('device');
    expect(initialViewMode('', 'inspect')).toBe('inspect');
    expect(initialViewMode('', null)).toBe('profile');
  });

  it('ignores an unknown URL value and falls back to the remembered one', () => {
    expect(initialViewMode('?view=charts', 'device')).toBe('device');
    expect(initialViewMode('?view=charts', 'bogus')).toBe('profile');
  });
});

describe('searchWithViewMode', () => {
  it('sets the parameter and keeps the others', () => {
    expect(searchWithViewMode('', 'inspect')).toBe('?view=inspect');
    expect(searchWithViewMode('?a=1', 'device')).toBe('?a=1&view=device');
    expect(searchWithViewMode('?view=device&a=1', 'inspect')).toBe('?view=inspect&a=1');
  });

  it('leaves the parameter out for the profiler', () => {
    expect(searchWithViewMode('?view=inspect', 'profile')).toBe('');
    expect(searchWithViewMode('?a=1&view=device', 'profile')).toBe('?a=1');
  });
});
