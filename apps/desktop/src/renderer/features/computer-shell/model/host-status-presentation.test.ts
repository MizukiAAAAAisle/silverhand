import { describe, expect, it } from "vitest";
import type { HostAdmissionFailure, HostStatusResponse } from "@silverhand/shared";
import {
  describeAdmissionFailure,
  describeHostStatus,
  describeUnreachableReason,
  formatUptime,
} from "./host-status-presentation";
import { computerCopy } from "./computer-copy";

/**
 * #task:808 slice 4 — pure mapper tests for `HostStatusResponse` →
 * UI pill view. Pins the stable state semantics per arm — `tone` and
 * `detail` shape (and, for `unreachable`, the per-reason detail via the
 * `describeUnreachableReason` mapper) — plus the anti-collapse invariant
 * (revoked vs disconnected must not share a label). Tone is a stable
 * state semantic, so a tone change (e.g. `unreachable` warning → error)
 * is a deliberate contract edit and SHOULD land here; the label copy is
 * visual and is NOT pinned.
 */

function aHost(hostId = "host-1"): {
  host_id: string;
  last_seen_at: number | null;
} {
  return { host_id: hostId, last_seen_at: 1_700_000_000_000 };
}

describe("describeHostStatus", () => {
  it("maps `available` to a success tone with no detail", () => {
    const view = describeHostStatus({
      ...aHost(),
      availability: "available",
      snapshot: {
        os: "macOS 14.5",
        daemon_pid: 1,
        daemon_version: "0.1.0",
        started_at: 1,
        uptime_ms: 1,
      },
      agents: [],
    } as HostStatusResponse);
    expect(view.tone).toBe("success");
    expect(view.detail).toBeNull();
    expect(view.label.length).toBeGreaterThan(0);
  });

  it("maps `disconnected` to a muted tone with non-empty offline detail", () => {
    const view = describeHostStatus({
      ...aHost(),
      availability: "disconnected",
      agents: [],
    } as HostStatusResponse);
    expect(view.tone).toBe("muted");
    // Detail prepares the user for the offline-but-registration-visible
    // pattern — it is intentionally non-empty.
    expect(view.detail).not.toBeNull();
    expect(view.detail!.length).toBeGreaterThan(0);
  });

  it("maps `unreachable{timeout}` to a warning tone + per-reason detail (via the mapper)", () => {
    const view = describeHostStatus({
      ...aHost(),
      availability: "unreachable",
      reason: "timeout",
      agents: [],
    } as HostStatusResponse);
    expect(view.tone).toBe("warning");
    expect(view.detail).toBe(describeUnreachableReason("timeout"));
  });

  it("maps `unreachable{daemon_unreachable}` reason verbatim into detail", () => {
    const view = describeHostStatus({
      ...aHost(),
      availability: "unreachable",
      reason: "daemon_unreachable",
      agents: [],
    } as HostStatusResponse);
    expect(view.detail).toBe(describeUnreachableReason("daemon_unreachable"));
  });

  it("maps `revoked` to a muted tone with non-empty recovery detail, distinct from disconnected", () => {
    const revoked = describeHostStatus({
      ...aHost(),
      availability: "revoked",
      agents: [],
    } as HostStatusResponse);
    expect(revoked.tone).toBe("muted");
    expect(revoked.detail).not.toBeNull();
    // revoked and disconnected share the muted tone but need different user
    // actions, so their labels must NOT collapse to one.
    const disconnected = describeHostStatus({
      ...aHost(),
      availability: "disconnected",
      agents: [],
    } as HostStatusResponse);
    expect(revoked.label).not.toBe(disconnected.label);
  });

  it("leaves the availability view untouched when `admission_failure` is present", () => {
    // `#task:1631` + shiki 2026-07-26: the upgrade prompt is a page-level
    // notice, not status chrome. So the pill must NOT fork — same label,
    // same tone, same detail as ordinary offline; the extra fact is
    // rendered by `AdmissionFailureNotice` from `describeAdmissionFailure`.
    const stale = describeHostStatus({
      ...aHost(),
      availability: "disconnected",
      agents: [],
      admission_failure: {
        kind: "protocol_mismatch",
        offered_protocol_version: 7,
        expected_protocol_version: 8,
        observed_at: 1_700_000_000_000,
      },
    } as HostStatusResponse);
    const ordinary = describeHostStatus({
      ...aHost(),
      availability: "disconnected",
      agents: [],
    } as HostStatusResponse);
    expect(stale).toEqual(ordinary);
  });
});

