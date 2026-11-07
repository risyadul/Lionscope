/**
 * The Storage tab's value handling (0.13.0). Integers stay decimal strings end to end (never `Number`), floats are
 * their raw bits: what the user types is turned into the same typed value the SDK compares, and anything that would
 * round is refused here instead of being written.
 */
import {
  STORAGE_FLOAT_BITS_PATTERN,
  STORAGE_INTEGER_PATTERN,
  STORAGE_REAL_BITS_PATTERN,
  type SessionState,
  type StorageAuditEntry,
  type StorageCode,
  type StoragePage,
  type StorageTable,
  type StorageTarget,
  type StorageValue,
  type StorageWriteOutcome,
} from '@lionscope/protocol/wire';

const RANGES = {
  int: [-(2n ** 31n), 2n ** 31n - 1n],
  long: [-(2n ** 63n), 2n ** 63n - 1n],
  integer: [-(2n ** 63n), 2n ** 63n - 1n],
} as const;

/** The value as text for the table (never parsed back: editing starts from `editText`). */
export function displayValue(value: StorageValue): string {
  switch (value.t) {
    case 'string':
      return value.complete === false ? `${value.v}… (${value.length ?? '?'} chars)` : value.v;
    case 'int':
    case 'long':
    case 'integer':
      return value.v;
    case 'float':
    case 'real':
      return value.v;
    case 'bool':
      return value.v ? 'true' : 'false';
    case 'stringSet':
      return `[${value.v.join(', ')}]${value.complete === false ? '…' : ''}`;
    case 'blob':
      return `${value.size} bytes${value.complete ? '' : ' (cut)'}`;
    case 'null':
      return 'NULL';
    case 'redacted':
      return value.preview ?? '‹redacted›';
  }
}

/** Whether a value can be edited in place (a complete value of a type the editor knows, not redacted). */
export function isEditable(value: StorageValue): boolean {
  if (value.t === 'redacted' || value.t === 'blob' || value.t === 'stringSet') return false;
  return !(value.t === 'string' && value.complete === false);
}

/** The text an edit field starts with. */
export function editText(value: StorageValue): string {
  return value.t === 'null' ? '' : displayValue(value);
}

/** The raw bits of `text` as a `float` (32-bit) or `real` (64-bit), or null when it is not a number. */
export function bitsOf(text: string, type: 'float' | 'real'): string | null {
  const trimmed = text.trim();
  const special: Record<string, number> = { NaN: NaN, Infinity: Infinity, '-Infinity': -Infinity };
  if (!(trimmed in special) && !/^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i.test(trimmed)) return null;
  const number = trimmed in special ? special[trimmed]! : Number(trimmed);
  const view = new DataView(new ArrayBuffer(8));
  if (type === 'float') {
    view.setFloat32(0, number);
    return `0x${view.getUint32(0).toString(16).padStart(8, '0')}`;
  }
  view.setFloat64(0, number);
  return `0x${view.getBigUint64(0).toString(16).padStart(16, '0')}`;
}

/**
 * `text` as a value of the same type as `current` (prefs keep their type; a SQLite cell keeps its storage class, or
 * takes `as` when it is NULL). `{ error }` when the text is not such a value. Integers are checked as BigInt.
 */
export function parseValue(
  text: string,
  current: StorageValue,
  as?: 'string' | 'integer' | 'real' | 'null',
): { value: StorageValue } | { error: string } {
  const type = current.t === 'null' ? (as ?? 'string') : current.t;
  switch (type) {
    case 'string':
      return { value: { t: 'string', v: text } };
    case 'int':
    case 'long':
    case 'integer': {
      const trimmed = text.trim();
      if (trimmed.length > 20 || !STORAGE_INTEGER_PATTERN.test(trimmed)) {
        return { error: 'Not a whole number.' };
      }
      const [min, max] = RANGES[type];
      const big = BigInt(trimmed);
      if (big < min || big > max) return { error: `Out of range for ${type}.` };
      return { value: { t: type, v: trimmed } };
    }
    case 'float':
    case 'real': {
      const bits = bitsOf(text, type);
      if (bits === null) return { error: 'Not a number.' };
      if (!(type === 'float' ? STORAGE_FLOAT_BITS_PATTERN : STORAGE_REAL_BITS_PATTERN).test(bits)) {
        return { error: 'Not a number.' };
      }
      return { value: { t: type, v: text.trim(), bits } };
    }
    case 'bool': {
      const trimmed = text.trim().toLowerCase();
      if (trimmed !== 'true' && trimmed !== 'false') return { error: 'true or false.' };
      return { value: { t: 'bool', v: trimmed === 'true' } };
    }
    case 'null':
      return { value: { t: 'null' } };
    default:
      return { error: 'This value can’t be edited here.' };
  }
}

const READ_ONLY_TEXT: Record<string, string> = {
  no_explicit_pk: 'no explicit primary key (rowid is not stable)',
  pk_column: 'primary key column',
  view: 'a view (its values are hidden: which table column they come from is not known)',
  virtual: 'a virtual table (its values are hidden: which table column they come from is not known)',
  deferred_fk:
    'a table in a deferred foreign key (its check would only fail at COMMIT, inside the app’s transaction)',
  defer_foreign_keys:
    'the app left PRAGMA defer_foreign_keys on (every foreign key would only be checked at COMMIT)',
  internal: 'an SQLite / Room internal table',
  redacted: 'looks like a credential',
  truncated: 'too long to send whole',
};

