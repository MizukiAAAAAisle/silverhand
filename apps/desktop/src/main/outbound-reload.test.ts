import { describe, expect, it } from "vitest";
import type { HostWsAttachment } from "@silverhand/backend";
import type {
  ClassifyServerUrlOptions,
  DaemonHostConfig,
  ServerUrlClassification,
} from "@silverhand/shared";
import { classifyServerUrl } from "@silverhand/shared";
import type { HostOutboundReloadResult } from "@silverhand/host";
import type {
  AttachWatchdogOutcome,
  ExpectedAttachWindow,
  AttachWatchdogDeps,
} from "./outbound-attach.js";
import {
  performOutboundReload,
  bindAttachmentAccessor,
  type PerformOutboundReloadDeps,
} from "./outbound-reload.js";

interface FakeState {
  classifyCalls: string[];
  classifyOptions: Array<ClassifyServerUrlOptions | undefined>;
  writeCalls: DaemonHostConfig[];
  reloadCalls: number;
  watchdogCalls: {
    window: ExpectedAttachWindow;
    deps: AttachWatchdogDeps;
  }[];
}

function makeAttachment(overrides?: Partial<HostWsAttachment>): HostWsAttachment {
  return {
    hostId: "host-1",
    connectionId: "conn-old",
    attachedAt: 1_700_000_000_000,
    hostname: null,
    capabilities: [],
    ...overrides,
  };
}

interface FakeOptions {
  classify?: (input: string, options?: ClassifyServerUrlOptions) => ServerUrlClassification;
  allowInsecureRemote?: boolean;
  writeThrows?: Error;
  reloadResult?: HostOutboundReloadResult;
  reloadThrows?: Error;
  attachment?: HostWsAttachment | null;
  /** When provided, watchdog resolves with this outcome immediately. */
  watchdogOutcome?: AttachWatchdogOutcome;
  hostId?: string | null;
  hostToken?: string | null;
  /** D4.a Commit 5c-1: optional `currentProfileVersion` dep — when
   *  `null` the dep is omitted entirely from the deps object so the
   *  test exercises the "unwired in tests" path; when a number, it
   *  is returned as the current value; when `undefined` (i.e. caller
   *  did not set the field), the dep is wired but returns
   *  `undefined` (matching a config that has no `profile_version`). */
  currentProfileVersion?: number | undefined | null;
  /** Defaults to a fixed clock starting at 1_700_000_010_000. */
  now?: () => number;
}

function makeDeps(opts: FakeOptions = {}): {
  deps: PerformOutboundReloadDeps;
  state: FakeState;
} {
  const state: FakeState = {
    classifyCalls: [],
    classifyOptions: [],
    writeCalls: [],
    reloadCalls: 0,
    watchdogCalls: [],
  };
  const defaultClassify = (input: string): ServerUrlClassification => {
    if (input === "__bad__") {
      return { ok: false, reason: "malformed_url", message: "Invalid URL" };
    }
    return { ok: true, kind: "loopback", url: new URL(input) };
  };
  const reloadResult: HostOutboundReloadResult = opts.reloadResult ?? {
    reloaded: true,
    action: "reloaded",
    config_path: "/fake/daemon-config.json",
    host_id: "host-1",
  };
  const deps: PerformOutboundReloadDeps = {
    classifyServerUrl: (input, options) => {
      state.classifyCalls.push(input);
      state.classifyOptions.push(options);
      return (opts.classify ?? defaultClassify)(input, options);
    },
    allowInsecureRemote: opts.allowInsecureRemote,
    writeDaemonHostConfig: (config) => {
      if (opts.writeThrows) throw opts.writeThrows;
      state.writeCalls.push(config);
    },
    hostOutboundReload: async () => {
      state.reloadCalls += 1;
      if (opts.reloadThrows) throw opts.reloadThrows;
      return reloadResult;
    },
    getAttachment: (_id) => opts.attachment ?? null,
    currentLocalHostId: () => (opts.hostId === undefined ? "host-1" : opts.hostId),
    currentHostToken: () => (opts.hostToken === undefined ? "tok-1" : opts.hostToken),
    // 5c-1 carry-through dep. `null` opt-out exercises the
    // "currentProfileVersion not wired" path (matches D3.x callers /
    // tests written before 5c-1). Local capture narrows the closure
    // type from `number | null | undefined` to `number | undefined`.
    ...(() => {
      if (opts.currentProfileVersion === null) return {};
      const captured: number | undefined = opts.currentProfileVersion;
      return { currentProfileVersion: () => captured };
    })(),
    startWatchdog: (window, watchdogDeps) => {
      state.watchdogCalls.push({ window, deps: watchdogDeps });
      const outcome: AttachWatchdogOutcome = opts.watchdogOutcome ?? {
        ok: true,
        attachment: makeAttachment({ connectionId: "conn-new", attachedAt: 1_700_000_011_000 }),
        elapsedMs: 30,
      };
      return {
        promise: Promise.resolve(outcome),
        abort: () => {},
      };
    },
    now: opts.now ?? (() => 1_700_000_010_000),
  };
  return { deps, state };
}

