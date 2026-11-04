import { describe, expect, it } from 'vitest';
import { buildRuntime, CANARY_CHANNEL, ensureRootState, readRuntimeConfig } from './runtime.js';
import { readDocument, type DocumentStore } from './vsm/state.js';
import type { NativeExecutor } from './vsm/executor.js';

class MemoryStore implements DocumentStore {
  value: unknown = undefined;
  version = 0;
  async observe(_key: string) { return { value: structuredClone(this.value), comparison: { version: this.version } }; }
  async compareAndApply(_key: string, comparison: unknown, mutation: { operation: 'update'; action: 'set'; value: unknown }) {
    if ((comparison as { version: number }).version !== this.version) return { status: 'conflict' as const };
    this.value = structuredClone(mutation.value); this.version++;
    return { status: 'applied' as const };
  }
}

const executor: NativeExecutor = {
  async dispatch() { return { status: 'not-launched' }; },
  async reconcile() { return { status: 'unknown' }; },
};

const healthy = async () => ({
  at: 100,
  readyz: { status: 200, latencyMs: 12, error: false },
  disk: { usedRatio: 0.4 },
  inodes: { usedRatio: 0.2 },
});

describe('runtime configuration', () => {
  it('adds no behavior unless runtime.enabled is exactly true', () => {
    expect(readRuntimeConfig(undefined, {})).toBeUndefined();
    expect(readRuntimeConfig({}, {})).toBeUndefined();
    expect(readRuntimeConfig({ runtime: { enabled: false, principalId: 'human', charter: 'x' } })).toBeUndefined();
    expect(readRuntimeConfig({ runtime: { enabled: 'true', principalId: 'human', charter: 'x' } })).toBeUndefined();
  });

  it('accepts the operator environment switch with the same validation', () => {
    expect(readRuntimeConfig(undefined, { VSC_RUNTIME_ENABLED: '1', VSC_RUNTIME_PRINCIPAL_ID: 'human', VSC_RUNTIME_CHARTER: 'Keep it observable' }))
      .toEqual({ principalId: 'human', charter: 'Keep it observable' });
    expect(readRuntimeConfig(undefined, { VSC_RUNTIME_ENABLED: '0' })).toBeUndefined();
    expect(() => readRuntimeConfig(undefined, { VSC_RUNTIME_ENABLED: '1', VSC_RUNTIME_PRINCIPAL_ID: 'human' })).toThrow('VSC_RUNTIME_CONFIG');
  });

  it('refuses an enabled runtime without a principal and charter', () => {
    expect(() => readRuntimeConfig({ runtime: { enabled: true } })).toThrow('VSC_RUNTIME_CONFIG');
    expect(() => readRuntimeConfig({ runtime: { enabled: true, principalId: 'human' } })).toThrow('VSC_RUNTIME_CONFIG');
    expect(() => readRuntimeConfig({ runtime: { enabled: true, principalId: ' ', charter: 'x' } })).toThrow('VSC_RUNTIME_CONFIG');
    expect(() => readRuntimeConfig({ runtime: { enabled: true, principalId: 'human', charter: ' ' } })).toThrow('VSC_RUNTIME_CONFIG');
  });

  it('returns the validated pair when enabled', () => {
    expect(readRuntimeConfig({ runtime: { enabled: true, principalId: 'human', charter: 'Keep it observable' } }))
      .toEqual({ principalId: 'human', charter: 'Keep it observable' });
  });
});

describe('root bootstrap', () => {
  it('creates the root and canary unit once', async () => {
    const store = new MemoryStore();
    await ensureRootState(store, { principalId: 'human', charter: 'Keep it observable' }, 10);
    const first = readDocument(store.value);
    expect(first?.state.units.root.parentId).toBeNull();
    expect(first?.state.units.canary.parentId).toBe('root');
    expect(first?.state.channels[CANARY_CHANNEL].procedureId).toBeNull();
    await ensureRootState(store, { principalId: 'human', charter: 'Changed' }, 20);
    expect(readDocument(store.value)?.state.charter.text).toBe('Keep it observable');
  });
});

describe('canary runtime', () => {
  it('applies one bounded observation per measured variable and stops cleanly', async () => {
    const store = new MemoryStore();
    await ensureRootState(store, { principalId: 'human', charter: 'Keep it observable' }, 10);
    const runtime = buildRuntime({ config: { principalId: 'human', charter: 'Keep it observable' }, store, executor, clock: () => 100, sampler: healthy });
    await runtime.start();
    await runtime.sampleOnce();
    const channel = runtime.service.state.channels[CANARY_CHANNEL];
    expect(channel.accumulator.observations).toBe(3);
    expect(channel.accumulator.evidenceRefs).toHaveLength(3);
    expect(runtime.service.state.decisions.length).toBeGreaterThan(0);
    await runtime.stop();
    await expect(runtime.service.apply({ id: 'after-stop', type: 'restart' })).rejects.toThrow('VSC_VSM_NOT_STARTED');
  });

  it('does not dispatch when the canary has no executable procedure', async () => {
    const store = new MemoryStore();
    await ensureRootState(store, { principalId: 'human', charter: 'Keep it observable' }, 10);
    let dispatches = 0;
    const counting: NativeExecutor = {
      async dispatch() { dispatches++; return { status: 'not-launched' }; },
      async reconcile() { return { status: 'unknown' }; },
    };
    const runtime = buildRuntime({
      config: { principalId: 'human', charter: 'Keep it observable' }, store, executor: counting,
      clock: () => 100, sampler: async () => ({
        at: 100, readyz: { status: null, latencyMs: null, error: true },
        disk: { usedRatio: 0.99 }, inodes: { usedRatio: 0.99 },
      }),
    });
    await runtime.start();
    await runtime.sampleOnce();
    expect(dispatches).toBe(0);
    expect(runtime.service.state.effects).toEqual({});
    await runtime.stop();
  });
});
