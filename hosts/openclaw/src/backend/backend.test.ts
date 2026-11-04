import { describe, expect, it } from 'vitest';
import { Backend } from './backend.js';
import { fromNativeEvent, fromSessionSend, type Observation } from './events.js';
import { DOCUMENT_KEY, type DocumentStore } from './store.js';

class MemoryStore implements DocumentStore {
  value: unknown;
  generation = 0;
  writes = 0;
  conflicts = 0;
  failure?: Error;
  async lookup(_key: string) { return structuredClone(this.value); }
  async observe(_key: string) { return { value: structuredClone(this.value), comparison: String(this.generation) }; }
  async compareAndApply(_key: string, comparison: string, intent: Parameters<DocumentStore['compareAndApply']>[2]) {
    if (this.failure) throw this.failure;
    if (comparison !== String(this.generation)) { this.conflicts++; return { status: 'conflict' as const, current: { value: structuredClone(this.value), comparison: String(this.generation) } }; }
    if (intent.action !== 'set') throw new Error('Test only supports data set');
    this.value = structuredClone(intent.value); this.generation++; this.writes++;
    return { status: 'applied' as const };
  }
}
const session = { sessionKey: 'agent:main:session:a', agentId: 'main' };
const second = { sessionKey: 'agent:main:session:b', agentId: 'main' };
function fixture(store = new MemoryStore()) {
  const notifications: unknown[] = [];
  const backend = new Backend({ store, verifySession: async input => input.sessionKey.endsWith(':missing') ? undefined : { sessionId: input.sessionKey.endsWith(':b') ? 'incarnation-b' : 'incarnation-a' },
    changed: event => notifications.push(event), clock: () => 1000 });
  return { backend, store, notifications };
}
async function configured() {
  const f = fixture(); await f.backend.start();
  await f.backend.upsertUnit({ id: 'a', name: 'Research', purpose: 'Find evidence' });
  await f.backend.bindSession({ unitId: 'a', session });
  return f;
}
function observation(overrides: Partial<Observation> = {}): Observation {
  return { ...session, sessionId: 'incarnation-a', runId: 'run-1', kind: 'run-start', at: 1000, ...overrides };
}

