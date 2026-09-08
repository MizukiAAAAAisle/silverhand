// The presence PROJECTION — native state → words (#task:2128).
//
// This is the one table that turns either authority's native verdict into the
// shared IM vocabulary, so it is where the vocabulary is pinned. Desktop's test
// env is `node`, so this asserts the projection's output objects, not rendered
// classes — a `bg-success` assertion would pass for a surface that got the right
// colour from the WRONG authority, which is the class of bug this whole design
// removes.
//
// The properties under test:
//
//  1. THREE WORDS, BOTH SCOPES. `Online / Away / Offline` is the whole visible
//     vocabulary; the per-conversation `Connecting…` is the only addition, and it
//     is transient. No native state produces `Active` / `Idle` / `Starting` /
//     `Crashed` any more.
//  2. TWO SOURCES NEVER MERGE, yet READ ALIKE. The global and conversation arms
//     are separate inputs, but the same lived state reads the same word on both
//     (available/active → Online; away/idle → Away; offline/no_session → Offline).
//  3. A CRASH IS OFFLINE + FAULT, NEVER A FOURTH WORD. `crashed` folds its label
//     into `Offline`, keeps a distinct `failed` tone (not `offline`), and carries
//     the fault in the accessible name so it is not colour-only.
//  4. SCOPE CHANGES ONLY THE SENTENCE. Same status → same word, same tone, same
//     accessible name across `conversation` / `agent`; only `detail` differs, and
//     an agent-scoped session is never said to run "in this channel".
//  5. UNSETTLED DRAWS NOTHING. `unknown` → `null`.
import { describe, expect, it } from "vitest";
import type { ConversationAgentStatus } from "@silverhand/shared";
import type { GlobalPresence } from "./hooks";
import type { AgentSlotScopeKind, MemberRuntimeStatus } from "./member-runtime-status";
import { PRESENCE_TONE_DOT, projectPresence, type PresenceTone } from "./presence-projection";

const SCOPES: readonly AgentSlotScopeKind[] = ["conversation", "agent"];
const SESSION_STATUSES: readonly ConversationAgentStatus[] = [
  "active",
  "starting",
  "idle",
  "crashed",
];

function global(presence: GlobalPresence) {
  return projectPresence({ scope: "global", presence });
}

function conversation(runtime: MemberRuntimeStatus) {
  return projectPresence({ scope: "conversation", runtime });
}

function session(status: ConversationAgentStatus, scope: AgentSlotScopeKind): MemberRuntimeStatus {
  return { kind: "session", status, scope };
}

describe("the visible vocabulary is exactly three words + a transient (#task:2128)", () => {
  it("never emits the old work-language words", () => {
    const everyLabel = [
      global("online"),
      global("away"),
      global("offline"),
      conversation({ kind: "not_here" }),
      conversation({ kind: "no_session" }),
      ...SCOPES.flatMap((scope) =>
        SESSION_STATUSES.map((status) => conversation(session(status, scope))),
      ),
    ]
      .filter((d): d is NonNullable<typeof d> => d !== null)
      .map((d) => d.label);
    for (const dead of ["Active", "Idle", "Starting", "Crashed", "Failed"]) {
      expect(everyLabel).not.toContain(dead);
    }
    // The only words a user ever reads.
    expect(new Set(everyLabel)).toEqual(
      new Set(["Online", "Away", "Offline", "Connecting…", "Not here"]),
    );
  });
});

describe("the global arm (#task:2128)", () => {
  it("maps availability × the presence clock to the three words", () => {
    expect(global("online")).toEqual({
      label: "Online",
      tone: "online",
      detail: "This agent is online.",
      a11yLabel: "Online",
      pulse: false,
    });
    expect(global("away")).toEqual({
      label: "Away",
      tone: "away",
      detail: "This agent is away.",
      a11yLabel: "Away",
      pulse: false,
    });
    expect(global("offline")).toEqual({
      label: "Offline",
      tone: "offline",
      detail: "This agent is offline.",
      a11yLabel: "Offline",
      pulse: false,
    });
  });
});

