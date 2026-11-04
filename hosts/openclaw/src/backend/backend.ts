import type { Static, TSchema } from 'typebox';
import { Value } from 'typebox/value';
import { BindSessionSchema, ComputeInputSchema, limits, RelationSchema, UnitUpsertSchema } from '../contract.js';
import type { ComputeSnapshot, GraphSnapshot, Unit } from '../model.js';
import { activity, metadataId, observationId, type Observation } from './events.js';
import { projectGraph, projectCompute } from './projections.js';
import { changeDocument, DOCUMENT_KEY, readDocument, assertAccess, type AgentAccess, type Document, type DocumentStore } from './store.js';

type UnitInput = Static<typeof UnitUpsertSchema>;
type BindInput = Static<typeof BindSessionSchema>;
type ComputeInput = Static<typeof ComputeInputSchema>;
type RelationInput = Static<typeof RelationSchema>;
export interface BackendOptions {
  store: DocumentStore;
  /** Public async session reader; only existence/incarnation metadata is returned to this boundary. */
  verifySession: (session: NonNullable<Unit['session']>) => Promise<{ sessionId: string } | undefined>;
  changed: (event: { revision: number; area: 'graph' | 'compute' | 'all' }) => void;
  clock?: () => number;
}
function validate(schema: TSchema, value: unknown): void {
  if (!Value.Check(schema, value)) throw new Error('VSC input does not match the bounded contract');
}
function unique(items: { id: string }[], label: string): void {
  if (new Set(items.map(item => item.id)).size !== items.length) throw new Error(`Duplicate ${label} id`);
}
function assertTree(units: Unit[]): void {
  const byId = new Map(units.map(unit => [unit.id, unit]));
  for (const unit of units) {
    const visited = new Set([unit.id]);
    let parent = unit.parentId;
    while (parent !== undefined) {
      if (visited.has(parent)) throw new Error('Unit parent would create a cycle');
      visited.add(parent);
      const ancestor = byId.get(parent);
      if (!ancestor) throw new Error('Unit parent does not exist');
      parent = ancestor.parentId;
    }
  }
}

/** Service-owned projection. Browser mounts neither start nor stop its lifetime. */
export class Backend {
  private started = false;
  private liveSince = 0;
  private readonly currentRuns = new Set<string>();
  private observedCompute = false;
  private tail: Promise<unknown> = Promise.resolve();
  private readonly now: () => number;
  constructor(private readonly options: BackendOptions) { this.now = options.clock ?? Date.now; }

