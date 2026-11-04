import type { EffectOutcome, EffectReceipt } from './types.js';

/** Parent must persist launching atomically before entering native dispatch. */
export interface RecoveryRecord {
  effectId: string;
  launchState: 'unattempted' | 'launching' | 'ambiguous';
  receipt?: EffectReceipt;
  outcome?: EffectOutcome;
  replyState?: 'ambiguous' | 'lost';
}
export type RecoveryPlan = {
  effectId: string;
  action: 'dispatch-once';
  reason: 'never-attempted';
} | {
  effectId: string;
  action: 'reconcile';
  runId: string;
  requiresResultPolicy: boolean;
} | {
  effectId: string;
  action: 'settle';
  reason: 'terminal-outcome' | 'dispatch-rejected';
  requiresResultPolicy: boolean;
} | {
  effectId: string;
  action: 'require-policy';
  reason: 'launch-ambiguous' | 'admission-unknown' | 'reply-ambiguous' | 'orphan-outcome';
};

/** Pure restart decision. This never launches, observes, cancels, or retries work. */
export function planRecovery(record: RecoveryRecord): RecoveryPlan {
  const { effectId, receipt, outcome } = record;
  if (receipt && receipt.effectId !== effectId) throw new Error('Receipt identity mismatch');
  if (outcome && (outcome.effectId !== effectId || (receipt && outcome.runId !== receipt.runId))) {
    throw new Error('Outcome identity mismatch');
  }
  const requiresResultPolicy = record.replyState !== undefined;
  if (receipt?.status === 'rejected' && receipt.admission === 'unknown') {
    return { effectId, action: 'require-policy', reason: 'admission-unknown' };
  }
  if (outcome?.terminal && outcome.status !== 'unknown') {
    if (!receipt) return { effectId, action: 'require-policy', reason: 'orphan-outcome' };
    return { effectId, action: 'settle', reason: 'terminal-outcome', requiresResultPolicy };
  }
  if (receipt?.status === 'accepted') return { effectId, action: 'reconcile', runId: receipt.runId, requiresResultPolicy };
  if (receipt?.status === 'rejected') return { effectId, action: 'settle', reason: 'dispatch-rejected', requiresResultPolicy };
  if (outcome) return { effectId, action: 'require-policy', reason: 'orphan-outcome' };
  if (record.replyState) return { effectId, action: 'require-policy', reason: 'reply-ambiguous' };
  if (record.launchState !== 'unattempted') return { effectId, action: 'require-policy', reason: 'launch-ambiguous' };
  return { effectId, action: 'dispatch-once', reason: 'never-attempted' };
}
