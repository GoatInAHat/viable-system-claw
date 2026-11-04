import type { ComputeSnapshot, GraphSnapshot } from '../model.js';
import type { Document } from './store.js';

export function projectGraph(document: Document, state: { started: boolean; liveSince: number; now: number; currentRuns: ReadonlySet<string> }): GraphSnapshot {
  const activeRuns = state.started ? document.runs.filter(run => run.phase === 'running' && state.currentRuns.has(run.id)).map(({ id, unitId }) => ({ id, unitId })) : [];
  const units = document.units.map(unit => ({ ...unit, status: activeRuns.some(run => run.unitId === unit.id)
    ? 'running' as const : unit.status === 'running' ? 'unknown' as const : unit.status }));
  return { liveSince: state.liveSince, activeRuns, revision: document.revision, observedAt: state.now, units,
    relations: document.relations, activities: document.activities, coverage: state.started ? 'partial' : 'disconnected' };
}

export function projectCompute(document: Document, live: boolean): ComputeSnapshot {
  const snapshot = document.compute;
  if (live) return snapshot;
  return { ...snapshot, pools: snapshot.pools.map(pool => ({ ...pool, status: 'unknown' })),
    allocations: snapshot.allocations.map(allocation => allocation.status === 'running' || allocation.status === 'admitted'
      ? { ...allocation, status: 'blocked', reason: 'Retained observation; live allocation state is unverified after service restart.' } : allocation) };
}
