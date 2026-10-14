import { mkdtemp, mkdir, rm, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it } from 'vitest';
import { DesktopHookSettings } from './settings';

const roots: string[] = [];
async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'silverhand-hooks-'));
  roots.push(root);
  return {
    root,
    settings: new DesktopHookSettings({
      hooks: join(root, 'hooks.json'),
      preferences: join(root, 'preferences.json'),
    }),
  };
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
it('uses independent defaults without creating configuration files', async () => {
  const { root, settings } = await setup();
  expect((await settings.loadHooks()).entries).toEqual([]);
  expect((await settings.loadPreferences()).notificationSoundEnabled).toBe(true);
  expect(await readdir(root)).toEqual([]);
});

const rule = {
  id: 'mention',
  name: 'Mention',
  enabled: true,
  event: 'notification' as const,
  match: { kind: 'mention_self' },
  action: { type: 'command' as const, command: 'cat' },
};
it('saves rules and sound independently and detects a manual-edit conflict', async () => {
  const { root, settings } = await setup();
  await writeFile(
    settings.paths.hooks,
    JSON.stringify({ version: 1, hooks: [{ ...rule, enabled: false }] }),
  );
  const hooks = await settings.loadHooks();
  await settings.setHookEnabled({
    source: settings.paths.hooks,
    revision: hooks.revision,
    index: 0,
    enabled: true,
  });
  const before = await readFile(join(root, 'hooks.json'), 'utf8');
  const prefs = await settings.loadPreferences();
  await settings.savePreferences({ revision: prefs.revision, notificationSoundEnabled: false });
  expect(await readFile(join(root, 'hooks.json'), 'utf8')).toBe(before);
  const fresh = new DesktopHookSettings(settings.paths);
  expect((await fresh.loadHooks()).entries[0]?.rule).toMatchObject(rule);
  expect((await fresh.loadPreferences()).notificationSoundEnabled).toBe(false);
  const stale = await settings.loadHooks();
  await writeFile(join(root, 'hooks.json'), JSON.stringify({ version: 1, hooks: [] }));
  await expect(
    settings.setHookEnabled({
      source: settings.paths.hooks,
      revision: stale.revision,
      index: 0,
      enabled: false,
    }),
  ).rejects.toThrow(/changed/);
  expect((await settings.loadHooks()).entries).toEqual([]);
});
it('isolates invalid rules and files, preserving invalid entries when another rule is edited', async () => {
  const { root, settings } = await setup();
  const invalid = { id: 'bad', event: 'PreToolUse', future: true };
  await writeFile(join(root, 'hooks.json'), JSON.stringify({ version: 1, hooks: [invalid, rule] }));
  const snapshot = await settings.loadHooks();
  expect(snapshot.entries[0]?.rule).toBeNull();
  expect(snapshot.entries[0]?.error).toBeTruthy();
  expect(snapshot.entries[1]?.rule).toEqual(rule);
  await settings.setHookEnabled({
    source: settings.paths.hooks,
    revision: snapshot.revision,
    index: 1,
    enabled: false,
  });
  expect(JSON.parse(await readFile(join(root, 'hooks.json'), 'utf8')).hooks[0]).toEqual(invalid);
  const prefs = await settings.loadPreferences();
  await settings.savePreferences({ revision: prefs.revision, notificationSoundEnabled: false });
  await writeFile(join(root, 'hooks.json'), '{broken');
  expect(await settings.loadHooks()).toMatchObject({ entries: [], error: expect.any(String) });
  expect(settings.notificationSoundEnabled).toBe(false);
  await writeFile(join(root, 'preferences.json'), '{broken');
  expect((await settings.loadPreferences()).error).toBeTruthy();
  expect(settings.notificationSoundEnabled).toBe(false);
});
it('creates optional default files only when explicitly opening configuration', async () => {
  const { settings } = await setup();
  const paths = settings.paths;
  await settings.prepareConfig('hooks');
  expect(JSON.parse(await readFile(paths.hooks, 'utf8'))).toEqual({ version: 1, hooks: [] });
  await writeFile(paths.hooks, 'broken but user-owned');
  await settings.prepareConfig('hooks');
  expect(await readFile(paths.hooks, 'utf8')).toBe('broken but user-owned');
});
it('rejects an explicit null document instead of treating it as a missing file', async () => {
  const { settings } = await setup();
  await writeFile(settings.paths.hooks, 'null');
  expect((await settings.loadHooks()).error).toBeTruthy();
});

