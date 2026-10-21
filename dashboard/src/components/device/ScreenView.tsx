import { useEffect, useId, useRef, type ReactNode } from 'react';
import type { ScreenErrorCode, ScreenNavButton, ScreenSize } from '@lionscope/protocol/wire';
import { DEFAULT_SCREEN_SIZE, SCREEN_SIZES } from '@lionscope/protocol/wire';
import { useElementSize } from '../../hooks/useElementSize.ts';
import { useStoredState } from '../../hooks/useStoredState.ts';
import { LAYOUT_KEYS } from '../../lib/layoutPrefs.ts';
import { fitDeviceGlass, mirrorPoint, type FramePoint } from '../../lib/screenInput.ts';
import type { ScreenConnectionState } from '../../lib/screenSocket.ts';
import { Segmented } from '../ui/Segmented.tsx';
import {
  BackIcon,
  CameraIcon,
  ClipboardIcon,
  HomeIcon,
  PowerIcon,
  RecentsIcon,
  RotateLeftIcon,
  RotateRightIcon,
} from './icons.tsx';
import { ClipboardToast } from './ClipboardToast.tsx';
import { useClipboardShare } from './useClipboardShare.ts';
import { useScreenInput } from './useScreenInput.ts';
import { useScreenStream, type ScreenStreamEvents } from './useScreenStream.ts';

/** Portrait phone until the first `screenInfo` says otherwise. */
const DEFAULT_ASPECT = 9 / 20;

function parseScreenSize(raw: string | null): ScreenSize {
  return SCREEN_SIZES.find((size) => String(size) === raw) ?? DEFAULT_SCREEN_SIZE;
}

const SIZE_OPTIONS = SCREEN_SIZES.map((size) => ({ value: size, label: String(size), title: `${size} px` }));

const NAV_BUTTONS: readonly { button: ScreenNavButton; label: string; icon: ReactNode }[] = [
  { button: 'back', label: 'Back', icon: <BackIcon /> },
  { button: 'home', label: 'Home', icon: <HomeIcon /> },
  { button: 'recents', label: 'Recents', icon: <RecentsIcon /> },
];

type ToolButtonProps = {
  label: string;
  icon: ReactNode;
  disabled: boolean;
  onClick: () => void;
  /** A toggle: rendered with `aria-pressed`. */
  isPressed?: boolean;
  /** Tooltip, when it should say more than the label. */
  title?: string;
};

function ToolButton({ label, icon, disabled, onClick, isPressed, title }: ToolButtonProps) {
  return (
    <button
      type="button"
      className="btn btn--icon device-tool"
      aria-label={label}
      aria-pressed={isPressed}
      title={title ?? label}
      disabled={disabled}
      onClick={onClick}
    >
      {icon}
    </button>
  );
}

const ERROR_TEXT: Record<ScreenErrorCode, string> = {
  not_emulator: 'Mirroring physical devices arrives in 0.3.1.',
  unavailable:
    'This emulator has no usable gRPC endpoint. Update the Android Emulator, or boot the AVD from Lionscope.',
  auth: 'The emulator rejected Lionscope’s gRPC token. Restart the emulator and try again.',
  ended: 'The screen stream ended',
  busy: 'Too many screens are streaming',
};

function statusText(state: ScreenConnectionState): string | null {
  if (state.status === 'live') return null;
  if (state.status === 'failed')
    return state.error ? ERROR_TEXT[state.error.code] : 'The screen stream failed.';
  if (state.status === 'reconnecting') {
    return `${state.error ? ERROR_TEXT[state.error.code] : 'The stream dropped'} — reconnecting…`;
  }
  return 'Connecting to the screen…';
}

function percent(value: number): string {
  return `${(value * 100).toFixed(2)}%`;
}

function PinchHint({ point }: { point: FramePoint }) {
  const mirror = mirrorPoint(point);
  return (
    <div className="pinch-hint" aria-hidden="true">
      <span className="pinch-centre" />
      <span className="pinch-dot" style={{ left: percent(point.x), top: percent(point.y) }} />
      <span
        className="pinch-dot pinch-dot--mirror"
        style={{ left: percent(mirror.x), top: percent(mirror.y) }}
      />
    </div>
  );
}

type Props = {
  serial: string;
  avdName: string;
  label: string;
  /** Stream only while the panel is on screen and the tab is visible. */
  isVisible: boolean;
};

