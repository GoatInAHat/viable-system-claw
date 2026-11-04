import { describe, expect, it } from 'vitest';
import { buildRuntime, CANARY_CHANNEL, DISPATCH_CHANNEL, PROBE_PROCEDURE, ensureRootState, readRuntimeConfig } from './runtime.js';
import { readDocument, type DocumentStore } from './vsm/state.js';
import { intentKey } from './vsm/intent-store.js';
import type { NativeExecutor } from './vsm/executor.js';
import type { DispatchRequest } from './vsm/executor.js';

class MemoryStore implements DocumentStore {
  data = new Map<string, unknown>();
  async observe(key: string) { return { value: structuredClone(this.data.get(key)), comparison: { key } }; }
  async compareAndApply(key: string, _comparison: unknown, mutation: { operation: 'update'; action: 'set'; value: unknown }) {
    this.data.set(key, structuredClone(mutation.value));
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
const faulty = async () => ({
  at: 100,
  readyz: { status: null, latencyMs: null, error: true },
  disk: { usedRatio: 0.99 },
  inodes: { usedRatio: 0.99 },
});

const base = { principalId: 'human', charter: 'Keep it observable' };

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

  it('validates an optional dispatch agent id', () => {
    expect(readRuntimeConfig({ runtime: { enabled: true, principalId: 'human', charter: 'x', agentId: 'canary' } }))
      .toEqual({ principalId: 'human', charter: 'x', agentId: 'canary' });
    expect(() => readRuntimeConfig({ runtime: { enabled: true, principalId: 'human', charter: 'x', agentId: 'Bad Agent' } }))
      .toThrow('VSC_RUNTIME_CONFIG');
  });
});

describe('root bootstrap', () => {
  it('creates the root and canary unit once', async () => {
    const store = new MemoryStore();
    await ensureRootState(store, base, 10);
    const first = readDocument(store.data.get('vsm-v1'));
    expect(first?.state.units.root.parentId).toBeNull();
    expect(first?.state.units.canary.parentId).toBe('root');
    expect(first?.state.channels[CANARY_CHANNEL].procedureId).toBeNull();
    await ensureRootState(store, { ...base, charter: 'Changed' }, 20);
    expect(readDocument(store.data.get('vsm-v1'))?.state.charter.text).toBe('Keep it observable');
  });

  it('adds the probe procedure exactly once and refuses an agent change', async () => {
    const store = new MemoryStore();
    await ensureRootState(store, { ...base, agentId: 'canary' }, 10);
    let document = readDocument(store.data.get('vsm-v1'));
    expect(document?.state.procedures[PROBE_PROCEDURE].executionRef).toBe('agent:canary');
    expect(document?.state.channels[DISPATCH_CHANNEL].procedureId).toBe(PROBE_PROCEDURE);
    await ensureRootState(store, { ...base, agentId: 'canary' }, 20);
    document = readDocument(store.data.get('vsm-v1'));
    expect(document?.state.procedures[PROBE_PROCEDURE].executionRef).toBe('agent:canary');
    await expect(ensureRootState(store, { ...base, agentId: 'other' }, 30)).rejects.toThrow('VSC_RUNTIME_AGENT_CHANGED');
  });

  it('upgrades an existing canary document with the probe without a second root', async () => {
    const store = new MemoryStore();
    await ensureRootState(store, base, 10);
    await ensureRootState(store, { ...base, agentId: 'canary' }, 20);
    const document = readDocument(store.data.get('vsm-v1'));
    expect(Object.keys(document!.state.units).sort()).toEqual(['canary', 'root']);
    expect(document?.state.procedures[PROBE_PROCEDURE]).toBeDefined();
  });
});

