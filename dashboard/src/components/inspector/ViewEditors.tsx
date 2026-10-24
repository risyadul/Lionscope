import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ChangeEvent,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
} from 'react';
import type { InspectorNode, ViewProperty, ViewPropertyGroup } from '@lionscope/protocol/wire';
import type { EditName, EditStatus, ViewEdits } from '../../hooks/useViewEdits.ts';
import { rectSize } from '../../lib/inspector.ts';
import {
  cssColor,
  currentValue,
  formatNumber,
  parseDraft,
  propertyWords,
  SLIDER_IDLE_MS,
} from '../../lib/viewEdits.ts';
import { Segmented, type SegmentedOption } from '../ui/Segmented.tsx';
import { ColorPicker } from './ColorPicker.tsx';
import './editors.css';

export { SLIDER_IDLE_MS } from '../../lib/viewEdits.ts';

/** What every editor of one view gets: the controller, the node and the snapshot its drafts belong to. */
export interface EditorProps {
  edits: ViewEdits;
  node: InspectorNode;
  /** The snapshot id: a committed draft gives way to the next snapshot's value. */
  resetKey: string;
}

type CommitOutcome = 'keep' | 'reset';

/** Parses and sends a typed value; a value that changes nothing drops the draft. */
function commitTyped(
  edits: ViewEdits,
  node: InspectorNode,
  property: ViewProperty,
  text: string,
): CommitOutcome {
  const parsed = parseDraft(property, text);
  if (!parsed.ok) {
    edits.reject(node.id, property, parsed.error);
    return 'keep';
  }
  return edits.edit(node.id, property, parsed.value) === 'unchanged' ? 'reset' : 'keep';
}

/** One Escape cancels the editor it was pressed in, nothing else (not inspect mode, not the device drawer). */
function swallowEscape(event: KeyboardEvent) {
  if (event.key !== 'Escape') return;
  event.preventDefault();
  event.stopPropagation();
}

/** A value of the snapshot shown until React state from the user replaces it; resets with every snapshot. */
function useResettable<T>(resetKey: string): [T | null, (value: T | null) => void] {
  const [state, setState] = useState<{ key: string; value: T | null }>({ key: resetKey, value: null });
  if (state.key !== resetKey) setState({ key: resetKey, value: null });
  const value = state.key === resetKey ? state.value : null;
  return [value, (next) => setState({ key: resetKey, value: next })];
}

type DraftInputProps = {
  id?: string;
  value: string;
  resetKey: string;
  label: string;
  onCommit: (text: string) => CommitOutcome;
  onCancel: () => void;
  /** Drawn before the field from the text it shows (a color swatch). */
  before?: (shown: string) => ReactNode;
  multiline?: boolean;
  inputMode?: 'numeric' | 'decimal';
  placeholder?: string;
  className?: string;
  disabled: boolean;
  isInvalid: boolean;
  isBusy: boolean;
  /** Id of the error shown for this field, while there is one. */
  describedBy?: string;
};

/**
 * A text field over a snapshot value. Enter (Ctrl/⌘+Enter in a multi-line one) or leaving it commits, Escape
 * restores the snapshot's value. A committed draft stays until the next snapshot shows the result.
 */
