import type { KeyboardEvent, ReactNode } from 'react';
import { formatInteger } from '../../lib/format.ts';
import './side.css';

export type SideTab = 'screens' | 'stalls' | 'layouts' | 'inspector';

const TABS: readonly { id: SideTab; label: string }[] = [
  { id: 'screens', label: 'Screens' },
  { id: 'stalls', label: 'Stalls' },
  { id: 'layouts', label: 'Layouts' },
  { id: 'inspector', label: 'Inspector' },
];

type Props = {
  tab: SideTab;
  onTabChange: (tab: SideTab) => void;
  /** Rows in the screens table, shown on its tab. */
  screenCount: number;
  /** Stalls in the visible window, shown on its tab. */
  stallCount: number;
  /** Layouts in the visible window, shown on its tab. */
  layoutCount: number;
  /** Views in the latest Inspector snapshot, shown on its tab. */
  inspectorCount: number;
  screens: ReactNode;
  stalls: ReactNode;
  layouts: ReactNode;
  inspector: ReactNode;
  /** Only this tab, under a heading instead of the tab list (the Inspector view); the others stay mounted. */
  lockedTab?: SideTab;
};

/** The right-hand column: the per-screen table and stalls share it as tabs (both stay mounted). */
export function SidePanel({
  tab,
  onTabChange,
  screenCount,
  stallCount,
  layoutCount,
  inspectorCount,
  screens,
  stalls,
  layouts,
  inspector,
  lockedTab,
}: Props) {
  const counts: Record<SideTab, number> = {
    screens: screenCount,
    stalls: stallCount,
    layouts: layoutCount,
    inspector: inspectorCount,
  };
  const panels: Record<SideTab, ReactNode> = { screens, stalls, layouts, inspector };
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

  if (lockedTab !== undefined) {
    const locked = TABS.find((t) => t.id === lockedTab);
    return (
      <aside className="side" data-locked={lockedTab} aria-labelledby={`side-title-${lockedTab}`}>
        <div className="side-tabs">
          <h2 id={`side-title-${lockedTab}`} className="side-tab side-title">
            {locked?.label}
            {counts[lockedTab] > 0 && (
              <span className="side-tab-count mono" data-tab={lockedTab}>
                {formatInteger(counts[lockedTab])}
              </span>
            )}
          </h2>
        </div>
        {TABS.map((t) => (
          <div key={t.id} id={`side-panel-${t.id}`} className="side-panel" hidden={t.id !== lockedTab}>
            {panels[t.id]}
          </div>
        ))}
      </aside>
    );
  }

  return (
    <aside className="side" aria-label="Screens, stalls, layouts and inspector">
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
