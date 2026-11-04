import type { Allocation, ComputePool, ComputeSnapshot, ModelProfile } from '../model.js';

/** All thresholds and prices are caller data, never inferred from an identity. */
export interface ComputePolicy {
  telemetryMaxAgeMs: number;
  profileMaxAgeMs: number;
  qualityMaxAgeMs: number;
  estimateMaxAgeMs: number;
  minimumQualitySamples: number;
  /** Hoeffding-style uncertainty penalty; not a guarantee under distribution shift. */
  qualityAlpha: number;
  weights: { quota: number; latency: number; capacity: number; money: number };
  prices: Record<string, { amount: number; currency: string; observedAt: number }>;
}
export interface TaskConstraints {
  allocationId: string;
  unitId: string;
  taskClass: string;
  requiredCapabilities: string[];
  minimumQuality: number;
  expectedContribution: number;
  allowedModelIds?: string[];
  maximumLatencyMs?: number;
  paidAuthorization?: { poolIds: string[]; currency: string; maximumCost: number; expiresAt: number };
}
export interface QualityEvidence {
  modelId: string;
  taskClass: string;
  signature: string;
  samples: number;
  mean: number;
  latest: number;
  observedAt: number;
  verifierId: string;
  observations: { score: number; observedAt: number; verifierId: string }[];
}
export interface QuotaEstimate {
  modelId: string;
  windowId: string;
  /** Conservative shared-delta upper envelope, NOT observed per-request usage. */
  upperBound: number;
  samples: number;
  observedAt: number;
  confounded: true;
  attributionConfidence: 'unidentified';
}
export interface QuotaDeltaEvidence {
  id: string;
  allocationId: string;
  poolId: string;
  windowId: string;
  beforeAt: number;
  afterAt: number;
  delta?: number;
  /** Usage during this observation interval only, never the entire running request. */
  requestUsageInterval?: [number, number];
  confounded: true;
  attributionConfidence: 'unidentified';
  reason?: string;
}
export interface Commitment {
  id: string;
  request: TaskConstraints;
  modelId: string;
  poolId: string;
  signature: string;
  status: 'reserved' | 'running' | 'finished' | 'cancelled';
  at: number;
  finishedAt?: number;
  quota: Record<string, { fraction: number; resetsAt?: number }>;
}
export interface ComputeState {
  commitments: Commitment[];
  quality: QualityEvidence[];
  quotaEstimates: QuotaEstimate[];
  quotaObservations: QuotaDeltaEvidence[];
  seenEvidenceIds: string[];
}
/** IDs fully charged/reserved in exactly this snapshot's totals; partial usage must NOT be marked covered. Absence means conservative addition. */
export interface AccountingCoverage {
  snapshotRevision: number;
  poolId: string;
  activeAllocationIds: string[];
  quotaAllocationIds: Record<string, string[]>;
}
export interface PlanningContext {
  now: number;
  policy: ComputePolicy;
  state: ComputeState;
  coverage?: AccountingCoverage[];
}
export interface CandidateEvidence {
  modelId: string;
  poolId: string;
  reasons: string[];
  quality?: { mean: number; latest: number; lowerBound: number; samples: number; observedAt: number; verifierId: string };
  windows: { id: string; observedUsed?: number; committed: number; estimate?: number; learnedSamples: number; resulting?: number }[];
  capacity?: { observedActive: number; committed: number; limit: number };
  expectedVerifiedContribution?: number;
  money?: number;
  score?: number;
}
interface ProposalBase {
  allocation: Allocation;
  request: TaskConstraints;
  snapshotRevision: number;
  candidates: CandidateEvidence[];
}
export type AllocationPlan = (ProposalBase & { kind: 'choice'; modelId: string; poolId: string; signature: string })
  | (ProposalBase & { kind: 'blocked'; reasons: string[] });

export const emptyComputeState = (): ComputeState => ({ commitments: [], quality: [], quotaEstimates: [], quotaObservations: [], seenEvidenceIds: [] });
const finite = (n: number | undefined): n is number => typeof n === 'number' && Number.isFinite(n);
const nonnegative = (n: number | undefined): n is number => finite(n) && n >= 0;
const fraction = (n: number | undefined): n is number => nonnegative(n) && n <= 1;
const fresh = (at: number, age: number, now: number) => finite(at) && at <= now && now - at <= age;
const copy = <T>(value: T): T => structuredClone(value);
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
/** A changed capability/pool invalidates quality; model-version changes require a new opaque ID. */
const qualitySignature = (m: ModelProfile) => JSON.stringify([m.id, m.poolId, [...m.capabilities].sort()]);
const profileSignature = (m: ModelProfile) => JSON.stringify([qualitySignature(m), Object.entries(m.quotaCost ?? {}).sort(), m.latencyMs]);

