/**
 * Latest-only frame decoding: at most one PNG decodes at a time and only the newest waiting frame is kept,
 * so a slow decode drops stale frames instead of building a backlog (and memory).
 */

/** The subset of `ImageBitmap` used here. */
export interface BitmapLike {
  readonly width: number;
  readonly height: number;
  close(): void;
}

export interface FrameDecoderOptions<B extends BitmapLike> {
  decode: (png: Blob) => Promise<B>;
  draw: (bitmap: B) => void;
}

export interface FrameDecoder {
  push(png: Blob): void;
  /** Frames replaced by a newer one before they were decoded. */
  readonly dropped: number;
  /** Stops decoding; a decode in flight is closed when it lands. */
  dispose(): void;
}

export function createFrameDecoder<B extends BitmapLike>(options: FrameDecoderOptions<B>): FrameDecoder {
  let pending: Blob | null = null;
  let isDecoding = false;
  let isDisposed = false;
  let dropped = 0;

  const run = (png: Blob) => {
    isDecoding = true;
    options.decode(png).then(
      (bitmap) => {
        try {
          if (!isDisposed) options.draw(bitmap);
        } catch (error) {
          console.error('Lionscope: could not draw a screen frame', error);
        } finally {
          bitmap.close();
        }
        next();
      },
      // A corrupt frame is skipped; the next one replaces it.
      () => next(),
    );
  };

  const next = () => {
    isDecoding = false;
    if (isDisposed || pending === null) return;
    const png = pending;
    pending = null;
    run(png);
  };

  return {
    push(png) {
      if (isDisposed) return;
      if (!isDecoding) {
        run(png);
        return;
      }
      if (pending !== null) dropped++;
      pending = png;
    },
    get dropped() {
      return dropped;
    },
    dispose() {
      isDisposed = true;
      pending = null;
    },
  };
}

/** Frames drawn over the last second. */
export function createFpsMeter(windowMs = 1000) {
  const stamps: number[] = [];
  const trim = (now: number) => {
    while (stamps.length > 0 && (stamps[0] ?? 0) <= now - windowMs) stamps.shift();
  };
  return {
    tick(now: number): void {
      stamps.push(now);
      trim(now);
    },
    fps(now: number): number {
      trim(now);
      return Math.round((stamps.length * 1000) / windowMs);
    },
  };
}