function DraftInput({
  id,
  value,
  resetKey,
  label,
  onCommit,
  onCancel,
  before,
  multiline = false,
  inputMode,
  placeholder,
  className = 'attr-input mono',
  disabled,
  isInvalid,
  isBusy,
  describedBy,
}: DraftInputProps) {
  // `isCommitted`: sent already, so Enter and then leaving the field send it once.
  const [draft, setDraft] = useState<{ text: string; isCommitted: boolean } | null>(null);
  const [seenKey, setSeenKey] = useState(resetKey);
  if (seenKey !== resetKey) {
    setSeenKey(resetKey);
    // A new snapshot replaces what was sent; text still being typed stays.
    if (draft?.isCommitted === true) setDraft(null);
  }

  const commit = () => {
    if (draft === null || draft.isCommitted) return;
    if (draft.text === value) {
      setDraft(null);
      return;
    }
    setDraft(onCommit(draft.text) === 'reset' ? null : { text: draft.text, isCommitted: true });
  };
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    if (event.key === 'Escape') {
      // Nothing to cancel: Esc goes on (it leaves inspect mode).
      if (draft === null && !isInvalid) return;
      swallowEscape(event);
      setDraft(null);
      onCancel();
    } else if (event.key === 'Enter' && (!multiline || event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      commit();
    }
  };
  const shown = draft?.text ?? value;
  const common = {
    id,
    className,
    value: shown,
    'aria-label': label,
    'aria-invalid': isInvalid || undefined,
    'aria-busy': isBusy || undefined,
    'aria-describedby': describedBy,
    disabled,
    placeholder,
    spellCheck: false,
    onKeyDown,
    onBlur: commit,
    onChange: (event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
      setDraft({ text: event.target.value, isCommitted: false }),
  };
  return (
    <>
      {before?.(shown)}
      {multiline ? (
        <textarea {...common} rows={3} title="Ctrl+Enter or leave the field to apply; Esc cancels" />
      ) : (
        <input {...common} type="text" inputMode={inputMode} autoComplete="off" />
      )}
    </>
  );
}

function errorOf(status: EditStatus): string | null {
  return status.kind === 'error' ? status.message : null;
}

/** The field a revert button belongs to: focus goes there, as the button itself goes away once reverted. */
const FIELDS = 'input, textarea, [role="radio"][tabindex="0"], [role="switch"]';

/** Moves focus from a button that is about to disappear to the first of `selector` around it (or in `scope`). */
export function keepFocusNear(event: MouseEvent<HTMLElement>, scope: string, selector = FIELDS): void {
  event.currentTarget.closest(scope)?.querySelector<HTMLElement>(selector)?.focus();
}

/** "edited" and a Revert button, for a property (or group) changed live and still in effect. */
export function EditedMark({ edits, node, name }: { edits: ViewEdits; node: InspectorNode; name: EditName }) {
  const words = propertyWords(name);
  const isBusy = edits.status(node.id, name).kind === 'applying';
  // A box-model group's fields are named after it ("Padding top").
  const field =
    name === 'padding' || name === 'margin'
      ? `input[aria-label^="${name === 'padding' ? 'Padding' : 'Margin'}"]`
      : FIELDS;
  return (
    <span className="attr-edited-wrap">
      <span className="attr-edited" title="Changed live from the Inspector: lasts until reverted">
        edited
      </span>
      <button
        type="button"
        className="attr-revert"
        aria-label={`Revert ${words}`}
        title={`Back to the app’s own ${words}`}
        disabled={!edits.canEdit || isBusy}
        onClick={(event) => {
          keepFocusNear(event, '.attr-row, .attr-box-edit, .attr-switch-wrap', field);
          edits.revert(node.id, name);
        }}
      >
        Revert
      </button>
    </span>
  );
}

/**
 * A row of an editable property: its label, the editor, the applying state, the edited mark and any error. `children`
 * gets the id of the error while there is one, for its control's aria-describedby.
 */
export function EditRow({
  name,
  htmlFor,
  status,
  edited,
  children,
  below,
}: {
  name: string;
  htmlFor?: string;
  status: EditStatus;
  /** The mark and Revert, when the property is edited. */
  edited: ReactNode;
  children: (describedBy: string | undefined) => ReactNode;
  /** Under the field and its error (the color picker). */
  below?: ReactNode;
}) {
  const errorId = useId();
  const error = errorOf(status);
  const isBusy = status.kind === 'applying';
  return (
    <div className="attr-row" data-editable="true">
      <dt>{htmlFor === undefined ? name : <label htmlFor={htmlFor}>{name}</label>}</dt>
      <dd>
        <div className="attr-edit" data-applying={isBusy || undefined} aria-busy={isBusy || undefined}>
          {children(error === null ? undefined : errorId)}
          {isBusy && <span className="banner-spinner attr-spinner" aria-hidden="true" />}
          {/* Always there, so a screen reader hears it change. */}
          <span className="sr-only" role="status">
            {isBusy ? `Applying ${name.toLowerCase()}` : ''}
          </span>
          {edited}
        </div>
        {error !== null && (
          <p id={errorId} className="attr-error" role="alert">
            {error}
          </p>
        )}
        {below}
      </dd>
    </div>
  );
}

function isEdited(node: InspectorNode, name: EditName): boolean {
  const edited = node.view?.edited ?? [];
  if (name === 'padding' || name === 'margin') return edited.some((p) => p.startsWith(name));
  return edited.includes(name);
}

function editedMark(edits: ViewEdits, node: InspectorNode, name: EditName): ReactNode {
  return isEdited(node, name) ? <EditedMark edits={edits} node={node} name={name} /> : null;
}

/** A number or text property typed into one field (`unit` after it). */
export function TypedRow({
  edits,
  node,
  resetKey,
  property,
  name,
  unit,
}: EditorProps & { property: ViewProperty; name: string; unit?: string }) {
  const id = useId();
  const status = edits.status(node.id, property);
  const value = currentValue(node, property);
  // A text size read in sp is rarely round (18sp is 47 px at 2.625x: 17.905 sp): one decimal is what matters.
  const shown = typeof value === 'number' && property === 'textSize' ? Math.round(value * 10) / 10 : value;
  const text = typeof shown === 'number' ? formatNumber(shown) : String(shown ?? '');
  const isText = property === 'text';
  return (
    <EditRow name={name} htmlFor={id} status={status} edited={editedMark(edits, node, property)}>
      {(describedBy) => (
        <>
          <DraftInput
            id={id}
            value={text}
            resetKey={resetKey}
            label={propertyWords(property)}
            onCommit={(draft) => commitTyped(edits, node, property, draft)}
            onCancel={() => edits.dismiss(node.id, property)}
            multiline={isText && text.includes('\n')}
            inputMode={property === 'textSize' || property === 'elevation' ? 'decimal' : undefined}
            className={isText ? 'attr-input attr-input--text' : 'attr-input mono'}
            disabled={!edits.canEdit}
            isInvalid={status.kind === 'error'}
            isBusy={status.kind === 'applying'}
            describedBy={describedBy}
          />
          {unit !== undefined && <span className="attr-unit">{unit}</span>}
        </>
      )}
    </EditRow>
  );
}

/**
 * A hex field, and a swatch (checkered behind, so alpha shows) that opens the color picker under it; null = not a
 * single color.
 */
export function ColorRow({
  edits,
  node,
  resetKey,
  property,
  name,
  screen = [],
}: EditorProps & {
  property: 'backgroundColor' | 'textColor';
  name: string;
  /** The snapshot's colors, offered as swatches by the picker. */
  screen?: readonly string[];
}) {
  const id = useId();
  const pickerId = useId();
  const [isOpen, setIsOpen] = useState(false);
  const [preview, setPreview] = useState<string | null>(null);
  const swatchRef = useRef<HTMLButtonElement>(null);
  const status = edits.status(node.id, property);
  // The picker's color until it is applied or given up (the picker clears it then).
  const value = currentValue(node, property);
  const color = typeof value === 'string' ? value : null;
  const words = propertyWords(property);
  const swatch = (shown: string) => {
    // The color being picked, else the typed one once it is one, else the app's.
    const css =
      (preview === null ? null : cssColor(preview)) ??
      cssColor(shown) ??
      (color === null ? null : cssColor(color));
    return (
      <button
        ref={swatchRef}
        type="button"
        className="attr-swatch"
        data-none={css === null || undefined}
        aria-expanded={isOpen}
        aria-controls={isOpen ? pickerId : undefined}
        aria-label={`${isOpen ? 'Close' : 'Open'} the ${words} picker`}
        title={
          color === null
            ? 'Not a single color (none, an image or a shape): pick one'
            : `${color}: pick a color`
        }
        // An open picker can always be closed, also while the screen is out of date.
        disabled={!edits.canEdit && !isOpen}
        onClick={() => setIsOpen(!isOpen)}
      >
        {css !== null && <span style={{ backgroundColor: css }} />}
      </button>
    );
  };
  return (
    <EditRow
      name={name}
      htmlFor={id}
      status={status}
      edited={editedMark(edits, node, property)}
      below={
        isOpen && (
          <ColorPicker
            id={pickerId}
            value={color}
            status={status.kind}
            notice={edits.notice}
            label={words}
            screen={screen}
            disabled={!edits.canEdit}
            onPreview={setPreview}
            onCommit={(argb) => edits.edit(node.id, property, argb)}
            onClose={() => {
              swatchRef.current?.focus();
              setIsOpen(false);
            }}
          />
        )
      }
    >
      {(describedBy) => (
        <DraftInput
          id={id}
          value={color ?? ''}
          resetKey={resetKey}
          label={words}
          onCommit={(draft) => commitTyped(edits, node, property, draft)}
          onCancel={() => edits.dismiss(node.id, property)}
          before={swatch}
          placeholder={color === null ? 'not a solid color' : '#AARRGGBB'}
          className="attr-input attr-input--color mono"
          disabled={!edits.canEdit}
          isInvalid={status.kind === 'error'}
          isBusy={status.kind === 'applying'}
          describedBy={describedBy}
        />
      )}
    </EditRow>
  );
}

const VISIBILITY: readonly SegmentedOption<'visible' | 'invisible' | 'gone'>[] = [
  { value: 'visible', label: 'visible' },
  { value: 'invisible', label: 'invisible', title: 'Hidden, still takes its space' },
  { value: 'gone', label: 'gone', title: 'Hidden and takes no space' },
];

export function VisibilityRow({ edits, node, resetKey }: EditorProps) {
  const [chosen, setChosen] = useResettable<InspectorNode['visibility']>(resetKey);
  const status = edits.status(node.id, 'visibility');
  // The pick shows while it is applied; a failure falls back to what the app has.
  const value = status.kind === 'applying' && chosen !== null ? chosen : node.visibility;
  return (
    <EditRow name="Visibility" status={status} edited={editedMark(edits, node, 'visibility')}>
      {(describedBy) => (
        <Segmented
          className="attr-segmented"
          options={VISIBILITY}
          value={value}
          label="Visibility"
          disabled={!edits.canEdit}
          describedBy={describedBy}
          ignoreRepeat
          onChange={(next) => {
            if (edits.edit(node.id, 'visibility', next) === 'sent') setChosen(next);
          }}
        />
      )}
    </EditRow>
  );
}

/** A slider and a number: the slider sends on release or when it rests, the number on Enter or leaving it. */
export function AlphaRow({ edits, node, resetKey }: EditorProps) {
  const id = useId();
  const [slide, setSlide] = useResettable<{ value: number }>(resetKey);
  // Read by the idle timer and the release, which may run after a new snapshot renewed the node (and its id), and
  // before React re-renders: the release after the slider rested must not send the same value again.
  const nodeRef = useRef(node);
  const isSent = useRef(true);
  useLayoutEffect(() => {
    nodeRef.current = node;
  });
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const status = edits.status(node.id, 'alpha');
  const shown = slide?.value ?? node.alpha ?? 1;

  const cancelTimer = () => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
  };
  useEffect(() => {
    const pending = timer;
    return () => {
      if (pending.current !== null) clearTimeout(pending.current);
    };
  }, []);

  const send = (value: number) => {
    cancelTimer();
    isSent.current = true;
    edits.edit(nodeRef.current.id, 'alpha', value);
    setSlide({ value });
  };
  const release = () => {
    if (slide !== null && !isSent.current) send(slide.value);
  };
  return (
    <EditRow name="Alpha" htmlFor={id} status={status} edited={editedMark(edits, node, 'alpha')}>
      {(describedBy) => (
        <>
          <input
            id={id}
            className="attr-range"
            type="range"
            min={0}
            max={1}
            step={0.01}
            value={shown}
            aria-label="alpha"
            aria-valuetext={formatNumber(shown)}
            aria-describedby={describedBy}
            disabled={!edits.canEdit}
            onChange={(event) => {
              const value = Number(event.target.value);
              isSent.current = false;
              setSlide({ value });
              cancelTimer();
              timer.current = setTimeout(() => send(value), SLIDER_IDLE_MS);
            }}
            onPointerUp={release}
            onKeyUp={release}
            onBlur={release}
            onKeyDown={(event) => {
              // Only a drag not sent yet is cancelled.
              if (event.key !== 'Escape' || slide === null || isSent.current) return;
              swallowEscape(event);
              cancelTimer();
              isSent.current = true;
              setSlide(null);
              edits.dismiss(node.id, 'alpha');
            }}
          />
          <DraftInput
            value={formatNumber(shown)}
            resetKey={resetKey}
            label="alpha value"
            onCommit={(draft) => {
              const outcome = commitTyped(edits, node, 'alpha', draft);
              const parsed = parseDraft('alpha', draft);
              if (outcome === 'keep' && parsed.ok && typeof parsed.value === 'number') {
                isSent.current = true;
                setSlide({ value: parsed.value });
              }
              return outcome;
            }}
            onCancel={() => {
              setSlide(null);
              edits.dismiss(node.id, 'alpha');
            }}
            inputMode="decimal"
            className="attr-input attr-input--short mono"
            disabled={!edits.canEdit}
            isInvalid={status.kind === 'error'}
            isBusy={status.kind === 'applying'}
            describedBy={describedBy}
          />
        </>
      )}
    </EditRow>
  );
}

