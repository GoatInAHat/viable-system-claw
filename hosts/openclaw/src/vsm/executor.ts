import { dispatchAdmission } from './runtime.js';
import type { EffectOutcome, Id, VsmEvent, VsmState } from './types.js';

export interface DispatchRequest {
  /** Native adapter must use this exact durable idempotency key. */
  effectId: Id;
  /** Owning viable unit, carried from the persisted effect. */
  unitId: Id;
  procedureId: Id;
  executionRef: string;
  grant: { id: Id; version: number };
  capabilities: { tools: string[]; surfaces: string[] };
}
export interface ReconcileRequest { effectId: Id; nativeId: string | null }
export type ExecutionResult =
  | { status: 'accepted'; nativeId: string; sessionKey?: string }
  | { status: 'completed'; nativeId: string; outcome: EffectOutcome; success: boolean; environmentEvidenceRef: Id | null }
  | { status: 'unknown' }
  /** Only authoritative proof of no launch; unavailable/not-found-with-eventual-consistency is unknown. */
  | { status: 'not-launched' };
export interface NativeExecutor {
  dispatch(request: DispatchRequest): Promise<ExecutionResult>;
  reconcile(request: ReconcileRequest): Promise<ExecutionResult>;
}
export function dispatchRequest(state: VsmState, effectId: Id, now: number): DispatchRequest {
  const admission = dispatchAdmission(state, effectId, now);
  if (!admission.admitted) throw new Error(admission.code);
  const e = state.effects[effectId];
  return { effectId, unitId: e.unitId, procedureId: e.procedureId, executionRef: state.procedures[e.procedureId].executionRef,
    grant: { id: e.grantId!, version: e.grantVersion! },
    capabilities: { tools: [...state.grants[e.grantId!].tools], surfaces: [...state.grants[e.grantId!].surfaces] } };
}
export function reconcileRequest(state: VsmState, effectId: Id): ReconcileRequest {
  const e = state.effects[effectId];
  if (!e) throw new Error('EFFECT_UNKNOWN');
  return { effectId, nativeId: e.receipt?.nativeId ?? null };
}
/** Host must commit these in order, with source IDs stable across replay. */
export function executionEvents(effectId: Id, result: ExecutionResult, sourceId: Id): VsmEvent[] {
  if (result.status === 'unknown' || result.status === 'not-launched') return [{
    id: `${sourceId}/reconciled`, type: 'effect.reconciled', effectId,
    result: result.status === 'unknown' ? 'unknown' : 'not-launched',
  }];
  const sessionKey = 'sessionKey' in result ? result.sessionKey : undefined;
  const events: VsmEvent[] = [{ id: `${sourceId}/accepted`, type: 'effect.accepted', effectId, nativeId: result.nativeId,
    ...(sessionKey === undefined ? {} : { sessionKey }) }];
  if (result.status === 'completed') {
    events.push({ id: `${sourceId}/outcome`, type: 'effect.outcome', effectId, value: result.outcome.value, evidenceRef: result.outcome.evidenceRef, success: result.success });
    if (result.environmentEvidenceRef !== null) events.push({ id: `${sourceId}/environment`, type: 'environment.returned', effectId, evidenceRef: result.environmentEvidenceRef });
  }
  return events;
}

export interface FakeRun { request: DispatchRequest; nativeId: string; outcome: EffectOutcome | null; success: boolean; environmentEvidenceRef: Id | null }
export interface FakeExecutorState {
  runs: Record<Id, FakeRun>;
  launches: number;
  dispatchCalls: number;
  /** Simulates process-local delivery state; ledger survives fakeRestart. */
  epoch: number;
}
export function createFakeExecutor(): FakeExecutorState { return { runs: {}, launches: 0, dispatchCalls: 0, epoch: 0 }; }
const resultOf = (run: FakeRun): ExecutionResult => run.outcome === null
  ? { status: 'accepted', nativeId: run.nativeId }
  : { status: 'completed', nativeId: run.nativeId, outcome: structuredClone(run.outcome), success: run.success, environmentEvidenceRef: run.environmentEvidenceRef };
/** Pure fake adapter: a result plus new durable fake state, not an OpenClaw API call. */
export function fakeDispatch(state: FakeExecutorState, request: DispatchRequest, fault: 'none' | 'lose-reply' | 'crash-before-launch' = 'none'): { state: FakeExecutorState; result: ExecutionResult } {
  const next = structuredClone(state); next.dispatchCalls++;
  const old = next.runs[request.effectId];
  if (old) {
    if (old.request.procedureId !== request.procedureId || old.request.executionRef !== request.executionRef) throw new Error('IDEMPOTENCY_CONFLICT');
    return { state: next, result: fault === 'lose-reply' ? { status: 'unknown' } : resultOf(old) };
  }
  if (fault === 'crash-before-launch') return { state: next, result: { status: 'unknown' } };
  next.launches++;
  const run: FakeRun = { request: structuredClone(request), nativeId: `native:${request.effectId}`, outcome: null, success: true, environmentEvidenceRef: null };
  next.runs[request.effectId] = run;
  return { state: next, result: fault === 'lose-reply' ? { status: 'unknown' } : resultOf(run) };
}
export function fakeReconcile(state: FakeExecutorState, request: ReconcileRequest, unavailable = false): ExecutionResult {
  if (unavailable) return { status: 'unknown' };
  const run = state.runs[request.effectId];
  if (!run) return { status: 'not-launched' };
  if (request.nativeId !== null && request.nativeId !== run.nativeId) throw new Error('RECEIPT_CONFLICT');
  return resultOf(run);
}
export function fakeComplete(state: FakeExecutorState, effectId: Id, outcome: EffectOutcome, success = true, environmentEvidenceRef: Id | null = null): FakeExecutorState {
  const next = structuredClone(state); const run = next.runs[effectId];
  if (!run) throw new Error('FAKE_RUN_UNKNOWN');
  if (run.outcome && (run.outcome.value !== outcome.value || run.success !== success || run.outcome.evidenceRef !== outcome.evidenceRef || run.environmentEvidenceRef !== environmentEvidenceRef)) throw new Error('FAKE_COMPLETION_CONFLICT');
  if (!run.outcome) { run.outcome = structuredClone(outcome); run.success = success; run.environmentEvidenceRef = environmentEvidenceRef; }
  return next;
}
export function fakeRestart(state: FakeExecutorState): FakeExecutorState { return { ...structuredClone(state), epoch: state.epoch + 1 }; }