describe("describeAdmissionFailure", () => {
  function mismatch(offered: number, expected: number): HostAdmissionFailure {
    return {
      kind: "protocol_mismatch",
      offered_protocol_version: offered,
      expected_protocol_version: expected,
      observed_at: 1_700_000_000_000,
    };
  }

  it("carries both versions in the fact clause", () => {
    const text = describeAdmissionFailure(mismatch(7, 8), {
      appManaged: false,
    });
    expect(text).toContain("v7");
    expect(text).toContain("v8");
  });

  it("points at the stale side — the computer when it is behind, the server when it is ahead", () => {
    // Both directions are reachable (rolling the server back inverts
    // which side is old), and sending the user to upgrade the machine
    // that is already ahead is a dead end.
    expect(describeAdmissionFailure(mismatch(7, 8), { appManaged: false })).toMatch(
      /on this computer to restore/,
    );
    expect(describeAdmissionFailure(mismatch(9, 8), { appManaged: false })).toMatch(
      /Update Silverhand on the server/,
    );
  });

  it("names the artifact the stale side actually installs", () => {
    // shiki 2026-07-26: the action clause must say WHAT to update. A
    // user-managed computer runs the published package, so it is named
    // verbatim; an app-managed computer runs the copy bundled in the app,
    // where naming that package would point at something it never
    // installed.
    expect(describeAdmissionFailure(mismatch(7, 8), { appManaged: false })).toContain(
      `Update ${computerCopy.connectionPackageName} on this computer`,
    );
    expect(describeAdmissionFailure(mismatch(7, 8), { appManaged: true })).toContain(
      "Update Silverhand on this computer",
    );
    expect(describeAdmissionFailure(mismatch(7, 8), { appManaged: true })).not.toContain(
      computerCopy.connectionPackageName,
    );
  });
});

describe("describeUnreachableReason", () => {
  it("returns a distinct, non-empty, jargon-free string for every reason", () => {
    const reasons: Array<"timeout" | "daemon_unreachable" | "protocol_error"> = [
      "timeout",
      "daemon_unreachable",
      "protocol_error",
    ];
    const texts = reasons.map(describeUnreachableReason);
    for (const text of texts) {
      expect(text.length).toBeGreaterThan(0);
      // Daemon-lang terms must NOT leak verbatim — keeps the pill in
      // user-facing voice no matter what we add server-side.
      expect(text).not.toMatch(/daemon/i);
      expect(text).not.toMatch(/RPC/i);
      expect(text).not.toMatch(/transport/i);
    }
    // Each reason surfaces its own message — none collapse together.
    expect(new Set(texts).size).toBe(texts.length);
  });
});

describe("formatUptime", () => {
  it("formats sub-minute as seconds", () => {
    expect(formatUptime(0)).toBe("0s");
    expect(formatUptime(45 * 1000)).toBe("45s");
    expect(formatUptime(59_999)).toBe("59s");
  });

  it("formats sub-hour as whole minutes", () => {
    expect(formatUptime(60 * 1000)).toBe("1m");
    expect(formatUptime(59 * 60 * 1000)).toBe("59m");
  });

  it("formats sub-day as hours (with leftover minutes when present)", () => {
    expect(formatUptime(60 * 60 * 1000)).toBe("1h");
    expect(formatUptime(2 * 60 * 60 * 1000 + 14 * 60 * 1000)).toBe("2h 14m");
    expect(formatUptime(23 * 60 * 60 * 1000 + 59 * 60 * 1000)).toBe("23h 59m");
  });

  it("formats >=1d as days (with leftover hours when present)", () => {
    expect(formatUptime(24 * 60 * 60 * 1000)).toBe("1d");
    expect(formatUptime(5 * 24 * 60 * 60 * 1000 + 6 * 60 * 60 * 1000)).toBe("5d 6h");
  });

  it("clamps negative inputs to 0s rather than throwing or returning NaN", () => {
    expect(formatUptime(-1000)).toBe("0s");
  });
});