/** `enabled` as a switch, with the read-only flags after it; `describedBy`: its error's id while there is one. */
export function EnabledSwitch({
  edits,
  node,
  resetKey,
  describedBy,
}: EditorProps & { describedBy?: string }) {
  const [chosen, setChosen] = useResettable<boolean>(resetKey);
  const status = edits.status(node.id, 'enabled');
  const isOn = status.kind === 'applying' && chosen !== null ? chosen : node.enabled === true;
  return (
    <span className="attr-switch-wrap" data-applying={status.kind === 'applying' || undefined}>
      <button
        type="button"
        role="switch"
        className="attr-switch"
        aria-checked={isOn}
        aria-busy={status.kind === 'applying' || undefined}
        aria-describedby={describedBy}
        disabled={!edits.canEdit}
        onClick={() => {
          if (edits.edit(node.id, 'enabled', !isOn) === 'sent') setChosen(!isOn);
        }}
      >
        <span className="attr-switch-track" aria-hidden="true" />
        enabled
      </button>
      {editedMark(edits, node, 'enabled')}
    </span>
  );
}

type SizeMode = 'match_parent' | 'wrap_content' | 'px';

const SIZE_MODES: readonly SegmentedOption<SizeMode>[] = [
  { value: 'match_parent', label: 'match', title: 'match_parent' },
  { value: 'wrap_content', label: 'wrap', title: 'wrap_content' },
  { value: 'px', label: 'px', title: 'A fixed size in px' },
];

