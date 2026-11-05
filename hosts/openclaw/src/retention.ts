import { createHash } from 'node:crypto';
import type { DocumentStore } from './vsm/state.js';

/**
 * Durable obligation for a private result payload that could not be written when the
 * execution became terminal. Execution terminality stays immutable; this obligation is
 * separate, bounded per pass and retried until the retained store accepts the payload or
 * the operator retires it.
 */
export const RETENTION_INDEX = 'retention/pending';
/** Redundant copy of the same list; the primary is authoritative, this is recovery. */
export const RETENTION_BACKUP = 'retention/pending-backup';
/** Ids examined per pass; the list itself is never truncated to fit a pass. */
export const RETENTION_SCAN = 256;
/** Hard ceiling: refuse a new obligation instead of silently evicting an old one. */
export const RETENTION_MAX_IDS = 4096;
export const RETENTION_MAX_ATTEMPTS = 64;
export const retentionRecordKey = (effectId: string): string => `retention/record/${effectId}`;
/** Canonical payload identity; must match the reconciler's private sink reference. */
export const resultPayloadRef = (effectId: string, runId: string): string =>
  `vsc-private-result:${createHash('sha256').update(`${effectId}\0${runId}`).digest('hex')}`;

export interface PendingRetention {
  effectId: string;
  runId: string;
  sessionKey: string;
  attempts: number;
  lastAt: number;
}

const ID = /^[A-Za-z0-9][A-Za-z0-9:._/\-]*$/;
const validId = (value: unknown, limit: number): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= limit && ID.test(value);

/** All valid, unique ids in stored order. Malformed entries are skipped, never invented. */
export function parseRetentionIndex(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  const record = value as { ids?: unknown };
  if (!Array.isArray(record.ids)) return [];
  const ids: string[] = [];
  for (const id of record.ids) {
    if (!validId(id, 128) || ids.includes(id)) continue;
    ids.push(id);
    if (ids.length >= RETENTION_MAX_IDS) break;
  }
  return ids;
}

export function parseRetentionCursor(value: unknown): number {
  const cursor = (value as { cursor?: unknown } | undefined)?.cursor;
  return Number.isSafeInteger(cursor) && (cursor as number) >= 0 ? cursor as number : 0;
}

export function parseRetentionRecord(value: unknown): PendingRetention | undefined {
  if (value === undefined || value === null || typeof value !== 'object') return undefined;
  const record = value as PendingRetention;
  if (!validId(record.effectId, 128) || !validId(record.runId, 256) || !validId(record.sessionKey, 512)) return undefined;
  if (!Number.isSafeInteger(record.attempts) || record.attempts < 0 || record.attempts > RETENTION_MAX_ATTEMPTS) return undefined;
  if (!Number.isSafeInteger(record.lastAt) || record.lastAt < 0) return undefined;
  return { effectId: record.effectId, runId: record.runId, sessionKey: record.sessionKey,
    attempts: record.attempts, lastAt: record.lastAt };
}

async function readIndex(store: DocumentStore): Promise<{ ids: string[]; cursor: number; comparison: unknown }> {
  const observed = await store.observe(RETENTION_INDEX);
  const raw = observed.value as { ids?: unknown } | undefined;
  let ids = parseRetentionIndex(observed.value);
  let cursor = parseRetentionCursor(observed.value);
  if (!Array.isArray(raw?.ids)) {
    // A malformed primary is repaired from the redundant copy when that copy is valid.
    const backup = await store.observe(RETENTION_BACKUP);
    if (Array.isArray((backup.value as { ids?: unknown } | undefined)?.ids)) {
      ids = parseRetentionIndex(backup.value);
      cursor = parseRetentionCursor(backup.value);
    }
  }
  return { ids, cursor, comparison: observed.comparison };
}

/**
 * Writes the full list and cursor to both keys. Retries an explicit CAS conflict only.
 * Refuses to evict: at the hard ceiling a new obligation fails loudly instead.
 */
