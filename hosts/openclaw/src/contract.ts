import { Type } from 'typebox';
import { defineFeatureContract } from 'openclaw/plugin-sdk/feature-contract';
import { NativeAllocationPlanSchema, ComputePlanInputSchema } from './compute/schema.js';

export const limits = { units: 128, relations: 512, activities: 256, runs: 256, seen: 1024, pools: 64, models: 256, allocations: 256 } as const;
const closed = { additionalProperties: false } as const;
export const IdSchema = Type.String({ minLength: 1, maxLength: 128, pattern: '^[a-zA-Z0-9_.:/-]+$' });
const text = (maxLength: number) => Type.String({ maxLength });
const timestamp = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
const count = Type.Integer({ minimum: 0, maximum: 1_000_000_000 });
const fraction = Type.Number({ minimum: 0, maximum: 1 });
const oneOf = <const T extends [string, ...string[]]>(...values: T) => Type.Enum<T>(values);
export const SessionSchema = Type.Object({ sessionKey: Type.String({ minLength: 1, maxLength: 512 }), agentId: IdSchema }, closed);
export const UnitSchema = Type.Object({
  id: IdSchema, parentId: Type.Optional(IdSchema), name: Type.String({ minLength: 1, maxLength: 160 }), purpose: text(2000),
  status: oneOf('idle', 'running', 'waiting', 'blocked', 'unknown'), session: Type.Optional(SessionSchema), updatedAt: timestamp,
}, closed);
export const RelationSchema = Type.Object({ id: IdSchema, source: IdSchema, target: IdSchema,
  kind: oneOf('communication', 'coordination', 'resource', 'audit'), label: Type.Optional(text(160)),
}, closed);
export const ActivitySchema = Type.Object({
  id: text(160), unitId: IdSchema, targetUnitId: Type.Optional(IdSchema), kind: oneOf('run-start', 'run-end', 'tool-start', 'tool-end', 'message', 'error'),
  at: timestamp, runId: Type.Optional(IdSchema), toolCallId: Type.Optional(IdSchema), label: Type.Optional(text(160)),
}, closed);
export const GraphSnapshotSchema = Type.Object({ activeRuns: Type.Array(Type.Object({ id: IdSchema, unitId: IdSchema }, closed), { maxItems: limits.runs }), liveSince: Type.Optional(timestamp), revision: timestamp, observedAt: timestamp,
  units: Type.Array(UnitSchema, { maxItems: limits.units }), relations: Type.Array(RelationSchema, { maxItems: limits.relations }),
  activities: Type.Array(ActivitySchema, { maxItems: limits.activities }), coverage: oneOf('live', 'partial', 'disconnected'),
}, closed);
const QuotaWindowSchema = Type.Object({ id: IdSchema, label: text(160), usedFraction: fraction,
  resetsAt: Type.Optional(timestamp), windowMs: Type.Optional(Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER })),
}, closed);
const ComputePoolSchema = Type.Object({ id: IdSchema, label: text(160), kind: oneOf('throughput', 'subscription', 'metered'), observedAt: timestamp,
  status: oneOf('available', 'unavailable', 'unknown'), concurrency: Type.Optional(count), active: Type.Optional(count),
  windows: Type.Array(QuotaWindowSchema, { maxItems: 16 }),
}, closed);
const ModelProfileSchema = Type.Object({ id: IdSchema, poolId: IdSchema, label: text(160), capabilities: Type.Array(text(80), { maxItems: 32, uniqueItems: true }),
  observedAt: timestamp, quality: Type.Optional(fraction), samples: count,
  quotaCost: Type.Optional(Type.Record(IdSchema, Type.Number({ minimum: 0, maximum: 1_000_000_000 }), { maxProperties: 16, additionalProperties: false })),
  latencyMs: Type.Optional(Type.Number({ minimum: 0, maximum: 86_400_000 })),
}, closed);
const AllocationSchema = Type.Object({ id: IdSchema, unitId: IdSchema, modelId: Type.Optional(IdSchema),
  status: oneOf('proposed', 'admitted', 'running', 'blocked', 'finished'), reason: text(1000), at: timestamp,
}, closed);
export const ComputeInputSchema = Type.Object({
  pools: Type.Array(ComputePoolSchema, { maxItems: limits.pools }), models: Type.Array(ModelProfileSchema, { maxItems: limits.models }),
  allocations: Type.Array(AllocationSchema, { maxItems: limits.allocations }),
}, closed);
export const ComputeSnapshotSchema = Type.Object({ ...ComputeInputSchema.properties, revision: timestamp, observedAt: timestamp }, closed);
export const UnitUpsertSchema = Type.Object({ id: IdSchema, parentId: Type.Optional(Type.Union([IdSchema, Type.Null()])),
  name: Type.String({ minLength: 1, maxLength: 160 }), purpose: text(2000),
  status: Type.Optional(oneOf('idle', 'waiting', 'blocked', 'unknown')),
}, closed);
export const BindSessionSchema = Type.Object({ unitId: IdSchema, session: Type.Union([SessionSchema, Type.Null()]) }, closed);
const EmptySchema = Type.Object({}, closed);

