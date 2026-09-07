import { readFileSync, promises as fs, rmSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import vm from 'node:vm';
import ts from 'typescript';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ServerConfig } from '@silverhand/shared';
import { EmbeddedBackendOwner } from '../embedded-backend-owner.js';
import {
  invalidateEmbeddedRuntime,
  persistEmbeddedBackend,
} from '../embedded-backend-publication.js';
import {
  desktopAppPaths,
  invalidateEmbeddedServerUrl,
  loadOrCreateServerConfig,
  writeServerConfig,
} from '../config.js';
import {
  DEFAULT_TIMINGS,
  startEmbeddedRustBackend,
  type EmbeddedRustBackendHandle,
} from '../embedded-rust-backend.js';

// Execute the real main-process call sites without booting Electron. Source drift
// must fail extraction, not silently leave a copied implementation under test.
const source = readFileSync(new URL('../index.ts', import.meta.url), 'utf8');
function extract(start: string, end: string): string {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from);
  expect(from).toBeGreaterThanOrEqual(0);
  expect(to).toBeGreaterThan(from);
  return source.slice(from, to);
}
function evaluate(code: string, context: Record<string, unknown>): unknown {
  return vm.runInNewContext(
    ts.transpileModule(code, {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
    }).outputText,
    context,
  );
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
function handle(close: () => Promise<void>): EmbeddedRustBackendHandle {
  return { url: 'http://127.0.0.1:1234', port: 1234, close, onTerminal: () => {} };
}
function mainContext(owner: EmbeddedBackendOwner): Record<string, unknown> {
  return {
    embeddedBackendOwner: owner,
    backend: null,
    mainWindow: null,
    hostClient: null,
    daemon: null,
    loggers: null,
    logger: null,
    console,
    isShuttingDown: false,
    rmSync,
    daemonPaths: () => ({
      controlPlaneServerUrlPath: join(process.env.SILVERHAND_DIR!, 'control-url'),
    }),
    invalidateEmbeddedServerUrl,
    invalidateEmbeddedRuntime,
    reportStartupFailure: vi.fn(),
  };
}
function shutdown(context: Record<string, unknown>): () => Promise<void> {
  return evaluate(
    `${extract('async function shutdown(): Promise<void> {', "app.on('before-quit'")}; shutdown`,
    context,
  ) as () => Promise<void>;
}

describe('production main ownership and config invalidation', () => {
  const originalRoot = process.env.SILVERHAND_DIR;
  let root: string | undefined;
  afterEach(async () => {
    vi.restoreAllMocks();
    if (root) await fs.rm(root, { recursive: true, force: true });
    root = undefined;
    if (originalRoot === undefined) delete process.env.SILVERHAND_DIR;
    else process.env.SILVERHAND_DIR = originalRoot;
  });
  async function seed(): Promise<ServerConfig> {
    root = await fs.mkdtemp(join(tmpdir(), 'main-owner-'));
    process.env.SILVERHAND_DIR = root;
    const config: ServerConfig = {
      mode: 'embedded',
      url: 'http://127.0.0.1:1234',
      refresh_token: 'synthetic-refresh',
      child_sessions: {
        max_concurrent_per_parent: 3,
        spawn_cooldown_seconds: 17,
        max_depth: 1,
      },
    };
    await writeServerConfig(config);
    return config;
  }

  it.each([false, true])(
    'shutdown joins unpublished startup reclaim (reject=%s)',
    async (reject) => {
      const owner = new EmbeddedBackendOwner();
      const entered = deferred();
      const reclaim = deferred();
      let reclaimed = false;
      const starting = owner.start(async () => {
        entered.resolve();
        await reclaim.promise;
        if (reject) {
          reclaimed = true;
          throw new Error('startup failed after reclaim');
        }
        return handle(async () => {
          reclaimed = true;
        });
      });
      const outcome = starting.catch((error) => error);
      await entered.promise;
      let exited = false;
      const quitting = shutdown(mainContext(owner))().then(() => {
        exited = true;
      });
      await Promise.resolve();
      expect(owner.signal.aborted).toBe(true);
      expect(exited).toBe(false);
      reclaim.resolve();
      await quitting;
      expect(reclaimed).toBe(true);
      expect(await outcome).toBeInstanceOf(Error);
    },
  );

  it('actual shutdown waits for SIGKILL and token cleanup of a startup child ignoring SIGTERM', async () => {
    const owner = new EmbeddedBackendOwner();
    const spawned = deferred();
    let tokenCleaned = false;
    class Child extends EventEmitter {
      stdout = new EventEmitter();
      exitCode = null;
      signalCode: string | null = null;
      signals: string[] = [];
      kill(signal: string) {
        this.signals.push(signal);
        if (signal === 'SIGKILL')
          queueMicrotask(() => {
            this.signalCode = signal;
            this.emit('exit', null, signal);
          });
        return true;
      }
    }
    const child = new Child();
    const starting = owner
      .start(() =>
        startEmbeddedRustBackend(
          { executablePath: '/fake' },
          {
            databasePath: '/fake/db',
            blobsRoot: '/fake/blobs',
            logDir: '/fake/logs',
            bootstrapTokenPath: '/fake/token',
            listen: { hostname: '127.0.0.1', port: 0 },
            allowedOrigins: [],
            disableSignup: false,
            apiEpoch: { clientEpoch: 5, minimumServerEpoch: 5 },
            signal: owner.signal,
          },
          {
            spawn: () => {
              tokenCleaned = false;
              spawned.resolve();
              return child as unknown as ChildProcess;
            },
            mintGeneration: () => 'test',
            removeBootstrapToken: async () => {
              tokenCleaned = true;
            },
            probeReadyz: async () => false,
            probeServerInfoEpoch: async () => null,
            clock: {
              now: Date.now,
              sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
            },
          },
          { ...DEFAULT_TIMINGS, shutdownGraceMs: 30 },
        ),
      )
      .catch((error) => error);
    await spawned.promise;
    await shutdown(mainContext(owner))();
    expect(child.signals).toEqual(['SIGTERM', 'SIGKILL']);
    expect(child.signalCode).toBe('SIGKILL');
    expect(tokenCleaned).toBe(true);
    expect(await starting).toBeInstanceOf(Error);
  });

  it.each(['success', 'close-reject', 'write-reject'])(
    'shutdown joins actual fatal callback after backend=null (%s)',
    async (outcome) => {
      const config = await seed();
      const owner = new EmbeddedBackendOwner();
      const entered = deferred();
      const reclaim = deferred();
      let reclaimed = false;
      const child = await owner.start(async () =>
        handle(async () => {
          entered.resolve();
          await reclaim.promise;
          reclaimed = true;
          if (outcome === 'close-reject') throw new Error('close reported failure after reclaim');
        }),
      );
      const context = mainContext(owner);
      context.backend = { kind: 'embedded', running: child };
      if (outcome === 'write-reject')
        vi.spyOn(fs, 'rename').mockRejectedValue(new Error('disk failure'));
      const fatal = evaluate(
        `${extract('async function handlePostPublishEmbeddedFatal(', "app.on('window-all-closed'")}; handlePostPublishEmbeddedFatal`,
        context,
      ) as (h: EmbeddedRustBackendHandle, reason: unknown) => Promise<void>;
      const failing = fatal(child, { kind: 'child-exit' });
      expect(context.backend).toBeNull();
      await entered.promise;
      expect(context.backend).toBeNull();
      let exited = false;
      const quitting = shutdown(context)().then(() => {
        exited = true;
      });
      await Promise.resolve();
      expect(exited).toBe(false);
      reclaim.resolve();
      await Promise.all([failing, quitting]);
      expect(reclaimed).toBe(true);
      expect(await loadOrCreateServerConfig()).toMatchObject({
        ...config,
        url: outcome === 'write-reject' ? config.url : 'http://127.0.0.1:0',
      });
    },
  );

  it.each(['startup', 'publication', 'write-failure'] as const)(
    'actual startup %s path preserves durable config',
    async (failure) => {
      const config = await seed();
      const owner = new EmbeddedBackendOwner();
      const close = vi.fn(async () => {});
      const context = {
        ...mainContext(owner),
        desktopAppPaths,
        embeddedBootstrapPath: () => join(root!, 'token'),
        process: { env: {}, resourcesPath: '' },
        app: { isPackaged: false, getAppPath: () => '' },
        DESKTOP_SERVER_API_EPOCH: 5,
        MINIMUM_SERVER_API_EPOCH: 5,
        startDesktopEmbeddedBackend: async () => {
          if (failure === 'startup') throw new Error('startup failure');
          return handle(close);
        },
        writeServerConfig,
        writeFileSync: () => {
          throw new Error('control URL write failure');
        },
        paths: { controlPlaneServerUrlPath: join(root!, 'control-url') },
        fsRm: fs.rm,
        persistEmbeddedBackend,
      };
      const callback = extract('startEmbeddedAndPersistConfig:', '      buildRemoteHandle:');
      const start = evaluate(`({ ${callback} }).startEmbeddedAndPersistConfig`, context) as (
        config: ServerConfig,
      ) => Promise<unknown>;
      const original = await fs.readFile(desktopAppPaths().embeddedServer.serverConfig, 'utf8');
      if (failure === 'write-failure')
        vi.spyOn(fs, 'rename').mockRejectedValue(new Error('disk failure'));
      await expect(start(config)).rejects.toThrow();
      await owner.shutdown();
      const persisted = await loadOrCreateServerConfig();
      expect(persisted).toMatchObject({
        ...config,
        url: failure === 'write-failure' ? config.url : 'http://127.0.0.1:0',
      });
      if (failure !== 'startup') expect(close).toHaveBeenCalledOnce();
      if (failure === 'write-failure')
        expect(await fs.readFile(desktopAppPaths().embeddedServer.serverConfig, 'utf8')).toBe(
          original,
        );
    },
  );

  it('main publication guard refuses a handle when shutdown starts after startup resolves', async () => {
    const owner = new EmbeddedBackendOwner();
    const close = vi.fn(async () => {});
    const child = await owner.start(async () => handle(close));
    await owner.shutdown();
    const context: Record<string, unknown> = {
      ...mainContext(owner),
      startedBackend: { kind: 'embedded', running: child },
    };
    const guard = extract(
      '    if (embeddedBackendOwner.isStopping)',
      '    backend = startedBackend;',
    );
    const publish = evaluate(
      `(async () => { ${guard} backend = startedBackend; })`,
      context,
    ) as () => Promise<void>;
    await expect(publish()).rejects.toThrow('cancelled before main publication');
    expect(context.backend).toBeNull();
    expect(close).toHaveBeenCalledOnce();
  });
});
