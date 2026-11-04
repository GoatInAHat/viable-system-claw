import type { Activity, GraphSnapshot, Relation, Unit } from '../model.js';

export const RECENT_MS = 8_000;
export const STALE_MS = 60_000;
// Without a matching end or fresh observation, activity becomes unknown, not perpetual.
export const ACTIVE_MS = 120_000;
export interface Box { x: number; y: number; width: number; height: number }
export interface GraphNode extends Box { unit: Unit; depth: number; children: number; descendants: number }
export interface GraphEdge { id: string; source: string; target: string; label: string; kind: Relation['kind']; count: number; relationIds: string[] }
export interface GraphLayout { nodes: GraphNode[]; edges: GraphEdge[]; width: number; height: number; warnings: string[] }
export interface Viewport { x: number; y: number; scale: number }
export interface ActivityState { runs: Activity[]; tools: Activity[]; recent: Activity[]; expired: Activity[] }

/** One deterministic containment forest drives layout, edge projection, and keyboard order. */
export function layoutGraph(snapshot: GraphSnapshot, collapsed: ReadonlySet<string>): GraphLayout {
  const units = new Map(snapshot.units.map(unit => [unit.id, unit]));
  const parents = new Map<string, string>();
  const warnings: string[] = [];
  for (const unit of units.values()) {
    if (!unit.parentId) continue;
    let cursor: string | undefined = unit.parentId;
    const seen = new Set([unit.id]);
    while (cursor && units.has(cursor) && !seen.has(cursor)) {
      seen.add(cursor);
      cursor = units.get(cursor)?.parentId;
    }
    if (cursor && seen.has(cursor)) warnings.push(`Containment cycle at ${unit.name}; shown at the top level.`);
    else if (!units.has(unit.parentId)) warnings.push(`Parent of ${unit.name} is unavailable; shown at the top level.`);
    else parents.set(unit.id, unit.parentId);
  }
  const children = new Map<string, Unit[]>();
  const roots: Unit[] = [];
  for (const unit of units.values()) {
    const parent = parents.get(unit.id);
    if (!parent) roots.push(unit);
    else children.set(parent, [...(children.get(parent) ?? []), unit]);
  }
  const byName = (a: Unit, b: Unit) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id);
  roots.sort(byName);
  for (const list of children.values()) list.sort(byName);
  const nodes: GraphNode[] = [];
  const descendantCounts = new Map<string, number>();
  const count = (id: string): number => {
    const total = (children.get(id) ?? []).reduce((n, child) => n + 1 + count(child.id), 0);
    descendantCounts.set(id, total);
    return total;
  };
  roots.forEach(unit => count(unit.id));
  const size = new Map<string, { width: number; height: number }>();
  const measure = (unit: Unit): { width: number; height: number } => {
    const list = collapsed.has(unit.id) ? [] : (children.get(unit.id) ?? []);
    const measured = list.map(measure);
    const cols = Math.min(2, measured.length);
    const widths = Array.from({ length: cols }, (_, col) => Math.max(...measured.filter((_, i) => i % cols === col).map(box => box.width)));
    const rows = Array.from({ length: Math.ceil(measured.length / (cols || 1)) }, (_, row) => Math.max(...measured.slice(row * cols, (row + 1) * cols).map(box => box.height)));
    const box = list.length ? { width: widths.reduce((a, b) => a + b, 0) + (cols - 1) * 28 + 48, height: rows.reduce((a, b) => a + b, 0) + (rows.length - 1) * 28 + 100 } : { width: 252, height: 106 };
    size.set(unit.id, box);
    return box;
  };
  roots.forEach(measure);
  const place = (unit: Unit, x: number, y: number, depth: number) => {
    const box = size.get(unit.id)!;
    const list = children.get(unit.id) ?? [];
    nodes.push({ unit, x, y, ...box, depth, children: list.length, descendants: descendantCounts.get(unit.id) ?? 0 });
    if (collapsed.has(unit.id)) return;
    const cols = Math.min(2, list.length);
    const colWidths = Array.from({ length: cols }, (_, col) => Math.max(...list.filter((_, i) => i % cols === col).map(child => size.get(child.id)!.width)));
    let rowY = y + 76;
    for (let row = 0; row < Math.ceil(list.length / (cols || 1)); row++) {
      let colX = x + 24;
      let rowHeight = 0;
      for (let col = 0; col < cols; col++) {
        const child = list[row * cols + col];
        if (!child) continue;
        place(child, colX, rowY, depth + 1);
        rowHeight = Math.max(rowHeight, size.get(child.id)!.height);
        colX += colWidths[col]! + 28;
      }
      rowY += rowHeight + 28;
    }
  };
  // Place independent roots in rows so large organizations do not become a single strip.
  const cols = Math.min(2, roots.length);
  const rootWidths = Array.from({ length: cols }, (_, col) => Math.max(...roots.filter((_, i) => i % cols === col).map(unit => size.get(unit.id)!.width)));
  let y = 40;
  for (let row = 0; row < Math.ceil(roots.length / (cols || 1)); row++) {
    let x = 40;
    let height = 0;
    for (let col = 0; col < cols; col++) {
      const unit = roots[row * cols + col];
      if (!unit) continue;
      place(unit, x, y, 1);
      height = Math.max(height, size.get(unit.id)!.height);
      x += rootWidths[col]! + 72;
    }
    y += height + 64;
  }
  const visible = new Set(nodes.map(node => node.unit.id));
  const representative = (id: string): string | undefined => {
    while (units.has(id) && !visible.has(id)) {
      const parent = parents.get(id);
      if (!parent) return undefined;
      id = parent;
    }
    return visible.has(id) ? id : undefined;
  };
  const edges = new Map<string, GraphEdge>();
  for (const relation of snapshot.relations) {
    const source = representative(relation.source);
    const target = representative(relation.target);
    if (!source || !target || source === target) continue;
    const key = JSON.stringify([source, target, relation.kind]);
    const existing = edges.get(key);
    if (existing) {
      existing.count++;
      existing.relationIds.push(relation.id);
      existing.label = `${existing.count} ${relation.kind} links`;
    } else edges.set(key, { id: relation.id, source, target, label: relation.label || relation.kind, kind: relation.kind, count: 1, relationIds: [relation.id] });
  }
  return { nodes, edges: [...edges.values()], width: Math.max(360, ...nodes.map(node => node.x + node.width + 40)), height: Math.max(240, ...nodes.map(node => node.y + node.height + 40)), warnings };
}

