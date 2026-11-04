import { describe, expect, it } from 'vitest';
import { configureChannel, createState, addUnit } from './kernel.js';
import { step } from './runtime.js';
import { bootstrapDocument, readDocument, type DocumentStore } from './state.js';
import { VsmService } from './service.js';
import { canaryObservations, sampleCanary, CANARY_THRESHOLDS } from './canary.js';
import { createFakeExecutor, fakeComplete, fakeDispatch, fakeReconcile, fakeRestart } from './executor.js';
import type { Actor, Grant, VsmEvent, VsmState } from './types.js';
import type { NativeExecutor } from './executor.js';

const principal: Actor = { kind: 'principal', id: 'human' };
const parent: Actor = { kind: 'organ', unitId: 'root', role: 'S3' };
const base = () => createState({ rootId: 'root', principalId: 'human', charter: 'Synthetic obligation', now: 0 });
const fixture = () => addUnit(base(), { id: 'a', parentId: 'root', exits: { delivered: 0, abandoned: 0 } });
const inputChannel = 'a/environment/return';
const procedureId = 'a/seed/operation';
const grant = (id = 'g', capacity = 2): Grant => ({
  id, version: 1, unitId: 'a', issuer: parent, procedureIds: [procedureId], tools: ['synthetic'],
  surfaces: [], capacity, validFrom: 0, validUntil: 1_000_000, revokedAt: null,
});
function ready(threshold = 1): VsmState {
  let state = configureChannel(fixture(), inputChannel, { procedureId, threshold });
  const result = step(state, { id: 'grant', type: 'grant.changed', actor: parent, grant: grant() }, 1);
  expect(result.errors).toEqual([]);
  return result.state;
}
const obs = (id: string, evidence = 1): VsmEvent => ({
  id, type: 'observation', channelId: inputChannel, index: 1, evidence, topic: 'change', evidenceRef: `trace:${id}`,
});

class MemoryStore implements DocumentStore {
  value: unknown = undefined;
  version = 0;
  conflicts = 0;
  failNextObserve = false;
  async observe(_key: string) {
    if (this.failNextObserve) { this.failNextObserve = false; throw new Error('STORAGE_DOWN'); }
    return { value: structuredClone(this.value), comparison: { version: this.version } };
  }
  async compareAndApply(_key: string, comparison: unknown,
    mutation: { operation: 'update'; action: 'set'; value: unknown }) {
    if ((comparison as { version: number }).version !== this.version) return { status: 'conflict' as const };
    if (this.conflicts > 0) { this.conflicts--; return { status: 'conflict' as const }; }
    this.value = structuredClone(mutation.value);
    this.version++;
    return { status: 'applied' as const };
  }
}

function fakeExecutor() {
  const fake = { state: createFakeExecutor() };
  const calls = { dispatch: 0, reconcile: 0 };
  const executor: NativeExecutor = {
    async dispatch(request) {
      calls.dispatch++;
      const result = fakeDispatch(fake.state, request);
      fake.state = result.state;
      return result.result;
    },
    async reconcile(request) {
      calls.reconcile++;
      return fakeReconcile(fake.state, request);
    },
  };
  return { fake, calls, executor };
}

