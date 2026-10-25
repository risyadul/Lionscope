/**
 * The Location panel's text input and saved places: coordinates typed or pasted as `lat, lng`, or a Google Maps,
 * OpenStreetMap or `geo:` link they can be read from (without fetching anything).
 */

export interface LatLng {
  latitude: number;
  longitude: number;
}

export interface SavedPlace extends LatLng {
  name: string;
}

export const MAX_SAVED_PLACES = 50;
export const MAX_PLACE_NAME_CHARS = 60;
/** Shown and sent with 6 decimals: about 0.1 m, finer than any GPS. */
const DECIMALS = 6;

export type ParsedLocation = { ok: true; point: LatLng } | { ok: false; error: string };

export function isValidLatLng({ latitude, longitude }: LatLng): boolean {
  return (
    Number.isFinite(latitude) &&
    Number.isFinite(longitude) &&
    Math.abs(latitude) <= 90 &&
    Math.abs(longitude) <= 180
  );
}

function round(value: number): number {
  return Number(value.toFixed(DECIMALS));
}

/** Both rounded to 6 decimals; -0 becomes 0. */
export function roundLatLng({ latitude, longitude }: LatLng): LatLng {
  return { latitude: round(latitude) || 0, longitude: round(longitude) || 0 };
}

export function formatLatLng(point: LatLng): string {
  const { latitude, longitude } = roundLatLng(point);
  return `${latitude}, ${longitude}`;
}

const NUMBER = String.raw`[-+]?\d{1,3}(?:\.\d+)?`;
/** `-6.2, 106.8`, `-6.2 106.8`, `-6.2;106.8`. */
const PAIR = new RegExp(String.raw`^\s*(${NUMBER})\s*[,; ]\s*(${NUMBER})\s*$`);
/** The pair anywhere in a link: `@-6.2,106.8,15z`, `q=-6.2,106.8`, `ll=`, `geo:`. */
const LINK_PATTERNS = [
  // A place's own position (`!3d<lat>!4d<lng>`) beats the map view (`@`): it is the pin, not the screen centre.
  new RegExp(String.raw`!3d(${NUMBER})!4d(${NUMBER})`),
  new RegExp(String.raw`[?&](?:q|query|ll|center|destination|daddr)=(${NUMBER})(?:,|%2C)\s*(${NUMBER})`, 'i'),
  new RegExp(String.raw`@(${NUMBER}),(${NUMBER})`),
  new RegExp(String.raw`^geo:(${NUMBER}),(${NUMBER})`, 'i'),
  // openstreetmap.org/#map=15/-6.2/106.8
  new RegExp(String.raw`#map=\d{1,2}/(${NUMBER})/(${NUMBER})`),
  new RegExp(String.raw`[?&]mlat=(${NUMBER})&mlon=(${NUMBER})`, 'i'),
];
const SHORT_LINK = /^https?:\/\/(?:maps\.app\.goo\.gl|goo\.gl\/maps)\//i;

function point(latitude: string | undefined, longitude: string | undefined): ParsedLocation {
  const parsed = { latitude: Number(latitude), longitude: Number(longitude) };
  if (!isValidLatLng(parsed)) {
    return { ok: false, error: 'Latitude goes from -90 to 90 and longitude from -180 to 180.' };
  }
  return { ok: true, point: roundLatLng(parsed) };
}

/** Read a point from what the user typed or pasted. */
export function parseLocationInput(raw: string): ParsedLocation {
  const text = raw.trim();
  if (text === '') return { ok: false, error: 'Enter a latitude and longitude, e.g. -6.1754, 106.8272.' };
  const pair = PAIR.exec(text);
  if (pair) return point(pair[1], pair[2]);
  if (SHORT_LINK.test(text)) {
    return {
      ok: false,
      error: 'Short links can’t be read here: open it, then copy the full Google Maps address.',
    };
  }
  for (const pattern of LINK_PATTERNS) {
    const match = pattern.exec(text);
    if (match) return point(match[1], match[2]);
  }
  return { ok: false, error: 'No coordinates found. Use “lat, lng” or a Google Maps link with them.' };
}

function isSavedPlace(value: unknown): value is SavedPlace {
  if (typeof value !== 'object' || value === null) return false;
  const { name, latitude, longitude } = value as Record<string, unknown>;
  return (
    typeof name === 'string' &&
    name.length > 0 &&
    name.length <= MAX_PLACE_NAME_CHARS &&
    typeof latitude === 'number' &&
    typeof longitude === 'number' &&
    isValidLatLng({ latitude, longitude })
  );
}

/** Saved places from storage; anything malformed is dropped. */
export function parseSavedPlaces(raw: string | null): SavedPlace[] {
  if (raw === null) return [];
  try {
    const value: unknown = JSON.parse(raw);
    if (!Array.isArray(value)) return [];
    return value
      .filter(isSavedPlace)
      .slice(0, MAX_SAVED_PLACES)
      .map(({ name, latitude, longitude }) => ({ name, latitude, longitude }));
  } catch {
    return [];
  }
}

export function serializeSavedPlaces(places: readonly SavedPlace[]): string {
  return JSON.stringify(places);
}

/** A new place goes first; one with the same name is replaced. */
export function addSavedPlace(places: readonly SavedPlace[], place: SavedPlace): SavedPlace[] {
  const name = place.name.trim().slice(0, MAX_PLACE_NAME_CHARS);
  if (name === '') return [...places];
  return [{ ...roundLatLng(place), name }, ...places.filter((other) => other.name !== name)].slice(
    0,
    MAX_SAVED_PLACES,
  );
}

export function removeSavedPlace(places: readonly SavedPlace[], name: string): SavedPlace[] {
  return places.filter((place) => place.name !== name);
}

export function sameLatLng(a: LatLng | null, b: LatLng | null): boolean {
  if (a === null || b === null) return a === b;
  const left = roundLatLng(a);
  const right = roundLatLng(b);
  return left.latitude === right.latitude && left.longitude === right.longitude;
}
