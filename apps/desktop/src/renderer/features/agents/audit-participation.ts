/**
 * Whether the VIEWER can walk into a conversation listed on an agent's Chats
 * page (#task:2040).
 *
 * The Chats list is an OWNER-AUDIT read: `GET /api/agents/:id/chats` answers
 * "which conversations is this agent in", and the owner is allowed to see that
 * even for lines they are not part of. Clickability is a completely different
 * question — "may the viewer open it as themselves" — and it must be answered
 * from VIEWER-scoped authorities only (@Cindy's #task:2040 boundary). Owner
 * audit ability, workspace visibility and public discovery are all NOT
 * participation:
 *
 *  - the audit summary carries no per-viewer field at all, by design;
 *  - a workspace channel list is a DISCOVERY UNION — it also contains public
 *    channels the viewer has not joined, so presence in it proves nothing and
 *    only the row's own `is_member` does ({@link deriveChannelMembership}, whose
 *    fail-closed three-state rule this module reuses rather than re-reading the
 *    field);
 *  - a `direct_pair` has no membership table to consult: the viewer's own
 *    `GET /api/direct-pairs` list IS the set of lines they are an endpoint of.
 *
 * ARCHIVE IS NOT A SECOND AUTHORITY (@Cindy, #task:2040 review). A workspace has
 * two channel tables and both answer the same viewer-scoped question: since
 * #task:1691 the archived route returns the same rows with the same `is_member`,
 * and the archived set is membership-filtered too. A joined channel that was
 * later archived therefore lives ONLY in the archived table, and the pair list
 * has no archived filter at all — so "archived" earns no pre-emptive refusal
 * here. Both tables flow into the one membership set and the row is judged once.
 *
 * THREE OUTCOMES, NOT TWO. "The viewer is not in it" and "we could not find out"
 * are different facts, and fail-closed licenses only the DISABLING, never the
 * claim: an authority that is missing or failed yields `unverified`, and only an
 * authority that actually ANSWERED can produce `not-a-participant`. That is why
 * every authority below is nullable — `null` is "no answer", and there is no way
 * to spell it as an empty set by accident.
 */
import type { AgentAuditChatSummary } from '@silverhand/shared';
import {
  deriveChannelMembership,
  type MembershipCarrier,
} from '@/features/channels/membership';

/**
 * The viewer-scoped authorities a row is judged against. `null` means the
 * authority has not answered (still loading, or failed) — distinct from an empty
 * answer, which is a real negative.
 */
export interface ViewerParticipation {
  /** The viewer's OWN workspaces, the only containers that could hold a channel
   *  they have joined. `null` = the workspace list itself hasn't answered. */
  workspaces: readonly ViewerWorkspaceCoordinate[] | null;
  /** Workspaces whose channel authority answered IN FULL (both tables). A row
   *  mapped to a workspace outside this set is `unverified`, not absent. */
  resolvedWorkspaceIds: ReadonlySet<string>;
  /** Conversations the viewer has JOINED — `is_member: true` rows of the
   *  viewer's own channel lists, active and archived. Never "every row". */
  memberConversationIds: ReadonlySet<string>;
  /** Conversations the viewer is an ENDPOINT of. `null` = the pair list hasn't
   *  answered; an empty set means they hold no lines. */
  directPairIds: ReadonlySet<string> | null;
}

/** Why a row is inert: the viewer is provably not in it, or no viewer authority
 *  could answer. The second is not a permission statement and must not be drawn
 *  as one. */
export type AgentChatBlockedReason = 'not-a-participant' | 'unverified';

/** The bit of a viewer workspace this module reads: its id, plus the DM channels
 *  it fronts (an agent-home container names them, a regular workspace has none —
 *  hence optional rather than an empty array every caller must build). */
export interface ViewerWorkspaceCoordinate {
  id: string;
  dm_channel_ids?: readonly string[];
}

/**
 * What a Chats row may do: open the conversation as the viewer, or nothing.
 *
 * `workspaceId` travels WITH the open verdict because the two placements have two
 * destinations (a workspace channel route vs. the workspace-less pair route), and
 * the row must not re-derive that from a nullable field at the call site.
 */
export type AgentChatRowAccess =
  | { kind: 'open'; conversationId: string; workspaceId: string | null }
  | { kind: 'blocked'; reason: AgentChatBlockedReason };

/**
 * Collect the viewer's joined conversation ids out of however many channel lists
 * were read — active and archived tables together, since both carry the same
 * per-viewer `is_member` and neither is complete alone.
 *
 * Membership comes from {@link deriveChannelMembership} — the locked authority
 * rule — so `is_member: false` (a browse-only public channel) and a payload that
 * lacks the field entirely are both excluded. A list that is still loading or
 * failed contributes `undefined`, which contributes nothing; whether that
 * absence may be read as "not a member" is decided by
 * {@link ViewerParticipation.resolvedWorkspaceIds}, not here.
 */
export function collectMemberConversationIds(
  lists: ReadonlyArray<readonly (MembershipCarrier & { id: string })[] | undefined>,
): ReadonlySet<string> {
  const ids = new Set<string>();
  for (const list of lists) {
    if (!list) continue;
    for (const item of list) {
      if (deriveChannelMembership(item) === 'member') ids.add(item.id);
    }
  }
  return ids;
}