describe("the conversation arm — the non-session answers (#task:2128)", () => {
  it("draws nothing while unsettled", () => {
    expect(conversation({ kind: "unknown" })).toBeNull();
  });

  it("states membership, with the membership tone, for a non-member", () => {
    expect(conversation({ kind: "not_here" })).toEqual({
      label: "Not here",
      tone: "membership",
      detail: "Not a member of this channel.",
      a11yLabel: "Not here",
      pulse: false,
    });
  });

  it("reads no_session as Offline, not Away — a channel with nothing running", () => {
    // The deliberate split from #2123's code, where no_session and session·idle
    // both read `Idle`. Away needs a live-but-idle session; no session at all is
    // Offline.
    expect(conversation({ kind: "no_session" })).toEqual({
      label: "Offline",
      tone: "offline",
      detail: "This channel has no live session.",
      a11yLabel: "Offline",
      pulse: false,
    });
  });
});

describe("the conversation arm — a live session, both scopes (#task:2128)", () => {
  it("maps active/starting/idle/crashed to the shared words", () => {
    expect(conversation(session("active", "conversation"))).toMatchObject({
      label: "Online",
      tone: "online",
      pulse: false,
    });
    expect(conversation(session("starting", "conversation"))).toMatchObject({
      label: "Connecting…",
      tone: "online",
      pulse: true,
    });
    expect(conversation(session("idle", "conversation"))).toMatchObject({
      label: "Away",
      tone: "away",
      pulse: false,
    });
  });

  it("folds a crash into Offline + fault tone + an accessible failure signal", () => {
    const crashed = conversation(session("crashed", "conversation"));
    expect(crashed).toMatchObject({
      label: "Offline",
      // NOT 'offline': a crash must stay distinct from a clean Offline.
      tone: "failed",
      a11yLabel: "Offline — session failed",
    });
    // The whole point of the `failed` tone: it colours differently from a clean
    // Offline, and the accessible name — not the colour — is what carries the
    // fault to a screen reader.
    expect(PRESENCE_TONE_DOT.failed).not.toBe(PRESENCE_TONE_DOT.offline);
    expect(crashed?.a11yLabel).not.toBe(crashed?.label);
  });

  it("gives the same word, tone and accessible name to both scopes — only the sentence differs", () => {
    for (const status of SESSION_STATUSES) {
      const conv = conversation(session(status, "conversation"));
      const agent = conversation(session(status, "agent"));
      expect(agent?.label).toBe(conv?.label);
      expect(agent?.tone).toBe(conv?.tone);
      expect(agent?.a11yLabel).toBe(conv?.a11yLabel);
      expect(agent?.pulse).toBe(conv?.pulse);
      // The one thing scope changes.
      expect(agent?.detail).not.toBe(conv?.detail);
    }
  });

  it("never attributes an agent-scoped session to this channel", () => {
    for (const status of SESSION_STATUSES) {
      const detail = conversation(session(status, "agent"))!.detail;
      expect(detail).not.toContain("This channel");
      expect(detail).toContain("shared across every channel");
    }
    for (const status of SESSION_STATUSES) {
      expect(conversation(session(status, "conversation"))!.detail).toContain(
        "This channel's session",
      );
    }
  });
});

describe("the tone→dot map is total and keeps green + fault as the only loud grounds (#task:2128)", () => {
  it("has a colour for every tone", () => {
    const tones: readonly PresenceTone[] = ["online", "away", "offline", "failed", "membership"];
    for (const tone of tones) {
      expect(PRESENCE_TONE_DOT[tone]).toBeTruthy();
    }
  });

  it("gives away / offline / membership the same muted ground", () => {
    // The distinction between them is a WORD, not a colour — a muted dot for all
    // three avoids a false alarm for an agent that will answer next message.
    expect(PRESENCE_TONE_DOT.away).toBe(PRESENCE_TONE_DOT.offline);
    expect(PRESENCE_TONE_DOT.membership).toBe(PRESENCE_TONE_DOT.offline);
  });
});
