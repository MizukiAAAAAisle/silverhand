import { describe, expect, it } from "vitest";
import type { DesktopSaveServerUrlResult } from "../../../preload/api";
import { describeSaveServerUrlOutcome } from "./describe-save-server-url-outcome";

describe("describeSaveServerUrlOutcome — success arms", () => {
  it("reloaded uses tone=success and reports the elapsed reconnect time", () => {
    const banner = describeSaveServerUrlOutcome({
      ok: true,
      kind: "reloaded",
      elapsedMs: 380,
      attachedAt: 1_700_000_000_000,
    });
    expect(banner.tone).toBe("success");
    expect(banner.description).toMatch(/380\s*ms/);
  });

  it("unchanged uses tone=info and does NOT claim connection state", () => {
    const banner = describeSaveServerUrlOutcome({
      ok: true,
      kind: "unchanged",
    });
    expect(banner.tone).toBe("info");
    // The connection is whatever it was before; UI must not imply
    // a verified state from this arm.
    expect(banner.title.toLowerCase()).not.toMatch(/connected/);
    expect(banner.description).toBe("");
  });

  it('connectivity_unverified uses tone=info and MUST NOT render as "Connected" (Cindy review note 1)', () => {
    // Load-bearing assertion: if a future refactor collapses
    // connectivity_unverified into the same copy as reloaded, this
    // test fails loud. The user's CONFIG is saved but the WS
    // attachment was not observed within budget — UI must not
    // imply a verified state.
    const banner = describeSaveServerUrlOutcome({
      ok: true,
      kind: "connectivity_unverified",
      elapsedMs: 10_000,
    });
    expect(banner.tone).toBe("info");
    // Anti-claim: the headline MUST NOT say "Connected".
    expect(banner.title.toLowerCase()).not.toMatch(/\bconnected\b/);
    expect(banner.dismissOnReady).toBe(true);
    // Cindy note 1 verbatim: the renderer cannot collapse
    // connectivity_unverified into the reloaded copy. Cross-check
    // by direct comparison against the reloaded headline.
    const reloaded = describeSaveServerUrlOutcome({
      ok: true,
      kind: "reloaded",
      elapsedMs: 380,
      attachedAt: 1_700_000_000_000,
    });
    expect(banner.title).not.toBe(reloaded.title);
    expect(banner.description).toMatch(/10\.0\s*s/);
  });

  it('reloaded_remote uses tone=info, points at the live indicator, stays direction-free, and MUST NOT claim "Connected"/"not available" (`#task:1021`)', () => {
    // Regression for shiki's report: in remote mode every save (even a
    // correct sandbox URL) showed "Connection check is not available in
    // this mode." That copy is wrong — connectivity IS shown live by the
    // "This computer" indicator (host-status `availability`, #task:1010).
    // The `reloaded_remote` arm must point the user there instead.
    const banner = describeSaveServerUrlOutcome({
      ok: true,
      kind: "reloaded_remote",
    });
    expect(banner.tone).toBe("info");
    // The exact misleading phrasing must be gone.
    expect(banner.title.toLowerCase()).not.toMatch(/not available/);
    expect(banner.description.toLowerCase()).not.toMatch(/not available/);
    expect(banner.description.toLowerCase()).not.toMatch(/cannot verify/);
    // Points the user at the live connection indicator.
    expect(banner.description.toLowerCase()).toMatch(/this computer/);
    // Cindy `#task:1021` review P2 — copy must stay direction-free: the
    // banner and the "This computer" indicator are separate sections of
    // ConnectionPane whose relative order can change, so a directional
    // word ("above"/"below") would be a layout-coupled lie.
    expect(banner.description.toLowerCase()).not.toMatch(/\babove\b|\bbelow\b/);
    // Anti-claim: must not say "Connected".
    expect(banner.title.toLowerCase()).not.toMatch(/\bconnected\b/);
    expect(banner.dismissOnReady).toBe(true);
  });

  it("formatMs switches to seconds at >= 1000ms", () => {
    // Sub-second renders as integer ms; ≥ 1000ms renders as 1dp s.
    const fast = describeSaveServerUrlOutcome({
      ok: true,
      kind: "reloaded",
      elapsedMs: 999,
      attachedAt: 0,
    });
    expect(fast.description).toMatch(/999\s*ms/);
    const slow = describeSaveServerUrlOutcome({
      ok: true,
      kind: "reloaded",
      elapsedMs: 1500,
      attachedAt: 0,
    });
    expect(slow.description).toMatch(/1\.5\s*s/);
  });
});

