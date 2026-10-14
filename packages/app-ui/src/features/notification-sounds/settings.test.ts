// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { NotificationSettingsPane } from './settings-pane';
import type { NotificationSoundsCapability } from '@silverhand/client';
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
it('chooses and previews a custom sound without exposing commands, and preserves it when muted', async () => {
  const sound = { id: 'test.ogg', name: 'My mention.ogg' };
  const api: NotificationSoundsCapability = {
    load: async () => ({
      path: '/preferences.json',
      revision: 'one',
      notificationSoundEnabled: true,
    }),
    chooseFile: vi.fn(async () => sound),
    preview: vi.fn(async () => {}),
    save: vi.fn(async (input) => ({ ...input, path: '/preferences.json', revision: 'two' })),
  };
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const click = async (label: string) => {
    const button = [...container.querySelectorAll('button')].find((b) =>
      b.textContent?.includes(label),
    );
    expect(button).toBeTruthy();
    await act(async () => button!.click());
  };
  try {
    await act(async () => root.render(createElement(NotificationSettingsPane, { api })));
    expect(container.querySelector('textarea')).toBeNull();
    expect(container.textContent).not.toContain('hooks.json');
    await click('Choose audio file');
    expect(api.preview).toHaveBeenCalledWith(sound);
    expect(api.save).toHaveBeenCalledWith({
      revision: 'one',
      notificationSoundEnabled: true,
      notificationSound: sound,
    });
    expect(container.textContent).toContain('My mention.ogg');
    await click('Preview');
    expect(api.preview).toHaveBeenCalledTimes(2);
    await act(async () => container.querySelector<HTMLButtonElement>('[role="switch"]')!.click());
    expect(api.save).toHaveBeenLastCalledWith({
      revision: 'two',
      notificationSoundEnabled: false,
      notificationSound: sound,
    });
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});
