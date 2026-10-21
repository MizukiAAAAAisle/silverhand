import { AgentChatsSkeleton } from "./agent-loading";
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
 * SHAPE (#task:2116, shiki): this is a list page like the others, so it speaks
 * their vocabulary — {@link CollectionItemCard} rows in grouped sections, not the
 * full-bleed `border-y` table this shipped with. And the rows are GROUPED, flat:
 * one section per workspace, one for every direct line, no tree — see
 * {@link groupAgentChats} for why that needs no authority beyond the list itself.
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
import { useMemo, type JSX, type ReactNode } from "react";
import type { AgentAuditChatSummary } from "@silverhand/shared";
import { cn } from "@/lib/cn";
import { ChannelIcon } from "@/components/channel-icon";
import {
  CollectionItemCard,
  COLLECTION_CARD_CLASS,
} from "@/components/layout/collection-item-card";
import {
  AuthorAvatarView,
  DeletedActorMarker,
} from "@/features/messages/components/author-avatar-view";
import { useAgentAvatarObjectUrls } from "@/features/agents/hooks/avatar-hooks";
import { useUserAvatarObjectUrls } from "@/features/users/avatar-hooks";
import {
  collectCounterpartAvatarSources,
  presentCounterpart,
  type CounterpartPresentation,
} from "@/features/direct-pairs/counterpart-presentation";
import { useDirectPairsList } from "@/features/direct-pairs/hooks";
import {
  useArchivedChannelsAcrossWorkspaces,
  useChannelsAcrossWorkspaces,
  useWorkspaces,
} from "@/features/workspaces/hooks";
import { useAgentAuditChats } from "../hooks/audit-hooks";
import { AGENT_PANE_INSET } from "../model/agent-pane-layout";
import {
  collectMemberConversationIds,
  decideAgentChatRowAccess,
  participationWorkspaceIds,
  viewerAuthoritiesSettled,
  type AgentChatBlockedReason,
  type AgentChatRowAccess,
  type ViewerParticipation,
} from "../model/audit-participation";
import { t } from "@/lib/i18n";

interface AgentChatsPaneProps {
  agentId: string;
  /** Open a conversation the viewer takes part in, in the ordinary chat surface.
   *  Carries the placement (`workspaceId: null` = a `direct_pair`) because the two
   *  placements have two destinations. Optional like its sibling on the Activity
   *  pane: without it the list still reads, and no row is actionable. */
  onOpenChat?: (target: { conversationId: string; workspaceId: string | null }) => void;
}

export function AgentChatsPane({ agentId, onOpenChat }: AgentChatsPaneProps): JSX.Element {
  const chatsQuery = useAgentAuditChats(agentId, true);
  // Archived conversations are excluded from this list (shiki #task:2116): the
  // owner-audit endpoint returns them, but the Chats page shows only live lines.
  // Filtered once here so grouping, counts, avatar batch and the empty state all
  // speak of the same set.
  const chats = useMemo(
    () => chatsQuery.data?.chats.filter((c) => c.archived_at === null),
    [chatsQuery.data],
  );

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
      workspaceIds.filter((_, i) => activeLists[i]?.isSuccess && archivedLists[i]?.isSuccess),
    ),
    memberConversationIds: collectMemberConversationIds([
      ...activeLists.map((q) => q.data),
      ...archivedLists.map((q) => q.data),
    ]),
    directPairIds: pairsQuery.data
      ? new Set(pairsQuery.data.direct_pairs.map((p) => p.conversation_id))
      : null,
  };
  // Settled, not successful, and covering EVERY authority — the workspace list
  // included. The rule (and the empty-fan-out trap it avoids) lives in the seam.
  const participationSettled = viewerAuthoritiesSettled({
    workspacesPending: workspacesQuery.isPending,
    pairsPending: pairsQuery.isPending,
    channelTablesPending: [...activeLists, ...archivedLists].map((q) => q.isPending),
  });

  // ONE avatar batch for the surface, over the counterpart set — the discipline
  // every author surface follows. Deleted counterparts fetch nothing.
  const { agents, users } = useMemo(
    () =>
      collectCounterpartAvatarSources(
        (chats ?? []).flatMap((c) => (c.placement_kind === "direct_pair" ? [c] : [])),
      ),
    [chats],
  );
  const agentAvatarUrls = useAgentAvatarObjectUrls(agents);
  const humanAvatarUrls = useUserAvatarObjectUrls(users);

  if (chatsQuery.isPending || !participationSettled) {
    return <AgentChatsSkeleton />;
  }
  if (chatsQuery.isError) {
    return <PaneNote>{t("agents.couldntLoadThisAgents")}</PaneNote>;
  }
  if (!chats || chats.length === 0) {
    return <PaneNote>{t("agents.thisAgentHasNo")}</PaneNote>;
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      <div className={cn("space-y-5", AGENT_PANE_INSET)}>
        {groupAgentChats(chats).map((group) => (
          <section key={group.key}>
            {/* Group chrome mirrors SearchPanel's sections — same product
                concept (a labelled band of collection cards) — but the label is
                one weight bolder here (`font-semibold`, shiki 2026-08-21) so the
                grouping reads as the primary structure of this denser audit list.
                NO icon in the header, unlike Search: a workspace's
                identity glyph needs its `owner_agent_id`, which the audit list
                does not carry and the viewer's own workspace list cannot supply
                for a container they are not in. A neutral glyph would draw
                "unowned workspace" — a claim, not a gap (#task:2084's lesson).
                Each ROW still wears its own entity's identity primitive. */}
            <header className="mb-2 flex items-center gap-2 px-1 text-(length:--text-meta) font-semibold uppercase leading-none tracking-wider text-text-muted">
              <span className="min-w-0 truncate leading-none">{group.label}</span>
              <span className="leading-none text-text-muted/70">{group.chats.length}</span>
            </header>
            <ul className="space-y-2">
              {group.chats.map((chat) => (
                <ChatRow
                  key={chat.conversation_id}
                  chat={chat}
                  access={decideAgentChatRowAccess(chat, participation)}
                  agentAvatarUrls={agentAvatarUrls}
                  humanAvatarUrls={humanAvatarUrls}
                  onOpen={onOpenChat}
                />
              ))}
            </ul>
          </section>
        ))}
      </div>
    </div>
  );
}

