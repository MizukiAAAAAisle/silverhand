import { describe, expect, it } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import { AGENT_AVAILABILITY_CHANGED_EVENT, AGENT_PRESENCE_CHANGED_EVENT } from "@silverhand/shared";
import { ApiError } from "@/lib/api";
import { agentRunStatesKey } from "@/features/agents/model/agent-run-state-cache";
import {
  agentAvailabilityRetry,
  applySwitchAgentRuntimeSideEffects,
  calibratePresenceDeadline,
  decideAgentAvailabilityInvalidation,
  decideAgentPresenceInvalidation,
  projectAgentAvailability,
  projectGlobalPresence,
  projectRosterMembership,
} from "./hooks";

/**
 * Availability is the SECOND presence axis (#task:2043), event-invalidated
 * rather than polled. With `staleTime: Infinity` a value only becomes `isStale`
 * when an event explicitly invalidates it, so the fold keys on `isStale`: a fresh
 * successful value passes through, and a value that has been invalidated but not
 * yet replaced by a successful refetch folds to `unknown` — never keeps asserting
 * the stale bit. #task:2039's review pinned the failure this closes: after a
 * disconnect/revoke frame invalidates and the refetch then 5xx's, React Query
 * retains the prior `data`, so reading `data` alone painted a stale `online`
 * indefinitely with no guaranteed next frame.
 */
describe("projectAgentAvailability", () => {
  it("passes a fresh (not-stale) definite value through unchanged", () => {
    expect(projectAgentAvailability({ data: "online", isStale: false })).toBe("online");
    expect(projectAgentAvailability({ data: "offline", isStale: false })).toBe("offline");
  });

  it("folds the no-answer state (pending / errored-cold) to unknown", () => {
    expect(projectAgentAvailability({ data: undefined, isStale: false })).toBe("unknown");
    expect(projectAgentAvailability({ data: undefined, isStale: true })).toBe("unknown");
  });

  it("folds a retained value that has been invalidated (stale) to unknown", () => {
    // The #task:2039 review pin: an `online` retained behind a failed refetch after
    // a disconnect/revoke invalidation must NOT keep asserting Online — it reads
    // `unknown` (→ no-status) until a successful refetch replaces it.
    expect(projectAgentAvailability({ data: "online", isStale: true })).toBe("unknown");
    expect(projectAgentAvailability({ data: "offline", isStale: true })).toBe("unknown");
  });
});

/**
 * The MEMBERSHIP gate a roster adds to the presence line (@Cindy, #task:2039).
 * It is a three-state projection, not a boolean over a default-`[]` list: the
 * roster read can be pending or cold-errored with no successful snapshot, and a
 * default `[]` there asserted "answered, no members" — painting a real member as
 * `Not here` on the first popover open. Same "un-settled must not impersonate
 * absent" rule the availability fold enforces, pinned so a later edit cannot
 * reintroduce the default empty array.
 */
describe("projectRosterMembership", () => {
  it("answers unknown while the roster read has no successful snapshot (undefined)", () => {
    // loading, or errored with no prior success — draw no `Not here`.
    expect(projectRosterMembership(undefined, "a-1")).toBe("unknown");
  });

  it("answers member when a successful snapshot contains the agent", () => {
    expect(projectRosterMembership([{ agent_id: "a-1" }, { agent_id: "a-2" }], "a-1")).toBe(
      "member",
    );
  });

  it("answers not_here only on a successful snapshot that omits the agent", () => {
    // A defined snapshot IS a real answer, even an empty one — that is the one
    // place `Not here` is earned.
    expect(projectRosterMembership([{ agent_id: "a-2" }], "a-1")).toBe("not_here");
    expect(projectRosterMembership([], "a-1")).toBe("not_here");
  });

  it("uses a retained snapshot as-is — failure states nothing new about membership", () => {
    // A failed refetch keeps the last successful `data`; the projection keys on
    // `data` being defined, never on fetch/error status, so the retained snapshot
    // still answers member / not_here rather than collapsing to unknown.
    expect(projectRosterMembership([{ agent_id: "a-1" }], "a-1")).toBe("member");
    expect(projectRosterMembership([{ agent_id: "a-2" }], "a-1")).toBe("not_here");
  });
});

describe("agentAvailabilityRetry", () => {
  it("never retries a 4xx — the 404 anti-enum answer is terminal, not transient", () => {
    for (const status of [400, 403, 404, 429]) {
      expect(agentAvailabilityRetry(0, new ApiError(status, "client", "no"))).toBe(false);
    }
  });

  it("retries a 5xx / transport failure up to a ceiling, then stops", () => {
    const err = new ApiError(500, "Server Error", "");
    const transport = new ApiError(0, "", "backend_unreachable", "backend_unreachable");
    expect(agentAvailabilityRetry(0, err)).toBe(true);
    expect(agentAvailabilityRetry(0, transport)).toBe(true);
    // Bounded: some finite failureCount must return false, or the read would
    // hammer an unreachable authority forever instead of settling to unknown.
    expect(agentAvailabilityRetry(99, err)).toBe(false);
    expect(agentAvailabilityRetry(99, transport)).toBe(false);
  });
});

