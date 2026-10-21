import type { KeyboardEvent, ReactNode } from 'react';
import { formatInteger } from '../../lib/format.ts';
import './side.css';

export type SideTab = 'logcat' | 'screens';

const TABS: readonly { id: SideTab; label: string }[] = [
  { id: 'logcat', label: 'Logcat' },
  { id: 'screens', label: 'Screens' },
];

type Props = {
  tab: SideTab;
  onTabChange: (tab: SideTab) => void;
  /** Rows in the screens table, shown on its tab. */
  screenCount: number;
  logcat: ReactNode;
  screens: ReactNode;
};

/** The right-hand column: logcat and the per-screen table share it as tabs (both stay mounted). */
export function SidePanel({ tab, onTabChange, screenCount, logcat, screens }: Props) {
  // WAI-ARIA tabs: arrows wrap, Home/End jump to the ends; selection follows focus.
  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const at = TABS.findIndex((t) => t.id === tab);
    let index: number;
    if (event.key === 'ArrowRight') index = (at + 1) % TABS.length;
    else if (event.key === 'ArrowLeft') index = (at - 1 + TABS.length) % TABS.length;
    else if (event.key === 'Home') index = 0;
    else if (event.key === 'End') index = TABS.length - 1;
    else return;
    const next = TABS[index];
    if (!next) return;
    event.preventDefault();
    onTabChange(next.id);
    event.currentTarget.querySelector<HTMLButtonElement>(`#side-tab-${next.id}`)?.focus();
  };

  return (
    <aside className="side" aria-label="Logs and screens">
      <div className="side-tabs" role="tablist" aria-label="Side panel" onKeyDown={handleKeyDown}>
        {TABS.map((t) => (
          <button
            key={t.id}
            id={`side-tab-${t.id}`}
            type="button"
            role="tab"
            className="side-tab"
            aria-selected={tab === t.id}
            aria-controls={`side-panel-${t.id}`}
            tabIndex={tab === t.id ? 0 : -1}
            onClick={() => onTabChange(t.id)}
          >
            {t.label}
            {t.id === 'screens' && screenCount > 0 && (
              <span className="side-tab-count mono">{formatInteger(screenCount)}</span>
            )}
          </button>
        ))}
      </div>
      <div
        id="side-panel-logcat"
        className="side-panel"
        role="tabpanel"
        aria-labelledby="side-tab-logcat"
        tabIndex={0}
        hidden={tab !== 'logcat'}
      >
        {logcat}
      </div>
      <div
        id="side-panel-screens"
        className="side-panel"
        role="tabpanel"
        aria-labelledby="side-tab-screens"
        tabIndex={0}
        hidden={tab !== 'screens'}
      >
        {screens}
      </div>
    </aside>
  );
}
