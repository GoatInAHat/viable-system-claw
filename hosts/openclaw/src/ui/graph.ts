import type { ControlUiView } from 'openclaw/plugin-sdk/control-ui';
import type { Activity, GraphSnapshot, Relation, Unit } from '../model.js';
import { ACTIVE_MS, RECENT_MS, STALE_MS, activityState, fitViewport, graphHealth, layoutGraph, zoomAt } from './graph-state.js';
import type { GraphLayout, GraphNode, Viewport } from './graph-state.js';
import { button, detail, element, errorText, field, input, installRoot, select, time } from './shared.js';
import type { UiClient } from './shared.js';

const SVG = 'http://www.w3.org/2000/svg';
// HTML patterns use Unicode sets (v); slash/hyphen need escaping inside the class.
const ID_PATTERN = String.raw`[a-zA-Z0-9_.:\/\-]+`;
let instance = 0;
function svg<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number> = {}, text?: string): SVGElementTagNameMap[K] {
  const node = document.createElementNS(SVG, tag);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value));
  if (text !== undefined) node.textContent = text;
  return node;
}
function trim(text: string, length: number): string { return text.length > length ? `${text.slice(0, length - 1)}…` : text; }

export function graphView(client: UiClient): ControlUiView {
  return (container, initial) => {
    let context = initial;
    const host = context.host;
    const root = installRoot(container, 'Viable System Claw organization');
    const toolbar = element('header', 'vsc-toolbar');
    const title = element('div', 'vsc-toolbar-title');
    const health = element('span', 'vsc-health', 'Connecting');
    health.setAttribute('role', 'status');
    title.append(element('h1', '', 'Organization'), health);
    const controls = element('div', 'vsc-toolbar-actions');
    const notice = element('p', 'vsc-notice');
    notice.hidden = true;
    const failure = element('p', 'vsc-notice vsc-error');
    failure.setAttribute('role', 'alert');
    failure.hidden = true;
    const workspace = element('div', 'vsc-workspace');
    const stage = element('div', 'vsc-stage');
    const canvas = svg('svg', { class: 'vsc-canvas', role: 'tree', 'aria-label': 'Nested organizational systems', tabindex: '0' });
    const helpId = `vsc-graph-help-${++instance}`;
    const instructions = element('p', 'vsc-instructions', 'Drag background to pan · Scroll to zoom · Arrow keys select · Shift + arrows pan · Enter inspects · + / − zoom · 0 fits');
    instructions.id = helpId;
    canvas.setAttribute('aria-describedby', helpId);
    const defs = svg('defs');
    const markerId = `vsc-arrow-${instance}`;
    const marker = svg('marker', { id: markerId, viewBox: '0 0 10 10', refX: 9, refY: 5, markerWidth: 5, markerHeight: 5, orient: 'auto-start-reverse' });
    marker.append(svg('path', { d: 'M 0 1 L 9 5 L 0 9 Z', class: 'vsc-edge-target' }));
    defs.append(marker);
    const world = svg('g');
    canvas.append(defs, world);
    const empty = element('div', 'vsc-empty');
    empty.append(element('h2', '', 'Waiting for organization data'), element('p', '', 'The graph will appear when the Gateway returns a snapshot.'));
    const inspector = element('aside', 'vsc-inspector');
    inspector.setAttribute('aria-label', 'System inspector');
    inspector.hidden = true;
    const announce = element('p', 'vsc-visually-hidden');
    announce.setAttribute('aria-live', 'polite');
    stage.append(canvas, instructions, empty);
    workspace.append(stage, inspector);
    toolbar.append(title, controls);
    root.append(toolbar, notice, failure, workspace, announce);

    let snapshot: GraphSnapshot | undefined;
    let layout: GraphLayout = { nodes: [], edges: [], width: 360, height: 240, warnings: [] };
    let selected: string | undefined = context.props.unit;
    let focused: string | undefined;
    const collapsed = new Set<string>();
    const ledger = new Map<string, Activity>();
    let viewport: Viewport = { x: 0, y: 0, scale: 1 };
    let fitted = false;
    let disposed = false;
    let formOpen = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let drag: { id: number; x: number; y: number; start: Viewport; moved: boolean } | undefined;
    const media = globalThis.matchMedia?.('(prefers-reduced-motion: reduce)');
    const setMotion = () => { root.dataset.reducedMotion = String(media?.matches ?? false); };
    setMotion();
    media?.addEventListener('change', setMotion);

    const error = (cause: unknown) => {
      if (disposed || context.signal.aborted) return;
      failure.textContent = host.redact(errorText(cause));
      failure.hidden = false;
      updateHealth();
    };
    const applyTransform = () => {
      world.setAttribute('transform', `translate(${viewport.x} ${viewport.y}) scale(${viewport.scale})`);
      zoomLabel.textContent = `${Math.round(viewport.scale * 100)}%`;
    };
    const dimensions = () => {
      const box = stage.getBoundingClientRect();
      return { width: box.width || 900, height: box.height || 560 };
    };
    const fit = () => {
      const { width, height } = dimensions();
      viewport = fitViewport(width, height, layout);
      fitted = true;
      applyTransform();
    };
    const zoom = (factor: number) => {
      const { width, height } = dimensions();
      viewport = zoomAt(viewport, factor, width / 2, height / 2);
      applyTransform();
    };
    const zoomLabel = element('span', 'vsc-subtle', '100%');
    zoomLabel.setAttribute('aria-label', 'Graph zoom');
    const addRoot = button('Add system', () => showUnitForm());
    const retry = button('Refresh', () => startWatch());
    controls.append(button('Fit', fit), button('−', () => zoom(1 / 1.2)), zoomLabel, button('+', () => zoom(1.2)), addRoot, retry);
    controls.children[1]!.setAttribute('aria-label', 'Zoom out');
    controls.children[3]!.setAttribute('aria-label', 'Zoom in');

    function updateHealth(): void {
      if (disposed) return;
      const state = graphHealth(snapshot, host.connection.connected, Date.now());
      const names = { loading: 'Loading', live: 'Live observations', partial: 'Partial coverage', stale: 'Stale observations', disconnected: 'Disconnected' };
      health.dataset.state = state;
      health.textContent = names[state];
      health.title = snapshot ? `Last observation ${time(snapshot.observedAt)} · Revision ${snapshot.revision}` : 'No snapshot received';
      const notes: string[] = [];
      if (state === 'disconnected') notes.push('Gateway disconnected. Displaying the last received graph; live activity is paused.');
      if (state === 'stale') notes.push('No recent snapshot. Recorded statuses may have changed; activity is paused. Refresh to check.');
      if (state === 'partial') notes.push('Configured systems only. Run/tool events and accepted handoffs have partial coverage; message contents and unbound sessions are not observed.');
      if (layout.warnings.length) notes.push(...layout.warnings);
      notice.textContent = notes.join(' ');
      notice.hidden = notes.length === 0;
      addRoot.hidden = !host.connection.canWrite;
      root.classList.toggle('vsc-motion-paused', !context.presented || state === 'stale' || state === 'disconnected');
      root.setAttribute('aria-busy', String(!snapshot));
    }

    function updateActivity(): void {
      if (disposed) return;
      const now = Date.now();
      updateHealth();
      const state = activityState([...ledger.values()].filter(event => event.at >= (snapshot?.liveSince ?? 0)), now);
      const canAnimate = context.presented && ['live', 'partial'].includes(graphHealth(snapshot, host.connection.connected, now));
      const current = (event: Activity) => snapshot?.activeRuns.some(run => run.id === event.runId && run.unitId === event.unitId);
      const activeUnits = new Set([...state.runs, ...state.tools].filter(current).map(event => event.unitId));
      const toolUnits = new Set(state.tools.filter(current).map(event => event.unitId));
      for (const node of world.querySelectorAll<SVGGElement>('.vsc-node')) {
        const id = node.dataset.unitId!;
        const graphNode = layout.nodes.find(entry => entry.unit.id === id)!;
        const contains = (unitId: string) => {
          if (unitId === id) return true;
          if (!collapsed.has(id)) return false;
          const seen = new Set<string>();
          let unit = snapshot?.units.find(entry => entry.id === unitId);
          while (unit?.parentId && !seen.has(unit.id)) {
            seen.add(unit.id);
            if (unit.parentId === id) return true;
            unit = snapshot?.units.find(entry => entry.id === unit!.parentId);
          }
          return false;
        };
        const running = [...activeUnits].some(contains);
        const tools = [...toolUnits].some(contains);
        node.dataset.active = String(canAnimate && running);
        node.dataset.tool = String(canAnimate && tools);
        node.dataset.recent = String(canAnimate && state.recent.some(event => contains(event.unitId)));
        const activity = node.querySelector<SVGTextElement>('[data-activity]');
        if (activity) activity.textContent = canAnimate && tools ? 'Tool call in progress' : canAnimate && running ? 'Run in progress' : graphNode.descendants ? `${graphNode.descendants} nested system${graphNode.descendants === 1 ? '' : 's'}` : (graphNode.unit.session ? 'Session bound' : 'No session bound');
        // A label conveys activity even when reduced motion disables animation.
        const actionLabel = canAnimate && tools ? ', tool call in progress' : canAnimate && running ? ', run in progress' : '';
        node.setAttribute('aria-label', `${graphNode.unit.name}, ${graphNode.unit.status}${actionLabel}`);
      }
      for (const path of world.querySelectorAll<SVGPathElement>('.vsc-edge')) {
        const edge = layout.edges.find(entry => entry.id === path.dataset.edgeId);
        const relations = snapshot?.relations.filter(relation => edge?.relationIds.includes(relation.id)) ?? [];
        const hasEvent = state.recent.some(event => event.targetUnitId && relations.some(relation => relation.source === event.unitId && relation.target === event.targetUnitId));
        path.dataset.active = String(canAnimate && hasEvent);
      }
      if (timer) clearTimeout(timer);
      if (!context.presented) return;
      const expirations = [...ledger.values()].flatMap(event => [event.at + RECENT_MS, event.at + ACTIVE_MS]);
      if (snapshot) expirations.push(snapshot.observedAt + STALE_MS + 1);
      const next = Math.min(...expirations.filter(at => at > now));
      if (Number.isFinite(next)) timer = setTimeout(() => {
        updateActivity();
        if (selected && !formOpen) renderInspector();
      }, Math.min(next - now + 1, 2_147_483_647));
    }

    const nodeElement = (id: string) => [...world.querySelectorAll<SVGGElement>('.vsc-node')].find(node => node.dataset.unitId === id);
    function choose(id: string, focus = false): void {
      selected = id;
      focused = id;
      formOpen = false;
      for (const node of world.querySelectorAll<SVGGElement>('.vsc-node')) {
        node.dataset.selected = String(node.dataset.unitId === id);
        node.setAttribute('aria-selected', String(node.dataset.unitId === id));
        node.setAttribute('tabindex', node.dataset.unitId === id ? '0' : '-1');
      }
      renderInspector();
      if (focus) nodeElement(id)?.focus();
    }
    function toggle(id: string): void {
      collapsed.has(id) ? collapsed.delete(id) : collapsed.add(id);
      renderGraph();
      choose(id, true);
      announce.textContent = `${snapshot?.units.find(unit => unit.id === id)?.name} ${collapsed.has(id) ? 'collapsed' : 'expanded'}`;
    }
    function renderGraph(): void {
      if (!snapshot || disposed) return;
      const active = (document.activeElement as HTMLElement | null)?.dataset?.unitId;
      layout = layoutGraph(snapshot, collapsed);
      const visible = new Set(layout.nodes.map(node => node.unit.id));
      if (selected && !snapshot.units.some(unit => unit.id === selected)) selected = undefined;
      if (focused && !visible.has(focused)) focused = undefined;
      const frames = svg('g', { 'aria-hidden': 'true' });
      const links = svg('g', { 'aria-hidden': 'true', 'pointer-events': 'none' });
      const nodes = svg('g', { role: 'group' });
      for (const node of layout.nodes) {
        const frame = svg('g', { class: node.children ? 'vsc-compound' : '' });
        frame.append(svg('rect', { x: node.x, y: node.y, width: node.width, height: node.height, rx: node.children ? 16 : 10, class: 'vsc-node-frame' }));
        frames.append(frame);
      }
      const positions = new Map(layout.nodes.map(node => [node.unit.id, node]));
      for (const [i, edge] of layout.edges.entries()) {
        const a = positions.get(edge.source)!;
        const b = positions.get(edge.target)!;
        const direction = b.x + b.width / 2 >= a.x + a.width / 2 ? 1 : -1;
        const x1 = direction > 0 ? a.x + a.width : a.x;
        const x2 = direction > 0 ? b.x : b.x + b.width;
        const y1 = a.y + (a.children ? 38 : a.height / 2);
        const y2 = b.y + (b.children ? 38 : b.height / 2);
        const bend = Math.max(42, Math.abs(x2 - x1) * .5) + (i % 3) * 9;
        const path = svg('path', { class: 'vsc-edge', d: `M ${x1} ${y1} C ${x1 + bend * direction} ${y1}, ${x2 - bend * direction} ${y2}, ${x2} ${y2}`, 'marker-end': `url(#${markerId})`, 'data-edge-id': edge.id, 'data-kind': edge.kind, 'data-source': edge.source, 'data-target': edge.target });
        path.append(svg('title', {}, `${a.unit.name} to ${b.unit.name}: ${edge.label}`));
        links.append(path);
        // Narrow links retain a tooltip and inspector label rather than overlapping node text.
        if (Math.abs(x2 - x1) > edge.label.length * 6 + 16) links.append(svg('text', { x: (x1 + x2) / 2, y: (y1 + y2) / 2 - 12, 'text-anchor': 'middle', class: 'vsc-edge-label' }, trim(edge.label, 42)));
      }
      for (const [index, node] of layout.nodes.entries()) {
        const { unit } = node;
        const group = svg('g', { class: `vsc-node${node.children ? ' vsc-compound' : ''}`, role: 'treeitem', 'aria-level': node.depth, 'aria-selected': String(unit.id === selected), tabindex: unit.id === focused || (!focused && index === 0) ? 0 : -1, 'data-unit-id': unit.id, 'data-status': unit.status, 'data-selected': String(unit.id === selected) });
        if (node.children) group.setAttribute('aria-expanded', String(!collapsed.has(unit.id)));
        const outline = svg('rect', { x: node.x, y: node.y, width: node.width, height: node.height, rx: node.children ? 16 : 10, class: 'vsc-node-frame' });
        outline.style.fill = 'transparent';
        group.append(outline, svg('circle', { cx: node.x + 21, cy: node.y + 28, r: 3.5, class: 'vsc-node-status' }), svg('text', { x: node.x + 33, y: node.y + 33, class: 'vsc-node-title' }, trim(unit.name, Math.floor((node.width - 78) / 8))), svg('text', { x: node.x + 18, y: node.y + 53, class: 'vsc-node-meta' }, trim(unit.purpose || unit.status, Math.floor((node.width - 40) / 6))));
        if (node.children) {
          const control = svg('text', { x: node.x + node.width - 30, y: node.y + 33, class: 'vsc-node-toggle', 'aria-hidden': 'true' }, collapsed.has(unit.id) ? '+' : '−');
          control.addEventListener('click', event => { event.stopPropagation(); toggle(unit.id); });
          group.append(control);
        }
        if (!node.children || collapsed.has(unit.id)) group.append(svg('text', { x: node.x + 18, y: node.y + 85, class: 'vsc-node-meta', 'data-activity': 'true' }));
        group.append(svg('title', {}, `${unit.name}\n${unit.purpose}\nRecorded status: ${unit.status}`));
        group.addEventListener('click', () => { if (!drag?.moved) choose(unit.id, true); });
        group.addEventListener('dblclick', event => { if (node.children) { event.stopPropagation(); toggle(unit.id); } });
        group.addEventListener('focus', () => { focused = unit.id; });
        nodes.append(group);
      }
      world.replaceChildren(frames, links, nodes);
      empty.hidden = snapshot.units.length > 0;
      if (!snapshot.units.length) {
        empty.replaceChildren(element('h2', '', 'Start with a system'), element('p', '', 'Name a purpose, then add the systems nested inside it. Nothing is inferred from your conversations.'));
        if (host.connection.canWrite) empty.append(button('Create root system', () => showUnitForm(), 'vsc-primary'));
      }
      if (!fitted && snapshot.units.length) fit();
      else applyTransform();
      if (active && visible.has(active)) nodeElement(active)?.focus();
      updateActivity();
      if (!formOpen) renderInspector();
    }

    function renderInspector(): void {
      if (formOpen) return;
      const unit = snapshot?.units.find(entry => entry.id === selected);
      inspector.hidden = !unit;
      if (!unit || !snapshot) { inspector.replaceChildren(); return; }
      const heading = element('div', 'vsc-inspector-header');
      heading.append(element('h2', '', unit.name), button('Close', () => { selected = undefined; inspector.hidden = true; renderGraph(); canvas.focus(); }));
      const facts = element('dl');
      detail(facts, 'Recorded state', unit.status);
      detail(facts, 'Parent', snapshot.units.find(entry => entry.id === unit.parentId)?.name ?? (unit.parentId ? 'Unavailable' : 'Root system'));
      detail(facts, 'Updated', time(unit.updatedAt));
      detail(facts, 'System ID', unit.id);
      const session = element('section');
      session.append(element('h3', '', 'Conversation'));
      if (unit.session) {
        session.append(element('p', 'vsc-subtle', `${unit.session.agentId} / ${unit.session.sessionKey}`));
        const bound = unit.session;
        session.append(button(host.dock ? 'Open alongside graph' : 'Open conversation', () => {
          if (host.dock) host.dock.openSession({ ...bound, label: unit.name, context: { page: 'organization', detail: { unitId: unit.id } } });
          else host.sessions.open(bound);
        }));
      } else session.append(element('p', 'vsc-subtle', 'No conversation is bound to this system.'));
      if (host.connection.canWrite) session.append(button(unit.session ? 'Change binding' : 'Bind conversation', () => showBindingForm(unit)));
      const actions = element('section');
      if (layout.nodes.find(node => node.unit.id === unit.id)?.children) actions.append(button(collapsed.has(unit.id) ? 'Expand system' : 'Collapse system', () => toggle(unit.id)));
      if (host.connection.canWrite) actions.append(button('Edit system', () => showUnitForm(unit)), button('Add child', () => showUnitForm(undefined, unit.id)), button('Add relation', () => showRelationForm(unit)));
      const relations = element('section');
      relations.append(element('h3', '', 'Relations'));
      const relationList = element('ul');
      for (const relation of snapshot.relations.filter(entry => entry.source === unit.id || entry.target === unit.id)) {
        const otherId = relation.source === unit.id ? relation.target : relation.source;
        const other = snapshot.units.find(entry => entry.id === otherId);
        const item = element('li');
        item.append(button(`${relation.source === unit.id ? 'To' : 'From'} ${other?.name ?? otherId}`, () => choose(otherId)), element('p', 'vsc-subtle', relation.label || relation.kind));
        relationList.append(item);
      }
      relations.append(relationList.children.length ? relationList : element('p', 'vsc-subtle', 'No explicit relations.'));
      const activity = element('section');
      activity.append(element('h3', '', 'Observed activity'));
      const state = activityState([...ledger.values()], Date.now());
      const active = [...state.runs, ...state.tools].filter(event => event.unitId === unit.id && snapshot?.activeRuns.some(run => run.id === event.runId && run.unitId === event.unitId));
      if (active.length) {
        const fresh = unit.status === 'running' && active.every(event => event.at >= (snapshot?.liveSince ?? 0)) && ['live', 'partial'].includes(graphHealth(snapshot, host.connection.connected, Date.now()));
        activity.append(element('p', 'vsc-subtle', fresh ? active.map(event => event.label || (event.kind === 'tool-start' ? 'Tool call in progress' : 'Run in progress')).join(', ') : 'A run or tool start was last observed. Current activity is unknown after lifecycle changes or while observations are stale or disconnected.'));
      }
      if (state.expired.some(event => event.unitId === unit.id)) activity.append(element('p', 'vsc-subtle', 'An observed start has no recent matching end. Current activity is unknown.'));
      const events = [...ledger.values()].filter(event => event.unitId === unit.id).sort((a, b) => b.at - a.at).slice(0, 8);
      const eventList = element('ul');
      for (const event of events) {
        const item = element('li', '', event.label || event.kind.replaceAll('-', ' '));
        const date = element('time', '', time(event.at));
        date.dateTime = new Date(event.at).toISOString();
        item.append(date);
        eventList.append(item);
      }
      activity.append(events.length ? eventList : element('p', 'vsc-subtle', 'No activity observed for this system.'));
      inspector.replaceChildren(heading, element('p', 'vsc-purpose', unit.purpose || 'No purpose recorded.'), facts, actions, session, relations, activity);
    }

    function form(titleText: string, saveLabel: string, submit: () => Promise<unknown>): HTMLFormElement {
      formOpen = true;
      inspector.hidden = false;
      const heading = element('h2', '', titleText);
      const form = element('form', 'vsc-form');
      const status = element('p', 'vsc-error');
      status.setAttribute('role', 'alert');
      const actions = element('div', 'vsc-form-actions');
      const save = button(saveLabel, () => undefined, 'vsc-primary');
      save.type = 'submit';
      const cancel = button('Cancel', () => { formOpen = false; renderInspector(); if (!selected) inspector.hidden = true; });
      actions.append(save, cancel);
      form.addEventListener('submit', async event => {
        event.preventDefault();
        if (!host.connection.canWrite || save.disabled || !form.reportValidity()) return;
        save.disabled = true;
        cancel.disabled = true;
        status.textContent = '';
        try {
          await submit();
          if (disposed || context.signal.aborted) return;
          formOpen = false;
          renderInspector();
        } catch (cause) {
          if (!disposed) status.textContent = host.redact(errorText(cause));
        } finally {
          if (!disposed) { save.disabled = false; cancel.disabled = false; }
        }
      });
      form.append(status, actions);
      inspector.replaceChildren(heading, form);
      return form;
    }
    function showUnitForm(unit?: Unit, parentId?: string): void {
      const id = input('id', unit?.id ?? '', 128);
      id.required = true;
      id.pattern = ID_PATTERN;
      id.readOnly = !!unit;
      const name = input('name', unit?.name ?? '');
      name.required = true;
      const purpose = element('textarea');
      purpose.name = 'purpose';
      purpose.maxLength = 2000;
      purpose.value = unit?.purpose ?? '';
      const parent = select('parentId', [{ value: '', label: 'Root system' }, ...(snapshot?.units ?? []).filter(entry => entry.id !== unit?.id).map(entry => ({ value: entry.id, label: entry.name }))], unit?.parentId ?? parentId ?? '');
      const editor = form(unit ? 'Edit system' : 'Create system', 'Save system', async () => {
        const unitId = id.value.trim();
        const result = await client.invoke('unit.upsert', { id: unitId, name: name.value.trim(), purpose: purpose.value.trim(), parentId: parent.value || null });
        if (disposed || context.signal.aborted) return;
        selected = unitId;
        accept(result);
      });
      editor.prepend(field('System ID', id), field('Name', name), field('Purpose', purpose), field('Parent system', parent));
      name.focus();
    }
    function showRelationForm(unit: Unit): void {
      const id = input('id', '', 128);
      id.required = true;
      id.pattern = ID_PATTERN;
      const target = select('target', (snapshot?.units ?? []).filter(entry => entry.id !== unit.id).map(entry => ({ value: entry.id, label: entry.name })));
      target.required = true;
      const kind = select('kind', ['communication', 'coordination', 'resource', 'audit'].map(value => ({ value, label: value })), 'communication');
      const label = input('label');
      const editor = form(`Relation from ${unit.name}`, 'Save relation', async () => {
        const result = await client.invoke('relation.upsert', { id: id.value.trim(), source: unit.id, target: target.value, kind: kind.value as Relation['kind'], ...(label.value.trim() ? { label: label.value.trim() } : {}) });
        accept(result);
      });
      editor.prepend(field('Relation ID', id), field('Target system', target), field('Kind', kind), field('Label (optional)', label));
      id.focus();
    }
    function showBindingForm(unit: Unit): void {
      const agent = input('agentId', unit.session?.agentId ?? '', 128);
      const key = input('sessionKey', unit.session?.sessionKey ?? '', 512);
      agent.required = true;
      key.required = true;
      agent.pattern = ID_PATTERN;
      const editor = form('Bind an existing conversation', 'Bind conversation', async () => {
        const result = await client.invoke('unit.bind-session', { unitId: unit.id, session: { agentId: agent.value.trim(), sessionKey: key.value.trim() } });
        accept(result);
      });
      editor.prepend(element('p', 'vsc-subtle', 'Use the exact agent and session key of an existing conversation. The Gateway verifies the session before binding it.'), field('Agent ID', agent), field('Session key', key));
      if (unit.session) editor.append(button('Detach conversation', () => {
        if (!host.connection.canWrite) return;
        const pendingButtons = [...editor.querySelectorAll('button')];
        pendingButtons.forEach(node => { node.disabled = true; });
        void client.invoke('unit.bind-session', { unitId: unit.id, session: null }).then(result => {
          if (disposed || context.signal.aborted) return;
          accept(result);
          formOpen = false;
          renderInspector();
        }).catch(cause => { error(cause); }).finally(() => { if (!disposed) pendingButtons.forEach(node => { node.disabled = false; }); });
      }));
      key.focus();
    }

    function accept(next: GraphSnapshot): void {
      if (disposed || context.signal.aborted || (snapshot && next.revision < snapshot.revision)) return;
      snapshot = next;
      failure.hidden = true;
      for (const event of next.activities) ledger.set(event.id, event);
      if (ledger.size > 2048) {
        const keep = [...ledger.values()].sort((a, b) => b.at - a.at).slice(0, 2048);
        ledger.clear();
        keep.forEach(event => ledger.set(event.id, event));
      }
      renderGraph();
    }
    let stopWatch: (() => void) | undefined;
    function startWatch(): void {
      if (disposed || context.signal.aborted) return;
      stopWatch?.();
      failure.hidden = true;
      stopWatch = client.watch('graph.snapshot', {}, { events: ['changed'], onChange: accept, onError: error });
    }

    canvas.addEventListener('keydown', event => {
      const index = Math.max(0, layout.nodes.findIndex(node => node.unit.id === focused));
      const node = layout.nodes[index];
      if (event.key === '+' || event.key === '=') { event.preventDefault(); zoom(1.2); return; }
      if (event.key === '-') { event.preventDefault(); zoom(1 / 1.2); return; }
      if (event.key === '0') { event.preventDefault(); fit(); return; }
      if (event.key === 'Escape') { selected = undefined; formOpen = false; inspector.hidden = true; renderGraph(); canvas.focus(); return; }
      if (!node) return;
      if (event.shiftKey && event.key.startsWith('Arrow')) {
        event.preventDefault();
        viewport = { ...viewport, x: viewport.x + (event.key === 'ArrowLeft' ? 40 : event.key === 'ArrowRight' ? -40 : 0), y: viewport.y + (event.key === 'ArrowUp' ? 40 : event.key === 'ArrowDown' ? -40 : 0) };
        applyTransform();
      } else if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
        event.preventDefault();
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? layout.nodes.length - 1 : Math.max(0, Math.min(layout.nodes.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1)));
        choose(layout.nodes[next]!.unit.id, true);
      } else if (event.key === 'ArrowRight') {
        event.preventDefault();
        if (node.children && collapsed.has(node.unit.id)) toggle(node.unit.id);
        else if (node.children) choose(layout.nodes[index + 1]!.unit.id, true);
      } else if (event.key === 'ArrowLeft') {
        event.preventDefault();
        if (node.children && !collapsed.has(node.unit.id)) toggle(node.unit.id);
        else if (node.unit.parentId && nodeElement(node.unit.parentId)) choose(node.unit.parentId, true);
      } else if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); choose(node.unit.id, true); }
    });
    canvas.addEventListener('wheel', event => {
      event.preventDefault();
      const box = canvas.getBoundingClientRect();
      viewport = zoomAt(viewport, Math.exp(-Math.max(-120, Math.min(120, event.deltaY)) * .002), event.clientX - box.left, event.clientY - box.top);
      applyTransform();
    }, { passive: false });
    canvas.addEventListener('pointerdown', event => {
      if (event.button !== 0 || (event.target as Element).closest('.vsc-node')) return;
      drag = { id: event.pointerId, x: event.clientX, y: event.clientY, start: { ...viewport }, moved: false };
      stage.dataset.dragging = 'true';
      canvas.setPointerCapture?.(event.pointerId);
    });
    canvas.addEventListener('pointermove', event => {
      if (!drag || event.pointerId !== drag.id) return;
      const dx = event.clientX - drag.x;
      const dy = event.clientY - drag.y;
      drag.moved ||= Math.abs(dx) + Math.abs(dy) > 3;
      viewport = { ...drag.start, x: drag.start.x + dx, y: drag.start.y + dy };
      applyTransform();
    });
    const endDrag = (event: PointerEvent) => {
      if (event.pointerId !== drag?.id) return;
      drag = undefined;
      stage.dataset.dragging = 'false';
      if (canvas.hasPointerCapture?.(event.pointerId)) canvas.releasePointerCapture?.(event.pointerId);
    };
    canvas.addEventListener('pointerup', endDrag);
    canvas.addEventListener('pointercancel', endDrag);
    canvas.addEventListener('lostpointercapture', () => { drag = undefined; stage.dataset.dragging = 'false'; });
    const resize = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(() => {
      // Resizing must not replace a user's pan/zoom; Fit is an explicit action.
      if (!fitted && snapshot?.units.length) fit();
    });
    resize?.observe(stage);
    const unsubscribe = host.subscribe(() => { updateActivity(); if (!formOpen) renderInspector(); });
    function dispose(): void {
      if (disposed) return;
      disposed = true;
      if (timer) clearTimeout(timer);
      stopWatch?.();
      unsubscribe();
      resize?.disconnect();
      media?.removeEventListener('change', setMotion);
      initial.signal.removeEventListener('abort', dispose);
      ledger.clear();
      root.remove();
    }
    initial.signal.addEventListener('abort', dispose, { once: true });
    if (initial.signal.aborted) dispose();
    else { startWatch(); updateHealth(); }
    return {
      focus: () => canvas.focus(),
      update(next) { const previous = context.props.unit; context = next; if (next.props.unit && next.props.unit !== previous && snapshot?.units.some(unit => unit.id === next.props.unit)) choose(next.props.unit, true); updateActivity(); },
      dispose,
    };
  };
}
