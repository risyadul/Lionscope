import { useId } from 'react';
import type { SdkOptions } from '@lionscope/protocol/wire';
import { STALL_THRESHOLDS_MS } from '@lionscope/protocol/wire';
import { formatBlockMs } from '../../lib/format.ts';
import { Segmented, type SegmentedOption } from '../ui/Segmented.tsx';

type Props = {
  options: SdkOptions;
  /** Why the controls are inert; null when they can be used. */
  blocker: string | null;
  /** A change was sent and the server hasn't answered yet. */
  isPending: boolean;
  onChange: (patch: Partial<SdkOptions>) => void;
  /** Why the inflation switch alone is inert (a link below protocol v3); null when it can be used. */
  inflateBlocker?: string | null;
  /** Why the RxJava switch alone is inert (a link below protocol v9); null when it can be used. */
  rxBlocker?: string | null;
};

const THRESHOLD_OPTIONS: readonly SegmentedOption<number>[] = STALL_THRESHOLDS_MS.map((ms) => ({
  value: ms,
  label: ms >= 1000 ? `${ms / 1000} s` : String(ms),
  title: `Report main-thread blocks of ${formatBlockMs(ms)} or longer`,
}));

export const SENDING_TEXT = 'Sending to the app…';

const STRICT_MODE_TITLE =
  'Adds disk, network, slow-call and leaked-closeable detection to the app’s StrictMode policies (API 28+) and reports violations here. The app’s own policies are restored when it is turned off.';

const INFLATE_TITLE =
  'Times every XML layout the app inflates on the main thread (Android 10+) and shows them in the Layouts tab. Turning it off stops recording, and screens opened afterwards get no hook; screens opened while it was on keep theirs.';

export const INFLATE_UPDATE_HINT = 'Update the app’s Lionscope SDK to 0.4.0 for layout timing';

const RX_TITLE =
  'Hooks RxJava 2, chained with the app’s own plugins, to name the chain and the line that subscribed it for each stall. Costs about 1–3 µs per observeOn subscription; turning it off removes the hooks.';

export const RX_UPDATE_HINT = 'Update the app’s Lionscope SDK to 0.9.0 for RxJava tracking';

/** Watchdog threshold and the StrictMode, inflation and RxJava switches; they reconfigure the SDK in the running app. */
export function StallControls({
  options,
  blocker,
  isPending,
  onChange,
  inflateBlocker = null,
  rxBlocker = null,
}: Props) {
  const blockerId = useId();
  const inflateBlockerId = useId();
  const rxBlockerId = useId();
  const isDisabled = blocker !== null;
  const isSending = !isDisabled && isPending;
  return (
    <div className="stall-controls" data-pending={isPending || undefined}>
      <div className="stall-control">
        <span className="overline" aria-hidden="true">
          Watchdog ms
        </span>
        <Segmented
          options={THRESHOLD_OPTIONS}
          value={options.stallThresholdMs}
          onChange={(stallThresholdMs) => onChange({ stallThresholdMs })}
          label="Watchdog threshold, ms"
          className="stall-thresholds"
          disabled={isDisabled}
          describedBy={isDisabled ? blockerId : undefined}
          ignoreRepeat
        />
      </div>
      <button
        type="button"
        role="switch"
        className="switch"
        aria-checked={options.strictMode}
        disabled={isDisabled}
        aria-describedby={isDisabled ? blockerId : undefined}
        title={STRICT_MODE_TITLE}
        onClick={() => onChange({ strictMode: !options.strictMode })}
      >
        <span className="switch-track" aria-hidden="true">
          <span className="switch-thumb" />
        </span>
        StrictMode
      </button>
      <button
        type="button"
        role="switch"
        className="switch"
        aria-checked={options.inflateTracking}
        disabled={isDisabled || inflateBlocker !== null}
        aria-describedby={inflateBlocker !== null && !isDisabled ? inflateBlockerId : undefined}
        title={INFLATE_TITLE}
        onClick={() => onChange({ inflateTracking: !options.inflateTracking })}
      >
        <span className="switch-track" aria-hidden="true">
          <span className="switch-thumb" />
        </span>
        Inflation tracking
      </button>
      <button
        type="button"
        role="switch"
        className="switch"
        aria-checked={options.rxTracking}
        disabled={isDisabled || rxBlocker !== null}
        aria-describedby={rxBlocker !== null && !isDisabled ? rxBlockerId : undefined}
        title={RX_TITLE}
        onClick={() => onChange({ rxTracking: !options.rxTracking })}
      >
        <span className="switch-track" aria-hidden="true">
          <span className="switch-thumb" />
        </span>
        RxJava tracking
      </button>
      {!isDisabled && inflateBlocker !== null && (
        <p id={inflateBlockerId} className="stall-blocker">
          {inflateBlocker}
        </p>
      )}
      {!isDisabled && rxBlocker !== null && (
        <p id={rxBlockerId} className="stall-blocker">
          {rxBlocker}
        </p>
      )}
      {isDisabled && (
        <p id={blockerId} className="stall-blocker">
          {blocker}
        </p>
      )}
      {isSending && (
        <p className="stall-blocker" data-quiet aria-hidden="true">
          {SENDING_TEXT}
        </p>
      )}
      {/* Always rendered, so screen readers announce the change (an element that appears isn't). */}
      <span className="sr-only" role="status">
        {isSending ? SENDING_TEXT : ''}
      </span>
    </div>
  );
}
