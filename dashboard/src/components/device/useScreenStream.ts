import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import type { ScreenClientMessage, ScreenFpsCap, ScreenSize } from '@lionscope/protocol/wire';
import { downloadBlob, screenshotFileName } from '../../lib/download.ts';
import { createFpsMeter, createFrameDecoder } from '../../lib/frameQueue.ts';
import {
  createVideoPipeline,
  videoUnavailableMessage,
  type VideoError,
  webCodecsApi,
  type VideoPipeline,
} from '../../lib/videoDecoder.ts';
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

/** Socket events the panel handles itself (read on each event, so they may change between renders). */
export interface ScreenStreamEvents {
  onOpen?: () => void;
  onClipboard?: (text: string) => void;
}

interface Input {
  serial: string;
  /** Screenshot file name prefix. */
  name: string;
  size: ScreenSize;
  /** Emulators: the most frames per second the server streams; undefined for physical devices (scrcpy paces). */
  fpsCap?: ScreenFpsCap;
  /** False while the panel is collapsed or the tab is hidden: no socket, no decoding. */
  isEnabled: boolean;
  events?: RefObject<ScreenStreamEvents>;
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
  /** The device's H.264 stream can't be decoded here; the socket is closed. */
  videoError: VideoError | null;
  /** The device refuses input (`input_denied`), with the server's message; the video keeps playing. */
  inputDenied: string | null;
  dismissInputDenied: () => void;
}

function drawFrame(
  canvas: HTMLCanvasElement | null,
  image: CanvasImageSource,
  width: number,
  height: number,
): void {
  if (!canvas) return;
  // The canvas keeps the frame's pixel size; CSS scales it into the device frame.
  if (canvas.width !== width) canvas.width = width;
  if (canvas.height !== height) canvas.height = height;
  canvas.getContext('2d')?.drawImage(image, 0, 0);
}

/**
 * One screen socket per visible panel: PNG frames (emulators) and H.264 video (physical devices) go straight
 * to the canvas, screenshots to a download.
 */
export function useScreenStream({ serial, name, size, fpsCap, isEnabled, events }: Input): ScreenStream {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const connectionRef = useRef<ScreenConnection | null>(null);
  const sizeRef = useRef(size);
  const fpsCapRef = useRef(fpsCap);
  const nameRef = useRef(name);
  const [state, setState] = useState<ScreenConnectionState>(CONNECTING);
  const [info, setInfo] = useState<ScreenInfo | null>(null);
  const [fps, setFps] = useState(0);
  const [attempt, setAttempt] = useState(0);
  const [videoError, setVideoError] = useState<VideoError | null>(null);
  const [inputDenied, setInputDenied] = useState<string | null>(null);

  useEffect(() => {
    nameRef.current = name;
  }, [name]);

  // A new size goes over the open socket; a reconnect picks it up from the URL.
  useEffect(() => {
    if (sizeRef.current === size) return;
    sizeRef.current = size;
    connectionRef.current?.send({ type: 'setSize', size });
  }, [size]);

  // Likewise the fps cap; the server applies it to the running stream.
  useEffect(() => {
    if (fpsCapRef.current === fpsCap) return;
    fpsCapRef.current = fpsCap;
    if (fpsCap !== undefined) connectionRef.current?.send({ type: 'setFpsCap', fps: fpsCap });
  }, [fpsCap]);

  useEffect(() => {
    if (!isEnabled) return;
    const meter = createFpsMeter();
    const decoder = createFrameDecoder<ImageBitmap>({
      decode: (png) => createImageBitmap(png),
      draw: (bitmap) => {
        drawFrame(canvasRef.current, bitmap, bitmap.width, bitmap.height);
        meter.tick(performance.now());
      },
    });
    let video: VideoPipeline | null = null;
    const failVideo = (error: VideoError) => {
      connection.close();
      setVideoError(error);
    };
    // Created on the first video packet: emulators stream PNG and never touch WebCodecs.
    const videoPipeline = (): VideoPipeline | null => {
      if (video !== null) return video;
      const api = webCodecsApi();
      if (api === null) {
        failVideo({ message: videoUnavailableMessage(), canRetry: false });
        return null;
      }
      video = createVideoPipeline({
        api,
        draw: (frame) => {
          drawFrame(canvasRef.current, frame, frame.displayWidth, frame.displayHeight);
          meter.tick(performance.now());
          connection.markLive();
        },
        onUnsupported: (message) => failVideo({ message, canRetry: false }),
        onFailed: (message) => failVideo({ message, canRetry: true }),
        // RESET_VIDEO on the device: a fresh IDR instead of waiting for the encoder's next one (~10 s).
        onKeyFrameNeeded: () => connection.send({ type: 'keyFrame' }),
      });
      return video;
    };
    const connection = createScreenConnection({
      url: () => screenUrl(window.location, serial, sizeRef.current, fpsCapRef.current),
      onBinary: (msg) => {
        if (msg.kind === 'frame') decoder.push(msg.png);
        else if (msg.kind === 'video') videoPipeline()?.push(msg.packet);
        else downloadBlob(msg.png, screenshotFileName(nameRef.current, new Date()));
      },
      onInfo: (next) => {
        // A new capture session (rotation, size): its own SPS / PPS and key frame follow.
        if (next.codec === 'h264') video?.reset();
        setInfo(next);
      },
      onState: setState,
      onOpen: () => events?.current.onOpen?.(),
      onClipboard: (text) => events?.current.onClipboard?.(text),
      onInputDenied: setInputDenied,
    });
    connectionRef.current = connection;
    const timer = setInterval(() => setFps(meter.fps(performance.now())), FPS_REFRESH_MS);
    return () => {
      clearInterval(timer);
      connection.close();
      decoder.dispose();
      video?.dispose();
      connectionRef.current = null;
      // A re-enabled panel must not show the old stream as live before the new socket reports.
      setState(CONNECTING);
      setFps(0);
      setVideoError(null);
      setInputDenied(null);
    };
  }, [isEnabled, serial, attempt, events]);

  const send = useCallback((msg: ScreenClientMessage) => connectionRef.current?.send(msg) ?? false, []);
  const retry = useCallback(() => setAttempt((n) => n + 1), []);
  const dismissInputDenied = useCallback(() => setInputDenied(null), []);
  const isVideoFailed = isEnabled && videoError !== null;

  return {
    state: !isEnabled ? CONNECTING : isVideoFailed ? { ...state, status: 'failed' } : state,
    info: info !== null && info.serial === serial ? info : null,
    fps: isEnabled && state.status === 'live' && !isVideoFailed ? fps : 0,
    canvasRef,
    send,
    retry,
    videoError: isVideoFailed ? videoError : null,
    inputDenied: isEnabled ? inputDenied : null,
    dismissInputDenied,
  };
}