describe("performOutboundReload — anchor 1: raw input classify", () => {
  it("classify_rejected surfaces malformed_url verbatim and skips write + IPC", async () => {
    const { deps, state } = makeDeps();
    const out = await performOutboundReload({ serverUrl: "__bad__" }, deps);
    expect(out).toEqual({
      ok: false,
      kind: "classify_rejected",
      reason: "malformed_url",
      message: "Invalid URL",
    });
    expect(state.writeCalls).toEqual([]);
    expect(state.reloadCalls).toBe(0);
    expect(state.watchdogCalls).toEqual([]);
  });

  it("classify_rejected with insecure_remote_http_disallowed short-circuits identically", async () => {
    // D4.a Commit 1 — replaces D3's `non_loopback_host` test. Same
    // wire behavior (no write, no reload IPC), new typed reason
    // pointing at the dev-flag / https escape routes.
    const { deps, state } = makeDeps({
      classify: () => ({
        ok: false,
        reason: "insecure_remote_http_disallowed",
        message:
          "Backend host 'example.com' is non-loopback over http://. " +
          "Use https://, or set SILVERHAND_ALLOW_INSECURE_REMOTE=1 for dev use.",
      }),
    });
    const out = await performOutboundReload({ serverUrl: "http://example.com" }, deps);
    expect(out.ok).toBe(false);
    if (out.ok) throw new Error("unreachable");
    if (out.kind !== "classify_rejected") throw new Error("unreachable");
    expect(out.reason).toBe("insecure_remote_http_disallowed");
    expect(state.writeCalls).toEqual([]);
    expect(state.reloadCalls).toBe(0);
  });

  it("passes the caller insecure-remote-http opt-in into the classifier", async () => {
    const { deps, state } = makeDeps({
      allowInsecureRemote: true,
      classify: (_input, options) => {
        expect(options).toEqual({ allowInsecureRemote: true });
        return {
          ok: true,
          kind: "remote",
          url: new URL("http://215.192.147.162:8080/"),
          insecure: true,
        };
      },
    });
    const out = await performOutboundReload({ serverUrl: "http://215.192.147.162:8080" }, deps);
    expect(out.ok).toBe(true);
    expect(state.classifyOptions).toEqual([{ allowInsecureRemote: true }]);
    expect(state.writeCalls[0]!.server_url).toBe("http://215.192.147.162:8080/");
    expect(state.writeCalls[0]!.allow_insecure_remote).toBe(true);
  });

  it("admits real non-loopback http classification when the caller opted in", async () => {
    const { deps, state } = makeDeps({
      allowInsecureRemote: true,
      classify: classifyServerUrl,
    });
    const out = await performOutboundReload({ serverUrl: "http://215.192.147.162:8080" }, deps);
    expect(out.ok).toBe(true);
    expect(state.writeCalls).toHaveLength(1);
    expect(state.writeCalls[0]!.server_url).toBe("http://215.192.147.162:8080/");
    expect(state.writeCalls[0]!.allow_insecure_remote).toBe(true);
  });

  it("keeps real non-loopback http rejected without caller opt-in", async () => {
    const { deps, state } = makeDeps({ classify: classifyServerUrl });
    const out = await performOutboundReload({ serverUrl: "http://215.192.147.162:8080" }, deps);
    expect(out.ok).toBe(false);
    if (out.ok) throw new Error("unreachable");
    expect(out.kind).toBe("classify_rejected");
    if (out.kind !== "classify_rejected") throw new Error("unreachable");
    expect(out.reason).toBe("insecure_remote_http_disallowed");
    expect(state.writeCalls).toEqual([]);
    expect(state.reloadCalls).toBe(0);
  });

  // #task:1008 — remote acceptance has landed. When the classifier
  // admits a remote URL (https, or http+dev-flag), the Settings layer
  // no longer short-circuits: the URL flows straight through the same
  // write → reload → watchdog pipeline as loopback. This pins that a
  // classified remote URL DOES write the new bytes and fire the
  // reload IPC (the old `remote_backend_not_yet_supported` guard is
  // gone — insecure http is still rejected at classify, tested above).
  it.each<{
    label: string;
    classified: { ok: true; kind: "remote"; url: URL; insecure: boolean };
  }>([
    {
      label: "remote https",
      classified: {
        ok: true,
        kind: "remote",
        url: new URL("https://api.example.com/"),
        insecure: false,
      },
    },
    {
      label: "remote http with dev flag",
      classified: {
        ok: true,
        kind: "remote",
        url: new URL("http://10.0.0.5:8080/"),
        insecure: true,
      },
    },
  ])("classified remote URL flows through to write + reload ($label)", async ({ classified }) => {
    const { deps, state } = makeDeps({ classify: () => classified });
    const out = await performOutboundReload({ serverUrl: classified.url.toString() }, deps);
    // Default deps reload as `action: 'reloaded'` then the watchdog
    // resolves ok → `reloaded` success arm. The point of the test
    // is that the remote URL reached the pipeline at all.
    expect(out.ok).toBe(true);
    if (!out.ok) throw new Error("unreachable");
    expect(out.kind).toBe("reloaded");
    // The remote URL's normalized form was written to daemon-config
    // and the reload IPC fired — no Settings-layer short-circuit.
    expect(state.writeCalls).toHaveLength(1);
    expect(state.writeCalls[0]!.server_url).toBe(classified.url.toString());
    expect(state.reloadCalls).toBe(1);
    expect(state.watchdogCalls).toHaveLength(1);
  });

  it("classify_rejected with unsupported_scheme short-circuits identically", async () => {
    const { deps, state } = makeDeps({
      classify: () => ({
        ok: false,
        reason: "unsupported_scheme",
        message: "Unsupported scheme 'ws:'.",
      }),
    });
    const out = await performOutboundReload({ serverUrl: "ws://127.0.0.1" }, deps);
    expect(out.ok).toBe(false);
    if (out.ok) throw new Error("unreachable");
    if (out.kind !== "classify_rejected") throw new Error("unreachable");
    expect(out.reason).toBe("unsupported_scheme");
    expect(state.writeCalls).toEqual([]);
  });
});

