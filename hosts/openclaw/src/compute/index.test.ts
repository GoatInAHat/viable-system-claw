import { describe, expect, it } from 'vitest';
import type { ComputePool, ComputeSnapshot, ModelProfile } from '../model.js';
import {
  emptyComputeState, planAllocation, reserveAllocation, transitionCommitment, updateEvidence,
  type ComputePolicy, type ComputeState, type PlanningContext, type TaskConstraints,
} from './index.js';

const now = 10_000;
const policy = (): ComputePolicy => ({
  telemetryMaxAgeMs: 5_000, profileMaxAgeMs: 5_000, qualityMaxAgeMs: 5_000, estimateMaxAgeMs: 5_000,
  minimumQualitySamples: 10, qualityAlpha: 0.1,
  weights: { quota: 1, latency: 0, capacity: 0, money: 1 }, prices: {},
});
const task = (patch: Partial<TaskConstraints> = {}): TaskConstraints => ({
  allocationId: 'work-1', unitId: 'unit', taskClass: 'implementation', requiredCapabilities: ['tools'],
  minimumQuality: 0.8, expectedContribution: 1, ...patch,
});
const pool = (patch: Partial<ComputePool> = {}): ComputePool => ({
  id: 'pool', label: 'User supplied', kind: 'subscription', observedAt: now,
  status: 'available', concurrency: 3, active: 0,
  windows: [{ id: 'short', label: 'Short', usedFraction: 0.6, resetsAt: 20_000 },
    { id: 'long', label: 'Long', usedFraction: 0.1, resetsAt: 30_000 }], ...patch,
});
const model = (patch: Partial<ModelProfile> = {}): ModelProfile => ({
  id: 'opaque-a', poolId: 'pool', label: 'Not a routing hint', capabilities: ['tools'],
  observedAt: now, quality: 1, samples: 10_000,
  quotaCost: { short: 0.1, long: 0.05 }, ...patch,
});
const snapshot = (models = [model()], pools = [pool()]): ComputeSnapshot => ({
  revision: 1, observedAt: now, models, pools, allocations: [],
});
function verified(state: ComputeState, m: ModelProfile, score = 1, samples = 100): ComputeState {
  for (let i = 0; i < samples; i++) {
    state = updateEvidence(state, { kind: 'verified-outcome', id: `${m.id}-${score}-${i}`,
      model: m, taskClass: 'implementation', score, observedAt: now - 100 + i,
      verifier: { id: 'held-out-tests', independent: true } }).state;
  }
  return state;
}
function context(models = [model()]): PlanningContext {
  return { now, policy: policy(), state: models.reduce((s, m) => verified(s, m), emptyComputeState()) };
}
function running(snapshotValue = snapshot(), ctx = context()): PlanningContext {
  const plan = planAllocation(snapshotValue, task(), ctx);
  const reserved = reserveAllocation(snapshotValue, plan, ctx);
  expect(reserved.status).toBe('reserved');
  return { ...ctx, state: transitionCommitment(reserved.state, 'work-1', 'running') };
}

