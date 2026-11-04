import { describe, expect, it } from 'vitest';
import { addUnit, configureChannel, createState, validateState } from './kernel.js';
import { createFakeExecutor, dispatchRequest, executionEvents, fakeComplete, fakeDispatch, fakeReconcile, fakeRestart, reconcileRequest } from './executor.js';
import { dispatchAdmission, step } from './runtime.js';
import type { Actor, Effect, VsmEvent, VsmState } from './types.js';

const actor: Actor = { kind: 'organ', unitId: 'root', role: 'S3' };
function apply(s: VsmState, event: VsmEvent, now = s.updatedAt + 1) {
  const r = step(s, event, now);
  expect(r.errors, JSON.stringify(r.errors)).toEqual([]);
  return r;
}
function reserved() {
  let s = addUnit(createState({ rootId: 'root', principalId: 'human', charter: 'Synthetic', now: 0 }), { id: 'worker', parentId: 'root' });
  s = configureChannel(s, 'worker/environment/return', { procedureId: 'worker/seed/operation', threshold: 1 });
  s = apply(s, { id: 'grant', type: 'grant.changed', actor, grant: {
    id: 'g', version: 1, unitId: 'worker', issuer: actor, capacity: 1, procedureIds: ['worker/seed/operation'], tools: [], surfaces: [], validFrom: 0, validUntil: 1_000_000, revokedAt: null,
  } }).state;
  const r = apply(s, { id: 'observation', type: 'observation', channelId: 'worker/environment/return', topic: 'change', index: 1, evidence: 1, evidenceRef: 'trace' });
  const e = Object.values(r.state.effects)[0];
  expect(r.actions[0]).toMatchObject({ type: 'dispatch', effectId: e.id });
  return { state: r.state, effect: e };
}
function events(s: VsmState, input: VsmEvent[]): VsmState {
  for (const e of input) s = apply(s, e).state;
  return s;
}

