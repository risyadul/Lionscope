import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import type { ScreenFpsCap } from '@lionscope/protocol/wire';
import { isValidScreenFpsCap, SCREEN_FPS_CAPS } from '@lionscope/protocol/wire';
import { FPS_CAP_RANGE, isPresetFpsCap, resolveFpsCapInput } from '../../lib/fpsCap.ts';
import { Select } from '../ui/Select.tsx';

const CUSTOM = 'custom';

type Props = {
  value: ScreenFpsCap;
  onChange: (fps: ScreenFpsCap) => void;
  /** Why the cap applied differs from what was typed (or why nothing was), null once that no longer applies. */
  onNote: (note: string | null) => void;
};

/**
 * The emulator's frame rate cap: the presets, the custom cap (current, or the last one while the panel is open),
 * and "Other…", which swaps the select for a number field in its place. Enter or leaving the field applies the number (rounded and clamped into range, with
 * a note when that changed it); Esc cancels.
 */
export function FpsCapPicker({ value, onChange, onNote }: Props) {
  /** The custom field's text while it is open. */
  const [draft, setDraft] = useState<string | null>(null);
  const [isInvalid, setInvalid] = useState(false);
  /** The last custom cap, kept as an option after a preset is picked so switching back is one choice. */
  const [lastCustom, setLastCustom] = useState<ScreenFpsCap | null>(isPresetFpsCap(value) ? null : value);
  const wrapRef = useRef<HTMLSpanElement>(null);
  /** Whether the field is open: Enter closes it before its blur arrives, which must not apply it again. */
  const isEditing = useRef(false);
  /** Focus goes back to the select once the field is closed from the keyboard. */
  const refocusSelect = useRef(false);
  const isOpen = draft !== null;

  useEffect(() => {
    if (isOpen) {
      const input = wrapRef.current?.querySelector('input');
      input?.focus();
      input?.select();
    } else if (refocusSelect.current) {
      refocusSelect.current = false;
      wrapRef.current?.querySelector('select')?.focus();
    }
  }, [isOpen]);

  const close = (fromKeyboard: boolean) => {
    isEditing.current = false;
    refocusSelect.current = fromKeyboard;
    setDraft(null);
    setInvalid(false);
  };

  const apply = (fromKeyboard: boolean) => {
    if (!isEditing.current || draft === null) return;
    const result = resolveFpsCapInput(draft);
    onNote(result.note);
    if (result.fps === null) {
      // Enter: stay to fix it. Leaving the field: the cap stays what it was.
      if (fromKeyboard) setInvalid(true);
      else close(false);
      return;
    }
    if (!isPresetFpsCap(result.fps)) setLastCustom(result.fps);
    if (result.fps !== value) onChange(result.fps);
    close(fromKeyboard);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      apply(true);
    } else if (event.key === 'Escape') {
      // Cancels this field only (not the device drawer, not inspect mode).
      event.preventDefault();
      event.stopPropagation();
      onNote(null);
      close(true);
    }
  };

  if (isOpen) {
    return (
      <span ref={wrapRef} className="device-fps-cap device-fps-cap--custom">
        <input
          className="mono"
          type="text"
          inputMode="numeric"
          autoComplete="off"
          spellCheck={false}
          maxLength={6}
          aria-label="Custom frame rate cap"
          aria-invalid={isInvalid || undefined}
          title={`Frames per second, ${FPS_CAP_RANGE}: Enter or leave the field to apply, Esc cancels`}
          value={draft}
          onChange={(event) => {
            setDraft(event.target.value);
            setInvalid(false);
          }}
          onKeyDown={onKeyDown}
          onBlur={() => apply(false)}
        />
        <span className="device-fps-unit" aria-hidden="true">
          fps
        </span>
      </span>
    );
  }

  const custom = isPresetFpsCap(value) ? lastCustom : value;
  const caps = custom === null ? SCREEN_FPS_CAPS : [...SCREEN_FPS_CAPS, custom].sort((a, b) => a - b);
  return (
    <span ref={wrapRef} className="device-fps-cap">
      <Select
        aria-label="Frame rate cap"
        title="The most frames per second the emulator streams (fewer: less CPU)"
        value={String(value)}
        onChange={(event) => {
          if (event.target.value === CUSTOM) {
            isEditing.current = true;
            onNote(null);
            setDraft(String(value));
            return;
          }
          const fps = Number(event.target.value);
          if (!isValidScreenFpsCap(fps)) return;
          onNote(null);
          onChange(fps);
        }}
      >
        {caps.map((fps) => (
          <option key={fps} value={fps}>
            ≤{fps} fps
          </option>
        ))}
        {/* Not "Custom…": wider than the presets, it would push the select into the nav keys at narrow columns. */}
        <option value={CUSTOM}>Other…</option>
      </Select>
    </span>
  );
}
