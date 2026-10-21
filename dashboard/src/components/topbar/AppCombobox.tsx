import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import type { AppInfo } from '@lionscope/protocol/wire';
import { isValidPackageName } from '@lionscope/protocol/wire';
import { useDebouncedValue } from '../../hooks/useDebouncedValue.ts';
import { filterApps, sortApps } from '../../lib/devices.ts';
import { splitMatch } from '../../lib/logFilter.ts';

/** Options rendered at once; typing narrows the rest. */
const MAX_OPTIONS = 200;
const ANNOUNCE_DEBOUNCE_MS = 500;

type Option =
  | { kind: 'app'; app: AppInfo }
  | { kind: 'custom'; packageName: string }
  /** Keyboard-reachable switch that reveals system packages hidden by the filter. */
  | { kind: 'reveal'; count: number };

export interface AppOptions {
  options: Option[];
  /** Matching packages currently shown (before the render cap). */
  shown: number;
  /** System packages matching the query but hidden by "Third-party only". */
  hiddenSystem: number;
  /** The filter found no third-party match, so system matches are shown instead. */
  autoRevealed: boolean;
}

/**
 * Builds the option list. "Third-party only" never makes a typed system package
 * unreachable: with no third-party match the system matches are shown anyway, and
 * otherwise a "Show N system apps" option sits at the end of the list.
 */
export function buildAppOptions(
  apps: readonly AppInfo[],
  query: string,
  thirdPartyOnly: boolean,
): AppOptions {
  const sorted = sortApps(apps);
  const all = filterApps(sorted, { query, thirdPartyOnly: false });
  const thirdParty = thirdPartyOnly ? filterApps(all, { query: '', thirdPartyOnly: true }) : all;
  const typed = query.trim();
  const autoRevealed = thirdPartyOnly && typed !== '' && thirdParty.length === 0 && all.length > 0;
  const matches = autoRevealed ? all : thirdParty;
  const hiddenSystem = all.length - matches.length;

  const options: Option[] = matches.slice(0, MAX_OPTIONS).map((app) => ({ kind: 'app', app }));
  if (typed !== '' && !matches.some((app) => app.packageName === typed) && isValidPackageName(typed)) {
    options.push({ kind: 'custom', packageName: typed });
  }
  if (hiddenSystem > 0) options.push({ kind: 'reveal', count: hiddenSystem });
  return { options, shown: matches.length, hiddenSystem, autoRevealed };
}

function optionKey(option: Option): string {
  switch (option.kind) {
    case 'app':
      return option.app.packageName;
    case 'custom':
      return `custom:${option.packageName}`;
    case 'reveal':
      return 'reveal';
  }
}

function PackageName({ name, query }: { name: string; query: string }) {
  const parts = splitMatch(name, query);
  if (!parts) return <>{name}</>;
  return (
    <>
      {parts[0]}
      <mark>{parts[1]}</mark>
      {parts[2]}
    </>
  );
}

type Props = {
  /** Apps for the selected device; null while loading. */
  apps: readonly AppInfo[] | null;
  value: string | null;
  onChange: (packageName: string) => void;
  /** Called when the list opens, to refresh the package list (the caller throttles). */
  onOpen: () => void;
  isDisabled: boolean;
  disabledReason?: string;
};

