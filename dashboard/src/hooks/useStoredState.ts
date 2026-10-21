import { useCallback, useState } from 'react';
import { readStored, writeStored } from '../lib/layoutPrefs.ts';

/** `useState` remembered per viewer in localStorage (falls back to in-memory state when storage is blocked). */
export function useStoredState<T>(
  key: string,
  parse: (raw: string | null) => T,
  serialize: (value: T) => string = String,
): [T, (next: T) => void] {
  const [value, setValue] = useState<T>(() => parse(readStored(key)));
  const update = useCallback(
    (next: T) => {
      setValue(next);
      writeStored(key, serialize(next));
    },
    [key, serialize],
  );
  return [value, update];
}
