import { useMemo } from 'react';
import { MessageSquare } from 'lucide-react';
import type { DirectPairListItem } from '@silverhand/shared';
import { useAgentAvatarObjectUrls } from '@/features/agents/avatar-hooks';
import { useUserAvatarObjectUrls } from '@/features/users/avatar-hooks';
import {
  AuthorAvatarView,
  DeletedActorMarker,
} from '@/components/chat/author-avatar-view';
import { useDirectPairs } from '@/features/direct-pairs/hooks';
import {
  collectCounterpartAvatarSources,
  presentCounterpart,
  type CounterpartPresentation,
} from '@/features/direct-pairs/counterpart-presentation';
import { channelRowBadge } from '@/lib/attention-mode';
import { conversationSelectionTier } from '@/lib/rail-selection';
import { ConversationRowLayout, SidebarSection, UnreadBadge } from './sidebar-shared';

/**
 * The sidebar's DIRECT MESSAGES section — the viewer's `direct_pair`
 * conversations (#task:2035).
 *
 * WHY IT IS ITS OWN SECTION, not a row species inside the rail tree: every rail
 * group is keyed by a container (a workspace or an agent home), and a
 * `direct_pair` has no container — it is placed by its two ENDPOINTS. Rendering it
 * under some workspace would require inventing a parent, and inventing one is
 * exactly the bug this whole ticket fixes (the pane then opens the conversation
 * under a workspace it does not belong to).
 *
 * ORDER is the server's (`created_at`, oldest first) and there is no sort menu or
 * drag: viewer sort is a per-`list_key` ordering state keyed by container lists,
 * and this list has no entry in it. A sort axis here would be a new stored
 * concept, not a widget.
 *
 * BADGE: a pair is unconditionally loud, exactly like a `dm_channel` — the
 * attention-modes batch joins `conversation_users AND roster_policy='open'`, so a
 * fixed-roster placement has no tier row and never will. That verdict is passed as
 * a literal `'all'` to the SHARED `channelRowBadge` rather than the number being
 * painted directly, so the count's rendering (tier, threshold) stays one
 * implementation with every other row (#task:1875).
 *
 * Self-contained like STARRED: it owns its read model, its avatar batch and its
 * label resolution, so the parent passes only the selection and the navigation
 * handler. Renders nothing when empty — a viewer with no open lines sees no
 * section, and per @shiki's ruling this list never pre-lists agents that could be
 * messaged (the agent's own page is that entrance).
 */
export function DirectMessagesGroup(props: {
  /** The open conversation — the ONLY thing that highlights a row here. */
  selectedChannelId: string | null;
  /** Open a pair. Takes no workspace: there is none, and that is the point. */
  onSelectDirectPair: (conversationId: string) => void;
}): JSX.Element | null {
  const pairs = useDirectPairs();
  // ONE avatar batch for the section, over the counterpart set — the same
  // discipline every author surface follows (a leaf row never fetches its own
  // blob). Deleted counterparts contribute nothing and fetch nothing.
  const { agents, users } = useMemo(
    () => collectCounterpartAvatarSources(pairs),
    [pairs],
  );
  const agentAvatarUrls = useAgentAvatarObjectUrls(agents);
  const humanAvatarUrls = useUserAvatarObjectUrls(users);
  // Resolve every label once, here: the label is also the pane's title, and both
  // must come from the same presentation rule (see `presentCounterpart`).
  const rows = useMemo(
    () =>
      pairs.map(pair => ({
        pair,
        counterpart: presentCounterpart(pair.counterpart),
      })),
    [pairs],
  );

  if (rows.length === 0) return null;

  // Collapsed section, open pair: keep that one row, so collapsing never leaves
  // the sidebar with no selection while the pane shows that conversation
  // (`SidebarSection.collapsedContent`, app-layout.md §3).
  const selectedRow = props.selectedChannelId
    ? rows.find(r => r.pair.conversation_id === props.selectedChannelId)
    : undefined;

  return (
    <SidebarSection
      label="DIRECT MESSAGES"
      icon={<MessageSquare className="size-3.5" />}
      count={rows.length}
      collapsible
      defaultExpanded
      persistId="direct-messages"
      collapsedContent={
        selectedRow ? (
          <li>
            <DirectPairRow
              pair={selectedRow.pair}
              counterpart={selectedRow.counterpart}
              selectedChannelId={props.selectedChannelId}
              agentAvatarUrls={agentAvatarUrls}
              humanAvatarUrls={humanAvatarUrls}
              onSelect={props.onSelectDirectPair}
            />
          </li>
        ) : null
      }
    >
      {rows.map(({ pair, counterpart }) => (
        <li key={pair.conversation_id}>
          <DirectPairRow
            pair={pair}
            counterpart={counterpart}
            selectedChannelId={props.selectedChannelId}
            agentAvatarUrls={agentAvatarUrls}
            humanAvatarUrls={humanAvatarUrls}
            onSelect={props.onSelectDirectPair}
          />
        </li>
      ))}
    </SidebarSection>
  );
}

/** One pair row. The counterpart IS the row: its avatar, its name, and — when the
 *  principal is gone — the same quiet deleted marker a byline shows, which is also
 *  the ONLY on-row explanation for the pane's read-only composer. */
function DirectPairRow({
  pair,
  counterpart,
  selectedChannelId,
  agentAvatarUrls,
  humanAvatarUrls,
  onSelect,
}: {
  pair: DirectPairListItem;
  counterpart: CounterpartPresentation;
  selectedChannelId: string | null;
  agentAvatarUrls: ReadonlyMap<string, string | null>;
  humanAvatarUrls: ReadonlyMap<string, string | null>;
  onSelect: (conversationId: string) => void;
}): JSX.Element {
  const isPrimary =
    conversationSelectionTier(pair.conversation_id, selectedChannelId) === 'primary';
  const badge = channelRowBadge({
    effectiveMode: 'all',
    positionalUnread: pair.unread_count,
    directedUnread: 0,
  });

  return (
    <ConversationRowLayout
      selected={isPrimary}
      // The section IS this row's parent, so it sits on the outer glyph column —
      // flush with STARRED's rows and the workspace containers, like every row
      // whose parent is a section rather than a workspace.
      column="outer"
      onSelect={() => onSelect(pair.conversation_id)}
    >
      <AuthorAvatarView
        avatar={counterpart.avatar}
        size={16}
        label={counterpart.label}
        agentAvatarUrls={agentAvatarUrls}
        humanAvatarUrls={humanAvatarUrls}
      />
      <span className="min-w-0 truncate">{counterpart.label}</span>
      {counterpart.isDeleted ? (
        <span className="flex shrink-0 items-center">
          <DeletedActorMarker />
        </span>
      ) : null}
      {badge ? (
        <UnreadBadge count={badge.count} tier={badge.tier} className="ml-auto" />
      ) : null}
    </ConversationRowLayout>
  );
}
