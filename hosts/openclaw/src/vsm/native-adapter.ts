import type { EffectExecutor, EffectIntent, EffectOutcome, EffectReceipt } from '../execution/types.js';
import type { DispatchRequest, ExecutionResult, NativeExecutor, ReconcileRequest } from './executor.js';
import type { Id } from './types.js';

/**
 * Bridges the kernel's dispatch contract to the native subagent executor.
 * The host supplies private intent fields and receipt identity; this module never
 * invents an agent, message, purpose or authority reference.
 */
export interface NativeAdapterOptions {
  executor: EffectExecutor;
  /** Returns undefined only when no launch can be formed; nothing has been sent yet. */
  resolveIntent: (request: DispatchRequest) => Omit<EffectIntent, 'id' | 'unitId' | 'procedureId' | 'grantRef'> | undefined
    | Promise<Omit<EffectIntent, 'id' | 'unitId' | 'procedureId' | 'grantRef'> | undefined>;
  /** Reconstructs persisted receipt identity after restart; undefined means unknown. */
  resolveReceipt?: (request: ReconcileRequest) => EffectReceipt | undefined;
  /** Optional environment evidence for a terminal outcome; null keeps the brake closed. */
  environmentRef?: (outcome: EffectOutcome) => Id | null;
  now?: () => number;
}

export function createNativeExecutor(options: NativeAdapterOptions): NativeExecutor {
  const now = options.now ?? Date.now;
  return {
    async dispatch(request: DispatchRequest): Promise<ExecutionResult> {
      const resolved = await options.resolveIntent(request);
      if (!resolved) return { status: 'not-launched' };
      const intent: EffectIntent = {
        id: request.effectId,
        unitId: request.unitId,
        procedureId: request.procedureId,
        grantRef: `${request.grant.id}@${request.grant.version}`,
        ...resolved,
      };
      let receipt: EffectReceipt;
      try {
        receipt = await options.executor.dispatch(intent);
      } catch {
        // No receipt identity is available; admission is unknown and retry is unsafe.
        return { status: 'unknown' };
      }
      if (receipt.status === 'rejected') {
        return receipt.admission === 'not-accepted' ? { status: 'not-launched' } : { status: 'unknown' };
      }
      return { status: 'accepted', nativeId: receipt.runId };

    },
    async reconcile(request: ReconcileRequest): Promise<ExecutionResult> {
      const receipt = options.resolveReceipt?.(request);
      if (!receipt || receipt.status !== 'accepted' || !request.nativeId) return { status: 'unknown' };
      let outcome: EffectOutcome;
      try {
        outcome = await options.executor.reconcile(receipt);
      } catch {
        return { status: 'unknown' };
      }
      if (!outcome.terminal) return { status: 'unknown' };
      const success = outcome.status === 'ok';
      const value = success ? 1 : 0;
      const evidenceRef = outcome.resultRef?.runId
        ? `run:${outcome.resultRef.runId}`
        : `run:${receipt.runId}`;
      return {
        status: 'completed',
        nativeId: receipt.runId,
        outcome: { value, evidenceRef, at: outcome.endedAt ?? now() },
        success,
        environmentEvidenceRef: options.environmentRef?.(outcome) ?? null,
      };
    },
  };
}