describe('compute feasibility and evidence', () => {
  it('uses model-specific quota multipliers and finds a feasible alternative', () => {
    const expensive = model({ id: 'opaque-z', quotaCost: { short: 0.5, long: 0.01 } });
    const cheap = model({ id: 'opaque-a' });
    const plan = planAllocation(snapshot([expensive, cheap]), task(), context([expensive, cheap]));
    expect(plan.kind).toBe('choice');
    if (plan.kind === 'choice') expect(plan.modelId).toBe(cheap.id);
    expect(plan.candidates.find(c => c.modelId === expensive.id)?.reasons).toContain('quota-window-exhausted:short');
  });

  it('requires ALL overlapping windows to fit, not just the cheapest/shortest one', () => {
    const p = pool({ windows: [{ id: 'short', label: 'S', usedFraction: 0.1 }, { id: 'long', label: 'L', usedFraction: 0.99 }] });
    const plan = planAllocation(snapshot([model()], [p]), task(), context());
    expect(plan.kind).toBe('blocked');
    expect(plan.candidates[0].reasons).toEqual(['quota-window-exhausted:long']);
  });

  it('never treats missing, NaN, stale or reset-crossing consumption as free', () => {
    for (const p of [pool({ observedAt: 0 }), pool({ windows: [] }),
      pool({ windows: [{ id: 'short', label: 'S', usedFraction: Number.NaN }] }),
      pool({ windows: [{ id: 'short', label: 'S', usedFraction: 0, resetsAt: now }] })]) {
      expect(planAllocation(snapshot([model()], [p]), task(), context()).kind).toBe('blocked');
    }
    expect(planAllocation({ ...snapshot(), observedAt: 0 }, task(), context()).kind).toBe('blocked');
    expect(planAllocation(snapshot([model({ quotaCost: {} })]), task(), context()).kind).toBe('blocked');
  });

  it('requires independent task-class-specific quality, not model self-ratings', () => {
    const ctx = { ...context(), state: emptyComputeState() };
    expect(planAllocation(snapshot(), task(), ctx).kind).toBe('blocked');
    const invalid = updateEvidence(ctx.state, { kind: 'verified-outcome', id: 'claim', model: model(), taskClass: 'implementation',
      score: 1, observedAt: now, verifier: { id: 'model-self', independent: false } });
    expect(invalid.accepted).toBe(false);
    expect(invalid.state.quality).toHaveLength(0);
    expect(planAllocation(snapshot(), task({ taskClass: 'research' }), context()).kind).toBe('blocked');
    expect(planAllocation(snapshot(), task(), { ...context(), now: 20_000 }).kind).toBe('blocked');
  });

  it('shows uncertainty/sample evidence and responds immediately to quality regression', () => {
    const ctx = context();
    const before = planAllocation(snapshot(), task(), ctx);
    expect(before.candidates[0].quality?.samples).toBe(100);
    expect(before.candidates[0].quality?.lowerBound).toBeLessThan(1);
    expect(before.candidates[0].expectedVerifiedContribution).toBeGreaterThan(0.8);
    const regression = updateEvidence(ctx.state, { kind: 'verified-outcome', id: 'regression', model: model(), taskClass: 'implementation',
      score: 0.2, observedAt: now, verifier: { id: 'held-out-tests', independent: true } });
    const after = planAllocation(snapshot(), task(), { ...ctx, state: regression.state });
    expect(after.candidates[0].reasons).toContain('quality-below-task-minimum');
  });

  it('blocks unknown and exhausted concurrent capacity for every pool kind', () => {
    for (const kind of ['subscription', 'throughput', 'metered'] as const) {
      for (const capacity of [{ active: 3 }, { active: undefined }, { concurrency: undefined }]) {
        expect(planAllocation(snapshot([model()], [pool({ kind, ...capacity })]), task(), context()).kind).toBe('blocked');
      }
    }
  });

  it('distinguishes throughput from subscription and requires no imaginary quota for throughput', () => {
    expect(planAllocation(snapshot([model()], [pool({ kind: 'throughput', windows: [] })]), task(), context()).kind).toBe('choice');
    expect(planAllocation(snapshot([model()], [pool({ kind: 'subscription', windows: [] })]), task(), context()).kind).toBe('blocked');
  });

  it('refuses metered overflow without exact supplied authorization and fresh prices', () => {
    const s = snapshot([model()], [pool({ kind: 'metered', windows: [] })]);
    const ctx = context();
    ctx.policy.prices[model().id] = { amount: 0.2, currency: 'USD', observedAt: now };
    expect(planAllocation(s, task(), ctx).candidates[0].reasons).toContain('paid-overflow-not-authorized');
    const auth = { poolIds: ['pool'], maximumCost: 0.2, currency: 'USD', expiresAt: now + 1_000 };
    expect(planAllocation(s, task({ paidAuthorization: auth }), ctx).kind).toBe('choice');
    for (const patch of [{ maximumCost: 0.1 }, { expiresAt: now }, { currency: 'other' }, { poolIds: ['elsewhere'] }]) {
      expect(planAllocation(s, task({ paidAuthorization: { ...auth, ...patch } }), ctx).kind).toBe('blocked');
    }
    ctx.policy.prices[model().id].observedAt = 0;
    expect(planAllocation(s, task({ paidAuthorization: auth }), ctx).kind).toBe('blocked');
  });

  it('scores from data and is independent of provider, label and enumeration order', () => {
    const a = model({ id: 'some-model', latencyMs: 100 });
    const b = model({ id: 'another-model', latencyMs: 1, label: 'arbitrary-label' });
    const ctx = context([a, b]);
    ctx.policy.weights.latency = 0.1;
    const first = planAllocation(snapshot([a, b]), task(), ctx);
    const reordered = planAllocation(snapshot([b, a]), task(), ctx);
    expect(first.kind === 'choice' && first.modelId).toBe(b.id);
    expect(reordered.kind === 'choice' && reordered.modelId).toBe(b.id);
  });
});

