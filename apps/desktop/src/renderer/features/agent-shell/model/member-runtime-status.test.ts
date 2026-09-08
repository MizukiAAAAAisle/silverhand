// The roster runtime CLASSIFICATION (#task:2128, née #task:2123).
//
// This leaf now holds classification ONLY — the native verdict about a roster
// placement. The words, the tone and the dot moved to `projectPresence`
// (presence-projection.test.ts), so this file no longer asserts labels; it
// asserts the discriminated union the projection consumes.
//
// Desktop's test env is `node` — no jsdom, no RTL — which is why this ticket's
// acceptance asks for a matrix over the PROJECTION rather than over rendered
// classes. That is also the better test: a `bg-success` assertion would pass for
// a surface that got the right colour from the wrong authority, which is exactly
// the bug being fixed here (the popover read global Availability while the chip
// beside it read the runtime slot, so one agent showed `Idle` and `Online` at the
// same time).
//
// Three properties:
//
//  1. THE MATRIX IS TOTAL — two session scopes × four runtime statuses, plus the
//     three arms that are not a row at all (missing row, non-member, unsettled).
//  2. UNSETTLED IS NOT no_session. Either read being unanswered yields `unknown`.
//     This is the arm every consumer used to destroy with `= []`.
//  3. NO ROSTER MEANS THE OTHER AUTHORITY, decided from the placement alone.
import { describe, expect, it } from "vitest";
import type { ConversationAgentRuntimeDto, ConversationAgentStatus } from "@silverhand/shared";
import {
  presenceAuthorityFor,
  projectMemberRuntimeStatus,
  type AgentSlotScopeKind,
  type MemberRuntimeStatus,
} from "./member-runtime-status";

const AGENT = "agt-1";
const OTHER = "agt-2";

const STATUSES: readonly ConversationAgentStatus[] = ["active", "starting", "idle", "crashed"];
const SCOPES: readonly AgentSlotScopeKind[] = ["conversation", "agent"];

function row(
  status: ConversationAgentStatus,
  scope: AgentSlotScopeKind,
  agentId = AGENT,
): ConversationAgentRuntimeDto {
  return {
    agent_id: agentId,
    scope_kind: scope,
    generation: 1,
    cli_session_id: null,
    pid: scope === "agent" ? 4242 : null,
    status,
  };
}

/** The projection with membership settled to `member`, which is what the strip
 *  and the dialog always pass (the loop over the roster IS the membership). */
function project(runtime: readonly ConversationAgentRuntimeDto[] | undefined): MemberRuntimeStatus {
  return projectMemberRuntimeStatus({
    membership: "member",
    runtime,
    agentId: AGENT,
  });
}

describe("a member with a slot row (#task:2123)", () => {
  for (const scope of SCOPES) {
    for (const status of STATUSES) {
      it(`reports ${status} from the ${scope}-scoped slot`, () => {
        expect(project([row(status, scope)])).toEqual({
          kind: "session",
          status,
          scope,
        });
      });
    }
  }

  it("reports the scope the ROW carries, never a re-derived one", () => {
    // The backend already picked ConversationSlot vs AgentSlot from
    // `agents.session_scope` (`listConversationRuntime`), so `scope_kind` is the
    // renderer's only input. An agent-scoped row appears in a channel's runtime
    // response with `conversation_id IS NULL` behind it — there is nothing in this
    // input that says which conversation, and nothing here invents one.
    const projected = project([row("active", "agent")]);
    expect(projected).toEqual({ kind: "session", status: "active", scope: "agent" });
    expect(JSON.stringify(projected)).not.toContain("conversation_id");
  });

  it("picks the row by agent id, not by position", () => {
    expect(project([row("crashed", "conversation", OTHER), row("active", "agent")])).toEqual({
      kind: "session",
      status: "active",
      scope: "agent",
    });
  });
});

describe("the three arms that are not a row (#task:2123)", () => {
  it("settled with no row for this agent is `no_session`, not unknown", () => {
    expect(project([])).toEqual({ kind: "no_session" });
    expect(project([row("active", "conversation", OTHER)])).toEqual({
      kind: "no_session",
    });
  });

  it("an unsettled RUNTIME read is `unknown`, even for a confirmed member", () => {
    // The regression this arm exists for: every consumer defaulted the query to
    // `[]`, which made a pending or 5xx'd runtime read indistinguishable from
    // "answered, this agent has no session" — so a whole channel of working agents
    // painted Idle while the read was failing.
    expect(project(undefined)).toEqual({ kind: "unknown" });
  });

  it("an unsettled MEMBERSHIP read is `unknown` whatever the runtime says", () => {
    // Membership is checked first on purpose: with the roster unsettled, a runtime
    // row would let the line claim a state for an agent that may not be here at
    // all, and an absent row would claim `no_session` for the same reason
    // (@Cindy's three-state discipline, #task:2039).
    expect(
      projectMemberRuntimeStatus({
        membership: "unknown",
        runtime: [row("active", "agent")],
        agentId: AGENT,
      }),
    ).toEqual({ kind: "unknown" });
    expect(
      projectMemberRuntimeStatus({
        membership: "unknown",
        runtime: [],
        agentId: AGENT,
      }),
    ).toEqual({ kind: "unknown" });
  });

  it("a confirmed non-member is `not_here` even when it HAS a session", () => {
    // An agent-scoped agent has its one slot row whether or not it is a member
    // here, so the runtime read cannot answer membership and must not override it.
    expect(
      projectMemberRuntimeStatus({
        membership: "not_here",
        runtime: [row("active", "agent")],
        agentId: AGENT,
      }),
    ).toEqual({ kind: "not_here" });
  });
});

describe("which authority answers, per placement (#task:2123)", () => {
  it("sends a roster placement to the runtime projection", () => {
    expect(presenceAuthorityFor(true)).toBe("roster_runtime");
  });

  it("leaves a placement with no roster on global presence", () => {
    // The DirectPair case, unchanged by this ticket: no roster to be absent from
    // and no conversation-scoped slot to read. It is decided from the PLACEMENT
    // alone, so the caller can use the answer to decide which reads to start —
    // a version needing roster data would have to start the roster read on a DM
    // to find out it should not have (shiki, #task:2039).
    expect(presenceAuthorityFor(false)).toBe("global_presence");
  });
});
