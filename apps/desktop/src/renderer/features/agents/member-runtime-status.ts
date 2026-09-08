import type { ConversationAgentRuntimeDto, ConversationAgentStatus } from "@silverhand/shared";
import type { RosterMembership } from "./hooks";

/**
 * WHAT A ROSTER PLACEMENT SAYS ABOUT ONE AGENT'S RUN STATE — the single
 * projection every roster surface reads (#task:2123).
 *
 * Before this module the member strip, the members dialog and the identity
 * popover each answered the question their own way, and the popover answered a
 * DIFFERENT question entirely: it read the agent's global Availability, so one
 * agent could read `Idle` on the chip and `Online` in the card opened FROM that
 * chip. Two authorities for one fact is the bug; this is the one authority for
 * a roster placement.
 *
 * THE FOUR ARMS ARE NOT INTERCHANGEABLE, and in particular `unknown` is not
 * `no_session`:
 *
 *  - `unknown` — a read has not settled. Either authority may be pending or
 *    errored, and neither "not a member" nor "no session" may be asserted from
 *    an absent answer. This is the same three-state discipline
 *    `projectRosterMembership` already applies to membership (@Cindy,
 *    #task:2039); the runtime read had none, because every consumer defaulted
 *    its array to `[]` — which makes a pending or 5xx'd runtime read
 *    indistinguishable from "answered, no row" and paints every agent Idle.
 *  - `not_here` — the roster settled and this agent is not on it. A fact only a
 *    roster can state, and one the runtime read cannot: an agent-scoped agent
 *    has a slot row whether or not it is a member here.
 *  - `no_session` — a member, the runtime read settled, and it has no slot row.
 *    No live session, and DELIBERATELY SCOPE-FREE: `scope_kind` exists only ON a
 *    row, so describing this case per-scope would have to reach for
 *    `agent.session_scope` and reintroduce a second scope authority in the renderer.
 *  - `session` — a member with a slot row. `scope` is the row's `scope_kind`,
 *    which the backend already derives from `agents.session_scope` when it picks
 *    ConversationSlot vs AgentSlot (`listConversationRuntime`), so the renderer
 *    reports the scope it was told and never re-derives it.
 */
export type MemberRuntimeStatus =
  | { kind: "unknown" }
  | { kind: "not_here" }
  | { kind: "no_session" }
  | {
      kind: "session";
      status: ConversationAgentStatus;
      scope: AgentSlotScopeKind;
    };

/** Which slot answered — the wire's own discriminant, not a renderer guess. */
export type AgentSlotScopeKind = ConversationAgentRuntimeDto["scope_kind"];

/**
 * WHICH AUTHORITY ANSWERS PRESENCE FOR THIS PLACEMENT. Named and pure, because
 * this one branch is where the two authorities used to be crossed, and because a
 * component that decides it inline can only be checked by rendering it.
 *
 *  - a roster placement (channel) → the roster runtime projection above. The run
 *    state of the session serving this conversation IS the agent's presence here;
 *    global Availability answers a different question ("can it work for me at
 *    all") and belongs to the surfaces that ask it.
 *  - no roster (workspace-less DirectPair) → global presence, unchanged. There is
 *    no roster to be absent from and no conversation-scoped slot to read, and
 *    adding either read here is what once told a user their DM counterpart was
 *    `Not here` while it was answering them (shiki, #task:2039).
 *
 * It answers from the PLACEMENT ALONE, deliberately: the caller switches on the
 * result to choose which reads to start, so a version of this that needed the
 * roster data would have to start the roster read on a DirectPair to decide it
 * should not have.
 */
export type PresenceAuthority = "roster_runtime" | "global_presence";

export function presenceAuthorityFor(hasRoster: boolean): PresenceAuthority {
  return hasRoster ? "roster_runtime" : "global_presence";
}

/**
 * `runtime === undefined` MEANS UNSETTLED and callers must pass the raw
 * `query.data` — a `= []` default at the call site defeats the `unknown` arm
 * silently, and every consumer had exactly that default before this ticket.
 */
export function projectMemberRuntimeStatus(input: {
  membership: RosterMembership;
  runtime: readonly ConversationAgentRuntimeDto[] | undefined;
  agentId: string;
}): MemberRuntimeStatus {
  if (input.membership === "unknown") return { kind: "unknown" };
  if (input.membership === "not_here") return { kind: "not_here" };
  if (input.runtime === undefined) return { kind: "unknown" };
  const row = input.runtime.find((r) => r.agent_id === input.agentId);
  if (row === undefined) return { kind: "no_session" };
  return { kind: "session", status: row.status, scope: row.scope_kind };
}
