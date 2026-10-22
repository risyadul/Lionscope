import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { groupStrictMode, summarizeFrames } from '../src/insights/index.ts';
import type { FrameSample, StackFrame, StrictModeSample } from '../src/wire.ts';

const T0 = Date.UTC(2026, 9, 20, 12, 0, 0);

function frame(ts: number, overrides: Partial<FrameSample> = {}): FrameSample {
  return {
    ts,
    frameCount: 60,
    jankCount: 3,
    slowCount: 5,
    fps: 60,
    p50Ms: 8,
    p90Ms: 14,
    p99Ms: 22,
    maxMs: 40,
    frameIntervalMs: 16.67,
    frameIntervalSource: 'reported',
    durationsMs: [8, 9, 10, 14, 30],
    ...overrides,
  };
}

const appFrame = (method: string, line: number): StackFrame => ({
  className: 'com.example.shop.cart.CartRepository',
  method,
  file: 'CartRepository.kt',
  line,
  inApp: true,
});

function violation(ts: number, overrides: Partial<StrictModeSample> = {}): StrictModeSample {
  return {
    ts,
    policy: 'thread',
    violation: 'DiskReadViolation',
    message: null,
    frames: [appFrame('load', 40)],
    count: 1,
    screen: 'Cart',
    ...overrides,
  };
}

describe('summarizeFrames', () => {
  it('sums the samples in the window', () => {
    const summary = summarizeFrames(
      [
        frame(T0 - 1000, { jankCount: 60 }),
        frame(T0, { fps: 30, frameCount: 30, maxMs: 90 }),
        frame(T0 + 1000, { source: 'sdk', slowCount: 1, jankCount: 2 }),
      ],
      T0,
      T0 + 1000,
    );
    expect(summary).toEqual({
      samples: 2,
      renderedFrames: 90,
      jankFrames: 5,
      slowFrames: 7,
      jankPercent: (5 / 90) * 100,
      slowPercent: (7 / 90) * 100,
      meanFps: 45,
      p50Ms: 10,
      p90Ms: 30,
      maxMs: 90,
      frameIntervalMs: 16.67,
      source: 'sdk',
    });
  });

  it('has no rates without frames, and ignores idle samples for the slowest frame', () => {
    const summary = summarizeFrames(
      [frame(T0, { frameCount: 0, fps: 0, maxMs: 500, durationsMs: [] })],
      T0,
      T0,
    );
    expect(summary).toMatchObject({
      jankPercent: null,
      meanFps: 0,
      maxMs: null,
      p90Ms: null,
      source: 'gfxinfo',
    });
    expect(summarizeFrames([], T0, T0)).toMatchObject({ samples: 0, meanFps: null, source: null });
  });
});

describe('groupStrictMode', () => {
  it('groups by violation and culprit line, most occurrences first', () => {
    const groups = groupStrictMode(
      [
        violation(T0, { count: 3 }),
        violation(T0 + 1000, { message: 'newest', screen: 'Home' }),
        violation(T0 + 2000, { frames: [appFrame('save', 70)] }),
        violation(T0 + 3000, { violation: 'NetworkViolation' }),
        violation(T0 - 5000, { count: 50 }),
      ],
      T0,
      T0 + 3000,
    );
    expect(groups.map((group) => [group.violation, group.frame?.line, group.occurrences])).toEqual([
      ['DiskReadViolation', 40, 4],
      ['NetworkViolation', 40, 1],
      ['DiskReadViolation', 70, 1],
    ]);
    expect(groups[0]).toMatchObject({ samples: 2, screens: ['Cart', 'Home'], lastTs: T0 + 1000 });
    expect(groups[0]?.latest.message).toBe('newest');
  });
});

describe('dependencies', () => {
  it('imports nothing but the wire contract and itself (the dashboard bundles it under a strict CSP)', () => {
    const dir = new URL('../src/insights/', import.meta.url);
    for (const file of readdirSync(dir)) {
      const source = readFileSync(new URL(file, dir), 'utf8');
      for (const [, specifier] of source.matchAll(/from '([^']+)'/g)) {
        expect(specifier, `${file} imports ${specifier}`).toMatch(/^\.\.?\/(?:wire|[a-z]+)\.ts$/);
      }
    }
  });
});