/** The live emulator screen in a device frame, with its controls. */
export function ScreenView({ serial, avdName, label, isVisible }: Props) {
  const [size, setSize] = useStoredState<ScreenSize>(LAYOUT_KEYS.screenSize, parseScreenSize);
  // Destructured: the stream object carries the canvas ref, which render must not read through.
  const streamEvents = useRef<ScreenStreamEvents>({});
  const { state, info, fps, canvasRef, send, retry } = useScreenStream({
    serial,
    avdName,
    size,
    isEnabled: isVisible,
    events: streamEvents,
  });
  const isLive = state.status === 'live';
  const { handlers, pinchHint, pasteNote } = useScreenInput(canvasRef, send, isLive);
  const clipboard = useClipboardShare(send, isLive);
  const { pushFromDesktop, onSocketOpen, onRemoteClipboard } = clipboard;

  useEffect(() => {
    streamEvents.current = { onOpen: onSocketOpen, onClipboard: onRemoteClipboard };
  }, [onSocketOpen, onRemoteClipboard]);

  // Back from another app with the screen still focused: the desktop clipboard may have changed.
  useEffect(() => {
    const onWindowFocus = () => {
      if (document.activeElement === canvasRef.current) pushFromDesktop();
    };
    window.addEventListener('focus', onWindowFocus);
    return () => window.removeEventListener('focus', onWindowFocus);
  }, [canvasRef, pushFromDesktop]);
  const stageRef = useRef<HTMLDivElement>(null);
  const stage = useElementSize(stageRef);
  const hintId = useId();

  const aspect = info && info.frameHeight > 0 ? info.frameWidth / info.frameHeight : DEFAULT_ASPECT;
  const glass = fitDeviceGlass(stage.width, stage.height, aspect);
  const orientation = aspect > 1 ? 'landscape' : 'portrait';
  const status = statusText(state);

  return (
    <div className="screen-view">
      <div className="device-toolbar" role="group" aria-label={`${label} controls`}>
        <ToolButton
          label="Power"
          icon={<PowerIcon />}
          disabled={!isLive}
          onClick={() => send({ type: 'nav', button: 'power' })}
        />
        <ToolButton
          label="Rotate left"
          icon={<RotateLeftIcon />}
          disabled={!isLive}
          onClick={() => send({ type: 'rotate', direction: 'left' })}
        />
        <ToolButton
          label="Rotate right"
          icon={<RotateRightIcon />}
          disabled={!isLive}
          onClick={() => send({ type: 'rotate', direction: 'right' })}
        />
        <ToolButton
          label="Share clipboard"
          title="Share clipboard with the emulator"
          icon={<ClipboardIcon />}
          disabled={false}
          isPressed={clipboard.isEnabled}
          onClick={() => clipboard.setEnabled(!clipboard.isEnabled)}
        />
        <ToolButton
          label="Screenshot"
          icon={<CameraIcon />}
          disabled={!isLive}
          onClick={() => send({ type: 'screenshot' })}
        />
        <Segmented
          className="device-size"
          label="Frame size (short edge, px)"
          options={SIZE_OPTIONS}
          value={size}
          onChange={setSize}
          ignoreRepeat
        />
        <span className="device-fps mono" title="Frames per second" data-live={isLive || undefined}>
          {isLive ? fps : '–'}
          <span className="device-fps-unit"> fps</span>
        </span>
      </div>

      <div ref={stageRef} className="device-stage">
        <div className="device-bezel" data-orientation={orientation} data-status={state.status}>
          <div
            className="device-glass"
            style={glass.width > 0 ? { width: `${glass.width}px`, height: `${glass.height}px` } : undefined}
          >
            <canvas
              ref={canvasRef}
              className="device-canvas"
              tabIndex={0}
              role="application"
              aria-roledescription="device screen"
              aria-label={`${label} screen`}
              aria-describedby={hintId}
              {...handlers}
              onPointerDown={(event) => {
                handlers.onPointerDown(event);
                pushFromDesktop();
              }}
              onFocus={pushFromDesktop}
            />
            {status !== null && (
              <div className="device-glass-status" data-tone={state.status} role="status">
                {state.status !== 'failed' && <span className="banner-spinner" aria-hidden="true" />}
                <span>{status}</span>
                {state.status === 'failed' && (
                  <button type="button" className="btn device-retry" onClick={retry}>
                    Try again
                  </button>
                )}
              </div>
            )}
            {pinchHint && <PinchHint point={pinchHint} />}
          </div>
        </div>
      </div>

      <div className="device-nav" role="group" aria-label="Navigation buttons">
        {NAV_BUTTONS.map(({ button, label: name, icon }) => (
          <ToolButton
            key={button}
            label={name}
            icon={icon}
            disabled={!isLive}
            onClick={() => send({ type: 'nav', button })}
          />
        ))}
      </div>
      <p id={hintId} className="device-hint">
        Click to interact · <kbd>Esc</kbd> = Back · <kbd>Alt</kbd>+drag = pinch
      </p>
      <p className="device-paste-note" role="status">
        {pasteNote}
      </p>
      <ClipboardToast toast={clipboard.toast} onCopy={clipboard.copyManually} />
    </div>
  );
}