/**
 * Copy-gate — §7.1 (line 820): internal concepts (`host` / `daemon` /
 * `remote` / `connect-token` / bare `token`) must NEVER appear in
 * user-facing prose, only inside a literal string the user copies or
 * runs (the connection command, the published package name).
 *
 * The prior guard only checked `describeUnreachableReason` labels, so
 * jargon could (and did) leak into `detail` prose and the `computerCopy`
 * lexicon untested (Alice: "测有洞 → 漏进 prose 测不出、还会 regress").
 * This sweeps EVERY user-facing string reachable from a pure mapper — the
 * whole `computerCopy` single source (including its function-valued
 * entries) and every `describeHostStatus` label + detail — so a future
 * jargon leak fails here instead of shipping. This is the production-path
 * guard for the §7.1 rule, not a spot-check.
 *
 * Surfaces that hold their words as component-local literals (the
 * ConnectionPane status pill) are covered by reading them FROM
 * `computerCopy` rather than by a second sweep here; that is why the pill
 * must not re-spell "Connected" / "Offline" locally.
 */
describe("copy-gate: no internal jargon in user-facing prose (§7.1)", () => {
  const JARGON: Array<{ name: string; re: RegExp }> = [
    { name: "host", re: /\bhosts?\b/i },
    { name: "daemon", re: /\bdaemons?\b/i },
    { name: "remote", re: /\bremote\b/i },
    { name: "connect-token", re: /connect-tokens?/i },
    { name: "token", re: /\btokens?\b/i },
  ];

  // Representative hostname sample for function-valued copy — deliberately
  // free of jargon substrings so a leak in the TEMPLATE (not the value)
  // is what trips the gate.
  const SAMPLE_HOST = "MacStudio";

  function collectUserFacingCopy(): Array<{ label: string; text: string }> {
    const out: Array<{ label: string; text: string }> = [];

    for (const [key, value] of Object.entries(computerCopy)) {
      if (typeof value === "string") {
        out.push({ label: `computerCopy.${key}`, text: value });
      }
    }
    // Function-valued copy: exercise every branch that produces prose.
    out.push({
      label: "computerCopy.connectedTo",
      text: computerCopy.connectedTo(SAMPLE_HOST),
    });
    out.push({
      label: "computerCopy.alreadyConnected(name)",
      text: computerCopy.alreadyConnected(SAMPLE_HOST),
    });
    out.push({
      label: "computerCopy.alreadyConnected(null)",
      text: computerCopy.alreadyConnected(null),
    });

    // Status-presentation prose: label + detail for every arm.
    const arms = [
      {
        ...aHost(),
        availability: "available",
        snapshot: {
          os: "macOS 14.5",
          daemon_pid: 1,
          daemon_version: "0.1.0",
          started_at: 1,
          uptime_ms: 1,
        },
        agents: [],
      },
      { ...aHost(), availability: "disconnected", agents: [] },
      { ...aHost(), availability: "unreachable", reason: "timeout", agents: [] },
      {
        ...aHost(),
        availability: "unreachable",
        reason: "daemon_unreachable",
        agents: [],
      },
      {
        ...aHost(),
        availability: "unreachable",
        reason: "protocol_error",
        agents: [],
      },
      { ...aHost(), availability: "revoked", agents: [] },
    ] as HostStatusResponse[];
    for (const arm of arms) {
      const view = describeHostStatus(arm);
      out.push({
        label: `describeHostStatus(${arm.availability}).label`,
        text: view.label,
      });
      if (view.detail) {
        out.push({
          label: `describeHostStatus(${arm.availability}).detail`,
          text: view.detail,
        });
      }
    }

    // Terminal admission-failure prose (`#task:1631`) — swept in both
    // directions AND both artifact forms, since each produces its own
    // action clause.
    for (const [offered, expected] of [
      [7, 8],
      [9, 8],
    ] as const) {
      for (const appManaged of [false, true] as const) {
        out.push({
          label: `describeAdmissionFailure(protocol_mismatch ${offered}→${expected}, appManaged=${appManaged})`,
          text: describeAdmissionFailure(
            {
              kind: "protocol_mismatch",
              offered_protocol_version: offered,
              expected_protocol_version: expected,
              observed_at: 1_700_000_000_000,
            },
            { appManaged },
          ),
        });
      }
    }

    return out;
  }

  it.each(collectUserFacingCopy())("$label has no internal jargon", ({ label, text }) => {
    // The published package identifier is exempt for the same reason the
    // connection command string is: it is a copy-pasteable name the user
    // types, not prose. Strip the literal (only the literal) so a bare
    // "daemon" anywhere else in the same sentence still trips the gate.
    const prose = text.split(computerCopy.connectionPackageName).join("");
    for (const { name, re } of JARGON) {
      expect(re.test(prose), `${label} = "${text}" leaks internal term "${name}"`).toBe(false);
    }
  });
});
