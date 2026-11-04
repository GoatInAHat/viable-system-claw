import { createHash } from 'node:crypto';
import type { Activity } from '../model.js';

export interface Observation {
  sessionKey: string;
  agentId?: string;
  sessionId?: string;
  runId: string;
  toolCallId?: string;
  kind: 'run-start' | 'run-end' | 'tool-start' | 'tool-end' | 'message' | 'error';
  at: number;
  sequence?: number;
  failed?: boolean;
  toolName?: string;
  targetSessionKey?: string;
}
export interface NativeEvent {
  sessionKey?: string; agentId?: string; sessionId?: string;
  runId: string; seq: number; stream: string; ts: number; data: Record<string, unknown>;
}
export function metadataId(value: unknown): string | undefined {
  return typeof value === 'string' && /^[a-zA-Z0-9_.:/-]{1,128}$/.test(value) ? value : undefined;
}
/** Whitelist fields, never spread native data: metadata payloads may still contain text/error strings. */
export function fromNativeEvent(event: NativeEvent): Observation | undefined {
  const runId = metadataId(event.runId);
  if (!runId || !event.sessionKey || event.sessionKey.length > 512 || !Number.isSafeInteger(event.ts) || event.ts < 0) return;
  const phase = event.data.phase;
  const kind = event.stream === 'lifecycle'
    ? phase === 'start' ? 'run-start' : phase === 'end' || phase === 'error' ? 'run-end' : undefined
    : event.stream === 'tool'
      ? phase === 'start' ? 'tool-start' : phase === 'end' || phase === 'result' ? 'tool-end' : undefined
      : event.stream === 'error' ? 'error' : undefined;
  if (!kind) return;
  const toolCallId = metadataId(event.data.toolCallId ?? event.data.itemId);
  // Without a native tool identity we cannot safely correlate/dedupe hook and stream copies.
  if ((kind === 'tool-start' || kind === 'tool-end') && !toolCallId) return;
  if (kind === 'error' && (!Number.isSafeInteger(event.seq) || event.seq < 0)) return;
  return { sessionKey: event.sessionKey, agentId: event.agentId, sessionId: event.sessionId, runId, kind,
    at: event.ts, sequence: event.seq, toolCallId,
    toolName: metadataId(event.data.name ?? event.data.toolName),
    failed: phase === 'error' || event.stream === 'error' || event.data.isError === true || event.data.status === 'error',
  };
}
export function observationId(unitId: string, sessionId: string, event: Observation): string {
  return createHash('sha256').update(JSON.stringify([unitId, sessionId, event.runId, event.kind, event.toolCallId ?? null,
    event.kind === 'error' ? event.sequence : null])).digest('hex');
}
export function activity(id: string, unitId: string, event: Observation, targetUnitId?: string): Activity {
  return { id, unitId, ...(targetUnitId ? { targetUnitId } : {}), kind: event.kind, at: event.at, runId: event.runId,
    ...(event.toolCallId ? { toolCallId: event.toolCallId } : {}),
    label: event.kind === 'message' ? 'handoff accepted' : event.kind.startsWith('tool-') ? event.toolName ?? 'tool' : event.failed ? 'failed' : event.kind === 'run-start' ? 'started' : 'completed' };
}

/** Read only data properties; never parse a content/text block or inspect tool message arguments. */
function field(value: unknown, key: string): unknown {
  if (!value || typeof value !== 'object') return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor && 'value' in descriptor ? descriptor.value : undefined;
}
/** Native sessions_send jsonResult puts its typed receipt in result.details. */
export function fromSessionSend(event: { toolName: string; runId?: string; toolCallId?: string; error?: string; result?: unknown },
  context: { toolName: string; sessionKey?: string; agentId?: string; sessionId?: string; runId?: string; toolCallId?: string }, at: number): Observation | undefined {
  if (event.toolName !== 'sessions_send' || context.toolName !== 'sessions_send' || event.error) return;
  const runId = metadataId(event.runId ?? context.runId);
  const toolCallId = metadataId(event.toolCallId ?? context.toolCallId);
  if (!context.sessionKey || !runId || !toolCallId || field(event.result, 'isError') === true) return;
  const receipt = field(event.result, 'details');
  const status = field(receipt, 'status');
  // These native receipt statuses prove admission, not target execution or reply delivery.
  if (status !== 'accepted' && status !== 'queued' && status !== 'ok' && status !== 'no_reply') return;
  const target = field(receipt, 'sessionKey');
  if (typeof target !== 'string' || target.length > 512 || !/^agent:[^:]+:.+/.test(target)) return;
  return { sessionKey: context.sessionKey, agentId: context.agentId, sessionId: context.sessionId,
    runId, toolCallId, kind: 'message', at, targetSessionKey: target };
}
