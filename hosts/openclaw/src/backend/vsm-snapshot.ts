import type { Static } from 'typebox';
import type { VsmSnapshotSchema } from '../contract.js';
import type { VsmState } from '../vsm/types.js';

export type VsmSnapshot = Static<typeof VsmSnapshotSchema>;

/** Stable empty projection; a disabled runtime is not an error. */
export function emptyVsmSnapshot(): VsmSnapshot {
  return {
    runtime: 'disabled', revision: 0, updatedAt: 0,
    purposes: [], channels: [], effects: [], alarms: [], grants: [],
  };
}

const LIMITS = { purposes: 64, channels: 128, effects: 128, alarms: 64, grants: 64 } as const;

/**
 * Read-only, bounded projection. It never mutates state, never includes private
 * intent text and never invents a status that the durable record does not hold.
 */
export function projectVsmSnapshot(state: VsmState): VsmSnapshot {
  const purposes = Object.values(state.units)
    .sort((a, b) => a.id.localeCompare(b.id))
    .slice(0, LIMITS.purposes)
    .map(unit => ({
      unitId: unit.id,
      description: unit.purpose.description,
      converged: unit.purpose.converged,
      revision: unit.purpose.revision,
      exits: Object.entries(unit.purpose.exits)
        .sort(([a], [b]) => a.localeCompare(b))
        .slice(0, 8)
        .map(([id, value]) => ({ id, declared: value.declared, imputed: value.imputed, error: value.error })),
    }));
  const channels = Object.values(state.channels)
    .sort((a, b) => a.id.localeCompare(b.id))
    .slice(0, LIMITS.channels)
    .map(channel => ({
      id: channel.id, kind: channel.kind, unitId: channel.unitId,
      ...(channel.procedureId === null ? {} : { procedureId: channel.procedureId }),
      value: channel.accumulator.value, observations: channel.accumulator.observations,
      filtered: channel.accumulator.filtered, phase: channel.pending.phase, wakeClass: channel.wakeClass,
    }));
  const effects = Object.values(state.effects)
    .sort((a, b) => b.sequence - a.sequence || a.id.localeCompare(b.id))
    .slice(0, LIMITS.effects)
    .map(effect => ({
      id: effect.id, unitId: effect.unitId, procedureId: effect.procedureId, status: effect.status,
      sequence: effect.sequence, attempts: effect.dispatchAttempts,
      ...(effect.receipt === null ? {} : { nativeId: effect.receipt.nativeId }),
      ...(effect.outcome === null ? {} : { outcomeValue: effect.outcome.value }),
      ...(effect.environmentReturn === null ? {} : { environmentRef: effect.environmentReturn.evidenceRef }),
      at: effect.intentAt,
    }));
  const alarms = Object.values(state.alarms)
    .sort((a, b) => (b.raisedAt ?? 0) - (a.raisedAt ?? 0) || a.id.localeCompare(b.id))
    .slice(0, LIMITS.alarms)
    .map(alarm => ({
      id: alarm.id, unitId: alarm.unitId, alarmClass: alarm.class, severity: alarm.severity,
      state: alarm.state, ...(alarm.raisedAt === null ? {} : { raisedAt: alarm.raisedAt }),
    }));
  const grants = Object.values(state.grants)
    .sort((a, b) => a.id.localeCompare(b.id))
    .slice(0, LIMITS.grants)
    .map(grant => ({
      id: grant.id, unitId: grant.unitId, version: grant.version, capacity: grant.capacity,
      validUntil: grant.validUntil, ...(grant.revokedAt === null ? {} : { revokedAt: grant.revokedAt }),
    }));
  return {
    runtime: 'running', revision: state.revision, updatedAt: state.updatedAt,
    principalId: state.principalId, purposes, channels, effects, alarms, grants,
  };
}
