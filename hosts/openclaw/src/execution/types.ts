import type { PluginRuntime } from 'openclaw/plugin-sdk/core';

/** Limits are per record/observation, not workload or context limits on the host. */
export const EXECUTION_LIMITS = {
  id: 128, agentId: 64, message: 32_768, purpose: 512, tool: 128,
  nativeId: 256, sessionKey: 512, messageCount: 10,
  privateMessagesBytes: 65_536, privateReplyCharacters: 16_384,
  waitMs: 30_000,
} as const;

/** Private retained intent. Never publish this record: message/purpose may be private. */
export interface EffectIntent {
  id: string;
  unitId: string;
  procedureId: string;
  agentId: string;
  message: string;
  purpose: string;
  /** Opaque authority reference, never a credential or authorization by itself. */
  grantRef: string;
  /** Grant capability claim. The actuator mediates it or refuses the launch. */
  capabilities: { tools: string[]; surfaces: string[] };
  createdAt: number;
  deadline?: number;
}

/** Mutable holder so the runtime can bind the fence after constructing the executor. */
export interface AuthorityFence { check?: (intent: Readonly<EffectIntent>) => void }

export type RejectionReason = 'invalid-intent' | 'invalid-agent' | 'missing-agent'
  | 'invalid-message' | 'message-too-long' | 'deadline-expired'
  | 'authority-rejected' | 'validation-unavailable' | 'admission-unknown' | 'invalid-admission'
  /** The grant claims tools or surfaces this actuator cannot enforce exactly. */
  | 'capability-unsupported';
export type EffectReceipt = {
  effectId: string;
  status: 'accepted';
  runId: string;
  sessionKey: string;
  at: number;
  reason?: never;
} | {
  effectId: string;
  status: 'rejected';
  runId: null;
  sessionKey: string | null;
  at: number;
  reason: RejectionReason;
  /** Unknown means the call may have launched; it is NEVER safe to retry. */
  admission: 'not-accepted' | 'unknown';
};

export type OutcomeStatus = 'ok' | 'error' | 'timeout' | 'killed' | 'unknown';
export type NativeStatus = 'ok' | 'error' | 'timeout' | 'pending';
export interface ReplyMetadata {
  disposition: 'visible' | 'silent' | 'empty';
  textCharacters?: number;
  code?: 'message-tool-not-called';
}
export interface ResultReference {
  kind: 'native-session';
  runId: string;
  sessionKey: string;
  messagesObserved: number;
  history: 'available' | 'unavailable';
  /** A full page may omit older messages; the SDK supplies no completeness marker. */
  historyMayBeTruncated: boolean;
  privateResult: 'not-requested' | 'stored' | 'unavailable';
  privateRef?: string;
  privatePayloadTruncated?: boolean;
}
export interface EffectOutcome {
  effectId: string;
  runId: string | null;
  status: OutcomeStatus;
  terminal: boolean;
  /** Host end time only; never substitute the observation time. */
  endedAt: number | null;
  /** Known host tokens only; free-form strings are projected as 'other'. */
  stopReason: string | null;
  livenessState: string | null;
  nativeStatus?: NativeStatus;
  reason?: 'dispatch-rejected' | 'admission-unknown' | 'wait-unavailable'
    | 'wait-pending' | 'observation-timeout' | 'incomplete-terminal';
  terminalReply?: ReplyMetadata;
  resultRef?: ResultReference;
}

export type NativeSubagentRuntime = Pick<PluginRuntime['subagent'], 'run' | 'waitForRun' | 'getSessionMessages'>;
export type NativeWaitResult = Awaited<ReturnType<NativeSubagentRuntime['waitForRun']>>;
export type NativeReply = NonNullable<NativeWaitResult['terminalReply']>;
export type Json = null | string | number | boolean | Json[] | { [key: string]: Json };
/** Explicitly private, idempotent sink. No delivery or public projections here. */
export interface PrivateResultSink {
  write(result: {
    ref: string;
    effectId: string;
    runId: string;
    sessionKey: string;
    messages: Json[];
    terminalReply?: NativeReply;
    truncated: boolean;
  }): Promise<void>;
}
export interface ReconcileOptions {
  timeoutMs?: number;
  privateResultSink?: PrivateResultSink;
}
export interface EffectExecutor {
  /** Caller must persist a launching marker BEFORE this call. */
  dispatch(intent: EffectIntent, previous?: EffectReceipt): Promise<EffectReceipt>;
  /** Supply persisted terminal outcome after restart; never re-dispatch accepted work. */
  reconcile(receipt: EffectReceipt, previous?: EffectOutcome): Promise<EffectOutcome>;
}

/** Intentionally excludes message, purpose and grantRef; publish only validated intent identities. */
export function projectEffectIntent(intent: EffectIntent): Pick<EffectIntent,
  'id' | 'unitId' | 'procedureId' | 'agentId' | 'createdAt' | 'deadline'> {
  const references = [intent.id, intent.unitId, intent.procedureId];
  if (references.some(value => typeof value !== 'string' || value.length < 1 || value.length > EXECUTION_LIMITS.id
    || !/^[A-Za-z0-9][A-Za-z0-9:._/-]*$/.test(value))
    || typeof intent.agentId !== 'string' || intent.agentId.length > EXECUTION_LIMITS.agentId || !/^[a-z0-9][a-z0-9_-]*$/.test(intent.agentId)
    || !Number.isSafeInteger(intent.createdAt) || intent.createdAt < 0
    || (intent.deadline !== undefined && (!Number.isSafeInteger(intent.deadline) || intent.deadline < intent.createdAt))) {
    throw new Error('Invalid effect projection');
  }
  return { id: intent.id, unitId: intent.unitId, procedureId: intent.procedureId,
    agentId: intent.agentId, createdAt: intent.createdAt,
    ...(intent.deadline === undefined ? {} : { deadline: intent.deadline }) };
}