describe("performOutboundReload — preconditions", () => {
  it("returns reload_rejected/not_attached when no current local host id (renderer never sees an IPC fire)", async () => {
    const { deps, state } = makeDeps({ hostId: null });
    const out = await performOutboundReload({ serverUrl: "http://127.0.0.1:8765" }, deps);
    expect(out.ok).toBe(false);
    if (out.ok) throw new Error("unreachable");
    if (out.kind !== "reload_rejected") throw new Error("unreachable");
    expect(out.reason).toBe("not_attached");
    expect(state.writeCalls).toEqual([]);
    expect(state.reloadCalls).toBe(0);
  });

  it("returns reload_rejected/not_attached when no in-memory host token", async () => {
    const { deps, state } = makeDeps({ hostToken: null });
    const out = await performOutboundReload({ serverUrl: "http://127.0.0.1:8765" }, deps);
    expect(out.ok).toBe(false);
    if (out.ok) throw new Error("unreachable");
    if (out.kind !== "reload_rejected") throw new Error("unreachable");
    expect(out.reason).toBe("not_attached");
    expect(state.writeCalls).toEqual([]);
    expect(state.reloadCalls).toBe(0);
  });
});

describe("performOutboundReload — anchor 2: atomic write before reload IPC", () => {
  it("config_write_failed surfaces the throw message and MUST NOT fire the reload IPC", async () => {
    const { deps, state } = makeDeps({
      writeThrows: new Error("EACCES /fake/daemon-config.json"),
    });
    const out = await performOutboundReload({ serverUrl: "http://127.0.0.1:8765" }, deps);
    expect(out).toEqual({
      ok: false,
      kind: "config_write_failed",
      message: "EACCES /fake/daemon-config.json",
    });
    expect(state.reloadCalls).toBe(0);
    expect(state.watchdogCalls).toEqual([]);
  });

  it("writes normalized URL form (not raw input) — keeps on-disk config tidy across save cycles", async () => {
    const { deps, state } = makeDeps();
    // URL constructor strips default port 80 for http: and lowercases
    // scheme/host, so a trailing slash / mixed case input becomes a
    // canonical form on disk.
    await performOutboundReload({ serverUrl: "HTTP://127.0.0.1:80/" }, deps);
    expect(state.writeCalls).toHaveLength(1);
    expect(state.writeCalls[0]!.server_url).toBe("http://127.0.0.1/");
  });

  it("write happens BEFORE reload IPC (sequence pin)", async () => {
    const { deps, state } = makeDeps();
    let writeIndex = -1;
    let reloadIndex = -1;
    let counter = 0;
    deps.writeDaemonHostConfig = (config) => {
      writeIndex = counter++;
      state.writeCalls.push(config);
    };
    deps.hostOutboundReload = async () => {
      reloadIndex = counter++;
      state.reloadCalls += 1;
      return {
        reloaded: true,
        action: "unchanged",
        config_path: "/fake",
        host_id: "host-1",
      };
    };
    await performOutboundReload({ serverUrl: "http://127.0.0.1:8765" }, deps);
    expect(writeIndex).toBeGreaterThanOrEqual(0);
    expect(reloadIndex).toBeGreaterThanOrEqual(0);
    expect(writeIndex).toBeLessThan(reloadIndex);
  });
});