async function writeIndex(store: DocumentStore, ids: string[], cursor: number): Promise<void> {
  if (ids.length > RETENTION_MAX_IDS) throw new Error('VSC_RETENTION_FULL');
  const value = { ids, cursor };
  for (let attempt = 0; attempt < 4; attempt++) {
    const first = await store.observe(RETENTION_INDEX);
    const written = await store.compareAndApply(RETENTION_INDEX, first.comparison,
      { operation: 'update', action: 'set', value });
    if (written.status === 'applied' || written.status === 'unchanged') break;
    if (attempt === 3) throw new Error('VSC_RETENTION_INDEX_CONFLICT');
  }
  const backup = await store.observe(RETENTION_BACKUP);
  await store.compareAndApply(RETENTION_BACKUP, backup.comparison,
    { operation: 'update', action: 'set', value });
}

export async function markPending(store: DocumentStore, record: PendingRetention): Promise<void> {
  const key = retentionRecordKey(record.effectId);
  const observed = await store.observe(key);
  const written = await store.compareAndApply(key, observed.comparison,
    { operation: 'update', action: 'set', value: record });
  if (written.status !== 'applied' && written.status !== 'unchanged') throw new Error('VSC_RETENTION_RECORD_CONFLICT');
  const index = await readIndex(store);
  await writeIndex(store, [...index.ids.filter(id => id !== record.effectId), record.effectId], index.cursor);
}

export async function clearPending(store: DocumentStore, effectId: string): Promise<void> {
  const key = retentionRecordKey(effectId);
  const observed = await store.observe(key);
  await store.compareAndApply(key, observed.comparison, { operation: 'update', action: 'set', value: null });
  const index = await readIndex(store);
  await writeIndex(store, index.ids.filter(id => id !== effectId), index.cursor);
}

export interface RetentionRetryOptions {
  store: DocumentStore;
  fetchMessages: (sessionKey: string, limit: number) => Promise<unknown[]>;
  /** Idempotent payload write; throws when the payload is not provably stored. */
  write: (payload: { effectId: string; runId: string; sessionKey: string; messages: unknown[] }) => Promise<void>;
  now: () => number;
  log?: (detail: string) => void;
}

/** One bounded pass over a window of pending payloads. Never touches execution terminality. */
export async function retryPendingResults(options: RetentionRetryOptions): Promise<{ retried: number; retained: number }> {
  const index = await readIndex(options.store);
  const start = index.ids.length === 0 ? 0 : index.cursor % index.ids.length;
  const window = index.ids.slice(start, start + RETENTION_SCAN);
  let retried = 0; let retained = 0; let lastProcessed: string | undefined;
  for (const effectId of window) {
    lastProcessed = effectId;
    const recordKey = retentionRecordKey(effectId);
    const recordValue = await options.store.observe(recordKey);
    const record = parseRetentionRecord(recordValue.value);
    if (!record) { await clearPending(options.store, effectId).catch(() => undefined); continue; }
    // An exhausted obligation waits for an operator; it is not retried automatically.
    if (record.attempts >= RETENTION_MAX_ATTEMPTS) {
      const fresh = await readIndex(options.store);
      await writeIndex(options.store, fresh.ids.filter(id => id !== effectId), fresh.cursor).catch(() => undefined);
      continue;
    }
    retried++;
    try {
      const messages = await options.fetchMessages(record.sessionKey, 10);
      await options.write({ effectId, runId: record.runId, sessionKey: record.sessionKey, messages });
      await clearPending(options.store, effectId);
      retained++;
    } catch {
      const next: PendingRetention = { ...record, attempts: record.attempts + 1, lastAt: options.now() };
      await options.store.compareAndApply(recordKey, recordValue.comparison,
        { operation: 'update', action: 'set', value: next });
      options.log?.(`retention-retry-failed ${effectId}`);
      if (next.attempts >= RETENTION_MAX_ATTEMPTS) {
        const fresh = await readIndex(options.store);
        await writeIndex(options.store, fresh.ids.filter(id => id !== effectId), fresh.cursor).catch(() => undefined);
        options.log?.(`retention-exhausted ${effectId}`);
      }
    }
  }
  try {
    // Anchor the cursor to the id after the last one processed, not to arithmetic on a
    // list that may have shrunk while clearing succeeded obligations.
    const fresh = await readIndex(options.store);
    const position = lastProcessed === undefined ? -1 : fresh.ids.indexOf(lastProcessed);
    const cursor = position >= 0 && position + 1 < fresh.ids.length ? position + 1 : 0;
    await writeIndex(options.store, fresh.ids, cursor);
  } catch { options.log?.('retention-cursor-write-failed'); }
  return { retried, retained };
}
