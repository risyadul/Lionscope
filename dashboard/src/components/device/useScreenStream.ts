import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import type { ScreenClientMessage, ScreenSize } from '@lionscope/protocol/wire';
import { downloadBlob, screenshotFileName } from '../../lib/download.ts';
import { createFpsMeter, createFrameDecoder } from '../../lib/frameQueue.ts';
import {
  createScreenConnection,
  screenUrl,
  type ScreenConnection,
  type ScreenConnectionState,
  type ScreenInfo,
} from '../../lib/screenSocket.ts';

/** The fps readout refreshes this often (re-rendering per frame would cost more than the readout is worth). */
const FPS_REFRESH_MS = 500;

const CONNECTING: ScreenConnectionState = { status: 'connecting', attempt: 0, error: null };

interface Input {
  serial: string;
  avdName: string;
  size: ScreenSize;
  /** False while the panel is collapsed or the tab is hidden: no socket, no decoding. */
  isEnabled: boolean;
}

export interface ScreenStream {
  state: ScreenConnectionState;
  /** Latest `screenInfo` for this serial; null before the first one. */
  info: ScreenInfo | null;
  fps: number;
  canvasRef: RefObject<HTMLCanvasElement | null>;
  send: (msg: ScreenClientMessage) => boolean;
  /** Opens a fresh socket, e.g. after an error a retry couldn't fix. */
  retry: () => void;
}

function drawFrame(canvas: HTMLCanvasElement | null, bitmap: ImageBitmap): void {
  if (!canvas) return;
  // The canvas keeps the frame's pixel size; CSS scales it into the device frame.
  if (canvas.width !== bitmap.width) canvas.width = bitmap.width;
  if (canvas.height !== bitmap.height) canvas.height = bitmap.height;
  canvas.getContext('2d')?.drawImage(bitmap, 0, 0);
}

/** One screen socket per visible panel: frames go straight to the canvas, screenshots to a download. */
export function useScreenStream({ serial, avdName, size, isEnabled }: Input): ScreenStream {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const connectionRef = useRef<ScreenConnection | null>(null);
  const sizeRef = useRef(size);
  const avdRef = useRef(avdName);
  const [state, setState] = useState<ScreenConnectionState>(CONNECTING);
  const [info, setInfo] = useState<ScreenInfo | null>(null);
  const [fps, setFps] = useState(0);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    avdRef.current = avdName;
  }, [avdName]);

  // A new size goes over the open socket; a reconnect picks it up from the URL.
  useEffect(() => {
    if (sizeRef.current === size) return;
    sizeRef.current = size;
    connectionRef.current?.send({ type: 'setSize', size });
  }, [size]);

  useEffect(() => {
    if (!isEnabled) return;
    const meter = createFpsMeter();
    const decoder = createFrameDecoder<ImageBitmap>({
      decode: (png) => createImageBitmap(png),
      draw: (bitmap) => {
        drawFrame(canvasRef.current, bitmap);
        meter.tick(performance.now());
      },
    });
    const connection = createScreenConnection({
      url: () => screenUrl(window.location, serial, sizeRef.current),
      onBinary: (msg) => {
        if (msg.kind === 'frame') decoder.push(msg.png);
        else downloadBlob(msg.png, screenshotFileName(avdRef.current, new Date()));
      },
      onInfo: setInfo,
      onState: setState,
    });
    connectionRef.current = connection;
    const timer = setInterval(() => setFps(meter.fps(performance.now())), FPS_REFRESH_MS);
    return () => {
      clearInterval(timer);
      connection.close();
      decoder.dispose();
      connectionRef.current = null;
      // A re-enabled panel must not show the old stream as live before the new socket reports.
      setState(CONNECTING);
      setFps(0);
    };
  }, [isEnabled, serial, attempt]);

  const send = useCallback((msg: ScreenClientMessage) => connectionRef.current?.send(msg) ?? false, []);
  const retry = useCallback(() => setAttempt((n) => n + 1), []);

  return {
    state: isEnabled ? state : CONNECTING,
    info: info !== null && info.serial === serial ? info : null,
    fps: isEnabled && state.status === 'live' ? fps : 0,
    canvasRef,
    send,
    retry,
  };
}
