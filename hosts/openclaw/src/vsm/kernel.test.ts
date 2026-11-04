import { describe, expect, it } from 'vitest';
import { addUnit, assertJson, configureChannel, connectHomeostat, createState, environment, measureProjection, organ, projectState, validateState } from './kernel.js';
import { step } from './runtime.js';
import type { Actor, Grant, VsmEvent, VsmState } from './types.js';

const principal: Actor = { kind: 'principal', id: 'human' };
const parent: Actor = { kind: 'organ', unitId: 'root', role: 'S3' };
const base = () => createState({ rootId: 'root', principalId: 'human', charter: 'Synthetic obligation', now: 0 });
const fixture = () => addUnit(base(), { id: 'a', parentId: 'root', exits: { delivered: 0, abandoned: 0 } });
const inputChannel = 'a/environment/return';
const procedureId = 'a/seed/operation';
function grant(id = 'g', capacity = 1, unitId = 'a'): Grant {
  return { id, version: 1, unitId, issuer: parent, procedureIds: [`${unitId}/seed/operation`], tools: ['synthetic'], surfaces: [], capacity, validFrom: 0, validUntil: 1_000_000, revokedAt: null };
}
function apply(state: VsmState, event: VsmEvent, now = state.updatedAt + 1) {
  const result = step(state, event, now);
  expect(result.errors, JSON.stringify(result.errors)).toEqual([]);
  return result;
}
function ready(threshold = 2, capacity = 2) {
  let s = configureChannel(fixture(), inputChannel, { procedureId, threshold });
  s = apply(s, { id: 'grant', type: 'grant.changed', actor: parent, grant: grant('g', capacity) }).state;
  return s;
}
const obs = (id: string, amount = 1, channelId = inputChannel): VsmEvent => ({ id, type: 'observation', channelId, index: 1, evidence: amount, topic: 'change', evidenceRef: `trace:${id}` });
function fire(s = ready(1)) {
  const result = apply(s, obs('fire'));
  const dispatch = result.actions.find(a => a.type === 'dispatch');
  expect(dispatch).toBeDefined();
  return { ...result, effectId: dispatch!.effectId };
}

