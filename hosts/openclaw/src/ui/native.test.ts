import { describe, expect, it, vi } from 'vitest';
import type { ControlUiHost } from 'openclaw/plugin-sdk/control-ui';
import plugin from '../control-ui.js';

describe('native Control UI contribution boundary', () => {
  it('registers separate organization and compute pages/navigation and cleans up activation', async () => {
    const removals = Array.from({ length: 4 }, () => vi.fn());
    const registerPage = vi.fn().mockReturnValueOnce(removals[0]).mockReturnValueOnce(removals[1]);
    const registerNavigation = vi.fn().mockReturnValueOnce(removals[2]).mockReturnValueOnce(removals[3]);
    const host = {
      pluginId: 'viable-system-claw', signal: new AbortController().signal,
      connection: { connected: true }, ui: { registerPage, registerNavigation },
    } as unknown as ControlUiHost;
    const dispose = await plugin.activate(host);
    expect(registerPage.mock.calls.map(([page]) => page.id)).toEqual(['organization', 'compute']);
    expect(registerPage.mock.calls.every(([page]) => typeof page.mount === 'function')).toBe(true);
    expect(registerNavigation).toHaveBeenCalledWith(expect.objectContaining({ id: 'organization', page: { id: 'organization' } }));
    expect(registerNavigation).toHaveBeenCalledWith(expect.objectContaining({ id: 'compute', parent: 'organization', page: { id: 'compute' } }));
    expect(typeof dispose).toBe('function');
    if (dispose) dispose();
    removals.forEach(remove => expect(remove).toHaveBeenCalledTimes(1));
  });
});