describe("describeSaveServerUrlOutcome — classify_rejected reasons", () => {
  const cases: ReadonlyArray<{
    reason: Extract<DesktopSaveServerUrlResult, { kind: "classify_rejected" }>["reason"];
    titleMatch: RegExp;
  }> = [
    { reason: "malformed_url", titleMatch: /not a valid url/i },
    { reason: "unsupported_scheme", titleMatch: /http:\/\/ or https:\/\//i },
    // D4.a Commit 2 fixup (Cindy review) — non_origin_url. Title
    // must mention "origin" so the user understands the rejection
    // shape rather than treating it as a generic URL-validity
    // failure.
    { reason: "non_origin_url", titleMatch: /origin/i },
    // D4.a Commit 1 — replaces D3's `non_loopback_host` case. Title
    // must point the user at the two valid escape routes (use
    // https, or set the dev env flag) rather than the obsolete
    // "loopback only" message.
    {
      reason: "insecure_remote_http_disallowed",
      titleMatch: /https:\/\/.*SILVERHAND_ALLOW_INSECURE_REMOTE/i,
    },
    // D4.a Commit 1 review — disguised loopback. Title must mention
    // the "disguised loopback" framing so the user understands the
    // gate fired because their URL form mismatched the host it
    // would actually connect to (not a "this URL is malformed"
    // false positive).
    {
      reason: "obfuscated_loopback_disallowed",
      titleMatch: /disguised loopback/i,
    },
  ];

  for (const c of cases) {
    it(`classify_rejected/${c.reason} → tone=error with reason-specific headline`, () => {
      const banner = describeSaveServerUrlOutcome({
        ok: false,
        kind: "classify_rejected",
        reason: c.reason,
        message: "classifier verbatim message",
      });
      expect(banner.tone).toBe("error");
      expect(banner.title).toMatch(c.titleMatch);
      expect(banner.description).toBe("classifier verbatim message");
    });
  }
});

describe("describeSaveServerUrlOutcome — reload_rejected reasons", () => {
  const cases: ReadonlyArray<{
    reason: Extract<DesktopSaveServerUrlResult, { kind: "reload_rejected" }>["reason"];
    titleMatch: RegExp;
    desc: string;
  }> = [
    { reason: "not_attached", titleMatch: /sign in/i, desc: "" },
    {
      reason: "config_unreadable",
      titleMatch: /could not read/i,
      desc: "Try saving the address again.",
    },
    {
      reason: "parse_failed",
      titleMatch: /could not apply/i,
      desc: "Try saving the address again.",
    },
    { reason: "invalid_server_url", titleMatch: /address was rejected/i, desc: "" },
  ];

  for (const c of cases) {
    it(`reload_rejected/${c.reason} → tone=error, product copy, NO raw daemon message`, () => {
      const banner = describeSaveServerUrlOutcome({
        ok: false,
        kind: "reload_rejected",
        reason: c.reason,
        // Raw backend message MUST NOT reach the banner — pin that the
        // mapper substitutes product copy instead of passing it through.
        message: "daemon could not parse daemon-config.json",
      });
      expect(banner.tone).toBe("error");
      expect(banner.title).toMatch(c.titleMatch);
      expect(banner.description).toBe(c.desc);
    });
  }
});

describe("describeSaveServerUrlOutcome — other failure arms", () => {
  it("config_write_failed → tone=error, NO raw disk path leaked", () => {
    const banner = describeSaveServerUrlOutcome({
      ok: false,
      kind: "config_write_failed",
      message: "EACCES /path/daemon-config.json",
    });
    expect(banner.tone).toBe("error");
    // Raw path / errno withheld from the user-facing banner.
    expect(banner.description).not.toContain("daemon-config.json");
  });

  it("no_attachment_controller → tone=info, NO controller type leaked", () => {
    const banner = describeSaveServerUrlOutcome({
      ok: false,
      kind: "no_attachment_controller",
      message: "backend HostWsServerController unavailable",
    });
    expect(banner.tone).toBe("info");
    expect(banner.description).not.toContain("HostWsServerController");
  });
});

describe("describeSaveServerUrlOutcome — no implementation language in user-visible copy", () => {
  // Guard (Cindy review): the Connection pane renders BOTH title and
  // description verbatim. After the product-copy pass, NO arm may leak
  // implementation words into either field — otherwise a future edit
  // that re-introduces `result.message` passthrough would quietly put
  // daemon/config/attachment jargon back on the primary surface.
  const TECH =
    /daemon|host_token|HostWsController|HostWsServerController|attachment|attach|daemon-config|\bWS\b/i;

  const results: ReadonlyArray<DesktopSaveServerUrlResult> = [
    { ok: true, kind: "reloaded", elapsedMs: 380, attachedAt: 1 },
    { ok: true, kind: "unchanged" },
    { ok: true, kind: "connectivity_unverified", elapsedMs: 10_000 },
    { ok: true, kind: "reloaded_remote" },
    {
      ok: false,
      kind: "config_write_failed",
      message: "EACCES /path/daemon-config.json",
    },
    {
      ok: false,
      kind: "reload_rejected",
      reason: "not_attached",
      message: "no active daemon attachment",
    },
    {
      ok: false,
      kind: "reload_rejected",
      reason: "config_unreadable",
      message: "daemon could not read daemon-config.json",
    },
    {
      ok: false,
      kind: "reload_rejected",
      reason: "parse_failed",
      message: "daemon parse_failed",
    },
    {
      ok: false,
      kind: "reload_rejected",
      reason: "invalid_server_url",
      message: "daemon rejected url",
    },
    {
      ok: false,
      kind: "no_attachment_controller",
      message: "backend HostWsServerController unavailable",
    },
  ];

  for (const result of results) {
    const tag = result.ok ? result.kind : `${result.kind}`;
    it(`${tag} → neither title nor description leaks implementation language`, () => {
      const banner = describeSaveServerUrlOutcome(result);
      expect(banner.title).not.toMatch(TECH);
      expect(banner.description).not.toMatch(TECH);
    });
  }
});