function sizeMode(value: string | null): SizeMode {
  return value === 'match_parent' || value === 'wrap_content' ? value : 'px';
}

/** match_parent / wrap_content / a fixed px size; picking px fixes the view at its measured size. */
export function LayoutSizeRow({
  edits,
  node,
  resetKey,
  property,
}: EditorProps & { property: 'layoutWidth' | 'layoutHeight' }) {
  const id = useId();
  const [chosen, setChosen] = useResettable<SizeMode>(resetKey);
  const status = edits.status(node.id, property);
  const current = property === 'layoutWidth' ? node.layoutWidth : node.layoutHeight;
  const mode = status.kind === 'applying' && chosen !== null ? chosen : sizeMode(current);
  const measured = rectSize(node.bounds)[property === 'layoutWidth' ? 'width' : 'height'];
  const px = current !== null && sizeMode(current) === 'px' ? current.replace(/px$/, '') : String(measured);
  const name = property === 'layoutWidth' ? 'Width' : 'Height';
  return (
    <EditRow
      name={name}
      htmlFor={mode === 'px' ? id : undefined}
      status={status}
      edited={editedMark(edits, node, property)}
    >
      {(describedBy) => (
        <>
          <Segmented
            className="attr-segmented"
            options={SIZE_MODES}
            value={mode}
            label={`Layout ${propertyWords(property)}`}
            disabled={!edits.canEdit}
            describedBy={describedBy}
            ignoreRepeat
            onChange={(next) => {
              if (next === mode) return;
              const value = next === 'px' ? measured : next;
              if (edits.edit(node.id, property, value) === 'sent') setChosen(next);
            }}
          />
          {mode === 'px' && (
            <>
              <DraftInput
                id={id}
                value={px}
                resetKey={resetKey}
                label={`${propertyWords(property)} in px`}
                onCommit={(draft) => commitTyped(edits, node, property, draft)}
                onCancel={() => edits.dismiss(node.id, property)}
                inputMode="numeric"
                className="attr-input attr-input--short mono"
                disabled={!edits.canEdit}
                isInvalid={status.kind === 'error'}
                isBusy={status.kind === 'applying'}
                describedBy={describedBy}
              />
              <span className="attr-unit">px</span>
            </>
          )}
        </>
      )}
    </EditRow>
  );
}