describe('rooted viable-system structure and authority', () => {
  it('constructs one root, recursive organs, required environments and paired interfaces', () => {
    let s = fixture(); s = addUnit(s, { id: 'leaf', parentId: 'a' });
    expect(validateState(s)).toEqual([]);
    expect(Object.values(s.units).filter(u => u.parentId === null)).toHaveLength(1);
    for (const unit of Object.values(s.units)) {
      expect(Object.keys(unit.organs)).toHaveLength(9);
      expect(unit.ownerId).toBe(unit.parentId ?? 'human');
      expect(unit.purpose.valuationOwner).toBe(unit.ownerId);
    }
    for (const h of Object.values(s.homeostats)) expect(h.directions).toHaveLength(2);
    expect(() => addUnit(s, { id: 'other', parentId: null })).toThrow('PARENT_REQUIRED');
  });
  it.each([
    ['ROOT_COUNT', (s: VsmState) => { s.units.a.parentId = null; }],
    ['UNIT_CYCLE', (s: VsmState) => { s.units.a.parentId = 'a'; }],
    ['OWNER_MISMATCH', (s: VsmState) => { s.units.a.ownerId = 'other'; }],
    ['ORGAN_REQUIRED', (s: VsmState) => { delete (s.units.a.organs as Partial<typeof s.units.a.organs>).S5; }],
    ['CHARTER_ROOT_ONLY', (s: VsmState) => { s.charter.unitId = 'a'; }],
    ['HOMEOSTAT_PAIR', (s: VsmState) => { s.channels[inputChannel].to = organ('root', 'S3'); }],
    ['CHANNEL_ENDPOINTS', (s: VsmState) => { s.channels['a/V2/forward'].to = organ('a', 'regulatory-centre'); }],
  ])('rejects %s with precise code', (code, mutate) => {
    const s = fixture(); mutate(s);
    expect(validateState(s).map(e => e.code)).toContain(code);
  });
  it('rejects illegal environment boundaries, non-sibling lateral links and S5 routine command', () => {
    const s = fixture();
    const connect = (kind: 'V2' | 'lateral' | 'environmental', a: ReturnType<typeof organ>, b: ReturnType<typeof organ> | ReturnType<typeof environment>) => () => connectHomeostat(s, {
      id: 'illegal', kind, directions: [{ from: a, to: b, unitId: 'a' }, { from: b, to: a, unitId: 'a' }],
    });
    expect(connect('V2', organ('root', 'S5'), organ('a', 'management'))).toThrow('CHANNEL_ENDPOINTS');
    expect(connect('lateral', organ('root', 'operation'), organ('a', 'operation'))).toThrow('CHANNEL_ENDPOINTS');
    expect(connect('environmental', organ('a', 'S3'), environment('a/env/operational'))).toThrow('CHANNEL_ENDPOINTS');
  });
  it('protects seed procedures, deployment references and the alarm bypass', () => {
    const old = fixture(); const next = structuredClone(old);
    next.procedures[procedureId].executionRef = 'malicious';
    delete next.channels['a/alarm/forward'];
    (next as { kernelRefs: Record<string, string> }).kernelRefs.seed = 'changed';
    expect(validateState(next, old).map(e => e.code)).toContain('KERNEL_IMMUTABLE');
    expect(validateState(next, old).map(e => e.code)).toContain('ALARM_PATH_IMMUTABLE');
  });
  it('rejects self-grants, stale versions and validates revocation history', () => {
    let s = fixture(); const self: Actor = { kind: 'organ', unitId: 'a', role: 'S3' };
    const invalid = { ...grant(), issuer: self };
    expect(step(s, { id: 'self', type: 'grant.changed', actor: self, grant: invalid }, 1).errors[0].code).toBe('GRANT_SELF_ESCALATION');
    s = apply(s, { id: 'g1', type: 'grant.changed', actor: parent, grant: grant() }).state;
    expect(step(s, { id: 'stale', type: 'grant.changed', actor: parent, grant: grant() }, 2).errors[0].code).toBe('GRANT_VERSION');
    s = apply(s, { id: 'revoke', type: 'grant.revoked', actor: parent, grantId: 'g', version: 2 }).state;
    expect(s.grants.g.revokedAt).toBe(2); expect(s.grantHistory[0].version).toBe(1);
    expect(validateState(s)).toEqual([]);
  });
});

