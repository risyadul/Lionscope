import { useSignal } from '../../hooks/useSignal.ts';
import { formatClockShort } from '../../lib/format.ts';
import type { Signal } from '../../lib/signal.ts';
import { Segmented, type SegmentedOption } from '../ui/Segmented.tsx';

export const WINDOW_OPTIONS: readonly SegmentedOption<number>[] = [
  { value: 60_000, label: '1m', title: 'Last minute' },
  { value: 5 * 60_000, label: '5m', title: 'Last 5 minutes' },
  { value: 10 * 60_000, label: '10m', title: 'Last 10 minutes' },
];

type Props = {
  windowMs: number;
  onWindowChange: (ms: number) => void;
  isPaused: boolean;
  pausedAt: number | null;
  onPause: () => void;
  onResume: () => void;
  cursorX: Signal<number | null>;
};

function CursorReadout({ cursorX, isPaused, pausedAt }: Pick<Props, 'cursorX' | 'isPaused' | 'pausedAt'>) {
  const x = useSignal(cursorX);
  if (x !== null) {
    return (
      <span className="cursor-readout" aria-live="off">
        <span className="overline">Cursor</span> <span className="mono">{formatClockShort(x * 1000)}</span>
      </span>
    );
  }
  if (isPaused && pausedAt !== null) {
    return (
      <span className="cursor-readout">
        <span className="overline">Frozen at</span> <span className="mono">{formatClockShort(pausedAt)}</span>
      </span>
    );
  }
  return null;
}

export function WindowControls({
  windowMs,
  onWindowChange,
  isPaused,
  pausedAt,
  onPause,
  onResume,
  cursorX,
}: Props) {
  return (
    <>
      <CursorReadout cursorX={cursorX} isPaused={isPaused} pausedAt={pausedAt} />
      <Segmented label="Time window" options={WINDOW_OPTIONS} value={windowMs} onChange={onWindowChange} />
      {isPaused ? (
        <button type="button" className="btn live-btn" onClick={onResume}>
          <span className="live-dot" aria-hidden="true" />
          Live
        </button>
      ) : (
        <button
          type="button"
          className="btn"
          onClick={onPause}
          title="Freeze the charts; data keeps recording"
        >
          <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
            <rect x="1.5" y="1" width="2.4" height="8" rx="0.6" fill="currentColor" />
            <rect x="6.1" y="1" width="2.4" height="8" rx="0.6" fill="currentColor" />
          </svg>
          Pause
        </button>
      )}
    </>
  );
}
