import { createHash, randomUUID } from 'node:crypto';
import { open, mkdir, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { parseHookRule } from './rule.js';
import { dirname, join } from 'node:path';
import { importSoundFile, readSoundFile } from './sound-files.js';
import type { NotificationSoundEdit, NotificationSoundFile } from '@silverhand/client';
import {
  HOOK_LIMITS,
  type DesktopPreferencesSnapshot,
  type HookToggle,
  type HookSettingsSnapshot,
} from '@silverhand/client';

const MAX_CONFIG_BYTES = HOOK_LIMITS.configBytes;
const revisionOf = (text: string | null) =>
  createHash('sha256')
    .update(text ?? '<missing>')
    .digest('hex');

/** A bounded file read and per-file write lane. No synchronous IO on event paths. */
class ConfigFile {
  private lane: Promise<unknown> = Promise.resolve();
  constructor(readonly path: string) {}
  async read(): Promise<{ text: string | null; revision: string }> {
    let file;
    try {
      file = await open(this.path, 'r');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT')
        return { text: null, revision: revisionOf(null) };
      throw error;
    }
    try {
      const buffer = Buffer.alloc(MAX_CONFIG_BYTES + 1);
      let size = 0;
      while (size < buffer.length) {
        const { bytesRead } = await file.read(buffer, size, buffer.length - size, null);
        if (!bytesRead) break;
        size += bytesRead;
      }
      if (size > MAX_CONFIG_BYTES) throw new Error('Configuration exceeds 256 KiB');
      const text = buffer.subarray(0, size).toString('utf8');
      return { text, revision: revisionOf(text) };
    } finally {
      await file.close();
    }
  }
  edit(revision: string, change: (current: unknown) => unknown): Promise<void> {
    const job = this.lane
      .catch(() => {})
      .then(async () => {
        const current = await this.read();
        if (current.revision !== revision)
          throw new Error('Configuration changed on disk. Reload before saving.');
        const next = change(current.text === null ? undefined : JSON.parse(current.text));
        const text = JSON.stringify(next, null, 2) + '\n';
        if (Buffer.byteLength(text) > MAX_CONFIG_BYTES)
          throw new Error('Configuration exceeds 256 KiB');
        await mkdir(dirname(this.path), { recursive: true });
        const temporary = `${this.path}.${randomUUID()}.tmp`;
        try {
          await writeFile(temporary, text, { mode: 0o600, flag: 'wx' });
          if ((await this.read()).revision !== revision)
            throw new Error('Configuration changed on disk. Reload before saving.');
          await rename(temporary, this.path);
        } finally {
          await rm(temporary, { force: true });
        }
      });
    this.lane = job;
    return job;
  }
}
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
function hooksDocument(value: unknown): { version: 1; hooks: unknown[] } {
  if (value === undefined) return { version: 1, hooks: [] };
  if (!object(value) || value.version !== 1 || !Array.isArray(value.hooks))
    throw new Error('Expected version 1 and a hooks array');
  if (value.hooks.length > HOOK_LIMITS.rules) throw new Error('At most 100 hooks are supported');
  return value as { version: 1; hooks: unknown[] };
}

export class DesktopHookSettings {
  private hooksFile: ConfigFile;
  private sourceFiles = new Map<string, ConfigFile>();
  private preferencesFile: ConfigFile;
  notificationSoundEnabled = true;
  notificationSound: NotificationSoundFile | null = null;
  notificationSoundDataUrl: string | null = null;
  importSound(path: string) {
    return importSoundFile(join(dirname(this.paths.preferences), 'sounds'), path);
  }
  readSound(sound: NotificationSoundFile) {
    return readSoundFile(join(dirname(this.paths.preferences), 'sounds'), sound);
  }
  constructor(readonly paths: { hooks: string; preferences: string }) {
    this.hooksFile = new ConfigFile(paths.hooks);
    this.preferencesFile = new ConfigFile(paths.preferences);
  }
  async prepareConfig(kind: 'hooks' | 'preferences'): Promise<string> {
    const path = this.paths[kind];
    await mkdir(dirname(path), { recursive: true });
    const defaults =
      kind === 'hooks' ? { version: 1, hooks: [] } : { version: 1, notificationSoundEnabled: true };
    try {
      await writeFile(path, JSON.stringify(defaults, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    return path;
  }
  private async sourcePaths(): Promise<string[]> {
    let names: string[] = [];
    try {
      names = (await readdir(join(dirname(this.paths.hooks), 'hooks.d'), { withFileTypes: true }))
        .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
        .map((entry) => entry.name)
        .sort();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    if (names.length >= 100) throw new Error('At most 100 hook sources are supported');
    return [
      this.paths.hooks,
      ...names.map((name) => join(dirname(this.paths.hooks), 'hooks.d', name)),
    ];
  }
  private fileFor(path: string): ConfigFile {
    if (path === this.paths.hooks) return this.hooksFile;
    let file = this.sourceFiles.get(path);
    if (!file) {
      file = new ConfigFile(path);
      this.sourceFiles.set(path, file);
    }
    return file;
  }
  async prepareHookSource(source: string): Promise<string> {
    if (!(await this.sourcePaths()).includes(source)) throw new Error('Unknown hook source');
    if (source === this.paths.hooks) await this.prepareConfig('hooks');
    return source;
  }
  async prepareHookDirectory(): Promise<string> {
    const directory = join(dirname(this.paths.hooks), 'hooks.d');
    await mkdir(directory, { recursive: true });
    return directory;
  }
  async loadHooks(): Promise<HookSettingsSnapshot> {
    const sources: HookSettingsSnapshot['sources'] = [];
    const entries: HookSettingsSnapshot['entries'] = [];
    let paths: string[];
    try {
      paths = await this.sourcePaths();
    } catch (error) {
      paths = [this.paths.hooks];
      sources.push({
        path: join(dirname(this.paths.hooks), 'hooks.d'),
        revision: '',
        error: message(error),
      });
    }
    for (const path of paths) {
      let revision = '';
      try {
        const source = await this.fileFor(path).read();
        revision = source.revision;
        const doc = hooksDocument(source.text === null ? undefined : JSON.parse(source.text));
        if (entries.length + doc.hooks.length > HOOK_LIMITS.rules)
          throw new Error('At most 100 hooks are supported across all sources');
        sources.push({ path, revision });
        doc.hooks.forEach((raw, index) => {
          try {
            entries.push({ source: path, revision, index, rule: parseHookRule(raw) });
          } catch (error) {
            entries.push({ source: path, revision, index, rule: null, error: message(error) });
          }
        });
      } catch (error) {
        sources.push({ path, revision, error: message(error) });
      }
    }
    const counts = new Map<string, number>();
    for (const { rule } of entries) if (rule) counts.set(rule.id, (counts.get(rule.id) ?? 0) + 1);
    for (const entry of entries)
      if (entry.rule && counts.get(entry.rule.id)! > 1) {
        entry.error = `Duplicate hook ID: ${entry.rule.id}`;
        entry.rule = null;
      }
    const primary = sources.find((source) => source.path === this.paths.hooks)!;
    return {
      path: this.paths.hooks,
      revision: primary.revision,
      error: primary.error,
      sources,
      entries,
    };
  }
  async setHookEnabled(input: HookToggle): Promise<HookSettingsSnapshot> {
    if (typeof input.enabled !== 'boolean') throw new Error('Expected enabled boolean');
    if (!(await this.sourcePaths()).includes(input.source)) throw new Error('Unknown hook source');
    await this.fileFor(input.source).edit(input.revision, (current) => {
      const doc = hooksDocument(current);
      if (!Number.isInteger(input.index) || input.index < 0 || input.index >= doc.hooks.length)
        throw new Error('Hook no longer exists');
      const raw = doc.hooks[input.index];
      parseHookRule(raw);
      doc.hooks[input.index] = { ...(raw as object), enabled: input.enabled };
      return doc;
    });
    return this.loadHooks();
  }
  async loadPreferences(): Promise<DesktopPreferencesSnapshot> {
    let revision = '';
    try {
      const source = await this.preferencesFile.read();
      revision = source.revision;
      const doc =
        source.text === null
          ? { version: 1, notificationSoundEnabled: true }
          : JSON.parse(source.text);
      if (!object(doc) || doc.version !== 1 || typeof doc.notificationSoundEnabled !== 'boolean')
        throw new Error('Expected version 1 and notificationSoundEnabled boolean');
      const sound = (doc.notificationSound ?? null) as NotificationSoundFile | null;
      const data = sound === null ? null : await this.readSound(sound);
      this.notificationSound = sound;
      this.notificationSoundDataUrl = data;
      this.notificationSoundEnabled = doc.notificationSoundEnabled;
      return {
        path: this.paths.preferences,
        revision,
        notificationSoundEnabled: this.notificationSoundEnabled,
        notificationSound: this.notificationSound,
      };
    } catch (error) {
      return {
        path: this.paths.preferences,
        revision,
        notificationSoundEnabled: this.notificationSoundEnabled,
        notificationSound: this.notificationSound,
        error: message(error),
      };
    }
  }
  async savePreferences(input: NotificationSoundEdit): Promise<DesktopPreferencesSnapshot> {
    if (typeof input.notificationSoundEnabled !== 'boolean')
      throw new Error('Expected a sound preference');
    if (input.notificationSound != null) await this.readSound(input.notificationSound);
    await this.preferencesFile.edit(input.revision, (current) => {
      if (current !== undefined && (!object(current) || current.version !== 1))
        throw new Error('Unsupported preferences version');
      return {
        ...((current as object) ?? {}),
        version: 1,
        notificationSoundEnabled: input.notificationSoundEnabled,
        ...(input.notificationSound !== undefined
          ? { notificationSound: input.notificationSound }
          : {}),
      };
    });
    return this.loadPreferences();
  }
}
