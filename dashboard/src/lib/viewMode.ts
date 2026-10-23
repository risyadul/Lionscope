/**
 * What the workspace shows: the whole profiler, the Layout Inspector beside the device, or the device alone
 * (for watching an AI agent operate it). Kept in the URL (`?view=inspect`, shareable and bookmarkable) and
 * remembered per viewer; the URL wins.
 */

export type ViewMode = 'profile' | 'inspect' | 'device';

export const VIEW_MODES: readonly { id: ViewMode; label: string; description: string }[] = [
  { id: 'profile', label: 'Profiler', description: 'Charts, screens, stalls, layouts and logcat' },
  { id: 'inspect', label: 'Inspector', description: 'The Layout Inspector beside the device' },
  {
    id: 'device',
    label: 'Device',
    description: 'The device screen alone, e.g. while an AI agent operates it',
  },
];

export const DEFAULT_VIEW_MODE: ViewMode = 'profile';
/** The query parameter; the profiler, the default, leaves it out. */
export const VIEW_PARAM = 'view';

export function parseViewMode(raw: string | null): ViewMode | null {
  return VIEW_MODES.some((mode) => mode.id === raw) ? (raw as ViewMode) : null;
}

/** The URL's mode, else the remembered one, else the profiler. */
export function initialViewMode(search: string, stored: string | null): ViewMode {
  return (
    parseViewMode(new URLSearchParams(search).get(VIEW_PARAM)) ?? parseViewMode(stored) ?? DEFAULT_VIEW_MODE
  );
}

/** `search` with the mode set (other parameters kept); the default mode removes the parameter. */
export function searchWithViewMode(search: string, mode: ViewMode): string {
  const params = new URLSearchParams(search);
  if (mode === DEFAULT_VIEW_MODE) params.delete(VIEW_PARAM);
  else params.set(VIEW_PARAM, mode);
  const next = params.toString();
  return next === '' ? '' : `?${next}`;
}
