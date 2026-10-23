/**
 * Live view edits (0.8.0): pure helpers for the Inspector's editors — a node's current value of a property, the
 * parsing of what the user typed, and the words for an edit's failure.
 */
import {
  MAX_EDIT_ELEVATION_PX,
  MAX_EDIT_MARGIN_PX,
  MAX_EDIT_PADDING_PX,
  MAX_EDIT_SIZE_PX,
  MAX_EDIT_TEXT_CHARS,
  MAX_EDIT_TRANSLATION_PX,
  MAX_EDIT_TEXT_SIZE_SP,
  MAX_LIVE_EDITS,
  MIN_EDIT_TEXT_SIZE_SP,
  normalizeColor,
  normalizeViewValue,
  VIEW_PROPERTY_GROUPS,
  type InspectorNode,
  type ViewEditError,
  type ViewProperty,
  type ViewPropertyGroup,
  type ViewPropertyValue,
} from '@lionscope/protocol/wire';

const SIDES = { Left: 0, Top: 1, Right: 2, Bottom: 3 } as const;

/** The value `node` has for `property` in its snapshot, as the wire carries it; null when unknown. */
export function currentValue(node: InspectorNode, property: ViewProperty): ViewPropertyValue | null {
  const view = node.view;
  switch (property) {
    case 'visibility':
      return node.visibility;
    case 'alpha':
      return node.alpha;
    case 'enabled':
      return node.enabled;
    case 'paddingLeft':
    case 'paddingTop':
    case 'paddingRight':
    case 'paddingBottom':
      return node.padding?.[SIDES[property.slice('padding'.length) as keyof typeof SIDES]] ?? null;
    case 'marginLeft':
    case 'marginTop':
    case 'marginRight':
    case 'marginBottom':
      return node.margin?.[SIDES[property.slice('margin'.length) as keyof typeof SIDES]] ?? null;
    case 'layoutWidth':
      return node.layoutWidth;
    case 'layoutHeight':
      return node.layoutHeight;
    case 'translationX':
    case 'translationY':
    case 'elevation':
    case 'backgroundColor':
    case 'textSize':
    case 'textColor':
      return view?.[property] ?? null;
    case 'text':
      return node.text;
  }
}

/** Already in effect: sending it would change nothing (a layout size and a color compare normalized). */
export function isCurrentValue(
  node: InspectorNode,
  property: ViewProperty,
  value: ViewPropertyValue,
): boolean {
  const current = currentValue(node, property);
  if (current === null) return false;
  return normalizeViewValue(property, current) === normalizeViewValue(property, value);
}

/** Whether `name` (a property, a padding / margin group, or every property) covers `property`. */
export function covers(name: ViewProperty | ViewPropertyGroup | null, property: ViewProperty): boolean {
  if (name === null || name === property) return true;
  return (
    name in VIEW_PROPERTY_GROUPS &&
    (VIEW_PROPERTY_GROUPS[name as ViewPropertyGroup] as readonly string[]).includes(property)
  );
}

export type Parsed = { ok: true; value: ViewPropertyValue } | { ok: false; error: string };

const fail = (error: string): Parsed => ({ ok: false, error });

function numberIn(text: string, min: number, max: number, isInteger: boolean, error: string): Parsed {
  const trimmed = text.trim();
  const value = Number(trimmed);
  if (trimmed === '' || !Number.isFinite(value) || value < min || value > max) return fail(error);
  if (isInteger && !Number.isInteger(value)) return fail(error);
  return { ok: true, value };
}

function minus(n: number): string {
  return `−${n}`;
}

