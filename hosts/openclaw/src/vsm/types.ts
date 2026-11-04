/** Persisted records contain data only. Opaque references never contain trace bodies. */
export type Id = string;
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export const ORGAN_ROLES = ['operation', 'management', 'regulatory-centre', 'S1', 'S2', 'S3', 'S3*', 'S4', 'S5'] as const;
export type OrganRole = typeof ORGAN_ROLES[number];
export type Actor = { kind: 'principal'; id: Id } | { kind: 'organ'; unitId: Id; role: OrganRole };
export interface Organ { id: Id; unitId: Id; role: OrganRole; procedureIds: Id[] }
export interface ExitValue { declared: number; imputed: number; error: number }
export interface Purpose {
  description: string;
  valuationOwner: Id;
  exits: Record<Id, ExitValue>;
  revision: number;
  convergenceSteps: number;
  maxUpdate: number;
  tolerance: number;
  converged: boolean;
  evidenceRefs: Id[];
}
export interface VsmUnit {
  id: Id;
  parentId: Id | null;
  ownerId: Id;
  organs: Record<OrganRole, Organ>;
  environmentIds: { operational: Id; total: Id; future: Id };
  purpose: Purpose;
}
export interface Environment { id: Id; unitId: Id; kind: 'operational' | 'total' | 'future'; reference: string }
export type Endpoint = { kind: 'organ'; unitId: Id; role: OrganRole } | { kind: 'environment'; environmentId: Id };
export type ChannelKind = 'V1' | 'V2' | 'V3' | 'V4' | 'V5' | 'V6' | 'metasystemic' | 'lateral' | 'algedonic' | 'environmental' | 'local';
export type WakeClass = 'fast-code' | 'slow-deliberative' | 'alarm';
export interface EvidenceAccumulator {
  value: number;
  updatedAt: number;
  observations: number;
  filtered: number;
  evidenceRefs: Id[];
}
export interface Channel {
  id: Id;
  homeostatId: Id;
  kind: ChannelKind;
  from: Endpoint;
  to: Endpoint;
  unitId: Id;
  capacity: number;
  delayMs: number;
  gain: number;
  threshold: number;
  decayPerMs: number;
  transducerRef: string;
  filter: { minIndex: number; topics: string[] };
  procedureId: Id | null;
  cost: number;
  wakeClass: WakeClass;
  accumulator: EvidenceAccumulator;
  pending: { phase: 'parked' | 'evidence' | 'waiting-environment' | 'waiting-grant' | 'reserved'; lastEffectId: Id | null; sequence: number };
}
export interface Homeostat { id: Id; directions: [Id, Id]; cycleMs: number }
export interface Procedure {
  id: Id;
  unitId: Id;
  organ: OrganRole;
  version: number;
  kind: 'code' | 'decision' | 'model' | 'tool' | 'nested' | 'approval';
  executionRef: string;
  kernel: boolean;
  expectedOutcome: number;
  returnTimeoutMs: number;
  requiredTools: string[];
  requiredSurfaces: string[];
}
export interface Grant {
  id: Id;
  version: number;
  unitId: Id;
  issuer: Actor;
  procedureIds: Id[];
  tools: string[];
  surfaces: string[];
  capacity: number;
  validFrom: number;
  validUntil: number;
  revokedAt: number | null;
}
export interface EffectOutcome { value: number; evidenceRef: Id; at: number }
export type EffectStatus = 'intent' | 'reserved' | 'accepted' | 'ambiguous' | 'lost' | 'succeeded' | 'failed' | 'cancelled';
export interface Effect {
  id: Id;
  channelId: Id;
  unitId: Id;
  procedureId: Id;
  sequence: number;
  status: EffectStatus;
  intentAt: number;
  reservedAt: number | null;
  grantId: Id | null;
  grantVersion: number | null;
  cost: number;
  expectedOutcome: number;
  returnDueAt: number;
  receipt: { nativeId: string; acceptedAt: number } | null;
  outcome: EffectOutcome | null;
  environmentReturn: { evidenceRef: Id; at: number } | null;
  evidenceRefs: Id[];
  dispatchAttempts: number;
  evidenceAtAdmission: number;
  thresholdAtAdmission: number;
  reservations: { attempt: number; at: number; grantId: Id; grantVersion: number; cost: number }[];
}
export interface Alarm {
  id: Id;
  unitId: Id;
  class: string;
  severity: number;
  threshold: number;
  evidenceRefs: Id[];
  route: Id[];
  state: 'recorded' | 'raised' | 'acknowledged';
  raisedAt: number | null;
  acknowledgedAt: number | null;
  acknowledgedBy: Actor | null;
}
export interface AuditFinding {
  id: Id;
  unitId: Id;
  effectId: Id | null;
  kind: 'outcome-residual' | 'missing-return' | 'conflicting-outcome' | 'inspection';
  residual: number;
  evidenceRefs: Id[];
  at: number;
  attribution: { componentId: Id; credit: number; blame: number }[];
}
export interface EpisodeReference {
  id: Id;
  unitId: Id;
  organ: OrganRole;
  traceRef: string;
  validAt: number;
  recordedAt: number;
  cost: number;
}
export interface SemanticFact {
  id: Id;
  unitId: Id;
  kind: 'world' | 'self' | 'resource' | 'coordination' | 'identity';
  value: Json;
  validFrom: number;
  validUntil: number | null;
  recordedAt: number;
  supersedes: Id | null;
  evidenceRefs: Id[];
}
export interface Decision {
  eventId: Id;
  at: number;
  channelId: Id | null;
  kind: 'filtered' | 'brakes' | 'lateral' | 'modulation' | 'wake' | 'purpose' | 'reconcile' | 'alarm';
  wakeClass: WakeClass;
  detail: string;
  evidence: boolean;
  environment: boolean;
  grant: boolean;
}
export interface VsmState {
  version: 1;
  revision: number;
  updatedAt: number;
  principalId: Id;
  rootId: Id;
  readonly kernelRefs: Readonly<Record<string, string>>;
  charter: { unitId: Id; version: number; text: string; ratifiedBy: Id };
  units: Record<Id, VsmUnit>;
  environments: Record<Id, Environment>;
  procedures: Record<Id, Procedure>;
  channels: Record<Id, Channel>;
  homeostats: Record<Id, Homeostat>;
  grants: Record<Id, Grant>;
  grantHistory: Grant[];
  effects: Record<Id, Effect>;
  alarms: Record<Id, Alarm>;
  alarmClasses: Record<string, { count: number; lastAt: number; improvementDue: boolean }>;
  auditFindings: Record<Id, AuditFinding>;
  episodes: Record<Id, EpisodeReference>;
  facts: Record<Id, SemanticFact>;
  ambient: { gain: number; price: number; version: number };
  decisions: Decision[];
  seenEvents: Record<Id, number>;
}
export type VsmEvent = { id: Id } & (
  | { type: 'observation'; channelId: Id; index: number; evidence: number; topic: string; evidenceRef: Id; lateralChannelIds?: Id[] }
  | { type: 'ambient.changed'; actor: Actor; gain: number; price: number }
  | { type: 'grant.changed'; actor: Actor; grant: Grant }
  | { type: 'grant.revoked'; actor: Actor; grantId: Id; version: number }
  | { type: 'effect.admit'; effectId: Id }
  | { type: 'effect.accepted'; effectId: Id; nativeId: string }
  | { type: 'effect.ambiguous'; effectId: Id }
  | { type: 'effect.outcome'; effectId: Id; value: number; evidenceRef: Id; success: boolean }
  | { type: 'environment.returned'; effectId: Id; evidenceRef: Id }
  | { type: 'effect.reconciled'; effectId: Id; result: 'not-launched' | 'unknown' | 'accepted'; nativeId?: string }
  | { type: 'restart' }
  | { type: 'alarm.raised'; alarmId: Id; unitId: Id; alarmClass: string; severity: number; localThreshold: number; falseAlarmCost: number; delayCost: number; evidenceRef: Id }
  | { type: 'alarm.acknowledged'; actor: Actor; alarmId: Id }
  | { type: 'purpose.feedback'; actor: Actor; unitId: Id; values: Record<Id, number>; evidenceRef: Id }
  | { type: 'audit.inspect'; effectId: Id }
  | { type: 'audit.finding'; actor: Actor; finding: AuditFinding }
  | { type: 'episode.recorded'; episode: EpisodeReference }
  | { type: 'fact.recorded'; actor: Actor; fact: SemanticFact }
);
export interface DispatchAction { type: 'dispatch'; effectId: Id; procedureId: Id; grantId: Id; grantVersion: number; wakeClass: WakeClass }
export type VsmAction = DispatchAction
  | { type: 'reconcile'; effectId: Id }
  | { type: 'alarm'; alarmId: Id; rootS5: Id; principalId: Id; wakeClass: 'alarm' }
  | { type: 'audit'; findingId: Id; organId: Id; wakeClass: 'slow-deliberative' }
  | { type: 'improve-alarm-class'; alarmClass: string; organId: Id; wakeClass: 'slow-deliberative' };
export interface ValidationError { code: string; path: string; message: string }
export interface StepResult { state: VsmState; actions: VsmAction[]; decisions: Decision[]; errors: ValidationError[] }