/** A read-only reason (`read_only:` code or the table's `readOnly`) as plain text. */
export function readOnlyText(reason: string): string {
  const bare = reason.startsWith('read_only:') ? reason.slice('read_only:'.length) : reason;
  if (bare.startsWith('unsupported:')) {
    const what = bare.slice('unsupported:'.length);
    return `not supported: ${READ_ONLY_TEXT[what] ?? what.replace(/_/g, ' ')}`;
  }
  return READ_ONLY_TEXT[bare] ?? bare.replace(/_/g, ' ');
}

/** Why a cell of a page can't be edited (null: it can). */
export function cellReadOnly(page: StoragePage, column: string, value: StorageValue): string | null {
  if (page.readOnly) return readOnlyText(page.readOnly);
  if (page.pk.includes(column)) return readOnlyText('pk_column');
  if (value.t === 'redacted') return readOnlyText('redacted');
  if (value.t === 'blob' || (value.t === 'string' && value.complete === false)) {
    return value.t === 'blob' && value.complete
      ? 'BLOBs are edited from an agent (write_storage)'
      : readOnlyText('truncated');
  }
  return null;
}

/** The table's affinity guess for a NULL cell: what a typed value becomes. */
export function affinityOf(table: StorageTable | undefined, column: string): 'string' | 'integer' | 'real' {
  const declared = table?.columns.find((candidate) => candidate.name === column)?.type.toUpperCase() ?? '';
  if (declared.includes('INT')) return 'integer';
  if (declared.includes('REAL') || declared.includes('FLOA') || declared.includes('DOUB')) return 'real';
  return 'string';
}

/** One line on what a write did, for the user (never more than the codes and flags say). */
export function outcomeText(outcome: StorageWriteOutcome): string {
  // `ok` with prefs not (yet) saved to disk is a change in the app's memory, not "Saved".
  const unsaved = outcome.code === 'ok' && outcome.persisted !== undefined && outcome.persisted !== true;
  const parts: string[] = [unsaved ? 'Changed in the app’s memory' : codeText(outcome.code)];
  if (outcome.phase === 'provisional') parts.push('saving to disk is still running');
  if (outcome.persisted === false) parts.push('changed in the app’s memory only: saving to disk failed');
  if (outcome.persisted === 'timeout' && outcome.phase !== 'provisional')
    parts.push('not known whether it was saved');
  if (outcome.observers === 'posted_unverified')
    parts.push(
      'a change notice was posted to the app’s listeners (whether they ran is not known); its UI may not show it',
    );
  if (outcome.observers === 'room_invalidation') {
    parts.push('Room was told the table changed; screens that don’t observe it change when they reload');
  }
  if (outcome.normalized) parts.push('SQLite stored it differently (shown is what it stored)');
  if (
    outcome.changes !== undefined &&
    outcome.totalChangesDelta !== undefined &&
    outcome.totalChangesDelta > outcome.changes
  ) {
    parts.push('there may be side effects (triggers, cascades, Room bookkeeping)');
  }
  if (outcome.late) parts.push('this final outcome came after the request had timed out');
  return parts.join(' · ');
}

export function codeText(code: StorageCode): string {
  switch (code) {
    case 'ok':
      return 'Saved';
    case 'conflict':
      return 'Not written: the value changed since it was read';
    case 'already_applied_or_concurrent':
      return 'Not written: it already had that value (a retry, or another writer)';
    case 'concurrent_after_write':
      return 'Written, then changed by another writer';
    case 'type_mismatch':
      return 'Not written: another type';
    case 'constraint_failed':
      return 'Not written: a constraint refused it';
    case 'timeout':
      return 'No answer in time: it may have been applied, read again';
    case 'busy':
      return 'Busy: try again';
    case 'consent_required':
      return 'Storage is off on this server';
    default:
      if (code.startsWith('read_only:')) return `Read-only: ${readOnlyText(code)}`;
      if (code.startsWith('unsupported:')) return `Not written: ${readOnlyText(code)}`;
      if (code === 'invalid_value:nan_not_storable') return 'Not written: SQLite can’t store NaN';
      if (code === 'invalid_value:nan_payload') return 'Not written: prefs keep a single NaN';
      if (code === 'invalid_value:lone_surrogate') return 'Not written: storage can’t keep a lone surrogate';
      return code.replace(/_/g, ' ');
  }
}

/** Two answers came from the same app link (StorageTarget). */
export function sameTarget(a: StorageTarget, b: StorageTarget): boolean {
  return a.serial === b.serial && a.packageName === b.packageName && a.link === b.link;
}

/** One audit entry as a line: when, what, where and how it ended (the audit holds no values). */
export function auditText(entry: StorageAuditEntry): string {
  const where = [entry.store, entry.name, entry.table, entry.field]
    .filter((part) => part !== null)
    .join(' · ');
  const parts = [
    new Date(entry.ts).toLocaleTimeString(),
    entry.op,
    where,
    entry.code,
    entry.phase ?? 'no answer',
  ];
  if (entry.late) parts.push('late');
  if (entry.persisted !== null) parts.push(`persisted ${String(entry.persisted)}`);
  if (entry.changes !== null) parts.push(`changes ${entry.changes}`);
  if (entry.pkDigest) parts.push(`key #${entry.pkDigest.slice(0, 8)}`);
  return parts.join(' · ');
}

/**
 * The session as the Storage tab binds its state to it: the device, the app, its process, the session's start and
 * whether its SDK link is up. When any of them changes, what was read (and any edit or undo offered from it) is gone.
 */
export function storageSessionKey(session: SessionState): string {
  return [
    session.status,
    session.serial ?? '',
    session.packageName ?? '',
    session.pid ?? '',
    session.startedAt ?? '',
    session.sdk?.connected ? 'sdk' : 'no-sdk',
  ].join('|');
}
