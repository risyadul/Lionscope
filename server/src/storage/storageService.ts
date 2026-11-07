/**
 * The storage inspector (0.13.0): list, read and edit the session app's SharedPreferences and registered Room
 * databases through its SDK link, for the dashboards and the agent tools alike.
 *
 * Fail-closed in this order, before anything reaches the device: the server's consent flags (`consent_required`), a
 * running session (`needs_profiling_session`), its app's live SDK link at device protocol v11 (`needs_sdk`) with the
 * link proof (`unauthenticated`). One request per device at a time (`busy`), writes rate-limited per device. What the
 * SDK answers is redacted again here. Every write (refused ones too, and late outcomes) is audited without values.
 */
import { createHash, randomUUID } from 'node:crypto';
import {
  canonicalPkJson,
  canonicalStorageJson,
  DEVICE_PROTOCOL_V11,
  isSensitiveStorageName,
  MAX_STORAGE_AUDIT,
  redactStoragePage,
  redactStorageValue,
  STORAGE_REDACTED_NAME,
  STORAGE_WRITE_BURST,
  STORAGE_WRITES_PER_SECOND,
  storageWriteProblem,
} from '@lionscope/protocol';
import type {
  ServerMessage,
  StorageAuditEntry,
  StorageConsent,
  StorageCode,
  StorageReadInput,
  StorageResponse,
  StorageTarget,
  StorageValue,
  StorageWriteInput,
  StorageWriteOutcome,
} from '@lionscope/protocol';
import { log } from '../log.ts';
import { TokenBucket } from '../net/tokenBucket.ts';
import { SdkStorageError } from '../device/sdkLink.ts';
import type { SdkLink, SdkLinkMessage, SdkStorageFailure, SdkStorageRequest } from '../device/sdkLink.ts';
import type { StorageSessionTarget } from '../session/sessionManager.ts';

type SdkWriteResult = Extract<SdkLinkMessage, { type: 'storageWriteResult' }>;

/** Devices whose write rate is tracked at most (the oldest is forgotten first). */
const MAX_TRACKED_DEVICES = 32;

/** What each refusal tells the caller (no app values: agents get these as plain tool errors). */
export const STORAGE_MESSAGES: Readonly<Record<string, string>> = {
  consent_required:
    'The storage inspector is off. Start Lionscope with --allow-storage-read (and --allow-storage-write to edit values).',
  consent_write:
    'Editing storage is off. Start Lionscope with --allow-storage-write (as well as --allow-storage-read).',
  needs_profiling_session:
    'The storage inspector needs a profiling session of the app (start one first): it works through its SDK link.',
  needs_sdk:
    'The app has no live Lionscope SDK link of 0.13.0 or newer (device protocol 11): add or update the SDK and restart the app.',
  unauthenticated:
    "The app's SDK link has no link proof (the link key could not be handed to the app over adb): restart the session.",
  busy: 'Another storage request is running on this device, or too many edits in a row: wait a moment and retry.',
  timeout:
    'The app did not answer in time. A write may still have been applied: read the value again before retrying. It cannot be undone from here.',
  link_gone: "The app's SDK link went away before it answered: read again before retrying.",
  too_large: 'The request is too large to send to the app (over 60 KiB).',
  not_undoable:
    'That write cannot be undone: only an edit whose final answer was ok in time (and, for prefs, persisted) can, on the same app link it was made on.',
  stale_target:
    "The app's SDK link is another one than the one these values were read from (a new session, another app, or the app restarted or reconnected): nothing was written. Read again.",
  failed: 'The storage request failed.',
};

const FAILURE_CODES: Readonly<Record<SdkStorageFailure, { code: StorageCode; message: string }>> = {
  unsupported: { code: 'needs_sdk', message: STORAGE_MESSAGES.needs_sdk! },
  closed: { code: 'failed', message: STORAGE_MESSAGES.link_gone! },
  timeout: { code: 'timeout', message: STORAGE_MESSAGES.timeout! },
  busy: { code: 'busy', message: STORAGE_MESSAGES.busy! },
  too_large: { code: 'invalid_value:too_large', message: STORAGE_MESSAGES.too_large! },
  invalid: { code: 'failed', message: STORAGE_MESSAGES.failed! },
};

function refusal(
  code: StorageCode,
  message = STORAGE_MESSAGES[code] ?? STORAGE_MESSAGES.failed!,
): StorageResponse {
  return { ok: false, code, message };
}