describe('durable dispatch/reconciliation contract', () => {
  it('persists stable intent and reservation before the fake can launch', () => {
    const { state, effect } = reserved();
    expect(effect).toMatchObject({ status: 'reserved', intentAt: 2, reservedAt: 2, grantId: 'g', grantVersion: 1, dispatchAttempts: 1, evidenceAtAdmission: 1, thresholdAtAdmission: 1 });
    const request = dispatchRequest(state, effect.id, 2);
    const fake = fakeDispatch(createFakeExecutor(), request);
    expect(fake.state.launches).toBe(1);
    const s = events(state, executionEvents(effect.id, fake.result, 'native-result'));
    expect(s.effects[effect.id].status).toBe('accepted');
    expect(s.effects[effect.id].receipt?.nativeId).toBe(`native:${effect.id}`);
  });
  it('replay never launches twice with identical effect identity', () => {
    const { state, effect } = reserved(); const request = dispatchRequest(state, effect.id, 2);
    const first = fakeDispatch(createFakeExecutor(), request);
    const duplicate = fakeDispatch(first.state, request);
    expect(duplicate.state.launches).toBe(1); expect(duplicate.result).toEqual(first.result);
    const original = JSON.stringify(state);
    const replay = step(state, { id: 'observation', type: 'observation', channelId: 'worker/environment/return', topic: 'change', index: 1, evidence: 1, evidenceRef: 'trace' }, 9);
    expect(replay.actions).toEqual([]); expect(JSON.stringify(replay.state)).toBe(original);
    expect(() => fakeDispatch(first.state, { ...request, executionRef: 'different' })).toThrow('IDEMPOTENCY_CONFLICT');
  });
  it('accepted launch with lost reply recovers receipt by stable effect ID after host/adapter restart', () => {
    const { state, effect } = reserved();
    const lost = fakeDispatch(createFakeExecutor(), dispatchRequest(state, effect.id, 2), 'lose-reply');
    let s = events(state, executionEvents(effect.id, lost.result, 'lost-reply'));
    expect(s.effects[effect.id].status).toBe('ambiguous');
    const restarted = apply(JSON.parse(JSON.stringify(s)) as VsmState, { id: 'restart', type: 'restart' });
    expect(restarted.actions).toEqual([{ type: 'reconcile', effectId: effect.id }]);
    expect(restarted.actions.some(a => a.type === 'dispatch')).toBe(false);
    s = restarted.state;
    const fake = fakeRestart(lost.state);
    s = events(s, executionEvents(effect.id, fakeReconcile(fake, reconcileRequest(s, effect.id)), 'recovery'));
    expect(s.effects[effect.id].status).toBe('accepted');
    expect(fake.launches).toBe(1);
    expect(step(s, { id: 'unsafe-retry', type: 'effect.admit', effectId: effect.id }, 100).errors[0].code).toBe('EFFECT_RECONCILE_FIRST');
  });
  it('crash before launch requires definitive absence before same-ID readmission', () => {
    const { state, effect } = reserved();
    const crashed = fakeDispatch(createFakeExecutor(), dispatchRequest(state, effect.id, 2), 'crash-before-launch');
    expect(crashed.state.launches).toBe(0);
    let s = events(state, executionEvents(effect.id, crashed.result, 'crashed'));
    expect(step(s, { id: 'premature', type: 'effect.admit', effectId: effect.id }, 10).errors[0].code).toBe('EFFECT_RECONCILE_FIRST');
    s = apply(s, { id: 'restart', type: 'restart' }).state;
    s = events(s, executionEvents(effect.id, fakeReconcile(crashed.state, reconcileRequest(s, effect.id)), 'absence'));
    expect(s.effects[effect.id].status).toBe('lost');
    const admitted = apply(s, { id: 'retry', type: 'effect.admit', effectId: effect.id });
    expect(admitted.actions).toContainEqual(expect.objectContaining({ type: 'dispatch', effectId: effect.id }));
    expect(Object.keys(admitted.state.effects)).toHaveLength(1);
    expect(admitted.state.effects[effect.id].dispatchAttempts).toBe(2);
    const launched = fakeDispatch(crashed.state, dispatchRequest(admitted.state, effect.id, admitted.state.updatedAt));
    expect(launched.state.launches).toBe(1);
  });
  it('unknown reconciliation remains ambiguous and never acts like authoritative absence', () => {
    const { state, effect } = reserved();
    const launched = fakeDispatch(createFakeExecutor(), dispatchRequest(state, effect.id, 2));
    const result = fakeReconcile(launched.state, reconcileRequest(state, effect.id), true);
    expect(result).toEqual({ status: 'unknown' });
    const s = events(state, executionEvents(effect.id, result, 'unavailable'));
    expect(s.effects[effect.id].status).toBe('ambiguous');
    expect(step(s, { id: 'retry', type: 'effect.admit', effectId: effect.id }, 100).errors[0].code).toBe('EFFECT_RECONCILE_FIRST');
  });
  it('duplicate completions and late accepted receipts cannot regress terminal state or repeat work', () => {
    const { state, effect } = reserved();
    let fake = fakeDispatch(createFakeExecutor(), dispatchRequest(state, effect.id, 2)).state;
    fake = fakeComplete(fake, effect.id, { value: 1, at: 3, evidenceRef: 'outcome' }, true, 'readback');
    const result = fakeReconcile(fake, reconcileRequest(state, effect.id));
    let s = events(state, executionEvents(effect.id, result, 'completed'));
    expect(s.effects[effect.id].status).toBe('succeeded');
    const snapshot = structuredClone(s.effects[effect.id]);
    s = events(s, executionEvents(effect.id, result, 'duplicate-completion'));
    expect(s.effects[effect.id]).toEqual(snapshot);
    expect(Object.keys(s.effects)).toHaveLength(1); expect(fake.launches).toBe(1);
    expect(validateState(s)).toEqual([]);
    const missing = step(s, { id: 'false-absence', type: 'effect.reconciled', effectId: effect.id, result: 'not-launched' }, 100);
    expect(missing.errors[0].code).toBe('RECONCILIATION_CONFLICT');
  });
  it('restart of a reserved effect reconciles, including crash before any launch attempt', () => {
    const { state, effect } = reserved();
    const restart = apply(state, { id: 'restart', type: 'restart' });
    expect(restart.state.effects[effect.id].status).toBe('ambiguous');
    expect(restart.actions).toEqual([{ type: 'reconcile', effectId: effect.id }]);
    expect(() => dispatchRequest(restart.state, effect.id, 10)).toThrow('EFFECT_NOT_RESERVED');
  });
  it('revocation closes the immediate native admission boundary without inventing cancellation of an accepted run', () => {
    const { state, effect } = reserved();
    const launched = fakeDispatch(createFakeExecutor(), dispatchRequest(state, effect.id, 2));
    let s = events(state, executionEvents(effect.id, launched.result, 'accepted'));
    const revoke = apply(s, { id: 'revoke', type: 'grant.revoked', actor, grantId: 'g', version: 2 });
    s = revoke.state;
    expect(s.effects[effect.id].status).toBe('accepted');
    expect(s.grantHistory[0].version).toBe(1);
    expect(revoke.actions).toEqual([{ type: 'reconcile', effectId: effect.id }]);
    const notLaunched = reserved();
    const withdrawn = apply(notLaunched.state, { id: 'revoke', type: 'grant.revoked', actor, grantId: 'g', version: 2 });
    expect(dispatchAdmission(withdrawn.state, notLaunched.effect.id, 3).admitted).toBe(false);
    expect(() => dispatchRequest(withdrawn.state, notLaunched.effect.id, 3)).toThrow();
  });
  it('same-ID retry preserves original procedure, cost and every reservation version', () => {
    const { state, effect } = reserved();
    let s = apply(state, { id: 'absent', type: 'effect.reconciled', effectId: effect.id, result: 'not-launched' }).state;
    s = configureChannel(s, effect.channelId, { procedureId: 'worker/seed/S4', cost: 0.01 });
    s = apply(s, { id: 'renew', type: 'grant.changed', actor, grant: { ...s.grants.g, version: 2 } }).state;
    const r = apply(s, { id: 'readmit', type: 'effect.admit', effectId: effect.id });
    expect(r.actions).toContainEqual(expect.objectContaining({ type: 'dispatch', procedureId: 'worker/seed/operation', grantVersion: 2 }));
    expect(r.state.effects[effect.id].cost).toBe(1);
    expect(r.state.effects[effect.id].reservations.map(r => r.grantVersion)).toEqual([1, 2]);
    expect(dispatchRequest(r.state, effect.id, r.state.updatedAt).procedureId).toBe('worker/seed/operation');
  });
  it('procedure bindings cannot authorize tools or surfaces outside a grant', () => {
    const { state, effect } = reserved();
    // Simulate an externally provisioned procedure footprint at bootstrap, not an allowed seed mutation.
    const s = structuredClone(state);
    s.procedures[effect.procedureId].requiredTools = ['restricted'];
    expect(dispatchAdmission(s, effect.id, s.updatedAt)).toEqual({ admitted: false, code: 'GRANT_CLOSED' });
    s.procedures[effect.procedureId].requiredTools = [];
    s.procedures[effect.procedureId].requiredSurfaces = ['protected'];
    expect(dispatchAdmission(s, effect.id, s.updatedAt).admitted).toBe(false);
    expect(dispatchAdmission(state, effect.id, state.updatedAt - 1)).toEqual({ admitted: false, code: 'CLOCK_REGRESSION' });
  });
  it('grant expiry and version change invalidate a queued dispatch token', () => {
    const { state, effect } = reserved();
    expect(dispatchAdmission(state, effect.id, 1_000_001)).toEqual({ admitted: false, code: 'GRANT_CLOSED' });
    const next = apply(state, { id: 'renew', type: 'grant.changed', actor, grant: { ...state.grants.g, version: 2 } });
    expect(dispatchAdmission(next.state, effect.id, 3).admitted).toBe(false);
  });
  it('does not release missing-return commitments when a receipt is reconciled', () => {
    const { state, effect } = reserved();
    let fake = fakeDispatch(createFakeExecutor(), dispatchRequest(state, effect.id, 2)).state;
    fake = fakeComplete(fake, effect.id, { value: 1, at: 3, evidenceRef: 'outcome' });
    let s = events(state, executionEvents(effect.id, fakeReconcile(fake, reconcileRequest(state, effect.id)), 'done-no-return'));
    const restart = apply(s, { id: 'restart', type: 'restart' });
    expect(restart.actions).toContainEqual({ type: 'reconcile', effectId: effect.id });
    s = restart.state;
    expect(s.effects[effect.id].environmentReturn).toBeNull();
    const repeated = events(s, executionEvents(effect.id, fakeReconcile(fake, reconcileRequest(s, effect.id)), 'repeated'));
    expect(repeated.effects[effect.id].environmentReturn).toBeNull();
  });
});