function invalidInputs(request: TaskConstraints, context: PlanningContext): string[] {
  const { policy: p, now } = context;
  const bad: string[] = [];
  if (!finite(now) || ![p.telemetryMaxAgeMs, p.profileMaxAgeMs, p.qualityMaxAgeMs, p.estimateMaxAgeMs].every(nonnegative)
    || !Number.isInteger(p.minimumQualitySamples) || p.minimumQualitySamples < 1
    || !finite(p.qualityAlpha) || p.qualityAlpha <= 0 || p.qualityAlpha >= 1
    || !Object.values(p.weights).every(nonnegative)) bad.push('invalid-policy');
  if (!request.allocationId || !request.unitId || !request.taskClass || !fraction(request.minimumQuality)
    || !nonnegative(request.expectedContribution) || !request.requiredCapabilities.every(c => typeof c === 'string' && c.length > 0)
    || (request.maximumLatencyMs !== undefined && !nonnegative(request.maximumLatencyMs))) bad.push('invalid-task-constraints');
  return bad;
}

function evaluate(snapshot: ComputeSnapshot, model: ModelProfile, request: TaskConstraints, ctx: PlanningContext): CandidateEvidence {
  const { now, policy, state } = ctx;
  const result: CandidateEvidence = { modelId: model.id, poolId: model.poolId, reasons: [], windows: [] };
  const reject = (reason: string) => result.reasons.push(reason);
  if (request.allowedModelIds && !request.allowedModelIds.includes(model.id)) reject('model-not-allowed');
  if (!request.requiredCapabilities.every(c => model.capabilities.includes(c))) reject('missing-capabilities');
  if (!fresh(model.observedAt, policy.profileMaxAgeMs, now)) reject('stale-model-profile');
  const quality = state.quality.find(q => q.modelId === model.id && q.taskClass === request.taskClass && q.signature === qualitySignature(model));
  const current = quality?.observations.filter(o => fresh(o.observedAt, policy.qualityMaxAgeMs, now)) ?? [];
  if (!quality || current.length < policy.minimumQualitySamples) {
    reject('missing-stale-or-insufficient-independent-quality');
  } else {
    const mean = current.reduce((sum, o) => sum + o.score, 0) / current.length;
    const latest = current[current.length - 1]!;
    const lowerBound = Math.max(0, Math.min(latest.score, mean - Math.sqrt(Math.log(1 / policy.qualityAlpha) / (2 * current.length))));
    result.quality = { mean, latest: latest.score, lowerBound, samples: current.length, observedAt: latest.observedAt, verifierId: latest.verifierId };
    if (lowerBound < request.minimumQuality) reject('quality-below-task-minimum');
    result.expectedVerifiedContribution = request.expectedContribution * lowerBound;
  }
  if ((request.maximumLatencyMs !== undefined || policy.weights.latency > 0) && !nonnegative(model.latencyMs)) reject('unknown-latency');
  if (request.maximumLatencyMs !== undefined && finite(model.latencyMs) && model.latencyMs > request.maximumLatencyMs) reject('latency-exceeds-task-maximum');
  const pool = snapshot.pools.find(p => p.id === model.poolId);
  if (!pool) { reject('missing-pool'); return result; }
  if (pool.status !== 'available') reject('pool-not-available');
  if (!fresh(pool.observedAt, policy.telemetryMaxAgeMs, now)) reject('stale-pool-telemetry');
  const coverage = ctx.coverage?.find(c => c.snapshotRevision === snapshot.revision && c.poolId === pool.id);
  const commitments = state.commitments.filter(c => c.poolId === pool.id && c.status !== 'cancelled');
  const active = commitments.filter(c => c.status !== 'finished' && !coverage?.activeAllocationIds.includes(c.id)).length;
  if (!Number.isInteger(pool.concurrency) || !finite(pool.concurrency) || pool.concurrency <= 0
    || !Number.isInteger(pool.active) || !nonnegative(pool.active)) reject('unknown-or-invalid-capacity');
  else {
    result.capacity = { observedActive: pool.active, committed: active, limit: pool.concurrency };
    if (pool.active + active + 1 > pool.concurrency) reject('no-concurrent-capacity');
  }
  if (pool.kind === 'subscription' && pool.windows.length === 0) reject('unknown-subscription-windows');
  if (new Set(pool.windows.map(w => w.id)).size !== pool.windows.length) reject('duplicate-quota-window');
  for (const window of pool.windows) {
    if (!fraction(window.usedFraction)) reject(`unknown-quota-consumption:${window.id}`);
    // Old telemetry crossing a reset is not evidence of a freshly empty window.
    if (window.resetsAt !== undefined && (!finite(window.resetsAt) || window.resetsAt <= now)) reject(`unobserved-window-reset:${window.id}`);
    const configured = model.quotaCost?.[window.id];
    const learned = state.quotaEstimates.find(e => e.modelId === model.id && e.windowId === window.id);
    if (!nonnegative(configured)) reject(`unknown-quota-estimate:${window.id}`);
    if (learned && !fresh(learned.observedAt, policy.estimateMaxAgeMs, now)) reject(`stale-quota-estimate:${window.id}`);
    // A shared delta may raise a bound; it must never turn unknown/positive cost into free usage.
    const estimate = Math.max(configured ?? Number.NaN, learned?.upperBound ?? 0);
    const committed = commitments.reduce((sum, c) => {
      const reserved = c.quota[window.id];
      if (!reserved || coverage?.quotaAllocationIds[window.id]?.includes(c.id)) return sum;
      if (c.status === 'finished' && c.finishedAt !== undefined && reserved.resetsAt !== undefined
        && c.finishedAt < reserved.resetsAt && pool.observedAt >= reserved.resetsAt) return sum;
      return sum + reserved.fraction;
    }, 0);
    const resulting = window.usedFraction + committed + estimate;
    result.windows.push({ id: window.id, ...(fraction(window.usedFraction) ? { observedUsed: window.usedFraction } : {}), committed,
      ...(finite(estimate) ? { estimate } : {}), learnedSamples: learned?.samples ?? 0, ...(finite(resulting) ? { resulting } : {}) });
    if (!finite(resulting) || resulting > 1) reject(`quota-window-exhausted:${window.id}`);
  }
  if (pool.kind === 'metered') {
    const price = policy.prices[model.id];
    const auth = request.paidAuthorization;
    if (!price || !nonnegative(price.amount) || !price.currency || !fresh(price.observedAt, policy.profileMaxAgeMs, now)) reject('unknown-or-stale-metered-price');
    else {
      result.money = price.amount;
      // Authorizations are per pinned request, never account-wide permission to overflow.
      if (!auth || !auth.poolIds.includes(pool.id) || auth.currency !== price.currency
        || !nonnegative(auth.maximumCost) || auth.maximumCost < price.amount || !finite(auth.expiresAt) || auth.expiresAt <= now) reject('paid-overflow-not-authorized');
    }
  }
  if (result.reasons.length === 0) {
    result.score = result.expectedVerifiedContribution! - policy.weights.quota * result.windows.reduce((s, w) => s + w.estimate!, 0)
      - policy.weights.latency * (model.latencyMs ?? 0) - policy.weights.money * (result.money ?? 0)
      - policy.weights.capacity * (result.capacity!.observedActive + result.capacity!.committed + 1) / result.capacity!.limit;
    if (!finite(result.score)) { delete result.score; reject('nonfinite-score'); }
  }
  return result;
}

