import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  composeRustBackendChildEnv,
  EmbeddedRustBackendStartError,
  startEmbeddedRustBackend,
  type EmbeddedRustBackendConfig,
  type EmbeddedRustBackendDeps,
  type EmbeddedRustBackendTerminalReason,
} from "../embedded/embedded-rust-backend.js";

const GENERATION = "gen-fixed-1";

/** A fake child process: a controllable stdout stream + exit/error events + kill spy. */
class FakeChild extends EventEmitter {
  readonly stdout = new EventEmitter();
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  readonly killed: NodeJS.Signals[] = [];
  env: Record<string, string> = {};

  kill(signal: NodeJS.Signals): boolean {
    this.killed.push(signal);
    // A SIGTERM/SIGKILL resolves the exit unless a test overrides (ignoreTerm).
    if (!this.ignoreTerm || signal === "SIGKILL") {
      queueMicrotask(() => this.simulateExit(null, signal));
    }
    return true;
  }

  ignoreTerm = false;

  emitStdout(line: string): void {
    this.stdout.emit("data", Buffer.from(line, "utf8"));
  }

  simulateExit(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.exitCode !== null || this.signalCode !== null) return;
    this.exitCode = code;
    this.signalCode = signal;
    this.emit("exit", code, signal);
  }
}

function config(): EmbeddedRustBackendConfig {
  return {
    databasePath: "/data/silverhand.sqlite",
    blobsRoot: "/data/blobs",
    logDir: "/data/logs",
    bootstrapTokenPath: "/data/bootstrap.token",
    listen: { hostname: "127.0.0.1", port: 0 },
    allowedOrigins: ["http://localhost:5173"],
    daemonNpmSpec: "@silverhand-ai/daemon@test",
    disableSignup: false,
    apiEpoch: { clientEpoch: 5, minimumServerEpoch: 5 },
  };
}

function boundLine(overrides: Record<string, unknown> = {}): string {
  return (
    phaseLine("preparing") +
    phaseLine("prepared") +
    `${JSON.stringify({
      v: 2,
      kind: "bound",
      generation: GENERATION,
      url: "http://127.0.0.1:51763",
      port: 51763,
      ...overrides,
    })}\n`
  );
}

function phaseLine(kind: "preparing" | "prepared"): string {
  return `${JSON.stringify({ v: 2, kind, generation: GENERATION })}\n`;
}

interface Harness {
  child: FakeChild;
  deps: EmbeddedRustBackendDeps;
  removedTokens: string[];
  spawnedEnv: () => Record<string, string>;
  setReadyz: (fn: (url: string) => boolean) => void;
  setServerInfoEpoch: (
    fn: (url: string) => { currentEpoch: number; minimumClientEpoch: number } | null,
  ) => void;
}

function harness(overrides: Partial<EmbeddedRustBackendDeps> = {}): Harness {
  const child = new FakeChild();
  const removedTokens: string[] = [];
  let readyzImpl: (url: string) => boolean = () => true;
  let epochImpl: (
    url: string,
  ) => { currentEpoch: number; minimumClientEpoch: number } | null = () => ({
    currentEpoch: 5,
    minimumClientEpoch: 5,
  });
  let capturedEnv: Record<string, string> = {};
  const deps: EmbeddedRustBackendDeps = {
    spawn: (_executablePath, env) => {
      capturedEnv = env;
      return child as unknown as ChildProcess;
    },
    probeReadyz: async (url) => readyzImpl(url),
    probeServerInfoEpoch: async (url) => epochImpl(url),
    mintGeneration: () => GENERATION,
    removeBootstrapToken: async (p) => {
      removedTokens.push(p);
    },
    ...overrides,
  };
  return {
    child,
    deps,
    removedTokens,
    spawnedEnv: () => capturedEnv,
    setReadyz: (fn) => {
      readyzImpl = fn;
    },
    setServerInfoEpoch: (fn) => {
      epochImpl = fn;
    },
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
});
afterEach(() => vi.useRealTimers());

async function rejectsAfter(pending: Promise<unknown>, ms: number, kind: string): Promise<void> {
  const settled = vi.fn();
  const result = pending.then(
    (value) => {
      settled();
      return value;
    },
    (error) => {
      settled();
      return error;
    },
  );
  await vi.advanceTimersByTimeAsync(ms);
  expect(settled).toHaveBeenCalledOnce();
  expect(await result).toBeInstanceOf(EmbeddedRustBackendStartError);
  expect(await result).toMatchObject({ kind });
}

