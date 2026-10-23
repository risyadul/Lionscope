import { useEffect, useId, useRef, type ReactNode } from 'react';
import type { ScreenErrorCode, ScreenNavButton, ScreenSize } from '@lionscope/protocol/wire';
import { DEFAULT_SCREEN_SIZE, SCREEN_SIZES } from '@lionscope/protocol/wire';
import { useElementSize } from '../../hooks/useElementSize.ts';
import { useStoredState } from '../../hooks/useStoredState.ts';
import { pasteShortcut } from '../../lib/clipboard.ts';
import { LAYOUT_KEYS } from '../../lib/layoutPrefs.ts';
import { fitDeviceGlass, mirrorPoint, type FramePoint } from '../../lib/screenInput.ts';
import type { ScreenConnectionState, ScreenError } from '../../lib/screenSocket.ts';
import type { VideoError } from '../../lib/videoDecoder.ts';
import { Segmented } from '../ui/Segmented.tsx';
import {
  BackIcon,
  CameraIcon,
  ClipboardIcon,
  HomeIcon,
  InspectIcon,
  PowerIcon,
  RecentsIcon,
  RotateLeftIcon,
  RotateRightIcon,
} from './icons.tsx';
import { InspectorOverlay } from '../inspector/InspectorOverlay.tsx';
import { useInspectorContext } from '../inspector/InspectorContext.tsx';
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
  className?: string;
};

