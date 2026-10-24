import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent,
} from 'react';
import { ANSWER_TIMEOUT_MS, SETTLE_MS, type EditResult, type EditStatus } from '../../hooks/useViewEdits.ts';
import { useSignal } from '../../hooks/useSignal.ts';
import {
  argbCss,
  argbToHsva,
  canSampleScreen,
  eyedropper,
  hsvaToArgb,
  hueCss,
  recentColors,
  rememberColor,
  type EyedropperRequest,
  type Hsva,
} from '../../lib/colorPicker.ts';
import { normalizeColor } from '@lionscope/protocol/wire';
import { SLIDER_IDLE_MS } from '../../lib/viewEdits.ts';
import './colorPicker.css';

/** A field without a single color (none, an image, a shape) starts the picker at opaque white. */
const START = '#FFFFFFFF';
const STEP = 0.01;
const BIG_STEP = 0.1;

type Props = {
  id: string;
  /** The app's color (`#AARRGGBB`), null when the view has no single color. */
  value: string | null;
  /** The field's edit status: while an edit of it applies, the picker doesn't follow the snapshots. */
  status: EditStatus['kind'];
  /** Why the last edit missed its view (said in the Inspector's head), as `ViewEdits.notice`. */
  notice: string | null;
  /** "background color": names the controls. */
  label: string;
  /** The background and text colors of the snapshot's views. */
  screen: readonly string[];
  disabled: boolean;
  /** The color being picked (the row's swatch shows it), null to show the app's again. */
  onPreview: (argb: string | null) => void;
  /** Sends the color to the app. */
  onCommit: (argb: string) => EditResult;
  onClose: () => void;
};

const percent = (n: number) => `${Math.round(n * 100)}%`;
const fromValue = (value: string | null): Hsva => argbToHsva(value ?? START) ?? { h: 0, s: 0, v: 1, a: 1 };

/**
 * The color picker under a color field: a saturation/brightness square, hue and alpha sliders, the colors on this
 * screen and the recent ones, and an eyedropper on the frozen screen. It sends what it rests on (on release, or
 * SLIDER_IDLE_MS after the last key), never every step: each edit takes a new snapshot. While the user moves it, or
 * an edit of the field applies, it keeps its own color; once the field settles it shows the app's again.
 */