it('imports an independent sound file and preserves legacy sound preferences', async () => {
  const { root, settings } = await setup();
  const audio = join(root, 'mention.ogg');
  await writeFile(audio, Buffer.from('OggSfixture'));
  const sound = await settings.importSound(audio);
  await rm(audio);
  expect(sound.name).toBe('mention.ogg');
  expect(await settings.readSound(sound)).toBe('data:audio/ogg;base64,T2dnU2ZpeHR1cmU=');
  const prefs = await settings.loadPreferences();
  const saved = await settings.savePreferences({
    revision: prefs.revision,
    notificationSoundEnabled: true,
    notificationSound: sound,
  });
  expect(saved.notificationSound).toEqual(sound);
  expect(settings.notificationSoundDataUrl).toContain('data:audio/ogg');
  const muted = await settings.savePreferences({
    revision: saved.revision,
    notificationSoundEnabled: false,
  });
  expect(muted.notificationSound).toEqual(sound);
  const fresh = new DesktopHookSettings(settings.paths);
  expect((await fresh.loadPreferences()).notificationSound).toEqual(sound);
  await expect(settings.readSound({ id: '../session.bin', name: 'oops' })).rejects.toThrow();
});

it('loads independent sources, toggles only the owning record and rejects conflicting IDs', async () => {
  const { root, settings } = await setup();
  await mkdir(join(root, 'hooks.d'));
  await writeFile(join(root, 'hooks.json'), JSON.stringify({ version: 1, hooks: [rule] }));
  const source = join(root, 'hooks.d', 'archive.json');
  const other = {
    ...rule,
    id: 'archive',
    name: 'Archive',
    action: { ...rule.action, async: true, env: { MODE: 'archive' } },
  };
  const invalid = { id: 'future', event: 'future', extra: true };
  await writeFile(source, JSON.stringify({ version: 1, note: 'keep', hooks: [other, invalid] }));
  await writeFile(join(root, 'hooks.d', 'broken.json'), '{broken');
  let snapshot = await settings.loadHooks();
  expect(snapshot.entries.filter((e) => e.rule).map((e) => e.rule!.id)).toEqual([
    'mention',
    'archive',
  ]);
  expect(snapshot.sources.find((s) => s.path.endsWith('broken.json'))?.error).toBeTruthy();
  const entry = snapshot.entries.find((e) => e.rule?.id === 'archive')!;
  const before = await readFile(join(root, 'hooks.json'), 'utf8');
  await settings.setHookEnabled({
    source,
    revision: entry.revision,
    index: entry.index,
    enabled: false,
  });
  expect(JSON.parse(await readFile(source, 'utf8'))).toEqual({
    version: 1,
    note: 'keep',
    hooks: [{ ...other, enabled: false }, invalid],
  });
  expect(await readFile(join(root, 'hooks.json'), 'utf8')).toBe(before);
  await expect(
    settings.setHookEnabled({ source, revision: entry.revision, index: 0, enabled: true }),
  ).rejects.toThrow(/changed/);
  await writeFile(source, JSON.stringify({ version: 1, hooks: [rule] }));
  snapshot = await settings.loadHooks();
  expect(snapshot.entries.filter((e) => e.rule)).toHaveLength(0);
  expect(snapshot.entries.filter((e) => e.error?.includes('Duplicate'))).toHaveLength(2);
  await expect(
    settings.setHookEnabled({
      source: join(root, '..', 'outside.json'),
      revision: '',
      index: 0,
      enabled: true,
    }),
  ).rejects.toThrow(/source/);
});

it('rejects synchronous actions without disabling other valid hooks', async () => {
  const { settings } = await setup();
  await writeFile(
    settings.paths.hooks,
    JSON.stringify({
      version: 1,
      hooks: [rule, { ...rule, id: 'sync', action: { ...rule.action, async: false } }],
    }),
  );
  const snapshot = await settings.loadHooks();
  expect(snapshot.entries[0]?.rule?.id).toBe('mention');
  expect(snapshot.entries[1]?.rule).toBeNull();
  expect(snapshot.entries[1]?.error).toContain('async');
});