describe('retained organization state', () => {
  it('is honestly empty and disconnected before service startup, partial while running', async () => {
    const { backend, store } = fixture();
    expect(await backend.graphSnapshot()).toMatchObject({ units: [], relations: [], activities: [], coverage: 'disconnected', revision: 0 });
    await backend.start();
    expect(await backend.graphSnapshot()).toMatchObject({ units: [], coverage: 'partial' });
    expect(await backend.computeSnapshot()).toEqual({ revision: 0, observedAt: 0, pools: [], models: [], allocations: [] });
    expect(store.writes).toBe(0);
  });
  it('persists units, bindings and relations without manufacturing a domain tree', async () => {
    const { backend, store } = await configured();
    await backend.upsertUnit({ id: 'b', parentId: 'a', name: 'Build', purpose: 'Use evidence' });
    await backend.upsertRelation({ id: 'r', source: 'a', target: 'b', kind: 'coordination' });
    await backend.stop();
    const restored = fixture(store).backend; await restored.start();
    expect(await restored.graphSnapshot()).toMatchObject({ units: [expect.objectContaining({ id: 'a', session }), expect.objectContaining({ id: 'b', parentId: 'a' })], relations: [{ id: 'r', source: 'a', target: 'b', kind: 'coordination' }] });
  });
  it('refuses missing parents, self/ancestor cycles and dangling relations atomically', async () => {
    const { backend, store } = await configured();
    await backend.upsertUnit({ id: 'b', parentId: 'a', name: 'B', purpose: '' });
    const before = structuredClone(store.value);
    await expect(backend.upsertUnit({ id: 'a', parentId: 'b', name: 'A', purpose: '' })).rejects.toThrow('cycle');
    await expect(backend.upsertUnit({ id: 'a', parentId: 'a', name: 'A', purpose: '' })).rejects.toThrow('cycle');
    await expect(backend.upsertUnit({ id: 'c', parentId: 'absent', name: 'C', purpose: '' })).rejects.toThrow('does not exist');
    await expect(backend.upsertRelation({ id: 'r', source: 'a', target: 'absent', kind: 'audit' })).rejects.toThrow('endpoints');
    expect(store.value).toEqual(before);
    await backend.upsertUnit({ id: 'b', parentId: null, name: 'B', purpose: '' });
    expect((await backend.graphSnapshot()).units.find(unit => unit.id === 'b')?.parentId).toBeUndefined();
  });
  it('refuses unproven event incarnations across restart and rebind', async () => {
    const { backend, store } = await configured();
    expect(await backend.observe(observation({ sessionId: undefined }))).toBe(false);
    expect(await backend.observe(observation())).toBe(true);
    expect(await backend.observe(observation({ sessionId: undefined, kind: 'tool-start', toolCallId: 'proven' }))).toBe(true);
    await backend.bindSession({ unitId: 'a', session: null });
    await backend.bindSession({ unitId: 'a', session });
    expect(await backend.observe(observation({ sessionId: undefined, kind: 'tool-start', toolCallId: 'unproven' }))).toBe(false);
    await backend.stop(); const restarted = fixture(store).backend; await restarted.start();
    expect(await restarted.observe(observation({ sessionId: undefined, runId: 'late-old-run', at: 900 }))).toBe(false);
    expect(await restarted.observe(observation({ sessionId: undefined, runId: 'unproven-new-run' }))).toBe(false);
    expect((await restarted.graphSnapshot()).units[0].status).not.toBe('running');
  });

  it('projects only current incarnation runs after rebind, not retained tool starts', async () => {
    const { backend } = await configured();
    await backend.observe(observation({ kind: 'tool-start', toolCallId: 'old-tool' }));
    expect((await backend.graphSnapshot()).activeRuns).toEqual([{ id: 'run-1', unitId: 'a' }]);
    await backend.bindSession({ unitId: 'a', session: second });
    await backend.observe(observation({ ...second, sessionId: 'incarnation-b', runId: 'run-2' }));
    const snapshot = await backend.graphSnapshot();
    expect(snapshot.activeRuns).toEqual([{ id: 'run-2', unitId: 'a' }]);
    expect(snapshot.activities.some(event => event.toolCallId === 'old-tool')).toBe(true);
    await backend.stop(); await backend.start();
    expect((await backend.graphSnapshot()).activeRuns).toEqual([]);
  });

  it('recomputes on actual CAS conflicts, preserving concurrent independent writes', async () => {
    const store = new MemoryStore(); const a = fixture(store).backend; const b = fixture(store).backend;
    await Promise.all([a.start(), b.start()]);
    await Promise.all([a.upsertUnit({ id: 'a', name: 'A', purpose: '' }), b.upsertUnit({ id: 'b', name: 'B', purpose: '' })]);
    expect((await a.graphSnapshot()).units.map(unit => unit.id).sort()).toEqual(['a', 'b']);
    expect(store.conflicts).toBeGreaterThan(0);
    expect((await a.graphSnapshot()).revision).toBe(2);
  });
  it('rechecks the full parent predicate after a competing CAS tree edit', async () => {
    const { backend: a, store } = await configured();
    await a.upsertUnit({ id: 'b', name: 'B', purpose: '' });
    const b = fixture(store).backend; await b.start();
    const results = await Promise.allSettled([a.upsertUnit({ id: 'a', parentId: 'b', name: 'A', purpose: '' }), b.upsertUnit({ id: 'b', parentId: 'a', name: 'B', purpose: '' })]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter(result => result.status === 'rejected')).toHaveLength(1);
    const graph = await a.graphSnapshot();
    expect(graph.units.filter(unit => unit.parentId)).toHaveLength(1);
  });
  it('preserves existing retained state on invalid data and storage failure, without replaying failures', async () => {
    const { backend, store } = await configured();
    const before = structuredClone(store.value); store.failure = new Error('storage unavailable');
    await expect(backend.upsertUnit({ id: 'b', name: 'B', purpose: '' })).rejects.toThrow('storage unavailable');
    expect(store.value).toEqual(before); expect(store.conflicts).toBe(0);
    store.value = { version: 900, secret: 'not echoed' };
    await expect(fixture(store).backend.start()).rejects.toThrow('retained state is invalid');
    expect(store.value).toEqual({ version: 900, secret: 'not echoed' });
  });
});