describe("performOutboundReload — daemon reason pass-through", () => {
  const reasons: ReadonlyArray<
    "not_attached" | "config_unreadable" | "parse_failed" | "invalid_server_url"
  > = ["not_attached", "config_unreadable", "parse_failed", "invalid_server_url"];

  for (const reason of reasons) {
    it(`reload reason=${reason} is surfaced verbatim as reload_rejected`, async () => {
      const { deps, state } = makeDeps({
        reloadResult: { reloaded: false, reason, message: `daemon said: ${reason}` },
      });
      const out = await performOutboundReload({ serverUrl: "http://127.0.0.1:8765" }, deps);
      expect(out.ok).toBe(false);
      if (out.ok) throw new Error("unreachable");
      expect(out.kind).toBe("reload_rejected");
      if (out.kind !== "reload_rejected") throw new Error("unreachable");
      expect(out.reason).toBe(reason);
      expect(out.message).toBe(`daemon said: ${reason}`);
      // Write happened (we sent the IPC with the new bytes), but
      // the watchdog DID NOT fire — daemon refused to swap, so
      // there's no fresh attachment to wait for.
      expect(state.writeCalls).toHaveLength(1);
      expect(state.watchdogCalls).toEqual([]);
    });
  }

  it("reload IPC transport failure maps to reload_rejected/not_attached with the throw message", async () => {
    const { deps, state } = makeDeps({
      reloadThrows: new Error("socket closed mid-call"),
    });
    const out = await performOutboundReload({ serverUrl: "http://127.0.0.1:8765" }, deps);
    expect(out.ok).toBe(false);
    if (out.ok) throw new Error("unreachable");
    expect(out.kind).toBe("reload_rejected");
    if (out.kind !== "reload_rejected") throw new Error("unreachable");
    expect(out.reason).toBe("not_attached");
    expect(out.message).toBe("socket closed mid-call");
    expect(state.watchdogCalls).toEqual([]);
  });
});

