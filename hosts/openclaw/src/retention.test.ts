import { describe, expect, it } from 'vitest';
import { RETENTION_BACKUP, RETENTION_INDEX, RETENTION_MAX_ATTEMPTS, RETENTION_SCAN, markPending, clearPending,
  parseRetentionIndex, parseRetentionRecord, retryPendingResults, retentionRecordKey, type PendingRetention } from './retention.js';
import type { DocumentStore } from './vsm/state.js';

class MemoryStore implements DocumentStore {
  data = new Map<string, unknown>();
  async observe(key: string) { return { value: structuredClone(this.data.get(key)), comparison: { key } }; }
  async compareAndApply(key: string, _comparison: unknown, mutation: { operation: 'update'; action: 'set'; value: unknown }):
    Promise<{ status: 'applied' | 'conflict' | 'unchanged' }> {
    this.data.set(key, structuredClone(mutation.value));
    return { status: 'applied' };
  }
}

const record = (patch: Partial<PendingRetention> = {}): PendingRetention => ({
  effectId: 'canary/local/forward/effect/1', runId: 'run-1', sessionKey: 'agent:main:subagent:x',
  attempts: 0, lastAt: 100, ...patch,
});

describe('result retention obligation', () => {
  it('keeps every valid id and rejects malformed records', () => {
    expect(parseRetentionIndex(undefined)).toEqual([]);
    expect(parseRetentionIndex({ ids: ['a', 'a', 'b', 7, 'bad\nid'] })).toEqual(['a', 'b']);
    expect(parseRetentionIndex({ ids: Array.from({ length: 300 }, (_, i) => `id${i}`) })).toHaveLength(300);
    expect(parseRetentionRecord(undefined)).toBeUndefined();
    expect(parseRetentionRecord({ effectId: 'x', runId: 'r', sessionKey: 's', attempts: RETENTION_MAX_ATTEMPTS + 1, lastAt: 1 })).toBeUndefined();
    expect(parseRetentionRecord({ effectId: 'x', runId: 'r', sessionKey: 's', attempts: RETENTION_MAX_ATTEMPTS, lastAt: 1 })?.attempts)
      .toBe(RETENTION_MAX_ATTEMPTS);
  });

  it('never drops an existing obligation when the index is cleaned', async () => {
    const store = new MemoryStore();
    for (let index = 0; index < 40; index++) {
      await markPending(store, record({ effectId: `canary/local/forward/effect/${index}`, runId: `run-${index}` }));
    }
    expect(parseRetentionIndex(store.data.get(RETENTION_INDEX))).toHaveLength(40);
    for (let index = 0; index < 39; index++) await clearPending(store, `canary/local/forward/effect/${index}`);
    expect(parseRetentionIndex(store.data.get(RETENTION_INDEX))).toEqual(['canary/local/forward/effect/39']);
    expect(parseRetentionRecord(store.data.get(retentionRecordKey('canary/local/forward/effect/39')))?.attempts).toBe(0);
  });

  it('keeps the redundant copy in step with the primary', async () => {
    const store = new MemoryStore();
    await markPending(store, record());
    expect(parseRetentionIndex(store.data.get(RETENTION_BACKUP))).toEqual(['canary/local/forward/effect/1']);
    await clearPending(store, 'canary/local/forward/effect/1');
    expect(parseRetentionIndex(store.data.get(RETENTION_BACKUP))).toEqual([]);
  });

  it('repairs a malformed primary from the redundant copy', async () => {
    const store = new MemoryStore();
    await markPending(store, record());
    store.data.set(RETENTION_INDEX, { ids: 'corrupt' });
    const write = async () => undefined;
    const first = await retryPendingResults({ store, fetchMessages: async () => [{ role: 'assistant', content: 'up' }],
      write, now: () => 200 });
    expect(first).toEqual({ retried: 1, retained: 1 });
    expect(parseRetentionIndex(store.data.get(RETENTION_INDEX))).toEqual([]);
  });

  it('pages past the scan window instead of evicting', async () => {
    const store = new MemoryStore();
    const total = RETENTION_SCAN + 5;
    for (let index = 0; index < total; index++) {
      await markPending(store, record({ effectId: `canary/local/forward/effect/${index}`, runId: `run-${index}` }));
    }
    expect(parseRetentionIndex(store.data.get(RETENTION_INDEX))).toHaveLength(total);
    const retained: string[] = [];
    const write = async (payload: { effectId: string }) => { retained.push(payload.effectId); };
    const fetchMessages = async () => [{ role: 'assistant', content: 'up' }];
    const first = await retryPendingResults({ store, fetchMessages, write, now: () => 200 });
    expect(first.retained).toBe(RETENTION_SCAN);
    const second = await retryPendingResults({ store, fetchMessages, write, now: () => 300 });
    expect(second.retained).toBe(total - RETENTION_SCAN);
    expect(retained).toHaveLength(total);
    expect(parseRetentionIndex(store.data.get(RETENTION_INDEX))).toEqual([]);
  });

  it('converges through an explicit index CAS conflict', async () => {
    const store = new MemoryStore();
    let conflicts = 1;
    const apply = store.compareAndApply.bind(store);
    store.compareAndApply = async (key, comparison, mutation) => {
      if (key === RETENTION_INDEX && conflicts > 0) { conflicts--; return { status: 'conflict' as const }; }
      return apply(key, comparison, mutation);
    };
    await markPending(store, record());
    expect(parseRetentionIndex(store.data.get(RETENTION_INDEX))).toEqual(['canary/local/forward/effect/1']);
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