/** What the server remembers of a write (no values): enough to judge an undo and to place a late answer. */
interface OpRecord {
  serial: string;
  packageName: string;
  /** The SDK link it was sent on (StorageTarget.link): an undo goes only to that same link. */
  link: number;
  /** The write's target without values, as canonical text (an undo must name the same one). */
  target: string;
  state: 'pending' | 'timeout' | 'provisional' | 'done';
  /**
   * A `final` that arrived while the request was still `pending` here: the gateway settled the request with the
   * `provisional` (or failed it on its timeout) but its continuation has not run yet, e.g. both lines came in one TCP
   * chunk. Kept, and taken up once the record leaves `pending` (write()).
   */
  early?: SdkWriteResult;
  undoable: boolean;
  input: Omit<StorageWriteInput, 'expected' | 'value' | 'rowDigest' | 'undoOf' | 'target'>;
}

export interface StorageServiceOptions {
  consent: StorageConsent;
  /** The running session's app (SessionManager.storageTarget). */
  target: () => StorageSessionTarget | null;
  /** Late outcomes go to every dashboard (`storageOutcome`). */
  broadcast?: (message: ServerMessage) => void;
  now?: () => number;
  newOpId?: () => string;
}

/** Reached: the session's app and its link, ready for a storage request. */
interface Reached {
  serial: string;
  packageName: string;
  link: SdkLink;
  /** Who answers (what responses carry and writes may name). */
  target: StorageTarget;
}

export class StorageService {
  readonly consent: StorageConsent;
  private readonly now: () => number;
  private readonly newOpId: () => string;
  private readonly inFlight = new Set<string>();
  private readonly buckets = new Map<string, TokenBucket>();
  private readonly auditLog: StorageAuditEntry[] = [];
  private readonly ops = new Map<string, OpRecord>();
  /** A number per SDK link object, so a new link (reconnect, restart, another app) is told apart from the last. */
  private readonly linkIds = new WeakMap<SdkLink, number>();
  private nextLinkId = 1;

  constructor(private readonly options: StorageServiceOptions) {
    this.consent = options.consent;
    this.now = options.now ?? Date.now;
    this.newOpId = options.newOpId ?? randomUUID;
  }

  /** The prefs files and registered databases of the session's app. */
  list(): Promise<StorageResponse> {
    return this.request('read', async ({ link, target }) => {
      const result = await link.storage({ type: 'storageList' });
      if (result.type !== 'storageListResult') return refusal('failed');
      if (result.code !== 'ok') return refusal(result.code, readMessage(result.code));
      return {
        ok: true,
        kind: 'list',
        target,
        prefs: result.prefs,
        prefsTruncated: result.prefsTruncated,
        databases: result.databases,
      };
    });
  }

  /** A prefs file's keys (a page), a database's schema, or up to MAX_STORAGE_PAGES table pages (one transaction). */
  read(input: StorageReadInput): Promise<StorageResponse> {
    return this.request('read', async ({ link, target }) => {
      const request: SdkStorageRequest =
        input.store === 'prefs'
          ? {
              type: 'storageRead',
              store: 'prefs',
              name: input.name,
              ...(input.cursor ? { cursor: input.cursor } : {}),
              ...(input.limit !== undefined ? { limit: input.limit } : {}),
            }
          : {
              type: 'storageRead',
              store: 'db',
              name: input.name,
              ...(input.pages ? { pages: JSON.stringify(input.pages) } : {}),
            };
      const result = await link.storage(request);
      if (result.type !== 'storageReadResult') return refusal('failed');
      if (result.code !== 'ok') return refusal(result.code, readMessage(result.code));
      if (input.store === 'prefs') {
        return {
          ok: true,
          kind: 'prefs',
          target,
          name: input.name,
          // keyLength stays: it is the entry's identity (a cut key names ANOTHER key in a write) and makes it read-only.
          entries: (result.entries ?? []).map(({ key, keyLength, value }) => ({
            key,
            ...(keyLength !== undefined ? { keyLength } : {}),
            value: redactStorageValue(key, value),
          })),
          nextCursor: result.nextCursor ?? null,
          truncated: result.truncated ?? false,
        };
      }
      if (!input.pages) {
        return {
          ok: true,
          kind: 'schema',
          target,
          name: input.name,
          tables: result.tables ?? [],
          tablesTruncated: result.tablesTruncated ?? false,
        };
      }
      return {
        ok: true,
        kind: 'pages',
        target,
        name: input.name,
        pages: (result.pages ?? []).map((page) => redactStoragePage(page)),
        txMs: result.txMs ?? 0,
      };
    });
  }

