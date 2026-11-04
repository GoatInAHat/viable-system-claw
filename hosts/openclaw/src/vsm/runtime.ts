import { assertJson, canGrant, canValue, grantAdmits, isPrincipal, validateState } from './kernel.js';

/**
 * Bounded replay window. Authoritative effects, alarms, grants and audit findings are
 * never dropped; only diagnostic decisions, dedupe IDs and evidence references age out.
 */
export const HISTORY_LIMITS = { decisions: 512, seenEvents: 1024, channelEvidence: 1024 } as const;
const bounded = <T,>(values: T[], max: number): T[] => values.length <= max ? values : values.slice(-max);

import type { Actor, AuditFinding, Channel, Decision, DispatchAction, Effect, Grant, Id, StepResult, ValidationError, VsmAction, VsmEvent, VsmState } from './types.js';

class Rejection extends Error { constructor(readonly code: string, message: string) { super(message); } }
function need(condition: unknown, code: string, message: string): asserts condition { if (!condition) throw new Rejection(code, message); }
const positive = (n: number): boolean => Number.isFinite(n) && n > 0;
const unique = (ids: Id[]): Id[] => [...new Set(ids)];
const currentGrant = (s: VsmState, c: Channel, now: number, exclude?: Id): Grant | undefined =>
  Object.values(s.grants).sort((a, b) => a.id.localeCompare(b.id)).find(g => c.procedureId !== null && grantAdmits(s, g, c.unitId, c.procedureId, c.cost, now, exclude));
export function effectiveThreshold(state: VsmState, channel: Channel): number {
  return Math.max(0, channel.threshold - state.ambient.gain + state.ambient.price * channel.cost);
}
function environmentReady(s: VsmState, c: Channel): boolean {
  if (c.pending.lastEffectId === null) return true;
  const e = s.effects[c.pending.lastEffectId];
  // A definitively absent launch never touched the world, so it re-opens the round trip.
  return !!e && (e.status === 'cancelled' || e.status === 'lost' || !!e.environmentReturn && !!e.outcome);
}
function parentAuditActor(s: VsmState, actor: Actor, unitId: Id): boolean {
  return isPrincipal(s, actor) || actor.kind === 'organ' && actor.role === 'S3*' &&
    actor.unitId === (s.units[unitId]?.parentId ?? s.rootId);
}
/** Recheck immediately before launch after persistence, including revocation/expiry/version. */
export function dispatchAdmission(state: VsmState, effectId: Id, now: number): { admitted: boolean; code: string } {
  if (!Number.isFinite(now) || now < state.updatedAt) return { admitted: false, code: 'CLOCK_REGRESSION' };
  const e = state.effects[effectId];
  if (!e || e.status !== 'reserved') return { admitted: false, code: 'EFFECT_NOT_RESERVED' };
  const g = e.grantId === null ? undefined : state.grants[e.grantId];
  if (!g || g.version !== e.grantVersion || !grantAdmits(state, g, e.unitId, e.procedureId, e.cost, now, e.id)) return { admitted: false, code: 'GRANT_CLOSED' };
  return { admitted: true, code: 'ADMITTED' };
}

