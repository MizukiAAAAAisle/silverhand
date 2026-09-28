import { describe, expect, it } from "vitest";
import type { ConversationRef, DirectPairListItem } from "@silverhand/shared";
import type { ConversationIdentityResolution } from "@/features/conversations/conversation-identity";
import {
  selectFocusedConversation,
  selectSecondaryDescriptor,
  selectSecondaryViewInputs,
  selectSidebarSelectedConversationId,
  selectVisibleConversations,
  shouldSecondaryFullscreen,
  type SecondaryDescriptor,
} from "./secondary-pane";

/** The two resolved arms of the identity the selector consumes (#task:2038). The
 *  non-resolved statuses need no builder — they carry nothing but the status. */
function workspaceIdentity(ref: ConversationRef): ConversationIdentityResolution {
  return { status: "resolved", identity: { placement: "workspace", ref } };
}
function pairIdentity(pair: DirectPairListItem): ConversationIdentityResolution {
  return { status: "resolved", identity: { placement: "direct_pair", pair } };
}

const localChannelRef: ConversationRef = {
  id: "c-other",
  placement_kind: "workspace",
  roster_policy: "open",
  title: "planning",
  workspace_id: "w-1",
  closed_at: null,
  archived_at: null,
};

const foreignChannelRef: ConversationRef = {
  id: "c-foreign",
  placement_kind: "workspace",
  roster_policy: "open",
  title: "team-y planning",
  workspace_id: "w-2",
  closed_at: null,
  archived_at: null,
};

// An agent's own `dm_channel`: workspace-PLACED (in that agent's agent_home)
// with a fixed roster. The ref states no container word at all — #task:2075's
// stop-publish step deleted it, and which KIND of container a channel sits in is
// answered by the workspace directory's ownership arc, not by this ref. This is
// the only kind of DM this DTO can name — a workspace-less `direct_pair` is not
// expressible here at all (#task:2038, ruling A: `ConversationRef.placement_kind`
// is `z.literal('workspace')`), and is modelled by its own carrier resolved from
// `GET /api/direct-pairs` (the `agentPair` fixture below).
const foreignDmRef: ConversationRef = {
  id: "dm-foreign",
  placement_kind: "workspace",
  roster_policy: "fixed",
  title: "dm-bob",
  workspace_id: "w-bob-home",
  closed_at: null,
  archived_at: null,
};

// A private line — the placement the workspace face cannot express, resolved from
// the viewer's own complete direct-pair list.
const agentPair: DirectPairListItem = {
  conversation_id: "dp-alice",
  counterpart: {
    status: "active",
    kind: "agent",
    id: "a-alice",
    name: "alice",
    display_name: "Alice",
    avatar_url: null,
    runtime: "claude",
  },
  unread_count: 3,
  read_only: false,
  created_at: 1_700_000_000_000,
};

