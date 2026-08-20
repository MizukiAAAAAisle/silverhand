/**
 * The agent's conversations, flat and full width (#task:2040).
 *
 * shiki's ruling replaced the master-detail shape this section shipped with: no
 * secondary side nav, one full-width list, and a row is either a way INTO the
 * conversation or inert («如果是有我参与的，应该直接跳转对应的 conversation，如果没有
 * 我参与的，暂时变为不可点击»). The in-place owner-audit transcript is gone with the
 * rail — a row now leads to the ordinary chat surface or nowhere, so there is no
 * second place to read a conversation from.
 *
 * The list itself is still the OWNER-AUDIT read (`GET /api/agents/:id/chats`):
 * the owner may see which conversations their agent is in, including lines they
 * are no part of. Clickability is a different question with different
 * authorities, and mixing the two is the one real hazard here — so the judgment
 * lives in {@link decideAgentChatRowAccess} and this file only paints its verdict.
 * The viewer-scoped authorities it feeds on:
 *   - workspace rows → the viewer's OWN channel lists, BOTH tables (active and
 *     archived carry the same per-viewer `is_member`, and a joined-then-archived
 *     channel exists only in the second), `is_member` only — a list is a
 *     discovery union, so presence in it proves nothing;
 *   - `direct_pair` rows → the viewer's own `GET /api/direct-pairs`, which is the
 *     set of lines they are an endpoint of.
 *
 * READINESS COVERS EVERY AUTHORITY IN THE CHAIN, including the viewer's workspace
 * list: it is what maps a row onto a container, so before it answers there is
 * nothing to fan out over and an empty fan-out must not read as "asked and
 * answered" (@Cindy, #task:2040 review). Settled, not successful — a failed
 * authority leaves its rows inert rather than holding the pane in a loading state
 * it can never leave. Nothing is prefetched for an inert row.
 *
 * A row whose authority FAILED is disabled but says so honestly: fail-closed
 * licenses the disabling, not the claim that the viewer is not a participant.
 */
import { useMemo, type JSX, type ReactNode } from 'react';
import type { AgentAuditChatSummary } from '@silverhand/shared';
import { cn } from '@/lib/cn';
import { ChannelIcon } from '@/components/ChannelIcon';
import {
  AuthorAvatarView,
  DeletedActorMarker,
} from '@/components/chat/author-avatar-view';
import { useAgentAvatarObjectUrls } from '@/features/agents/avatar-hooks';
import { useUserAvatarObjectUrls } from '@/features/users/avatar-hooks';
import {
  collectCounterpartAvatarSources,
  presentCounterpart,
  type CounterpartPresentation,
} from '@/features/direct-pairs/counterpart-presentation';
import { useDirectPairsList } from '@/features/direct-pairs/hooks';
import {
  useArchivedChannelsAcrossWorkspaces,
  useChannelsAcrossWorkspaces,
  useWorkspaces,
} from '@/features/workspaces/hooks';
import { useAgentAuditChats } from './audit-hooks';
import {
  collectMemberConversationIds,
  decideAgentChatRowAccess,
  participationWorkspaceIds,
  viewerAuthoritiesSettled,
  type AgentChatBlockedReason,
  type AgentChatRowAccess,
  type ViewerParticipation,
} from './audit-participation';

interface AgentChatsPaneProps {
  agentId: string;
  /** Open a conversation the viewer takes part in, in the ordinary chat surface.
   *  Carries the placement (`workspaceId: null` = a `direct_pair`) because the two
   *  placements have two destinations. Optional like its sibling on the Activity
   *  pane: without it the list still reads, and no row is actionable. */
  onOpenChat?: (target: { conversationId: string; workspaceId: string | null }) => void;
}

