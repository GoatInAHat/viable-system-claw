import { describe, expect, it, vi } from 'vitest';
import type { OpenClawPluginApi } from 'openclaw/plugin-sdk/core';
import { emptyDocument } from './backend/store.js';
import entry, { contract } from './index.js';

function registration(initial?: unknown) {
  const services: Array<{ id: string; start: (context: unknown) => unknown; stop?: (context: unknown) => unknown }> = [];
  const actions = new Map<string, { requiredScopes: string[]; handler: (context: unknown) => Promise<unknown> }>();
  const hooks = new Map<string, (...args: unknown[]) => Promise<unknown>>();
  const subscriptions: Array<{ payload: string; streams: string[]; handle: (...args: unknown[]) => Promise<unknown> }> = [];
  let stored: unknown = initial; let version = 0; let fail = false;
  const store = {
    lookup: async () => structuredClone(stored),
    observe: async () => { if (fail) throw new Error('PRIVATE storage detail'); return { value: structuredClone(stored), comparison: String(version) }; },
    compareAndApply: async (_key: string, comparison: string, intent: { value: unknown }) => {
      if (comparison !== String(version)) return { status: 'conflict' };
      stored = structuredClone(intent.value); version++;
      return { status: 'applied' };
    },
  };
  const openStore = vi.fn(() => store);
  const sessionReader = vi.fn(async () => ({ sessionId: 'native-incarnation' }));
  const warn = vi.fn(); const emit = vi.fn();
  const api = {
    id: 'viable-system-claw', logger: { warn },
    runtime: { state: { openKeyedStoreV2: openStore }, agent: { session: { getSessionEntryAsync: sessionReader } } },
    registerService: (service: typeof services[number]) => services.push(service),
    registerSessionAction: (action: { id: string; requiredScopes: string[]; handler: (context: unknown) => Promise<unknown> }) => actions.set(action.id, action),
    registerTool: vi.fn(), on: (name: string, handler: (...args: unknown[]) => Promise<unknown>) => hooks.set(name, handler),
    agent: { events: { registerAgentEventSubscription: (subscription: typeof subscriptions[number]) => subscriptions.push(subscription) } },
  };
  entry.register(api as unknown as OpenClawPluginApi);
  async function start() { for (const service of services) await service.start({ gatewayEvents: { emit } }); }
  async function invoke(name: string, payload: unknown, client?: unknown) {
    return actions.get(name)!.handler({ pluginId: contract.pluginId, actionId: name, payload, client });
  }
  return { services, actions, hooks, subscriptions, openStore, sessionReader, warn, emit, start, invoke, readStored: () => structuredClone(stored), failStorage: () => { fail = true; } };
}