const effectStatus = oneOf('intent', 'reserved', 'accepted', 'ambiguous', 'lost', 'succeeded', 'failed', 'cancelled');
const channelKind = oneOf('V1', 'V2', 'V3', 'V4', 'V5', 'V6', 'metasystemic', 'lateral', 'algedonic', 'environmental', 'local');
const channelPhase = oneOf('parked', 'evidence', 'waiting-environment', 'waiting-grant', 'reserved');
const wakeClass = oneOf('fast-code', 'slow-deliberative', 'alarm');
const VsmExitSchema = Type.Object({ id: IdSchema, declared: Type.Number(), imputed: Type.Number(), error: Type.Number() }, closed);
const VsmPurposeSchema = Type.Object({
  unitId: IdSchema, description: text(512), converged: Type.Boolean(), revision: count,
  exits: Type.Array(VsmExitSchema, { maxItems: 8 }),
}, closed);
const VsmChannelSchema = Type.Object({
  id: IdSchema, kind: channelKind, unitId: IdSchema, procedureId: Type.Optional(IdSchema),
  value: Type.Number(), observations: count, filtered: count, phase: channelPhase, wakeClass,
}, closed);
const VsmEffectSchema = Type.Object({
  id: IdSchema, unitId: IdSchema, procedureId: IdSchema, status: effectStatus, sequence: count, attempts: count,
  nativeId: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
  outcomeValue: Type.Optional(Type.Number()), environmentRef: Type.Optional(text(160)),
  at: timestamp,
}, closed);
const VsmAlarmSchema = Type.Object({
  id: IdSchema, unitId: IdSchema, alarmClass: text(80), severity: Type.Number({ minimum: 0 }),
  state: oneOf('recorded', 'raised', 'acknowledged'), raisedAt: Type.Optional(timestamp),
}, closed);
const VsmGrantSchema = Type.Object({
  id: IdSchema, unitId: IdSchema, version: count, capacity: Type.Number({ minimum: 0 }),
  validUntil: timestamp, revokedAt: Type.Optional(timestamp),
}, closed);
export const VsmSnapshotSchema = Type.Object({
  runtime: oneOf('disabled', 'running'),
  revision: timestamp, updatedAt: timestamp, principalId: Type.Optional(IdSchema),
  purposes: Type.Array(VsmPurposeSchema, { maxItems: 64 }),
  channels: Type.Array(VsmChannelSchema, { maxItems: 128 }),
  effects: Type.Array(VsmEffectSchema, { maxItems: 128 }),
  alarms: Type.Array(VsmAlarmSchema, { maxItems: 64 }),
  grants: Type.Array(VsmGrantSchema, { maxItems: 64 }),
}, closed);

/** Public operations shared by the native UI, typed session actions and optional agent tools. */
export const contract = defineFeatureContract({
  pluginId: 'viable-system-claw',
  operations: {
    'vsm.snapshot': { kind: 'query', description: 'Bounded projection of the durable VSM runtime: purposes, homeostat channels, effects, alarms and grants. Read-only; does not launch, authorize or acknowledge.', input: EmptySchema, output: VsmSnapshotSchema,
      tool: { name: 'vsc_vsm_snapshot', optional: true } },
    'graph.snapshot': { kind: 'query', description: 'Configured organization and recent metadata activity only. No automatic session-to-unit discovery. Partial coverage includes accepted handoffs but excludes message contents, historical replay and unbound sessions.', input: EmptySchema, output: GraphSnapshotSchema,
      tool: { name: 'vsc_graph_snapshot', optional: true } },
    'compute.snapshot': { kind: 'query', description: 'Last explicit allocator observations. Empty until a compute observer publishes data; no inferred quotas or capacity.', input: EmptySchema, output: ComputeSnapshotSchema,
      tool: { name: 'vsc_compute_snapshot', optional: true } },
    'compute.plan': { kind: 'query', description: 'Evaluate a compute allocation scenario against current retained observations and server time. Caller evidence is scenario data, not execution authority. Evaluates all candidates; diagnostics are paged with diagnosticOffset and diagnostics.nextOffset. Pages are recomputed and must use matching snapshotRevision. Returns a proposal or explicit reasons; does not reserve, dispatch or authorize spending.', input: ComputePlanInputSchema, output: NativeAllocationPlanSchema,
      tool: { name: 'vsc_compute_plan', optional: true } },
    'unit.upsert': { kind: 'action', description: 'Create or edit a named organizational unit. Omitted parent/status preserve existing values; null parent makes it a root. Cycles and missing parents are refused.', input: UnitUpsertSchema, output: GraphSnapshotSchema,
      tool: { name: 'vsc_unit_upsert', optional: true } },
    'relation.upsert': { kind: 'action', description: 'Create or replace an explicit relation between two configured units.', input: RelationSchema, output: GraphSnapshotSchema,
      tool: { name: 'vsc_relation_upsert', optional: true } },
    'unit.bind-session': { kind: 'action', description: 'Explicitly bind a configured unit to an existing native session verified by the public session reader. A session belongs to at most one unit. Null detaches. A reset session must be rebound.', input: BindSessionSchema, output: GraphSnapshotSchema,
      tool: { name: 'vsc_unit_bind_session', optional: true } },
    'compute.observe': { kind: 'action', description: 'Replace compute observations with validated metadata from an authorized allocator. This records observations only and does not launch work, authorize spending, or enforce admission.', input: ComputeInputSchema, output: ComputeSnapshotSchema,
      tool: { name: 'vsc_compute_observe', optional: true } },
  },
  events: {
    changed: Type.Object({ revision: timestamp, area: oneOf('graph', 'compute', 'all') }, closed),
    alarm: Type.Object({ alarmId: IdSchema, unitId: IdSchema, alarmClass: text(80),
      severity: Type.Number({ minimum: 0, maximum: 1_000_000_000 }), at: timestamp }, closed),
    vsm: Type.Object({ revision: timestamp, updatedAt: timestamp }, closed),
  },
});