export function AgentChatsPane({
  agentId,
  onOpenChat,
}: AgentChatsPaneProps): JSX.Element {
  const chatsQuery = useAgentAuditChats(agentId, true);
  const chats = chatsQuery.data?.chats;

  // Only the viewer's OWN workspaces that could hold one of these rows: a list
  // from a workspace they are not in would simply be refused. This query is an
  // authority in its own right — until it answers, no row can even be mapped to
  // a container.
  const workspacesQuery = useWorkspaces();
  const viewerWorkspaces = workspacesQuery.data;
  const workspaceIds = useMemo(
    () => participationWorkspaceIds(chats, viewerWorkspaces ?? []),
    [chats, viewerWorkspaces],
  );
  const activeLists = useChannelsAcrossWorkspaces(workspaceIds);
  const archivedLists = useArchivedChannelsAcrossWorkspaces(workspaceIds);
  const pairsQuery = useDirectPairsList();

  // Recomputed per render rather than memoised: `useQueries` hands back a fresh
  // array every time, so a dependency on it would be a lie that reads as a
  // guarantee. The inputs are two small id sets.
  //
  // A workspace counts as ANSWERED only when BOTH of its tables succeeded — a
  // conversation the viewer joined may sit in either one, so half an answer
  // cannot license "not a member".
  const participation: ViewerParticipation = {
    workspaces: viewerWorkspaces ?? null,
    resolvedWorkspaceIds: new Set(
      workspaceIds.filter(
        (_, i) => activeLists[i]?.isSuccess && archivedLists[i]?.isSuccess,
      ),
    ),
    memberConversationIds: collectMemberConversationIds([
      ...activeLists.map(q => q.data),
      ...archivedLists.map(q => q.data),
    ]),
    directPairIds: pairsQuery.data
      ? new Set(pairsQuery.data.direct_pairs.map(p => p.conversation_id))
      : null,
  };
  // Settled, not successful, and covering EVERY authority — the workspace list
  // included. The rule (and the empty-fan-out trap it avoids) lives in the seam.
  const participationSettled = viewerAuthoritiesSettled({
    workspacesPending: workspacesQuery.isPending,
    pairsPending: pairsQuery.isPending,
    channelTablesPending: [...activeLists, ...archivedLists].map(q => q.isPending),
  });

  // ONE avatar batch for the surface, over the counterpart set — the discipline
  // every author surface follows. Deleted counterparts fetch nothing.
  const { agents, users } = useMemo(
    () =>
      collectCounterpartAvatarSources(
        (chats ?? []).flatMap(c => (c.placement_kind === 'direct_pair' ? [c] : [])),
      ),
    [chats],
  );
  const agentAvatarUrls = useAgentAvatarObjectUrls(agents);
  const humanAvatarUrls = useUserAvatarObjectUrls(users);

  if (chatsQuery.isPending || !participationSettled) {
    return <PaneNote>Loading chats…</PaneNote>;
  }
  if (chatsQuery.isError) {
    return <PaneNote>Couldn’t load this agent’s chats.</PaneNote>;
  }
  if (!chats || chats.length === 0) {
    return <PaneNote>This agent has no conversations yet.</PaneNote>;
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      <div className="px-8 py-6">
        <ul className="border-y border-border-subtle">
          {chats.map(chat => (
            <li
              key={chat.conversation_id}
              className="border-b border-border-subtle last:border-b-0"
            >
              <ChatRow
                chat={chat}
                access={decideAgentChatRowAccess(chat, participation)}
                agentAvatarUrls={agentAvatarUrls}
                humanAvatarUrls={humanAvatarUrls}
                onOpen={onOpenChat}
              />
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

function PaneNote({ children }: { children: ReactNode }): JSX.Element {
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center text-sm text-text-muted">
      {children}
    </div>
  );
}

/** Why an inert row is inert. Short, and about the conversation rather than about
 *  permissions machinery — except that "we couldn't find out" must never be
 *  dressed up as "you're not in it": the second is a claim, the first is a
 *  temporary failure the viewer can retry by reopening the page. */
const BLOCKED_TITLE: Record<AgentChatBlockedReason, string> = {
  'not-a-participant': 'You’re not in this conversation.',
  unverified: 'Couldn’t check your access to this conversation.',
};

/**
 * How one row names itself, derived in a SINGLE narrowing of the placement union:
 * the two arms don't share a name field — a workspace channel has a title, a
 * direct line is named by its counterpart — and they carry different metas.
 * Keeping it in one place also keeps the avatar/icon choice honest: `counterpart`
 * is non-null exactly for the rows that wear a face.
 */
function describeChatRow(chat: AgentAuditChatSummary): {
  title: string;
  meta: string;
  counterpart: CounterpartPresentation | null;
} {
  if (chat.placement_kind === 'direct_pair') {
    const counterpart = presentCounterpart(chat.counterpart);
    return { title: counterpart.label, meta: 'Direct message', counterpart };
  }
  return {
    title: chat.title,
    // The container's own name, which for an agent space IS the bound agent's —
    // the same label every other picker/filter row shows. No kind branch: this
    // carrier never had the list shape's `dm-` prefix, and #task:2066 retired
    // that prefix everywhere, so both kinds render the name verbatim.
    meta: chat.workspace_name,
    counterpart: null,
  };
}

/**
 * One row. Identity primitive per entity, not one glyph everywhere: a workspace
 * channel wears the canonical `#`, a direct line wears its counterpart's avatar —
 * the same faces these conversations have in the sidebar.
 *
 * Two shells, chosen by the verdict, because they are two different things: a way
 * in (a real `<button>`, with the hover the rest of the app gives a navigable row)
 * and a fact on the page (no button, no hover, muted, with the reason on hover).
 */
function ChatRow({
  chat,
  access,
  agentAvatarUrls,
  humanAvatarUrls,
  onOpen,
}: {
  chat: AgentAuditChatSummary;
  access: AgentChatRowAccess;
  agentAvatarUrls: ReadonlyMap<string, string | null>;
  humanAvatarUrls: ReadonlyMap<string, string | null>;
  onOpen?: (target: { conversationId: string; workspaceId: string | null }) => void;
}): JSX.Element {
  const { title, meta, counterpart } = describeChatRow(chat);

  const body = (
    <>
      {counterpart ? (
        <AuthorAvatarView
          avatar={counterpart.avatar}
          size={16}
          label={counterpart.label}
          agentAvatarUrls={agentAvatarUrls}
          humanAvatarUrls={humanAvatarUrls}
        />
      ) : (
        <ChannelIcon variant="sticker" />
      )}
      <span className="min-w-0 flex-1 truncate">{title}</span>
      {counterpart?.isDeleted ? (
        <span className="flex shrink-0 items-center">
          <DeletedActorMarker />
        </span>
      ) : null}
      <span className="shrink-0 text-xs text-text-muted">
        {meta}
        {chat.archived_at !== null ? ' · Archived' : ''}
      </span>
    </>
  );

  const shell = 'flex h-11 w-full items-center gap-2.5 px-3 text-left text-sm';

  if (access.kind === 'open' && onOpen) {
    return (
      <button
        type="button"
        onClick={() => onOpen({
          conversationId: access.conversationId,
          workspaceId: access.workspaceId,
        })}
        className={cn(
          shell,
          'text-text-primary transition-colors hover:bg-bg-hover/50 focus-outline',
        )}
      >
        {body}
      </button>
    );
  }

  return (
    <div
      className={cn(shell, 'text-text-muted')}
      title={access.kind === 'blocked' ? BLOCKED_TITLE[access.reason] : undefined}
    >
      {body}
    </div>
  );
}
