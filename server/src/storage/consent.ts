import type { StorageConsent } from '@lionscope/protocol';

/**
 * The storage consent of the server flags: `--allow-storage-write` needs `--allow-storage-read` too (an edit names the
 * value it expects, which takes reading it), so write alone is `off`.
 */
export function storageConsentOf(read: boolean, write: boolean): StorageConsent {
  if (!read) return 'off';
  return write ? 'read_write' : 'read';
}
