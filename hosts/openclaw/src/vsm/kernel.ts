import { ORGAN_ROLES } from './types.js';
import type { Actor, Channel, ChannelKind, Endpoint, Grant, Id, Json, OrganRole, ValidationError, VsmState, VsmUnit } from './types.js';

const safeId = (id: string): boolean => /^[A-Za-z0-9][A-Za-z0-9._:/@*-]{0,199}$/.test(id) && !['__proto__', 'constructor', 'prototype'].includes(id);
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
const finite = (n: number): boolean => Number.isFinite(n);
const nonnegative = (n: number): boolean => finite(n) && n >= 0;
export function endpointKey(endpoint: Endpoint): string {
  return endpoint.kind === 'organ' ? `${endpoint.unitId}/${endpoint.role}` : `environment/${endpoint.environmentId}`;
}
export const organ = (unitId: Id, role: OrganRole): Endpoint => ({ kind: 'organ', unitId, role });
export const environment = (environmentId: Id): Endpoint => ({ kind: 'environment', environmentId });

export interface UnitInput { id: Id; parentId: Id | null; purpose?: string; exits?: Record<string, number>; maxPurposeUpdate?: number }
export interface DirectionInput {
  from: Endpoint; to: Endpoint; unitId: Id; procedureId?: Id | null;
  threshold?: number; gain?: number; cost?: number; minIndex?: number; topics?: string[];
  decayPerMs?: number; capacity?: number; delayMs?: number; transducerRef?: string;
}
export interface HomeostatInput { id: Id; kind: ChannelKind; directions: [DirectionInput, DirectionInput]; cycleMs?: number }

