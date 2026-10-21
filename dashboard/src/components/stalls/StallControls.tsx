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
};

const THRESHOLD_OPTIONS: readonly SegmentedOption<number>[] = STALL_THRESHOLDS_MS.map((ms) => ({
  value: ms,
  label: ms >= 1000 ? `${ms / 1000} s` : String(ms),
  title: `Report main-thread blocks of ${formatBlockMs(ms)} or longer`,
}));

export const SENDING_TEXT = 'Sending to the app…';

const STRICT_MODE_TITLE =
  'Adds disk, network, slow-call and leaked-closeable detection to the app’s StrictMode policies (API 28+) and reports violations here. The app’s own policies are restored when it is turned off.';

/** Watchdog threshold and StrictMode switch; they reconfigure the SDK in the running app. */
export function StallControls({ options, blocker, isPending, onChange }: Props) {
  const blockerId = useId();
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