describe("selectSecondaryDescriptor — URL × identity matrix", () => {
  it("returns null when ?side is not set", () => {
    const out = selectSecondaryDescriptor({ sideConversationId: null }, null);
    expect(out).toBeNull();
  });

  it("?side resolved (same workspace) carries the pane descriptor + workspace kind", () => {
    const out = selectSecondaryDescriptor(
      { sideConversationId: "c-other" },
      workspaceIdentity(localChannelRef),
    );
    expect(out).toEqual({
      source: "side",
      status: "resolved",
      id: "c-other",
      descriptor: {
        id: "c-other",
        title: "planning",
        placement_kind: "workspace",
        roster_policy: "open",
        closed_at: null,
        archived_at: null,
        workspace_id: "w-1",
      },
      hasChannelNamespace: true,
    });
  });

  it("?side resolved (cross-workspace) surfaces the foreign workspace meta", () => {
    // The whole point of PR-2: `?side=<id>` may live in a workspace
    // other than the one currently in the primary pane.
    const out = selectSecondaryDescriptor(
      { sideConversationId: "c-foreign" },
      workspaceIdentity(foreignChannelRef),
    );
    expect(out).toMatchObject({
      source: "side",
      status: "resolved",
      id: "c-foreign",
      descriptor: { workspace_id: "w-2" },
      hasChannelNamespace: true,
    });
  });

  it("?side resolved to a dm_channel: a fixed roster still HAS a channel namespace", () => {
    const out = selectSecondaryDescriptor(
      { sideConversationId: "dm-foreign" },
      workspaceIdentity(foreignDmRef),
    );
    expect(out).toMatchObject({
      source: "side",
      status: "resolved",
      // `'workspace'` + a fixed roster is what an agent-home DM channel looks
      // like on this face; the roster is what distinguishes it from a channel,
      // and it still HAS a workspace (unlike a private line).
      descriptor: { placement_kind: "workspace", roster_policy: "fixed" },
      // The bit is the PLACEMENT's, not the container kind's: every workspace
      // placement has a `#` namespace, whatever kind of workspace it is
      // (#task:2078). No container kind rides this path in either spelling.
      hasChannelNamespace: true,
    });
  });

  it("?side resolved to a private line carries a workspace-LESS descriptor (#task:2038)", () => {
    // The regression this ticket exists for: before the pair face was composed
    // in, this id 404'd on the workspace arm and the pane read "deleted or never
    // existed" while the line sat in the viewer's own DIRECT MESSAGES list.
    const out = selectSecondaryDescriptor(
      { sideConversationId: "dp-alice" },
      pairIdentity(agentPair),
    );
    expect(out).toEqual({
      source: "side",
      status: "resolved",
      id: "dp-alice",
      descriptor: {
        id: "dp-alice",
        // The counterpart IS the pair's title — resolved by the one rule every
        // DM surface uses, so the side pane's header matches the sidebar row.
        title: "Alice",
        placement_kind: "direct_pair",
        roster_policy: "fixed",
        closed_at: null,
        archived_at: null,
        // A positive fact, not "unresolved": there is no workspace to scope a
        // member list / archive door / workspace search to.
        workspace_id: null,
        read_only: false,
        counterpart: agentPair.counterpart,
      },
      // No workspace ⇒ no `#` namespace. Downstream this withholds every
      // top-level channel affordance.
      hasChannelNamespace: false,
    });
  });

  it("?side loading produces a loading descriptor that still carries the id", () => {
    // Placeholder/skeleton needs the id to render `#conv:<id>` and offer
    // a Close button while the identity is in-flight.
    const out = selectSecondaryDescriptor(
      { sideConversationId: "c-foreign" },
      {
        status: "loading",
      },
    );
    expect(out).toEqual({ source: "side", status: "loading", id: "c-foreign" });
  });

  it("?side null sideIdentity defaults to loading (component hasn't emitted yet)", () => {
    const out = selectSecondaryDescriptor({ sideConversationId: "c-foreign" }, null);
    expect(out).toEqual({ source: "side", status: "loading", id: "c-foreign" });
  });

  it("?side unauthorized surfaces the placeholder status (not silently stripped)", () => {
    const out = selectSecondaryDescriptor(
      { sideConversationId: "c-foreign" },
      {
        status: "unauthorized",
      },
    );
    expect(out).toEqual({
      source: "side",
      status: "unauthorized",
      id: "c-foreign",
    });
  });

  it("?side not_found surfaces the placeholder status (not silently stripped)", () => {
    const out = selectSecondaryDescriptor(
      { sideConversationId: "c-foreign" },
      {
        status: "not_found",
      },
    );
    expect(out).toEqual({
      source: "side",
      status: "not_found",
      id: "c-foreign",
    });
  });

  it("?side unresolved is its own status — never collapsed into not_found", () => {
    // #task:2038: the pair read FAILED with the workspace face at 404. Claiming
    // deletion would be a false statement, and a skeleton would never end.
    const out = selectSecondaryDescriptor(
      { sideConversationId: "dp-alice" },
      {
        status: "unresolved",
      },
    );
    expect(out).toEqual({
      source: "side",
      status: "unresolved",
      id: "dp-alice",
    });
  });
});