describe("performOutboundReload — anchor 3: reloaded ≠ connected", () => {
  it("action=unchanged skips the watchdog and returns success directly (no WS bounce)", async () => {
    const { deps, state } = makeDeps({
      reloadResult: {
        reloaded: true,
        action: "unchanged",
        config_path: "/fake",
        host_id: "host-1",
      },
    });
    const out = await performOutboundReload({ serverUrl: "http://127.0.0.1:8765" }, deps);
    expect(out).toEqual({ ok: true, kind: "unchanged" });
    expect(state.watchdogCalls).toEqual([]);
  });

  it("action=unchanged succeeds even when getAttachment is null — no_attachment_controller MUST gate only the reloaded-watchdog path (Cindy `#task:634` review note 2)", async () => {
    // Concern: if the orchestrator gated `no_attachment_controller`
    // before the unchanged short-circuit, a save-with-no-byte-change
    // would surface as `no_attachment_controller` whenever the
    // backend mode lacks a HostWsController — even though there's
    // no swap and no reconnect to verify. The controller check
    // belongs strictly on the path that actually NEEDS a fresh
    // attachment.
    const { deps, state } = makeDeps({
      reloadResult: {
        reloaded: true,
        action: "unchanged",
        config_path: "/fake",
        host_id: "host-1",
      },
    });
    deps.getAttachment = null;
    const out = await performOutboundReload({ serverUrl: "http://127.0.0.1:8765" }, deps);
    expect(out).toEqual({ ok: true, kind: "unchanged" });
    expect(state.watchdogCalls).toEqual([]);
  });

  it("action=reloaded fires the watchdog with the pre-write snapshot", async () => {
    const prev = makeAttachment({ connectionId: "conn-pre", attachedAt: 1_699_999_000_000 });
    const { deps, state } = makeDeps({ attachment: prev });
    const out = await performOutboundReload({ serverUrl: "http://127.0.0.1:8765" }, deps);
    expect(out.ok).toBe(true);
    if (!out.ok) throw new Error("unreachable");
    expect(out.kind).toBe("reloaded");
    expect(state.watchdogCalls).toHaveLength(1);
    const window = state.watchdogCalls[0]!.window;
    expect(window).toEqual({
      expectedHostId: "host-1",
      previousConnectionId: "conn-pre",
      expectAttachSince: 1_700_000_010_000,
    });
  });

  it("action=reloaded + watchdog success returns kind=reloaded with elapsedMs and attachedAt", async () => {
    const fresh = makeAttachment({ connectionId: "conn-new", attachedAt: 1_700_000_011_000 });
    const { deps } = makeDeps({
      watchdogOutcome: { ok: true, attachment: fresh, elapsedMs: 42 },
    });
    const out = await performOutboundReload({ serverUrl: "http://127.0.0.1:8765" }, deps);
    expect(out).toEqual({
      ok: true,
      kind: "reloaded",
      elapsedMs: 42,
      attachedAt: 1_700_000_011_000,
    });
  });

  it("action=reloaded + watchdog timeout returns success-arm connectivity_unverified (NOT a failure)", async () => {
    // The user's CONFIG IS SAVED — the daemon acked `reloaded: true`.
    // Timeout means "we didn't observe the new WS within budget",
    // which most often means the backend is unreachable on the new
    // URL. Surfacing this as a failure would mislead the user into
    // thinking their save was lost. Mirrors the D3.a attach-side
    // policy where UI status stays `connecting` on timeout.
    const { deps } = makeDeps({
      watchdogOutcome: { ok: false, reason: "timeout", elapsedMs: 10_000 },
    });
    const out = await performOutboundReload({ serverUrl: "http://127.0.0.1:8765" }, deps);
    expect(out).toEqual({
      ok: true,
      kind: "connectivity_unverified",
      elapsedMs: 10_000,
    });
  });

  it("action=reloaded + getAttachment null returns no_attachment_controller (caller saw daemon ack reload but cannot observe WS)", async () => {
    const { deps, state } = makeDeps();
    deps.getAttachment = null;
    const out = await performOutboundReload({ serverUrl: "http://127.0.0.1:8765" }, deps);
    expect(out.ok).toBe(false);
    if (out.ok) throw new Error("unreachable");
    expect(out.kind).toBe("no_attachment_controller");
    // Write happened (config IS updated on disk); just no controller.
    expect(state.writeCalls).toHaveLength(1);
    expect(state.watchdogCalls).toEqual([]);
  });

  it("action=reloaded + getAttachment null + remoteMode → reloaded_remote (NOT no_attachment_controller) — `#task:1021`", async () => {
    // Remote backend: the in-process HostWsServerController is
    // structurally absent (it lives in the remote backend process), so
    // `getAttachment` is null — same root cause as the #task:1010 pill.
    // But the daemon DID swap (reloaded), and connectivity is observable
    // out-of-band via the renderer's connection indicator (host-status
    // `availability`). So this is the `reloaded_remote` SUCCESS arm, not
    // the misleading `no_attachment_controller` "can't verify" failure.
    const { deps, state } = makeDeps();
    deps.getAttachment = null;
    deps.remoteMode = true;
    const out = await performOutboundReload({ serverUrl: "https://sandbox.example.com" }, deps);
    expect(out).toEqual({ ok: true, kind: "reloaded_remote" });
    // Config IS saved; no watchdog is started (nothing local to watch).
    expect(state.writeCalls).toHaveLength(1);
    expect(state.watchdogCalls).toEqual([]);
  });

  it("action=reloaded + getAttachment null + remoteMode=false stays no_attachment_controller (headless / unsupported edge keeps the failure arm)", async () => {
    // Contrast pin for the test above: the `reloaded_remote` promotion
    // must be gated on `remoteMode`. Without it (headless test, no
    // indicator to defer to) verification is genuinely impossible and
    // the failure arm must remain reachable.
    const { deps } = makeDeps();
    deps.getAttachment = null;
    deps.remoteMode = false;
    const out = await performOutboundReload({ serverUrl: "http://127.0.0.1:8765" }, deps);
    expect(out.ok).toBe(false);
    if (out.ok) throw new Error("unreachable");
    expect(out.kind).toBe("no_attachment_controller");
  });
});

