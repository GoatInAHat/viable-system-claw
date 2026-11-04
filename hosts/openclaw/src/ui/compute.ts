import type { ControlUiView } from 'openclaw/plugin-sdk/control-ui';
import type { ComputeSnapshot } from '../model.js';
import { STALE_MS } from './graph-state.js';
import { button, element, errorText, installRoot, time } from './shared.js';
import type { UiClient } from './shared.js';

function table(headers: string[]): { wrap: HTMLElement; body: HTMLTableSectionElement } {
  const wrap = element('div', 'vsc-table-wrap');
  const table = element('table');
  const head = element('thead');
  const row = element('tr');
  for (const label of headers) {
    const cell = element('th', '', label);
    cell.scope = 'col';
    row.append(cell);
  }
  head.append(row);
  const body = element('tbody');
  table.append(head, body);
  wrap.append(table);
  return { wrap, body };
}
function cell(row: HTMLTableRowElement, text?: string, className = ''): HTMLTableCellElement {
  const node = element('td', className, text);
  row.append(node);
  return node;
}
function section(title: string): HTMLElement {
  const node = element('section');
  const heading = element('div', 'vsc-section-heading');
  heading.append(element('h2', '', title));
  node.append(heading);
  return node;
}

export function computeView(client: UiClient): ControlUiView {
  return (container, initial) => {
    let context = initial;
    const host = context.host;
    const root = installRoot(container, 'Viable System Claw compute allocation');
    const toolbar = element('header', 'vsc-toolbar');
    const heading = element('div', 'vsc-toolbar-title');
    const health = element('span', 'vsc-health', 'Loading');
    health.setAttribute('role', 'status');
    heading.append(element('h1', '', 'Compute allocation'), health);
    toolbar.append(heading, button('Refresh', () => startWatch()));
    const notice = element('p', 'vsc-notice');
    notice.hidden = true;
    const error = element('p', 'vsc-notice vsc-error');
    error.hidden = true;
    error.setAttribute('role', 'alert');
    const body = element('div', 'vsc-compute');
    body.append(element('p', 'vsc-compute-empty', 'Waiting for allocator observations.'));
    root.append(toolbar, notice, error, body);
    let snapshot: ComputeSnapshot | undefined;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stopWatch: (() => void) | undefined;
    const freshness = (at: number) => Date.now() - at > STALE_MS ? 'Stale' : 'Observed';
    function updateHealth(): void {
      if (disposed) return;
      const disconnected = !host.connection.connected;
      const stale = !!snapshot && Date.now() - snapshot.observedAt > STALE_MS;
      const empty = !!snapshot && !snapshot.pools.length && !snapshot.models.length && !snapshot.allocations.length;
      health.dataset.state = disconnected ? 'disconnected' : !snapshot ? 'loading' : empty ? 'partial' : stale ? 'stale' : 'live';
      health.textContent = disconnected ? 'Disconnected' : !snapshot ? 'Loading' : empty ? 'No observations' : stale ? 'Stale observations' : 'Allocator observations';
      const messages = ['Observations only. This page does not launch work or change admission.'];
      if (disconnected) messages.push('Gateway disconnected; showing the last received data.');
      if (stale && !empty) messages.push('Allocator data is older than one minute; capacity and quotas may have changed.');
      notice.textContent = messages.join(' ');
      notice.hidden = false;
      root.setAttribute('aria-busy', String(!snapshot));
      if (timer) clearTimeout(timer);
      if (context.presented && snapshot) {
        const dates = [snapshot.observedAt, ...snapshot.pools.map(pool => pool.observedAt), ...snapshot.models.map(model => model.observedAt)];
        const next = Math.min(...dates.map(at => at + STALE_MS + 1).filter(at => at > Date.now()));
        if (Number.isFinite(next)) timer = setTimeout(() => { render(); }, Math.min(next - Date.now() + 1, 2_147_483_647));
      }
    }
    function render(): void {
      if (disposed || !snapshot) return;
      const pools = section('Capacity and quotas');
      if (!snapshot.pools.length) pools.append(element('p', 'vsc-compute-empty', 'No compute pools have been observed. Capacity and quota availability are unknown; an allocator must publish observations first.'));
      else {
        const grid = table(['Pool', 'Availability', 'Concurrency', 'Quota windows', 'Observed']);
        for (const pool of snapshot.pools) {
          const row = element('tr');
          const name = cell(row);
          name.append(element('strong', '', pool.label), element('p', 'vsc-subtle', `${pool.kind} · ${pool.id}`));
          cell(row, pool.status);
          cell(row, `${pool.active === undefined ? 'Unknown' : pool.active} active / ${pool.concurrency === undefined ? 'unknown capacity' : `${pool.concurrency} capacity`}`);
          const quotas = cell(row);
          if (!pool.windows.length) quotas.textContent = 'No quota windows observed';
          for (const window of pool.windows) {
            const quota = element('div', 'vsc-quota');
            const label = element('div', 'vsc-quota-label');
            label.append(element('span', '', window.label), element('span', '', `${Math.round(window.usedFraction * 100)}% used`));
            const progress = element('progress');
            progress.max = 1;
            progress.value = window.usedFraction;
            progress.setAttribute('aria-label', `${pool.label}: ${window.label} quota used`);
            quota.append(label, progress, element('p', 'vsc-subtle', window.resetsAt === undefined ? 'Reset time unknown' : `Resets ${time(window.resetsAt)}`));
            if (window.windowMs !== undefined) quota.append(element('p', 'vsc-subtle', `${Math.round(window.windowMs / 60_000)} minute window`));
            quotas.append(quota);
          }
          cell(row, `${freshness(pool.observedAt)} ${time(pool.observedAt)}`, 'vsc-subtle');
          grid.body.append(row);
        }
        pools.append(grid.wrap);
      }
      const models = section('Model profiles');
      if (!snapshot.models.length) models.append(element('p', 'vsc-compute-empty', 'No model profiles have been observed. Quality, latency and quota cost are unknown.'));
      else {
        const grid = table(['Model', 'Pool', 'Capabilities', 'Evidence', 'Quota cost', 'Observed']);
        for (const model of snapshot.models) {
          const row = element('tr');
          const name = cell(row);
          name.append(element('strong', '', model.label), element('p', 'vsc-subtle', model.id));
          cell(row, snapshot.pools.find(pool => pool.id === model.poolId)?.label ?? `${model.poolId} (pool unavailable)`);
          cell(row, model.capabilities.join(', ') || 'Unknown', 'vsc-wrap');
          const evidence = cell(row);
          evidence.append(element('p', '', `Quality: ${model.quality === undefined ? 'unknown' : `${Math.round(model.quality * 100)}%`}`), element('p', 'vsc-subtle', `${model.samples} sample${model.samples === 1 ? '' : 's'}`), element('p', 'vsc-subtle', `Latency: ${model.latencyMs === undefined ? 'unknown' : `${model.latencyMs.toLocaleString()} ms`}`));
          const costs = Object.entries(model.quotaCost ?? {});
          cell(row, costs.length ? costs.map(([window, cost]) => `${window}: ${cost}`).join(', ') : 'Unknown', 'vsc-wrap');
          cell(row, `${freshness(model.observedAt)} ${time(model.observedAt)}`, 'vsc-subtle');
          grid.body.append(row);
        }
        models.append(grid.wrap);
      }
      const allocations = section('Allocation decisions');
      if (!snapshot.allocations.length) allocations.append(element('p', 'vsc-compute-empty', 'No allocation decisions recorded. No resources are assumed to be assigned.'));
      else {
        const grid = table(['System', 'Model', 'Decision', 'Reason', 'Recorded']);
        for (const allocation of [...snapshot.allocations].sort((a, b) => b.at - a.at)) {
          const row = element('tr');
          const unit = cell(row);
          const link = element('a', '', allocation.unitId);
          link.href = host.navigation.pageHref({ id: 'organization', params: { unit: allocation.unitId } });
          link.addEventListener('click', event => {
            if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
            event.preventDefault();
            host.navigation.openPage({ id: 'organization', params: { unit: allocation.unitId } });
          });
          unit.append(link);
          cell(row, allocation.modelId ? snapshot.models.find(model => model.id === allocation.modelId)?.label ?? allocation.modelId : 'Not assigned');
          cell(row, allocation.status);
          cell(row, allocation.reason || 'No reason recorded', 'vsc-wrap');
          cell(row, time(allocation.at), 'vsc-subtle');
          grid.body.append(row);
        }
        allocations.append(grid.wrap);
      }
      const observed = element('p', 'vsc-subtle', `Snapshot ${snapshot.revision} · ${time(snapshot.observedAt)}`);
      body.replaceChildren(pools, models, allocations, observed);
      updateHealth();
    }
    function startWatch(): void {
      if (disposed || context.signal.aborted) return;
      stopWatch?.();
      error.hidden = true;
      stopWatch = client.watch('compute.snapshot', {}, {
        events: ['changed'],
        onChange(next) {
          if (disposed || context.signal.aborted || (snapshot && next.revision < snapshot.revision)) return;
          snapshot = next;
          error.hidden = true;
          render();
        },
        onError(cause) {
          if (disposed || context.signal.aborted) return;
          error.textContent = host.redact(errorText(cause));
          error.hidden = false;
          updateHealth();
        },
      });
    }
    const unsubscribe = host.subscribe(() => { if (snapshot) render(); else updateHealth(); });
    function dispose(): void {
      if (disposed) return;
      disposed = true;
      if (timer) clearTimeout(timer);
      stopWatch?.();
      unsubscribe();
      initial.signal.removeEventListener('abort', dispose);
      root.remove();
    }
    initial.signal.addEventListener('abort', dispose, { once: true });
    if (initial.signal.aborted) dispose();
    else { startWatch(); updateHealth(); }
    return { focus: () => root.querySelector<HTMLButtonElement>('button')?.focus(), update(next) { context = next; if (snapshot) render(); else updateHealth(); }, dispose };
  };
}
