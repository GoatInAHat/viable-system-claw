import { describe, expect, it } from 'vitest';
import type { Activity, GraphSnapshot, Unit } from '../model.js';
import { ACTIVE_MS, RECENT_MS, STALE_MS, activityState, fitViewport, graphHealth, layoutGraph, zoomAt } from './graph-state.js';

// Explicit deterministic replay fixtures; these are never imported by production code.
const unit = (id: string, parentId?: string): Unit => ({ id, parentId, name: `REPLAY ${id}`, purpose: 'Interaction test replay', status: 'idle', updatedAt: 1000 });
const graph = (units: Unit[]): GraphSnapshot => ({ units, activeRuns: [], relations: [], activities: [], revision: 1, observedAt: 1000, coverage: 'partial' });
const event = (id: string, kind: Activity['kind'], at: number, extra: Partial<Activity> = {}): Activity => ({ id, unitId: 'root', kind, at, runId: 'run-1', ...extra });

describe('compound organization layout', () => {
  it('lays out true containment and projects links when a branch is collapsed', () => {
    const snapshot = graph([unit('root'), unit('child', 'root'), unit('grandchild', 'child'), unit('peer')]);
    snapshot.relations = [{ id: 'relation', source: 'grandchild', target: 'peer', kind: 'communication', label: 'handoff' }];
    const expanded = layoutGraph(snapshot, new Set());
    const root = expanded.nodes.find(node => node.unit.id === 'root')!;
    const child = expanded.nodes.find(node => node.unit.id === 'child')!;
    expect(child.x).toBeGreaterThan(root.x);
    expect(child.x + child.width).toBeLessThan(root.x + root.width);
    expect(child.y + child.height).toBeLessThan(root.y + root.height);
    const collapsed = layoutGraph(snapshot, new Set(['root']));
    expect(collapsed.nodes.map(node => node.unit.id)).not.toContain('grandchild');
    expect(collapsed.edges[0]).toMatchObject({ source: 'root', target: 'peer', label: 'handoff' });
    expect(collapsed.nodes.find(node => node.unit.id === 'root')?.descendants).toBe(2);
  });
  it('does not overlap sibling frames and has stable order across snapshots', () => {
    const units = [unit('root'), ...Array.from({ length: 9 }, (_, i) => unit(`child${i}`, 'root'))];
    const result = layoutGraph(graph(units), new Set());
    const siblings = result.nodes.filter(node => node.unit.parentId === 'root');
    for (const [i, a] of siblings.entries()) for (const b of siblings.slice(i + 1)) {
      expect(a.x + a.width <= b.x || b.x + b.width <= a.x || a.y + a.height <= b.y || b.y + b.height <= a.y).toBe(true);
    }
    expect(layoutGraph(graph([...units].reverse()), new Set()).nodes).toEqual(result.nodes);
  });
  it('makes malformed cycles/orphans explicit and still renders every system', () => {
    const result = layoutGraph(graph([unit('a', 'b'), unit('b', 'a'), unit('orphan', 'missing')]), new Set());
    expect(result.nodes).toHaveLength(3);
    expect(result.warnings).toHaveLength(3);
    expect(result.nodes.every(node => Number.isFinite(node.width))).toBe(true);
  });
});

describe('metadata activity lifecycle', () => {
  it('correlates tool/run starts and ends and ignores unit status as an activity source', () => {
    const starts = [event('run', 'run-start', 1000), event('tool', 'tool-start', 1050, { toolCallId: 'call-1' })];
    expect(activityState(starts, 1100)).toMatchObject({ runs: [starts[0]], tools: [starts[1]] });
    const ended = [...starts, event('end', 'tool-end', 1060, { toolCallId: 'call-1' })];
    expect(activityState(ended, 1100).tools).toEqual([]);
    expect(activityState([...starts, event('run-end', 'run-end', 1100)], 1100)).toMatchObject({ runs: [], tools: [] });
  });
  it('never pairs activity from another system or another run', () => {
    const events = [event('tool', 'tool-start', 1000, { toolCallId: 'same' }), event('wrong-unit', 'tool-end', 1100, { toolCallId: 'same', unitId: 'other' }), event('wrong-run', 'tool-end', 1100, { toolCallId: 'same', runId: 'run-2' })];
    expect(activityState(events, 1200).tools).toHaveLength(1);
  });
  it('expires unclosed activity and short message pulses without an eternal timer', () => {
    const start = event('run', 'run-start', 1000);
    expect(activityState([start], 1000 + ACTIVE_MS)).toMatchObject({ runs: [], expired: [start], recent: [] });
    expect(activityState([event('message', 'message', 1000)], 1000 + RECENT_MS).recent).toEqual([]);
    expect(activityState([event('future', 'run-start', 50_000)], 1000).runs).toEqual([]);
  });
  it('orders out-of-order replay and gives same-time ends precedence', () => {
    expect(activityState([event('end', 'run-end', 1000), event('start', 'run-start', 1000)], 1100).runs).toEqual([]);
    expect(activityState([event('end', 'run-end', 1100), event('start', 'run-start', 1000)], 1200).runs).toEqual([]);
  });
});

describe('viewport and observation health', () => {
  it('keeps the cursor world position fixed during zoom and clamps scale', () => {
    const before = { x: 25, y: -40, scale: .5 };
    const after = zoomAt(before, 2, 100, 200);
    expect((100 - after.x) / after.scale).toBe((100 - before.x) / before.scale);
    expect((200 - after.y) / after.scale).toBe((200 - before.y) / before.scale);
    expect(zoomAt(before, 100, 0, 0).scale).toBe(3);
    expect(fitViewport(800, 500, { width: 1000, height: 800 }).scale).toBeLessThan(1);
  });
  it('distinguishes partial, disconnected, loading and stale', () => {
    expect(graphHealth(undefined, true, 1000)).toBe('loading');
    expect(graphHealth(graph([]), true, 1000)).toBe('partial');
    expect(graphHealth(graph([]), false, 1000)).toBe('disconnected');
    expect(graphHealth(graph([]), true, 1001 + STALE_MS)).toBe('stale');
  });
});