const primary = { id: "c-primary" as const, rosterPolicy: "open" as const };
const sideChannelDescriptor: SecondaryDescriptor = {
  source: "side",
  status: "resolved",
  id: "c-other",
  descriptor: {
    id: "c-other",
    title: "planning",
    placement_kind: "workspace",
    roster_policy: "open",
    closed_at: null,
    archived_at: null,
    workspace_id: "w-1",
  },
  hasChannelNamespace: true,
};
// A second resolved channel-kind side (distinct id from primary) to
// exercise the downstream pure selectors on a resolved secondary.
const sideSecondDescriptor: SecondaryDescriptor = {
  source: "side",
  status: "resolved",
  id: "t-of-primary",
  descriptor: {
    id: "t-of-primary",
    title: "investigations",
    placement_kind: "workspace",
    roster_policy: "open",
    closed_at: null,
    archived_at: null,
    workspace_id: "w-1",
  },
  hasChannelNamespace: true,
};
const foreignSideDescriptor: SecondaryDescriptor = {
  source: "side",
  status: "resolved",
  id: "c-foreign",
  descriptor: {
    id: "c-foreign",
    title: "team-y planning",
    placement_kind: "workspace",
    roster_policy: "open",
    closed_at: null,
    archived_at: null,
    workspace_id: "w-2",
  },
  hasChannelNamespace: true,
};
const pairSideDescriptor: SecondaryDescriptor = {
  source: "side",
  status: "resolved",
  id: "dp-alice",
  descriptor: {
    id: "dp-alice",
    title: "Alice",
    placement_kind: "direct_pair",
    roster_policy: "fixed",
    closed_at: null,
    archived_at: null,
    workspace_id: null,
    read_only: false,
    counterpart: agentPair.counterpart,
  },
  hasChannelNamespace: false,
};
const loadingSide: SecondaryDescriptor = {
  source: "side",
  status: "loading",
  id: "c-foreign",
};
const unauthorizedSide: SecondaryDescriptor = {
  source: "side",
  status: "unauthorized",
  id: "c-foreign",
};
const notFoundSide: SecondaryDescriptor = {
  source: "side",
  status: "not_found",
  id: "c-foreign",
};
const unresolvedSide: SecondaryDescriptor = {
  source: "side",
  status: "unresolved",
  id: "dp-alice",
};

describe("selectVisibleConversations — read-cursor visibility matrix", () => {
  it("only primary visible when no secondary", () => {
    const out = selectVisibleConversations({
      primary,
      secondary: null,
      fullscreen: false,
    });
    expect(out).toEqual({ primary, secondary: null });
  });

  it("both visible when resolved secondary present (split view)", () => {
    const out = selectVisibleConversations({
      primary,
      secondary: sideChannelDescriptor,
      fullscreen: false,
    });
    expect(out).toEqual({
      primary,
      secondary: { id: "c-other", rosterPolicy: "open" },
    });
  });

  it("a resolved private line advances its own read cursor like any other pane", () => {
    // The placement with no workspace is still a real conversation on screen —
    // this is the second half of the #task:2035 bug (a pane that advanced no
    // cursor), now reachable through `?side` too.
    const out = selectVisibleConversations({
      primary,
      secondary: pairSideDescriptor,
      fullscreen: false,
    });
    expect(out).toEqual({
      primary,
      secondary: { id: "dp-alice", rosterPolicy: "fixed" },
    });
  });

  it("only secondary visible when fullscreen + resolved secondary", () => {
    const out = selectVisibleConversations({
      primary,
      secondary: sideSecondDescriptor,
      fullscreen: true,
    });
    expect(out).toEqual({
      primary: null,
      secondary: { id: "t-of-primary", rosterPolicy: "open" },
    });
  });

  it("only primary visible when secondary is loading (placeholder has no id to mark read)", () => {
    const out = selectVisibleConversations({
      primary,
      secondary: loadingSide,
      fullscreen: false,
    });
    expect(out).toEqual({ primary, secondary: null });
  });

  it("only primary visible when secondary is unauthorized", () => {
    const out = selectVisibleConversations({
      primary,
      secondary: unauthorizedSide,
      fullscreen: false,
    });
    expect(out).toEqual({ primary, secondary: null });
  });

  it("only primary visible when secondary is not_found", () => {
    const out = selectVisibleConversations({
      primary,
      secondary: notFoundSide,
      fullscreen: false,
    });
    expect(out).toEqual({ primary, secondary: null });
  });

  it("only primary visible when secondary is unresolved", () => {
    const out = selectVisibleConversations({
      primary,
      secondary: unresolvedSide,
      fullscreen: false,
    });
    expect(out).toEqual({ primary, secondary: null });
  });

  it("fullscreen with no secondary is a no-op (primary stays visible)", () => {
    const out = selectVisibleConversations({
      primary,
      secondary: null,
      fullscreen: true,
    });
    expect(out).toEqual({ primary, secondary: null });
  });

  it("fullscreen + non-resolved secondary still shows primary (placeholder has no read cursor)", () => {
    // The placeholder pane covers the viewport visually but contributes
    // no conversation to advance read cursors for. Primary stays in the
    // visible set so its cursor still moves on stream events.
    const out = selectVisibleConversations({
      primary,
      secondary: loadingSide,
      fullscreen: true,
    });
    expect(out).toEqual({ primary, secondary: null });
  });
});

