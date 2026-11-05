import { describe, expect, it } from 'vitest';
import { RETENTION_INDEX, RETENTION_MAX_ATTEMPTS, markPending, clearPending, parseRetentionIndex,
  parseRetentionRecord, retryPendingResults, retentionRecordKey, type PendingRetention } from './retention.js';
import type { DocumentStore } from './vsm/state.js';

class MemoryStore implements DocumentStore {
  data = new Map<string, unknown>();
  async observe(key: string) { return { value: structuredClone(this.data.get(key)), comparison: { key } }; }
  async compareAndApply(key: string, _comparison: unknown, mutation: { operation: 'update'; action: 'set'; value: unknown }) {
    this.data.set(key, structuredClone(mutation.value));
    return { status: 'applied' as const };
  }
}

const record = (patch: Partial<PendingRetention> = {}): PendingRetention => ({
  effectId: 'canary/local/forward/effect/1', runId: 'run-1', sessionKey: 'agent:main:subagent:x',
  attempts: 0, lastAt: 100, ...patch,
});

describe('result retention obligation', () => {
  it('bounds and dedupes the pending index and rejects malformed records', () => {
    expect(parseRetentionIndex(undefined)).toEqual([]);
    expect(parseRetentionIndex({ ids: ['a', 'a', 'b', 7, 'bad\nid'] })).toEqual(['a', 'b']);
    expect(parseRetentionIndex({ ids: Array.from({ length: 40 }, (_, i) => `id${i}`) })).toHaveLength(32);
    expect(parseRetentionRecord(undefined)).toBeUndefined();
    expect(parseRetentionRecord({ effectId: 'x', runId: 'r', sessionKey: 's', attempts: RETENTION_MAX_ATTEMPTS + 1, lastAt: 1 })).toBeUndefined();
    expect(parseRetentionRecord({ effectId: 'x', runId: 'r', sessionKey: 's', attempts: RETENTION_MAX_ATTEMPTS, lastAt: 1 })?.attempts)
      .toBe(RETENTION_MAX_ATTEMPTS);
    expect(parseRetentionRecord({ effectId: 'x', runId: 'r', sessionKey: 's', attempts: 1, lastAt: 1 })).toEqual(
      { effectId: 'x', runId: 'r', sessionKey: 's', attempts: 1, lastAt: 1 });
  });

  it('marks and clears one obligation without losing the others', async () => {
    const store = new MemoryStore();
    await markPending(store, record());
    await markPending(store, record({ effectId: 'canary/local/forward/effect/2', runId: 'run-2' }));
    expect(parseRetentionIndex(store.data.get(RETENTION_INDEX))).toEqual([
      'canary/local/forward/effect/1', 'canary/local/forward/effect/2']);
    await clearPending(store, 'canary/local/forward/effect/1');
    expect(parseRetentionIndex(store.data.get(RETENTION_INDEX))).toEqual(['canary/local/forward/effect/2']);
    expect(store.data.get(retentionRecordKey('canary/local/forward/effect/1'))).toBeNull();
  });

  it('retains a payload on a later pass and clears the obligation', async () => {
    const store = new MemoryStore();
    await markPending(store, record());
    const stored: string[] = [];
    let failFirst = true;
    const write = async (payload: { effectId: string }) => {
      if (failFirst) { failFirst = false; throw new Error('storage-fault'); }
      stored.push(payload.effectId);
    };
    const fetchMessages = async () => [{ role: 'assistant', content: 'host is up' }];
    const first = await retryPendingResults({ store, fetchMessages, write, now: () => 200 });
    expect(first).toEqual({ retried: 1, retained: 0 });
    expect(parseRetentionRecord(store.data.get(retentionRecordKey('canary/local/forward/effect/1')))?.attempts).toBe(1);
    const second = await retryPendingResults({ store, fetchMessages, write, now: () => 300 });
    expect(second).toEqual({ retried: 1, retained: 1 });
    expect(stored).toEqual(['canary/local/forward/effect/1']);
    expect(parseRetentionIndex(store.data.get(RETENTION_INDEX))).toEqual([]);
  });

  it('gives up after the bounded attempt count and keeps the record for an operator', async () => {
    const store = new MemoryStore();
    await markPending(store, record({ attempts: RETENTION_MAX_ATTEMPTS - 1 }));
    const write = async () => { throw new Error('permanent'); };
    const result = await retryPendingResults({ store, fetchMessages: async () => [], write, now: () => 400, log: () => undefined });
    expect(result).toEqual({ retried: 1, retained: 0 });
    expect(parseRetentionIndex(store.data.get(RETENTION_INDEX))).toEqual([]);
    expect(parseRetentionRecord(store.data.get(retentionRecordKey('canary/local/forward/effect/1')))?.attempts)
      .toBe(RETENTION_MAX_ATTEMPTS);
  });
});
