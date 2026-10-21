import { describe, expect, it, vi, type Mock } from 'vitest';
import { createFpsMeter, createFrameDecoder, type BitmapLike } from '../src/lib/frameQueue.ts';

interface FakeBitmap extends BitmapLike {
  name: string;
  close: Mock<() => void>;
}

/** A decoder whose decodes finish only when the test resolves them, in order. */
function controlledDecode() {
  const calls: { png: Blob; resolve: (b: FakeBitmap) => void; reject: (e: Error) => void }[] = [];
  const decode = (png: Blob) =>
    new Promise<FakeBitmap>((resolve, reject) => {
      calls.push({ png, resolve, reject });
    });
  const finish = async (index: number) => {
    const call = calls[index];
    if (!call) throw new Error(`no decode #${index}`);
    const bitmap: FakeBitmap = { name: blobName(call.png), width: 1, height: 1, close: vi.fn<() => void>() };
    call.resolve(bitmap);
    await Promise.resolve();
    await Promise.resolve();
    return bitmap;
  };
  return { calls, decode, finish };
}

const names = new WeakMap<Blob, string>();
function png(name: string): Blob {
  const blob = new Blob([name], { type: 'image/png' });
  names.set(blob, name);
  return blob;
}
function blobName(blob: Blob): string {
  return names.get(blob) ?? '?';
}

describe('createFrameDecoder', () => {
  it('decodes one frame at a time and keeps only the newest waiting frame', async () => {
    const { calls, decode, finish } = controlledDecode();
    const drawn: string[] = [];
    const decoder = createFrameDecoder<FakeBitmap>({ decode, draw: (b) => drawn.push(b.name) });

    decoder.push(png('a'));
    decoder.push(png('b'));
    decoder.push(png('c'));
    decoder.push(png('d'));
    expect(calls).toHaveLength(1);
    expect(decoder.dropped).toBe(2);

    const a = await finish(0);
    expect(drawn).toEqual(['a']);
    expect(a.close).toHaveBeenCalledOnce();
    expect(calls.map((c) => blobName(c.png))).toEqual(['a', 'd']);

    await finish(1);
    expect(drawn).toEqual(['a', 'd']);
    expect(calls).toHaveLength(2);
  });

  it('skips a frame that fails to decode and carries on with the next', async () => {
    const { calls, decode, finish } = controlledDecode();
    const drawn: string[] = [];
    const decoder = createFrameDecoder<FakeBitmap>({ decode, draw: (b) => drawn.push(b.name) });
    decoder.push(png('bad'));
    decoder.push(png('good'));
    calls[0]!.reject(new Error('corrupt'));
    await Promise.resolve();
    await Promise.resolve();
    await finish(1);
    expect(drawn).toEqual(['good']);
  });

  it('closes a bitmap that lands after dispose without drawing it, and decodes nothing more', async () => {
    const { calls, decode, finish } = controlledDecode();
    const draw = vi.fn();
    const decoder = createFrameDecoder<FakeBitmap>({ decode, draw });
    decoder.push(png('a'));
    decoder.push(png('b'));
    decoder.dispose();
    const a = await finish(0);
    expect(draw).not.toHaveBeenCalled();
    expect(a.close).toHaveBeenCalledOnce();
    decoder.push(png('c'));
    expect(calls).toHaveLength(1);
  });

  it('closes the bitmap and carries on when drawing throws', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { calls, decode, finish } = controlledDecode();
    const decoder = createFrameDecoder<FakeBitmap>({
      decode,
      draw: () => {
        throw new Error('canvas gone');
      },
    });
    decoder.push(png('a'));
    decoder.push(png('b'));
    const a = await finish(0);
    expect(a.close).toHaveBeenCalledOnce();
    expect(calls).toHaveLength(2);
    expect(error).toHaveBeenCalledOnce();
    error.mockRestore();
  });
});

describe('createFpsMeter', () => {
  it('counts frames drawn over the last second', () => {
    const meter = createFpsMeter();
    for (let t = 0; t < 1000; t += 20) meter.tick(t);
    expect(meter.fps(999)).toBe(50);
    // (500, 1500]: ticks 520 … 980.
    expect(meter.fps(1500)).toBe(24);
    expect(meter.fps(3000)).toBe(0);
  });
});