describe("performOutboundReload — anchor 3 freshness contract pin", () => {
  it("snapshot expectAttachSince is captured BEFORE writeDaemonHostConfig (not after, not after IPC ack)", async () => {
    // If the lower bound were captured AFTER the write or AFTER the
    // IPC, an attachment whose attachedAt got stamped between the
    // write and the snapshot would fail `attachedAt >=
    // expectAttachSince` and the watchdog would loop until the
    // connectionId branch caught it or the budget expired. We pin
    // the BEFORE-write order by making `now()` advance through the
    // call and asserting the snapshot equals the value sampled
    // BEFORE the write callback ran.
    const ticks: number[] = [];
    let counter = 1_700_000_010_000;
    const now = (): number => {
      counter += 1;
      ticks.push(counter);
      return counter;
    };
    const { deps, state } = makeDeps({ now });
    // Record the value `now` was at just before the write fired.
    let preWriteNow = -1;
    deps.writeDaemonHostConfig = (config) => {
      // The orchestrator must have already sampled now() into
      // expectAttachSince at this point — before the write call.
      preWriteNow = counter;
      state.writeCalls.push(config);
    };
    await performOutboundReload({ serverUrl: "http://127.0.0.1:8765" }, deps);
    expect(state.watchdogCalls).toHaveLength(1);
    const expect_since = state.watchdogCalls[0]!.window.expectAttachSince;
    // expect_since was taken BEFORE write (i.e. <= preWriteNow,
    // since preWriteNow was sampled at write-call time AFTER
    // expectAttachSince was already set).
    expect(expect_since).toBeLessThanOrEqual(preWriteNow);
  });

  it("previousConnectionId is captured from the snapshot BEFORE write (not from a post-reload re-snapshot)", async () => {
    // Two get-attachment calls would be a regression: one for the
    // snapshot and one for the watchdog. The watchdog deps re-poll
    // independently, but the WINDOW (used by the predicate) must
    // freeze the pre-write connectionId so the predicate's
    // connection-id branch fires when the WS reconnects with a
    // NEW connection id.
    const prev = makeAttachment({ connectionId: "conn-frozen-pre-write" });
    const { deps, state } = makeDeps({ attachment: prev });
    await performOutboundReload({ serverUrl: "http://127.0.0.1:8765" }, deps);
    expect(state.watchdogCalls).toHaveLength(1);
    expect(state.watchdogCalls[0]!.window.previousConnectionId).toBe("conn-frozen-pre-write");
  });
});

