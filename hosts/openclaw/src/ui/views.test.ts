// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ControlUiHost, ControlUiViewContext } from 'openclaw/plugin-sdk/control-ui';
import type { ComputeSnapshot, GraphSnapshot } from '../model.js';
import { graphView } from './graph.js';
import { computeView } from './compute.js';
import type { UiClient } from './shared.js';
import { ACTIVE_MS, STALE_MS } from './graph-state.js';

// REPLAY fixture: only tests publish these synthetic observations.
const now = 1_700_000_000_000;
function replay(): GraphSnapshot {
  return {
    revision: 1, observedAt: now, coverage: 'partial', activeRuns: [],
    units: [
      { id: 'root', name: 'REPLAY organization', purpose: 'Containment interaction replay', status: 'running', updatedAt: now },
      { id: 'child', parentId: 'root', name: 'REPLAY worker', purpose: 'Bound conversation', status: 'idle', updatedAt: now, session: { agentId: 'replay-agent', sessionKey: 'replay-session' } },
      { id: 'peer', name: 'REPLAY peer', purpose: 'Relation endpoint', status: 'unknown', updatedAt: now },
    ],
    relations: [{ id: 'r1', source: 'child', target: 'peer', kind: 'communication', label: 'Handoff' }],
    activities: [],
  };
}
function harness() {
  const controller = new AbortController();
  let listener: (() => void) | undefined;
  let graphChange: ((value: GraphSnapshot) => void) | undefined;
  let computeChange: ((value: ComputeSnapshot) => void) | undefined;
  let onError: ((error: Error) => void) | undefined;
  const unwatch = vi.fn();
  const unsubscribe = vi.fn();
  const host = {
    signal: controller.signal, pluginId: 'viable-system-claw',
    connection: { connected: true, canWrite: true, canRead: true },
    redact: (value: string) => value.replace('SECRET', '[redacted]'),
    subscribe: vi.fn((fn: () => void) => { listener = fn; return unsubscribe; }),
    sessions: { open: vi.fn() },
    navigation: { pageHref: vi.fn(() => '/plugin/organization?unit=root'), openPage: vi.fn() },
    dock: { openSession: vi.fn() },
  } as unknown as ControlUiHost;
  const watch = vi.fn((operation: string, _input: unknown, options: { onChange: (value: GraphSnapshot | ComputeSnapshot) => void; onError: (error: Error) => void }) => {
    if (operation === 'graph.snapshot') graphChange = options.onChange;
    else computeChange = options.onChange;
    onError = options.onError;
    return unwatch;
  });
  const invoke = vi.fn(async () => ({ ...replay(), revision: 2 }));
  const client = { watch, invoke } as unknown as UiClient;
  const context = { host, signal: controller.signal, props: {}, presented: true, mountDefault: vi.fn() } as ControlUiViewContext;
  const container = document.createElement('div');
  document.body.append(container);
  const mountGraph = () => graphView(client)(container, context)!;
  const mountCompute = () => computeView(client)(container, context)!;
  return { controller, host, client, context, container, mountGraph, mountCompute, watch, invoke, unwatch, unsubscribe,
    graph: (value = replay()) => graphChange!(value), compute: (value: ComputeSnapshot) => computeChange!(value),
    changeConnection: () => listener!(), error: (error: Error) => onError!(error) };
}
function findButton(container: Element, label: string): HTMLButtonElement {
  const found = [...container.querySelectorAll('button')].find(node => node.textContent === label);
  if (!found) throw new Error(`Button not found: ${label}`);
  return found;
}
function unit(container: Element, id: string): SVGGElement {
  return container.querySelector<SVGGElement>(`[data-unit-id="${id}"]`)!;
}
function click(node: Element): void { node.dispatchEvent(new MouseEvent('click', { bubbles: true })); }
function key(node: Element, key: string, options = {}): void { node.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, ...options })); }

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(now); });
afterEach(() => { document.body.replaceChildren(); vi.useRealTimers(); vi.restoreAllMocks(); });