export function ColorPicker({
  id,
  value,
  status,
  notice,
  label,
  screen,
  disabled,
  onPreview,
  onCommit,
  onClose,
}: Props) {
  const [hsva, setHsva] = useState<Hsva>(() => fromValue(value));
  const [isDragging, setIsDragging] = useState(false);
  // A color moved to and not sent yet (the idle timer runs). State for rendering, a ref for the release that may
  // come before React re-renders after the last move.
  const [unsent, setUnsent] = useState<string | null>(null);
  const unsentRef = useRef<string | null>(null);
  // The color sent last, until a snapshot shows it, the field fails, or it is given up on.
  const [inFlight, setInFlight] = useState<{ argb: string; notice: string | null } | null>(null);
  const [followed, setFollowed] = useState(`${value}|${status}|${notice}`);
  const recent = useSignal(recentColors);
  const request = useSignal(eyedropper);
  const canSample = useSignal(canSampleScreen);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const giveUp = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isPicking = request !== null && request.label === label;

  // The app's color, once nothing of the user's is in flight: a snapshot taken between two edits (it shows the
  // first) never pulls the picker back, and a failed edit gives way to what the app has.
  const isAnswered =
    inFlight !== null &&
    (value === inFlight.argb || status === 'error' || (notice !== null && notice !== inFlight.notice));
  if (isAnswered) setInFlight(null);
  const isWaiting = inFlight !== null && !isAnswered;
  const key = `${value}|${status}|${notice}`;
  if (followed !== key && !isDragging && unsent === null && status !== 'applying' && !isWaiting) {
    setFollowed(key);
    // Already showing it (a grey keeps the hue it was picked with), or no single color to show.
    const target = value === null ? null : normalizeColor(value);
    if (target !== null && hsvaToArgb(hsva) !== target) setHsva(fromValue(target));
  }

  // The timer and the eyedropper call these after later renders: they read the latest props.
  const latest = useRef({ onCommit, onPreview });
  useLayoutEffect(() => {
    latest.current = { onCommit, onPreview };
  });

  const cancelTimer = () => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
  };

  const keep = (argb: string | null) => {
    unsentRef.current = argb;
    setUnsent(argb);
  };

  const send = (argb: string) => {
    cancelTimer();
    keep(null);
    const result = latest.current.onCommit(argb);
    if (result === 'sent') {
      rememberColor(argb);
      // Sending clears the head's notice: any notice from now on answers this edit.
      setInFlight({ argb, notice: null });
      // An answer lost, or a refusal shown in the Inspector's head: follow the app again after a while.
      if (giveUp.current !== null) clearTimeout(giveUp.current);
      giveUp.current = setTimeout(() => {
        setInFlight(null);
        setFollowed('');
      }, ANSWER_TIMEOUT_MS + SETTLE_MS);
    } else {
      // Unchanged or refused: back to the app's color.
      latest.current.onPreview(null);
    }
  };

  /** Moves the picker; sent on release, or after the keys rest. */
  const move = (next: Hsva, sendLater: boolean) => {
    const argb = hsvaToArgb(next);
    setHsva(next);
    keep(argb);
    onPreview(argb);
    cancelTimer();
    if (sendLater) timer.current = setTimeout(() => send(argb), SLIDER_IDLE_MS);
  };

  const flush = () => {
    if (unsentRef.current !== null) send(unsentRef.current);
  };

  const release = () => {
    setIsDragging(false);
    flush();
  };

  /** A swatch or a picked pixel: sent at once. */
  const choose = (argb: string) => {
    const next = argbToHsva(argb);
    if (next === null) return;
    setHsva(next);
    onPreview(argb);
    send(argb);
  };
  const chooseRef = useRef(choose);
  useLayoutEffect(() => {
    chooseRef.current = choose;
  });

  // Closing (or the pane going away) drops an unsent move and an eyedropper waiting for this picker.
  useEffect(() => {
    const pendingTimer = timer;
    const giveUpTimer = giveUp;
    const props = latest;
    return () => {
      if (pendingTimer.current !== null) clearTimeout(pendingTimer.current);
      if (giveUpTimer.current !== null) clearTimeout(giveUpTimer.current);
      if (eyedropper.get()?.label === label) eyedropper.set(null);
      props.current.onPreview(null);
    };
  }, [label]);

  // Nothing of the user's unsent or in flight: the row's swatch shows the app's color again.
  useEffect(() => {
    if (inFlight === null && unsent === null && !isDragging) latest.current.onPreview(null);
  }, [inFlight, unsent, isDragging]);

  // Editing turned off (a stale screen): a waiting eyedropper would pick nothing.
  useEffect(() => {
    if (disabled && eyedropper.get()?.label === label) eyedropper.set(null);
  }, [disabled, label]);

  const square = (event: PointerEvent<HTMLDivElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;
    const s = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
    const v = 1 - Math.min(1, Math.max(0, (event.clientY - rect.top) / rect.height));
    move({ ...hsva, s, v }, false);
  };

  const onSquareKey = (event: KeyboardEvent<HTMLDivElement>) => {
    const step = event.shiftKey ? BIG_STEP : STEP;
    const delta: Partial<Record<string, [number, number]>> = {
      ArrowLeft: [-step, 0],
      ArrowRight: [step, 0],
      ArrowUp: [0, step],
      ArrowDown: [0, -step],
    };
    const d = delta[event.key];
    if (d === undefined) return;
    event.preventDefault();
    move(
      {
        ...hsva,
        s: Math.min(1, Math.max(0, hsva.s + d[0])),
        v: Math.min(1, Math.max(0, hsva.v + d[1])),
      },
      true,
    );
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    // The frozen screen already took this Escape (it gave up the eyedropper).
    if (event.key !== 'Escape' || event.defaultPrevented) return;
    // One Escape: the eyedropper first, then the picker (an unsent move is dropped).
    event.preventDefault();
    event.stopPropagation();
    if (isPicking) {
      eyedropper.set(null);
      return;
    }
    cancelTimer();
    keep(null);
    onPreview(null);
    onClose();
  };

  const pickFromScreen = () => {
    if (isPicking) {
      eyedropper.set(null);
      return;
    }
    const next: EyedropperRequest = {
      label,
      onPick: (argb) => {
        eyedropper.set(null);
        chooseRef.current(argb);
      },
      onCancel: () => eyedropper.set(null),
    };
    eyedropper.set(next);
  };

  // Native range drags: the picker holds its color until the release.
  const rangeEvents = {
    onPointerDown: (event: PointerEvent<HTMLInputElement>) => {
      if (event.button === 0) setIsDragging(true);
    },
    onPointerUp: release,
    onPointerCancel: release,
    onBlur: flush,
  };

  const argb = hsvaToArgb(hsva);
  const opaque = hsvaToArgb({ ...hsva, a: 1 });
  const swatchRow = (title: string, colors: readonly string[]) =>
    colors.length === 0 ? null : (
      <div className="cp-swatches" role="group" aria-label={title}>
        <span className="cp-swatches-title">{title}</span>
        <div className="cp-swatch-list">
          {colors.map((color) => (
            <button
              key={color}
              type="button"
              className="cp-swatch"
              title={color}
              aria-label={`${title}: ${color}`}
              aria-current={color === argb || undefined}
              disabled={disabled}
              onClick={() => choose(color)}
            >
              <span style={{ backgroundColor: argbCss(color) }} />
            </button>
          ))}
        </div>
      </div>
    );

  return (
    <div id={id} className="cp" role="group" aria-label={`Pick the ${label}`} onKeyDown={onKeyDown}>
      <div
        className="cp-square"
        style={{ backgroundColor: hueCss(hsva.h) }}
        role="slider"
        tabIndex={disabled ? -1 : 0}
        aria-label={`${label}: saturation and brightness`}
        aria-valuetext={`saturation ${percent(hsva.s)}, brightness ${percent(hsva.v)}`}
        aria-valuenow={Math.round(hsva.s * 100)}
        aria-disabled={disabled || undefined}
        aria-describedby={`${id}-keys`}
        onPointerDown={(event) => {
          if (disabled || event.button !== 0) return;
          event.currentTarget.setPointerCapture(event.pointerId);
          setIsDragging(true);
          square(event);
        }}
        onPointerMove={(event) => {
          // Only with the button held: a drag whose release went elsewhere (a context menu) never moves it.
          if (isDragging && (event.buttons & 1) === 1) square(event);
        }}
        onPointerUp={release}
        onPointerCancel={release}
        onKeyDown={onSquareKey}
        onBlur={flush}
      >
        <span
          className="cp-thumb"
          style={{ left: percent(hsva.s), top: percent(1 - hsva.v), backgroundColor: argbCss(opaque) }}
          aria-hidden="true"
        />
      </div>
      <span id={`${id}-keys`} className="sr-only">
        Left and right arrows change the saturation, up and down the brightness; Shift steps by ten.
      </span>
      <div className="cp-sliders">
        <input
          className="cp-range cp-hue"
          type="range"
          min={0}
          max={359}
          step={1}
          value={Math.round(hsva.h)}
          aria-label={`${label}: hue`}
          aria-valuetext={`${Math.round(hsva.h)}°`}
          disabled={disabled}
          onChange={(event) => move({ ...hsva, h: Number(event.target.value) }, true)}
          {...rangeEvents}
        />
        <input
          className="cp-range cp-alpha"
          type="range"
          min={0}
          max={1}
          step={0.01}
          value={hsva.a}
          style={{ '--cp-opaque': argbCss(opaque) } as CSSProperties}
          aria-label={`${label}: alpha`}
          aria-valuetext={percent(hsva.a)}
          disabled={disabled}
          onChange={(event) => move({ ...hsva, a: Number(event.target.value) }, true)}
          {...rangeEvents}
        />
      </div>
      <div className="cp-bar">
        <span className="cp-preview" aria-hidden="true">
          <span style={{ backgroundColor: argbCss(argb) }} />
        </span>
        <span className="cp-hex mono">{argb}</span>
        <button
          type="button"
          className="btn cp-eyedropper"
          aria-pressed={isPicking}
          disabled={disabled || (!canSample && !isPicking)}
          title={
            canSample
              ? 'Pick a color from the frozen screen'
              : 'The frozen screen’s screenshot isn’t shown, so there is nothing to pick from'
          }
          onClick={pickFromScreen}
        >
          <svg width="13" height="13" viewBox="0 0 13 13" aria-hidden="true">
            <path
              d="M8.6 1.6a1.8 1.8 0 0 1 2.6 2.6L9.8 5.6l.7.7-1 1-.7-.7-4.6 4.6H2.4v-1.8L7 4.8l-.7-.7 1-1 .7.7z"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.2"
              strokeLinejoin="round"
            />
          </svg>
          Pick
        </button>
      </div>
      {isPicking && (
        <p className="cp-hint" role="status">
          Click a pixel on the frozen screen (the mouse only). Esc cancels.
        </p>
      )}
      {swatchRow('On this screen', screen)}
      {swatchRow('Recent', recent)}
    </div>
  );
}