/** Deterministic one-request greedy proposal, not dispatch or globally optimal scheduling. */
export function planAllocation(snapshot: ComputeSnapshot, request: TaskConstraints, context: PlanningContext): AllocationPlan {
  const errors = invalidInputs(request, context);
  if (!fresh(snapshot.observedAt, context.policy.telemetryMaxAgeMs, context.now)) errors.push('stale-snapshot');
  if (new Set(snapshot.models.map(m => m.id)).size !== snapshot.models.length || new Set(snapshot.pools.map(p => p.id)).size !== snapshot.pools.length) errors.push('duplicate-model-or-pool');
  if (context.state.commitments.some(c => c.id === request.allocationId)) errors.push('allocation-id-already-committed');
  const candidates = errors.length ? [] : snapshot.models.map(m => evaluate(snapshot, m, request, context));
  const winner = candidates.filter(c => c.reasons.length === 0).sort((a, b) => b.score! - a.score! || a.modelId.localeCompare(b.modelId))[0];
  const base: ProposalBase = { request: copy(request), snapshotRevision: snapshot.revision, candidates,
    allocation: { id: request.allocationId, unitId: request.unitId, at: context.now, status: winner ? 'proposed' : 'blocked', reason: '' } };
  if (!winner) {
    const reasons = errors.length ? errors : candidates.length ? candidates.flatMap(c => c.reasons.map(r => `${c.modelId}:${r}`)) : ['no-models'];
    base.allocation.reason = reasons.join('; ').slice(0, 1000);
    return { ...base, kind: 'blocked', reasons };
  }
  base.allocation.modelId = winner.modelId;
  base.allocation.reason = 'Feasible greedy proposal using independent quality lower bound, all quota windows and outstanding commitments; not dispatched.';
  return { ...base, kind: 'choice', modelId: winner.modelId, poolId: winner.poolId, signature: profileSignature(snapshot.models.find(m => m.id === winner.modelId)!) };
}