describe('pure reservations, revalidation and reconciliation', () => {
  it('pins constraints, is immutable and is idempotent across serialized restart', () => {
    const ctx = context();
    const request = task();
    const plan = planAllocation(snapshot(), request, ctx);
    request.requiredCapabilities.push('changed-after-planning');
    expect(plan.request.requiredCapabilities).toEqual(['tools']);
    const reserved = reserveAllocation(snapshot(), plan, ctx);
    expect(reserved.status).toBe('reserved');
    expect(reserved.plan.allocation.status).toBe('admitted');
    expect(ctx.state.commitments).toHaveLength(0);
    const restartState: ComputeState = JSON.parse(JSON.stringify(reserved.state));
    const replay = reserveAllocation(snapshot(), plan, { ...ctx, state: restartState });
    expect(replay.status).toBe('existing');
    expect(replay.state.commitments).toHaveLength(1);
    expect(planAllocation(snapshot(), plan.request, { ...ctx, state: restartState }).kind).toBe('blocked');
  });

  it('accounts racing commitments against capacity and every quota window', () => {
    const s = snapshot([model()], [pool({ concurrency: 1 })]);
    const ctx = context();
    const first = planAllocation(s, task(), ctx);
    const racing = planAllocation(s, task({ allocationId: 'work-2' }), ctx);
    const reserved = reserveAllocation(s, first, ctx);
    const second = reserveAllocation(s, racing, { ...ctx, state: reserved.state });
    expect(second.status).toBe('blocked');
    expect(second.reasons).toContain('no-concurrent-capacity');
    const quotaTight = snapshot([model()], [pool({ concurrency: 10, windows: [{ id: 'short', label: 'S', usedFraction: 0.85 }] })]);
    const admitted = reserveAllocation(quotaTight, planAllocation(quotaTight, task(), ctx), ctx);
    expect(planAllocation(quotaTight, task({ allocationId: 'work-2' }), { ...ctx, state: admitted.state }).kind).toBe('blocked');
  });

  it('never double-counts commitments explicitly included in matching telemetry', () => {
    const ctx = running();
    const p = pool({ concurrency: 2, active: 1, windows: [{ id: 'short', label: 'S', usedFraction: 0.8, resetsAt: 20_000 }] });
    const s = snapshot([model()], [p]);
    const coverage = [{ snapshotRevision: s.revision, poolId: 'pool', activeAllocationIds: ['work-1'], quotaAllocationIds: { short: ['work-1'] } }];
    const result = planAllocation(s, task({ allocationId: 'next' }), { ...ctx, coverage });
    expect(result.kind).toBe('choice');
    expect(result.candidates[0].capacity?.committed).toBe(0);
    expect(result.candidates[0].windows[0].committed).toBe(0);
    expect(planAllocation(s, task({ allocationId: 'next' }), { ...ctx, coverage: [{ ...coverage[0], snapshotRevision: 0 }] }).kind).toBe('blocked');
  });

  it('releases slots after completion but retains unaccounted usage until observed reset', () => {
    const ctx = running();
    ctx.state = transitionCommitment(ctx.state, 'work-1', 'finished', ctx.now);
    const result = planAllocation(snapshot(), task({ allocationId: 'next' }), ctx);
    expect(result.candidates[0].capacity?.committed).toBe(0);
    expect(result.candidates[0].windows[0].committed).toBe(0.1);
    const later = 21_000;
    const s = snapshot([model({ observedAt: later })], [pool({ observedAt: later, windows: [{ id: 'short', label: 'S', usedFraction: 0, resetsAt: 25_000 }] })]);
    s.observedAt = later;
    const reset = planAllocation(s, task({ allocationId: 'next' }), { ...ctx, now: later });
    expect(reset.candidates[0].windows[0].committed).toBe(0);
    expect(() => transitionCommitment(ctx.state, 'work-1', 'cancelled')).toThrow();
  });

  it('preserves running and post-reset finished reservations across quota reset', () => {
    const ctx = running();
    const later = 21_000;
    const s = snapshot([model({ observedAt: later })], [pool({ observedAt: later, windows: [{ id: 'short', label: 'S', usedFraction: .85, resetsAt: 25_000 }] })]);
    s.observedAt = later;
    const request = task({ allocationId: 'after-reset' });
    const check = () => planAllocation(s, request, { ...ctx, now: later });
    expect(check().candidates[0].windows[0].committed).toBe(.1);
    expect(check().kind).toBe('blocked');
    ctx.state = transitionCommitment(ctx.state, 'work-1', 'finished', later);
    expect(check().candidates[0].windows[0].committed).toBe(.1);
    expect(check().kind).toBe('blocked');
  });

  it('allows cancellation only before work starts and releases the unused reservation', () => {
    const ctx = context();
    const reserved = reserveAllocation(snapshot(), planAllocation(snapshot(), task(), ctx), ctx);
    ctx.state = transitionCommitment(reserved.state, 'work-1', 'cancelled');
    const next = planAllocation(snapshot(), task({ allocationId: 'next' }), ctx);
    expect(next.candidates[0].capacity?.committed).toBe(0);
    expect(next.candidates[0].windows[0].committed).toBe(0);
    expect(() => transitionCommitment(ctx.state, 'work-1', 'running')).toThrow();
  });

  it('revalidates removed/changed models and quota/capacity at admission; fallback preserves constraints', () => {
    const a = model();
    const b = model({ id: 'fallback', capabilities: [] });
    const ctx = context([a, b]);
    const request = task({ allowedModelIds: [a.id, b.id] });
    const plan = planAllocation(snapshot([a, b]), request, ctx);
    expect(reserveAllocation(snapshot([b]), plan, ctx).reasons).toContain('selected-model-removed-or-changed');
    expect(reserveAllocation(snapshot([model({ quotaCost: { short: 0.2, long: 0.05 } })]), plan, ctx).status).toBe('blocked');
    expect(reserveAllocation(snapshot([a], [pool({ active: 3 })]), plan, ctx).status).toBe('blocked');
    expect(planAllocation(snapshot([b]), plan.request, ctx).kind).toBe('blocked');
    expect(planAllocation(snapshot([model({ capabilities: ['tools', 'new'] })]), plan.request, ctx).kind).toBe('blocked');
  });
});

