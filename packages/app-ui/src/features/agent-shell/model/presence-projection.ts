import type { ConversationAgentStatus } from "@silverhand/shared";
import type { GlobalPresence } from "../hooks/hooks";
import type { AgentSlotScopeKind, MemberRuntimeStatus } from "./member-runtime-status";

/**
 * THE ONE PLACE A PRESENCE NATIVE STATE BECOMES WORDS (#task:2128).
 *
 * shiki chose an IM-familiar vocabulary — `Online / Away / Offline` — shared by
 * BOTH scopes so a reader learns three words, not two parallel sets (the old
 * per-conversation `Active / Starting / Idle / Crashed`). The two scopes still
 * answer DIFFERENT questions from DIFFERENT authorities and are never merged:
 *
 *  - global (`GlobalPresence`, from availability × the presence clock) — "can
 *    this agent work for me at all";
 *  - per-conversation (`MemberRuntimeStatus`, from the channel runtime slot) —
 *    "is the session serving THIS channel running".
 *
 * Both natives are produced by their own leaf (`hooks.ts` / `member-runtime-
 * status.ts`); those leaves classify only and hold NO words. This projection is
 * the single presentation table: every `label`, `tone`, `detail` and accessible
 * name literal lives here and nowhere else, so changing a word is one edit and
 * two agents in the same state can never read differently on different surfaces.
 * A leaf must not import this back — the dependency points one way, native → words.
 */
export type PresenceTone = "online" | "away" | "offline" | "failed" | "membership";

export interface PresenceDisplay {
  /** The visible word. */
  label: string;
  /** Drives the dot colour via {@link PRESENCE_TONE_DOT}. `failed` is its own
   *  tone, NOT `offline`: a crashed session folds its LABEL into `Offline`
   *  (shiki — no fourth word) but must stay visibly and non-visually distinct
   *  from a clean Offline, which is what this tone and {@link a11yLabel} carry. */
  tone: PresenceTone;
  /** The scope-aware sentence for a tooltip / caption. Scope lives ONLY here —
   *  never in the word or the dot — so an agent-scoped agent reads the same word
   *  as a conversation-scoped one, and only the sentence says which session. */
  detail: string;
  /** The accessible name. Equals {@link label} except for a crashed session,
   *  where it carries the failure the folded `Offline` word drops, so the fault
   *  is not conveyed by colour alone (a11y floor, @Cindy / @Alice #task:2128). */
  a11yLabel: string;
  /** A transient state (`Connecting…`). Consumers MAY add a decorative pulse;
   *  it is never the only signal — the word already says it (reduced-motion,
   *  screenshots and screen readers all read the label). */
  pulse: boolean;
}

/** The two typed sources, kept as a discriminated union so the projection cannot
 *  reach the wrong authority: the global arm never sees a runtime, the
 *  conversation arm never sees a `GlobalPresence`. "Two sources do not merge" is
 *  a property of this type, not a discipline. */
export type PresenceInput =
  | { scope: "global"; presence: GlobalPresence }
  | { scope: "conversation"; runtime: MemberRuntimeStatus };

/** `null` = draw nothing (an unsettled read has no honest word — never a
 *  speculative status). Only the conversation arm has that case (`unknown`); the
 *  global arm is total, so its overload returns a non-null `PresenceDisplay` and
 *  its callers need no null check. */
export function projectPresence(input: {
  scope: "global";
  presence: GlobalPresence;
}): PresenceDisplay;
export function projectPresence(input: {
  scope: "conversation";
  runtime: MemberRuntimeStatus;
}): PresenceDisplay | null;
export function projectPresence(input: PresenceInput): PresenceDisplay | null {
  return input.scope === "global"
    ? projectGlobalPresence(input.presence)
    : projectConversationPresence(input.runtime);
}

/** Dot colour per tone. `away` and `offline` share the muted ground — the word
 *  and detail carry their difference, and a grey dot for both avoids a false red
 *  alarm for an agent that will answer on the next message. `failed` is the only
 *  loud one besides `online`, because a crash is the one thing worth a colour. */
export const PRESENCE_TONE_DOT: Record<PresenceTone, string> = {
  online: "bg-success",
  away: "bg-text-muted/50",
  offline: "bg-text-muted/50",
  failed: "bg-error",
  membership: "bg-text-muted/50",
};

function display(
  label: string,
  tone: PresenceTone,
  detail: string,
  extra?: { a11yLabel?: string; pulse?: boolean },
): PresenceDisplay {
  return {
    label,
    tone,
    detail,
    a11yLabel: extra?.a11yLabel ?? label,
    pulse: extra?.pulse ?? false,
  };
}

function projectGlobalPresence(presence: GlobalPresence): PresenceDisplay {
  switch (presence) {
    case "online":
      return display("Online", "online", "This agent is online.");
    case "away":
      return display("Away", "away", "This agent is away.");
    case "offline":
      return display("Offline", "offline", "This agent is offline.");
  }
}

function projectConversationPresence(runtime: MemberRuntimeStatus): PresenceDisplay | null {
  switch (runtime.kind) {
    case "unknown":
      return null;
    case "not_here":
      return display("Not here", "membership", "Not a member of this channel.");
    case "no_session":
      // A member with no slot row: in this channel there is nothing running, so
      // the honest IM word is Offline — not Away, which needs a live-but-idle
      // session. This is the deliberate split from #2123's code, where both this
      // and `session·idle` read `Idle` (@Alice #task:2128 baseline).
      return display("Offline", "offline", "This channel has no live session.");
    case "session":
      return projectSession(runtime.status, runtime.scope);
  }
}

function projectSession(
  status: ConversationAgentStatus,
  scope: AgentSlotScopeKind,
): PresenceDisplay {
  switch (status) {
    case "active":
      return display("Online", "online", sessionSentence(scope, "is online"));
    case "starting":
      return display("Connecting…", "online", sessionSentence(scope, "is starting"), {
        pulse: true,
      });
    case "idle":
      return display("Away", "away", sessionSentence(scope, "is idle"));
    case "crashed":
      // Label folds into Offline (no fourth word), tone stays `failed`, and the
      // accessible name keeps the fault the word drops.
      return display("Offline", "failed", sessionSentence(scope, "failed"), {
        a11yLabel: "Offline — session failed",
      });
  }
}

/**
 * The detail sentence per scope, as a WHOLE sentence with the predicate
 * interpolated (moved here from `member-runtime-status.ts` so no presentation is
 * left in the leaf — @Cindy / @Alice #task:2128).
 *
 * Not a bare subject + join: the agent-scoped subject ends on an appositive
 * (`, shared across every channel,`) whose closing comma is sentence structure,
 * and a comma at the end of a string constant reads as a typo to the next reader.
 */
function sessionSentence(scope: AgentSlotScopeKind, predicate: string): string {
  switch (scope) {
    case "conversation":
      return `This channel's session ${predicate}.`;
    case "agent":
      return `This agent's one session, shared across every channel, ${predicate}.`;
  }
}