/** Searchable app picker following the WAI-ARIA combobox (list autocomplete) pattern. */
export function AppCombobox({ apps, value, onChange, onOpen, isDisabled, disabledReason }: Props) {
  const id = useId();
  const listId = `${id}-list`;
  const [isOpen, setIsOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const [thirdPartyOnly, setThirdPartyOnly] = useState(true);
  const listRef = useRef<HTMLUListElement>(null);

  const { options, shown, autoRevealed } = useMemo(
    () => buildAppOptions(apps ?? [], query, thirdPartyOnly),
    [apps, query, thirdPartyOnly],
  );
  const runningCount = useMemo(
    () => options.filter((o) => o.kind === 'app' && o.app.pid !== null).length,
    [options],
  );
  const active = Math.min(activeIndex, Math.max(0, options.length - 1));
  const activeId = options[active] ? `${id}-opt-${active}` : undefined;

  const status =
    apps === null
      ? 'Loading packages…'
      : `${shown} ${shown === 1 ? 'app' : 'apps'}${runningCount > 0 ? ` · ${runningCount} running` : ''}`;
  // Announce the count once typing settles, not on every keystroke.
  const announced = useDebouncedValue(isOpen ? status : '', ANNOUNCE_DEBOUNCE_MS);

  useEffect(() => {
    if (!isOpen) return;
    const el = listRef.current?.querySelector<HTMLElement>(`[data-index="${active}"]`);
    el?.scrollIntoView({ block: 'nearest' });
  }, [active, isOpen]);

  const open = () => {
    if (isOpen || isDisabled) return;
    setIsOpen(true);
    setQuery('');
    setActiveIndex(0);
    onOpen();
  };

  const close = () => {
    setIsOpen(false);
    setQuery('');
  };

  const toggleSystem = () => {
    setThirdPartyOnly((v) => !v);
    setActiveIndex(0);
  };

  const choose = (option: Option | undefined) => {
    if (!option) return;
    if (option.kind === 'reveal') {
      setThirdPartyOnly(false);
      return;
    }
    onChange(option.kind === 'app' ? option.app.packageName : option.packageName);
    close();
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.altKey && event.code === 'KeyS') {
      event.preventDefault();
      if (!isOpen) open();
      toggleSystem();
      return;
    }
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        if (!isOpen) open();
        else setActiveIndex(Math.min(active + 1, options.length - 1));
        break;
      case 'ArrowUp':
        event.preventDefault();
        if (isOpen) setActiveIndex(Math.max(active - 1, 0));
        break;
      case 'Home':
        if (isOpen) {
          event.preventDefault();
          setActiveIndex(0);
        }
        break;
      case 'End':
        if (isOpen) {
          event.preventDefault();
          setActiveIndex(options.length - 1);
        }
        break;
      case 'Enter':
        if (isOpen) {
          event.preventDefault();
          choose(options[active]);
        }
        break;
      case 'Escape':
        if (isOpen) {
          event.preventDefault();
          close();
        }
        break;
      case 'Tab':
        close();
        break;
    }
  };

  return (
    <div className="field field--grow">
      <label className="overline" htmlFor={`${id}-input`}>
        App
      </label>
      <div className="combo" data-open={isOpen || undefined}>
        <input
          id={`${id}-input`}
          className="combo-input mono"
          type="text"
          role="combobox"
          aria-expanded={isOpen}
          aria-controls={isOpen ? listId : undefined}
          aria-autocomplete="list"
          aria-activedescendant={isOpen ? activeId : undefined}
          aria-keyshortcuts="Alt+S"
          autoComplete="off"
          spellCheck={false}
          placeholder={isDisabled ? (disabledReason ?? 'Select a device first') : 'Search packages'}
          title={isDisabled ? disabledReason : undefined}
          disabled={isDisabled}
          value={isOpen ? query : (value ?? '')}
          onClick={open}
          onBlur={close}
          onChange={(e) => {
            if (!isOpen) open();
            setQuery(e.target.value);
            setActiveIndex(0);
          }}
          onKeyDown={handleKeyDown}
        />
        <svg className="select-chevron" width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
          <path d="m2 3.5 3 3 3-3" fill="none" stroke="currentColor" strokeWidth="1.5" />
        </svg>
        <span className="sr-only" aria-live="polite">
          {announced}
        </span>
        {isOpen && (
          // Pointer-down inside the popover must not blur the input.
          <div className="combo-pop" onMouseDown={(e) => e.preventDefault()}>
            <div className="combo-toolbar">
              <label className="check">
                <input type="checkbox" checked={thirdPartyOnly} tabIndex={-1} onChange={toggleSystem} />
                Third-party only
                <kbd className="combo-kbd">Alt S</kbd>
              </label>
              <span className="combo-status mono">{status}</span>
            </div>
            {autoRevealed && <p className="combo-note">No third-party match — showing system packages.</p>}
            <ul ref={listRef} id={listId} className="combo-list" role="listbox" aria-label="Apps">
              {options.length === 0 && (
                <li className="combo-empty" role="presentation">
                  {apps === null ? 'Loading packages…' : 'No matching packages'}
                </li>
              )}
              {options.map((option, i) => (
                <li
                  key={optionKey(option)}
                  id={`${id}-opt-${i}`}
                  data-index={i}
                  role="option"
                  aria-selected={i === active}
                  className="combo-option"
                  data-kind={option.kind}
                  data-current={(option.kind === 'app' && option.app.packageName === value) || undefined}
                  onMouseMove={() => i !== active && setActiveIndex(i)}
                  onClick={() => choose(option)}
                >
                  {option.kind === 'app' && (
                    <>
                      <span className="combo-name mono">
                        <PackageName name={option.app.packageName} query={query} />
                      </span>
                      {option.app.pid !== null && (
                        <span className="pid-badge mono">PID {option.app.pid}</span>
                      )}
                      {!option.app.thirdParty && <span className="sys-badge">system</span>}
                    </>
                  )}
                  {option.kind === 'custom' && (
                    <>
                      <span className="combo-name mono">
                        Use <strong>{option.packageName}</strong>
                      </span>
                      <span className="sys-badge">not listed</span>
                    </>
                  )}
                  {option.kind === 'reveal' && (
                    <span className="combo-name">
                      Show {option.count} system {option.count === 1 ? 'app' : 'apps'}
                    </span>
                  )}
                </li>
              ))}
              {shown > MAX_OPTIONS && (
                <li className="combo-empty" role="presentation">
                  {shown - MAX_OPTIONS} more — keep typing to narrow
                </li>
              )}
            </ul>
            {!thirdPartyOnly && (
              <p className="combo-note combo-note--foot">Showing system apps · Alt S to hide</p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