describe("selectFocusedConversation — single-id focus rule", () => {
  it("returns primary when no secondary", () => {
    const out = selectFocusedConversation({
      primary,
      primaryWorkspaceId: "w-1",
      secondary: null,
      fullscreen: false,
    });
    expect(out).toEqual({ id: "c-primary", rosterPolicy: "open", workspaceId: "w-1" });
  });

  it("resolved secondary wins over primary (preserves legacy openThreadId ?? selectedChannelId)", () => {
    const out = selectFocusedConversation({
      primary,
      primaryWorkspaceId: "w-1",
      secondary: sideSecondDescriptor,
      fullscreen: false,
    });
    expect(out).toEqual({
      id: "t-of-primary",
      rosterPolicy: "open",
      workspaceId: "w-1",
    });
  });

  it("cross-workspace resolved secondary focuses on the *foreign* workspace id", () => {
    // PR-2 cross-workspace IPC contract: setActiveConversation must
    // emit the workspace the focused conversation lives in, not the
    // primary pane's workspace.
    const out = selectFocusedConversation({
      primary,
      primaryWorkspaceId: "w-1",
      secondary: foreignSideDescriptor,
      fullscreen: false,
    });
    expect(out).toEqual({
      id: "c-foreign",
      rosterPolicy: "open",
      workspaceId: "w-2",
    });
  });

  it("a resolved private line focuses with workspaceId null — NOT the primary workspace", () => {
    // Same rule as the cross-workspace case, one step further: focus reports
    // the focused conversation's OWN coordinate, and a private line's is
    // "no workspace". Falling back to the primary's id here would attribute
    // the DM to a workspace it is not in.
    const out = selectFocusedConversation({
      primary,
      primaryWorkspaceId: "w-1",
      secondary: pairSideDescriptor,
      fullscreen: false,
    });
    expect(out).toEqual({
      id: "dp-alice",
      rosterPolicy: "fixed",
      workspaceId: null,
    });
  });

  it("fullscreen + secondary keeps secondary focused (the only visible pane)", () => {
    const out = selectFocusedConversation({
      primary,
      primaryWorkspaceId: "w-1",
      secondary: sideSecondDescriptor,
      fullscreen: true,
    });
    expect(out?.id).toBe("t-of-primary");
  });

  it("non-resolved secondary does NOT take focus — primary keeps it", () => {
    // Toast suppression / notification-badge clearing should target a
    // real conversation, never the placeholder. Same rule for all four
    // non-resolved statuses.
    for (const ph of [loadingSide, unauthorizedSide, notFoundSide, unresolvedSide]) {
      const out = selectFocusedConversation({
        primary,
        primaryWorkspaceId: "w-1",
        secondary: ph,
        fullscreen: false,
      });
      expect(out).toEqual({ id: "c-primary", rosterPolicy: "open", workspaceId: "w-1" });
    }
  });

  it("returns null when nothing is visible", () => {
    const out = selectFocusedConversation({
      primary: null,
      primaryWorkspaceId: null,
      secondary: null,
      fullscreen: false,
    });
    expect(out).toBeNull();
  });

  it("side channel-typed secondary still wins focus (sigil click ux)", () => {
    // PR-3 will route sigil clicks through `openSide(id)`. The secondary
    // pointer is then a channel (not a thread), but the focus rule must
    // still hand attention to the side overlay so toasts for that
    // conversation don't fire while the user is reading it.
    const out = selectFocusedConversation({
      primary,
      primaryWorkspaceId: "w-1",
      secondary: sideChannelDescriptor,
      fullscreen: false,
    });
    expect(out?.id).toBe("c-other");
    expect(out?.rosterPolicy).toBe("open");
  });
});

