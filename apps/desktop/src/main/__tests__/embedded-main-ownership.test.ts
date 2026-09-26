import { promises as fs } from "node:fs";
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ServerConfig } from "@silverhand/shared";
import { EmbeddedBackendOwner } from "../embedded-backend-owner.js";
import {
  invalidateEmbeddedRuntime,
  persistEmbeddedBackend,
} from "../embedded-backend-publication.js";
import {
  desktopAppPaths,
  invalidateEmbeddedServerUrl,
  loadOrCreateServerConfig,
  writeServerConfig,
} from "../config.js";
import {
  startEmbeddedRustBackend,
  type EmbeddedRustBackendHandle,
} from "../embedded-rust-backend.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
function handle(close: () => Promise<void>): EmbeddedRustBackendHandle {
  return { url: "http://127.0.0.1:1234", port: 1234, close, onTerminal: () => {} };
}
describe("embedded ownership and durable config integration", () => {
  const originalRoot = process.env.SILVERHAND_DIR;
  let root: string | undefined;
  afterEach(async () => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    if (root) await fs.rm(root, { recursive: true, force: true });
    root = undefined;
    if (originalRoot === undefined) delete process.env.SILVERHAND_DIR;
    else process.env.SILVERHAND_DIR = originalRoot;
  });
  async function seed(): Promise<ServerConfig> {
    if (!originalRoot) throw new Error("isolated SILVERHAND_DIR required");
    await fs.mkdir(originalRoot, { recursive: true });
    root = await fs.mkdtemp(join(originalRoot, "main-owner-"));
    process.env.SILVERHAND_DIR = root;
    const config: ServerConfig = {
      mode: "embedded",
      url: "http://127.0.0.1:1234",
      refresh_token: "synthetic-refresh",
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
    "shutdown joins unpublished startup reclaim (reject=%s)",
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
          throw new Error("startup failed after reclaim");
        }
        return handle(async () => {
          reclaimed = true;
        });
      });
      const outcome = starting.catch((error) => error);
      await entered.promise;
      let exited = false;
      const quitting = owner.shutdown().then(() => {
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

  it("shutdown waits for SIGKILL and token cleanup of a startup child ignoring SIGTERM", async () => {
    vi.useFakeTimers();
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
        if (signal === "SIGKILL")
          queueMicrotask(() => {
            this.signalCode = signal;
            this.emit("exit", null, signal);
          });
        return true;
      }
    }
    const child = new Child();
    const starting = owner
      .start(() =>
        startEmbeddedRustBackend(
          { executablePath: "/fake" },
          {
            databasePath: "/fake/db",
            blobsRoot: "/fake/blobs",
            logDir: "/fake/logs",
            bootstrapTokenPath: "/fake/token",
            listen: { hostname: "127.0.0.1", port: 0 },
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
            mintGeneration: () => "test",
            removeBootstrapToken: async () => {
              tokenCleaned = true;
            },
            probeReadyz: async () => false,
            probeServerInfoEpoch: async () => null,
          },
        ),
      )
      .catch((error) => error);
    await spawned.promise;
    const quitting = owner.shutdown();
    await vi.advanceTimersByTimeAsync(4999);
    expect(child.signals).toEqual(["SIGTERM"]);
    expect(tokenCleaned).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await quitting;
    expect(child.signals).toEqual(["SIGTERM", "SIGKILL"]);
    expect(child.signalCode).toBe("SIGKILL");
    expect(tokenCleaned).toBe(true);
    expect(await starting).toBeInstanceOf(Error);
  });

  it.each(["success", "close-reject", "write-reject"])(
    "shutdown joins pending fatal cleanup after unpublication (%s)",
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
          if (outcome === "close-reject") throw new Error("close reported failure after reclaim");
        }),
      );
      let current: EmbeddedRustBackendHandle | null = child;
      if (outcome === "write-reject") {
        vi.spyOn(fs, "rename").mockRejectedValue(new Error("disk failure"));
      }
      const failing = owner
        .own(() =>
          invalidateEmbeddedRuntime(
            { kind: "child-exited", code: 1, signal: null },
            {
              isCurrent: () => current === child,
              invalidate: () => {
                current = null;
              },
              clearUrls: invalidateEmbeddedServerUrl,
              close: () => owner.close(child),
              report: vi.fn(),
            },
          ),
        )
        .catch((error: unknown) => error);
      expect(current).toBeNull();
      await entered.promise;
      expect(current).toBeNull();
      let exited = false;
      const quitting = owner.shutdown().then(() => {
        exited = true;
      });
      await Promise.resolve();
      expect(exited).toBe(false);
      reclaim.resolve();
      await Promise.all([failing, quitting]);
      expect(reclaimed).toBe(true);
      expect(await loadOrCreateServerConfig()).toMatchObject({
        ...config,
        url: outcome === "write-reject" ? config.url : "http://127.0.0.1:0",
      });
    },
  );

  it.each(["startup", "publication", "write-failure"] as const)(
    "startup %s path preserves durable config",
    async (failure) => {
      const config = await seed();
      const owner = new EmbeddedBackendOwner();
      const close = vi.fn(async () => {});
      const start = () =>
        owner.start(async () => {
          if (failure === "startup") {
            throw new Error("startup failure");
          }
          return persistEmbeddedBackend(
            handle(close),
            {
              config: () => writeServerConfig(config),
              controlUrl: () => {
                throw new Error("control URL write failure");
              },
              invalidate: invalidateEmbeddedServerUrl,
            },
            owner.signal,
          );
        });
      const original = await fs.readFile(desktopAppPaths().embeddedServer.serverConfig, "utf8");
      if (failure === "write-failure")
        vi.spyOn(fs, "rename").mockRejectedValue(new Error("disk failure"));
      await expect(start()).rejects.toThrow();
      await owner.shutdown();
      const persisted = await loadOrCreateServerConfig();
      expect(persisted).toMatchObject({
        ...config,
        url: failure === "publication" ? "http://127.0.0.1:0" : config.url,
      });
      if (failure !== "startup") expect(close).toHaveBeenCalledOnce();
      if (failure === "write-failure")
        expect(await fs.readFile(desktopAppPaths().embeddedServer.serverConfig, "utf8")).toBe(
          original,
        );
    },
  );

  it("publication refuses a handle when shutdown starts after startup resolves", async () => {
    const owner = new EmbeddedBackendOwner();
    const close = vi.fn(async () => {});
    const child = await owner.start(async () => handle(close));
    await owner.shutdown();
    const publish = vi.fn();
    const published = persistEmbeddedBackend(
      { ...child, close: () => owner.close(child) },
      {
        config: async () => {},
        controlUrl: publish,
        invalidate: async () => {},
      },
      owner.signal,
    );
    await expect(published).rejects.toThrow("terminal-before-publication");
    expect(publish).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledOnce();
  });
});