describe('public native plugin registration', () => {
  it('uses the exact installed feature/session-action, retained-state and service APIs', async () => {
    const registered = registration();
    expect(registered.openStore).toHaveBeenCalledWith({ namespace: 'organization', retention: 'retained' });
    expect([...registered.actions.keys()].sort()).toEqual(Object.keys(contract.operations).sort());
    expect(registered.actions.get('graph.snapshot')?.requiredScopes).toEqual(['operator.read']);
    expect(registered.actions.get('unit.bind-session')?.requiredScopes).toEqual(['operator.write']);
    expect(registered.services.map(service => service.id)).toContain('viable-system-claw:backend');
    expect(registered.subscriptions[0]).toMatchObject({ streams: ['lifecycle', 'tool', 'error'], payload: 'metadata' });
    await registered.start();
    expect(await registered.invoke('graph.snapshot', {})).toMatchObject({ ok: true, result: { units: [], activities: [], coverage: 'partial' } });
    await registered.invoke('unit.upsert', { id: 'u', name: 'Unit', purpose: '' });
    expect(registered.emit).toHaveBeenCalledWith('changed', expect.objectContaining({ area: 'graph' }), { scope: 'operator.read' });
  });
  it('validates feature inputs and verifies bindings through the public async reader', async () => {
    const registered = registration(); await registered.start();
    expect(await registered.invoke('unit.upsert', { id: 'u', name: 'Unit', purpose: '', raw: 'PRIVATE' })).toMatchObject({ ok: false, code: 'INVALID_INPUT' });
    await registered.invoke('unit.upsert', { id: 'u', name: 'Unit', purpose: '' });
    expect(await registered.invoke('unit.bind-session', { unitId: 'u', session: { sessionKey: 'agent:main:test', agentId: 'main' } })).toMatchObject({ ok: true });
    expect(registered.sessionReader).toHaveBeenCalledWith({ sessionKey: 'agent:main:test', agentId: 'main', readConsistency: 'latest', hydrateSkillPromptRefs: false });
    await expect(registered.invoke('unit.bind-session', { unitId: 'u', session: { sessionKey: 'agent:restricted:test', agentId: 'restricted' } }, { allowsAgent: () => false })).rejects.toThrow('cannot access');
  });
  it('refuses restricted graph/compute reads and edits of already-bound disallowed units', async () => {
    const r = registration(); await r.start();
    await r.invoke('unit.upsert', { id: 'u', name: 'Private unit', purpose: '' });
    await r.invoke('unit.bind-session', { unitId: 'u', session: { sessionKey: 'agent:restricted:test', agentId: 'restricted' } });
    const client = { allowsAgent: (id: string) => id === 'main' };
    for (const [operation, payload] of [
      ['graph.snapshot', {}], ['compute.snapshot', {}],
      ['unit.upsert', { id: 'u', name: 'Changed', purpose: '' }],
      ['unit.bind-session', { unitId: 'u', session: null }],
      ['relation.upsert', { id: 'r', source: 'u', target: 'u', kind: 'audit' }],
      ['compute.observe', { pools: [], models: [], allocations: [] }],
    ] as const) await expect(r.invoke(operation, payload, client)).rejects.toThrow('cannot access');
    expect(await r.invoke('graph.snapshot', {})).toMatchObject({ result: { units: [{ name: 'Private unit' }] } });
  });

  it('plans against retained snapshots and server time without dispatch or supplied clock overrides', async () => {
    const r = registration(); await r.start();
    await r.invoke('unit.upsert', { id: 'u', name: 'Unit', purpose: '' });
    await r.invoke('compute.observe', { pools: [], models: [], allocations: [] });
    const input = {
      request: { allocationId: 'plan', unitId: 'u', taskClass: 'test', requiredCapabilities: [], minimumQuality: 0, expectedContribution: 1 },
      policy: { telemetryMaxAgeMs: 60000, profileMaxAgeMs: 60000, qualityMaxAgeMs: 60000, estimateMaxAgeMs: 60000, minimumQualitySamples: 1, qualityAlpha: .05, weights: { quota: 1, latency: 0, capacity: 0, money: 1 }, prices: {} },
      state: { commitments: [], quality: [], quotaEstimates: [], quotaObservations: [], seenEvidenceIds: [] },
    };
    expect(await r.invoke('compute.plan', input)).toMatchObject({ ok: true, result: { kind: 'blocked', reasons: ['no-models'] } });
    expect(await r.invoke('compute.plan', { ...input, now: 0 })).toMatchObject({ ok: false, code: 'INVALID_INPUT' });
    expect(await r.invoke('compute.snapshot', {})).toMatchObject({ result: { allocations: [] } });
  });

  it('rejects byte-budget growth before commit and keeps the previous graph readable', async () => {
    const r = registration(); await r.start();
    let refused = false;
    for (let index = 0; index < 128; index++) {
      const before = r.readStored();
      try {
        expect(await r.invoke('unit.upsert', { id: `u${index}`, name: 'N'.repeat(160), purpose: 'P'.repeat(2000) })).toMatchObject({ ok: true });
      } catch (error) {
        expect(String(error)).toContain('transport budget');
        expect(r.readStored()).toEqual(before); refused = true; break;
      }
    }
    expect(refused).toBe(true);
    expect(await r.invoke('graph.snapshot', {})).toMatchObject({ ok: true });
    // Shrinking content restores room; no destructive reset is necessary.
    expect(await r.invoke('unit.upsert', { id: 'u0', name: 'Short', purpose: '' })).toMatchObject({ ok: true });
  });
  it('rejects graph node-budget growth atomically through the real feature wrapper', async () => {
    const document = emptyDocument();
    document.units = Array.from({ length: 128 }, (_, n) => ({ id: `u${n}`, name: 'U', purpose: '', status: 'idle' as const, updatedAt: 0 }));
    document.relations = Array.from({ length: 512 }, (_, n) => ({ id: `r${n}`, source: 'u0', target: 'u1', kind: 'audit' as const, label: '' }));
    const r = registration(document); await r.start();
    expect(await r.invoke('graph.snapshot', {})).toMatchObject({ ok: true });
    let refused = false;
    for (let index = 0; index < 128; index++) {
      const before = r.readStored();
      try { expect(await r.invoke('unit.bind-session', { unitId: `u${index}`, session: { agentId: 'main', sessionKey: `agent:main:u${index}` } })).toMatchObject({ ok: true }); }
      catch (error) { expect(String(error)).toContain('transport budget'); expect(r.readStored()).toEqual(before); refused = true; break; }
    }
    expect(refused).toBe(true);
    expect(await r.invoke('graph.snapshot', {})).toMatchObject({ ok: true });
  });
  it('pages expanded compute diagnostics through the real SDK without changing state', async () => {
    const r = registration(); await r.start();
    await r.invoke('unit.upsert', { id: 'u', name: 'U', purpose: '' });
    const at = Date.now();
    const input = {
      pools: [{ id: 'p', label: 'P', kind: 'subscription', observedAt: at, status: 'available', windows: Array.from({ length: 16 }, (_, n) => ({ id: `w${n}`, label: 'W', usedFraction: 0 })) }],
      models: Array.from({ length: 64 }, (_, n) => ({ id: `m${n}`, poolId: 'p', label: 'M', capabilities: [], observedAt: at, samples: 0 })), allocations: [],
    };
    expect(await r.invoke('compute.observe', input)).toMatchObject({ ok: true });
    const before = r.readStored();
    const plan = {
      request: { allocationId: 'plan', unitId: 'u', taskClass: 'test', requiredCapabilities: [], minimumQuality: 0, expectedContribution: 1 },
      policy: { telemetryMaxAgeMs: 60000, profileMaxAgeMs: 60000, qualityMaxAgeMs: 60000, estimateMaxAgeMs: 60000, minimumQualitySamples: 1, qualityAlpha: .05, weights: { quota: 1, latency: 0, capacity: 0, money: 1 }, prices: {} },
      state: { commitments: [], quality: [], quotaEstimates: [], quotaObservations: [], seenEvidenceIds: [] },
    };
    let offset = 0;
    const seen: string[] = [];
    do {
      const response = await r.invoke('compute.plan', { ...plan, diagnosticOffset: offset }) as { ok: boolean; result: { kind: string; candidates: { modelId: string }[]; diagnostics: { nextOffset: number | null; candidateCount: number }; snapshotRevision: number } };
      expect(response.ok).toBe(true); expect(response.result.kind).toBe('blocked');
      expect(response.result.diagnostics.candidateCount).toBe(64);
      expect(response.result.candidates.length).toBeGreaterThan(0);
      seen.push(...response.result.candidates.map(candidate => candidate.modelId));
      offset = response.result.diagnostics.nextOffset ?? 64;
    } while (offset < 64);
    expect(new Set(seen).size).toBe(64);
    expect(seen).toHaveLength(64);
    expect(r.readStored()).toEqual(before);
    expect(await r.invoke('compute.snapshot', {})).toMatchObject({ ok: true });
  });

  it('isolates projection/storage failures from native subscriptions and hooks without logging payloads', async () => {
    const registered = registration(); await registered.start(); registered.failStorage();
    const event = { sessionKey: 'agent:main:test', agentId: 'main', runId: 'run-1', stream: 'lifecycle', seq: 1, ts: 1000, data: { phase: 'start', text: 'PRIVATE' } };
    await expect(registered.subscriptions[0].handle(event, {})).resolves.toBeUndefined();
    await expect(registered.hooks.get('after_tool_call')!({ toolName: 'read', runId: 'run-1', toolCallId: 'call-1', params: { token: 'PRIVATE' }, result: 'PRIVATE' }, { sessionKey: 'agent:main:test' })).resolves.toBeUndefined();
    await expect(registered.hooks.get('agent_end')!({ success: false, messages: ['PRIVATE'], error: 'PRIVATE' }, { sessionKey: 'agent:main:test', runId: 'run-1' })).resolves.toBeUndefined();
    expect(registered.warn).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(registered.warn.mock.calls)).not.toContain('PRIVATE');
  });
});