/** One host transaction: validate, dedupe, reduce, validate; never performs external work. */
export function step(state: VsmState, event: VsmEvent, now: number): StepResult {
  const before = validateState(state);
  const reject = (errors: ValidationError[]): StepResult => ({ state, actions: [], decisions: [], errors });
  if (before.length) return reject(before);
  try { assertJson(event); } catch (e) { return reject([{ code: 'EVENT_NOT_JSON', path: 'event', message: String(e) }]); }
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/@*-]{0,199}$/.test(event.id) || ['constructor', 'prototype', '__proto__'].includes(event.id)) return reject([{ code: 'EVENT_ID', path: 'id', message: 'Safe stable event ID required' }]);
  if (Object.hasOwn(state.seenEvents, event.id)) return { state, actions: [], decisions: [], errors: [] };
  if (!Number.isFinite(now) || now < state.updatedAt) return reject([{ code: 'CLOCK_REGRESSION', path: 'now', message: 'Monotonic finite processing time required' }]);
  const s = structuredClone(state);
  const actions: VsmAction[] = [];
  const decisions: Decision[] = [];
  const record = (kind: Decision['kind'], channel: Channel | null, detail: string, brakes = { evidence: false, environment: false, grant: false }, wakeClass = channel?.wakeClass ?? 'fast-code'): void => {
    const decision: Decision = { eventId: event.id, at: now, channelId: channel?.id ?? null, kind, wakeClass, detail, ...brakes };
    decisions.push(decision); s.decisions.push(decision);
    if (s.decisions.length > HISTORY_LIMITS.decisions) s.decisions.splice(0, s.decisions.length - HISTORY_LIMITS.decisions);
  };
  const channel = (id: Id): Channel => { need(Object.hasOwn(s.channels, id), 'CHANNEL_UNKNOWN', id); return s.channels[id]; };
  const effect = (id: Id): Effect => { need(Object.hasOwn(s.effects, id), 'EFFECT_UNKNOWN', id); return s.effects[id]; };
  const audit = (e: Effect, kind: AuditFinding['kind'], residual: number, refs: Id[]): void => {
    const id = `${e.id}/audit/${kind}`;
    if (s.auditFindings[id]) return;
    const finding: AuditFinding = {
      id, unitId: e.unitId, effectId: e.id, kind, residual, evidenceRefs: unique([...e.evidenceRefs, ...refs]), at: now,
      attribution: [{ componentId: e.procedureId, credit: residual === 0 ? 1 : 0, blame: residual }],
    };
    s.auditFindings[id] = finding;
    const auditor = s.units[e.unitId].parentId ?? s.rootId;
    actions.push({ type: 'audit', findingId: id, organId: s.units[auditor].organs['S3*'].id, wakeClass: 'slow-deliberative' });
  };
  const reserve = (c: Channel, e: Effect, g: Grant): void => {
    e.status = 'reserved'; e.reservedAt = now; e.grantId = g.id; e.grantVersion = g.version;
    e.returnDueAt = now + s.procedures[e.procedureId].returnTimeoutMs;
    e.dispatchAttempts++;
    e.reservations.push({ attempt: e.dispatchAttempts, at: now, grantId: g.id, grantVersion: g.version, cost: e.cost });
    c.pending.phase = 'reserved'; c.pending.lastEffectId = e.id;
    const action: DispatchAction = { type: 'dispatch', effectId: e.id, procedureId: e.procedureId, grantId: g.id, grantVersion: g.version, wakeClass: c.wakeClass };
    actions.push(action);
    record('wake', c, `Reserved ${e.id}; persist before native dispatch`, { evidence: true, environment: true, grant: true });
  };
  const attemptWake = (c: Channel): boolean => {
    c.accumulator.value = Math.max(0, c.accumulator.value - c.decayPerMs * (now - c.accumulator.updatedAt));
    c.accumulator.updatedAt = now;
    const threshold = effectiveThreshold(s, c);
    const evidence = c.accumulator.observations > 0 && c.accumulator.value >= threshold;
    const environment = environmentReady(s, c);
    const g = currentGrant(s, c, now);
    record('brakes', c, `E=${c.accumulator.value}; threshold=${threshold}; g=${s.ambient.gain}; price=${s.ambient.price}`, { evidence, environment, grant: !!g });
    if (!evidence || !environment || !g || c.procedureId === null || c.kind === 'algedonic') {
      c.pending.phase = !environment ? 'waiting-environment' : !evidence ? (c.accumulator.observations > 0 ? 'evidence' : 'parked') : 'waiting-grant';
      return false;
    }
    const sequence = c.pending.sequence + 1;
    const id = `${c.id}/effect/${sequence}`;
    need(!s.effects[id], 'EFFECT_COLLISION', id);
    const procedure = s.procedures[c.procedureId];
    const e: Effect = {
      id, channelId: c.id, unitId: c.unitId, procedureId: procedure.id, sequence, status: 'intent', intentAt: now,
      reservedAt: null, grantId: null, grantVersion: null, cost: c.cost, expectedOutcome: procedure.expectedOutcome,
      returnDueAt: now + procedure.returnTimeoutMs, receipt: null, outcome: null, environmentReturn: null,
      evidenceRefs: [...c.accumulator.evidenceRefs], dispatchAttempts: 0,
      evidenceAtAdmission: c.accumulator.value, thresholdAtAdmission: threshold, reservations: [],
    };
    s.effects[id] = e; c.pending.sequence = sequence;
    // Each wake consumes its supporting evidence; data that arrived in flight are retained separately.
    c.accumulator.value = 0; c.accumulator.observations = 0; c.accumulator.evidenceRefs = [];
    reserve(c, e, g);
    return true;
  };
  const ingest = (c: Channel, datum: Extract<VsmEvent, { type: 'observation' }>): boolean => {
    const a = c.accumulator;
    a.value = Math.max(0, a.value - c.decayPerMs * (now - a.updatedAt));
    a.updatedAt = now;
    // Working-set evidence for the live accumulator; authoritative refs stay on effects,
    // alarms and audit findings, which are never trimmed.
    a.evidenceRefs = bounded(unique([...a.evidenceRefs, datum.evidenceRef]), HISTORY_LIMITS.channelEvidence);
    if (datum.index < c.filter.minIndex || c.filter.topics.length > 0 && !c.filter.topics.includes(datum.topic)) {
      a.filtered++;
      record('filtered', c, `Normal datum filtered; evidence pointer retained: ${datum.evidenceRef}`);
      return false;
    }
    a.value = Math.max(0, a.value + c.gain * datum.evidence);
    a.observations++;
    return true;
  };
  const accepted = (e: Effect, nativeId: string, sessionKey?: string): void => {
    need(nativeId.length > 0, 'RECEIPT_INVALID', 'Native receipt ID required');
    need(e.status !== 'intent' && e.status !== 'cancelled', 'EFFECT_TRANSITION', 'Cannot accept unreserved/cancelled effect');
    if (e.receipt) need(e.receipt.nativeId === nativeId, 'RECEIPT_CONFLICT', 'Stable effect maps to one native receipt');
    else e.receipt = { nativeId, acceptedAt: now, ...(sessionKey === undefined ? {} : { sessionKey }) };
    if (!e.outcome) e.status = 'accepted';
  };
  try {
    switch (event.type) {
      case 'observation': {
        need(Number.isFinite(event.index) && Number.isFinite(event.evidence) && !!event.evidenceRef, 'OBSERVATION_INVALID', 'Finite index and evidence required');
        const primary = channel(event.channelId);
        need(primary.kind !== 'algedonic', 'ALARM_EVENT_REQUIRED', 'Alarms use the bypass event, never ordinary filters');
        const origin = s.units[primary.unitId];
        let absorbed = false;
        const lateralIds = event.lateralChannelIds ?? Object.values(s.channels).filter(c =>
          ['V3', 'lateral'].includes(c.kind) && c.from.kind === 'organ' && c.from.unitId === origin.id).map(c => c.id);
        for (const id of unique(lateralIds).sort()) {
          const c = channel(id);
          const endpoints = [c.from, c.to];
          need(['V3', 'lateral'].includes(c.kind) && endpoints.some(e => e.kind === 'organ' && e.unitId === origin.id), 'LATERAL_NOT_SIBLING', 'Lateral candidate must touch the originating sibling');
          // Eligibility is a real absorption test: its normal filter, evidence, environment and grant must all admit.
          if (ingest(c, event) && attemptWake(c)) {
            record('lateral', c, `Absorbed locally; suppressed vertical ${primary.id}`, { evidence: true, environment: true, grant: true });
            absorbed = true; break;
          }
        }
        if (!absorbed && ingest(primary, event)) attemptWake(primary);
        break;
      }
      case 'ambient.changed': {
        need(isPrincipal(s, event.actor) || event.actor.kind === 'organ' && event.actor.unitId === s.rootId && event.actor.role === 'S3', 'AMBIENT_AUTHORITY', 'Root S3 or principal controls the ambient medium');
        need(Number.isFinite(event.gain) && Number.isFinite(event.price) && event.price >= 0, 'AMBIENT_INVALID', 'Finite gain and nonnegative price required');
        s.ambient = { gain: event.gain, price: event.price, version: s.ambient.version + 1 };
        record('modulation', null, `Threshold = max(0, base - ${event.gain} + ${event.price} * cost)`, undefined, 'slow-deliberative');
        // Modulation is a real event, not a periodic inference wake.
        for (const c of Object.values(s.channels).sort((a, b) => a.id.localeCompare(b.id))) if (c.accumulator.observations > 0) attemptWake(c);
        break;
      }
      case 'grant.changed': {
        const g = structuredClone(event.grant); const old = s.grants[g.id];
        need(canGrant(s, event.actor, g.unitId) && JSON.stringify(g.issuer) === JSON.stringify(event.actor), 'GRANT_SELF_ESCALATION', 'Only authenticated parent S3 or principal issues grants');
        need(g.version === (old?.version ?? 0) + 1 && (!old || old.unitId === g.unitId), 'GRANT_VERSION', 'Exact successor version and same grantee required');
        need(g.revokedAt === null, 'GRANT_INVALID', 'Issue active grants; use grant.revoked to withdraw');
        if (old) s.grantHistory.push(structuredClone(old));
        s.grants[g.id] = g;
        for (const e of Object.values(s.effects).filter(e => e.grantId === g.id && e.grantVersion !== g.version && e.status === 'reserved')) {
          e.status = 'ambiguous';
          actions.push({ type: 'reconcile', effectId: e.id });
        }
        for (const c of Object.values(s.channels).filter(c => c.unitId === g.unitId && c.accumulator.observations > 0).sort((a, b) => a.id.localeCompare(b.id))) attemptWake(c);
        break;
      }
      case 'grant.revoked': {
        const old = s.grants[event.grantId];
        need(old && canGrant(s, event.actor, old.unitId), 'GRANT_AUTHORITY', 'Only grant owner may revoke');
        need(event.version === old.version + 1, 'GRANT_VERSION', 'Revocation is a new version');
        s.grantHistory.push(structuredClone(old)); old.version = event.version; old.revokedAt = now;
        for (const e of Object.values(s.effects).filter(e => e.grantId === old.id && ['reserved', 'accepted', 'ambiguous'].includes(e.status))) {
          if (e.status === 'reserved') e.status = 'ambiguous';
          actions.push({ type: 'reconcile', effectId: e.id });
        }
        break;
      }
      case 'effect.admit': {
        const e = effect(event.effectId); const c = channel(e.channelId);
        // Only a definitive not-launched reconciliation permits a same-ID retry.
        need(e.status === 'lost' || e.status === 'intent', 'EFFECT_RECONCILE_FIRST', 'Unknown/accepted effects must reconcile, never retry');
        const g = Object.values(s.grants).sort((a, b) => a.id.localeCompare(b.id)).find(g => grantAdmits(s, g, e.unitId, e.procedureId, e.cost, now, e.id));
        const evidence = e.evidenceAtAdmission >= e.thresholdAtAdmission;
        record('brakes', c, `Readmit definitive not-launched effect ${e.id}`, { evidence, environment: true, grant: !!g });
        if (evidence && g) reserve(c, e, g);
        break;
      }
      case 'effect.accepted': accepted(effect(event.effectId), event.nativeId, event.sessionKey); break;
      case 'effect.ambiguous': {
        const e = effect(event.effectId);
        need(e.status !== 'intent', 'EFFECT_TRANSITION', 'Unreserved intent cannot have ambiguous launch');
        if (!e.outcome && !['cancelled', 'lost'].includes(e.status)) { e.status = 'ambiguous'; actions.push({ type: 'reconcile', effectId: e.id }); }
        break;
      }
      case 'effect.outcome': {
        need(Number.isFinite(event.value), 'OUTCOME_INVALID', 'Finite outcome required');
        const e = effect(event.effectId);
        need(!['intent', 'cancelled'].includes(e.status), 'EFFECT_TRANSITION', 'Outcome needs a reserved effect');
        if (e.outcome) {
          if (e.outcome.value !== event.value || (e.status === 'succeeded') !== event.success) audit(e, 'conflicting-outcome', Math.abs(e.outcome.value - event.value) || 1, [event.evidenceRef]);
          break;
        }
        e.outcome = { value: event.value, at: now, evidenceRef: event.evidenceRef };
        e.status = event.success ? 'succeeded' : 'failed';
        const residual = Math.abs(e.expectedOutcome - event.value);
        if (residual > 0 || !event.success) audit(e, 'outcome-residual', residual || 1, [event.evidenceRef]);
        if (e.environmentReturn) attemptWake(channel(e.channelId));
        break;
      }
      case 'environment.returned': {
        const e = effect(event.effectId);
        need(!['intent', 'cancelled'].includes(e.status), 'EFFECT_TRANSITION', 'Environment return needs reserved action');
        if (!e.environmentReturn) e.environmentReturn = { evidenceRef: event.evidenceRef, at: now };
        if (e.outcome) attemptWake(channel(e.channelId));
        break;
      }
      case 'effect.reconciled': {
        const e = effect(event.effectId);
        if (event.result === 'accepted') { need(event.nativeId, 'RECEIPT_INVALID', 'Reconciled acceptance needs native receipt'); accepted(e, event.nativeId); }
        else if (event.result === 'not-launched') {
          need(!e.receipt && !e.outcome && !e.environmentReturn, 'RECONCILIATION_CONFLICT', 'An accepted or observed effect cannot be declared absent');
          need(['reserved', 'ambiguous', 'lost'].includes(e.status), 'EFFECT_TRANSITION', 'Only uncertain reservations reconcile as absent');
          e.status = 'lost';
        } else if (!e.outcome) e.status = 'ambiguous';
        record('reconcile', channel(e.channelId), `Reconciled ${e.id}: ${event.result}`);
        break;
      }
      case 'restart': {
        for (const e of Object.values(s.effects)) {
          // A proven no-launch ('lost') is already resolved; re-reconciling it would
          // turn known absence back into ambiguity.
          if (['reserved', 'accepted', 'ambiguous'].includes(e.status) || !!e.outcome && !e.environmentReturn) {
            if (e.status === 'reserved') e.status = 'ambiguous';
            actions.push({ type: 'reconcile', effectId: e.id });
          }
        }
        for (const alarm of Object.values(s.alarms).filter(a => a.state === 'raised')) actions.push({ type: 'alarm', alarmId: alarm.id, rootS5: s.units[s.rootId].organs.S5.id, principalId: s.principalId, wakeClass: 'alarm' });
        for (const finding of Object.values(s.auditFindings)) {
          const auditor = s.units[finding.unitId].parentId ?? s.rootId;
          actions.push({ type: 'audit', findingId: finding.id, organId: s.units[auditor].organs['S3*'].id, wakeClass: 'slow-deliberative' });
        }
        for (const [alarmClass, item] of Object.entries(s.alarmClasses)) if (item.improvementDue) actions.push({ type: 'improve-alarm-class', alarmClass, organId: s.units[s.rootId].organs.S4.id, wakeClass: 'slow-deliberative' });
        record('reconcile', null, 'Recovery emits reconcile and durable notifications only, never dispatch');
        break;
      }
      case 'alarm.raised': {
        need(!!s.units[event.unitId] && Number.isFinite(event.severity) && event.severity >= 0 && positive(event.falseAlarmCost) && positive(event.delayCost) && Number.isFinite(event.localThreshold), 'ALARM_INVALID', 'Known unit, finite nonnegative severity and positive costs required');
        need(!s.alarms[event.alarmId], 'ALARM_ID_REUSED', 'Stable alarm IDs may not be reassigned');
        const threshold = Math.max(0, event.localThreshold - Math.log(event.delayCost / event.falseAlarmCost) - s.ambient.gain);
        const raised = event.severity >= threshold;
        const localS5 = s.units[event.unitId].organs.S5.id; const rootS5 = s.units[s.rootId].organs.S5.id;
        s.alarms[event.alarmId] = {
          id: event.alarmId, unitId: event.unitId, class: event.alarmClass, severity: event.severity, threshold,
          evidenceRefs: [event.evidenceRef], route: unique([localS5, rootS5, s.principalId]), state: raised ? 'raised' : 'recorded',
          raisedAt: raised ? now : null, acknowledgedAt: null, acknowledgedBy: null,
        };
        if (raised) {
          const previous = s.alarmClasses[event.alarmClass] ?? { count: 0, lastAt: now, improvementDue: false };
          const repeated = previous.count + 1;
          s.alarmClasses[event.alarmClass] = { count: repeated, lastAt: now, improvementDue: repeated >= 3 };
          actions.push({ type: 'alarm', alarmId: event.alarmId, rootS5, principalId: s.principalId, wakeClass: 'alarm' });
          if (repeated === 3) actions.push({ type: 'improve-alarm-class', alarmClass: event.alarmClass, organId: s.units[s.rootId].organs.S4.id, wakeClass: 'slow-deliberative' });
        }
        record('alarm', null, `Alarm ${event.alarmId} bypasses normal filters; threshold=${threshold}; raised=${raised}`, undefined, 'alarm');
        break;
      }
      case 'alarm.acknowledged': {
        const alarm = s.alarms[event.alarmId];
        need(alarm, 'ALARM_UNKNOWN', event.alarmId);
        need(isPrincipal(s, event.actor) || event.actor.kind === 'organ' && event.actor.role === 'S5' && (event.actor.unitId === s.rootId || event.actor.unitId === alarm.unitId), 'ALARM_ACK_AUTHORITY', 'S5 or principal acknowledges');
        need(alarm.state !== 'recorded', 'ALARM_NOT_RAISED', 'Subthreshold alarm was not raised');
        if (alarm.state !== 'acknowledged') { alarm.state = 'acknowledged'; alarm.acknowledgedAt = now; alarm.acknowledgedBy = event.actor; }
        break;
      }
      case 'purpose.feedback': {
        need(canValue(s, event.actor, event.unitId), 'PURPOSE_AUTHORITY', 'Valuation belongs to parent S3 or principal, never the unit');
        need(event.unitId !== s.rootId, 'PURPOSE_ROOT_CHARTER', 'Root purpose changes require external charter ratification');
        const p = s.units[event.unitId].purpose;
        need(Object.keys(event.values).length === Object.keys(p.exits).length && Object.keys(p.exits).every(key => Object.hasOwn(event.values, key) && Number.isFinite(event.values[key])), 'PURPOSE_EXITS', 'Parent must value every exit state');
        let maxError = 0;
        for (const [id, exit] of Object.entries(p.exits)) {
          exit.imputed = event.values[id];
          const delta = exit.imputed - exit.declared;
          exit.declared += Math.max(-p.maxUpdate, Math.min(p.maxUpdate, delta));
          exit.error = exit.imputed - exit.declared; maxError = Math.max(maxError, Math.abs(exit.error));
        }
        p.revision++; p.convergenceSteps++; p.converged = maxError <= p.tolerance;
        p.evidenceRefs = unique([...p.evidenceRefs, event.evidenceRef]);
        record('purpose', null, `Parent updated all exits of ${event.unitId}; maxError=${maxError}; converged=${p.converged}`, undefined, 'slow-deliberative');
        break;
      }
      case 'audit.inspect': {
        const e = effect(event.effectId);
        if (now >= e.returnDueAt && !e.environmentReturn && !['intent', 'lost', 'cancelled'].includes(e.status)) audit(e, 'missing-return', 1, []);
        if (e.outcome && Math.abs(e.expectedOutcome - e.outcome.value) > 0) audit(e, 'outcome-residual', Math.abs(e.expectedOutcome - e.outcome.value), [e.outcome.evidenceRef]);
        break;
      }
      case 'audit.finding': {
        need(parentAuditActor(s, event.actor, event.finding.unitId), 'AUDIT_AUTHORITY', 'Independent parent S3* or principal writes findings');
        need(!s.auditFindings[event.finding.id] && event.finding.residual >= 0 && Number.isFinite(event.finding.residual), 'AUDIT_INVALID', 'Fresh finding with nonnegative residual required');
        s.auditFindings[event.finding.id] = structuredClone(event.finding);
        break;
      }
      case 'episode.recorded': {
        need(!s.episodes[event.episode.id] && !!s.units[event.episode.unitId], 'EPISODE_IMMUTABLE', 'Append-only episode reference with known owner required');
        need(event.episode.recordedAt <= now && event.episode.cost >= 0, 'EPISODE_INVALID', 'Knowledge time cannot be in the future; cost nonnegative');
        s.episodes[event.episode.id] = structuredClone(event.episode);
        break;
      }
      case 'fact.recorded': {
        const fact = event.fact;
        need(!!s.units[fact.unitId] && (isPrincipal(s, event.actor) || event.actor.kind === 'organ' && event.actor.unitId === fact.unitId &&
          ({ world: 'S4', self: 'S4', resource: 'S3', coordination: 'S2', identity: 'S5' } as const)[fact.kind] === event.actor.role), 'FACT_AUTHORITY', 'Semantic model writes belong to their organ');
        need(!s.facts[fact.id] && fact.recordedAt <= now && (fact.supersedes === null || s.facts[fact.supersedes]?.unitId === fact.unitId && s.facts[fact.supersedes]?.kind === fact.kind), 'FACT_IMMUTABLE', 'Append-only bitemporal facts require valid predecessor');
        s.facts[fact.id] = structuredClone(fact);
        break;
      }
      default: throw new Rejection('EVENT_UNKNOWN', 'Unknown event type');
    }
    s.updatedAt = now; s.revision++; s.seenEvents[event.id] = now;
    const seenKeys = Object.keys(s.seenEvents);
    if (seenKeys.length > HISTORY_LIMITS.seenEvents) {
      for (const key of seenKeys.slice(0, seenKeys.length - HISTORY_LIMITS.seenEvents)) delete s.seenEvents[key];
    }
    const errors = validateState(s, state);
    if (errors.length) return reject(errors);
    return { state: s, actions, decisions, errors: [] };
  } catch (e) {
    return reject([{ code: e instanceof Rejection ? e.code : 'EVENT_SHAPE', path: 'event', message: String(e) }]);
  }
}