export interface ReservationResult { status: 'reserved' | 'existing' | 'blocked'; state: ComputeState; plan: AllocationPlan; reasons: string[]; }
/** Parent must persist using revision/CAS atomically. Replaying a reservation never adds another. */
export function reserveAllocation(snapshot: ComputeSnapshot, proposal: AllocationPlan, context: PlanningContext): ReservationResult {
  const refuse = (reasons: string[]): ReservationResult => ({ status: 'blocked', state: context.state, plan: proposal, reasons });
  if (proposal.kind !== 'choice') return refuse(['proposal-is-blocked']);
  const existing = context.state.commitments.find(c => c.id === proposal.request.allocationId);
  if (existing) {
    if (!same(existing.request, proposal.request) || existing.modelId !== proposal.modelId || existing.signature !== proposal.signature) return refuse(['allocation-id-conflict']);
    return { status: 'existing', state: context.state, plan: proposal, reasons: [] };
  }
  const model = snapshot.models.find(m => m.id === proposal.modelId);
  if (!model || profileSignature(model) !== proposal.signature) return refuse(['selected-model-removed-or-changed']);
  // Reevaluate exactly the pinned request; a fallback is a fresh plan of proposal.request.
  const checked = planAllocation(snapshot, proposal.request, context);
  const candidate = checked.candidates.find(c => c.modelId === proposal.modelId);
  if (!candidate || candidate.reasons.length) return refuse(candidate?.reasons ?? (checked.kind === 'blocked' ? checked.reasons : ['selected-model-not-feasible']));
  const pool = snapshot.pools.find(p => p.id === model.poolId)!;
  const commitment: Commitment = { id: proposal.request.allocationId, request: copy(proposal.request), modelId: model.id, poolId: pool.id,
    signature: proposal.signature, status: 'reserved', at: context.now,
    quota: Object.fromEntries(candidate.windows.map(w => [w.id, { fraction: w.estimate!, resetsAt: pool.windows.find(pw => pw.id === w.id)?.resetsAt }])) };
  const state = copy(context.state);
  state.commitments.push(commitment);
  return { status: 'reserved', state, plan: { ...proposal, candidates: checked.candidates, snapshotRevision: snapshot.revision,
    allocation: { ...proposal.allocation, status: 'admitted', at: context.now, reason: 'Reserved after revalidation; no dispatch performed.' } }, reasons: [] };
}

/** Finishing releases slots, not unobserved quota. Only never-started work can cancel free. */
export function transitionCommitment(state: ComputeState, id: string, status: 'running' | 'finished' | 'cancelled', at?: number): ComputeState {
  const existing = state.commitments.find(c => c.id === id);
  if (!existing) throw new Error('unknown-commitment');
  if (existing.status === status) return state;
  const valid = (existing.status === 'reserved' && (status === 'running' || status === 'cancelled'))
    || (existing.status === 'running' && status === 'finished');
  if (!valid) throw new Error('invalid-commitment-transition');
  if (at !== undefined && (!finite(at) || at < existing.at)) throw new Error('invalid-transition-time');
  const next = copy(state);
  const changed = next.commitments.find(c => c.id === id)!;
  changed.status = status;
  if (status === 'finished' && at !== undefined) changed.finishedAt = at;
  return next;
}