/**
 * The pure invalidation decision for the viewer-scoped availability event. The
 * caller has already gated `isCurrentViewerScope(frame.scope)`, so this only has
 * to match the kind, validate the payload, and fence the event to THIS agent —
 * the frame is per-viewer, not per-agent.
 */
describe("decideAgentAvailabilityInvalidation", () => {
  const AGENT = "agent-1";

  it("invalidates on a matching agent_availability_changed event", () => {
    expect(
      decideAgentAvailabilityInvalidation(
        { type: "event", kind: AGENT_AVAILABILITY_CHANGED_EVENT, payload: { agent_id: AGENT } },
        AGENT,
      ),
    ).toBe(true);
  });

  it("ignores the event for a DIFFERENT agent (per-viewer, not per-agent fan-out)", () => {
    expect(
      decideAgentAvailabilityInvalidation(
        { type: "event", kind: AGENT_AVAILABILITY_CHANGED_EVENT, payload: { agent_id: "other" } },
        AGENT,
      ),
    ).toBe(false);
  });

  it("ignores an unrelated event kind", () => {
    expect(
      decideAgentAvailabilityInvalidation(
        { type: "event", kind: "agent_changed", payload: { agent_id: AGENT } },
        AGENT,
      ),
    ).toBe(false);
  });

  it("ignores a malformed payload even on the right kind", () => {
    expect(
      decideAgentAvailabilityInvalidation(
        { type: "event", kind: AGENT_AVAILABILITY_CHANGED_EVENT, payload: { wrong: 1 } },
        AGENT,
      ),
    ).toBe(false);
  });

  it("invalidates unconditionally on snapshot_required (a replay gap may have dropped the frame)", () => {
    expect(decideAgentAvailabilityInvalidation({ type: "snapshot_required" }, AGENT)).toBe(true);
  });
});

/**
 * The pure invalidation decision for the viewer-scoped PRESENCE event. Mirror of
 * `decideAgentAvailabilityInvalidation` on `agent_presence_changed`: the caller
 * has already gated `isCurrentViewerScope(frame.scope)`, so this only matches the
 * kind, validates the payload, and fences the event to THIS agent (the frame is
 * per-viewer, not per-agent). It must NOT fire on `agent_availability_changed` —
 * the two axes have distinct read faces (#task:2049).
 */
describe("decideAgentPresenceInvalidation", () => {
  const AGENT = "agent-1";

  it("invalidates on a matching agent_presence_changed event", () => {
    expect(
      decideAgentPresenceInvalidation(
        { type: "event", kind: AGENT_PRESENCE_CHANGED_EVENT, payload: { agent_id: AGENT } },
        AGENT,
      ),
    ).toBe(true);
  });

  it("ignores the event for a DIFFERENT agent (per-viewer, not per-agent fan-out)", () => {
    expect(
      decideAgentPresenceInvalidation(
        { type: "event", kind: AGENT_PRESENCE_CHANGED_EVENT, payload: { agent_id: "other" } },
        AGENT,
      ),
    ).toBe(false);
  });

  it("ignores the availability event — distinct axis, distinct read face", () => {
    expect(
      decideAgentPresenceInvalidation(
        { type: "event", kind: AGENT_AVAILABILITY_CHANGED_EVENT, payload: { agent_id: AGENT } },
        AGENT,
      ),
    ).toBe(false);
  });

  it("ignores a malformed payload even on the right kind", () => {
    expect(
      decideAgentPresenceInvalidation(
        { type: "event", kind: AGENT_PRESENCE_CHANGED_EVENT, payload: { wrong: 1 } },
        AGENT,
      ),
    ).toBe(false);
  });

  it("invalidates unconditionally on snapshot_required (a replay gap may have dropped the frame)", () => {
    expect(decideAgentPresenceInvalidation({ type: "snapshot_required" }, AGENT)).toBe(true);
  });
});

/**
 * The skew calibration that keeps a server-epoch deadline comparable to a client
 * clock (#task:2049). `offset = dataUpdatedAt − server_now` is the client↔server
 * skew measured at the SAME response; the deadline shifts by it. The pairing is
 * the whole point — both inputs come from one fetch — which is why the presence
 * cache is refetch-only and never `setQueryData`'d (an optimistic write would
 * advance `dataUpdatedAt` while `server_now` stayed old, poisoning the offset
 * with the entry's age). `null` (never active) has no deadline to shift.
 */
describe("calibratePresenceDeadline", () => {
  it("shifts the deadline by the client↔server offset", () => {
    // Client clock is 1000ms AHEAD of the server (dataUpdatedAt 6000 vs
    // server_now 5000) → offset +1000 → a server deadline of 8000 lands at 9000
    // on the client clock.
    expect(calibratePresenceDeadline(8000, 5000, 6000)).toBe(9000);
  });

  it("shifts backward when the client clock trails the server", () => {
    // Client 2000ms BEHIND (dataUpdatedAt 3000 vs server_now 5000) → offset -2000.
    expect(calibratePresenceDeadline(8000, 5000, 3000)).toBe(6000);
  });

  it("is identity when the clocks agree", () => {
    expect(calibratePresenceDeadline(8000, 5000, 5000)).toBe(8000);
  });

  it("passes null (never active) through — no deadline to shift", () => {
    expect(calibratePresenceDeadline(null, 5000, 6000)).toBeNull();
  });
});

