import { createHash } from 'node:crypto';
import { EffectReconciler } from './reconcile.js';
import { EXECUTION_LIMITS, type EffectExecutor, type EffectIntent, type EffectOutcome,
  type EffectReceipt, type NativeSubagentRuntime, type ReconcileOptions, type RejectionReason } from './types.js';

const AGENT_ID = /^[a-z0-9][a-z0-9_-]*$/;
export function validReference(value: unknown, limit: number = EXECUTION_LIMITS.id): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= limit
    && /^[A-Za-z0-9][A-Za-z0-9:._/-]*$/.test(value);
}
export function effectSessionKey(effectId: string, agentId: string): string {
  if (!validReference(effectId) || !validReference(agentId, EXECUTION_LIMITS.agentId) || !AGENT_ID.test(agentId)) {
    throw new Error('Invalid execution identity');
  }
  const digest = createHash('sha256').update(effectId).digest('hex');
  return `agent:${agentId}:subagent:viable-system-claw-effect-${digest}`;
}
export interface NativeExecutorOptions extends ReconcileOptions {
  /** Current configured-agent existence check; not an authorization grant. */
  agentExists(agentId: string): boolean;
  now?: () => number;
  /** Optional live authority assertion, also forwarded to host admission. */
  assertCurrent?: (intent: Readonly<EffectIntent>) => void;
}

/** In-process deduplication only. The parent owns the durable launch journal. */
export class NativeEffectExecutor implements EffectExecutor {
  private readonly dispatches = new Map<string, Promise<EffectReceipt>>();
  private readonly reconciler: EffectReconciler;
  constructor(
    private readonly api: { runtime: { subagent: NativeSubagentRuntime } },
    private readonly options: NativeExecutorOptions,
  ) {
    this.reconciler = new EffectReconciler(api.runtime.subagent, options);
  }

  dispatch(intent: EffectIntent, previous?: EffectReceipt): Promise<EffectReceipt> {
    if (previous) {
      if (previous.effectId !== intent.id) return Promise.reject(new Error('Receipt identity mismatch'));
      if (!this.dispatches.has(intent.id)) this.dispatches.set(intent.id, Promise.resolve(Object.freeze({ ...previous })));
    }
    const existing = this.dispatches.get(intent.id);
    if (existing) return existing;
    // Copy before any await so the caller cannot retarget the launch or admission assertion.
    const snapshot = Object.freeze({ ...intent });
    const pending = this.launch(snapshot).then(receipt => Object.freeze(receipt));
    this.dispatches.set(intent.id, pending);
    return pending;
  }

  reconcile(receipt: EffectReceipt, previous?: EffectOutcome): Promise<EffectOutcome> {
    // Even a reconstructed executor remembers receipts passed through reconciliation.
    if (!this.dispatches.has(receipt.effectId)) this.dispatches.set(receipt.effectId, Promise.resolve(Object.freeze({ ...receipt })));
    return this.reconciler.reconcile(receipt, previous);
  }

  private async launch(intent: Readonly<EffectIntent>): Promise<EffectReceipt> {
    const at = (this.options.now ?? Date.now)();
    // Invalid ids are programmer errors: do not echo an unbounded/private value into a record.
    if (!validReference(intent.id)) throw new Error('Invalid effect identity');
    let sessionKey: string | null = null;
    const reject = (reason: RejectionReason, admission: 'not-accepted' | 'unknown' = 'not-accepted'): EffectReceipt =>
      ({ effectId: intent.id, status: 'rejected', runId: null, sessionKey, at, reason, admission });
    if (!validReference(intent.agentId, EXECUTION_LIMITS.agentId) || !AGENT_ID.test(intent.agentId)) return reject('invalid-agent');
    sessionKey = effectSessionKey(intent.id, intent.agentId);
    if (![intent.unitId, intent.procedureId, intent.grantRef].every(value => validReference(value))
      || typeof intent.purpose !== 'string' || !intent.purpose.trim() || intent.purpose.length > EXECUTION_LIMITS.purpose
      || !Number.isSafeInteger(intent.createdAt) || intent.createdAt < 0
      || (intent.deadline !== undefined && (!Number.isSafeInteger(intent.deadline) || intent.deadline < intent.createdAt))) {
      return reject('invalid-intent');
    }
    if (typeof intent.message !== 'string' || !intent.message.trim() || intent.message.includes('\0')) return reject('invalid-message');
    if (intent.message.length > EXECUTION_LIMITS.message) return reject('message-too-long');
    if (intent.deadline !== undefined && intent.deadline <= at) return reject('deadline-expired');
    try { if (!this.options.agentExists(intent.agentId)) return reject('missing-agent'); }
    catch { return reject('validation-unavailable'); }
    try { this.options.assertCurrent?.(intent); }
    catch { return reject('authority-rejected'); }
    try {
      const result = await this.api.runtime.subagent.run({
        sessionKey, message: intent.message, deliver: false, promptMode: 'minimal',
        ...(this.options.assertCurrent ? { assertCurrent: () => this.options.assertCurrent!(intent) } : {}),
      });
      if (!validReference(result.runId, EXECUTION_LIMITS.nativeId)
        || (result.sessionKey !== undefined && !validReference(result.sessionKey, EXECUTION_LIMITS.sessionKey))) {
        return reject('invalid-admission', 'unknown');
      }
      // Retain the host's canonical accepted key; explicit custom runtimes may omit it.
      return { effectId: intent.id, status: 'accepted', runId: result.runId,
        sessionKey: result.sessionKey ?? sessionKey, at: (this.options.now ?? Date.now)() };
    } catch {
      // Public run() has no typed rejection/transport distinction. No retry is safe here.
      return reject('admission-unknown', 'unknown');
    }
  }
}
