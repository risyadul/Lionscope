import { useEffect, useId, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import type { DeviceLocation } from '@lionscope/protocol/wire';
import { useStoredState } from '../../hooks/useStoredState.ts';
import type { LocationsController } from '../../hooks/useDeviceLocations.ts';
import { LAYOUT_KEYS } from '../../lib/layoutPrefs.ts';
import {
  addSavedPlace,
  formatLatLng,
  MAX_PLACE_NAME_CHARS,
  parseLocationInput,
  parseSavedPlaces,
  removeSavedPlace,
  sameLatLng,
  serializeSavedPlaces,
  type LatLng,
  type SavedPlace,
} from '../../lib/location.ts';
import { LocationMap } from './LocationMap.tsx';
import './location.css';

type Kind = 'emulator' | 'device';

const METHOD_TEXT: Record<DeviceLocation['method'], string> = {
  emulator: 'Emulator GPS: apps see a real fix.',
  mock_provider: 'Mock location: apps see Location.isMock(), and some refuse it.',
};

function parseLast(raw: string | null): LatLng | null {
  const parsed = raw === null ? null : parseLocationInput(raw);
  return parsed?.ok ? parsed.point : null;
}

function clockTime(ms: number): string {
  return new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

type Props = {
  /** The panel element's id (the toolbar button's `aria-controls`). */
  id?: string;
  serial: string;
  label: string;
  kind: Kind;
  controller: LocationsController;
  onClose: () => void;
};

/**
 * Put the device somewhere else, like the Android Studio emulator's Location controls: pick a point on the map, or
 * type coordinates or paste a Google Maps link, then Set location. Places can be saved (in this browser).
 */
export function LocationPanel({ id: panelId, serial, label, kind, controller, onClose }: Props) {
  const id = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const active = controller.locations?.find((location) => location.serial === serial) ?? null;
  const [last, setLast] = useStoredState<LatLng | null>(LAYOUT_KEYS.locationLast, parseLast, (point) =>
    point === null ? '' : formatLatLng(point),
  );
  const [places, setPlaces] = useStoredState<SavedPlace[]>(
    LAYOUT_KEYS.locationPlaces,
    parseSavedPlaces,
    serializeSavedPlaces,
  );
  const [draft, setDraft] = useState<LatLng | null>(() => active ?? last);
  const [text, setText] = useState(() => (draft === null ? '' : formatLatLng(draft)));
  const [inputError, setInputError] = useState<string | null>(null);
  const [placeName, setPlaceName] = useState<string | null>(null);
  const [focusSeq, setFocusSeq] = useState(0);
  const isPending = controller.pendingSerial === serial;
  const canChange = controller.blocker === null && !isPending;
  const isDraftActive = active !== null && sameLatLng(active, draft);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const pick = (point: LatLng) => {
    setDraft(point);
    setText(formatLatLng(point));
    setInputError(null);
  };

  /** A point from outside the map: the map centres on it. */
  const choose = (point: LatLng) => {
    pick(point);
    setFocusSeq((seq) => seq + 1);
  };

  const changeText = (value: string) => {
    setText(value);
    const parsed = parseLocationInput(value);
    if (parsed.ok) {
      setDraft(parsed.point);
      setInputError(null);
      setFocusSeq((seq) => seq + 1);
    }
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const parsed = parseLocationInput(text);
    if (!parsed.ok) {
      setInputError(parsed.error);
      return;
    }
    choose(parsed.point);
    setLast(parsed.point);
    controller.set(serial, parsed.point);
  };

  const savePlace = (event: FormEvent) => {
    event.preventDefault();
    if (draft === null || placeName === null || placeName.trim() === '') return;
    setPlaces(addSavedPlace(places, { name: placeName, ...draft }));
    setPlaceName(null);
  };

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key !== 'Escape' || event.defaultPrevented) return;
    event.preventDefault();
    // The place name field closes first.
    if (placeName !== null) setPlaceName(null);
    else onClose();
  };

  const note = controller.error ?? controller.blocker;
  return (
    <section
      id={panelId}
      className="loc-panel"
      role="dialog"
      aria-labelledby={`${id}-title`}
      onKeyDown={onKeyDown}
    >
      <header className="loc-head">
        <h3 id={`${id}-title`} className="loc-title">
          Location
        </h3>
        <span className="loc-kind" data-kind={kind}>
          {kind === 'emulator' ? 'GPS' : 'Mock'}
        </span>
        <button type="button" className="btn btn--icon loc-close" onClick={onClose} aria-label="Close">
          <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
            <path d="m2 2 6 6m0-6-6 6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
        </button>
      </header>

      <LocationMap draft={draft} active={active} onPick={pick} focusSeq={focusSeq} label={label} />

      <form className="loc-form" onSubmit={submit} noValidate>
        <label className="loc-label" htmlFor={`${id}-input`}>
          Coordinates or a Google Maps link
        </label>
        <div className="loc-row">
          <input
            ref={inputRef}
            id={`${id}-input`}
            className="loc-input"
            value={text}
            onChange={(event) => changeText(event.target.value)}
            placeholder="-6.1754, 106.8272"
            spellCheck={false}
            autoComplete="off"
            aria-invalid={inputError !== null || undefined}
            aria-describedby={inputError === null ? undefined : `${id}-input-error`}
          />
          <button
            type="submit"
            className="btn btn--primary loc-set"
            disabled={!canChange || text.trim() === ''}
          >
            {isPending ? 'Setting…' : isDraftActive ? 'Set again' : 'Set location'}
          </button>
        </div>
        {inputError !== null && (
          <p id={`${id}-input-error`} className="loc-error" role="alert">
            {inputError}
          </p>
        )}
      </form>

      <div className="loc-status" role="status" data-state={active ? 'set' : 'real'}>
        {active === null ? (
          <p className="loc-status-line">
            <span className="loc-dot" aria-hidden="true" />
            {kind === 'emulator'
              ? 'Not changed by Lionscope.'
              : 'Real location: not changed by Lionscope. Needs Android 12+.'}
          </p>
        ) : (
          <>
            <p className="loc-status-line">
              <span className="loc-dot" aria-hidden="true" />
              <span>
                Set to <span className="loc-coords">{formatLatLng(active)}</span> at {clockTime(active.since)}
              </span>
              <button
                type="button"
                className="btn loc-reset"
                disabled={!canChange}
                onClick={() => controller.clear(serial)}
                title={
                  kind === 'emulator'
                    ? 'Back to the GPS fix from before'
                    : 'Give the device its real location back'
                }
              >
                Reset
              </button>
            </p>
            <p className="loc-meta">{METHOD_TEXT[active.method]}</p>
            {active.warning !== null && <p className="loc-warning">{active.warning}</p>}
          </>
        )}
        {note !== null && <p className="loc-error">{note}</p>}
        {/* A phone Lionscope can't change (another server holds it, a set failed halfway): Reset restores it anyway. */}
        {active === null && kind === 'device' && controller.error !== null && (
          <button
            type="button"
            className="btn loc-reset loc-reset--force"
            disabled={!canChange}
            onClick={() => controller.clear(serial)}
          >
            Reset the device’s location
          </button>
        )}
      </div>

      <div className="loc-places">
        <div className="loc-places-head">
          <h4 className="overline">Saved places</h4>
          {placeName === null && (
            <button
              type="button"
              className="btn loc-save"
              disabled={draft === null}
              onClick={() => setPlaceName('')}
            >
              Save this point
            </button>
          )}
        </div>
        {placeName !== null && (
          <form className="loc-row" onSubmit={savePlace}>
            <input
              className="loc-input"
              value={placeName}
              onChange={(event) => setPlaceName(event.target.value)}
              maxLength={MAX_PLACE_NAME_CHARS}
              placeholder="Name, e.g. Office"
              aria-label="Place name"
              autoFocus
            />
            <button type="submit" className="btn" disabled={placeName.trim() === ''}>
              Save
            </button>
          </form>
        )}
        {places.length === 0 ? (
          <p className="loc-meta">Places you save are kept in this browser.</p>
        ) : (
          <ul className="loc-place-list">
            {places.map((place) => (
              <li key={place.name} className="loc-place" data-current={sameLatLng(place, draft) || undefined}>
                <button type="button" className="loc-place-pick" onClick={() => choose(place)}>
                  <span className="loc-place-name">{place.name}</span>
                  <span className="loc-coords">{formatLatLng(place)}</span>
                </button>
                <button
                  type="button"
                  className="btn btn--icon loc-place-remove"
                  aria-label={`Remove ${place.name}`}
                  title="Remove"
                  onClick={() => setPlaces(removeSavedPlace(places, place.name))}
                >
                  <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
                    <path
                      d="m2 2 6 6m0-6-6 6"
                      stroke="currentColor"
                      strokeWidth="1.5"
                      strokeLinecap="round"
                    />
                  </svg>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
