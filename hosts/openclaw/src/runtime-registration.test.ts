import { describe, expect, it, vi } from 'vitest';
import type { OpenClawPluginApi } from 'openclaw/plugin-sdk/core';
import entry, { contract } from './index.js';
import { readDocument, VSM_DOCUMENT_KEY } from './vsm/state.js';

type Entry = { value: unknown; version: number };

function keyedRegistration(pluginConfig?: Record<string, unknown>) {
  const stores = new Map<string, Entry>();
  const store = {
    lookup: async (key: string) => structuredClone(stores.get(key)?.value),
    observe: async (key: string) => ({
      value: structuredClone(stores.get(key)?.value),
      comparison: { version: stores.get(key)?.version ?? 0 },
    }),
    compareAndApply: async (key: string, comparison: unknown, intent: { value: unknown }) => {
      const current = stores.get(key)?.version ?? 0;
      if ((comparison as { version: number }).version !== current) return { status: 'conflict' as const };
      stores.set(key, { value: structuredClone(intent.value), version: current + 1 });
      return { status: 'applied' as const };
    },
  };
  const openStore = vi.fn(() => store);
  const services: Array<{ id: string; start: (context: unknown) => Promise<unknown>; stop?: (context: unknown) => Promise<unknown> }> = [];
  const api = {
    id: 'viable-system-claw', pluginConfig, logger: { warn: vi.fn() },
    runtime: { state: { openKeyedStoreV2: openStore }, agent: { session: { getSessionEntryAsync: async () => ({ sessionId: 'native' }) } } },
    registerService: (service: typeof services[number]) => services.push(service),
    registerSessionAction: vi.fn(), registerTool: vi.fn(), on: vi.fn(),
    agent: { events: { registerAgentEventSubscription: vi.fn() } },
  };
  entry.register(api as unknown as OpenClawPluginApi);
  const start = async () => { for (const service of services) await service.start({ gatewayEvents: { emit: vi.fn() } }); };
  const stop = async () => { for (const service of [...services].reverse()) await service.stop?.({ gatewayEvents: { emit: vi.fn() } }); };
  return { services, openStore, start, stop, store };
}

describe('opt-in runtime registration', () => {
  it('adds nothing when the plugin config does not enable the runtime', () => {
    const r = keyedRegistration();
    const ids = r.services.map(s => s.id);
    expect(ids).toContain('viable-system-claw:backend');
    expect(ids).not.toContain('viable-system-claw:runtime');
    expect(r.openStore).toHaveBeenCalledTimes(1);
    expect(r.openStore).toHaveBeenCalledWith({ namespace: 'organization', retention: 'retained' });
  });

  it('registers a separate retained store and service when enabled', async () => {
    const r = keyedRegistration({ runtime: { enabled: true, principalId: 'human', charter: 'Keep it observable' } });
    const ids = r.services.map(s => s.id);
    expect(ids).toContain('viable-system-claw:runtime');
    expect(ids).toContain('viable-system-claw:backend');
    expect(r.openStore).toHaveBeenCalledWith({ namespace: 'vsm', retention: 'retained' });
    await r.start();
    const observed = await r.store.observe(VSM_DOCUMENT_KEY);
    const durable = readDocument(observed.value);
    expect(durable?.state.units.root.id).toBe('root');
    expect(durable?.state.units.canary.parentId).toBe('root');
    await r.stop();
  });

  it('refuses an enabled runtime without a principal and charter', () => {
    expect(() => keyedRegistration({ runtime: { enabled: true } })).toThrow('VSC_RUNTIME_CONFIG');
  });

  it('keeps the published contract unchanged', () => {
    expect(contract.pluginId).toBe('viable-system-claw');
  });
});