describe("startup ordering and cancellation", () => {
  it("bound does not reset the prepared-to-service deadline", async () => {
    vi.useFakeTimers();
    try {
      const h = harness({ probeReadyz: async () => new Promise(() => {}) });
      let outcome: unknown;
      const starting = startEmbeddedRustBackend(
        { executablePath: "/app/backend" },
        config(),
        h.deps,
      ).catch((error) => {
        outcome = error;
        return error;
      });
      await Promise.resolve();
      h.child.emitStdout(phaseLine("preparing"));
      await vi.advanceTimersByTimeAsync(60_000);
      h.child.emitStdout(phaseLine("prepared"));
      await vi.advanceTimersByTimeAsync(20_000);
      h.child.emitStdout(
        boundLine().slice(phaseLine("preparing").length + phaseLine("prepared").length),
      );
      await vi.advanceTimersByTimeAsync(9_999);
      expect(outcome).toBeUndefined();
      await vi.advanceTimersByTimeAsync(1);
      expect(await starting).toMatchObject({ kind: "readiness-timeout" });
      expect(h.child.killed).toContain("SIGTERM");
    } finally {
      vi.useRealTimers();
    }
  });
  it("confirmed preparation can exceed 30 seconds; service budget starts only at prepared", async () => {
    vi.useFakeTimers();
    try {
      const h = harness();
      let published = false;
      const starting = startEmbeddedRustBackend(
        { executablePath: "/app/backend" },
        config(),
        h.deps,
      ).then((handle) => {
        published = true;
        return handle;
      });
      await Promise.resolve();
      h.child.emitStdout(phaseLine("preparing"));
      await vi.advanceTimersByTimeAsync(120_000);
      expect(published).toBe(false);
      expect(h.child.killed).toEqual([]);
      h.child.emitStdout(boundLine().slice(phaseLine("preparing").length));
      const handle = await starting;
      expect(handle.url).toBe("http://127.0.0.1:51763");
      await handle.close();
    } finally {
      vi.useRealTimers();
    }
  });

  for (const phase of ["preparing", "prepared"] as const) {
    it(`cancellation in ${phase} waits for forced reclamation without publication`, async () => {
      vi.useFakeTimers();
      try {
        const h = harness();
        h.child.ignoreTerm = true;
        const abort = new AbortController();
        const starting = startEmbeddedRustBackend(
          { executablePath: "/app/backend" },
          { ...config(), signal: abort.signal },
          h.deps,
        ).catch((error) => error);
        await Promise.resolve();
        h.child.emitStdout(
          phaseLine("preparing") + (phase === "prepared" ? phaseLine("prepared") : ""),
        );
        abort.abort();
        await vi.advanceTimersByTimeAsync(5000);
        expect(await starting).toMatchObject({ kind: "shutdown-during-startup" });
        expect(h.child.killed).toEqual(["SIGTERM", "SIGKILL"]);
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        vi.useRealTimers();
      }
    });
  }
  it("abort before the first frame disposes its timer after reclamation", async () => {
    vi.useFakeTimers();
    try {
      const h = harness();
      const abort = new AbortController();
      const starting = startEmbeddedRustBackend(
        { executablePath: "/app/backend" },
        { ...config(), signal: abort.signal },
        h.deps,
      ).catch((error) => error);
      await Promise.resolve();
      abort.abort();
      await vi.advanceTimersByTimeAsync(0);
      await starting;
      expect(h.removedTokens).toContain("/data/bootstrap.token");
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
  it("one total deadline includes frame, readiness and epoch verification", async () => {
    let attemptSignal: AbortSignal | undefined;
    const h = harness({
      probeReadyz: async () => {
        await new Promise((resolve) => setTimeout(resolve, 4000));
        return true;
      },
      probeServerInfoEpoch: async (_url, signal) => {
        attemptSignal = signal;
        return new Promise(() => {});
      },
    });
    const starting = startEmbeddedRustBackend({ executablePath: "/app/backend" }, config(), h.deps);
    const settled = vi.fn();
    const result = starting.catch((error) => {
      settled(error);
      return error;
    });
    await Promise.resolve();
    h.child.emitStdout(phaseLine("preparing") + phaseLine("prepared"));
    await vi.advanceTimersByTimeAsync(25000);
    h.child.emitStdout(boundLine().split("\n")[2]! + "\n");
    await vi.advanceTimersByTimeAsync(4999);
    expect(attemptSignal).toBeDefined();
    expect(attemptSignal!.aborted).toBe(false);
    expect(settled).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(settled).toHaveBeenCalledOnce();
    expect(await result).toMatchObject({ kind: "readiness-timeout" });
    expect(attemptSignal!.aborted).toBe(true);
    expect(h.child.killed).toContain("SIGTERM");
  });
  it("replays terminal delivered synchronously after bound but before the gate installs its waiter", async () => {
    const h = harness();
    const starting = startEmbeddedRustBackend({ executablePath: "/app/backend" }, config(), h.deps);
    queueMicrotask(() => {
      h.child.emitStdout(boundLine());
      h.child.emitStdout("duplicate\n");
    });
    await expect(starting).rejects.toMatchObject({ kind: "duplicate-frame" });
    expect(h.child.killed).toContain("SIGTERM");
    expect(h.removedTokens).toContain(config().bootstrapTokenPath);
  });

  for (const phase of ["frame", "ready", "epoch"] as const) {
    it(`shutdown cancels ${phase} even when its probe ignores AbortSignal`, async () => {
      const abort = new AbortController();
      const h = harness();
      let entered!: () => void;
      const probing = new Promise<void>((resolve) => {
        entered = resolve;
      });
      if (phase === "ready")
        h.deps.probeReadyz = async () => {
          entered();
          return new Promise(() => {});
        };
      if (phase === "epoch")
        h.deps.probeServerInfoEpoch = async () => {
          entered();
          return new Promise(() => {});
        };
      const starting = startEmbeddedRustBackend(
        { executablePath: "/app/backend" },
        { ...config(), signal: abort.signal },
        h.deps,
      );
      queueMicrotask(() => {
        if (phase !== "frame") h.child.emitStdout(boundLine());
      });
      if (phase !== "frame") await probing;
      else await Promise.resolve();
      abort.abort();
      await expect(starting).rejects.toMatchObject({ kind: "shutdown-during-startup" });
      expect(h.child.killed).toContain("SIGTERM");
      expect(h.removedTokens).toContain(config().bootstrapTokenPath);
    });
  }

  it("child exit interrupts a probe that never settles", async () => {
    let entered!: () => void;
    const probing = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const h = harness({
      probeReadyz: async () => {
        entered();
        return new Promise(() => {});
      },
    });
    const starting = startEmbeddedRustBackend({ executablePath: "/app/backend" }, config(), h.deps);
    queueMicrotask(() => h.child.emitStdout(boundLine()));
    await probing;
    h.child.simulateExit(9, null);
    await expect(starting).rejects.toMatchObject({ kind: "child-exited-early" });
    expect(h.removedTokens).toContain(config().bootstrapTokenPath);
  });

  it("replays post-publish terminal to an owner registered after the event", async () => {
    const h = harness();
    const starting = startEmbeddedRustBackend({ executablePath: "/app/backend" }, config(), h.deps);
    queueMicrotask(() => h.child.emitStdout(boundLine()));
    const handle = await starting;
    h.child.simulateExit(9, null);
    const reasons: EmbeddedRustBackendTerminalReason[] = [];
    handle.onTerminal((reason) => reasons.push(reason));
    expect(reasons).toMatchObject([{ kind: "child-exited", code: 9 }]);
    await handle.close();
  });

  it("stdout EOF after bound interrupts startup", async () => {
    const h = harness({ probeReadyz: async () => new Promise(() => {}) });
    const starting = startEmbeddedRustBackend({ executablePath: "/app/backend" }, config(), h.deps);
    queueMicrotask(() => {
      h.child.emitStdout(boundLine());
      h.child.stdout.emit("end");
    });
    await expect(starting).rejects.toMatchObject({ kind: "eof-before-frame" });
    expect(h.child.killed).toContain("SIGTERM");
  });
});

describe("startEmbeddedRustBackend — happy path", () => {
  it("spawns with the explicit env boundary + minted generation, then publishes on bound + readyz", async () => {
    const h = harness();
    const promise = startEmbeddedRustBackend(
      { executablePath: "/app/silverhand-backend" },
      config(),
      h.deps,
    );
    // The child emits its single bound frame.
    queueMicrotask(() => h.child.emitStdout(boundLine()));
    const handle = await promise;

    expect(handle.url).toBe("http://127.0.0.1:51763");
    expect(handle.port).toBe(51763);

    // The launcher-owned explicit env boundary, incl the minted generation + profile.
    const env = h.spawnedEnv();
    expect(env.SILVERHAND_DATABASE_PATH).toBe("/data/silverhand.sqlite");
    expect(env.SILVERHAND_BLOBS_ROOT).toBe("/data/blobs");
    expect(env.SILVERHAND_LOG_DIR).toBe("/data/logs");
    expect(env.SILVERHAND_BOOTSTRAP_TOKEN_PATH).toBe("/data/bootstrap.token");
    expect(env.SILVERHAND_LISTEN_ADDR).toBe("127.0.0.1:0");
    expect(env.SILVERHAND_ALLOWED_ORIGINS).toBe("http://localhost:5173");
    expect(env.SILVERHAND_DEPLOYMENT_PROFILE).toBe("embedded");
    expect(env.SILVERHAND_STARTUP_GENERATION).toBe(GENERATION);
    expect(env.SILVERHAND_DAEMON_NPM_SPEC).toBe("@silverhand-ai/daemon@test");
    // signup enabled => the disable flag is ABSENT (not "0")
    expect(env.SILVERHAND_DISABLE_SIGNUP).toBeUndefined();

    // #task:2343 — NO local-outbound-socket data-plane key: the Rust backend reaches the
    // daemon over authenticated generation-bound `/ws/host`, never the legacy TS embedded
    // `daemon-outbound.sock`. Assert no such hidden fallback is smuggled into the env.
    for (const key of Object.keys(env)) {
      expect(key.toLowerCase()).not.toContain("outbound");
      expect(key.toLowerCase()).not.toContain("socket");
    }
    // The env boundary is EXACTLY the launcher-owned config keys — a closed allowlist so
    // no unmodelled data-plane input can hide in it.
    expect(new Set(Object.keys(env))).toEqual(
      new Set([
        "SILVERHAND_DATABASE_PATH",
        "SILVERHAND_BLOBS_ROOT",
        "SILVERHAND_LOG_DIR",
        "SILVERHAND_BOOTSTRAP_TOKEN_PATH",
        "SILVERHAND_LISTEN_ADDR",
        "SILVERHAND_ALLOWED_ORIGINS",
        "SILVERHAND_DEPLOYMENT_PROFILE",
        "SILVERHAND_STARTUP_GENERATION",
        "SILVERHAND_DAEMON_NPM_SPEC",
      ]),
    );
  });

  it("close() terminates the child gracefully and removes the bootstrap token", async () => {
    const h = harness();
    const promise = startEmbeddedRustBackend(
      { executablePath: "/app/silverhand-backend" },
      config(),
      h.deps,
    );
    queueMicrotask(() => h.child.emitStdout(boundLine()));
    const handle = await promise;

    await Promise.all([handle.close(), handle.close()]);
    expect(h.child.killed).toEqual(["SIGTERM"]);
    expect(h.removedTokens).toContain("/data/bootstrap.token");
    // Idempotent.
    await handle.close();
    expect(h.child.killed).toEqual(["SIGTERM"]);
    expect(h.removedTokens).toEqual(["/data/bootstrap.token", "/data/bootstrap.token"]);
  });
});

describe("startEmbeddedRustBackend — failure matrix (each fail-loud, reclaim, no orphan)", () => {
  it("spawn error → spawn-failed, no orphan", async () => {
    const h = harness({
      spawn: () => {
        throw new Error("ENOENT");
      },
    });
    await expect(
      startEmbeddedRustBackend({ executablePath: "/missing" }, config(), h.deps),
    ).rejects.toMatchObject({ kind: "spawn-failed" });
  });

  it("child exits before the frame → child-exited-early + token cleaned", async () => {
    const h = harness();
    const promise = startEmbeddedRustBackend(
      { executablePath: "/app/silverhand-backend" },
      config(),
      h.deps,
    );
    queueMicrotask(() => h.child.simulateExit(1, null));
    await expect(promise).rejects.toMatchObject({ kind: "child-exited-early" });
    expect(h.removedTokens).toContain("/data/bootstrap.token");
  });

  it("an invalid frame → invalid-frame + child reclaimed", async () => {
    const h = harness();
    const promise = startEmbeddedRustBackend(
      { executablePath: "/app/silverhand-backend" },
      config(),
      h.deps,
    );
    queueMicrotask(() => h.child.emitStdout(boundLine({ generation: "wrong" })));
    await expect(promise).rejects.toMatchObject({ kind: "invalid-frame" });
    expect(h.child.killed).toContain("SIGTERM");
    expect(h.removedTokens).toContain("/data/bootstrap.token");
  });

  it("two lines BEFORE bound resolves → duplicate-frame + reclaim", async () => {
    // Both lines arrive in one chunk before the microtask resolves: the reader settles
    // the first line, then a SECOND non-blank line flips it to 'duplicate' — a pre-bound
    // protocol violation (stdout carries only ONE frame) → cancel startup.
    const h = harness();
    const promise = startEmbeddedRustBackend(
      { executablePath: "/app/silverhand-backend" },
      config(),
      h.deps,
    );
    queueMicrotask(() => h.child.emitStdout(`${boundLine()}duplicate\n`));
    await expect(promise).rejects.toMatchObject({ kind: "duplicate-frame" });
    expect(h.child.killed).toContain("SIGTERM");
  });

  it("P0-4: a stray non-blank stdout line AFTER publish fires the typed terminal owner (protocol-violation), not a silent auto-close", async () => {
    const h = harness();
    const promise = startEmbeddedRustBackend(
      { executablePath: "/app/silverhand-backend" },
      config(),
      h.deps,
    );
    queueMicrotask(() => h.child.emitStdout(boundLine()));
    const handle = await promise;
    expect(h.child.killed).not.toContain("SIGTERM"); // healthy after publish

    // #task:2343 P0-4 — the handle does NOT auto-close on a post-publish protocol
    // violation; it surfaces a TYPED terminal reason to the single external owner (the
    // Desktop main), which decides to invalidate + close. The monitor keeps draining
    // stdout so the stray line is consumed (no pipe back-pressure).
    const reasons: EmbeddedRustBackendTerminalReason[] = [];
    handle.onTerminal((reason) => reasons.push(reason));
    expect(h.child.killed).not.toContain("SIGTERM"); // still not auto-killed

    h.child.emitStdout("unexpected post-startup line\n");
    expect(reasons).toHaveLength(1);
    expect(reasons[0]).toMatchObject({ kind: "protocol-violation" });
    // The child is still alive until the OWNER closes it — that is the main's job.
    expect(h.child.killed).not.toContain("SIGTERM");

    // The owner reacts by closing; that reclaims the child + token.
    await handle.close();
    expect(h.child.killed).toContain("SIGTERM");
    expect(h.removedTokens).toContain("/data/bootstrap.token");
    await handle.close(); // idempotent
  });

  it("P0-4: a post-publish child crash fires the typed terminal owner (child-exited)", async () => {
    const h = harness();
    const promise = startEmbeddedRustBackend(
      { executablePath: "/app/silverhand-backend" },
      config(),
      h.deps,
    );
    queueMicrotask(() => h.child.emitStdout(boundLine()));
    const handle = await promise;
    const reasons: EmbeddedRustBackendTerminalReason[] = [];
    handle.onTerminal((reason) => reasons.push(reason));

    h.child.simulateExit(139, null); // crash
    expect(reasons).toHaveLength(1);
    expect(reasons[0]).toMatchObject({ kind: "child-exited", code: 139 });
    await handle.close();
  });

  it("a second stdout line during an entered ready probe rejects before publication", async () => {
    let entered!: () => void;
    const probing = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const h = harness({
      probeReadyz: async () => {
        entered();
        return new Promise(() => {});
      },
    });
    const starting = startEmbeddedRustBackend({ executablePath: "/app/backend" }, config(), h.deps);
    queueMicrotask(() => h.child.emitStdout(boundLine()));
    await probing;
    h.child.emitStdout("stray pre-publish line\n");
    await expect(starting).rejects.toMatchObject({ kind: "duplicate-frame" });
    expect(h.child.killed).toContain("SIGTERM");
    expect(h.removedTokens).toContain("/data/bootstrap.token");
  });

  it("P0: server-info unavailable after readyz → server-info-unavailable + reclaim", async () => {
    const h = harness();
    h.setServerInfoEpoch(() => null);
    const promise = startEmbeddedRustBackend(
      { executablePath: "/app/silverhand-backend" },
      config(),
      h.deps,
    );
    queueMicrotask(() => h.child.emitStdout(boundLine()));
    await expect(promise).rejects.toMatchObject({ kind: "server-info-unavailable" });
    expect(h.child.killed).toContain("SIGTERM");
    expect(h.removedTokens).toContain("/data/bootstrap.token");
  });

  it("P0: an ASYMMETRIC-range compatible epoch still publishes (not exact-equality)", async () => {
    // Deliberately NON-lockstep: Desktop clientEpoch=7, minimumServerEpoch=4; server
    // advertises current=6 (>= Desktop.minServer 4, and != clientEpoch 7),
    // minimumClientEpoch=5 (<= clientEpoch 7). classifyDesktopServerApiCompatibility →
    // 'compatible'. An exact-equality gate would WRONGLY reject this, so this proves the
    // range classifier is used.
    const h = harness();
    const cfg: EmbeddedRustBackendConfig = {
      ...config(),
      apiEpoch: { clientEpoch: 7, minimumServerEpoch: 4 },
    };
    h.setServerInfoEpoch(() => ({ currentEpoch: 6, minimumClientEpoch: 5 }));
    const promise = startEmbeddedRustBackend(
      { executablePath: "/app/silverhand-backend" },
      cfg,
      h.deps,
    );
    queueMicrotask(() => h.child.emitStdout(boundLine()));
    const handle = await promise;
    expect(handle.port).toBe(51763);
    await handle.close();
  });

  it("P0: client_too_old (client < server.minimum_client_epoch) → epoch-incompatible", async () => {
    const h = harness();
    const cfg: EmbeddedRustBackendConfig = {
      ...config(),
      apiEpoch: { clientEpoch: 4, minimumServerEpoch: 1 },
    };
    // server demands minimum_client_epoch=6 > client 4 → client_too_old.
    h.setServerInfoEpoch(() => ({ currentEpoch: 6, minimumClientEpoch: 6 }));
    const promise = startEmbeddedRustBackend(
      { executablePath: "/app/silverhand-backend" },
      cfg,
      h.deps,
    );
    queueMicrotask(() => h.child.emitStdout(boundLine()));
    await expect(promise).rejects.toMatchObject({
      kind: "epoch-incompatible",
      detail: "client_too_old",
    });
    expect(h.child.killed).toContain("SIGTERM");
    expect(h.removedTokens).toContain("/data/bootstrap.token");
  });

  it("P0: server_too_old (server.current < Desktop.minimumServerEpoch) → epoch-incompatible", async () => {
    const h = harness();
    const cfg: EmbeddedRustBackendConfig = {
      ...config(),
      apiEpoch: { clientEpoch: 7, minimumServerEpoch: 6 },
    };
    // server current=5 < Desktop.minimumServerEpoch 6 → server_too_old (client ok).
    h.setServerInfoEpoch(() => ({ currentEpoch: 5, minimumClientEpoch: 5 }));
    const promise = startEmbeddedRustBackend(
      { executablePath: "/app/silverhand-backend" },
      cfg,
      h.deps,
    );
    queueMicrotask(() => h.child.emitStdout(boundLine()));
    await expect(promise).rejects.toMatchObject({
      kind: "epoch-incompatible",
      detail: "server_too_old",
    });
    expect(h.child.killed).toContain("SIGTERM");
    expect(h.removedTokens).toContain("/data/bootstrap.token");
  });

  it("readiness timeout → readiness-timeout + reclaim", async () => {
    const h = harness();
    h.setReadyz(() => false); // never ready
    const promise = startEmbeddedRustBackend(
      { executablePath: "/app/silverhand-backend" },
      config(),
      h.deps,
    );
    queueMicrotask(() => h.child.emitStdout(boundLine()));
    await rejectsAfter(promise, 30000, "readiness-timeout");
    expect(h.child.killed).toContain("SIGTERM");
    expect(h.removedTokens).toContain("/data/bootstrap.token");
  });

  it("child exits during readiness polling → child-exited-early", async () => {
    const h = harness();
    let probes = 0;
    h.setReadyz(() => {
      probes += 1;
      if (probes === 1) {
        // exit the child after the first (failing) probe
        h.child.simulateExit(2, null);
      }
      return false;
    });
    const promise = startEmbeddedRustBackend(
      { executablePath: "/app/silverhand-backend" },
      config(),
      h.deps,
    );
    queueMicrotask(() => h.child.emitStdout(boundLine()));
    await expect(promise).rejects.toMatchObject({ kind: "child-exited-early" });
  });

  it("frame timeout (EOF-before-frame) → eof-before-frame + reclaim", async () => {
    const h = harness();
    const promise = startEmbeddedRustBackend(
      { executablePath: "/app/silverhand-backend" },
      config(),
      h.deps,
    );
    // never emit a frame; the frame-timeout sleep advances the fake clock and fires.
    await rejectsAfter(promise, 30000, "eof-before-frame");
    expect(h.child.killed).toContain("SIGTERM");
    expect(h.removedTokens).toContain("/data/bootstrap.token");
  });

  it("a hung child is SIGKILLed after the grace period on reclaim", async () => {
    const h = harness();
    h.child.ignoreTerm = true; // ignores SIGTERM, only dies on SIGKILL
    h.setReadyz(() => false);
    const promise = startEmbeddedRustBackend(
      { executablePath: "/app/silverhand-backend" },
      config(),
      h.deps,
    );
    queueMicrotask(() => h.child.emitStdout(boundLine()));
    await rejectsAfter(promise, 35000, "readiness-timeout");
    expect(h.child.killed).toContain("SIGTERM");
    expect(h.child.killed).toContain("SIGKILL");
  });

  it("#task:2343 P0-5: spawn `error` WITHOUT `exit` still completes reclaim (no hang) and fails loud", async () => {
    const h = harness();
    // A child that emits `error` and NEVER emits `exit` (ENOENT-style async surface) and
    // also ignores SIGTERM/SIGKILL exit — terminateChild must not wait forever for an
    // `exit` that will never arrive; it settles on the bounded grace.
    h.child.ignoreTerm = true;
    const noExitChild = h.child;
    // Suppress SIGKILL-triggered exit too, to model a truly phantom child.
    noExitChild.kill = (signal: NodeJS.Signals): boolean => {
      noExitChild.killed.push(signal);
      return true; // never simulate exit
    };
    const promise = startEmbeddedRustBackend(
      { executablePath: "/app/silverhand-backend" },
      config(),
      h.deps,
    );
    // Emit `error` (before the frame) with no following `exit`.
    queueMicrotask(() => h.child.emit("error", new Error("ENOENT: spawn failed async")));
    await rejectsAfter(promise, 10000, "spawn-failed");
    // Reclaim still completed (token cleaned) despite no `exit` ever arriving.
    expect(h.removedTokens).toContain("/data/bootstrap.token");
  });

  it("#task:2343 P0-2: a hung /readyz fetch is bounded by the attempt timeout and does not bypass the ready budget", async () => {
    const h = harness();
    const signals: AbortSignal[] = [];
    // A probe that never resolves unless its signal aborts — models a hung socket. The
    // per-attempt timeout must abort it so the ready-deadline loop still fails loud.
    h.deps.probeReadyz = (_url, signal) => {
      signals.push(signal);
      return new Promise<boolean>((resolve) => {
        if (signal.aborted) resolve(false);
        else signal.addEventListener("abort", () => resolve(false), { once: true });
      });
    };
    const promise = startEmbeddedRustBackend(
      { executablePath: "/app/silverhand-backend" },
      config(),
      h.deps,
    );
    queueMicrotask(() => h.child.emitStdout(boundLine()));
    await vi.advanceTimersByTimeAsync(4999);
    expect(signals).toHaveLength(1);
    expect(signals[0]!.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(signals[0]!.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(100);
    expect(signals).toHaveLength(2);
    // The per-attempt timeout releases the first socket before the total budget.
    await rejectsAfter(promise, 24900, "readiness-timeout");
    expect(h.child.killed).toContain("SIGTERM");
    expect(h.removedTokens).toContain("/data/bootstrap.token");
  });

  it("#task:2343 P0-2: a hung server-info fetch is bounded and fails loud (server-info-unavailable)", async () => {
    const h = harness();
    h.deps.probeServerInfoEpoch = (_url, signal) =>
      new Promise((resolve) => {
        if (signal.aborted) resolve(null);
        else signal.addEventListener("abort", () => resolve(null), { once: true });
      });
    const promise = startEmbeddedRustBackend(
      { executablePath: "/app/silverhand-backend" },
      config(),
      h.deps,
    );
    queueMicrotask(() => h.child.emitStdout(boundLine()));
    await rejectsAfter(promise, 5000, "server-info-unavailable");
    expect(h.child.killed).toContain("SIGTERM");
    expect(h.removedTokens).toContain("/data/bootstrap.token");
  });
});

describe("composeRustBackendChildEnv — closed OS allowlist + explicit boundary (#task:2343 P1-7)", () => {
  it("poison-parent: drops unknown SILVERHAND_*, credentials, and injection vectors; forwards only the OS allowlist + launcher boundary", () => {
    const boundary = {
      SILVERHAND_DATABASE_PATH: "/x/silverhand.db",
      SILVERHAND_BLOBS_ROOT: "/x/blobs",
      SILVERHAND_LOG_DIR: "/x/logs",
      SILVERHAND_DEPLOYMENT_PROFILE: "embedded",
      SILVERHAND_STARTUP_GENERATION: "gen-xyz",
    };
    const inherited = {
      // OS runtime essentials — MUST be preserved.
      PATH: "/usr/bin:/bin",
      HOME: "/Users/x",
      LANG: "en_US.UTF-8",
      TMPDIR: "/tmp/x",
      // A bare SILVERHAND_DIR (second path authority) — MUST NOT reach the child.
      SILVERHAND_DIR: "/x",
      // An UNKNOWN SILVERHAND_* input — MUST NOT reach the child (closed allowlist).
      SILVERHAND_SECRET_BACKDOOR: "nope",
      SILVERHAND_DAEMON_NPM_SPEC: "evil-from-parent",
      // Credentials / secrets — MUST NOT reach the child.
      AWS_SECRET_ACCESS_KEY: "shhh",
      GITHUB_TOKEN: "ghp_x",
      OPENAI_API_KEY: "sk-x",
      // Code-injection vectors — MUST NOT reach the child.
      DYLD_INSERT_LIBRARIES: "/evil.dylib",
      LD_PRELOAD: "/evil.so",
      NODE_OPTIONS: "--require /evil.js",
    };
    const composed = composeRustBackendChildEnv(boundary, inherited);

    // OS runtime essentials preserved.
    expect(composed.PATH).toBe("/usr/bin:/bin");
    expect(composed.HOME).toBe("/Users/x");
    expect(composed.LANG).toBe("en_US.UTF-8");
    expect(composed.TMPDIR).toBe("/tmp/x");

    // The launcher boundary is authoritative.
    expect(composed.SILVERHAND_DATABASE_PATH).toBe("/x/silverhand.db");
    expect(composed.SILVERHAND_BLOBS_ROOT).toBe("/x/blobs");
    expect(composed.SILVERHAND_LOG_DIR).toBe("/x/logs");
    expect(composed.SILVERHAND_STARTUP_GENERATION).toBe("gen-xyz");

    // No second path authority; no unknown SILVERHAND_* smuggled from the parent; the
    // boundary did not set a daemon spec, so the parent's forged one is GONE.
    expect("SILVERHAND_DIR" in composed).toBe(false);
    expect("SILVERHAND_SECRET_BACKDOOR" in composed).toBe(false);
    expect("SILVERHAND_DAEMON_NPM_SPEC" in composed).toBe(false);

    // Credentials gone.
    expect("AWS_SECRET_ACCESS_KEY" in composed).toBe(false);
    expect("GITHUB_TOKEN" in composed).toBe(false);
    expect("OPENAI_API_KEY" in composed).toBe(false);

    // Injection vectors gone.
    expect("DYLD_INSERT_LIBRARIES" in composed).toBe(false);
    expect("LD_PRELOAD" in composed).toBe(false);
    expect("NODE_OPTIONS" in composed).toBe(false);

    // Exhaustive: every key is either an allowlisted OS key or a boundary key — nothing
    // else can hide in the composed env.
    const allowedOsKeys = new Set([
      "PATH",
      "HOME",
      "TMPDIR",
      "TMP",
      "TEMP",
      "LANG",
      "LC_ALL",
      "LC_CTYPE",
      "TZ",
      "SystemRoot",
      "SystemDrive",
      "windir",
      "USERPROFILE",
      "PATHEXT",
      "COMSPEC",
    ]);
    const boundaryKeys = new Set(Object.keys(boundary));
    for (const key of Object.keys(composed)) {
      expect(allowedOsKeys.has(key) || boundaryKeys.has(key)).toBe(true);
    }
  });

  it("a launcher-boundary key always wins over an inherited allowlisted key of the same name", () => {
    const composed = composeRustBackendChildEnv(
      {
        PATH: "/trusted/bin",
        SILVERHAND_DATABASE_PATH: "/y/db",
        SILVERHAND_DAEMON_NPM_SPEC: "trusted@1",
      },
      { PATH: "/bin", SILVERHAND_DAEMON_NPM_SPEC: "evil" },
    );
    expect(composed.PATH).toBe("/trusted/bin");
    expect(composed.SILVERHAND_DATABASE_PATH).toBe("/y/db");
    expect(composed.SILVERHAND_DAEMON_NPM_SPEC).toBe("trusted@1");
  });
});