export function ToolButton({ label, icon, disabled, onClick, isPressed, title, className }: ToolButtonProps) {
  return (
    <button
      type="button"
      className={`btn btn--icon device-tool${className ? ` ${className}` : ''}`}
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
  not_emulator:
    'This device can’t be mirrored: adb doesn’t list it as ready (offline, unauthorized or gone).',
  mirror_failed: 'Couldn’t start mirroring on the device.',
  input_denied: 'The device refuses input.',
  unavailable:
    'This emulator has no usable gRPC endpoint. Update the Android Emulator, or boot the AVD from Lionscope.',
  auth: 'The emulator rejected Lionscope’s gRPC token. Restart the emulator and try again.',
  ended: 'The screen stream ended',
  busy: 'Too many screens are streaming',
};

function errorText(error: ScreenError): string {
  // The server's own reason (scrcpy's, sanitised) says more than a generic line.
  if (error.code === 'mirror_failed' && error.message !== '') {
    return `Couldn’t start mirroring: ${error.message}`;
  }
  return ERROR_TEXT[error.code];
}

function statusText(state: ScreenConnectionState, videoError: VideoError | null): string | null {
  if (videoError !== null) return videoError.message;
  if (state.status === 'live') return null;
  if (state.status === 'failed') return state.error ? errorText(state.error) : 'The screen stream failed.';
  if (state.status === 'reconnecting') {
    return `${state.error ? errorText(state.error) : 'The stream dropped'} — reconnecting…`;
  }
  return 'Connecting to the screen…';
}

/** Mirroring works but injection is refused (Xiaomi / HyperOS needs an extra developer option). */
function InputDeniedBanner({
  label,
  message,
  onDismiss,
}: {
  label: string;
  /** The server's reason; null while input works. */
  message: string | null;
  onDismiss: () => void;
}) {
  // The alert region stays mounted so screen readers announce it the moment it fills.
  return (
    <div className="device-alert-region" role="alert">
      {message !== null && (
        <div className="device-input-denied">
          <p>
            <strong>{label} refuses input.</strong> Mirroring works, but taps, keys and paste are ignored. On
            Xiaomi / HyperOS, turn on Developer options → “USB debugging (Security settings)”, then reconnect
            the device.
            {message !== '' && <span className="device-input-denied-detail mono">{message}</span>}
          </p>
          <button type="button" className="btn device-input-denied-dismiss" onClick={onDismiss}>
            Dismiss
          </button>
        </div>
      )}
    </div>
  );
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

/** What is mirrored: an emulator (PNG over gRPC) or a physical device (H.264 from scrcpy). */
export type ScreenTargetKind = 'emulator' | 'device';

type Props = {
  serial: string;
  /** Screenshot file name prefix. */
  name: string;
  label: string;
  kind: ScreenTargetKind;
  /** Stream only while the panel is on screen and the tab is visible. */
  isVisible: boolean;
  /** At the far end of the toolbar, apart from the device keys (Shut down for an emulator). */
  endTool?: ReactNode;
};

/** The live emulator or device screen in a device frame, with its controls. */
export function ScreenView({ serial, name, label, kind, isVisible, endTool }: Props) {
  const [size, setSize] = useStoredState<ScreenSize>(LAYOUT_KEYS.screenSize, parseScreenSize);
  // Destructured: the stream object carries the canvas ref, which render must not read through.
  const streamEvents = useRef<ScreenStreamEvents>({});
  const { state, info, fps, canvasRef, send, retry, videoError, inputDenied, dismissInputDenied } =
    useScreenStream({
      serial,
      name,
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
  const inspector = useInspectorContext();
  const frozen = inspector !== null && inspector.isActive ? inspector.snapshot : null;
  const stageRef = useRef<HTMLDivElement>(null);
  const stage = useElementSize(stageRef);
  const hintId = useId();

  const streamAspect = info && info.frameHeight > 0 ? info.frameWidth / info.frameHeight : DEFAULT_ASPECT;
  // The frozen screenshot has its own size and rotation.
  const aspect =
    frozen !== null && frozen.display.height > 0
      ? frozen.display.width / frozen.display.height
      : streamAspect;
  const glass = fitDeviceGlass(stage.width, stage.height, aspect);
  const orientation = aspect > 1 ? 'landscape' : 'portrait';
  const status = statusText(state, videoError);
  // Many apps lock their orientation; a device only rotates when the foreground app allows it.
  const rotateNote = kind === 'device' ? ' (best effort on a device)' : '';

  return (
    <div className="screen-view">
      <div className="device-toolbar" role="group" aria-label={`${label} controls`}>
        <ToolButton
          label="Power"
          title="Power button (screen on/off)"
          icon={<PowerIcon />}
          disabled={!isLive}
          onClick={() => send({ type: 'nav', button: 'power' })}
        />
        <ToolButton
          label="Rotate left"
          title={`Rotate left${rotateNote}`}
          icon={<RotateLeftIcon />}
          disabled={!isLive}
          onClick={() => send({ type: 'rotate', direction: 'left' })}
        />
        <ToolButton
          label="Rotate right"
          title={`Rotate right${rotateNote}`}
          icon={<RotateRightIcon />}
          disabled={!isLive}
          onClick={() => send({ type: 'rotate', direction: 'right' })}
        />
        <ToolButton
          label="Share clipboard"
          title={`Share clipboard with the ${kind}`}
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
        {inspector !== null && (
          <>
            <ToolButton
              label="Inspect"
              title="Inspect the layout: freezes the screen so you can pick a view (Esc exits)"
              icon={<InspectIcon />}
              disabled={!inspector.canInspect}
              isPressed={inspector.isActive}
              className="device-inspect"
              onClick={inspector.toggle}
            />
          </>
        )}
        <Segmented
          className="device-size"
          label="Frame size (short edge, px)"
          options={SIZE_OPTIONS}
          value={size}
          onChange={setSize}
          ignoreRepeat
        />
        {endTool}
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
              tabIndex={frozen !== null || inspector?.isActive ? -1 : 0}
              inert={inspector?.isActive || undefined}
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
            {inspector?.isActive && frozen !== null && (
              <InspectorOverlay controller={inspector} snapshot={frozen} label={label} />
            )}
            {inspector?.isActive && frozen === null && (
              <div
                className="device-glass-status"
                data-tone={inspector.failure === null ? 'capturing' : 'failed'}
                role="status"
              >
                {inspector.failure === null ? (
                  <>
                    <span className="banner-spinner" aria-hidden="true" />
                    <span>Capturing the screen…</span>
                  </>
                ) : (
                  <>
                    <span>{inspector.failure}</span>
                    <button type="button" className="btn device-retry" onClick={inspector.refresh}>
                      Try again
                    </button>
                  </>
                )}
              </div>
            )}
            {!inspector?.isActive && status !== null && (
              <div className="device-glass-status" data-tone={state.status} role="status">
                {state.status !== 'failed' && <span className="banner-spinner" aria-hidden="true" />}
                <span>{status}</span>
                {state.status === 'failed' && (videoError === null || videoError.canRetry) && (
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

      <InputDeniedBanner label={label} message={inputDenied} onDismiss={dismissInputDenied} />
      <div className="device-nav" role="group" aria-label="Navigation buttons">
        <span className="device-fps mono" title="Frames per second" data-live={isLive || undefined}>
          {isLive ? fps : '–'}
          <span className="device-fps-unit"> fps</span>
        </span>
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
        {inspector?.isActive ? (
          <>
            Frozen · hover to highlight · click to select · <kbd>Esc</kbd> exits
          </>
        ) : (
          <>
            Click to interact · <kbd>Esc</kbd> = Back · <kbd>Alt</kbd>+drag = pinch
          </>
        )}
        {!inspector?.isActive && clipboard.isPasteOnly && (
          <>
            {' · '}
            Press <kbd>{pasteShortcut()}</kbd> on the screen to send your clipboard
          </>
        )}
      </p>
      <p className="device-paste-note" role="status">
        {pasteNote}
      </p>
      <ClipboardToast toast={clipboard.toast} noun={kind} onCopy={clipboard.copyManually} />
    </div>
  );
}