describe("performOutboundReload — happy path end-to-end shape", () => {
  it("writes host_token from currentHostToken (not from input) so renderer NEVER provides token bytes", async () => {
    const { deps, state } = makeDeps({ hostToken: "secret-from-main-memory" });
    await performOutboundReload({ serverUrl: "http://127.0.0.1:8765" }, deps);
    expect(state.writeCalls[0]).toEqual({
      server_url: "http://127.0.0.1:8765/",
      host_id: "host-1",
      host_token: "secret-from-main-memory",
    });
  });

  // ── profile_version carry-through ──────────────────────

  it("writes profile_version when currentProfileVersion returns a value (legacy save preserves the field)", async () => {
    // Legacy `settings:saveServerUrl` is NOT a profile commit — it
    // does not bump the version. Carrying through whatever the
    // current daemon-config has stamped means the daemon's
    // `<none>` ↔ value transitions reflect ONLY profile commits.
    const { deps, state } = makeDeps({ currentProfileVersion: 7 });
    await performOutboundReload({ serverUrl: "http://127.0.0.1:8765" }, deps);
    expect(state.writeCalls[0]).toEqual({
      server_url: "http://127.0.0.1:8765/",
      host_id: "host-1",
      host_token: "tok-1",
      profile_version: 7,
    });
  });

  it("omits profile_version when currentProfileVersion returns undefined (legacy save on a D3.x config)", async () => {
    // Default `undefined` mirrors a D3.x daemon-config that pre-dates
    // the 5b schema field. The orchestrator MUST emit absent (not
    // explicit undefined) so the daemon fingerprint encodes `<none>`,
    // matching the existing on-disk state.
    const { deps, state } = makeDeps({ currentProfileVersion: undefined });
    await performOutboundReload({ serverUrl: "http://127.0.0.1:8765" }, deps);
    const written = state.writeCalls[0]!;
    expect(written).toEqual({
      server_url: "http://127.0.0.1:8765/",
      host_id: "host-1",
      host_token: "tok-1",
    });
    expect("profile_version" in written).toBe(false);
  });

  it("stamps allow_insecure_remote when the caller opted into insecure remote http", async () => {
    const { deps, state } = makeDeps({
      allowInsecureRemote: true,
      currentProfileVersion: undefined,
    });
    await performOutboundReload({ serverUrl: "http://127.0.0.1:8765" }, deps);
    expect(state.writeCalls[0]).toEqual({
      server_url: "http://127.0.0.1:8765/",
      host_id: "host-1",
      host_token: "tok-1",
      allow_insecure_remote: true,
    });
  });

  it("omits profile_version when the dep is unwired entirely (D3.x callers / pre-5c-1 tests)", async () => {
    // `currentProfileVersion: null` opts out of wiring the dep at all —
    // simulates a caller that hasn't been updated to 5c-1 yet. The
    // orchestrator must not throw and must produce a config without
    // the field.
    const { deps, state } = makeDeps({ currentProfileVersion: null });
    await performOutboundReload({ serverUrl: "http://127.0.0.1:8765" }, deps);
    const written = state.writeCalls[0]!;
    expect(written).toEqual({
      server_url: "http://127.0.0.1:8765/",
      host_id: "host-1",
      host_token: "tok-1",
    });
    expect("profile_version" in written).toBe(false);
  });
});