describe('durable VSM service', () => {
  it('persists the receipt before returning and never dispatches twice', async () => {
    const store = new MemoryStore();
    await bootstrapDocument(store, ready());
    const { fake, calls, executor } = fakeExecutor();
    const service = new VsmService({ store, executor, clock: () => 100 });
    await service.start();
    await service.apply(obs('fire'));
    const effectId = Object.keys(service.state.effects)[0];
    const effect = service.state.effects[effectId];
    expect(effect.status).toBe('accepted');
    expect(effect.receipt?.nativeId).toBe(`native:${effectId}`);
    expect(calls.dispatch).toBe(1);
    const revision = service.state.revision;
    await service.apply(obs('fire'));
    expect(service.state.revision).toBe(revision);
    expect(calls.dispatch).toBe(1);
    expect(readDocument(store.value)?.state.effects[effectId].status).toBe('accepted');
    expect(fake.state.launches).toBe(1);
  });

  it('reconciles accepted work after restart instead of redispatching', async () => {
    const store = new MemoryStore();
    await bootstrapDocument(store, ready());
    const first = fakeExecutor();
    const service = new VsmService({ store, executor: first.executor, clock: () => 100 });
    await service.start();
    await service.apply(obs('fire'));
    const effectId = Object.keys(service.state.effects)[0];
    first.fake.state = fakeComplete(first.fake.state, effectId,
      { value: 1, evidenceRef: 'evidence:outcome', at: 110 }, true, 'evidence:environment');

    const second = fakeExecutor();
    // The native ledger survives the process restart; only in-process delivery state resets.
    second.fake.state = fakeRestart(first.fake.state);
    const restarted = new VsmService({ store, executor: second.executor, clock: () => 200 });
    await restarted.start();
    expect(second.calls.reconcile).toBe(1);
    expect(second.calls.dispatch).toBe(0);
    expect(restarted.state.effects[effectId].status).toBe('succeeded');
    expect(restarted.state.effects[effectId].environmentReturn?.evidenceRef).toBe('evidence:environment');
  });

  it('treats an executor exception as ambiguous and never retries it', async () => {
    const store = new MemoryStore();
    await bootstrapDocument(store, ready());
    let dispatches = 0;
    const executor: NativeExecutor = {
      async dispatch() { dispatches++; throw new Error('native unavailable'); },
      async reconcile() { return { status: 'unknown' }; },
    };
    const service = new VsmService({ store, executor, clock: () => 100 });
    await service.start();
    await service.apply(obs('fire'));
    const effectId = Object.keys(service.state.effects)[0];
    expect(service.state.effects[effectId].status).toBe('ambiguous');
    expect(dispatches).toBe(1);
  });

  it('calls the alarm sink without passing channel filters', async () => {
    const store = new MemoryStore();
    await bootstrapDocument(store, ready());
    const alarms: string[] = [];
    const service = new VsmService({
      store, executor: fakeExecutor().executor, clock: () => 100,
      alarmSink: action => alarms.push(action.alarmId),
    });
    await service.start();
    await service.apply({
      id: 'alarm-1', type: 'alarm.raised', alarmId: 'alarm:1', unitId: 'a', alarmClass: 'health.ready',
      severity: 10, localThreshold: 1, falseAlarmCost: 1, delayCost: 10, evidenceRef: 'trace:alarm',
    });
    expect(alarms).toContain('alarm:1');
    expect(service.state.alarms['alarm:1'].state).toBe('raised');
  });

  it('stops without erasing durable state', async () => {
    const store = new MemoryStore();
    await bootstrapDocument(store, ready());
    const service = new VsmService({ store, executor: fakeExecutor().executor, clock: () => 100 });
    await service.start();
    await service.stop();
    expect(readDocument(store.value)?.state.units.root).toBeDefined();
    await expect(service.apply(obs('after-stop'))).rejects.toThrow('VSC_VSM_NOT_STARTED');
  });
});

describe('canary purpose', () => {
  it('turns a healthy sample into negative drift and a fault into positive evidence', () => {
    const healthy = canaryObservations({
      at: 1,
      readyz: { status: 200, latencyMs: 10, error: false },
      disk: { usedRatio: 0.5 },
      inodes: { usedRatio: 0.2 },
    });
    expect(healthy.map(o => o.topic)).toEqual(['health.ready', 'health.disk', 'health.inodes']);
    expect(healthy.every(o => o.evidence < 0)).toBe(true);
    const faulting = canaryObservations({
      at: 2,
      readyz: { status: null, latencyMs: null, error: true },
      disk: { usedRatio: CANARY_THRESHOLDS.diskUsedRatio + 0.01 },
      inodes: { usedRatio: 0.1 },
    });
    expect(faulting[0].evidence).toBeGreaterThan(0);
    expect(faulting[1].evidence).toBeGreaterThan(0);
    expect(faulting[2].evidence).toBeLessThan(0);
    expect(faulting.every(o => o.evidenceRef.startsWith('canary:2:'))).toBe(true);
  });

  it('keeps absent counters as evidence instead of a healthy reading', async () => {
    const sample = await sampleCanary({
      now: 5, readyzUrl: 'http://127.0.0.1:1/readyz', filesystemPath: '/definitely/missing/path',
      fetch: async () => { throw new Error('offline'); },
    });
    expect(sample.readyz.error).toBe(true);
    expect(sample.disk.usedRatio).toBeNull();
    expect(sample.inodes.usedRatio).toBeNull();
    expect(canaryObservations(sample).every(o => o.evidence > 0)).toBe(true);
  });
});
