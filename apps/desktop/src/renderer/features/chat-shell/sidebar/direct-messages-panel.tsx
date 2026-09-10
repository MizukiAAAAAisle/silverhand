import { useMemo } from "react";
import { MessageSquare } from "lucide-react";
import { useAgent } from "@/features/agent-shell/hooks/hooks";
import { useAgentAvatarObjectUrls } from "@/features/agent-shell/hooks/avatar-hooks";
import { useUserAvatarObjectUrls } from "@/features/users/avatar-hooks";
import { AuthorAvatarView, DeletedActorMarker } from "@/components/chat/author-avatar-view";
import { useDirectPairs } from "@/features/direct-pairs/hooks";
import {
  collectCounterpartAvatarSources,
  counterpartFromAgent,
  presentCounterpart,
} from "@/features/direct-pairs/counterpart-presentation";
import { mergeDirectLineRows, type DirectLineRow } from "@/features/direct-pairs/direct-line-rows";
import { channelRowBadge } from "@/features/attention/attention-mode";
import {
  ConversationRowLayout,
  SidebarSection,
  UnreadBadge,
} from "../../../components/layout/sidebar-shared";

export function DirectMessagesGroup(props: {
  /** The open conversation — the ONLY thing that highlights a row here. */
  selectedChannelId: string | null;
  /** The agent whose pre-mint draft pane is open, if any. Nothing about it is
   *  stored: it comes from the route and leaves with it. */
  draftAgentId?: string | null;
  /** Open a pair. Takes no workspace: there is none, and that is the point. */
  onSelectDirectPair: (conversationId: string) => void;
  /** Re-open the draft pane — the transient row's only action. */
  onSelectDirectDraft?: (agentId: string) => void;
}): JSX.Element | null {
  const pairs = useDirectPairs();
  const draftAgentId = props.draftAgentId ?? null;
  // The draft pane already reads this agent (it is the route's subject), so this
  // is a cache hit in practice, not a second fetch for the sidebar's sake.
  const draftAgent = useAgent(draftAgentId).data;
  // The open draft, as the seam takes it. Its counterpart is only the fallback for
  // a line with no pair yet — a merged row wears the pair's.
  const draft = useMemo(
    () =>
      draftAgentId !== null && draftAgent
        ? { agentId: draftAgentId, counterpart: counterpartFromAgent(draftAgent) }
        : null,
    [draftAgentId, draftAgent],
  );
  // Merging, ordering and selection are ONE pure decision (`mergeDirectLineRows`),
  // so this component only paints what it is handed.
  const rows = useMemo(
    () =>
      mergeDirectLineRows({
        pairs,
        draft,
        selectedConversationId: props.selectedChannelId,
      }),
    [pairs, draft, props.selectedChannelId],
  );
  // ONE avatar batch for the section, over the counterpart set of the rows that
  // are actually rendered — the same discipline every author surface follows (a
  // leaf row never fetches its own blob). Deleted counterparts contribute nothing
  // and fetch nothing.
  const { agents, users } = useMemo(() => collectCounterpartAvatarSources(rows), [rows]);
  const agentAvatarUrls = useAgentAvatarObjectUrls(agents);
  const humanAvatarUrls = useUserAvatarObjectUrls(users);

  if (rows.length === 0) return null;

  // Collapsed section, open line: keep that one row, so collapsing never leaves
  // the sidebar with no selection while the pane shows that conversation
  // (`SidebarSection.collapsedContent`, app-layout.md §3). The draft row is the
  // open pane just as much, so it survives collapsing the same way.
  const selectedRow = rows.find((row) => row.selected);

  return (
    <SidebarSection
      label="DIRECT MESSAGES"
      labelClassName="text-[13px] tracking-normal"
      icon={<MessageSquare className="size-3.5" />}
      // The count is the number of lines the section shows, draft included —
      // a count that disagreed with the visible rows would read as a bug.
      count={rows.length}
      collapsible
      defaultExpanded
      persistId="direct-messages"
      collapsedContent={
        selectedRow ? (
          <li>
            <DirectMessageRow
              row={selectedRow}
              agentAvatarUrls={agentAvatarUrls}
              humanAvatarUrls={humanAvatarUrls}
              onSelectDirectPair={props.onSelectDirectPair}
              onSelectDirectDraft={props.onSelectDirectDraft}
            />
          </li>
        ) : null
      }
    >
      {rows.map((row) => (
        <li key={row.key}>
          <DirectMessageRow
            row={row}
            agentAvatarUrls={agentAvatarUrls}
            humanAvatarUrls={humanAvatarUrls}
            onSelectDirectPair={props.onSelectDirectPair}
            onSelectDirectDraft={props.onSelectDirectDraft}
          />
        </li>
      ))}
    </SidebarSection>
  );
}

/** One line's row. The counterpart IS the row: its avatar, its name, and — when the
 *  principal is gone — the same quiet deleted marker a byline shows, which is also
 *  the ONLY on-row explanation for the pane's read-only composer.
 *
 *  A pair and a draft differ in exactly one thing — WHAT opening it navigates to —
 *  so they share one component instead of a second row species with its own
 *  painting. */
function DirectMessageRow({
  row,
  agentAvatarUrls,
  humanAvatarUrls,
  onSelectDirectPair,
  onSelectDirectDraft,
}: {
  row: DirectLineRow;
  agentAvatarUrls: ReadonlyMap<string, string | null>;
  humanAvatarUrls: ReadonlyMap<string, string | null>;
  onSelectDirectPair: (conversationId: string) => void;
  onSelectDirectDraft?: (agentId: string) => void;
}): JSX.Element {
  // The label is also the pane's title, and both must come from the same
  // presentation rule (see `presentCounterpart`) — so the draft row's face and
  // name are already the ones the minted pair will wear.
  const counterpart = presentCounterpart(row.counterpart);
  // A draft has no unread state to have — it has no messages, by construction.
  const badge = channelRowBadge({
    effectiveMode: "all",
    positionalUnread: row.unread,
    directedUnread: 0,
  });

  return (
    <ConversationRowLayout
      selected={row.selected}
      column="outer"
      onSelect={() => {
        // A draft row stays on the draft even when a pair for the same agent
        // exists: that is what makes it one row instead of two.
        if (row.kind === "draft") {
          onSelectDirectDraft?.(row.agentId);
          return;
        }
        onSelectDirectPair(row.conversationId);
      }}
    >
      <div className="flex size-5.5 shrink-0 items-center justify-center">
        <AuthorAvatarView
          avatar={counterpart.avatar}
          size={16}
          label={counterpart.label}
          agentAvatarUrls={agentAvatarUrls}
          humanAvatarUrls={humanAvatarUrls}
        />
      </div>
      <span className="min-w-0 truncate">{counterpart.label}</span>
      {counterpart.isDeleted ? (
        <span className="flex shrink-0 items-center">
          <DeletedActorMarker />
        </span>
      ) : null}
      {badge ? <UnreadBadge count={badge.count} tier={badge.tier} className="ml-auto" /> : null}
    </ConversationRowLayout>
  );
}