describe('native graph interactions', () => {
  it('watches the validated snapshot and selects a real inspector with native session dock', () => {
    const h = harness();
    const view = h.mountGraph();
    h.graph();
    expect(h.watch).toHaveBeenCalledWith('graph.snapshot', {}, expect.objectContaining({ events: ['changed'] }));
    click(unit(h.container, 'child'));
    const inspector = h.container.querySelector('aside')!;
    expect(inspector.textContent).toContain('REPLAY worker');
    expect(inspector.textContent).toContain('Bound conversation');
    findButton(inspector, 'Open alongside graph').click();
    expect(h.host.dock!.openSession).toHaveBeenCalledWith(expect.objectContaining({ agentId: 'replay-agent', sessionKey: 'replay-session' }));
    view.dispose?.();
  });
  it('uses native session navigation when no dock capability exists', () => {
    const h = harness();
    delete h.host.dock;
    const view = h.mountGraph();
    h.graph();
    click(unit(h.container, 'child'));
    findButton(h.container, 'Open conversation').click();
    expect(h.host.sessions.open).toHaveBeenCalledWith({ agentId: 'replay-agent', sessionKey: 'replay-session' });
    view.dispose?.();
  });
  it('supports accessible keyboard collapse/expand and keeps focus', () => {
    const h = harness();
    const view = h.mountGraph();
    h.graph();
    click(unit(h.container, 'root'));
    key(unit(h.container, 'root'), 'ArrowLeft');
    expect(unit(h.container, 'root').getAttribute('aria-expanded')).toBe('false');
    expect(unit(h.container, 'child')).toBeNull();
    expect(document.activeElement).toBe(unit(h.container, 'root'));
    expect(h.container.querySelector('.vsc-edge')?.getAttribute('data-source')).toBe('root');
    key(unit(h.container, 'root'), 'ArrowRight');
    expect(unit(h.container, 'child')).not.toBeNull();
    key(unit(h.container, 'root'), 'ArrowRight');
    expect(unit(h.container, 'child').getAttribute('aria-selected')).toBe('true');
    view.dispose?.();
  });
  it('pans and zooms without losing the viewport or selection on event refresh', () => {
    const h = harness();
    const view = h.mountGraph();
    h.graph();
    click(unit(h.container, 'child'));
    const canvas = h.container.querySelector('svg')!;
    const world = canvas.children[1]!;
    const original = world.getAttribute('transform');
    canvas.dispatchEvent(new PointerEvent('pointerdown', { button: 0, pointerId: 4, clientX: 100, clientY: 100, bubbles: true }));
    canvas.dispatchEvent(new PointerEvent('pointermove', { pointerId: 4, clientX: 160, clientY: 140, bubbles: true }));
    canvas.dispatchEvent(new PointerEvent('pointerup', { pointerId: 4, bubbles: true }));
    expect(world.getAttribute('transform')).not.toBe(original);
    canvas.dispatchEvent(new WheelEvent('wheel', { deltaY: -80, clientX: 200, clientY: 200, bubbles: true, cancelable: true }));
    const changed = world.getAttribute('transform');
    h.graph({ ...replay(), revision: 2 });
    expect(world.getAttribute('transform')).toBe(changed);
    expect(unit(h.container, 'child').getAttribute('aria-selected')).toBe('true');
    expect(h.container.querySelector('aside')?.hidden).toBe(false);
    view.dispose?.();
  });
  it('never animates a running status alone and correlates actual run/tool ends', () => {
    const h = harness();
    const view = h.mountGraph();
    h.graph();
    expect(unit(h.container, 'root').dataset.active).toBe('false');
    const start = { id: 'run-start', kind: 'run-start' as const, unitId: 'root', runId: 'run-1', at: now };
    const tool = { id: 'tool-start', kind: 'tool-start' as const, unitId: 'root', runId: 'run-1', toolCallId: 'call-1', at: now + 1 };
    h.graph({ ...replay(), revision: 2, activeRuns: [{ id: 'run-1', unitId: 'root' }], activities: [start, tool] });
    expect(unit(h.container, 'root').dataset.active).toBe('true');
    expect(unit(h.container, 'root').dataset.tool).toBe('true');
    h.graph({ ...replay(), revision: 3, activities: [{ ...tool, id: 'tool-end', kind: 'tool-end' }, { ...start, id: 'run-end', kind: 'run-end', at: now + 2 }] });
    expect(unit(h.container, 'root').dataset.active).toBe('false');
    expect(unit(h.container, 'root').dataset.tool).toBe('false');
    view.dispose?.();
  });
  it('does not revive retained activity after restart or session detachment', () => {
    const h = harness(); const view = h.mountGraph();
    const start = { id: 'start', kind: 'run-start' as const, unitId: 'root', runId: 'run', at: now - 10 };
    h.graph({ ...replay(), activeRuns: [{ id: 'run', unitId: 'root' }], activities: [start] });
    expect(unit(h.container, 'root').dataset.active).toBe('true');
    h.graph({ ...replay(), revision: 2, liveSince: now, units: replay().units.map(u => ({ ...u, status: 'unknown' as const })), activities: [start] });
    expect(unit(h.container, 'root').dataset.active).toBe('false');
    click(unit(h.container, 'root'));
    expect(h.container.querySelector('aside')?.textContent).not.toContain('Run in progress');
    h.graph({ ...replay(), revision: 3, units: replay().units.map(u => ({ ...u, status: 'idle' as const })), activities: [start] });
    expect(unit(h.container, 'root').dataset.active).toBe('false');
    view.dispose?.();
  });

  it('never revives an old tool when a rebound unit starts a new run, including a fresh mount', () => {
    const h = harness(); const view = h.mountGraph();
    const old = { id: 'old-tool', kind: 'tool-start' as const, unitId: 'root', runId: 'old-run', toolCallId: 'old-call', at: now - 10 };
    const graph = { ...replay(), activeRuns: [{ id: 'new-run', unitId: 'root' }], activities: [old,
      { id: 'new-start', kind: 'run-start' as const, unitId: 'root', runId: 'new-run', at: now }] };
    h.graph(graph);
    expect(unit(h.container, 'root').dataset.active).toBe('true');
    expect(unit(h.container, 'root').dataset.tool).toBe('false');
    click(unit(h.container, 'root'));
    expect(h.container.querySelector('aside')?.textContent).not.toContain('Tool call in progress');
    view.dispose?.();
    const fresh = harness(); const mounted = fresh.mountGraph(); fresh.graph(graph);
    expect(unit(fresh.container, 'root').dataset.active).toBe('true');
    expect(unit(fresh.container, 'root').dataset.tool).toBe('false');
    mounted.dispose?.();
  });

  it('shows partial/stale/disconnected observations, expires activity, and cleans up on abort', () => {
    const h = harness();
    const view = h.mountGraph();
    h.graph({ ...replay(), activeRuns: [{ id: 'run-1', unitId: 'root' }], activities: [{ id: 'start', kind: 'run-start', unitId: 'root', runId: 'run-1', at: now }] });
    click(unit(h.container, 'root'));
    expect(h.container.textContent).toContain('Partial coverage');
    vi.advanceTimersByTime(STALE_MS + 5);
    expect(h.container.textContent).toContain('Stale observations');
    expect(unit(h.container, 'root').dataset.active).toBe('false');
    vi.advanceTimersByTime(ACTIVE_MS);
    expect(h.container.querySelector('aside')?.textContent).toContain('Current activity is unknown');
    h.host.connection.connected = false;
    h.changeConnection();
    expect(h.container.textContent).toContain('Disconnected');
    h.controller.abort();
    expect(h.unwatch).toHaveBeenCalledTimes(1);
    expect(h.unsubscribe).toHaveBeenCalledTimes(1);
    expect(h.container.children).toHaveLength(0);
    view.dispose?.();
    expect(h.unwatch).toHaveBeenCalledTimes(1);
    h.graph();
    expect(h.container.children).toHaveLength(0);
  });
  it('respects reduced motion and unpresented lifecycle without losing graph state', () => {
    const h = harness();
    const media = { matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() };
    vi.stubGlobal('matchMedia', vi.fn(() => media));
    const view = h.mountGraph();
    h.graph({ ...replay(), activeRuns: [{ id: 'run-1', unitId: 'root' }], activities: [{ id: 'run', unitId: 'root', kind: 'run-start', runId: 'run-1', at: now }] });
    expect(h.container.querySelector<HTMLElement>('.vsc')?.dataset.reducedMotion).toBe('true');
    // Activity remains semantically visible; CSS suppresses motion for the media preference.
    expect(unit(h.container, 'root').getAttribute('aria-label')).toContain('run in progress');
    view.update?.({ ...h.context, presented: false });
    expect(unit(h.container, 'root').dataset.active).toBe('false');
    expect(h.container.querySelector('.vsc-motion-paused')).not.toBeNull();
    view.update?.(h.context);
    expect(unit(h.container, 'root').dataset.active).toBe('true');
    view.dispose?.();
    expect(media.removeEventListener).toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
  it('creates an empty root through real schema inputs and keeps errors visible/redacted', async () => {
    const h = harness();
    const view = h.mountGraph();
    h.graph({ ...replay(), units: [], relations: [] });
    findButton(h.container, 'Create root system').click();
    const form = h.container.querySelector('form')!;
    form.querySelector<HTMLInputElement>('[name=id]')!.value = 'new-system';
    form.querySelector<HTMLInputElement>('[name=name]')!.value = 'Actual purpose';
    form.querySelector<HTMLTextAreaElement>('[name=purpose]')!.value = 'Coordinate the organization';
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await Promise.resolve();
    expect(h.invoke).toHaveBeenCalledWith('unit.upsert', { id: 'new-system', name: 'Actual purpose', purpose: 'Coordinate the organization', parentId: null });
    h.error(new Error('Connection SECRET failed'));
    expect(h.container.textContent).toContain('Connection [redacted] failed');
    view.dispose?.();
  });
  it('binds and detaches through the verified native session operation', async () => {
    const h = harness();
    const view = h.mountGraph();
    h.graph();
    click(unit(h.container, 'child'));
    findButton(h.container, 'Change binding').click();
    const form = h.container.querySelector('form')!;
    form.querySelector<HTMLInputElement>('[name=agentId]')!.value = 'another-agent';
    form.querySelector<HTMLInputElement>('[name=sessionKey]')!.value = 'another-session';
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await Promise.resolve();
    await Promise.resolve();
    expect(h.invoke).toHaveBeenCalledWith('unit.bind-session', { unitId: 'child', session: { agentId: 'another-agent', sessionKey: 'another-session' } });
    findButton(h.container, 'Change binding').click();
    findButton(h.container, 'Detach conversation').click();
    expect(h.invoke).toHaveBeenCalledWith('unit.bind-session', { unitId: 'child', session: null });
    await Promise.resolve();
    await Promise.resolve();
    view.dispose?.();
  });
  it('animates only a recent actual handoff and accepts a native system deep link', () => {
    const h = harness();
    const context = { ...h.context, props: { unit: 'child' } };
    const view = graphView(h.client)(h.container, context)!;
    h.graph({ ...replay(), activities: [{ id: 'message', kind: 'message', unitId: 'child', targetUnitId: 'peer', at: now }] });
    expect(unit(h.container, 'child').getAttribute('aria-selected')).toBe('true');
    expect(h.container.querySelector<SVGPathElement>('.vsc-edge')?.dataset.active).toBe('true');
    click(unit(h.container, 'root'));
    key(unit(h.container, 'root'), 'ArrowLeft');
    expect(h.container.querySelector<SVGPathElement>('.vsc-edge')?.dataset.active).toBe('true');
    vi.advanceTimersByTime(8_010);
    expect(h.container.querySelector<SVGPathElement>('.vsc-edge')?.dataset.active).toBe('false');
    view.dispose?.();
  });
  it('disallows graph mutations for read-only operators without inventing disabled controls', () => {
    const h = harness();
    h.host.connection.canWrite = false;
    const view = h.mountGraph();
    h.graph();
    click(unit(h.container, 'root'));
    expect([...h.container.querySelectorAll('button')].filter(node => !node.hidden).map(node => node.textContent)).not.toContain('Edit system');
    expect(findButton(h.container, 'Add system').hidden).toBe(true);
    view.dispose?.();
  });
  it('ignores lower-revision replay results and preserves an open editing form', () => {
    const h = harness();
    const view = h.mountGraph();
    h.graph({ ...replay(), revision: 5 });
    click(unit(h.container, 'root'));
    findButton(h.container, 'Edit system').click();
    const name = h.container.querySelector<HTMLInputElement>('[name=name]')!;
    name.value = 'Unsaved operator input';
    h.graph({ ...replay(), revision: 6 });
    expect(h.container.querySelector('[name=name]')).toBe(name);
    expect(name.value).toBe('Unsaved operator input');
    h.graph({ ...replay(), revision: 2, units: [] });
    expect(unit(h.container, 'root')).not.toBeNull();
    view.dispose?.();
  });
});

describe('separate compute observations view', () => {
  it('renders honest unknown states, actual quotas/models/reasons and system navigation', () => {
    const h = harness();
    const view = h.mountCompute();
    h.compute({ revision: 1, observedAt: now, pools: [], models: [], allocations: [] });
    expect(h.container.textContent).toContain('No compute pools have been observed');
    expect(h.container.querySelector('progress')).toBeNull();
    h.compute({ revision: 2, observedAt: now,
      pools: [{ id: 'pool', label: 'REPLAY pool', kind: 'subscription', observedAt: now, status: 'available', active: 2, concurrency: 4, windows: [{ id: 'daily', label: 'Daily', usedFraction: .6 }] }],
      models: [{ id: 'model', poolId: 'pool', label: 'REPLAY model', capabilities: ['coding'], observedAt: now, quality: .8, samples: 12, latencyMs: 1800, quotaCost: { daily: .01 } }],
      allocations: [{ id: 'allocation', unitId: 'root', modelId: 'model', status: 'blocked', reason: 'Insufficient fresh quota evidence', at: now }],
    });
    expect(h.container.querySelector('progress')?.value).toBe(.6);
    expect(h.container.textContent).toContain('2 active / 4 capacity');
    expect(h.container.textContent).toContain('12 samples');
    expect(h.container.textContent).toContain('Insufficient fresh quota evidence');
    click(h.container.querySelector('a')!);
    expect(h.host.navigation.openPage).toHaveBeenCalledWith({ id: 'organization', params: { unit: 'root' } });
    view.dispose?.();
    expect(h.unwatch).toHaveBeenCalledTimes(1);
    expect(h.unsubscribe).toHaveBeenCalledTimes(1);
  });
  it('marks compute stale/disconnected and refresh replaces its watch instead of leaking it', () => {
    const h = harness();
    const view = h.mountCompute();
    h.compute({ revision: 1, observedAt: now, pools: [{ id: 'pool', label: 'REPLAY', kind: 'throughput', observedAt: now, status: 'unknown', windows: [] }], models: [], allocations: [] });
    vi.advanceTimersByTime(STALE_MS + 5);
    expect(h.container.textContent).toContain('Stale observations');
    h.host.connection.connected = false;
    h.changeConnection();
    expect(h.container.textContent).toContain('Disconnected');
    findButton(h.container, 'Refresh').click();
    expect(h.unwatch).toHaveBeenCalledTimes(1);
    expect(h.watch).toHaveBeenCalledTimes(2);
    view.dispose?.();
    expect(h.unwatch).toHaveBeenCalledTimes(2);
  });
});