/** What the user typed into a text editor of `property`, as a wire value, or why it is not one. */
export function parseDraft(property: ViewProperty, text: string): Parsed {
  switch (property) {
    case 'alpha':
      return numberIn(text, 0, 1, false, 'A number from 0 to 1.');
    case 'paddingLeft':
    case 'paddingTop':
    case 'paddingRight':
    case 'paddingBottom':
      return numberIn(text, 0, MAX_EDIT_PADDING_PX, true, `Whole px from 0 to ${MAX_EDIT_PADDING_PX}.`);
    case 'marginLeft':
    case 'marginTop':
    case 'marginRight':
    case 'marginBottom':
      return numberIn(
        text,
        -MAX_EDIT_MARGIN_PX,
        MAX_EDIT_MARGIN_PX,
        true,
        `Whole px from ${minus(MAX_EDIT_MARGIN_PX)} to ${MAX_EDIT_MARGIN_PX}.`,
      );
    case 'layoutWidth':
    case 'layoutHeight':
      return numberIn(text, 0, MAX_EDIT_SIZE_PX, true, `Whole px from 0 to ${MAX_EDIT_SIZE_PX}.`);
    case 'translationX':
    case 'translationY':
      return numberIn(
        text,
        -MAX_EDIT_TRANSLATION_PX,
        MAX_EDIT_TRANSLATION_PX,
        false,
        `px from ${minus(MAX_EDIT_TRANSLATION_PX)} to ${MAX_EDIT_TRANSLATION_PX}.`,
      );
    case 'elevation':
      return numberIn(text, 0, MAX_EDIT_ELEVATION_PX, false, `px from 0 to ${MAX_EDIT_ELEVATION_PX}.`);
    case 'textSize':
      return numberIn(
        text,
        MIN_EDIT_TEXT_SIZE_SP,
        MAX_EDIT_TEXT_SIZE_SP,
        false,
        `sp from ${MIN_EDIT_TEXT_SIZE_SP} to ${MAX_EDIT_TEXT_SIZE_SP}.`,
      );
    case 'backgroundColor':
    case 'textColor': {
      const trimmed = text.trim();
      const color = normalizeColor(trimmed.startsWith('#') ? trimmed : `#${trimmed}`);
      return color === null ? fail('A color as #RRGGBB or #AARRGGBB.') : { ok: true, value: color };
    }
    case 'text':
      return normalizeViewValue('text', text) === null
        ? fail(`At most ${MAX_EDIT_TEXT_CHARS} characters, no control characters.`)
        : { ok: true, value: text };
    case 'visibility':
    case 'enabled':
      // Picked from a control, never typed.
      return normalizeViewValue(property, text) === null
        ? fail('Not a valid value.')
        : { ok: true, value: text };
  }
}

/** `#AARRGGBB` as CSS `#RRGGBBAA`, for a swatch; null when it is not a color. */
export function cssColor(text: string): string | null {
  const argb = normalizeColor(text.trim().startsWith('#') ? text.trim() : `#${text.trim()}`);
  return argb === null ? null : `#${argb.slice(3)}${argb.slice(1, 3)}`;
}

/** A number the way the editors show it: no float noise (0.30000000000000004 → 0.3). */
export function formatNumber(value: number | null): string {
  return value === null ? '' : String(Number(value.toFixed(3)));
}

const EDIT_ERRORS: Record<ViewEditError, string> = {
  stale: 'The view changed since this snapshot: inspect again.',
  not_editable: 'This property cannot be edited on this view.',
  password: 'The text of a password field is never edited.',
  invalid_value: 'The app does not take this value.',
  old_sdk: 'The app’s Lionscope SDK is older than 0.8.0: update it to edit views live.',
  no_link: 'The app’s SDK is no longer connected: inspect again.',
  rate_limited: 'Too many edits at once: wait a moment and try again.',
  limit: `${MAX_LIVE_EDITS} live edits are in effect: revert some first.`,
  timeout: 'The app did not answer in time.',
  failed: 'The app could not apply it.',
};

/** The server's message, else words for its error code. */
export function editErrorMessage(error: ViewEditError | undefined, message: string | undefined): string {
  if (message !== undefined && message.trim() !== '') return message;
  return (error === undefined ? undefined : EDIT_ERRORS[error]) ?? EDIT_ERRORS.failed;
}

export function liveEditsLabel(count: number): string {
  return count === 1 ? '1 live edit (temporary)' : `${count} live edits (temporary)`;
}

const PROPERTY_WORDS: Record<ViewProperty | ViewPropertyGroup, string> = {
  visibility: 'visibility',
  alpha: 'alpha',
  enabled: 'enabled',
  paddingLeft: 'padding left',
  paddingTop: 'padding top',
  paddingRight: 'padding right',
  paddingBottom: 'padding bottom',
  marginLeft: 'margin left',
  marginTop: 'margin top',
  marginRight: 'margin right',
  marginBottom: 'margin bottom',
  layoutWidth: 'width',
  layoutHeight: 'height',
  translationX: 'translation X',
  translationY: 'translation Y',
  elevation: 'elevation',
  backgroundColor: 'background color',
  text: 'text',
  textSize: 'text size',
  textColor: 'text color',
  padding: 'padding',
  margin: 'margins',
};

/** A property (or a padding / margin group) in words, for labels: `layoutWidth` → `width`. */
export function propertyWords(name: ViewProperty | ViewPropertyGroup): string {
  return PROPERTY_WORDS[name];
}