  /**
   * One compare-and-set edit. Never retried by the server. A `timeout` may still have been applied (its late
   * outcome is audited and broadcast when it comes); only an `ok` final answer in time (prefs: persisted) carries an
   * `undo`, and only such an undo is accepted (`undoOf`).
   */
  async write(input: StorageWriteInput): Promise<StorageResponse> {
    const target = writeTarget(input);
    const reached = this.reach('read_write');
    const auditBase = {
      serial: 'serial' in reached ? reached.serial : (this.options.target()?.serial ?? ''),
      packageName: 'serial' in reached ? reached.packageName : (this.options.target()?.packageName ?? ''),
    };
    const opId = this.newOpId();
    const refuse = (code: StorageCode, message?: string): StorageResponse => {
      this.record(opId, auditBase.serial, auditBase.packageName, input, code, null, false, {});
      return refusal(code, message ?? codeMessage(code));
    };
    if (!('serial' in reached)) return refuse(reached.code, reached.message);
    const field = input.op === 'delete' ? null : input.store === 'prefs' ? input.key : input.column;
    if (field !== null && isSensitiveStorageName(field)) return refuse('read_only:redacted');
    const problem = storageWriteProblem(input);
    if (problem) return refuse(problem);
    // Values read from another app, process or link must not be written here (checked before anything is sent).
    if (input.target !== undefined && !sameTarget(input.target, reached.target)) {
      return refuse('failed', STORAGE_MESSAGES.stale_target);
    }
    const original = 'undoOf' in input && input.undoOf !== undefined ? this.ops.get(input.undoOf) : null;
    if (original !== null) {
      if (
        !original ||
        !original.undoable ||
        original.target !== target ||
        original.serial !== reached.serial ||
        original.packageName !== reached.packageName ||
        original.link !== reached.target.link
      ) {
        return refuse('failed', STORAGE_MESSAGES.not_undoable);
      }
    }
    if (this.inFlight.has(reached.serial)) return refuse('busy');
    if (!this.bucket(reached.serial).take()) return refuse('busy');
    // An undo is offered once: it is spent when it goes out (a busy refusal above leaves it offered).
    if (original) original.undoable = false;
    const record: OpRecord = {
      serial: reached.serial,
      packageName: reached.packageName,
      link: reached.target.link,
      target,
      state: 'pending',
      undoable: false,
      input: stripValues(input),
    };
    this.remember(opId, record);
    this.inFlight.add(reached.serial);
    let result: SdkWriteResult;
    try {
      const answer = await reached.link.storage(writeRequest(opId, input));
      if (answer.type !== 'storageWriteResult' || answer.opId !== opId) throw new SdkStorageError('invalid');
      result = answer;
    } catch (error) {
      if (!(error instanceof SdkStorageError)) throw error;
      const { code, message } = FAILURE_CODES[error.reason];
      // Sent but unanswered: it may have been applied; a late final answer is still recorded.
      record.state = error.reason === 'timeout' ? 'timeout' : 'done';
      this.audit(opId, record, input, code, null, false, {});
      this.takeEarly(opId, record);
      return {
        ok: true,
        kind: 'write',
        target: reached.target,
        outcome: { opId, code, late: false, message },
      };
    } finally {
      this.inFlight.delete(reached.serial);
    }
    record.state = result.phase === 'provisional' ? 'provisional' : 'done';
    const outcome = this.outcome(input, result, false, reached.target);
    record.undoable = outcome.undo !== undefined;
    this.audit(opId, record, input, result.code, result.phase, false, result);
    this.takeEarly(opId, record);
    return { ok: true, kind: 'write', target: reached.target, outcome };
  }

  /**
   * A write's answer that came after its request was settled: the `final` after a `provisional`, or any answer after
   * a `timeout` (`late`). Audited and broadcast; never undoable, and the original answer stays what it was. Monotonic:
   * one `final` per write is taken (a duplicate, or a `provisional` after anything, is dropped), and one that comes
   * while the request is still settling here is kept until it has (`early`).
   */
  onLateResult(target: StorageSessionTarget, message: SdkWriteResult): void {
    const record = this.ops.get(message.opId);
    if (!record || record.serial !== target.serial || record.state === 'done') return;
    if (message.phase !== 'final') return;
    if (record.state === 'pending') {
      record.early ??= message;
      return;
    }
    this.settleLate(message.opId, record, message);
  }