describe('conservative learning with outside consumption', () => {
  it('keeps shared deltas as confounded intervals and never reduces configured costs', () => {
    const ctx = running();
    const before = pool();
    const after = pool({ observedAt: now + 1_000, windows: before.windows.map(w => ({ ...w, usedFraction: w.usedFraction + 0.2 })) });
    const event = { kind: 'quota-delta' as const, counterSemantics: 'monotone-within-window' as const, id: 'delta-1', allocationId: 'work-1', before, after };
    const result = updateEvidence(ctx.state, event);
    expect(result.accepted).toBe(true);
    expect(result.state.quotaObservations[0].delta).toBeCloseTo(0.2);
    expect(result.state.quotaObservations[0].requestUsageInterval?.[0]).toBe(0);
    expect(result.state.quotaObservations[0].requestUsageInterval?.[1]).toBeCloseTo(0.2);
    expect(result.state.quotaObservations[0].confounded).toBe(true);
    expect(result.state.quotaEstimates[0].upperBound).toBeCloseTo(0.2);
    expect(result.state.quotaEstimates[0]).toMatchObject({ samples: 1, confounded: true, attributionConfidence: 'unidentified' });
    expect(updateEvidence(result.state, event).accepted).toBe(false);
    const zero = updateEvidence(result.state, { ...event, id: 'delta-zero', after: { ...before, observedAt: now + 2_000 } });
    expect(zero.state.quotaEstimates[0].upperBound).toBeCloseTo(0.2);
    const plan = planAllocation(snapshot(), task({ allocationId: 'next' }), { ...ctx, state: zero.state, now: now + 2_000 });
    expect(plan.candidates[0].windows[0].estimate).toBeCloseTo(0.2);
  });

  it('does not learn free usage from negative/reset deltas or stale evidence', () => {
    const ctx = running();
    const before = pool();
    const after = pool({ observedAt: now + 1_000, windows: before.windows.map(w => ({ ...w, usedFraction: 0, resetsAt: 40_000 })) });
    const result = updateEvidence(ctx.state, { kind: 'quota-delta', id: 'reset', allocationId: 'work-1', before, after });
    expect(result.accepted).toBe(true);
    expect(result.state.quotaEstimates).toHaveLength(0);
    expect(result.state.quotaObservations[0].delta).toBeUndefined();
    const learned = updateEvidence(ctx.state, { kind: 'quota-delta', counterSemantics: 'monotone-within-window', id: 'positive', allocationId: 'work-1', before,
      after: pool({ observedAt: now + 1, windows: before.windows.map(w => ({ ...w, usedFraction: w.usedFraction + 0.01 })) }) });
    const plan = planAllocation(snapshot(), task({ allocationId: 'next' }), { ...ctx, state: learned.state, policy: { ...policy(), estimateMaxAgeMs: 0 }, now: now + 2 });
    expect(plan.candidates[0].reasons).toContain('stale-quota-estimate:short');
  });

  it('deduplicates verified outcomes and rejects out-of-order evidence', () => {
    const state = emptyComputeState();
    const event = { kind: 'verified-outcome' as const, id: 'proof', model: model(), taskClass: 'implementation', score: 1,
      observedAt: now, verifier: { id: 'judge', independent: true } };
    const once = updateEvidence(state, event);
    expect(once.state.quality[0].samples).toBe(1);
    expect(updateEvidence(once.state, event).accepted).toBe(false);
    expect(updateEvidence(once.state, { ...event, id: 'older', observedAt: now - 1 }).accepted).toBe(false);
    expect(state.quality).toHaveLength(0);
  });
});

