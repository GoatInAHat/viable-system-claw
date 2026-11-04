import { Type, type Static, type TSchema } from 'typebox';

// Transport bounds, NOT resource quotas. Keep aligned with native snapshot sizes.
const closed = { additionalProperties: false } as const;
const id = Type.String({ minLength: 1, maxLength: 128, pattern: '^[a-zA-Z0-9_.:/-]+$' });
const text = (maxLength: number) => Type.String({ maxLength });
const timestamp = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
const positiveCount = Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER });
const count = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
const nonnegative = Type.Number({ minimum: 0, maximum: Number.MAX_VALUE });
const number = Type.Number({ minimum: -Number.MAX_VALUE, maximum: Number.MAX_VALUE });
const fraction = Type.Number({ minimum: 0, maximum: 1 });
const ids = (maxItems: number) => Type.Array(id, { maxItems, uniqueItems: true });
const record = <T extends TSchema>(value: T, maxProperties: number) =>
  Type.Record(id, value, { maxProperties, additionalProperties: false });

export const TaskConstraintsSchema = Type.Object({
  allocationId: id, unitId: id, taskClass: id,
  requiredCapabilities: Type.Array(Type.String({ minLength: 1, maxLength: 80 }), { maxItems: 32, uniqueItems: true }),
  minimumQuality: fraction, expectedContribution: nonnegative,
  allowedModelIds: Type.Optional(ids(256)), maximumLatencyMs: Type.Optional(nonnegative),
  paidAuthorization: Type.Optional(Type.Object({
    poolIds: ids(64), currency: Type.String({ minLength: 1, maxLength: 32 }), maximumCost: nonnegative, expiresAt: timestamp,
  }, closed)),
}, closed);
export const ComputePolicySchema = Type.Object({
  telemetryMaxAgeMs: count, profileMaxAgeMs: count, qualityMaxAgeMs: count, estimateMaxAgeMs: count,
  minimumQualitySamples: positiveCount,
  qualityAlpha: Type.Number({ exclusiveMinimum: 0, exclusiveMaximum: 1 }),
  weights: Type.Object({ quota: nonnegative, latency: nonnegative, capacity: nonnegative, money: nonnegative }, closed),
  prices: record(Type.Object({ amount: nonnegative, currency: Type.String({ minLength: 1, maxLength: 32 }), observedAt: timestamp }, closed), 256),
}, closed);
const QualityEvidenceSchema = Type.Object({
  modelId: id, taskClass: id, signature: text(8192), samples: positiveCount, mean: fraction, latest: fraction,
  observedAt: timestamp, verifierId: id,
  observations: Type.Array(Type.Object({ score: fraction, observedAt: timestamp, verifierId: id }, closed), { minItems: 1, maxItems: 4096 }),
}, closed);
const QuotaEstimateSchema = Type.Object({
  modelId: id, windowId: id, upperBound: nonnegative, samples: positiveCount, observedAt: timestamp,
  confounded: Type.Literal(true), attributionConfidence: Type.Literal('unidentified'),
}, closed);
const QuotaObservationSchema = Type.Object({
  id, allocationId: id, poolId: id, windowId: id, beforeAt: timestamp, afterAt: timestamp,
  delta: Type.Optional(number), requestUsageInterval: Type.Optional(Type.Tuple([nonnegative, nonnegative])),
  confounded: Type.Literal(true), attributionConfidence: Type.Literal('unidentified'), reason: Type.Optional(text(512)),
}, closed);
const CommitmentSchema = Type.Object({
  id, request: TaskConstraintsSchema, modelId: id, poolId: id, signature: text(8192),
  status: Type.Enum(['reserved', 'running', 'finished', 'cancelled']), at: timestamp, finishedAt: Type.Optional(timestamp),
  quota: record(Type.Object({ fraction, resetsAt: Type.Optional(timestamp) }, closed), 16),
}, closed);
export const ComputeStateSchema = Type.Object({
  commitments: Type.Array(CommitmentSchema, { maxItems: 256 }),
  quality: Type.Array(QualityEvidenceSchema, { maxItems: 4096 }),
  quotaEstimates: Type.Array(QuotaEstimateSchema, { maxItems: 4096 }),
  quotaObservations: Type.Array(QuotaObservationSchema, { maxItems: 4096 }),
  seenEvidenceIds: ids(65536),
}, closed);
export const AccountingCoverageSchema = Type.Object({
  snapshotRevision: timestamp, poolId: id, activeAllocationIds: ids(256), quotaAllocationIds: record(ids(256), 16),
}, closed);
/** The query supplies only scenario data. Backend snapshot and server time cannot be overridden. */
export const ComputePlanInputSchema = Type.Object({
  request: TaskConstraintsSchema, policy: ComputePolicySchema, state: ComputeStateSchema,
  diagnosticOffset: Type.Optional(Type.Integer({ minimum: 0, maximum: 256 })),
  coverage: Type.Optional(Type.Array(AccountingCoverageSchema, { maxItems: 64 })),
}, closed);
const CandidateEvidenceSchema = Type.Object({
  modelId: id, poolId: id, reasons: Type.Array(text(512), { maxItems: 128 }),
  quality: Type.Optional(Type.Object({
    mean: fraction, latest: fraction, lowerBound: fraction, samples: positiveCount, observedAt: timestamp, verifierId: id,
  }, closed)),
  windows: Type.Array(Type.Object({
    id, observedUsed: Type.Optional(fraction), committed: nonnegative, estimate: Type.Optional(nonnegative), learnedSamples: count, resulting: Type.Optional(nonnegative),
  }, closed), { maxItems: 16 }),
  capacity: Type.Optional(Type.Object({ observedActive: count, committed: count, limit: positiveCount }, closed)),
  expectedVerifiedContribution: Type.Optional(nonnegative), money: Type.Optional(nonnegative), score: Type.Optional(number),
}, closed);
const proposalProperties = {
  allocation: Type.Object({
    id, unitId: id, modelId: Type.Optional(id), status: Type.Enum(['proposed', 'admitted', 'running', 'blocked', 'finished']),
    reason: text(1000), at: timestamp,
  }, closed),
  request: TaskConstraintsSchema, snapshotRevision: timestamp,
  candidates: Type.Array(CandidateEvidenceSchema, { maxItems: 256 }),
};
export const AllocationPlanSchema = Type.Union([
  Type.Object({ ...proposalProperties, kind: Type.Literal('choice'), modelId: id, poolId: id, signature: text(8192) }, closed),
  Type.Object({ ...proposalProperties, kind: Type.Literal('blocked'), reasons: Type.Array(text(512), { maxItems: 32768 }) }, closed),
]);
export type ComputePlanInput = Static<typeof ComputePlanInputSchema>;

/** Native query pages diagnostics without changing the all-candidate decision. */
const DiagnosticsSchema = Type.Object({ candidateCount: count, offset: count, nextOffset: Type.Union([count, Type.Null()]), reasonCount: count }, closed);
export const NativeAllocationPlanSchema = Type.Union([
  Type.Object({ ...AllocationPlanSchema.anyOf[0].properties, diagnostics: DiagnosticsSchema }, closed),
  Type.Object({ ...AllocationPlanSchema.anyOf[1].properties, diagnostics: DiagnosticsSchema }, closed),
]);
