import { describe, expect, it } from 'vitest';
import { emptyVsmSnapshot, projectVsmSnapshot } from './vsm-snapshot.js';
import { addUnit, configureChannel, createState } from '../vsm/kernel.js';
import { step } from '../vsm/runtime.js';

const base = () => addUnit(createState({ rootId: 'root', principalId: 'human', charter: 'Keep it observable', now: 0 }),
  { id: 'canary', parentId: 'root', purpose: 'Keep the host observable', exits: { observed: 1 } });

describe('VSM runtime snapshot', () => {
  it('reports a disabled runtime without inventing state', () => {
    expect(emptyVsmSnapshot()).toEqual({
      runtime: 'disabled', revision: 0, updatedAt: 0,
      purposes: [], channels: [], effects: [], alarms: [], grants: [],
    });
  });

  it('projects purposes, channels and grants without private fields', () => {
    let state = configureChannel(base(), 'canary/environment/return', { threshold: 2 });
    const result = step(state, {
      id: 'grant', type: 'grant.changed', actor: { kind: 'organ', unitId: 'root', role: 'S3' },
      grant: { id: 'g', version: 1, unitId: 'canary', issuer: { kind: 'organ', unitId: 'root', role: 'S3' },
        procedureIds: ['canary/seed/operation'], tools: [], surfaces: [], capacity: 2, validFrom: 0, validUntil: 1_000_000, revokedAt: null },
    }, 1);
    expect(result.errors).toEqual([]);
    state = result.state;
    const snapshot = projectVsmSnapshot(state);
    expect(snapshot.runtime).toBe('running');
    expect(snapshot.principalId).toBe('human');
    expect(snapshot.purposes.map(p => p.unitId).sort()).toEqual(['canary', 'root']);
    expect(snapshot.channels.some(c => c.id === 'canary/environment/return')).toBe(true);
    expect(snapshot.grants).toEqual([{ id: 'g', unitId: 'canary', version: 1, capacity: 2, validUntil: 1_000_000 }]);
    expect(JSON.stringify(snapshot)).not.toContain('message');
  });

  it('caps a large runtime projection while keeping the newest effects', () => {
    let state = base();
    for (let i = 0; i < 200; i++) {
      state = configureChannel(state, 'canary/environment/return', { threshold: i + 1 });
      state.revision++;
    }
    const snapshot = projectVsmSnapshot(state);
    expect(snapshot.channels.length).toBeLessThanOrEqual(128);
  });
});