describe("shouldSecondaryFullscreen — render-time fullscreen gate", () => {
  it("false when there is no secondary at all", () => {
    expect(shouldSecondaryFullscreen(null, true)).toBe(false);
    expect(shouldSecondaryFullscreen(null, false)).toBe(false);
  });

  it("false when fullscreen flag is off (split / overlay render)", () => {
    expect(shouldSecondaryFullscreen(sideChannelDescriptor, false)).toBe(false);
    expect(shouldSecondaryFullscreen(sideSecondDescriptor, false)).toBe(false);
    expect(shouldSecondaryFullscreen(loadingSide, false)).toBe(false);
  });

  it("true only when secondary is resolved AND fullscreen is set", () => {
    expect(shouldSecondaryFullscreen(sideChannelDescriptor, true)).toBe(true);
    expect(shouldSecondaryFullscreen(sideSecondDescriptor, true)).toBe(true);
    expect(shouldSecondaryFullscreen(foreignSideDescriptor, true)).toBe(true);
    // A private line is as resolved as any channel — the gate is about the
    // resolution status, never about having a workspace.
    expect(shouldSecondaryFullscreen(pairSideDescriptor, true)).toBe(true);
  });

  it("false for any non-resolved status + fullscreen — DOM falls back to split", () => {
    // This is the bug Cindy flagged in commit `e9278a7`. Without the
    // gate, `routeFullscreen && secondaryView` rendered only the
    // placeholder while `selectVisibleConversations` /
    // `selectFocusedConversation` kept primary in the visible/focused
    // set — primary's read cursor and notification badge advanced
    // even though the user never saw it. The same rule applies to all
    // four non-resolved statuses.
    expect(shouldSecondaryFullscreen(loadingSide, true)).toBe(false);
    expect(shouldSecondaryFullscreen(unauthorizedSide, true)).toBe(false);
    expect(shouldSecondaryFullscreen(notFoundSide, true)).toBe(false);
    expect(shouldSecondaryFullscreen(unresolvedSide, true)).toBe(false);
  });
});

// ── PR-2 cross-workspace integration: end-to-end descriptor → ChannelView prop chain ──
describe("selectSecondaryViewInputs — full descriptor → ChannelView prop chain", () => {
  it("returns null/primary fallbacks when there is no secondary", () => {
    const out = selectSecondaryViewInputs({
      secondary: null,
      primaryHasChannelNamespace: true,
      primaryWorkspaceId: "w-1",
    });
    expect(out).toEqual({
      conversationDescriptor: null,
      hasChannelNamespace: true,
      archiveWorkspaceId: "w-1",
    });
  });

  it("cross-workspace ?side resolved channel: ChannelView gets the *foreign* workspace id/path", () => {
    // The end-to-end assertion Cindy asked for (PR-2 review):
    // "?side=<other-workspace-channel> resolved 后，ChannelView 收到
    // other workspace id/kind/path，focused IPC 也用 other workspace
    // id." This locks the descriptor → ChannelView prop chain so a
    // future refactor can't quietly fall back to the primary's
    // workspace metadata.
    const out = selectSecondaryViewInputs({
      secondary: foreignSideDescriptor,
      // Primary has NO namespace (it is on a private line), so the `true`
      // below can only have come from the side's own descriptor — with a
      // boolean, a matching primary fallback would prove nothing.
      primaryHasChannelNamespace: false,
      primaryWorkspaceId: "w-1",
    });
    expect(out.conversationDescriptor).toEqual({
      id: "c-foreign",
      title: "team-y planning",
      placement_kind: "workspace",
      roster_policy: "open",
      closed_at: null,
      archived_at: null,
      // The whole point: ChannelView's workspace_id is the FOREIGN
      // one, not the primary's. Workspace-scoped hooks inside ChannelView
      // then target the right workspace cache.
      workspace_id: "w-2",
    });
    expect(out.hasChannelNamespace).toBe(true);
    // Archive mutation invalidation targets the FOREIGN workspace.
    expect(out.archiveWorkspaceId).toBe("w-2");
  });

  it("cross-workspace ?side resolved dm_channel: the foreign placement decides the namespace bit", () => {
    // The prop chain, locked at its far end: the bit comes from the SIDE's own
    // placement, so ChannelView's `hasChannelNamespace` prop — and every
    // consumer under it — ignores the primary. Note this is the
    // workspace-PLACED DM channel, which still has a workspace to invalidate.
    const out = selectSecondaryViewInputs({
      secondary: selectSecondaryDescriptor(
        { sideConversationId: "dm-foreign" },
        workspaceIdentity(foreignDmRef),
      ),
      primaryHasChannelNamespace: false,
      primaryWorkspaceId: "w-1",
    });
    expect(out.conversationDescriptor?.workspace_id).toBe("w-bob-home");
    expect(out.conversationDescriptor?.roster_policy).toBe("fixed");
    expect(out.hasChannelNamespace).toBe(true);
    expect(out.archiveWorkspaceId).toBe("w-bob-home");
  });

  it("?side resolved private line: ChannelView gets the DM descriptor and NO workspace", () => {
    // The #task:2038 prop chain. `hasChannelNamespace: false` is what withholds
    // every top-level channel affordance (rename / archive / visibility /
    // member management) — and it must not fall back to the primary's `true`.
    // `archiveWorkspaceId: null` must NOT fall back either: invalidating
    // `['workspaces', w-1, 'channels']` for a conversation that is not in w-1
    // would be a wrong cache write.
    const out = selectSecondaryViewInputs({
      secondary: pairSideDescriptor,
      primaryHasChannelNamespace: true,
      primaryWorkspaceId: "w-1",
    });
    expect(out.conversationDescriptor).toEqual({
      id: "dp-alice",
      title: "Alice",
      placement_kind: "direct_pair",
      roster_policy: "fixed",
      closed_at: null,
      archived_at: null,
      workspace_id: null,
      read_only: false,
      counterpart: agentPair.counterpart,
    });
    expect(out.hasChannelNamespace).toBe(false);
    expect(out.archiveWorkspaceId).toBeNull();
  });

  it("same-workspace ?side resolved channel: still routes through the identity descriptor", () => {
    // Even when the side conversation lives in the same workspace as
    // primary, the pane routes through the identity resolution for consistency.
    const out = selectSecondaryViewInputs({
      secondary: sideChannelDescriptor,
      primaryHasChannelNamespace: true,
      primaryWorkspaceId: "w-1",
    });
    expect(out.conversationDescriptor?.workspace_id).toBe("w-1");
    expect(out.archiveWorkspaceId).toBe("w-1");
  });

  it("non-resolved ?side: descriptor null, primary fallbacks (placeholder pane handles render)", () => {
    for (const ph of [loadingSide, unauthorizedSide, notFoundSide, unresolvedSide]) {
      const out = selectSecondaryViewInputs({
        secondary: ph,
        primaryHasChannelNamespace: true,
        primaryWorkspaceId: "w-1",
      });
      expect(out).toEqual({
        conversationDescriptor: null,
        hasChannelNamespace: true,
        archiveWorkspaceId: "w-1",
      });
    }
  });
});