describe('explicit native session projection', () => {
  it('ignores all unbound sessions and refuses missing/mismatched/already-owned binding identities', async () => {
    const { backend } = await configured();
    expect(await backend.observe(observation({ sessionKey: second.sessionKey }))).toBe(false);
    expect(await backend.observe(observation({ agentId: 'other' }))).toBe(false);
    expect(await backend.observe(observation({ sessionId: 'old-incarnation' }))).toBe(false);
    await backend.upsertUnit({ id: 'b', name: 'B', purpose: '' });
    await expect(backend.bindSession({ unitId: 'b', session })).rejects.toThrow('already bound');
    await expect(backend.bindSession({ unitId: 'b', session: { ...session, agentId: 'other' } })).rejects.toThrow('selected agent');
    await expect(backend.bindSession({ unitId: 'b', session: { ...session, sessionKey: 'agent:main:missing' } })).rejects.toThrow('does not exist');
    expect((await backend.graphSnapshot()).activities).toEqual([]);
    await backend.bindSession({ unitId: 'a', session: null });
    expect(await backend.observe(observation())).toBe(false);
  });
  it('does not reassign an already observed run when a binding moves to another unit', async () => {
    const { backend } = await configured();
    await backend.observe(observation());
    await backend.upsertUnit({ id: 'b', name: 'B', purpose: '' });
    await backend.bindSession({ unitId: 'a', session: null });
    await backend.bindSession({ unitId: 'b', session });
    expect(await backend.observe(observation({ kind: 'tool-start', toolCallId: 'old-run-call' }))).toBe(false);
    expect(await backend.observe(observation({ runId: 'new-run' }))).toBe(true);
    expect((await backend.graphSnapshot()).units.find(unit => unit.id === 'b')?.status).toBe('running');
  });
  it('deduplicates stream/hook copies by run/tool identity, including after restart', async () => {
    const { backend, store, notifications } = await configured();
    await backend.observe(observation());
    const tool = observation({ kind: 'tool-end', toolCallId: 'call-1', toolName: 'read' });
    await backend.observe(tool);
    const revision = (await backend.graphSnapshot()).revision;
    const noticeCount = notifications.length;
    expect(await backend.observe({ ...tool, at: 2000 })).toBe(false);
    expect(notifications).toHaveLength(noticeCount);
    const restarted = fixture(store).backend; await restarted.start();
    expect(await restarted.observe(tool)).toBe(false);
    expect((await restarted.graphSnapshot()).activities).toHaveLength(2);
    expect((await restarted.graphSnapshot()).revision).toBe(revision);
  });
  it('never revives retained or terminal activity as live, but accepts fresh correlated in-process work', async () => {
    const { backend, store } = await configured();
    await backend.observe(observation());
    expect((await backend.graphSnapshot()).units[0].status).toBe('running');
    const restarted = fixture(store).backend; await restarted.start();
    expect((await restarted.graphSnapshot()).units[0].status).toBe('unknown');
    expect(await restarted.observe(observation())).toBe(false);
    expect((await restarted.graphSnapshot()).units[0].status).toBe('unknown');
    await restarted.observe(observation({ kind: 'tool-start', toolCallId: 'new-call', at: 1100 }));
    expect((await restarted.graphSnapshot()).units[0].status).toBe('running');
    await restarted.observe(observation({ kind: 'run-end', at: 1200 }));
    expect((await restarted.graphSnapshot()).units[0].status).toBe('idle');
    expect(await restarted.observe(observation({ kind: 'tool-start', toolCallId: 'late-call', at: 1050 }))).toBe(false);
    expect((await restarted.graphSnapshot()).units[0].status).toBe('idle');
    await restarted.stop();
    expect((await restarted.graphSnapshot()).coverage).toBe('disconnected');
  });
  it('keeps overlapping runs active until all end, and rejects late starts after an early terminal', async () => {
    const { backend } = await configured();
    await backend.observe(observation()); await backend.observe(observation({ runId: 'run-2' }));
    await backend.observe(observation({ kind: 'run-end' }));
    expect((await backend.graphSnapshot()).units[0].status).toBe('running');
    await backend.observe(observation({ kind: 'run-end', runId: 'run-2' }));
    expect((await backend.graphSnapshot()).units[0].status).toBe('idle');
    await backend.observe(observation({ kind: 'run-end', runId: 'terminal-first' }));
    expect(await backend.observe(observation({ runId: 'terminal-first' }))).toBe(false);
  });
  it('records only admitted sessions_send handoff metadata between explicitly bound units', async () => {
    const { backend, store } = await configured();
    await backend.upsertUnit({ id: 'b', name: 'B', purpose: '' });
    const context = { ...session, sessionId: 'incarnation-a', toolName: 'sessions_send', runId: 'run-1', toolCallId: 'send-1' };
    const raw = { toolName: 'sessions_send', result: { details: { status: 'accepted', sessionKey: second.sessionKey, reply: 'PRIVATE REPLY' }, content: [{ type: 'text', text: 'PRIVATE BODY' }] } };
    const event = fromSessionSend(raw, context, 1000)!;
    expect(await backend.observe(event)).toBe(false);
    await backend.bindSession({ unitId: 'b', session: second });
    expect(await backend.observe(event)).toBe(true);
    expect(await backend.observe(event)).toBe(false);
    expect((await backend.graphSnapshot()).activities).toEqual([expect.objectContaining({ kind: 'message', unitId: 'a', targetUnitId: 'b', label: 'handoff accepted', toolCallId: 'send-1' })]);
    expect(JSON.stringify(store.value)).not.toMatch(/PRIVATE/);
    for (const status of ['error', 'forbidden', 'timeout', 'unknown']) {
      expect(fromSessionSend({ toolName: 'sessions_send', result: { details: { status, sessionKey: second.sessionKey } } }, context, 1000)).toBeUndefined();
    }
    expect(fromSessionSend({ ...raw, error: 'failure' }, context, 1000)).toBeUndefined();
    expect(fromSessionSend({ ...raw, toolName: 'plugin_send' }, context, 1000)).toBeUndefined();
  });
});

