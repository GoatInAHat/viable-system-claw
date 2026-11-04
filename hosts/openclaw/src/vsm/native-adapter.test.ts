import { describe, expect, it } from 'vitest';
import { createNativeExecutor } from './native-adapter.js';
import type { EffectExecutor, EffectIntent, EffectOutcome, EffectReceipt } from '../execution/types.js';
import type { DispatchRequest } from './executor.js';

const request: DispatchRequest = {
  effectId: 'a/environment/return/effect/1',
  unitId: 'a',
  procedureId: 'a/seed/operation',
  executionRef: 'agent:canary',
  grant: { id: 'g', version: 1 },
  capabilities: { tools: [], surfaces: [] },
};

const intent = { agentId: 'canary', message: 'sample host health', purpose: 'canary', createdAt: 10 };

function fakeExecutor(receipt: EffectReceipt, outcome?: EffectOutcome) {
  const calls = { dispatch: 0, reconcile: 0 };
  const executor: EffectExecutor = {
    async dispatch(_intent: EffectIntent) { calls.dispatch++; return receipt; },
    async reconcile(_receipt: EffectReceipt) { calls.reconcile++; if (!outcome) throw new Error('missing'); return outcome!; },
  };
  return { calls, executor };
}

const accepted: EffectReceipt = { effectId: request.effectId, status: 'accepted', runId: 'run-1', sessionKey: 'agent:canary:subagent:x', at: 11 };

describe('native adapter', () => {
  it('launches nothing when the host cannot form an intent', async () => {
    const { calls, executor } = fakeExecutor(accepted);
    const native = createNativeExecutor({ executor, resolveIntent: () => undefined });
    expect(await native.dispatch(request)).toEqual({ status: 'not-launched' });
    expect(calls.dispatch).toBe(0);
  });

  it('reports acceptance with the durable native identity', async () => {
    const { executor } = fakeExecutor(accepted);
    const native = createNativeExecutor({ executor, resolveIntent: () => intent });
    expect(await native.dispatch(request)).toEqual({ status: 'accepted', nativeId: 'run-1', sessionKey: 'agent:canary:subagent:x' });
  });

  it('treats a thrown dispatch as unknown, not as absence', async () => {
    const executor: EffectExecutor = {
      async dispatch() { throw new Error('relay down'); },
      async reconcile() { throw new Error('unused'); },
    };
    const native = createNativeExecutor({ executor, resolveIntent: () => intent });
    expect(await native.dispatch(request)).toEqual({ status: 'unknown' });
  });

  it('separates a proven rejection from an unknown admission', async () => {
    const rejected: EffectReceipt = {
      effectId: request.effectId, status: 'rejected', runId: null, sessionKey: null, at: 12,
      reason: 'authority-rejected', admission: 'not-accepted',
    };
    const native = createNativeExecutor({ executor: fakeExecutor(rejected).executor, resolveIntent: () => intent });
    expect(await native.dispatch(request)).toEqual({ status: 'not-launched' });

    const ambiguous = { ...rejected, admission: 'unknown' as const };
    const native2 = createNativeExecutor({ executor: fakeExecutor(ambiguous).executor, resolveIntent: () => intent });
    expect(await native2.dispatch(request)).toEqual({ status: 'unknown' });
  });

  it('refuses to reconcile without a receipt identity', async () => {
    const native = createNativeExecutor({ executor: fakeExecutor(accepted).executor, resolveIntent: () => intent });
    expect(await native.reconcile({ effectId: request.effectId, nativeId: null })).toEqual({ status: 'unknown' });
  });

  it('maps a terminal native outcome to a bounded kernel outcome', async () => {
    const outcome: EffectOutcome = {
      effectId: request.effectId, runId: 'run-1', status: 'ok', terminal: true, endedAt: 30,
      stopReason: 'completed', livenessState: 'ended',
      resultRef: { kind: 'native-session', runId: 'run-1', sessionKey: 'agent:canary:subagent:x', messagesObserved: 2, history: 'available', historyMayBeTruncated: false, privateResult: 'not-requested' },
    };
    const { executor } = fakeExecutor(accepted, outcome);
    const native = createNativeExecutor({
      executor, resolveIntent: () => intent, resolveReceipt: () => accepted,
      environmentRef: () => 'evidence:environment', now: () => 99,
    });
    expect(await native.reconcile({ effectId: request.effectId, nativeId: 'run-1' })).toEqual({
      status: 'completed', nativeId: 'run-1',
      outcome: { value: 1, evidenceRef: 'run:run-1', at: 30 },
      success: true, environmentEvidenceRef: 'evidence:environment',
    });
  });


  it('refuses to launch when the live authority fence closes after admission', async () => {
    const { calls, executor } = fakeExecutor(accepted);
    const native = createNativeExecutor({
      executor, resolveIntent: () => intent,
      assertAdmission: async () => false,
    });
    expect(await native.dispatch(request)).toEqual({ status: 'not-launched' });
    expect(calls.dispatch).toBe(0);
  });

  it('does not score a silent process success as a delivered outcome', async () => {
    const silent: EffectOutcome = {
      effectId: request.effectId, runId: 'run-1', status: 'ok', terminal: true, endedAt: 30,
      stopReason: 'completed', livenessState: 'ended',
      terminalReply: { disposition: 'empty', code: 'message-tool-not-called' },
    };
    const native = createNativeExecutor({
      executor: fakeExecutor(accepted, silent).executor, resolveIntent: () => intent, resolveReceipt: () => accepted,
      evaluate: outcome => {
        const delivered = outcome.terminalReply?.disposition === 'visible' && (outcome.terminalReply.textCharacters ?? 0) > 0;
        const ok = outcome.status === 'ok' && delivered;
        return { value: ok ? 1 : 0, success: ok };
      },
    });
    const result = await native.reconcile({ effectId: request.effectId, nativeId: 'run-1' });
    expect(result).toMatchObject({ status: 'completed', success: false, outcome: { value: 0 } });
  });

  it('keeps a pending observation out of the outcome record', async () => {
    const pending: EffectOutcome = {
      effectId: request.effectId, runId: 'run-1', status: 'unknown', terminal: false, endedAt: null,
      stopReason: null, livenessState: 'running', reason: 'wait-pending',
    };
    const native = createNativeExecutor({
      executor: fakeExecutor(accepted, pending).executor, resolveIntent: () => intent, resolveReceipt: () => accepted,
    });
    expect(await native.reconcile({ effectId: request.effectId, nativeId: 'run-1' })).toEqual({ status: 'unknown' });
  });
});