describe('seven runtime channel laws', () => {
  it('persists subthreshold evidence across JSON restart without work, then summates to fire', () => {
    const original = ready(3);
    const a = apply(original, obs('a')); expect(a.actions).toEqual([]);
    expect(a.state.channels[inputChannel].accumulator.value).toBe(1);
    const b = apply(JSON.parse(JSON.stringify(a.state)) as VsmState, obs('b'));
    expect(b.actions).toEqual([]);
    const c = apply(b.state, obs('c'));
    expect(c.actions.filter(a => a.type === 'dispatch')).toHaveLength(1);
    expect(original.channels[inputChannel].accumulator.value).toBe(0);
    expect(Object.values(c.state.effects)[0].evidenceRefs).toEqual(['trace:a', 'trace:b', 'trace:c']);
  });
  it('applies elapsed-time decay before a delayed grant opens, not only on observations', () => {
    let s = configureChannel(fixture(), inputChannel, { procedureId, threshold: 2, decayPerMs: 0.1 });
    s = apply(s, obs('waiting', 3), 1).state;
    const r = apply(s, { id: 'late-grant', type: 'grant.changed', actor: parent, grant: grant() }, 21);
    expect(r.actions).toEqual([]);
    expect(r.state.channels[inputChannel].accumulator.value).toBe(1);
    expect(r.decisions.at(-1)).toMatchObject({ evidence: false, environment: true, grant: true });
  });
  it('retains negative CUSUM evidence and optional elapsed-time decay without inferring', () => {
    let s = ready(10);
    s = configureChannel(s, inputChannel, { decayPerMs: 0.1 });
    s = apply(s, obs('x', 4), 2).state;
    s = apply(s, obs('y', -1), 12).state;
    expect(s.channels[inputChannel].accumulator.value).toBe(2);
    const last = apply(s, obs('z', -100), 13);
    expect(last.state.channels[inputChannel].accumulator.value).toBe(0);
    expect(last.actions).toHaveLength(0);
    expect(last.state.channels[inputChannel].accumulator.evidenceRefs).toHaveLength(3);
  });
  it('brake 1: insufficient evidence emits no dispatch despite grant and free environment', () => {
    const r = apply(ready(10), obs('small'));
    expect(r.decisions.at(-1)).toMatchObject({ kind: 'brakes', evidence: false, environment: true, grant: true });
    expect(r.actions).toEqual([]);
  });
  it('brake 2: outcome alone or return alone cannot free in-flight environmental capacity', () => {
    const first = fire();
    let r = apply(first.state, obs('next'));
    expect(r.actions).toEqual([]); expect(r.decisions.at(-1)).toMatchObject({ evidence: true, environment: false });
    r = apply(r.state, { id: 'outcome', type: 'effect.outcome', effectId: first.effectId, value: 1, success: true, evidenceRef: 'result' });
    expect(r.actions).toEqual([]);
    expect(r.state.channels[inputChannel].accumulator.value).toBe(1);
    r = apply(r.state, { id: 'return', type: 'environment.returned', effectId: first.effectId, evidenceRef: 'readback' });
    expect(r.actions.filter(a => a.type === 'dispatch')).toHaveLength(1);
    const other = fire();
    r = apply(other.state, { id: 'return-first', type: 'environment.returned', effectId: other.effectId, evidenceRef: 'env' });
    r = apply(r.state, obs('still-waiting'));
    expect(r.actions).toEqual([]);
  });
  it('brake 3: no grant, insufficient reservation budget, expired and revoked grants retain evidence', () => {
    const s = configureChannel(fixture(), inputChannel, { procedureId, threshold: 1 });
    let r = apply(s, obs('no-grant'));
    expect(r.decisions.at(-1)).toMatchObject({ evidence: true, environment: true, grant: false });
    expect(r.actions).toEqual([]);
    r = apply(r.state, { id: 'grant', type: 'grant.changed', actor: parent, grant: grant('g', 0) });
    expect(r.actions).toEqual([]); expect(r.state.channels[inputChannel].accumulator.value).toBe(1);
    const expiry = apply(ready(1), obs('expired'), 1_000_001);
    expect(expiry.actions).toEqual([]);
    let revoked = apply(ready(1), { id: 'revoke', type: 'grant.revoked', actor: parent, grantId: 'g', version: 2 }).state;
    revoked = apply(revoked, obs('blocked')).state;
    expect(Object.keys(revoked.effects)).toHaveLength(0);
  });
  it('arbitrates sibling lateral loops before vertical management without an event hint', () => {
    let s = addUnit(ready(1), { id: 'b', parentId: 'root' });
    s = connectHomeostat(s, { id: 'siblings', kind: 'lateral', directions: [
      { from: organ('a', 'regulatory-centre'), to: organ('b', 'regulatory-centre'), unitId: 'a', procedureId, threshold: 1 },
      { from: organ('b', 'regulatory-centre'), to: organ('a', 'regulatory-centre'), unitId: 'b' },
    ] });
    s = configureChannel(s, 'a/V2/return', { procedureId, threshold: 1 });
    const r = apply(s, obs('disturbance', 1, 'a/V2/return'));
    expect(r.actions.filter(a => a.type === 'dispatch')).toHaveLength(1);
    expect(Object.values(r.state.effects)[0].channelId).toBe('siblings/forward');
    expect(r.state.channels['a/V2/return'].accumulator.observations).toBe(0);
    expect(r.decisions.some(d => d.kind === 'lateral')).toBe(true);
  });
  it('falls back vertically when a sibling cannot absorb', () => {
    let s = addUnit(ready(1), { id: 'b', parentId: 'root' });
    s = connectHomeostat(s, { id: 'siblings', kind: 'V3', directions: [
      { from: organ('a', 'operation'), to: organ('b', 'operation'), unitId: 'a', procedureId, threshold: 10 },
      { from: organ('b', 'operation'), to: organ('a', 'operation'), unitId: 'b' },
    ] });
    const r = apply(s, obs('not-absorbed'));
    expect(Object.values(r.state.effects)[0].channelId).toBe(inputChannel);
    expect(r.state.channels['siblings/forward'].accumulator.value).toBe(1);
  });
  it('normal filters suppress ordinary observations, not direct alarms from depth', () => {
    let s = addUnit(ready(1), { id: 'leaf', parentId: 'a' });
    s = configureChannel(s, inputChannel, { filter: { minIndex: 100, topics: ['different'] } });
    const filtered = apply(s, obs('normal', 100));
    expect(filtered.actions).toEqual([]); expect(filtered.decisions[0].kind).toBe('filtered');
    const alarm = apply(filtered.state, { id: 'alarm', type: 'alarm.raised', alarmId: 'danger', unitId: 'leaf', alarmClass: 'hazard', severity: 5, localThreshold: 3, falseAlarmCost: 1, delayCost: 1, evidenceRef: 'independent' });
    expect(alarm.actions).toContainEqual({ type: 'alarm', alarmId: 'danger', rootS5: 'root/S5', principalId: 'human', wakeClass: 'alarm' });
    expect(alarm.state.alarms.danger.route).toEqual(['leaf/S5', 'root/S5', 'human']);
    const acknowledged = apply(alarm.state, { id: 'ack', type: 'alarm.acknowledged', actor: principal, alarmId: 'danger' });
    expect(acknowledged.state.alarms.danger.state).toBe('acknowledged');
  });
  it('records gain/price modulation, requires evidence and distinguishes slow wake class', () => {
    let s = ready(3); s = apply(s, obs('one')).state;
    const expensive = apply(s, { id: 'price', type: 'ambient.changed', actor: parent, gain: 0, price: 4 });
    expect(expensive.actions).toEqual([]);
    const crisis = apply(expensive.state, { id: 'gain', type: 'ambient.changed', actor: parent, gain: 6, price: 4 });
    expect(crisis.actions.filter(a => a.type === 'dispatch')).toHaveLength(1);
    expect(crisis.decisions.find(d => d.kind === 'modulation')?.wakeClass).toBe('slow-deliberative');
    expect(crisis.actions[0]).toMatchObject({ wakeClass: 'fast-code' });
    const empty = apply(ready(3), { id: 'empty', type: 'ambient.changed', actor: parent, gain: 100, price: 0 });
    expect(empty.actions).toEqual([]);
    let slow = configureChannel(fixture(), 'a/adapt/forward', { procedureId: 'a/seed/S4', threshold: 1 });
    slow = apply(slow, { id: 'g', type: 'grant.changed', actor: parent, grant: { ...grant(), procedureIds: ['a/seed/S4'] } }).state;
    expect(apply(slow, obs('slow', 1, 'a/adapt/forward')).actions[0]).toMatchObject({ wakeClass: 'slow-deliberative' });
  });
});

