import { createHash } from 'node:crypto';
import type { DocumentStore } from './vsm/state.js';

/**
 * Durable obligation for a private result payload that could not be written when the
 * execution became terminal. Execution terminality stays immutable; this obligation is
 * separate, bounded and retried until the retained store accepts the payload or the
 * operator retires it.
 */
export const RETENTION_INDEX = 'retention/pending';
/**
 * Storage keeps every obligation it was given; scanning and writes are bounded together
 * so a full index never silently drops a record that already exists.
 */
export const RETENTION_LIMIT = 256;
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

/** Bounded, unique, order-preserving list of pending effect ids. */
export function parseRetentionIndex(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  const record = value as { ids?: unknown };
  if (!Array.isArray(record.ids)) return [];
  const ids: string[] = [];
  for (const id of record.ids) {
    if (!validId(id, 128) || ids.includes(id)) continue;
    ids.push(id);
    if (ids.length >= RETENTION_LIMIT) break;
  }
  return ids;
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

/**
 * Index update over the RAW stored list, not a parsed projection, so cleanup can never
 * truncate an existing entry. Retries an explicit CAS conflict only; the mutation is
 * re-applied to the fresh list each time, so concurrent writers converge.
 */
async function updateIndex(store: DocumentStore, mutate: (ids: string[]) => string[]): Promise<void> {
  for (let attempt = 0; attempt < 4; attempt++) {
    const observed = await store.observe(RETENTION_INDEX);
    const raw = observed.value as { ids?: unknown } | undefined;
    const current = Array.isArray(raw?.ids) ? raw!.ids.filter((id): id is string => validId(id, 128)) : [];
    const next = mutate(current).slice(-RETENTION_LIMIT);
    const written = await store.compareAndApply(RETENTION_INDEX, observed.comparison,
      { operation: 'update', action: 'set', value: { ids: next } });
    if (written.status === 'applied' || written.status === 'unchanged') return;
  }
  throw new Error('VSC_RETENTION_INDEX_CONFLICT');
}

export async function markPending(store: DocumentStore, record: PendingRetention): Promise<void> {
  const key = retentionRecordKey(record.effectId);
  const observed = await store.observe(key);
  const written = await store.compareAndApply(key, observed.comparison,
    { operation: 'update', action: 'set', value: record });
  if (written.status !== 'applied' && written.status !== 'unchanged') throw new Error('VSC_RETENTION_RECORD_CONFLICT');
  await updateIndex(store, ids => [...ids.filter(id => id !== record.effectId), record.effectId]);
}

export async function clearPending(store: DocumentStore, effectId: string): Promise<void> {
  const key = retentionRecordKey(effectId);
  const observed = await store.observe(key);
  await store.compareAndApply(key, observed.comparison, { operation: 'update', action: 'set', value: null });
  await updateIndex(store, ids => ids.filter(id => id !== effectId));
}

export interface RetentionRetryOptions {
  store: DocumentStore;
  fetchMessages: (sessionKey: string, limit: number) => Promise<unknown[]>;
  /** Idempotent payload write; throws when the payload is not provably stored. */
  write: (payload: { effectId: string; runId: string; sessionKey: string; messages: unknown[] }) => Promise<void>;
  now: () => number;
  log?: (detail: string) => void;
}

/** One bounded pass over pending payloads. Never touches execution terminality. */
export async function retryPendingResults(options: RetentionRetryOptions): Promise<{ retried: number; retained: number }> {
  const observed = await options.store.observe(RETENTION_INDEX);
  const ids = parseRetentionIndex(observed.value);
  let retried = 0; let retained = 0;
  for (const effectId of ids) {
    const recordKey = retentionRecordKey(effectId);
    const recordValue = await options.store.observe(recordKey);
    const record = parseRetentionRecord(recordValue.value);
    if (!record) { await clearPending(options.store, effectId).catch(() => undefined); continue; }
    // An exhausted obligation waits for an operator; it is not retried automatically.
    if (record.attempts >= RETENTION_MAX_ATTEMPTS) {
      await updateIndex(options.store, list => list.filter(id => id !== effectId)).catch(() => undefined);
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
      // Stop retrying a permanently unavailable session; leave the record for an operator.
      if (next.attempts >= RETENTION_MAX_ATTEMPTS) {
        await options.store.compareAndApply(recordKey, recordValue.comparison,
          { operation: 'update', action: 'set', value: next });
        options.log?.(`retention-exhausted ${effectId}`);
        await updateIndex(options.store, list => list.filter(id => id !== effectId)).catch(() => undefined);
        continue;
      }
      await options.store.compareAndApply(recordKey, recordValue.comparison,
        { operation: 'update', action: 'set', value: next });
      options.log?.(`retention-retry-failed ${effectId}`);
    }
  }
  return { retried, retained };
}
