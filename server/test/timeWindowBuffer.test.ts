import { describe, expect, it } from 'vitest';
import { TimeWindowBuffer } from '../src/store/timeWindowBuffer.ts';

describe('TimeWindowBuffer', () => {
  it('keeps items within the window of the newest timestamp', () => {
    const buffer = new TimeWindowBuffer<{ ts: number }>(1000, 100);
    buffer.push({ ts: 0 }, { ts: 500 }, { ts: 1000 });
    expect(buffer.size).toBe(3);
    buffer.push({ ts: 1600 });
    expect(buffer.toArray().map((item) => item.ts)).toEqual([1000, 1600]);
  });

  it('prunes against a supplied clock when reading', () => {
    const buffer = new TimeWindowBuffer<{ ts: number }>(1000, 100);
    buffer.push({ ts: 0 }, { ts: 900 });
    expect(buffer.toArray(1500).map((item) => item.ts)).toEqual([900]);
    expect(buffer.toArray(5000)).toEqual([]);
  });

  it('caps the number of items', () => {
    const buffer = new TimeWindowBuffer<{ ts: number }>(1_000_000, 3);
    buffer.push({ ts: 1 }, { ts: 2 }, { ts: 3 }, { ts: 4 }, { ts: 5 });
    expect(buffer.toArray().map((item) => item.ts)).toEqual([3, 4, 5]);
  });

  it('caps the total byte size when a byte limit is given', () => {
    const buffer = new TimeWindowBuffer<{ ts: number; text: string }>(1_000_000, 100, {
      maxBytes: 10,
      sizeOf: (item) => item.text.length,
    });
    buffer.push({ ts: 1, text: 'aaaa' }, { ts: 2, text: 'bbbb' });
    expect(buffer.totalBytes).toBe(8);
    buffer.push({ ts: 3, text: 'cccccc' });
    expect(buffer.toArray().map((item) => item.text)).toEqual(['bbbb', 'cccccc']);
    expect(buffer.totalBytes).toBe(10);
    buffer.toArray(2_000_000);
    expect(buffer.totalBytes).toBe(0);
  });

  it('returns copies that are not affected by later writes', () => {
    const buffer = new TimeWindowBuffer<{ ts: number }>(1000, 10);
    buffer.push({ ts: 1 });
    const snapshot = buffer.toArray();
    buffer.push({ ts: 2 });
    expect(snapshot).toHaveLength(1);
  });

  it('compacts its backing storage, keeping byte accounting intact', () => {
    const buffer = new TimeWindowBuffer<{ ts: number }>(10, 5000, { maxBytes: 1_000_000, sizeOf: () => 2 });
    for (let ts = 0; ts < 5000; ts += 1) buffer.push({ ts });
    expect(buffer.size).toBe(11);
    expect(buffer.totalBytes).toBe(22);
    expect(buffer.toArray()[0]?.ts).toBe(4989);
    buffer.push();
    expect(buffer.size).toBe(11);
  });

  it('finds the newest item, or the newest matching one, without copying', () => {
    const buffer = new TimeWindowBuffer<{ ts: number; tag: string }>(1000, 3);
    expect(buffer.last()).toBeUndefined();
    expect(buffer.findLast(() => true)).toBeUndefined();
    buffer.push({ ts: 1, tag: 'a' }, { ts: 2, tag: 'b' }, { ts: 3, tag: 'a' }, { ts: 4, tag: 'c' });
    expect(buffer.last()).toEqual({ ts: 4, tag: 'c' });
    expect(buffer.findLast((item) => item.tag === 'a')).toEqual({ ts: 3, tag: 'a' });
    // { ts: 1 } was evicted by the item cap and is never found.
    expect(buffer.findLast((item) => item.ts === 1)).toBeUndefined();
    buffer.prune(10_000);
    expect(buffer.last()).toBeUndefined();
  });
});
