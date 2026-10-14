import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import type { GuardedIpcRegistrar } from '../ipc/guarded-ipc';
import { registerHookIpc } from './ipc';
import { DesktopHookSettings } from './settings';
import { HookService } from './service';

vi.mock('electron', () => ({ shell: {} }));

it('applies saved and reloaded configuration to commands, disabling intake on a broken file', async () => {
  const root = await mkdtemp(join(tmpdir(), 'silverhand-hook-ipc-'));
  const settings = new DesktopHookSettings({
    hooks: join(root, 'hooks.json'),
    preferences: join(root, 'preferences.json'),
  });
  const service = new HookService();
  const handlers = new Map<string, Function>();
  registerHookIpc(
    {
      handle: (channel, listener) => {
        handlers.set(channel, listener);
      },
      on: () => {},
    } satisfies GuardedIpcRegistrar,
    settings,
    service,
    () => ({ identity: 'server/alice', scope: 'viewer:alice', current: () => true }),
  );
  const invoke = (channel: string, ...args: unknown[]) => handlers.get(channel)!({}, ...args);
  const rule = {
    id: 'mention',
    name: 'Mention',
    enabled: true,
    event: 'notification',
    action: { type: 'command', command: 'cat' },
  };
  try {
    await writeFile(
      settings.paths.hooks,
      JSON.stringify({ version: 1, hooks: [{ ...rule, enabled: false }] }),
    );
    const initial = await invoke('hooks:load');
    const saved = await invoke('hooks:toggle', {
      source: settings.paths.hooks,
      revision: initial.revision,
      index: 0,
      enabled: true,
    });
    expect(saved.entries[0].rule).toEqual(rule);
    const lease = await invoke('hooks:begin');
    const deliver = (seq: number) =>
      invoke('hooks:deliver', {
        lease,
        frames: [
          {
            type: 'event',
            scope: 'viewer:alice',
            epoch: 'one',
            seq,
            kind: 'notification',
            payload: { kind: 'mention_self' },
          },
        ],
      });
    await deliver(1);
    await expect.poll(async () => (await invoke('hooks:runs'))[0]?.status).toBe('succeeded');
    await writeFile(
      settings.paths.hooks,
      JSON.stringify({ version: 1, hooks: [{ ...rule, enabled: false }] }),
    );
    await invoke('hooks:load');
    await deliver(2);
    expect(await invoke('hooks:runs')).toHaveLength(1);
    await writeFile(settings.paths.hooks, JSON.stringify({ version: 1, hooks: [rule] }));
    await invoke('hooks:load');
    await deliver(3);
    await expect.poll(async () => (await invoke('hooks:runs'))[0]?.status).toBe('succeeded');
    expect(await invoke('hooks:runs')).toHaveLength(2);
    await writeFile(settings.paths.hooks, '{broken');
    expect((await invoke('hooks:load')).error).toBeTruthy();
    await deliver(4);
    expect(await invoke('hooks:runs')).toHaveLength(2);
  } finally {
    await service.shutdown();
    await rm(root, { recursive: true, force: true });
  }
});