  /** The `final` kept while the request was settling, once it has: a final after a provisional or a timeout. */
  private takeEarly(opId: string, record: OpRecord): void {
    const early = record.early;
    delete record.early;
    if (early && (record.state === 'provisional' || record.state === 'timeout'))
      this.settleLate(opId, record, early);
  }

  private settleLate(opId: string, record: OpRecord, message: SdkWriteResult): void {
    const late = record.state === 'timeout';
    record.state = 'done';
    record.undoable = false;
    const outcome: StorageWriteOutcome = {
      ...this.outcome(record.input as StorageWriteInput, message, true),
      late,
    };
    delete outcome.undo;
    this.audit(opId, record, record.input as StorageWriteInput, message.code, 'final', late, message);
    log.info(
      `Storage: ${late ? 'late' : 'final'} outcome of write ${opId} on ${record.serial}: ${message.code}`,
    );
    this.options.broadcast?.({ type: 'storageOutcome', serial: record.serial, outcome });
  }

  /** Audit entries, oldest first (all, or one write's). */
  auditEntries(opId?: string): StorageAuditEntry[] {
    return opId === undefined ? [...this.auditLog] : this.auditLog.filter((entry) => entry.opId === opId);
  }

  /** The write audit for a caller (dashboard, agent): needs --allow-storage-read, like reading storage. */
  auditResponse(): StorageResponse {
    if (this.consent === 'off') return refusal('consent_required', STORAGE_MESSAGES.consent_required!);
    return { ok: true, kind: 'audit', entries: this.auditEntries() };
  }

  private async request(
    needed: 'read' | 'read_write',
    run: (reached: Reached) => Promise<StorageResponse>,
  ): Promise<StorageResponse> {
    const reached = this.reach(needed);
    if (!('serial' in reached)) return refusal(reached.code, reached.message);
    if (this.inFlight.has(reached.serial)) return refusal('busy');
    this.inFlight.add(reached.serial);
    try {
      return await run(reached);
    } catch (error) {
      if (!(error instanceof SdkStorageError)) throw error;
      const { code, message } = FAILURE_CODES[error.reason];
      return refusal(code, error.reason === 'timeout' ? 'The app did not answer in time.' : message);
    } finally {
      this.inFlight.delete(reached.serial);
    }
  }

  /** The session's app and link, or why storage can't be reached (checked in the order of the module comment). */
  private reach(needed: 'read' | 'read_write'): Reached | { code: StorageCode; message: string } {
    if (this.consent === 'off')
      return { code: 'consent_required', message: STORAGE_MESSAGES.consent_required! };
    if (needed === 'read_write' && this.consent !== 'read_write') {
      return { code: 'consent_required', message: STORAGE_MESSAGES.consent_write! };
    }
    const target = this.options.target();
    if (!target || !target.ready) {
      return { code: 'needs_profiling_session', message: STORAGE_MESSAGES.needs_profiling_session! };
    }
    const { link } = target;
    if (!link) return { code: 'needs_sdk', message: STORAGE_MESSAGES.needs_sdk! };
    if (link.mode !== 'session') {
      return { code: 'needs_profiling_session', message: STORAGE_MESSAGES.needs_profiling_session! };
    }
    if (link.protocolVersion < DEVICE_PROTOCOL_V11)
      return { code: 'needs_sdk', message: STORAGE_MESSAGES.needs_sdk! };
    if (!link.proven) return { code: 'unauthenticated', message: STORAGE_MESSAGES.unauthenticated! };
    return {
      serial: target.serial,
      packageName: target.packageName,
      link,
      target: { serial: target.serial, packageName: target.packageName, link: this.linkId(link) },
    };
  }

  private linkId(link: SdkLink): number {
    let id = this.linkIds.get(link);
    if (id === undefined) {
      id = this.nextLinkId++;
      this.linkIds.set(link, id);
    }
    return id;
  }

