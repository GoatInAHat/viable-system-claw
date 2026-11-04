import { Type, type Static } from 'typebox';
import { Value } from 'typebox/value';
import { projectGraph, projectCompute } from './projections.js';
import { assertTransportValue } from './transport.js';
import { Buffer } from 'node:buffer';
import { ActivitySchema, ComputeInputSchema, IdSchema, limits, RelationSchema, UnitSchema } from '../contract.js';
import type { OpenClawPluginApi } from 'openclaw/plugin-sdk/core';

const closed = { additionalProperties: false } as const;
const integer = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
export const DocumentSchema = Type.Object({
  version: Type.Literal(1), revision: integer,
  units: Type.Array(UnitSchema, { maxItems: limits.units }),
  relations: Type.Array(RelationSchema, { maxItems: limits.relations }),
  activities: Type.Array(ActivitySchema, { maxItems: limits.activities }),
  bindings: Type.Array(Type.Object({ unitId: IdSchema, sessionId: Type.String({ minLength: 1, maxLength: 256 }) }, closed), { maxItems: limits.units }),
  runs: Type.Array(Type.Object({ id: IdSchema, unitId: IdSchema, phase: Type.Union([Type.Literal('running'), Type.Literal('ended')]), at: integer }, closed), { maxItems: limits.runs }),
  seen: Type.Array(Type.String({ pattern: '^[a-f0-9]{64}$' }), { maxItems: limits.seen }),
  compute: Type.Object({ ...ComputeInputSchema.properties, revision: integer, observedAt: integer }, closed),
}, closed);
export type Document = Static<typeof DocumentSchema>;
type NativeStore = ReturnType<OpenClawPluginApi['runtime']['state']['openKeyedStoreV2']>;
/** Exact public V2 retained-store subset; the fake used in tests implements the same CAS contract. */
export type DocumentStore = Pick<NativeStore, 'lookup' | 'observe' | 'compareAndApply'>;
export type AgentAccess = (agentId: string) => boolean;
/** This first shared-organization view is all-or-none for restricted operators. */
export function assertAccess(document: Document, allowsAgent?: AgentAccess): void {
  if (allowsAgent && document.units.some(unit => unit.session && !allowsAgent(unit.session.agentId))) {
    throw new Error('Operator cannot access this organization');
  }
}
export const DOCUMENT_KEY = 'organization-v1';
export function emptyDocument(): Document {
  return { version: 1, revision: 0, units: [], relations: [], activities: [], bindings: [], runs: [], seen: [],
    compute: { revision: 0, observedAt: 0, pools: [], models: [], allocations: [] } };
}
export function readDocument(value: unknown): Document {
  if (value === undefined) return emptyDocument();
  if (!Value.Check(DocumentSchema, value)) throw new Error('VSC retained state is invalid; refusing to replace it');
  return structuredClone(value);
}
/** One bounded document makes tree, bindings, projection and dedupe one atomic decision. */
export async function changeDocument(store: DocumentStore, decide: (document: Document) => boolean, allowsAgent?: AgentAccess): Promise<{ document: Document; changed: boolean }> {
  for (let attempt = 0; attempt < 8; attempt++) {
    const observed = await store.observe(DOCUMENT_KEY);
    const next = readDocument(observed.value);
    assertAccess(next, allowsAgent);
    if (!decide(next)) return { document: next, changed: false };
    assertAccess(next, allowsAgent);
    next.revision++;
    if (!Value.Check(DocumentSchema, next)) throw new Error('VSC mutation exceeds the validated state contract');
    if (Buffer.byteLength(JSON.stringify(next), 'utf8') > 900 * 1024) throw new Error('VSC retained state exceeds its 900 KiB budget');
    // Validate every public projection before committing, including restart degradation and
    // all potentially active runs. Successful writes must remain readable through the SDK.
    const currentRuns = new Set(next.runs.map(run => run.id));
    for (const started of [true, false]) {
      assertTransportValue(projectGraph(next, { started, liveSince: Number.MAX_SAFE_INTEGER, now: Number.MAX_SAFE_INTEGER, currentRuns }));
      assertTransportValue(projectCompute(next, started));
    }
    const result = await store.compareAndApply(DOCUMENT_KEY, observed.comparison, { operation: 'update', action: 'set', value: next });
    if (result.status === 'applied') return { document: next, changed: true };
    if (result.status === 'unchanged') throw new Error('VSC state write was unexpectedly unchanged');
    // Only an explicit conflict retries. Storage errors must propagate without an unsafe replay.
  }
  throw new Error('VSC state changed concurrently; retry the operation');
}
