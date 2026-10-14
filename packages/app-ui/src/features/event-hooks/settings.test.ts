// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import type { EventHooksCapability } from '@silverhand/client';
import { HookSettingsPane } from './settings-pane';
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
it('shows read-only event groups and opens or toggles the owning source without any editor', async () => {
  const source = '/desktop/hooks.d/log.json';
  const rule = {
    id: 'log',
    name: 'Mention log',
    event: 'notification' as const,
    enabled: true,
    match: { kind: 'mention_self' },
    action: {
      type: 'command' as const,
      command: './log.sh',
      async: true as const,
      cwd: '/scripts',
      env: { MODE: 'log' },
    },
  };
  const snapshot = {
    path: '/desktop/hooks.json',
    revision: 'base',
    sources: [
      { path: source, revision: 'one' },
      { path: '/desktop/hooks.d/bad.json', revision: 'bad', error: 'Broken JSON' },
    ],
    entries: [{ source, revision: 'one', index: 0, rule }],
  };
  const api = {
    loadHooks: vi.fn(async () => snapshot),
    setHookEnabled: vi.fn(async () => ({
      ...snapshot,
      entries: [{ ...snapshot.entries[0]!, rule: { ...rule, enabled: false } }],
    })),
    openSource: vi.fn(async () => {}),
    openDirectory: vi.fn(async () => {}),
    runs: async () => [],
  } as unknown as EventHooksCapability;
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const click = async (label: string) => {
    const el = [...host.querySelectorAll<HTMLElement>('button,summary')].find(
      (e) => e.getAttribute('aria-label') === label || e.textContent === label,
    );
    expect(el).toBeTruthy();
    await act(async () => el!.click());
  };
  try {
    await act(async () => root.render(createElement(HookSettingsPane, { api })));
    expect(host.querySelector('input,textarea,select,form')).toBeNull();
    expect(host.textContent).not.toMatch(/Add .*hook|Save hook|Test command|Delete hook/);
    expect(host.textContent).toContain('Mentions of you');
    expect(host.textContent).toContain('Broken JSON');
    await click('Mention log');
    expect(host.textContent).toContain('./log.sh');
    await click('Open source for Mention log');
    expect(api.openSource).toHaveBeenCalledWith(source);
    await click('Enable Mention log');
    expect(api.setHookEnabled).toHaveBeenCalledWith({
      source,
      revision: 'one',
      index: 0,
      enabled: false,
    });
    expect(host.querySelector('[role="switch"]')?.getAttribute('aria-checked')).toBe('false');
    vi.mocked(api.setHookEnabled).mockRejectedValueOnce(new Error('Configuration changed on disk'));
    await click('Enable Mention log');
    expect(host.textContent).toContain('Configuration changed on disk');
    await click('Reload');
    await click('Open configuration folder');
    expect(api.openDirectory).toHaveBeenCalledOnce();
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});