export type EvidenceUpdate = {
  kind: 'verified-outcome'; id: string; model: ModelProfile; taskClass: string; score: number;
  observedAt: number; verifier: { id: string; independent: boolean };
} | {
  kind: 'quota-delta'; id: string; allocationId: string; before: ComputePool; after: ComputePool;
  /** Adapter assertion: no expiry, replenishment or negative adjustments inside this interval. */
  counterSemantics?: 'monotone-within-window';
};
export interface EvidenceResult { state: ComputeState; accepted: boolean; reasons: string[]; }
/** Pure, deduplicated evidence ingest. Claimed/self-judged scores cannot improve quality. */
export function updateEvidence(state: ComputeState, event: EvidenceUpdate): EvidenceResult {
  const reject = (reason: string): EvidenceResult => ({ state, accepted: false, reasons: [reason] });
  if (!event.id) return reject('missing-evidence-id');
  if (state.seenEvidenceIds.includes(event.id)) return reject('duplicate-evidence');
  const next = copy(state);
  if (event.kind === 'verified-outcome') {
    if (!event.verifier.independent || !event.verifier.id || !fraction(event.score) || !finite(event.observedAt) || !event.taskClass) return reject('invalid-or-unverified-outcome');
    const signature = qualitySignature(event.model);
    const previous = next.quality.find(q => q.modelId === event.model.id && q.taskClass === event.taskClass);
    if (previous && event.observedAt < previous.observedAt) return reject('out-of-order-outcome');
    const matching = previous?.signature === signature ? previous : undefined;
    const samples = (matching?.samples ?? 0) + 1;
    const entry: QualityEvidence = { modelId: event.model.id, taskClass: event.taskClass, signature, samples,
      mean: (matching?.mean ?? 0) + (event.score - (matching?.mean ?? 0)) / samples, latest: event.score,
      observedAt: event.observedAt, verifierId: event.verifier.id,
      observations: [...(matching?.observations ?? []), { score: event.score, observedAt: event.observedAt, verifierId: event.verifier.id }] };
    next.quality = next.quality.filter(q => q.modelId !== entry.modelId || q.taskClass !== entry.taskClass).concat(entry);
  } else {
    const { before, after } = event;
    const commitment = next.commitments.find(c => c.id === event.allocationId);
    if (!commitment || (commitment.status !== 'running' && commitment.status !== 'finished') || before.id !== after.id || after.id !== commitment.poolId
      || !finite(before.observedAt) || !finite(after.observedAt) || after.observedAt <= before.observedAt || before.observedAt > commitment.at) return reject('unmatched-quota-observation');
    for (const window of after.windows) {
      const prior = before.windows.find(w => w.id === window.id);
      const observation: QuotaDeltaEvidence = { id: event.id, allocationId: commitment.id, poolId: after.id, windowId: window.id,
        beforeAt: before.observedAt, afterAt: after.observedAt, confounded: true, attributionConfidence: 'unidentified' };
      if (!prior || !fraction(prior.usedFraction) || !fraction(window.usedFraction) || window.usedFraction < prior.usedFraction
        || prior.resetsAt !== window.resetsAt || prior.windowMs !== window.windowMs
        || (prior.resetsAt !== undefined && prior.resetsAt <= after.observedAt)
        || before.status !== 'available' || after.status !== 'available') {
        observation.reason = 'reset-changing-window-or-incomplete-consumption';
      } else {
        observation.delta = window.usedFraction - prior.usedFraction;
        if (event.counterSemantics !== 'monotone-within-window') {
          observation.reason = 'unknown-counter-semantics';
          next.quotaObservations.push(observation);
          continue;
        }
        observation.requestUsageInterval = [0, observation.delta];
        // Includes outside usage. Never subtract it or report this as our consumption.
        const existing = next.quotaEstimates.find(e => e.modelId === commitment.modelId && e.windowId === window.id);
        if (existing && after.observedAt < existing.observedAt) return reject('out-of-order-quota-observation');
        const entry: QuotaEstimate = { modelId: commitment.modelId, windowId: window.id, upperBound: Math.max(existing?.upperBound ?? 0, observation.delta),
          samples: (existing?.samples ?? 0) + 1, observedAt: after.observedAt, confounded: true, attributionConfidence: 'unidentified' };
        next.quotaEstimates = next.quotaEstimates.filter(e => e.modelId !== entry.modelId || e.windowId !== entry.windowId).concat(entry);
      }
      next.quotaObservations.push(observation);
    }
  }
  next.seenEvidenceIds.push(event.id);
  return { state: next, accepted: true, reasons: [] };
}