// Schemas are intentionally query-only: no caller snapshot or caller clock accepted.
import { Check } from 'typebox/value';
import { AllocationPlanSchema, ComputePlanInputSchema } from './schema.js';

describe('bounded native query schemas', () => {
  it('accepts scenario input and both plan variants, rejects caller clock/snapshot and unknown fields', () => {
    const ctx = context();
    const input = { request: task(), policy: ctx.policy, state: ctx.state };
    expect(Check(ComputePlanInputSchema, input)).toBe(true);
    expect(Check(ComputePlanInputSchema, { ...input, now })).toBe(false);
    expect(Check(ComputePlanInputSchema, { ...input, snapshot: snapshot() })).toBe(false);
    expect(Check(ComputePlanInputSchema, { ...input, request: { ...input.request, dispatch: true } })).toBe(false);
    expect(Check(AllocationPlanSchema, planAllocation(snapshot(), task(), ctx))).toBe(true);
    expect(Check(AllocationPlanSchema, planAllocation(snapshot([]), task(), ctx))).toBe(true);
    const unknownCost = planAllocation(snapshot([model({ quotaCost: undefined })]), task(), ctx);
    expect(unknownCost.kind).toBe('blocked');
    expect(Check(AllocationPlanSchema, unknownCost)).toBe(true);
  });

  it('bounds all collections and refuses invalid numbers, policy thresholds and evidence fields', () => {
    const ctx = context();
    const input = { request: task(), policy: ctx.policy, state: ctx.state };
    expect(Check(ComputePlanInputSchema, { ...input, policy: { ...ctx.policy, qualityAlpha: 0 } })).toBe(false);
    expect(Check(ComputePlanInputSchema, { ...input, request: { ...task(), expectedContribution: Infinity } })).toBe(false);
    expect(Check(ComputePlanInputSchema, { ...input, request: { ...task(), allowedModelIds: Array.from({ length: 257 }, (_, i) => `m-${i}`) } })).toBe(false);
    expect(Check(ComputePlanInputSchema, { ...input, state: { ...ctx.state, arbitrary: {} } })).toBe(false);
    expect(Check(ComputePlanInputSchema, { ...input, policy: { ...ctx.policy, prices: { 'bad key': { amount: 1, currency: 'USD', observedAt: now } } } })).toBe(false);
  });
});

describe('learning edge conditions', () => {
  it('one fresh result cannot refresh an old quality batch', () => {
    const ctx = context();
    const later = now + 10_000;
    ctx.state = updateEvidence(ctx.state, { kind: 'verified-outcome', id: 'only-fresh', model: model(),
      taskClass: 'implementation', score: 1, observedAt: later, verifier: { id: 'judge', independent: true } }).state;
    const s = snapshot([model({ observedAt: later })], [pool({ observedAt: later })]);
    s.observedAt = later;
    const plan = planAllocation(s, task(), { ...ctx, now: later });
    expect(plan.candidates[0].reasons).toContain('missing-stale-or-insufficient-independent-quality');
  });

  it('keeps unknown/rolling-counter deltas as observations without inventing request bounds', () => {
    const ctx = running();
    const before = pool();
    const after = pool({ observedAt: now + 1_000, windows: before.windows.map(w => ({ ...w, usedFraction: w.usedFraction + 0.1 })) });
    const result = updateEvidence(ctx.state, { kind: 'quota-delta', id: 'rolling-or-unknown', allocationId: 'work-1', before, after });
    expect(result.state.quotaEstimates).toHaveLength(0);
    expect(result.state.quotaObservations[0].delta).toBeCloseTo(0.1);
    expect(result.state.quotaObservations[0].reason).toBe('unknown-counter-semantics');
    expect(result.state.quotaObservations[0].requestUsageInterval).toBeUndefined();
  });
});