/** One flat section of the list: a workspace's conversations, or every direct
 *  line. */
interface AgentChatGroup {
  key: string;
  label: string;
  chats: AgentAuditChatSummary[];
}

/**
 * Group the audit list FLAT — one section per workspace, one for all direct
 * lines, no tree (shiki #task:2116「每个 workspace 是一个 group，agent space 是一个
 * group，所有的 DM 是一个 group。平铺即可」). An agent space needs no arm of its own: it
 * IS a workspace, so it falls out as its own section, labelled by its name —
 * which for an agent space is the bound agent's.
 *
 * Both the sections and their rows keep the list's SERVER order (`created_at`,
 * oldest first): a section takes the position of its first row, so the ordering
 * needs nothing beyond the response — no workspace directory, which the viewer
 * may not even have for a container they are not in. Direct lines go last: a
 * pair is not a container, so it is the one group that names no place.
 */
function groupAgentChats(chats: readonly AgentAuditChatSummary[]): AgentChatGroup[] {
  const byWorkspace = new Map<string, AgentChatGroup>();
  const directs: AgentAuditChatSummary[] = [];

  for (const chat of chats) {
    if (chat.placement_kind === "direct_pair") {
      directs.push(chat);
      continue;
    }
    const existing = byWorkspace.get(chat.workspace_id);
    if (existing) {
      existing.chats.push(chat);
      continue;
    }
    byWorkspace.set(chat.workspace_id, {
      key: `workspace:${chat.workspace_id}`,
      label: chat.workspace_name,
      chats: [chat],
    });
  }

  const groups = [...byWorkspace.values()];
  if (directs.length > 0) {
    groups.push({ key: "direct", label: t("agents.directMessages"), chats: directs });
  }
  return groups;
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
const blockedTitle = (): Record<AgentChatBlockedReason, string> => ({
  "not-a-participant": t("agents.youreNotInThis"),
  unverified: t("agents.couldntCheckYourAccess"),
});

/**
 * How one row names itself, derived in a SINGLE narrowing of the placement union:
 * the two arms don't share a name field — a workspace channel has a title, a
 * direct line is named by its counterpart. Keeping it in one place also keeps the
 * avatar/icon choice honest: `counterpart` is non-null exactly for the rows that
 * wear a face.
 *
 * No meta line: the container's name and "this is a direct line" are now the
 * GROUP's job (#task:2116), and repeating a section's label on every row inside it
 * is ink that carries no information.
 */
function describeChatRow(chat: AgentAuditChatSummary): {
  title: string;
  counterpart: CounterpartPresentation | null;
} {
  if (chat.placement_kind === "direct_pair") {
    const counterpart = presentCounterpart(chat.counterpart);
    return { title: counterpart.label, counterpart };
  }
  return { title: chat.title, counterpart: null };
}

/**
 * One row, in the shared collection-card vocabulary (#task:2116, shiki:
 * 「Chats item 样式跟其他的列表页样式不一致（比如 searched message）」) — the same frame,
 * inset and hover language as a search result or an archived channel, because it
 * is the same product concept.
 *
 * Identity primitive per entity, not one glyph everywhere: a workspace channel
 * wears the canonical `#` sticker, a direct line wears its counterpart's avatar —
 * the same faces these conversations have in the sidebar. Both sit in the shared
 * icon slot, which draws no frame of its own: a sticker already carries one, and a
 * second box around it would be a lift on top of a lift.
 *
 * Two shells, chosen by the verdict, because they are two different things: a way
 * in (a real `<button>` card) and a fact on the page (the same frame WITHOUT the
 * hover hook, muted, with the reason on hover). The frame-minus-hook spelling is
 * the shell's own documented one — loading skeletons use it for the same reason,
 * a card that must not answer the pointer.
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
  const { title, counterpart } = describeChatRow(chat);

  const body = (
    <>
      <span
        data-collection-card-icon
        className="flex size-8 shrink-0 items-center justify-center text-text-muted"
      >
        {counterpart ? (
          <AuthorAvatarView
            avatar={counterpart.avatar}
            size={24}
            label={counterpart.label}
            agentAvatarUrls={agentAvatarUrls}
            humanAvatarUrls={humanAvatarUrls}
          />
        ) : (
          <ChannelIcon variant="sticker" density="lg" />
        )}
      </span>
      <span className="min-w-0 flex-1 truncate text-sm font-medium">{title}</span>
      {counterpart?.isDeleted ? (
        <span className="flex shrink-0 items-center">
          <DeletedActorMarker />
        </span>
      ) : null}
    </>
  );

  const inner = "flex w-full min-w-0 items-center gap-3 px-3 py-2.5 text-left";

  if (access.kind === "open" && onOpen) {
    return (
      <li>
        <CollectionItemCard
          as="button"
          type="button"
          onClick={() =>
            onOpen({
              conversationId: access.conversationId,
              workspaceId: access.workspaceId,
            })
          }
          className={cn(inner, "text-text-primary focus-outline")}
        >
          {body}
        </CollectionItemCard>
      </li>
    );
  }

  return (
    <li>
      <div
        className={cn(COLLECTION_CARD_CLASS, inner, "text-text-muted")}
        title={access.kind === "blocked" ? blockedTitle()[access.reason] : undefined}
      >
        {body}
      </div>
    </li>
  );
}