  async start(): Promise<void> {
    await this.tail;
    await this.read(); // Fail startup on corrupt/unreadable state; never fabricate an empty healthy snapshot.
    this.currentRuns.clear();
    this.observedCompute = false;
    this.liveSince = this.now();
    this.started = true;
    this.notify((await this.read()).revision, 'all');
  }
  async stop(): Promise<void> {
    this.started = false;
    await this.tail;
    this.currentRuns.clear();
    this.observedCompute = false;
  }
  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(operation);
    this.tail = result.catch(() => undefined);
    return result;
  }
  private requireStarted(): void { if (!this.started) throw new Error('VSC backend service is not started'); }
  private async read(allowsAgent?: AgentAccess): Promise<Document> { const document = readDocument(await this.options.store.lookup(DOCUMENT_KEY)); assertAccess(document, allowsAgent); return document; }
  private notify(revision: number, area: 'graph' | 'compute' | 'all'): void {
    // A detached/disconnecting UI broadcaster cannot turn a committed mutation into a failed write.
    try { this.options.changed({ revision, area }); } catch { /* Native watch refreshes on reconnect. */ }
  }
  private graph(document: Document): GraphSnapshot {
    return projectGraph(document, { started: this.started, liveSince: this.liveSince, now: this.now(), currentRuns: this.currentRuns });
  }
  private compute(document: Document): ComputeSnapshot {
    return projectCompute(document, this.started && this.observedCompute);
  }
  async graphSnapshot(allowsAgent?: AgentAccess): Promise<GraphSnapshot> { await this.tail; return this.graph(await this.read(allowsAgent)); }
  async computeSnapshot(allowsAgent?: AgentAccess): Promise<ComputeSnapshot> { await this.tail; return this.compute(await this.read(allowsAgent)); }

  upsertUnit(input: UnitInput, allowsAgent?: AgentAccess): Promise<GraphSnapshot> {
    validate(UnitUpsertSchema, input);
    return this.serialize(async () => {
      this.requireStarted();
      const at = this.now();
      const { document, changed } = await changeDocument(this.options.store, next => {
        const existing = next.units.find(unit => unit.id === input.id);
        if (!existing && next.units.length >= limits.units) throw new Error('Unit limit reached');
        const unit: Unit = { ...existing, id: input.id, name: input.name, purpose: input.purpose,
          status: input.status ?? existing?.status ?? 'idle', updatedAt: at };
        if (input.parentId === null) delete unit.parentId;
        else if (input.parentId !== undefined) unit.parentId = input.parentId;
        next.units = [...next.units.filter(row => row.id !== unit.id), unit];
        assertTree(next.units);
        return true;
      }, allowsAgent);
      if (changed) this.notify(document.revision, 'graph');
      return this.graph(document);
    });
  }
  upsertRelation(input: RelationInput, allowsAgent?: AgentAccess): Promise<GraphSnapshot> {
    validate(RelationSchema, input);
    return this.serialize(async () => {
      this.requireStarted();
      const { document, changed } = await changeDocument(this.options.store, next => {
        if (!next.units.some(unit => unit.id === input.source) || !next.units.some(unit => unit.id === input.target)) throw new Error('Relation endpoints must be configured units');
        if (!next.relations.some(relation => relation.id === input.id) && next.relations.length >= limits.relations) throw new Error('Relation limit reached');
        next.relations = [...next.relations.filter(relation => relation.id !== input.id), structuredClone(input)];
        return true;
      }, allowsAgent);
      if (changed) this.notify(document.revision, 'graph');
      return this.graph(document);
    });
  }
  bindSession(input: BindInput, allowsAgent?: AgentAccess): Promise<GraphSnapshot> {
    validate(BindSessionSchema, input);
    return this.serialize(async () => {
      this.requireStarted();
      let sessionId: string | undefined;
      if (input.session) {
        if (allowsAgent && !allowsAgent(input.session.agentId)) throw new Error('Operator cannot access the selected agent');
        if (!input.session.sessionKey.startsWith(`agent:${input.session.agentId}:`)) throw new Error('Session key does not belong to the selected agent');
        const verified = await this.options.verifySession(input.session);
        sessionId = verified?.sessionId;
        if (!sessionId || sessionId.length > 256) throw new Error('Native session does not exist or its identity is unavailable');
      }
      this.requireStarted();
      const at = this.now();
      const { document, changed } = await changeDocument(this.options.store, next => {
        const unit = next.units.find(row => row.id === input.unitId);
        if (!unit) throw new Error('Unit does not exist');
        if (input.session && next.units.some(row => row.id !== unit.id && row.session?.sessionKey === input.session!.sessionKey)) throw new Error('Session is already bound to a different unit');
        if (input.session && unit.session?.sessionKey === input.session.sessionKey && unit.session.agentId === input.session.agentId
          && next.bindings.find(row => row.unitId === unit.id)?.sessionId === sessionId) return false;
        if (!input.session && !unit.session) return false;
        if (input.session) unit.session = structuredClone(input.session);
        else delete unit.session;
        unit.status = 'idle';
        unit.updatedAt = at;
        next.bindings = next.bindings.filter(row => row.unitId !== unit.id);
        if (sessionId) next.bindings.push({ unitId: unit.id, sessionId });
        // Retain run ownership tombstones so a moved session cannot reassign a prior run to a new unit.
        next.runs = next.runs.map(run => run.unitId === unit.id ? { ...run, phase: 'ended' as const } : run);
        return true;
      }, allowsAgent);
      if (changed) this.notify(document.revision, 'graph');
      return this.graph(document);
    });
  }
  observeCompute(input: ComputeInput, allowsAgent?: AgentAccess): Promise<ComputeSnapshot> {
    validate(ComputeInputSchema, input);
    return this.serialize(async () => {
      this.requireStarted();
      unique(input.pools, 'pool'); unique(input.models, 'model'); unique(input.allocations, 'allocation');
      for (const pool of input.pools) unique(pool.windows, 'quota window');
      for (const model of input.models) if (!input.pools.some(pool => pool.id === model.poolId)) throw new Error('Model references a missing pool');
      const at = this.now();
      const { document, changed } = await changeDocument(this.options.store, next => {
        for (const allocation of input.allocations) {
          if (!next.units.some(unit => unit.id === allocation.unitId)) throw new Error('Allocation references an unconfigured unit');
          if (allocation.modelId && !input.models.some(model => model.id === allocation.modelId)) throw new Error('Allocation references a missing model');
        }
        next.compute = { ...structuredClone(input), revision: next.revision + 1, observedAt: at };
        return true;
      }, allowsAgent);
      this.observedCompute = true;
      if (changed) this.notify(document.revision, 'compute');
      return this.compute(document);
    });
  }
  observe(event: Observation): Promise<boolean> {
    if (!this.started) return Promise.resolve(false);
    return this.serialize(async () => {
      if (!this.started) return false;
      if (event.at < this.liveSince) return false;
      if (!metadataId(event.runId) || !event.sessionKey || event.sessionKey.length > 512 || !Number.isSafeInteger(event.at) || event.at < 0) return false;
      if ((event.kind === 'tool-start' || event.kind === 'tool-end') && !metadataId(event.toolCallId)) return false;
      const { document, changed } = await changeDocument(this.options.store, next => {
        const unit = next.units.find(row => row.session?.sessionKey === event.sessionKey && (!event.agentId || row.session.agentId === event.agentId));
        if (!unit) return false;
        const binding = next.bindings.find(row => row.unitId === unit.id);
        if (!binding || (event.sessionId && binding.sessionId !== event.sessionId)) return false;
        const id = observationId(unit.id, binding.sessionId, event);
        if (next.seen.includes(id)) return false;
        let run = next.runs.find(row => row.id === event.runId);
        // A run is never reassigned just because a unit binding changed.
        if (run && run.unitId !== unit.id) return false;
        // Missing incarnation is usable only after this process established the run from trusted metadata.
        if (!event.sessionId && (!run || !this.currentRuns.has(event.runId))) return false;
        // Terminal observations dominate delayed starts and late tool notifications.
        if (run?.phase === 'ended' && event.kind !== 'error' && event.kind !== 'message') return false;
        const target = event.kind === 'message' ? next.units.find(row => row.session?.sessionKey === event.targetSessionKey) : undefined;
        if (event.kind === 'message' && (!target || target.id === unit.id || !next.bindings.some(binding => binding.unitId === target.id))) return false;
        next.seen = [...next.seen, id].slice(-limits.seen);
        next.activities = [...next.activities, activity(id, unit.id, event, target?.id)].slice(-limits.activities);
        if (event.kind !== 'error' && event.kind !== 'message') {
          if (!run) { run = { id: event.runId, unitId: unit.id, phase: 'running', at: event.at }; next.runs.push(run); }
          run.at = Math.max(run.at, event.at);
          if (event.kind === 'run-end') run.phase = 'ended';
          next.runs = next.runs.slice(-limits.runs);
          const active = next.runs.some(row => row.unitId === unit.id && row.phase === 'running');
          unit.status = active ? 'running' : event.failed ? 'blocked' : 'idle';
          unit.updatedAt = Math.max(unit.updatedAt, event.at);
        }
        return true;
      });
      if (changed) {
        if (event.kind === 'run-end') this.currentRuns.delete(event.runId);
        else if (event.kind !== 'error' && event.kind !== 'message') this.currentRuns.add(event.runId);
        this.notify(document.revision, 'graph');
      }
      return changed;
    });
  }
}
