import { describe, expect, it, vi } from 'vitest';
import type { ControlUiHost } from 'openclaw/plugin-sdk/control-ui';
import plugin from '../control-ui.js';

describe('native Control UI contribution boundary', () => {
  it('registers organization, compute and runtime pages/navigation and cleans up activation', async () => {
    const removals = Array.from({ length: 6 }, () => vi.fn());
    const registerPage = vi.fn()
      .mockReturnValueOnce(removals[0]).mockReturnValueOnce(removals[1]).mockReturnValueOnce(removals[2]);
    const registerNavigation = vi.fn()
      .mockReturnValueOnce(removals[3]).mockReturnValueOnce(removals[4]).mockReturnValueOnce(removals[5]);
    const host = {
      pluginId: 'viable-system-claw', signal: new AbortController().signal,
      connection: { connected: true }, ui: { registerPage, registerNavigation },
    } as unknown as ControlUiHost;
    const dispose = await plugin.activate(host);
    expect(registerPage.mock.calls.map(([page]) => page.id)).toEqual(['organization', 'compute', 'runtime']);
    expect(registerPage.mock.calls.every(([page]) => typeof page.mount === 'function')).toBe(true);
    expect(registerNavigation).toHaveBeenCalledWith(expect.objectContaining({ id: 'organization', page: { id: 'organization' } }));
    expect(registerNavigation).toHaveBeenCalledWith(expect.objectContaining({ id: 'compute', parent: 'organization', page: { id: 'compute' } }));
    expect(registerNavigation).toHaveBeenCalledWith(expect.objectContaining({ id: 'runtime', parent: 'organization', page: { id: 'runtime' } }));
    expect(typeof dispose).toBe('function');
    if (dispose) dispose();
    removals.forEach(remove => expect(remove).toHaveBeenCalledTimes(1));
  });
});