describe("bindAttachmentAccessor — controller snapshot contract (Cindy `#task:634` review P2)", () => {
  it("returns null when controller is null — orchestrator no_attachment_controller arm reachable", () => {
    // Load-bearing: without this contract, main wiring that always
    // returns a non-null function (even one whose body returns null)
    // would make `no_attachment_controller` unreachable in
    // production. Every "missing controller" case would silently
    // fall through to the watchdog, polling nothing for 10s, and
    // surface as `connectivity_unverified` — wasting the budget AND
    // lying about which mode-specific edge happened.
    const accessor = bindAttachmentAccessor(null);
    expect(accessor).toBeNull();
  });

  it("returns a delegating function when controller is non-null", () => {
    const fakeAttachment = makeAttachment({ connectionId: "conn-1" });
    const controller = {
      getAttachment: (_id: string) => fakeAttachment,
    };
    const accessor = bindAttachmentAccessor(controller);
    expect(accessor).not.toBeNull();
    expect(accessor?.("host-1")).toBe(fakeAttachment);
  });

  it("end-to-end: bindAttachmentAccessor(null) + orchestrator action=reloaded → no_attachment_controller (NOT watchdog timeout)", async () => {
    // Composition pin: the helper plus the orchestrator together
    // must produce `no_attachment_controller` for the missing-
    // controller production case. Without the helper, main's old
    // wiring `(hostId) => controller?.getAttachment(hostId) ?? null`
    // produced a non-null function and the orchestrator started the
    // watchdog → connectivity_unverified after 10s.
    const { deps, state } = makeDeps();
    deps.getAttachment = bindAttachmentAccessor(null);
    const out = await performOutboundReload({ serverUrl: "http://127.0.0.1:8765" }, deps);
    expect(out.ok).toBe(false);
    if (out.ok) throw new Error("unreachable");
    expect(out.kind).toBe("no_attachment_controller");
    expect(state.watchdogCalls).toEqual([]);
  });

  it("end-to-end: bindAttachmentAccessor(real) + action=reloaded → watchdog runs → reloaded outcome", async () => {
    const fresh = makeAttachment({ connectionId: "conn-new", attachedAt: 1_700_000_011_000 });
    const controller = {
      getAttachment: (_id: string) => fresh,
    };
    const { deps } = makeDeps({
      watchdogOutcome: { ok: true, attachment: fresh, elapsedMs: 25 },
    });
    deps.getAttachment = bindAttachmentAccessor(controller);
    const out = await performOutboundReload({ serverUrl: "http://127.0.0.1:8765" }, deps);
    expect(out.ok).toBe(true);
    if (!out.ok) throw new Error("unreachable");
    expect(out.kind).toBe("reloaded");
  });
});
