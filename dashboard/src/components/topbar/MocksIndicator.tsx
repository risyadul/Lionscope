import type { MocksIndicatorState } from '../../lib/network.ts';

const STATE_LABELS: Record<MocksIndicatorState['state'], string | null> = {
  applied: 'applied',
  waiting: 'waiting for the app',
  idle: null,
};

const STATE_TITLES: Record<MocksIndicatorState['state'], string> = {
  applied: 'The app runs with these rules: matching requests never reach the network.',
  waiting: 'The app hasn’t confirmed the latest rules yet (it applies them while its SDK is linked).',
  idle: 'Rules are kept for the session.',
};

type Props = {
  indicator: MocksIndicatorState;
  /** Opens the Profiler's Network tab on its Mocks list. */
  onOpen: () => void;
};

/** "N mocks active" in the top bar (every view) while enabled rules exist: the app's network is not all real. */
export function MocksIndicator({ indicator, onOpen }: Props) {
  const { count, state } = indicator;
  const label = `${count} ${count === 1 ? 'mock' : 'mocks'} active`;
  const meta = STATE_LABELS[state];
  return (
    <button
      type="button"
      className="mocks-pill"
      data-state={state}
      onClick={onOpen}
      title={`${STATE_TITLES[state]} Click to see the rules.`}
      aria-label={meta === null ? `${label}: show the rules` : `${label}, ${meta}: show the rules`}
    >
      <span className="mocks-dot" aria-hidden="true" />
      <span className="mocks-label">{label}</span>
      {meta && <span className="mocks-meta">{meta}</span>}
    </button>
  );
}
