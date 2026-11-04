import type { ControlUiView } from 'openclaw/plugin-sdk/control-ui';
import type { VsmSnapshot } from '../backend/vsm-snapshot.js';
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
function cell(row: HTMLTableRowElement, text = '', className = ''): HTMLTableCellElement {
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

/**
 * Runtime view: durable purposes, homeostat channels, effects, alarms and grants.
 * Read-only. It never launches work, acknowledges an alarm or changes authority.
 */
export function runtimeView(client: UiClient): ControlUiView {
  return (container, initial) => {
    const host = initial.host;
    const root = installRoot(container, 'Viable System Claw runtime');
    const toolbar = element('header', 'vsc-toolbar');
    const heading = element('div', 'vsc-toolbar-title');
    const health = element('span', 'vsc-health', 'Loading');
    health.setAttribute('role', 'status');
    heading.append(element('h1', '', 'Runtime'), health);
    toolbar.append(heading, button('Refresh', () => { void load(); }));
    const notice = element('p', 'vsc-notice', 'Read-only runtime projection. Acknowledging alarms and changing grants are not available on this page.');
    const error = element('p', 'vsc-notice vsc-error');
    error.hidden = true;
    error.setAttribute('role', 'alert');
    const body = element('div', 'vsc-runtime');
    root.append(toolbar, notice, error, body);
    let snapshot: VsmSnapshot | undefined;
    let disposed = false;
    let stopWatch: (() => void) | undefined;

    function render(): void {
      if (disposed || !snapshot) return;
      body.replaceChildren();
      if (snapshot.runtime === 'disabled') {
        body.append(element('p', 'vsc-runtime-empty', 'The durable runtime is not enabled on this Gateway. Set runtime configuration to inspect live purposes, effects and alarms.'));
        return;
      }
      const purposes = section('Purposes');
      if (!snapshot.purposes.length) purposes.append(element('p', 'vsc-runtime-empty', 'No viable unit has a purpose yet.'));
      else {
        const grid = table(['Unit', 'Purpose', 'Converged', 'Exits']);
        for (const purpose of snapshot.purposes) {
          const row = element('tr');
          const unit = cell(row);
          const link = element('a', '', purpose.unitId);
          link.href = host.navigation.pageHref({ id: 'organization', params: { unit: purpose.unitId } });
          unit.append(link);
          cell(row, purpose.description || 'No declared purpose', 'vsc-wrap');
          cell(row, purpose.converged ? 'Yes' : 'No', purpose.converged ? '' : 'vsc-warn');
          cell(row, purpose.exits.map(exit => `${exit.id}: ${exit.declared.toFixed(2)} (${exit.error.toFixed(3)})`).join(', ') || 'None', 'vsc-wrap vsc-subtle');
          grid.body.append(row);
        }
        purposes.append(grid.wrap);
      }
      const channels = section('Homeostat channels');
      if (!snapshot.channels.length) channels.append(element('p', 'vsc-runtime-empty', 'No channels recorded.'));
      else {
        const grid = table(['Channel', 'Kind', 'Phase', 'Evidence', 'Observations', 'Procedure']);
        for (const channel of snapshot.channels) {
          const row = element('tr');
          cell(row, channel.id, 'vsc-wrap');
          cell(row, channel.kind);
          cell(row, channel.phase);
          cell(row, channel.value.toFixed(2));
          cell(row, String(channel.observations));
          cell(row, channel.procedureId ?? 'Observe only', channel.procedureId ? '' : 'vsc-subtle');
          grid.body.append(row);
        }
        channels.append(grid.wrap);
      }
      const effects = section('Effects');
      if (!snapshot.effects.length) effects.append(element('p', 'vsc-runtime-empty', 'No effect has been admitted.'));
      else {
        const grid = table(['Effect', 'Status', 'Sequence', 'Native run', 'Outcome', 'Environment', 'Intent at']);
        for (const effect of snapshot.effects) {
          const row = element('tr');
          cell(row, effect.id, 'vsc-wrap');
          cell(row, effect.status);
          cell(row, String(effect.sequence));
          cell(row, effect.nativeId ?? 'None', effect.nativeId ? 'vsc-subtle vsc-wrap' : 'vsc-subtle');
          cell(row, effect.outcomeValue === undefined ? 'Pending' : effect.outcomeValue.toFixed(2));
          cell(row, effect.environmentRef ?? 'Awaiting readback', effect.environmentRef ? 'vsc-subtle vsc-wrap' : 'vsc-warn');
          cell(row, time(effect.at), 'vsc-subtle');
          grid.body.append(row);
        }
        effects.append(grid.wrap);
      }
      const alarms = section('Alarms');
      if (!snapshot.alarms.length) alarms.append(element('p', 'vsc-runtime-empty', 'No alarm recorded.'));
      else {
        const grid = table(['Alarm', 'Class', 'Severity', 'State', 'Raised']);
        for (const alarm of snapshot.alarms) {
          const row = element('tr');
          cell(row, alarm.id, 'vsc-wrap');
          cell(row, alarm.alarmClass);
          cell(row, alarm.severity.toFixed(2));
          cell(row, alarm.state, alarm.state === 'raised' ? 'vsc-warn' : '');
          cell(row, alarm.raisedAt === undefined ? 'Not raised' : time(alarm.raisedAt), 'vsc-subtle');
          grid.body.append(row);
        }
        alarms.append(grid.wrap);
      }
      const grants = section('Grants');
      if (!snapshot.grants.length) grants.append(element('p', 'vsc-runtime-empty', 'No grant exists; admission is closed.'));
      else {
        const grid = table(['Grant', 'Unit', 'Version', 'Capacity', 'Valid until', 'Revoked']);
        for (const grant of snapshot.grants) {
          const row = element('tr');
          cell(row, grant.id, 'vsc-wrap');
          cell(row, grant.unitId);
          cell(row, String(grant.version));
          cell(row, String(grant.capacity));
          cell(row, time(grant.validUntil), 'vsc-subtle');
          cell(row, grant.revokedAt === undefined ? 'No' : time(grant.revokedAt), grant.revokedAt === undefined ? '' : 'vsc-warn');
          grid.body.append(row);
        }
        grants.append(grid.wrap);
      }
      health.dataset.state = host.connection.connected ? 'live' : 'disconnected';
      health.textContent = host.connection.connected
        ? `Revision ${snapshot.revision} · ${time(snapshot.updatedAt)}`
        : 'Disconnected; showing the last received state.';
      root.setAttribute('aria-busy', 'false');
    }

    async function load(): Promise<void> {
      if (disposed) return;
      error.hidden = true;
      root.setAttribute('aria-busy', 'true');
      try {
        snapshot = await client.invoke('vsm.snapshot', {});
        render();
      } catch (cause) {
        error.textContent = errorText(cause);
        error.hidden = false;
        health.dataset.state = 'error';
        health.textContent = 'Unavailable';
      } finally {
        root.setAttribute('aria-busy', 'false');
      }
    }

    stopWatch = client.watch('vsm.snapshot', {}, {
      events: ['vsm', 'alarm', 'changed'],
      onChange: output => { if (!disposed) { snapshot = output; render(); } },
      onError: cause => { if (!disposed) { error.textContent = errorText(cause); error.hidden = false; } },
    });
    void load();
    const dispose = (): void => { disposed = true; stopWatch?.(); };
    initial.signal.addEventListener('abort', dispose, { once: true });
    if (initial.signal.aborted) dispose();
    return {
      focus: () => root.querySelector<HTMLButtonElement>('button')?.focus(),
      update: () => { if (snapshot) render(); },
      dispose,
    };
  };
}
