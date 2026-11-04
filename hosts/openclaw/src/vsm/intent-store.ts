import { EXECUTION_LIMITS, type EffectIntent } from '../execution/types.js';
import type { DocumentStore } from './state.js';

/** Private retained namespace for launch intents; never projected into the public graph. */
export const INTENT_NAMESPACE = 'vsm-private';
export const intentKey = (effectId: string): string => `intent/${effectId}`;

const AGENT_ID = /^[a-z0-9][a-z0-9_-]*$/;
const REFERENCE = /^[A-Za-z0-9][A-Za-z0-9:._/@-]*$/;

function valid(value: unknown, limit: number, pattern: RegExp = REFERENCE): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= limit && pattern.test(value);
}

/** Rejects records that cannot be safely persisted or replayed. */
export function assertIntent(intent: EffectIntent): void {
  if (!valid(intent.id, EXECUTION_LIMITS.id) || !valid(intent.unitId, EXECUTION_LIMITS.id)
    || !valid(intent.procedureId, EXECUTION_LIMITS.id) || !valid(intent.grantRef, EXECUTION_LIMITS.id)) {
    throw new Error('VSC_INTENT_IDENTITY');
  }
  if (!valid(intent.agentId, EXECUTION_LIMITS.agentId, AGENT_ID)) throw new Error('VSC_INTENT_AGENT');
  if (typeof intent.purpose !== 'string' || !intent.purpose.trim() || intent.purpose.length > EXECUTION_LIMITS.purpose) {
    throw new Error('VSC_INTENT_PURPOSE');
  }
  if (typeof intent.message !== 'string' || !intent.message.trim() || intent.message.includes('\0')
    || intent.message.length > EXECUTION_LIMITS.message) {
    throw new Error('VSC_INTENT_MESSAGE');
  }
  if (!Number.isSafeInteger(intent.createdAt) || intent.createdAt < 0) throw new Error('VSC_INTENT_TIME');
  if (intent.deadline !== undefined && (!Number.isSafeInteger(intent.deadline) || intent.deadline < intent.createdAt)) {
    throw new Error('VSC_INTENT_DEADLINE');
  }
}

function sameIntent(left: EffectIntent, right: EffectIntent): boolean {
  return left.id === right.id && left.unitId === right.unitId && left.procedureId === right.procedureId
    && left.agentId === right.agentId && left.message === right.message && left.purpose === right.purpose
    && left.grantRef === right.grantRef && left.createdAt === right.createdAt && left.deadline === right.deadline;
}

function readIntentValue(value: unknown): EffectIntent | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'object') throw new Error('VSC_INTENT_INVALID');
  const intent = value as EffectIntent;
  assertIntent(intent);
  return intent;
}

/**
 * Write-once launch marker. It is committed before the native executor is called, so a
 * crash between admission and dispatch leaves recoverable intent rather than a guess.
 */
export async function writeIntent(store: DocumentStore, intent: EffectIntent): Promise<void> {
  assertIntent(intent);
  const key = intentKey(intent.id);
  const observed = await store.observe(key);
  const existing = readIntentValue(observed.value);
  if (existing) {
    if (sameIntent(existing, intent)) return;
    throw new Error('VSC_INTENT_CONFLICT');
  }
  const result = await store.compareAndApply(key, observed.comparison,
    { operation: 'update', action: 'set', value: intent });
  if (result.status !== 'applied') throw new Error('VSC_INTENT_CONFLICT');
}

export async function readIntent(store: DocumentStore, effectId: string): Promise<EffectIntent | undefined> {
  const observed = await store.observe(intentKey(effectId));
  return readIntentValue(observed.value);
}