describe('purpose, audit and durable memory', () => {
  it('converges by bounded parent-owned valuation of every exit, not self-evaluation', () => {
    let s = fixture();
    const values = { delivered: 2.5, abandoned: -1 };
    const wrong = step(s, { id: 'self', type: 'purpose.feedback', actor: { kind: 'organ', unitId: 'a', role: 'S3' }, unitId: 'a', values, evidenceRef: 'trace' }, 1);
    expect(wrong.errors[0].code).toBe('PURPOSE_AUTHORITY');
    for (let i = 0; i < 3; i++) s = apply(s, { id: `valuation-${i}`, type: 'purpose.feedback', actor: parent, unitId: 'a', values, evidenceRef: `global:${i}` }).state;
    expect(s.units.a.purpose).toMatchObject({ converged: true, convergenceSteps: 3 });
    expect(s.units.a.purpose.exits.delivered.declared).toBe(2.5);
    expect(s.units.a.purpose.exits.abandoned.declared).toBe(-1);
    expect(step(s, { id: 'partial', type: 'purpose.feedback', actor: parent, unitId: 'a', values: { delivered: 9 }, evidenceRef: 'partial' }, 4).errors[0].code).toBe('PURPOSE_EXITS');
  });
  it('derives residual audit with causal references and does not duplicate findings', () => {
    const first = fire();
    const mismatch: VsmEvent = { id: 'mismatch', type: 'effect.outcome', effectId: first.effectId, value: 0, success: false, evidenceRef: 'actual' };
    let r = apply(first.state, mismatch);
    expect(r.actions).toContainEqual(expect.objectContaining({ type: 'audit', organId: 'root/S3*' }));
    expect(Object.values(r.state.auditFindings)[0]).toMatchObject({ kind: 'outcome-residual', residual: 1, attribution: [{ componentId: procedureId, credit: 0, blame: 1 }] });
    expect(Object.values(r.state.auditFindings)[0].evidenceRefs).toEqual(['trace:fire', 'actual']);
    r = apply(r.state, { ...mismatch, id: 'duplicate-native-delivery' });
    expect(r.actions).toEqual([]); expect(Object.keys(r.state.auditFindings)).toHaveLength(1);
    r = apply(r.state, { ...mismatch, id: 'conflict', value: 2 });
    expect(Object.values(r.state.auditFindings).some(f => f.kind === 'conflicting-outcome')).toBe(true);
  });
  it('audits missing environment returns at a deadline and retains reserved cost after failed outcome', () => {
    const f = fire(ready(1, 1));
    let r = apply(f.state, { id: 'failure', type: 'effect.outcome', effectId: f.effectId, value: 0, success: false, evidenceRef: 'failed' });
    r = apply(r.state, { id: 'deadline', type: 'audit.inspect', effectId: f.effectId }, 100_000);
    expect(Object.values(r.state.auditFindings).some(a => a.kind === 'missing-return')).toBe(true);
    // Same grant budget on another channel is still occupied pending environmental accounting.
    const s = configureChannel(r.state, 'a/local/forward', { procedureId, threshold: 1 });
    const other = apply(s, obs('budget-occupied', 1, 'a/local/forward'));
    expect(other.actions).toEqual([]);
    expect(other.decisions.at(-1)?.grant).toBe(false);
  });
  it('recovers unacknowledged alarms after commit/delivery crashes, never re-emits acknowledged alarms', () => {
    const raised = apply(fixture(), { id: 'raised', type: 'alarm.raised', alarmId: 'recoverable', unitId: 'a', alarmClass: 'risk', severity: 9, localThreshold: 1, falseAlarmCost: 1, delayCost: 1, evidenceRef: 'trace' });
    const restart = apply(JSON.parse(JSON.stringify(raised.state)) as VsmState, { id: 'restart', type: 'restart' });
    expect(restart.actions).toEqual([{ type: 'alarm', alarmId: 'recoverable', rootS5: 'root/S5', principalId: 'human', wakeClass: 'alarm' }]);
    const ack = apply(restart.state, { id: 'ack', type: 'alarm.acknowledged', actor: principal, alarmId: 'recoverable' });
    expect(apply(ack.state, { id: 'restart2', type: 'restart' }).actions).toEqual([]);
  });
  it('tracks repeated alarm classes, cost-derived severity and acknowledgment separately', () => {
    let s = fixture();
    for (let i = 0; i < 3; i++) {
      const r = apply(s, { id: `alarm-${i}`, type: 'alarm.raised', alarmId: `hazard-${i}`, unitId: 'a', alarmClass: 'recurring', severity: 1, localThreshold: 3, falseAlarmCost: 1, delayCost: Math.exp(3), evidenceRef: 'signal' });
      s = r.state;
      if (i === 2) expect(r.actions).toContainEqual({ type: 'improve-alarm-class', alarmClass: 'recurring', organId: 'root/S4', wakeClass: 'slow-deliberative' });
    }
    expect(s.alarmClasses.recurring).toMatchObject({ count: 3, improvementDue: true });
    const sub = apply(s, { id: 'quiet', type: 'alarm.raised', alarmId: 'quiet', unitId: 'a', alarmClass: 'quiet', severity: 0, localThreshold: 10, falseAlarmCost: 1, delayCost: 1, evidenceRef: 'quiet-ref' });
    expect(sub.actions).toEqual([]); expect(sub.state.alarms.quiet.state).toBe('recorded');
  });
  it('appends bitemporal references and semantic facts without overwriting history', () => {
    let s = fixture();
    s = apply(s, { id: 'episode', type: 'episode.recorded', episode: { id: 'ep', unitId: 'a', organ: 'operation', traceRef: 'protected:trace/1', validAt: 0, recordedAt: 1, cost: 1 } }).state;
    s = apply(s, { id: 'fact', type: 'fact.recorded', actor: { kind: 'organ', unitId: 'a', role: 'S4' }, fact: { id: 'world1', unitId: 'a', kind: 'world', value: { index: 1 }, validFrom: 0, validUntil: null, recordedAt: 2, supersedes: null, evidenceRefs: ['ep'] } }).state;
    expect(s.episodes.ep.traceRef).toBe('protected:trace/1');
    expect(s.facts.world1.value).toEqual({ index: 1 });
    const repeated = step(s, { id: 'new-source', type: 'episode.recorded', episode: s.episodes.ep }, 3);
    expect(repeated.errors[0].code).toBe('EPISODE_IMMUTABLE');
  });
});

