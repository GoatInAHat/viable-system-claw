import { resultPayloadRef } from '../retention.js';
import { EXECUTION_LIMITS, type EffectOutcome, type EffectReceipt, type Json,
  type NativeReply, type NativeSubagentRuntime, type NativeWaitResult, type ReconcileOptions,
  type ReplyMetadata, type ResultReference } from './types.js';

const STOP_REASONS = new Set(['completed', 'stop', 'end_turn', 'tool_use', 'error', 'failed',
  'hard_timeout', 'timed_out', 'timeout', 'aborted', 'cancelled', 'killed', 'restart',
  'superseded', 'blocked', 'abandoned', 'max_tokens', 'length']);
const LIVENESS_STATES = new Set(['unknown', 'queued', 'pending', 'running', 'active', 'idle',
  'stalled', 'completed', 'failed', 'error', 'timeout', 'timed_out', 'aborted', 'cancelled',
  'killed', 'stopped', 'ended', 'terminal', 'finishing']);
const KILLED_REASONS = new Set(['aborted', 'cancelled', 'killed', 'restart', 'superseded']);
function token(value: string | undefined, allowed: ReadonlySet<string>): string | null {
  return value === undefined ? null : allowed.has(value) ? value : 'other';
}
function replyMetadata(reply: NativeReply | undefined): ReplyMetadata | undefined {
  if (!reply) return undefined;
  if (reply.disposition === 'visible') return { disposition: 'visible', textCharacters: reply.text.length,
    textNonWhitespace: reply.text.replace(/\s/g, '').length };
  if (reply.disposition === 'empty') return { disposition: 'empty',
    ...(reply.code === 'message-tool-not-called' ? { code: reply.code } : {}) };
  return { disposition: 'silent' };
}
/** Host wait observations are not a cancellation mechanism. No time is invented. */
export function classifyWait(receipt: Extract<EffectReceipt, { status: 'accepted' }>, result: NativeWaitResult): EffectOutcome {
  const endedAt = Number.isSafeInteger(result.endedAt) && result.endedAt! >= 0 ? result.endedAt! : null;
  const outcome: EffectOutcome = {
    effectId: receipt.effectId, runId: receipt.runId, status: 'unknown', terminal: false, endedAt,
    stopReason: token(result.stopReason, STOP_REASONS),
    livenessState: token(result.livenessState, LIVENESS_STATES), nativeStatus: result.status,
  };
  if (result.retryableTransportError) return { ...outcome, reason: 'wait-unavailable' };
  if (result.yielded || result.pendingError) return { ...outcome, reason: 'incomplete-terminal' };
  if (result.status === 'pending') return { ...outcome, reason: 'wait-pending' };
  if (result.status === 'timeout' && endedAt === null
    && result.stopReason !== 'hard_timeout' && result.stopReason !== 'timed_out') {
    return { ...outcome, reason: 'observation-timeout' };
  }
  const killSignal = KILLED_REASONS.has(result.stopReason ?? '') || result.livenessState === 'killed';
  const killed = result.status === 'error' && killSignal;
  // Preserve native execution timeout even if its cleanup aborted the provider.
  // Bare abort observations may still be under native wait-layer recovery.
  if ((killed && endedAt === null) || (killSignal && result.status === 'ok')) {
    return { ...outcome, reason: 'incomplete-terminal' };
  }
  const terminalReply = replyMetadata(result.terminalReply);
  return { ...outcome, status: killed ? 'killed' : result.status, terminal: true,
    ...(terminalReply ? { terminalReply } : {}) };
}