  /** The outcome for callers: values redacted again, `undo` only for an `ok` final answer in time (bound to [target]). */
  private outcome(
    input: StorageWriteInput,
    result: SdkWriteResult,
    late: boolean,
    target?: StorageTarget,
  ): StorageWriteOutcome {
    const field = input.op === 'delete' ? '' : input.store === 'prefs' ? input.key : input.column;
    const redact = (value: StorageValue | undefined) =>
      value === undefined ? undefined : redactStorageValue(field, value);
    const outcome: StorageWriteOutcome = {
      opId: result.opId,
      code: result.code,
      phase: result.phase,
      late,
    };
    const current = redact(result.current);
    const stored = redact(result.stored);
    if (current) outcome.current = current;
    if (stored) outcome.stored = stored;
    if (result.normalized !== undefined) outcome.normalized = result.normalized;
    if (result.memory !== undefined) outcome.memory = result.memory;
    if (result.persisted !== undefined) outcome.persisted = result.persisted;
    if (result.observers !== undefined) outcome.observers = result.observers;
    if (result.changes !== undefined) outcome.changes = result.changes;
    if (result.totalChangesDelta !== undefined) outcome.totalChangesDelta = result.totalChangesDelta;
    if (result.txMs !== undefined) outcome.txMs = result.txMs;
    if (result.code !== 'ok') outcome.message = codeMessage(result.code);
    else if (input.store === 'prefs' && result.persisted !== true) {
      outcome.message =
        result.persisted === 'timeout'
          ? 'Changed in the app\u2019s memory; saving to disk is still running (its final outcome follows).'
          : 'Changed in the app\u2019s memory only: saving to disk failed.';
    }
    const undoable =
      !late &&
      result.code === 'ok' &&
      result.phase === 'final' &&
      input.op === 'update' &&
      (input.store === 'db' || result.persisted === true) &&
      stored !== undefined &&
      stored.t !== 'redacted' &&
      // A cut value (what a trigger or another writer left, too large to send) can't be an undo's `expected`.
      !isCut(stored);
    if (undoable && input.op === 'update' && stored) {
      outcome.undo =
        input.store === 'prefs'
          ? {
              store: 'prefs',
              name: input.name,
              op: 'update',
              key: input.key,
              expected: stored,
              value: input.expected,
              undoOf: result.opId,
              ...(target ? { target } : {}),
            }
          : {
              store: 'db',
              name: input.name,
              op: 'update',
              table: input.table,
              column: input.column,
              pk: input.pk,
              expected: stored,
              value: input.expected,
              undoOf: result.opId,
              ...(target ? { target } : {}),
            };
    }
    return outcome;
  }

  private remember(opId: string, record: OpRecord): void {
    if (this.ops.size >= MAX_STORAGE_AUDIT) {
      const oldest = this.ops.keys().next().value;
      if (oldest !== undefined) this.ops.delete(oldest);
    }
    this.ops.set(opId, record);
  }

  private record(
    opId: string,
    serial: string,
    packageName: string,
    input: StorageWriteInput,
    code: StorageCode,
    phase: 'provisional' | 'final' | null,
    late: boolean,
    result: Partial<SdkWriteResult>,
  ): void {
    const field = input.op === 'delete' ? null : input.store === 'prefs' ? input.key : input.column;
    this.auditLog.push({
      ts: this.now(),
      opId,
      serial,
      packageName,
      store: input.store,
      name: input.name,
      table: input.store === 'db' ? input.table : null,
      field: field === null ? null : isSensitiveStorageName(field) ? STORAGE_REDACTED_NAME : field,
      pkDigest: input.store === 'db' ? sha256(canonicalPkJson(input.pk)) : null,
      op: input.op,
      code,
      phase,
      late,
      persisted: result.persisted ?? null,
      changes: result.changes ?? null,
      totalChangesDelta: result.totalChangesDelta ?? null,
    });
    if (this.auditLog.length > MAX_STORAGE_AUDIT)
      this.auditLog.splice(0, this.auditLog.length - MAX_STORAGE_AUDIT);
  }

  private audit(
    opId: string,
    record: OpRecord,
    input: StorageWriteInput,
    code: StorageCode,
    phase: 'provisional' | 'final' | null,
    late: boolean,
    result: Partial<SdkWriteResult>,
  ): void {
    this.record(opId, record.serial, record.packageName, input, code, phase, late, result);
  }

  private bucket(serial: string): TokenBucket {
    let bucket = this.buckets.get(serial);
    if (!bucket) {
      if (this.buckets.size >= MAX_TRACKED_DEVICES) {
        const oldest = this.buckets.keys().next().value;
        if (oldest !== undefined) this.buckets.delete(oldest);
      }
      bucket = new TokenBucket(STORAGE_WRITE_BURST, STORAGE_WRITES_PER_SECOND, this.now);
      this.buckets.set(serial, bucket);
    }
    return bucket;
  }
}

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** A read refusal's text: a read changes nothing, so its `timeout` (the SDK's budget ran out) says so. */
export function readMessage(code: StorageCode): string {
  if (code === 'timeout')
    return 'The read ran out of its time budget in the app and was rolled back: nothing changed. Read fewer rows or retry.';
  return codeMessage(code);
}