describe('transport and replay boundaries', () => {
  it('dedupes source replay, returns original state on failure and rejects unsafe JSON', () => {
    const s = ready(3); const e = obs('once'); const a = apply(s, e);
    expect(step(a.state, e, 20)).toEqual({ state: a.state, errors: [], actions: [], decisions: [] });
    const invalid = step(s, obs('nan', Number.NaN), 2);
    expect(invalid.state).toBe(s); expect(invalid.errors[0].code).toBe('EVENT_NOT_JSON');
    expect(() => assertJson(new Date())).toThrow('Non-plain');
    expect(() => assertJson({ value: undefined })).toThrow('Non-JSON');
    expect(() => assertJson(Array(5000))).toThrow('Non-dense');
  });
  it('projects explicit bounded pages without constraining durable history', () => {
    let s = fixture();
    for (let i = 0; i < 10; i++) s = addUnit(s, { id: `child${i}`, parentId: i === 0 ? 'root' : `child${i - 1}` });
    for (let i = 0; i < 100; i++) s = apply(s, { id: `datum${i}`, type: 'observation', channelId: inputChannel, index: 1, evidence: 0.001, topic: 'synthetic', evidenceRef: `episode${i}` }).state;
    expect(validateState(JSON.parse(JSON.stringify(s)) as VsmState)).toEqual([]);
    const projection = projectState(s, { unitIds: ['root', 'a'], channelIds: [inputChannel] });
    const size = measureProjection(projection);
    expect(size.nodes).toBeLessThanOrEqual(4096); expect(size.bytes).toBeLessThanOrEqual(262144);
    expect(projection.counts).toMatchObject({ units: 12, decisions: 100 });
    expect(() => projectState(s, { unitIds: Object.keys(s.units), channelIds: Object.keys(s.channels) })).toThrow('TRANSPORT_NODES');
    expect(s.channels[inputChannel].accumulator.evidenceRefs).toHaveLength(100);
  });
  it('bounds strings, object keys, depth, total nodes and encoded bytes', () => {
    expect(() => measureProjection('x'.repeat(65537))).toThrow('TRANSPORT_STRING');
    expect(() => measureProjection(Object.fromEntries(Array.from({ length: 513 }, (_, i) => [i, i])))).toThrow('TRANSPORT_KEYS');
    expect(() => measureProjection(Array(4096).fill(1))).toThrow('TRANSPORT_NODES');
    expect(() => measureProjection(Array(8).fill('x'.repeat(40000)))).toThrow('TRANSPORT_BYTES');
    let deep: unknown = 1; for (let i = 0; i < 34; i++) deep = [deep];
    expect(() => measureProjection(deep)).toThrow('TRANSPORT_DEPTH');
  });
});