function addLoop(state: VsmState, input: HomeostatInput, now: number): void {
  input = structuredClone(input);
  if (state.homeostats[input.id]) throw new Error(`DUPLICATE_HOMEOSTAT:${input.id}`);
  const ids: [Id, Id] = [`${input.id}/forward`, `${input.id}/return`];
  state.homeostats[input.id] = { id: input.id, directions: ids, cycleMs: input.cycleMs ?? 0 };
  input.directions.forEach((direction, i) => {
    const id = ids[i];
    const roles = [direction.from, direction.to].flatMap(e => e.kind === 'organ' ? [e.role] : []);
    state.channels[id] = {
      id, homeostatId: input.id, kind: input.kind, from: direction.from, to: direction.to,
      unitId: direction.unitId, procedureId: direction.procedureId ?? null,
      capacity: direction.capacity ?? 1, delayMs: direction.delayMs ?? 0,
      gain: direction.gain ?? 1, threshold: direction.threshold ?? 1,
      decayPerMs: direction.decayPerMs ?? 0, transducerRef: direction.transducerRef ?? 'code:identity',
      filter: { minIndex: direction.minIndex ?? 0, topics: direction.topics ?? [] },
      cost: direction.cost ?? 1,
      wakeClass: input.kind === 'algedonic' ? 'alarm' : roles.some(r => ['S3*', 'S4', 'S5'].includes(r)) ? 'slow-deliberative' : 'fast-code',
      accumulator: { value: 0, updatedAt: now, observations: 0, filtered: 0, evidenceRefs: [] },
      pending: { phase: 'parked', lastEffectId: null, sequence: 0 },
    };
  });
}
function seedUnit(state: VsmState, input: UnitInput, now: number): void {
  if (state.units[input.id]) throw new Error(`DUPLICATE_UNIT:${input.id}`);
  const ownerId = input.parentId ?? state.principalId;
  const organs = {} as VsmUnit['organs'];
  for (const role of ORGAN_ROLES) {
    const procedureId = `${input.id}/seed/${role}`;
    organs[role] = { id: `${input.id}/${role}`, unitId: input.id, role, procedureIds: [procedureId] };
    state.procedures[procedureId] = {
      id: procedureId, unitId: input.id, organ: role, version: 1, kind: 'code',
      executionRef: `kernel:${role}:v1`, kernel: true, expectedOutcome: 1, returnTimeoutMs: 60_000, requiredTools: [], requiredSurfaces: [],
    };
  }
  const exits = Object.fromEntries(Object.entries(input.exits ?? { complete: 0 }).map(([id, value]) =>
    [id, { declared: value, imputed: value, error: 0 }]));
  const environmentIds = { operational: `${input.id}/env/operational`, total: `${input.id}/env/total`, future: `${input.id}/env/future` };
  state.units[input.id] = {
    id: input.id, parentId: input.parentId, ownerId, organs, environmentIds,
    purpose: { description: input.purpose ?? '', valuationOwner: ownerId, exits, revision: 0, convergenceSteps: 0,
      maxUpdate: input.maxPurposeUpdate ?? 1, tolerance: 1e-6, converged: true, evidenceRefs: [] },
  };
  for (const kind of ['operational', 'total', 'future'] as const) {
    const id = environmentIds[kind];
    state.environments[id] = { id, unitId: input.id, kind, reference: `environment:${id}` };
  }
  const pair = (id: string, kind: ChannelKind, a: Endpoint, b: Endpoint): void => addLoop(state, {
    id, kind, directions: [{ from: a, to: b, unitId: input.id }, { from: b, to: a, unitId: input.id }],
  }, now);
  pair(`${input.id}/alarm`, 'algedonic', organ(input.id, 'operation'), organ(state.rootId, 'S5'));
  pair(`${input.id}/adapt`, 'metasystemic', organ(input.id, 'S3'), organ(input.id, 'S4'));
  pair(`${input.id}/environment`, 'environmental', organ(input.id, 'operation'), environment(environmentIds.operational));
  pair(`${input.id}/future`, 'environmental', organ(input.id, 'S4'), environment(environmentIds.future));
  pair(`${input.id}/local`, 'local', organ(input.id, 'operation'), organ(input.id, 'management'));
  if (input.parentId !== null) {
    pair(`${input.id}/V1`, 'V1', organ(input.parentId, 'S3'), organ(input.id, 'management'));
    pair(`${input.id}/V2`, 'V2', organ(input.parentId, 'S3'), organ(input.id, 'management'));
    pair(`${input.id}/V5`, 'V5', organ(input.parentId, 'S2'), organ(input.id, 'regulatory-centre'));
    pair(`${input.id}/V6`, 'V6', organ(input.parentId, 'S3*'), organ(input.id, 'operation'));
  }
}
export function createState(input: { rootId: Id; principalId: Id; charter: string; now: number; kernelRefs?: Readonly<Record<string, string>> }): VsmState {
  const state: VsmState = {
    version: 1, revision: 0, updatedAt: input.now, principalId: input.principalId, rootId: input.rootId,
    kernelRefs: { ...(input.kernelRefs ?? { seed: 'kernel:v1' }) },
    charter: { unitId: input.rootId, version: 1, text: input.charter, ratifiedBy: input.principalId },
    units: {}, environments: {}, procedures: {}, channels: {}, homeostats: {}, grants: {}, grantHistory: [],
    effects: {}, alarms: {}, alarmClasses: {}, auditFindings: {}, episodes: {}, facts: {},
    ambient: { gain: 0, price: 0, version: 0 }, decisions: [], seenEvents: {},
  };
  seedUnit(state, { id: input.rootId, parentId: null }, input.now);
  assertValid(state);
  return state;
}
export function addUnit(state: VsmState, input: UnitInput): VsmState {
  if (input.parentId === null || !state.units[input.parentId]) throw new Error('PARENT_REQUIRED');
  const next = structuredClone(state);
  seedUnit(next, input, state.updatedAt);
  next.revision++;
  assertValid(next, state);
  return next;
}
export function connectHomeostat(state: VsmState, input: HomeostatInput): VsmState {
  const next = structuredClone(state);
  addLoop(next, input, state.updatedAt);
  next.revision++;
  assertValid(next, state);
  return next;
}
export function configureChannel(state: VsmState, id: Id, config: Partial<Pick<Channel, 'threshold' | 'gain' | 'cost' | 'filter' | 'decayPerMs' | 'procedureId'>>): VsmState {
  if (!state.channels[id]) throw new Error('CHANNEL_UNKNOWN');
  const next = structuredClone(state);
  Object.assign(next.channels[id], structuredClone(config));
  next.revision++;
  assertValid(next, state);
  return next;
}
export function isPrincipal(state: VsmState, actor: Actor): boolean { return actor.kind === 'principal' && actor.id === state.principalId; }
export function canValue(state: VsmState, actor: Actor, unitId: Id): boolean {
  const unit = state.units[unitId];
  return !!unit && (isPrincipal(state, actor) || (unit.parentId !== null && actor.kind === 'organ' && actor.unitId === unit.parentId && actor.role === 'S3'));
}
export function canGrant(state: VsmState, actor: Actor, unitId: Id): boolean { return canValue(state, actor, unitId); }
export function grantAdmits(state: VsmState, grant: Grant, unitId: Id, procedureId: Id, cost: number, now: number, excludeEffect?: Id): boolean {
  const procedure = state.procedures[procedureId];
  if (!procedure || procedure.requiredTools.some(tool => !grant.tools.includes(tool)) || procedure.requiredSurfaces.some(surface => !grant.surfaces.includes(surface))) return false;
  const reserved = Object.values(state.effects).filter(e => e.id !== excludeEffect && e.grantId === grant.id &&
    (!['lost', 'cancelled'].includes(e.status)) && !(e.outcome && e.environmentReturn)).reduce((sum, e) => sum + e.cost, 0);
  return grant.unitId === unitId && grant.revokedAt === null && now >= grant.validFrom && now < grant.validUntil &&
    grant.procedureIds.includes(procedureId) && reserved + cost <= grant.capacity && canGrant(state, grant.issuer, unitId);
}
function endpointUnit(state: VsmState, e: Endpoint): Id | null {
  return e.kind === 'organ' ? (state.units[e.unitId]?.organs[e.role] ? e.unitId : null) : state.environments[e.environmentId]?.unitId ?? null;
}
function legalChannel(state: VsmState, channel: Channel): boolean {
  const { from: a, to: b, kind } = channel;
  const au = endpointUnit(state, a); const bu = endpointUnit(state, b);
  if (!au || !bu || same(a, b)) return false;
  const siblings = au !== bu && state.units[au].parentId !== null && state.units[au].parentId === state.units[bu].parentId;
  const rolePair = (x: OrganRole, y: OrganRole, parentChild = false): boolean => a.kind === 'organ' && b.kind === 'organ' &&
    ((a.role === x && b.role === y && (!parentChild || state.units[bu].parentId === au)) ||
     (b.role === x && a.role === y && (!parentChild || state.units[au].parentId === bu)));
  switch (kind) {
    case 'V1': case 'V2': return rolePair('S3', 'management', true);
    case 'V3': return siblings && rolePair('operation', 'operation');
    case 'V4': return siblings && a.kind === 'environment' && b.kind === 'environment' &&
      state.environments[a.environmentId].kind === 'operational' && state.environments[b.environmentId].kind === 'operational';
    case 'V5': return rolePair('S2', 'regulatory-centre', true);
    case 'V6': return rolePair('S3*', 'operation', true);
    case 'metasystemic': return au === bu && rolePair('S3', 'S4');
    case 'lateral': return siblings && (rolePair('regulatory-centre', 'regulatory-centre') || rolePair('operation', 'operation'));
    case 'algedonic': return a.kind === 'organ' && b.kind === 'organ' &&
      ((a.unitId === state.rootId && a.role === 'S5') || (b.unitId === state.rootId && b.role === 'S5'));
    case 'environmental': {
      const o = a.kind === 'organ' ? a : b.kind === 'organ' ? b : null;
      const e = a.kind === 'environment' ? state.environments[a.environmentId] : b.kind === 'environment' ? state.environments[b.environmentId] : null;
      return !!o && !!e && o.unitId === e.unitId && (o.role === 'operation' && e.kind !== 'future' || o.role === 'S4' && e.kind === 'future');
    }
    case 'local': return au === bu && (rolePair('operation', 'management') || rolePair('operation', 'regulatory-centre') || rolePair('S1', 'operation'));
    default: return false;
  }
}
/** Trust boundary for deserialized JSON as well as typed callers. Does not impose a UI size limit. */
export function validateState(state: VsmState, previous?: VsmState): ValidationError[] {
  const errors: ValidationError[] = [];
  const error = (code: string, path: string, message: string): void => { errors.push({ code, path, message }); };
  try { assertJson(state); } catch (e) { error('STATE_NOT_JSON', '', String(e)); return errors; }
  try {
    if (state.version !== 1) error('STATE_VERSION', 'version', 'Unsupported kernel version');
    if (!safeId(state.rootId) || !safeId(state.principalId) || state.rootId === state.principalId) error('IDENTITY_INVALID', 'rootId', 'Distinct safe root and principal IDs required');
    if (!Number.isSafeInteger(state.revision) || state.revision < 0 || !nonnegative(state.updatedAt)) error('STATE_CLOCK', 'revision', 'Invalid revision or clock');
    const roots = Object.values(state.units).filter(u => u.parentId === null);
    if (roots.length !== 1 || roots[0].id !== state.rootId) error('ROOT_COUNT', 'units', 'Exactly one designated root is required');
    if (state.charter.unitId !== state.rootId || state.charter.ratifiedBy !== state.principalId || !Number.isSafeInteger(state.charter.version) || state.charter.version < 1) error('CHARTER_ROOT_ONLY', 'charter', 'Only the principal ratifies the root charter');
    for (const [table, records] of Object.entries({ units: state.units, environments: state.environments, procedures: state.procedures, channels: state.channels, homeostats: state.homeostats, grants: state.grants, effects: state.effects, alarms: state.alarms, auditFindings: state.auditFindings, episodes: state.episodes, facts: state.facts })) {
      for (const [id, record] of Object.entries(records)) if (!safeId(id) || record.id !== id) error('RECORD_ID', `${table}.${id}`, 'Safe matching record ID required');
    }
    for (const unit of Object.values(state.units)) {
      const path = `units.${unit.id}`;
      if (unit.parentId !== null && !state.units[unit.parentId]) error('PARENT_UNKNOWN', path, 'Unknown parent');
      if (unit.ownerId !== (unit.parentId ?? state.principalId)) error('OWNER_MISMATCH', path, 'The parent is the only owner (principal owns root)');
      const visited = new Set<Id>(); let cursor: VsmUnit | undefined = unit;
      while (cursor) {
        if (visited.has(cursor.id)) { error('UNIT_CYCLE', path, 'Ownership must be a tree'); break; }
        visited.add(cursor.id); cursor = cursor.parentId === null ? undefined : state.units[cursor.parentId];
      }
      for (const role of ORGAN_ROLES) {
        const o = unit.organs[role];
        if (!o || o.unitId !== unit.id || o.role !== role || o.id !== `${unit.id}/${role}` || !o.procedureIds.length || o.procedureIds.some(id => state.procedures[id]?.unitId !== unit.id || state.procedures[id]?.organ !== role)) error('ORGAN_REQUIRED', `${path}.organs.${role}`, 'Required organ with owned procedure missing');
      }
      if ('charter' in unit) error('CHARTER_ROOT_ONLY', path, 'Charter must be on the root state, not a unit');
      for (const kind of ['operational', 'total', 'future'] as const) {
        const e = state.environments[unit.environmentIds[kind]];
        if (e?.unitId !== unit.id || e.kind !== kind) error('ENVIRONMENT_REQUIRED', path, `Missing ${kind} environment`);
      }
      const p = unit.purpose;
      if (p.valuationOwner !== unit.ownerId || !Object.keys(p.exits).length) error('PURPOSE_OWNER', path, 'Parent owns the nonempty exit valuation');
      if (!finite(p.maxUpdate) || p.maxUpdate <= 0 || !nonnegative(p.tolerance) || Object.values(p.exits).some(v => !finite(v.declared) || !finite(v.imputed) || !finite(v.error))) error('PURPOSE_VALUES', path, 'Finite exit values and positive update bound required');
      if (!Object.values(state.channels).some(c => c.kind === 'algedonic' && c.from.kind === 'organ' && c.from.unitId === unit.id && c.to.kind === 'organ' && c.to.unitId === state.rootId && c.to.role === 'S5')) error('ALARM_PATH_REQUIRED', path, 'Every unit has an immutable direct root S5 path');
    }
    for (const e of Object.values(state.environments)) if (!state.units[e.unitId]) error('ENVIRONMENT_UNIT', `environments.${e.id}`, 'Environment owner missing');
    for (const p of Object.values(state.procedures)) if (!state.units[p.unitId]?.organs[p.organ] || !Number.isSafeInteger(p.version) || p.version < 1 || !finite(p.expectedOutcome) || !nonnegative(p.returnTimeoutMs)) error('PROCEDURE_INVALID', `procedures.${p.id}`, 'Invalid procedure owner/version/expectation');
    for (const h of Object.values(state.homeostats)) {
      const [a, b] = h.directions.map(id => state.channels[id]);
      if (h.directions.length !== 2 || !a || !b || a.id === b.id || a.homeostatId !== h.id || b.homeostatId !== h.id || a.kind !== b.kind || !same(a.from, b.to) || !same(a.to, b.from)) error('HOMEOSTAT_PAIR', `homeostats.${h.id}`, 'Two opposite directions of the same kind required');
      if (!nonnegative(h.cycleMs)) error('HOMEOSTAT_CYCLE', `homeostats.${h.id}`, 'Nonnegative cycle time required');
    }
    for (const c of Object.values(state.channels)) {
      const path = `channels.${c.id}`;
      if (!state.homeostats[c.homeostatId]?.directions.includes(c.id)) error('CHANNEL_HOMEOSTAT', path, 'Orphan channel');
      if (!state.units[c.unitId] || ![endpointUnit(state, c.from), endpointUnit(state, c.to)].includes(c.unitId) || !legalChannel(state, c)) error('CHANNEL_ENDPOINTS', path, 'Illegal endpoints for channel kind');
      if (c.procedureId !== null && state.procedures[c.procedureId]?.unitId !== c.unitId) error('CHANNEL_PROCEDURE', path, 'Execution procedure must belong to channel unit');
      if (![c.capacity, c.delayMs, c.gain, c.threshold, c.decayPerMs, c.cost, c.accumulator.value, c.accumulator.updatedAt].every(nonnegative) || !finite(c.filter.minIndex)) error('CHANNEL_NUMERIC', path, 'Finite nonnegative channel parameters required');
      const slow = [c.from, c.to].some(e => e.kind === 'organ' && ['S3*', 'S4', 'S5'].includes(e.role));
      const wake = c.kind === 'algedonic' ? 'alarm' : slow ? 'slow-deliberative' : 'fast-code';
      if (c.wakeClass !== wake) error('WAKE_CLASS', path, 'Wake class follows organ timescale');
      if (!Number.isSafeInteger(c.pending.sequence) || c.pending.sequence < 0 || !Number.isSafeInteger(c.accumulator.observations) || c.accumulator.observations < 0 || !Number.isSafeInteger(c.accumulator.filtered) || c.accumulator.filtered < 0 || !['parked', 'evidence', 'waiting-environment', 'waiting-grant', 'reserved'].includes(c.pending.phase)) error('CHANNEL_PENDING', path, 'Invalid persistent loop phase or counters');
      if (c.pending.lastEffectId !== null && (state.effects[c.pending.lastEffectId]?.channelId !== c.id || state.effects[c.pending.lastEffectId]?.sequence !== c.pending.sequence)) error('CHANNEL_EFFECT', path, 'Pending effect must belong to channel');
    }
    for (const g of [...Object.values(state.grants), ...state.grantHistory]) {
      const path = `grants.${g.id}`;
      if (!canGrant(state, g.issuer, g.unitId)) error('GRANT_SELF_ESCALATION', path, 'Only parent S3 or principal may issue grants');
      if (!Number.isSafeInteger(g.version) || g.version < 1 || !nonnegative(g.capacity) || !nonnegative(g.validFrom) || !finite(g.validUntil) || g.validUntil <= g.validFrom || (g.revokedAt !== null && !nonnegative(g.revokedAt)) || g.procedureIds.some(id => state.procedures[id]?.unitId !== g.unitId)) error('GRANT_INVALID', path, 'Invalid version, bounds or procedures');
    }
    for (const e of Object.values(state.effects)) {
      const path = `effects.${e.id}`;
      if (state.channels[e.channelId]?.unitId !== e.unitId || state.procedures[e.procedureId]?.unitId !== e.unitId || e.id !== `${e.channelId}/effect/${e.sequence}`) error('EFFECT_IDENTITY', path, 'Stable channel/sequence identity and owned procedure required');
      if (![e.cost, e.intentAt, e.returnDueAt, e.evidenceAtAdmission, e.thresholdAtAdmission].every(nonnegative) || !Number.isSafeInteger(e.sequence) || e.sequence < 1 || e.sequence > state.channels[e.channelId]?.pending.sequence || e.evidenceAtAdmission < e.thresholdAtAdmission || !Number.isSafeInteger(e.dispatchAttempts) || e.dispatchAttempts < 1 || !['intent', 'reserved', 'accepted', 'ambiguous', 'lost', 'succeeded', 'failed', 'cancelled'].includes(e.status)) error('EFFECT_NUMERIC', path, 'Invalid effect amounts/times');
      if (e.status !== 'intent' && (e.grantId === null || e.grantVersion === null || e.reservedAt === null)) error('EFFECT_RESERVATION', path, 'Non-intent effects retain their original reservation');
      if (e.grantId !== null && ![...Object.values(state.grants), ...state.grantHistory].some(g => g.id === e.grantId && g.version === e.grantVersion && g.unitId === e.unitId && g.procedureIds.includes(e.procedureId))) error('EFFECT_GRANT', path, 'Reserved grant version must exist in current state or history');
      if (!e.reservations.length || e.reservations.some((r, i) => r.attempt !== i + 1 || !nonnegative(r.at) || !nonnegative(r.cost) || ![...Object.values(state.grants), ...state.grantHistory].some(g => g.id === r.grantId && g.version === r.grantVersion)) || e.reservations.length !== e.dispatchAttempts) error('EFFECT_RESERVATIONS', path, 'Every dispatch attempt retains its grant-version reservation');
      if (e.receipt !== null && (!e.receipt.nativeId || !nonnegative(e.receipt.acceptedAt))) error('EFFECT_RECEIPT', path, 'Native receipt identity and timestamp required');
      if (e.outcome !== null && (!finite(e.outcome.value) || !nonnegative(e.outcome.at) || !e.outcome.evidenceRef)) error('EFFECT_OUTCOME', path, 'Outcome must carry a finite value and provenance');
      if (e.environmentReturn !== null && (!nonnegative(e.environmentReturn.at) || !e.environmentReturn.evidenceRef)) error('EFFECT_RETURN', path, 'Environment return requires provenance');
      if (['succeeded', 'failed'].includes(e.status) !== (e.outcome !== null)) error('EFFECT_TERMINAL', path, 'Only terminal outcomes use succeeded/failed state');
    }
    const grantIds = new Set([...Object.keys(state.grants), ...state.grantHistory.map(g => g.id)]);
    for (const id of grantIds) {
      const versions = [...state.grantHistory.filter(g => g.id === id), ...(state.grants[id] ? [state.grants[id]] : [])].sort((a, b) => a.version - b.version);
      if (!state.grants[id] || versions.some((g, i) => g.version !== i + 1)) error('GRANT_HISTORY', `grants.${id}`, 'Grant versions must be contiguous, unique and retained');
    }
    for (const alarm of Object.values(state.alarms)) {
      const path = `alarms.${alarm.id}`; const unit = state.units[alarm.unitId];
      const route = unit ? [...new Set([unit.organs.S5.id, state.units[state.rootId].organs.S5.id, state.principalId])] : [];
      if (!unit || !same(alarm.route, route)) error('ALARM_ROUTE', path, 'Alarms bypass intermediate management on a direct S5/principal path');
      if (![alarm.severity, alarm.threshold].every(nonnegative) || !['recorded', 'raised', 'acknowledged'].includes(alarm.state) || !alarm.evidenceRefs.length) error('ALARM_INVALID', path, 'Alarm state, numeric threshold and evidence required');
      if (alarm.state === 'acknowledged' && (alarm.acknowledgedAt === null || alarm.acknowledgedBy === null)) error('ALARM_ACKNOWLEDGMENT', path, 'Acknowledgment requires actor and time');
    }
    for (const finding of Object.values(state.auditFindings)) {
      if (!state.units[finding.unitId] || !nonnegative(finding.residual) || !nonnegative(finding.at) || finding.effectId !== null && state.effects[finding.effectId]?.unitId !== finding.unitId || !['outcome-residual', 'missing-return', 'conflicting-outcome', 'inspection'].includes(finding.kind) || finding.attribution.some(a => !nonnegative(a.credit) || !nonnegative(a.blame))) error('AUDIT_INVALID', `auditFindings.${finding.id}`, 'Audit finding requires owned effect, residual and attribution');
    }
    for (const episode of Object.values(state.episodes)) {
      if (!state.units[episode.unitId]?.organs[episode.organ] || !episode.traceRef || ![episode.validAt, episode.recordedAt, episode.cost].every(nonnegative)) error('EPISODE_INVALID', `episodes.${episode.id}`, 'Valid bitemporal episode with owner, cost and trace reference required');
    }
    for (const fact of Object.values(state.facts)) {
      if (!state.units[fact.unitId] || !['world', 'self', 'resource', 'coordination', 'identity'].includes(fact.kind) || !nonnegative(fact.validFrom) || !nonnegative(fact.recordedAt) || fact.validUntil !== null && (!finite(fact.validUntil) || fact.validUntil < fact.validFrom) || fact.supersedes !== null && (!state.facts[fact.supersedes] || state.facts[fact.supersedes].unitId !== fact.unitId || state.facts[fact.supersedes].kind !== fact.kind)) error('FACT_INVALID', `facts.${fact.id}`, 'Bitemporal semantic fact requires a same-owner/kind predecessor');
    }
    if (!finite(state.ambient.gain) || !nonnegative(state.ambient.price)) error('AMBIENT_INVALID', 'ambient', 'Finite gain and nonnegative price required');
    if (previous) {
      if (!same(previous.kernelRefs, state.kernelRefs) || previous.rootId !== state.rootId || previous.principalId !== state.principalId) error('KERNEL_IMMUTABLE', 'kernelRefs', 'Kernel references and deployment identity are read-only');
      for (const p of Object.values(previous.procedures).filter(p => p.kernel)) if (!same(p, state.procedures[p.id])) error('KERNEL_IMMUTABLE', `procedures.${p.id}`, 'Seed procedures are read-only');
      for (const c of Object.values(previous.channels).filter(c => c.kind === 'algedonic')) {
        const n = state.channels[c.id];
        if (!n || n.kind !== c.kind || !same(n.from, c.from) || !same(n.to, c.to)) error('ALARM_PATH_IMMUTABLE', `channels.${c.id}`, 'Algedonic paths cannot be removed or rewired');
      }
      for (const g of Object.values(state.grants)) {
        const old = previous.grants[g.id];
        if (old && !same(old, g) && (g.version !== old.version + 1 || g.unitId !== old.unitId || !state.grantHistory.some(h => same(h, old)))) error('GRANT_VERSION', `grants.${g.id}`, 'Grant changes append old version and increment exactly once');
      }
    }
  } catch (e) { error('STATE_SHAPE', '', `Malformed state: ${String(e)}`); }
  return errors;
}
export function assertValid(state: VsmState, previous?: VsmState): void {
  const errors = validateState(state, previous);
  if (errors.length) throw new Error(errors.map(e => `${e.code}:${e.path}:${e.message}`).join('\n'));
}
export function assertJson(value: unknown): void {
  const ancestors = new Set<object>();
  const visit = (v: unknown): void => {
    if (v === null || typeof v === 'string' || typeof v === 'boolean' || typeof v === 'number' && finite(v)) return;
    if (!v || typeof v !== 'object') throw new Error('Non-JSON value');
    if (ancestors.has(v)) throw new Error('Cyclic JSON value');
    if (!Array.isArray(v) && Object.getPrototypeOf(v) !== Object.prototype && Object.getPrototypeOf(v) !== null) throw new Error('Non-plain object');
    if (Array.isArray(v) && (Object.keys(v).length !== v.length || Object.keys(v).some((key, i) => key !== String(i)))) throw new Error('Non-dense JSON array');
    ancestors.add(v);
    for (const child of Object.values(v)) visit(child);
    ancestors.delete(v);
  };
  visit(value);
}
export const TRANSPORT_LIMITS = { bytes: 262144, nodes: 4096, depth: 32, keys: 512, string: 65536 } as const;
export function measureProjection(value: unknown): { bytes: number; nodes: number } {
  assertJson(value);
  let nodes = 0;
  const visit = (v: Json, depth: number): void => {
    if (++nodes > TRANSPORT_LIMITS.nodes) throw new Error('TRANSPORT_NODES');
    if (depth > TRANSPORT_LIMITS.depth) throw new Error('TRANSPORT_DEPTH');
    if (typeof v === 'string' && v.length > TRANSPORT_LIMITS.string) throw new Error('TRANSPORT_STRING');
    if (v !== null && typeof v === 'object') {
      const entries = Object.entries(v);
      if (!Array.isArray(v) && entries.length > TRANSPORT_LIMITS.keys) throw new Error('TRANSPORT_KEYS');
      for (const [key, child] of entries) {
        if (key.length > TRANSPORT_LIMITS.string) throw new Error('TRANSPORT_STRING');
        visit(child, depth + 1);
      }
    }
  };
  visit(value as Json, 0);
  const bytes = new TextEncoder().encode(JSON.stringify(value)).byteLength;
  if (bytes > TRANSPORT_LIMITS.bytes) throw new Error('TRANSPORT_BYTES');
  return { bytes, nodes };
}
/** Explicit selection, never a lossy replacement for authoritative state. Default is one root. */
export function projectState(state: VsmState, selection: { unitIds?: Id[]; channelIds?: Id[]; effectIds?: Id[]; alarmIds?: Id[]; findingIds?: Id[] } = {}) {
  const pick = <T>(records: Record<Id, T>, ids: Id[]): Record<Id, T> => Object.fromEntries(ids.map(id => {
    if (!Object.hasOwn(records, id)) throw new Error(`PROJECTION_UNKNOWN:${id}`);
    return [id, structuredClone(records[id])];
  }));
  const value = {
    version: state.version, revision: state.revision, rootId: state.rootId,
    counts: { units: Object.keys(state.units).length, effects: Object.keys(state.effects).length, alarms: Object.keys(state.alarms).length, episodes: Object.keys(state.episodes).length, decisions: state.decisions.length },
    units: pick(state.units, selection.unitIds ?? [state.rootId]), channels: pick(state.channels, selection.channelIds ?? []),
    effects: pick(state.effects, selection.effectIds ?? []), alarms: pick(state.alarms, selection.alarmIds ?? []), findings: pick(state.auditFindings, selection.findingIds ?? []),
  };
  measureProjection(value);
  return value;
}