/** A refusal's text: the fixed message of its code (`read_only:pk_column` → its reason). */
export function codeMessage(code: StorageCode): string {
  if (code === 'conflict')
    return 'The value changed since it was read: nothing was written. The current value is in `current`.';
  if (code === 'already_applied_or_concurrent')
    return 'The value already is the new one (a retry after a lost answer, or another writer): nothing was written.';
  if (code === 'concurrent_after_write')
    return 'Written, but another writer changed the value right after: read it again.';
  if (code === 'type_mismatch') return 'The new value is not of the type the value has: nothing was written.';
  if (code === 'constraint_failed')
    return 'The database refused the change (NOT NULL, UNIQUE, CHECK or foreign key).';
  if (code === 'not_found') return 'No such prefs file, key, database, table or row.';
  if (code === 'invalid_identifier')
    return 'A table, column or primary key that does not match the schema exactly.';
  if (code === 'invalid_value:nan_not_storable')
    return 'SQLite cannot store NaN in a REAL column (it would become NULL).';
  if (code === 'invalid_value:lone_surrogate')
    return 'Storage cannot keep a lone surrogate: SQLite on Android would change it and the character after it, and SharedPreferences write it to the file as "?".';
  if (code === 'invalid_value:nan_payload')
    return 'SharedPreferences keep a single NaN (bits 0x7fc00000): another NaN payload cannot be stored.';
  if (code.startsWith('invalid_value')) return 'The value is malformed, out of range or too large.';
  if (code.startsWith('read_only:'))
    return `Read-only: ${code.slice('read_only:'.length).replace(/_/g, ' ')}.`;
  if (code.startsWith('unsupported:'))
    return `Not supported: ${code.slice('unsupported:'.length).replace(/_/g, ' ')}.`;
  return STORAGE_MESSAGES[code] ?? STORAGE_MESSAGES.failed!;
}

/** A value sent cut (`complete: false`): read-only. */
function isCut(value: StorageValue): boolean {
  return 'complete' in value && value.complete === false;
}

function sameTarget(a: StorageTarget, b: StorageTarget): boolean {
  return a.serial === b.serial && a.packageName === b.packageName && a.link === b.link;
}

/** A write's target without values (what an undo must name the same). */
function writeTarget(input: StorageWriteInput): string {
  return JSON.stringify([
    input.store,
    input.name,
    input.op === 'delete' ? null : input.store === 'prefs' ? input.key : [input.table, input.column],
    input.store === 'db' ? canonicalPkJson(input.pk) : null,
  ]);
}

function stripValues(input: StorageWriteInput): OpRecord['input'] {
  const {
    expected: _expected,
    value: _value,
    rowDigest: _rowDigest,
    undoOf: _undoOf,
    target: _target,
    ...rest
  } = input as Partial<Record<'expected' | 'value' | 'rowDigest' | 'undoOf' | 'target', unknown>> &
    StorageWriteInput;
  return rest;
}

/** The flat `storageWrite` line's fields (typed values and the key as canonical JSON strings). */
function writeRequest(opId: string, input: StorageWriteInput): SdkStorageRequest {
  if (input.store === 'prefs') {
    return input.op === 'update'
      ? {
          type: 'storageWrite',
          opId,
          store: 'prefs',
          name: input.name,
          op: 'update',
          key: input.key,
          expected: canonicalStorageJson(input.expected),
          value: canonicalStorageJson(input.value),
        }
      : {
          type: 'storageWrite',
          opId,
          store: 'prefs',
          name: input.name,
          op: 'remove',
          key: input.key,
          expected: canonicalStorageJson(input.expected),
        };
  }
  return input.op === 'update'
    ? {
        type: 'storageWrite',
        opId,
        store: 'db',
        name: input.name,
        op: 'update',
        table: input.table,
        column: input.column,
        pk: canonicalPkJson(input.pk),
        expected: canonicalStorageJson(input.expected),
        value: canonicalStorageJson(input.value),
      }
    : {
        type: 'storageWrite',
        opId,
        store: 'db',
        name: input.name,
        op: 'delete',
        table: input.table,
        pk: canonicalPkJson(input.pk),
        rowDigest: input.rowDigest,
      };
}