function freezeOutcome(outcome: EffectOutcome): EffectOutcome {
  if (outcome.terminalReply) Object.freeze(outcome.terminalReply);
  if (outcome.resultRef) Object.freeze(outcome.resultRef);
  return Object.freeze(outcome);
}
function privatePayload(messages: unknown[], reply: NativeReply | undefined): {
  messages: Json[]; terminalReply?: NativeReply; truncated: boolean;
} {
  const bounded: Json[] = [];
  let bytes = 2;
  let truncated = messages.length >= EXECUTION_LIMITS.messageCount;
  for (const message of messages.slice(0, EXECUTION_LIMITS.messageCount)) {
    try {
      const serialized = JSON.stringify(message);
      if (serialized === undefined) { truncated = true; continue; }
      const size = Buffer.byteLength(serialized, 'utf8');
      if (size + bytes + (bounded.length ? 1 : 0) > EXECUTION_LIMITS.privateMessagesBytes) { truncated = true; continue; }
      bounded.push(JSON.parse(serialized) as Json);
      bytes += size + (bounded.length > 1 ? 1 : 0);
    } catch { truncated = true; }
  }
  let terminalReply: NativeReply | undefined;
  if (reply?.disposition === 'visible') {
    terminalReply = { disposition: 'visible', text: reply.text.slice(0, EXECUTION_LIMITS.privateReplyCharacters) };
    truncated ||= reply.text.length > EXECUTION_LIMITS.privateReplyCharacters;
  } else if (reply) {
    terminalReply = reply.disposition === 'silent' ? { disposition: 'silent' }
      : { disposition: 'empty', ...(reply.code === 'message-tool-not-called' ? { code: reply.code } : {}) };
  }
  return { messages: bounded, ...(terminalReply ? { terminalReply } : {}), truncated };
}