const SIDES = ['Top', 'Right', 'Bottom', 'Left'] as const;
const SIDE_ATTR = { Top: 't', Right: 'r', Bottom: 'b', Left: 'l' } as const;

function BoxSides({
  edits,
  node,
  resetKey,
  group,
  isEditable,
  describedBy,
}: EditorProps & {
  group: ViewPropertyGroup;
  isEditable: boolean;
  /** The id of the error shown for a side, while there is one. */
  describedBy: (property: ViewProperty) => string | undefined;
}) {
  return SIDES.map((side) => {
    const property = `${group}${side}` as ViewProperty;
    const value = currentValue(node, property);
    const text = typeof value === 'number' ? String(value) : '0';
    if (!isEditable) {
      return (
        <b key={side} data-side={SIDE_ATTR[side]} className="mono">
          {text}
        </b>
      );
    }
    const status = edits.status(node.id, property);
    return (
      <span key={side} className="attr-box-side" data-side={SIDE_ATTR[side]}>
        <DraftInput
          value={text}
          resetKey={resetKey}
          label={`${group === 'padding' ? 'Padding' : 'Margin'} ${side.toLowerCase()}`}
          onCommit={(draft) => commitTyped(edits, node, property, draft)}
          onCancel={() => edits.dismiss(node.id, property)}
          inputMode={group === 'padding' ? 'numeric' : undefined}
          className="attr-box-input mono"
          disabled={!edits.canEdit}
          isInvalid={status.kind === 'error'}
          isBusy={status.kind === 'applying'}
          describedBy={describedBy(property)}
        />
      </span>
    );
  });
}