export function activityState(activities: readonly Activity[], now: number): ActivityState {
  const runs = new Map<string, Activity>();
  const tools = new Map<string, Activity>();
  const recent: Activity[] = [];
  const expired: Activity[] = [];
  const ordered = [...activities].sort((a, b) => a.at - b.at || Number(a.kind.endsWith('end')) - Number(b.kind.endsWith('end')));
  for (const event of ordered) {
    if (!Number.isFinite(event.at) || event.at > now + 5_000) continue;
    const run = JSON.stringify([event.unitId, event.runId]);
    const tool = JSON.stringify([event.unitId, event.runId, event.toolCallId]);
    if (event.kind === 'run-start' && event.runId) runs.set(run, event);
    if (event.kind === 'run-end' && event.runId) {
      runs.delete(run);
      for (const [key, start] of tools) if (start.unitId === event.unitId && start.runId === event.runId) tools.delete(key);
    }
    if (event.kind === 'tool-start' && event.toolCallId) tools.set(tool, event);
    if (event.kind === 'tool-end' && event.toolCallId) tools.delete(tool);
    if (now - event.at >= 0 && now - event.at < RECENT_MS) recent.push(event);
  }
  const fresh = (events: Map<string, Activity>) => [...events.values()].filter(event => {
    if (now - event.at >= ACTIVE_MS) { expired.push(event); return false; }
    return true;
  });
  return { runs: fresh(runs), tools: fresh(tools), recent, expired };
}

export function zoomAt(view: Viewport, factor: number, x: number, y: number): Viewport {
  const scale = Math.max(0.02, Math.min(3, view.scale * factor));
  const ratio = scale / view.scale;
  return { scale, x: x - (x - view.x) * ratio, y: y - (y - view.y) * ratio };
}
export function fitViewport(width: number, height: number, content: Pick<GraphLayout, 'width' | 'height'>): Viewport {
  const scale = Math.max(0.02, Math.min(1.25, (width - 48) / content.width, (height - 48) / content.height));
  return { scale, x: (width - content.width * scale) / 2, y: (height - content.height * scale) / 2 };
}
export function graphHealth(snapshot: GraphSnapshot | undefined, connected: boolean, now: number): 'loading' | 'disconnected' | 'stale' | 'partial' | 'live' {
  if (!connected || snapshot?.coverage === 'disconnected') return 'disconnected';
  if (!snapshot) return 'loading';
  if (now - snapshot.observedAt > STALE_MS) return 'stale';
  return snapshot.coverage === 'partial' ? 'partial' : 'live';
}