/** One instance per retained executor; terminals are immutable and coalesced in-process. */
export class EffectReconciler {
  private readonly terminals = new Map<string, EffectOutcome>();
  private readonly observing = new Map<string, Promise<EffectOutcome>>();
  private readonly timeoutMs: number;
  constructor(private readonly runtime: NativeSubagentRuntime, private readonly options: ReconcileOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? EXECUTION_LIMITS.waitMs;
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 1 || this.timeoutMs > EXECUTION_LIMITS.waitMs) {
      throw new Error('Observation timeout must be between 1 and 30000 ms');
    }
  }
  async reconcile(receipt: EffectReceipt, previous?: EffectOutcome): Promise<EffectOutcome> {
    if (previous && (previous.effectId !== receipt.effectId || previous.runId !== receipt.runId)) {
      throw new Error('Outcome identity mismatch');
    }
    if (previous?.terminal && receipt.status === 'rejected' && receipt.admission === 'unknown') {
      throw new Error('Ambiguous admission cannot have a terminal outcome');
    }
    const key = `${receipt.effectId}\0${receipt.runId ?? ''}`;
    const terminal = this.terminals.get(key);
    if (terminal) return terminal;
    if (previous?.terminal && previous.status !== 'unknown') {
      // Strip extra properties from reconstructed JSON; do not retain a caller-owned mutable object.
      const restored: EffectOutcome = { effectId: previous.effectId, runId: previous.runId,
        status: previous.status, terminal: true, endedAt: previous.endedAt,
        stopReason: previous.stopReason, livenessState: previous.livenessState,
        ...(previous.nativeStatus ? { nativeStatus: previous.nativeStatus } : {}),
        ...(previous.reason ? { reason: previous.reason } : {}),
        ...(previous.terminalReply ? { terminalReply: { disposition: previous.terminalReply.disposition,
          ...(previous.terminalReply.textCharacters === undefined ? {} : { textCharacters: previous.terminalReply.textCharacters }),
          ...(previous.terminalReply.textNonWhitespace === undefined ? {} : { textNonWhitespace: previous.terminalReply.textNonWhitespace }),
          ...(previous.terminalReply.code === undefined ? {} : { code: previous.terminalReply.code }) } } : {}),
        ...(previous.resultRef ? { resultRef: { kind: 'native-session', runId: previous.resultRef.runId,
          sessionKey: previous.resultRef.sessionKey, messagesObserved: previous.resultRef.messagesObserved,
          history: previous.resultRef.history, historyMayBeTruncated: previous.resultRef.historyMayBeTruncated,
          privateResult: previous.resultRef.privateResult,
          ...(previous.resultRef.privateRef === undefined ? {} : { privateRef: previous.resultRef.privateRef }),
          ...(previous.resultRef.privatePayloadTruncated === undefined ? {} : { privatePayloadTruncated: previous.resultRef.privatePayloadTruncated }) } } : {}) };
      const frozen = freezeOutcome(restored);
      this.terminals.set(key, frozen);
      return frozen;
    }
    const existing = this.observing.get(key);
    if (existing) return existing;
    const pending = this.observe(receipt, key).then(outcome => {
      const alreadyTerminal = this.terminals.get(key);
      if (alreadyTerminal) return alreadyTerminal;
      const frozen = freezeOutcome(outcome);
      if (frozen.terminal) this.terminals.set(key, frozen);
      return frozen;
    });
    this.observing.set(key, pending);
    try { return await pending; }
    finally { if (this.observing.get(key) === pending) this.observing.delete(key); }
  }

  private async observe(receipt: EffectReceipt, key: string): Promise<EffectOutcome> {
    const empty: EffectOutcome = { effectId: receipt.effectId, runId: receipt.runId,
      status: 'unknown', terminal: false, endedAt: null, stopReason: null, livenessState: null };
    if (receipt.status === 'rejected') {
      return receipt.admission === 'unknown' ? { ...empty, reason: 'admission-unknown' }
        : { ...empty, status: 'error', terminal: true, reason: 'dispatch-rejected' };
    }
    let wait: NativeWaitResult;
    try { wait = await this.runtime.waitForRun({ runId: receipt.runId, timeoutMs: this.timeoutMs }); }
    catch { return { ...empty, reason: 'wait-unavailable' }; }
    const restoredWhileWaiting = this.terminals.get(key);
    if (restoredWhileWaiting) return restoredWhileWaiting;
    const outcome = classifyWait(receipt, wait);
    if (!outcome.terminal) return outcome;
    const resultRef: ResultReference = { kind: 'native-session', runId: receipt.runId, sessionKey: receipt.sessionKey,
      messagesObserved: 0, history: 'unavailable', historyMayBeTruncated: true, privateResult: 'not-requested' };
    let messages: unknown[] = [];
    let oversizedPage = false;
    try {
      const history = await this.runtime.getSessionMessages({ sessionKey: receipt.sessionKey, limit: EXECUTION_LIMITS.messageCount });
      if (Array.isArray(history.messages)) {
        oversizedPage = history.messages.length > EXECUTION_LIMITS.messageCount;
        messages = history.messages.slice(0, EXECUTION_LIMITS.messageCount);
        resultRef.messagesObserved = messages.length;
        resultRef.history = 'available';
        resultRef.historyMayBeTruncated = history.messages.length >= EXECUTION_LIMITS.messageCount;
      }
    } catch { /* Execution terminality survives lost history. Result retrieval is a separate state. */ }
    const restoredWhileReading = this.terminals.get(key);
    if (restoredWhileReading) return restoredWhileReading;
    if (this.options.privateResultSink) {
      const ref = resultPayloadRef(receipt.effectId, receipt.runId);
      const payload = privatePayload(messages, wait.terminalReply);
      payload.truncated ||= oversizedPage;
      // Do not claim to have stored a result when neither history nor a terminal reply was available.
      if (resultRef.history === 'unavailable' && !wait.terminalReply) resultRef.privateResult = 'unavailable';
      else try {
        await this.options.privateResultSink.write({ ref, effectId: receipt.effectId, runId: receipt.runId,
          sessionKey: receipt.sessionKey, ...payload });
        resultRef.privateResult = 'stored';
        resultRef.privateRef = ref;
        resultRef.privatePayloadTruncated = payload.truncated;
      } catch { resultRef.privateResult = 'unavailable'; }
    }
    return { ...outcome, resultRef };
  }
}