/**
 * The composition #task:2049 turns on: Offline is read from AVAILABILITY ALONE,
 * and Online requires POSITIVE evidence — an away deadline (in the CLIENT clock
 * domain) still in the future against the injected `now`. Liveness is no longer
 * an input. Every truth-table cell is pinned so a later edit cannot let a stale /
 * absent deadline paint Online, nor let availability's Offline leak from the
 * deadline axis. `now` is injected (the hook owns the clock), so this stays pure.
 */
describe("projectGlobalPresence", () => {
  const NOW = 1_000;

  it("availability unknown → no status regardless of deadline", () => {
    for (const d of [500, 2_000, null, "unknown"] as const) {
      expect(projectGlobalPresence("unknown", d, NOW)).toBeNull();
    }
  });

  it("availability offline → Offline regardless of any deadline", () => {
    for (const d of [500, 2_000, null, "unknown"] as const) {
      expect(projectGlobalPresence("offline", d, NOW)).toBe("offline");
    }
  });

  it("available + a future deadline → Online", () => {
    expect(projectGlobalPresence("online", NOW + 1, NOW)).toBe("online");
  });

  it("available + a past-or-now deadline → Away (the boundary is inclusive of Away)", () => {
    expect(projectGlobalPresence("online", NOW - 1, NOW)).toBe("away");
    expect(projectGlobalPresence("online", NOW, NOW)).toBe("away");
  });

  it("available + null deadline (never active) → Away, NEVER Online", () => {
    // v82 has no backfill, so null is the DOMINANT post-deploy state; Online here
    // would be a deploy-day mass lie.
    expect(projectGlobalPresence("online", null, NOW)).toBe("away");
  });

  it("available + unknown deadline (presence read pending / errored) → Away", () => {
    expect(projectGlobalPresence("online", "unknown", NOW)).toBe("away");
  });
});

/**
 * The runtime-switch transition may restart every conversation an agent
 * participates in, so `onSuccess` must invalidate every conversation-scoped
 * agent-run-states query — not just the agent's own detail row. Cindy's
 * #1470 review caught two previous drift versions of this predicate; the
 * test seeds real keys (from `features/agents/model/agent-run-state-cache::agentRunStatesKey`,
 * the single authority) and asserts they get marked invalid.
 */
describe("applySwitchAgentRuntimeSideEffects", () => {
  it("invalidates every seeded agent-run-states query (predicate walks the whole cache)", () => {
    const qc = new QueryClient();
    const c1 = agentRunStatesKey("conv-1");
    const c2 = agentRunStatesKey("conv-2");
    qc.setQueryData(c1, { agents: [] });
    qc.setQueryData(c2, { agents: [] });

    applySwitchAgentRuntimeSideEffects(qc, "agent-1");

    expect(qc.getQueryState(c1)?.isInvalidated).toBe(true);
    expect(qc.getQueryState(c2)?.isInvalidated).toBe(true);
  });

  it("invalidates the agent detail + agent-scoped runtime-state singleton", () => {
    const qc = new QueryClient();
    qc.setQueryData(["agents", "agent-1"], { id: "agent-1" });
    qc.setQueryData(["agents", "agent-1", "runtime-state"], {
      participations: [],
      visible_participations: [],
      seats: [],
    });
    qc.setQueryData(["agents"], []);

    applySwitchAgentRuntimeSideEffects(qc, "agent-1");

    expect(qc.getQueryState(["agents"])?.isInvalidated).toBe(true);
    expect(qc.getQueryState(["agents", "agent-1"])?.isInvalidated).toBe(true);
    expect(qc.getQueryState(["agents", "agent-1", "runtime-state"])?.isInvalidated).toBe(true);
  });

  it("does not touch unrelated conversation-scoped queries", () => {
    // Non-run-state conversation queries (e.g. message lists) share the
    // `['conversations', id, ...]` prefix; the predicate must narrow on the
    // trailing `'agent-run-states'` segment so those unrelated queries stay
    // fresh and don't refetch on every runtime switch.
    const qc = new QueryClient();
    const runStateKey = agentRunStatesKey("conv-1");
    const messagesKey = ["conversations", "conv-1", "messages"] as const;
    qc.setQueryData(runStateKey, { agents: [] });
    qc.setQueryData(messagesKey, []);

    applySwitchAgentRuntimeSideEffects(qc, "agent-1");

    expect(qc.getQueryState(runStateKey)?.isInvalidated).toBe(true);
    expect(qc.getQueryState(messagesKey)?.isInvalidated).toBe(false);
  });
});