describe('canary runtime', () => {
  it('applies one bounded observation per measured variable and stops cleanly', async () => {
    const store = new MemoryStore();
    await ensureRootState(store, base, 10);
    const runtime = buildRuntime({ config: base, store, executor, clock: () => 100, sampler: healthy });
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
    await ensureRootState(store, base, 10);
    let dispatches = 0;
    const counting: NativeExecutor = {
      async dispatch() { dispatches++; return { status: 'not-launched' }; },
      async reconcile() { return { status: 'unknown' }; },
    };
    const runtime = buildRuntime({ config: base, store, executor: counting, clock: () => 100, sampler: faulty });
    await runtime.start();
    await runtime.sampleOnce();
    expect(dispatches).toBe(0);
    expect(runtime.service.state.effects).toEqual({});
    await runtime.stop();
  });




  it('keeps healthy operation bounded instead of exhausting the document budget', async () => {
    const store = new MemoryStore();
    await ensureRootState(store, base, 10);
    let t = 10;
    const runtime = buildRuntime({ config: base, store, executor, clock: () => (t += 30_000), sampler: async now => ({
      at: now, readyz: { status: 200, latencyMs: 12, error: false },
      disk: { usedRatio: 0.4 }, inodes: { usedRatio: 0.2 },
    }) });
    await runtime.start();
    for (let i = 0; i < 320; i++) await runtime.sampleOnce();
    const bytes = new TextEncoder().encode(JSON.stringify(runtime.service.state)).length;
    expect(bytes).toBeLessThan(200 * 1024);
    expect(runtime.service.state.decisions.length).toBeLessThanOrEqual(512);
    expect(Object.keys(runtime.service.state.seenEvents).length).toBeLessThanOrEqual(1024);
    expect(runtime.service.state.effects).toEqual({});
    await runtime.stop();
  }, 60_000);

  it('raises one algedonic alarm after three consecutive faulted samples', async () => {
    const store = new MemoryStore();
    await ensureRootState(store, base, 10);
    let t = 100;
    const alarms: string[] = [];
    const runtime = buildRuntime({
      config: base, store, executor, clock: () => (t += 10), onAlarm: action => alarms.push(action.alarmId),
      sampler: async now => ({
        at: now, readyz: { status: null, latencyMs: null, error: true },
        disk: { usedRatio: 0.99 }, inodes: { usedRatio: 0.99 },
      }),
    });
    await runtime.start();
    for (let i = 0; i < 3; i++) await runtime.sampleOnce();
    const raised = Object.values(runtime.service.state.alarms);
    expect(raised).toHaveLength(1);
    expect(raised[0].class).toBe('canary.host-health');
    expect(raised[0].state).toBe('raised');
    expect(alarms).toHaveLength(1);
    await runtime.sampleOnce();
    expect(Object.keys(runtime.service.state.alarms)).toHaveLength(1);
    await runtime.stop();
  });

  it('reconciles accepted probe work on the periodic pass', async () => {
    const store = new MemoryStore();
    const privateStore = new MemoryStore();
    const config = { ...base, agentId: 'canary' };
    await ensureRootState(store, config, 10);
    const dispatching: NativeExecutor = {
      async dispatch() { return { status: 'accepted', nativeId: 'run-probe-9', sessionKey: 'agent:canary:subagent:x' }; },
      async reconcile() {
        return {
          status: 'completed', nativeId: 'run-probe-9',
          outcome: { value: 1, evidenceRef: 'run:run-probe-9', at: 110 }, success: true,
          environmentEvidenceRef: 'evidence:env-probe',
        };
      },
    };
    const runtime = buildRuntime({ config, store, privateStore, executor: dispatching, clock: () => 100, sampler: faulty });
    await runtime.start();
    await runtime.sampleOnce();
    const effectId = Object.keys(runtime.service.state.effects)[0];
    expect(runtime.service.state.effects[effectId].receipt?.sessionKey).toBe('agent:canary:subagent:x');
    await runtime.reconcileOnce();
    expect(runtime.service.state.effects[effectId].status).toBe('succeeded');
    expect(runtime.service.state.effects[effectId].environmentReturn?.evidenceRef).toBe('evidence:env-probe');
    await runtime.stop();
  });

  it('commits a private intent and dispatches the probe when a fault crosses the threshold', async () => {
    const store = new MemoryStore();
    const privateStore = new MemoryStore();
    const config = { ...base, agentId: 'canary' };
    await ensureRootState(store, config, 10);
    const requests: DispatchRequest[] = [];
    const dispatching: NativeExecutor = {
      async dispatch(request) { requests.push(request); return { status: 'accepted', nativeId: 'run-probe-1' }; },
      async reconcile() { return { status: 'unknown' }; },
    };
    const runtime = buildRuntime({
      config, store, privateStore, executor: dispatching, clock: () => 100, sampler: faulty,
    });
    await runtime.start();
    await runtime.sampleOnce();
    expect(requests).toHaveLength(1);
    expect(requests[0].procedureId).toBe(PROBE_PROCEDURE);
    const effectId = requests[0].effectId;
    expect(runtime.service.state.effects[effectId].status).toBe('accepted');
    const intent = privateStore.data.get(intentKey(effectId)) as { agentId: string; message: string } | undefined;
    expect(intent?.agentId).toBe('canary');
    expect(intent?.message).toContain(effectId);
    await runtime.stop();
  });
});
