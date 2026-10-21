import { describe, expect, it } from 'vitest';
import { ErrorThrottle, PublicError } from '../src/errors.ts';

describe('ErrorThrottle', () => {
  it('reports a key once per ttl', () => {
    let now = 0;
    const throttle = new ErrorThrottle(() => now, 1000, 10);
    expect(throttle.shouldReport('a')).toBe(true);
    expect(throttle.shouldReport('a')).toBe(false);
    expect(throttle.shouldReport('b')).toBe(true);
    now = 999;
    expect(throttle.shouldReport('a')).toBe(false);
    now = 1000;
    expect(throttle.shouldReport('a')).toBe(true);
  });

  it('drops new keys silently when full, and evicts expired ones', () => {
    let now = 0;
    const throttle = new ErrorThrottle(() => now, 1000, 2);
    expect(throttle.shouldReport('a')).toBe(true);
    now = 500;
    expect(throttle.shouldReport('b')).toBe(true);
    expect(throttle.shouldReport('c')).toBe(false);
    now = 1200; // 'a' expired, 'b' not
    expect(throttle.shouldReport('c')).toBe(true);
    expect(throttle.shouldReport('d')).toBe(false);
    expect(throttle.shouldReport('b')).toBe(false);
  });
});

describe('PublicError', () => {
  it('is an Error with its own name', () => {
    const error = new PublicError('Device x is not connected');
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('PublicError');
  });
});