describe('bounded metadata and compute inputs', () => {
  it('whitelists correlation metadata without inspecting messages, arguments, results or error text', () => {
    const data = { phase: 'start', toolCallId: 'call-1', name: 'read', args: { token: 'PRIVATE' }, result: 'PRIVATE', error: 'PRIVATE' };
    Object.defineProperty(data, 'text', { get() { throw new Error('must not read message text'); } });
    const event = fromNativeEvent({ ...session, runId: 'run-1', seq: 1, stream: 'tool', ts: 1000, data });
    expect(event).toMatchObject({ kind: 'tool-start', runId: 'run-1', toolCallId: 'call-1', toolName: 'read' });
    expect(JSON.stringify(event)).not.toMatch(/PRIVATE/);
    expect(fromNativeEvent({ ...session, runId: 'run-1', seq: 1, stream: 'assistant', ts: 1000, data })).toBeUndefined();
  });
  it('rejects unknown/unbounded fields on backend entry points as well as feature transport', async () => {
    const { backend } = await configured();
    expect(() => backend.upsertUnit({ id: 'x', name: 'X'.repeat(161), purpose: '' })).toThrow('bounded contract');
    expect(() => backend.upsertUnit({ id: 'x', name: 'X', purpose: '', message: 'PRIVATE' } as never)).toThrow('bounded contract');
    expect(() => backend.observeCompute({ pools: [], models: [], allocations: [], token: 'PRIVATE' } as never)).toThrow('bounded contract');
  });
  it('persists explicit compute observations, validates references, and refuses to report retained capacity as freshly live', async () => {
    const { backend, store } = await configured();
    const input = { pools: [{ id: 'p', label: 'Pool', kind: 'throughput' as const, status: 'available' as const, observedAt: 900, windows: [] }], models: [{ id: 'm', poolId: 'p', label: 'Model', capabilities: [], observedAt: 900, samples: 0 }],
      allocations: [{ id: 'allocation-1', unitId: 'a', modelId: 'm', status: 'running' as const, reason: 'Observer receipt', at: 900 }] };
    await backend.observeCompute(input);
    expect((await backend.computeSnapshot()).pools[0].status).toBe('available');
    await expect(backend.observeCompute({ ...input, models: [{ ...input.models[0], poolId: 'missing' }] })).rejects.toThrow('missing pool');
    const restarted = fixture(store).backend; await restarted.start();
    expect(await restarted.computeSnapshot()).toMatchObject({ pools: [{ status: 'unknown', observedAt: 900 }], allocations: [{ status: 'blocked' }], observedAt: 1000 });
    expect(DOCUMENT_KEY).toBe('organization-v1');
  });
});
