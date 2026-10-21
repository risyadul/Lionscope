import type { KeyboardEvent, ReactNode } from 'react';
import { formatInteger } from '../../lib/format.ts';
import './side.css';

export type SideTab = 'logcat' | 'screens' | 'stalls';

const TABS: readonly { id: SideTab; label: string }[] = [
  { id: 'logcat', label: 'Logcat' },
  { id: 'screens', label: 'Screens' },
  { id: 'stalls', label: 'Stalls' },
];

type Props = {
  tab: SideTab;
  onTabChange: (tab: SideTab) => void;
  /** Rows in the screens table, shown on its tab. */
  screenCount: number;
  /** Stalls in the visible window, shown on its tab. */
  stallCount: number;
  logcat: ReactNode;
  screens: ReactNode;
  stalls: ReactNode;
};

/** The right-hand column: logcat, the per-screen table and stalls share it as tabs (all stay mounted). */
export function SidePanel({ tab, onTabChange, screenCount, stallCount, logcat, screens, stalls }: Props) {
  const counts: Record<SideTab, number> = { logcat: 0, screens: screenCount, stalls: stallCount };
  const panels: Record<SideTab, ReactNode> = { logcat, screens, stalls };
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
    <aside className="side" aria-label="Logs, screens and stalls">
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
            {counts[t.id] > 0 && (
              <span className="side-tab-count mono" data-tab={t.id}>
                {formatInteger(counts[t.id])}
              </span>
            )}
          </button>
        ))}
      </div>
      {TABS.map((t) => (
        <div
          key={t.id}
          id={`side-panel-${t.id}`}
          className="side-panel"
          role="tabpanel"
          aria-labelledby={`side-tab-${t.id}`}
          tabIndex={0}
          hidden={tab !== t.id}
        >
          {panels[t.id]}
        </div>
      ))}
    </aside>
  );
}
