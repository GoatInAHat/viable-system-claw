import { describe, expect, it } from 'vitest';
import { assertIntent, intentKey, readIntent, writeIntent, type StoredIntent } from './intent-store.js';
import type { DocumentStore } from './state.js';
import type { EffectIntent } from '../execution/types.js';

class MemoryStore implements DocumentStore {
  data = new Map<string, unknown>();
  failNextWrite = false;
  async observe(key: string) { return { value: structuredClone(this.data.get(key)), comparison: { key } }; }
  async compareAndApply(key: string, _comparison: unknown, mutation: { value: unknown }) {
    if (this.failNextWrite) { this.failNextWrite = false; throw new Error('STORAGE_DOWN'); }
    this.data.set(key, structuredClone(mutation.value));
    return { status: 'applied' as const };
  }
}

const intent = (overrides: Partial<StoredIntent> = {}): StoredIntent => ({
  id: 'a/environment/return/effect/1', unitId: 'a', procedureId: 'a/probe', agentId: 'canary',
  message: 'Report host health in one line.', purpose: 'canary probe', grantRef: 'g:1', createdAt: 10,
  sessionKey: 'agent:canary:subagent:viable-system-claw-effect-abc',
  ...overrides,
});

describe('private launch intent', () => {
  it('stores one bounded record under the private namespace key', async () => {
    const store = new MemoryStore();
    await writeIntent(store, intent());
    expect(store.data.has(intentKey('a/environment/return/effect/1'))).toBe(true);
    expect(await readIntent(store, 'a/environment/return/effect/1')).toEqual(intent());
    expect(await readIntent(store, 'unknown')).toBeUndefined();
  });

  it('is write-once and idempotent for the same intent', async () => {
    const store = new MemoryStore();
    await writeIntent(store, intent());
    await writeIntent(store, intent());
    await expect(writeIntent(store, intent({ message: 'different' }))).rejects.toThrow('VSC_INTENT_CONFLICT');
  });

  it('propagates a storage fault instead of claiming a marker', async () => {
    const store = new MemoryStore();
    store.failNextWrite = true;
    await expect(writeIntent(store, intent())).rejects.toThrow('STORAGE_DOWN');
    expect(await readIntent(store, intent().id)).toBeUndefined();
  });

  it('rejects unbounded or malformed identity fields', () => {
    expect(() => assertIntent(intent({ agentId: 'Bad Agent' }))).toThrow('VSC_INTENT_AGENT');
    expect(() => assertIntent(intent({ message: ' ' }))).toThrow('VSC_INTENT_MESSAGE');
    expect(() => assertIntent(intent({ purpose: '' }))).toThrow('VSC_INTENT_PURPOSE');
    expect(() => assertIntent(intent({ createdAt: -1 }))).toThrow('VSC_INTENT_TIME');
    expect(() => assertIntent(intent({ deadline: 5 }))).toThrow('VSC_INTENT_DEADLINE');
    expect(() => assertIntent(intent({ message: 'x'.repeat(40_000) }))).toThrow('VSC_INTENT_MESSAGE');
    expect(() => assertIntent(intent({ sessionKey: 'bad key' }))).toThrow('VSC_INTENT_SESSION');
  });
});