/**
 * Which of the viewer's OWN workspaces could hold this row, or `null` if none.
 *
 * Two ways a row maps onto a viewer workspace, because a `dm_channel`'s own
 * `workspace_id` is the AGENT's home and not necessarily a container the viewer
 * holds: the row's own workspace when the viewer is in it, else the viewer's home
 * whose `dm_channel_ids` names the conversation (the same two-step
 * `resolveNavWorkspaceId` walks when it builds the URL).
 *
 * One definition, consumed both by the fan-out that decides which lists to read
 * and by the verdict below — otherwise "which list would prove this row" and
 * "which list did we check" could drift apart, which is exactly how a failed read
 * turns into a false negative.
 */
export function viewerWorkspaceForChat(
  chat: AgentAuditChatSummary,
  viewerWorkspaces: readonly ViewerWorkspaceCoordinate[],
): string | null {
  if (chat.placement_kind !== 'workspace') return null;
  if (viewerWorkspaces.some(w => w.id === chat.workspace_id)) return chat.workspace_id;
  const home = viewerWorkspaces.find(w =>
    w.dm_channel_ids?.includes(chat.conversation_id),
  );
  return home?.id ?? null;
}

/**
 * Judge ONE audit row against the viewer's authorities.
 *
 * Archive plays no part: it is a state of the conversation, not of the viewer's
 * relation to it, and both channel tables answer membership (see the module
 * docblock). An archived conversation the viewer belongs to opens like any other
 * — read-only once inside, which the chat surface already owns.
 */
export function decideAgentChatRowAccess(
  chat: AgentAuditChatSummary,
  viewer: ViewerParticipation,
): AgentChatRowAccess {
  if (chat.placement_kind === 'direct_pair') {
    // No pair answer ⇒ no claim. Silence here would otherwise tell the viewer
    // they are not in their own line.
    if (!viewer.directPairIds) return { kind: 'blocked', reason: 'unverified' };
    return viewer.directPairIds.has(chat.conversation_id)
      ? {
          kind: 'open',
          conversationId: chat.conversation_id,
          // A pair has no workspace coordinate, and that is the whole reason it
          // routes differently (#task:2035).
          workspaceId: null,
        }
      : { kind: 'blocked', reason: 'not-a-participant' };
  }

  if (!viewer.workspaces) return { kind: 'blocked', reason: 'unverified' };
  const holder = viewerWorkspaceForChat(chat, viewer.workspaces);
  // A PROVEN negative that needs no channel table: the viewer holds no container
  // that could contain this conversation.
  if (!holder) return { kind: 'blocked', reason: 'not-a-participant' };
  if (!viewer.resolvedWorkspaceIds.has(holder)) {
    return { kind: 'blocked', reason: 'unverified' };
  }
  return viewer.memberConversationIds.has(chat.conversation_id)
    ? {
        kind: 'open',
        conversationId: chat.conversation_id,
        // The holder, not `chat.workspace_id`: for a `dm_channel` the row's own
        // workspace is the agent's home, while the viewer navigates through the
        // container they actually hold.
        workspaceId: holder,
      }
    : { kind: 'blocked', reason: 'not-a-participant' };
}

/**
 * Whether every viewer authority in the chain has SETTLED, i.e. the pane may stop
 * showing one loading state and start painting verdicts.
 *
 * Settled, not successful: a failed authority is settled, and its rows come out
 * `unverified` rather than holding the pane in a state it can never leave.
 *
 * The workspace list is part of this and the reason the function exists
 * (@Cindy, #task:2040 review). It is what maps a row onto a container, so while
 * it is pending the channel fan-out is EMPTY — and an empty fan-out satisfies
 * "every list answered" vacuously. Reading only the fan-out therefore declares
 * readiness before anything was asked, paints every workspace row inert, and
 * flips them once the list lands: the affordance flash the gate exists to
 * prevent. Ordering is the whole content of this rule, which is why it is a
 * function and not an inline `&&`.
 */
export function viewerAuthoritiesSettled(input: {
  workspacesPending: boolean;
  pairsPending: boolean;
  /** One flag per fanned-out channel table. Empty while the workspace list is
   *  pending — which is exactly why it cannot be the only input. */
  channelTablesPending: readonly boolean[];
}): boolean {
  if (input.workspacesPending || input.pairsPending) return false;
  return input.channelTablesPending.every(pending => !pending);
}

/**
 * The workspaces whose channel lists are worth reading for this chats list —
 * i.e. the viewer's OWN workspaces that could hold one of these rows.
 *
 * Narrowing is not an optimisation: a workspace the viewer is not in cannot hold
 * a channel they have joined, and asking for its channel list would be a request
 * the backend refuses. Archived rows ARE included — they are judged by the same
 * two tables as any other row.
 *
 * `direct_pair` rows contribute nothing here; they are answered by the pair list.
 */
export function participationWorkspaceIds(
  chats: readonly AgentAuditChatSummary[] | undefined,
  viewerWorkspaces: readonly ViewerWorkspaceCoordinate[],
): string[] {
  if (!chats) return [];
  const ids = new Set<string>();
  for (const chat of chats) {
    const holder = viewerWorkspaceForChat(chat, viewerWorkspaces);
    if (holder) ids.add(holder);
  }
  // Sorted so the fan-out's query list is stable across re-renders regardless of
  // the order rows arrive in.
  return Array.from(ids).sort();
}