describe("selectSidebarSelectedConversationId — which row the sidebar fills", () => {
  it("primary selection when there is no secondary", () => {
    expect(
      selectSidebarSelectedConversationId({
        primarySelectedChannelId: "c-primary",
        secondary: null,
        primaryWorkspaceId: "w-1",
      }),
    ).toBe("c-primary");
  });

  it("a same-workspace resolved secondary takes the highlight", () => {
    expect(
      selectSidebarSelectedConversationId({
        primarySelectedChannelId: "c-primary",
        secondary: sideChannelDescriptor,
        primaryWorkspaceId: "w-1",
      }),
    ).toBe("c-other");
  });

  it("a cross-workspace resolved secondary does NOT (its row is under another parent)", () => {
    expect(
      selectSidebarSelectedConversationId({
        primarySelectedChannelId: "c-primary",
        secondary: foreignSideDescriptor,
        primaryWorkspaceId: "w-1",
      }),
    ).toBe("c-primary");
  });

  it("a resolved private line takes the highlight whatever workspace is expanded", () => {
    // Its row lives in the workspace-independent DIRECT MESSAGES section, so it
    // is on screen either way — and comparing its null workspace against the
    // selected one would answer for the wrong reason (#task:2038).
    for (const wid of ["w-1", "w-2", null]) {
      expect(
        selectSidebarSelectedConversationId({
          primarySelectedChannelId: "c-primary",
          secondary: pairSideDescriptor,
          primaryWorkspaceId: wid,
        }),
      ).toBe("dp-alice");
    }
  });

  it("a non-resolved secondary never takes the highlight", () => {
    for (const ph of [loadingSide, unauthorizedSide, notFoundSide, unresolvedSide]) {
      expect(
        selectSidebarSelectedConversationId({
          primarySelectedChannelId: "c-primary",
          secondary: ph,
          primaryWorkspaceId: "w-1",
        }),
      ).toBe("c-primary");
    }
  });
});