/** The box model with each side of padding (and of margins, when they can be edited) as a field. */
export function EditableBoxModel({
  edits,
  node,
  resetKey,
  canEditMargin,
}: EditorProps & { canEditMargin: boolean }) {
  const { width, height } = rectSize(node.bounds);
  const baseId = useId();
  const groups: ViewPropertyGroup[] = canEditMargin ? ['margin', 'padding'] : ['padding'];
  const errors = groups.flatMap((group) => {
    const names: EditName[] = [group, ...SIDES.map((side) => `${group}${side}` as ViewProperty)];
    return names.flatMap((name) => {
      const message = errorOf(edits.status(node.id, name));
      return message === null ? [] : [{ name, message }];
    });
  });
  const isBusy = groups.some((group) => edits.status(node.id, group).kind === 'applying');
  const errorId = (name: EditName) => `${baseId}-${name}`;
  // A side's own error, else its group's (a failed revert).
  const describedBy = (property: ViewProperty) => {
    const group = groups.find((candidate) => property.startsWith(candidate));
    const own =
      errors.find((error) => error.name === property) ?? errors.find((error) => error.name === group);
    return own === undefined ? undefined : errorId(own.name);
  };
  return (
    <div className="attr-box-edit">
      <figure
        className="attr-box"
        data-editable="true"
        aria-label="Margin and padding in pixels"
        aria-busy={isBusy || undefined}
      >
        <div className="attr-box-margin">
          <span className="attr-box-name">margin</span>
          <BoxSides
            edits={edits}
            node={node}
            resetKey={resetKey}
            group="margin"
            isEditable={canEditMargin}
            describedBy={describedBy}
          />
          <div className="attr-box-padding">
            <span className="attr-box-name">padding</span>
            <BoxSides
              edits={edits}
              node={node}
              resetKey={resetKey}
              group="padding"
              isEditable
              describedBy={describedBy}
            />
            <div className="attr-box-content mono">
              {width} × {height}
            </div>
          </div>
        </div>
      </figure>
      {groups.some((group) => isEdited(node, group)) && (
        <p className="attr-box-edited">
          {groups.map((group) =>
            isEdited(node, group) ? (
              <span key={group} className="attr-box-edited-group">
                {group === 'padding' ? 'Padding' : 'Margins'}
                <EditedMark edits={edits} node={node} name={group} />
              </span>
            ) : null,
          )}
        </p>
      )}
      {errors.map(({ name, message }) => (
        <p key={name} id={errorId(name)} className="attr-error" role="alert">
          {propertyWords(name)}: {message}
        </p>
      ))}
    </div>
  );
}
