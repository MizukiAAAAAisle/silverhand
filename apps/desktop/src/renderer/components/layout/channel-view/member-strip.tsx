import { useMemo } from 'react';
import type {
  AgentDto,
  ConversationAgentDto,
  HumanMemberDto,
  MemberDto,
} from '@silverhand/shared';
import { AgentAvatar } from '@/components/AgentAvatar';
import { UserAvatar } from '@/components/UserAvatar';
import { AVATAR_PX } from '@/components/avatar-scale';
import { AgentInfoPopover } from '@/components/AgentInfoPopover';
import { HumanInfoPopover } from '@/components/HumanInfoPopover';
import { useAgents } from '@/features/agents/hooks';
import { useUserAvatarObjectUrls } from '@/features/users/avatar-hooks';
import { useUsersById } from '@/features/users/hooks';
import { usePresenceById, presenceDotStatus } from '@/features/presence/hooks';
import {
  isBackendUnreachable,
  isRegistrationRequired,
  useViewerUser,
} from '@/features/me/hooks';
import { useConversationMembers } from '@/features/conversations/useConversationMembers';

// ── Member strip ────────────────────────────────────────────────────────

/** Maximum number of chips rendered inline; overflow collapses into a
 *  `+N` chip that opens the members modal. Header height must not jitter as
 *  channels grow membership, so this cap exists even though current channels
 *  rarely exceed it. */
const MEMBER_STRIP_VISIBLE_CAP = 8;

export function MemberStrip({
  channelId,
  conversationAgents,
  agentAvatarUrls,
  onOpenMembers,
}: {
  channelId: string;
  conversationAgents: ConversationAgentDto[];
  agentAvatarUrls: Map<string, string | null>;
  /** Open the channel members modal — the `+N` chip's action (#task:1687). */
  onOpenMembers: () => void;
}): JSX.Element | null {
  const { data: agents = [] } = useAgents();
  const agentById = useMemo(() => {
    const m = new Map<string, AgentDto>();
    for (const a of agents) m.set(a.id, a);
    return m;
  }, [agents]);
  const conversationAgentById = useMemo(() => {
    const m = new Map<string, ConversationAgentDto>();
    for (const ca of conversationAgents) m.set(ca.agent_id, ca);
    return m;
  }, [conversationAgents]);

  // Members come from the same backend source-of-truth that the
  // platform prompt's "Channel members:" block renders, so
  // chips and prompt can never drift. Self-filter is the renderer's
  // job: the *current human viewer* is dropped here. Agent self has no
  // UI meaning for chips and is intentionally not filtered.
  const membersResult = useConversationMembers(channelId);
  const { data: viewer } = useViewerUser();
  const viewerUserId = viewer && !isRegistrationRequired(viewer) && !isBackendUnreachable(viewer) ? viewer.id : null;

  const visibleMembers = useMemo(() => {
    if (membersResult.status !== 'resolved') return [];
    return membersResult.members.filter(m => {
      if (m.kind !== 'human') return true;
      // Drop the current viewer — UI-self has no meaning in a chip strip
      // pointing at "who else is in this room with me".
      return m.user_id !== viewerUserId;
    });
  }, [membersResult, viewerUserId]);

  // Resolve avatars for the human members so HumanMemberChip can render real
  // images instead of letter placeholders. Prefer the conversation member's
  // denormalized avatar URL, and fall back to the global users directory for
  // older responses while mixed builds are still possible.
  const usersById = useUsersById();
  const humanAvatarSources = useMemo(
    () =>
      visibleMembers
        .filter((m): m is Extract<MemberDto, { kind: 'human' }> => m.kind === 'human')
        .map(m => ({
          id: m.user_id,
          avatar_url: m.avatar_url ?? usersById.get(m.user_id)?.avatar_url ?? null,
        })),
    [visibleMembers, usersById],
  );
  const humanMemberAvatarUrls = useUserAvatarObjectUrls(humanAvatarSources);

  // An empty room renders nothing: the header is identity, not a place for a
  // status line, and the adjacent add-member control already says what to do
  // (shiki, 2026-07-26 "直接去掉").
  if (visibleMembers.length === 0) return null;

  const inline = visibleMembers.slice(0, MEMBER_STRIP_VISIBLE_CAP);
  const overflow = visibleMembers.slice(MEMBER_STRIP_VISIBLE_CAP);

  return (
    <div
      className="flex shrink-0 items-center gap-1.5"
      data-member-strip
      data-member-count={visibleMembers.length}
    >
      {inline.map(member => {
        if (member.kind === 'agent') {
          const agent = agentById.get(member.agent_id);
          if (!agent) return null;
          const ca = conversationAgentById.get(member.agent_id);
          // No conversation_agents row → agent is in `conversation_users`-style
          // membership but never spawned in this conversation. Render
          // a faint dot (idle) so the chip stays uniform shape.
          const status: ConversationAgentDto['status'] = ca?.status ?? 'idle';
          return (
            <AgentInfoPopover
              key={`agent:${member.agent_id}`}
              agent={agent}
              conversationId={channelId}
              trigger="hover"
              side="bottom"
              align="end"
              avatarObjectUrl={agentAvatarUrls.get(agent.id) ?? null}
            >
              <button
                type="button"
                aria-label={`@${agent.name}`}
                data-member-chip="agent"
                data-member-id={member.agent_id}
                className="relative inline-flex size-6 shrink-0 items-center justify-center rounded-none border border-border-subtle bg-bg-floating p-0 transition-transform hover:scale-105 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-focus"
              >
                <AgentAvatar
                  runtime={agent.runtime}
                  size={AVATAR_PX.sm}
                  avatarObjectUrl={agentAvatarUrls.get(agent.id) ?? null}
                  alt={agent.display_name || agent.name}
                />
                <span
                  className={
                    'pointer-events-none absolute bottom-0 right-0 size-2 translate-x-1/2 translate-y-1/2 rounded-full border border-bg-floating shadow-sm '
                    + STATUS_DOT[status]
                  }
                />
              </button>
            </AgentInfoPopover>
          );
        }
        return (
          <HumanMemberChip
            key={`human:${member.user_id}`}
            human={member}
            avatarObjectUrl={humanMemberAvatarUrls.get(member.user_id) ?? null}
          />
        );
      })}
      {overflow.length > 0 ? (
        <MemberOverflowChip
          overflow={overflow}
          totalVisible={visibleMembers.length}
          onOpenMembers={onOpenMembers}
        />
      ) : null}
    </div>
  );
}

/**
 * Human chip — same footprint as the agent chip (24px square). Renders
 * the human's actual avatar when the parent has resolved one and falls back to
 * `UserAvatar`'s neutral person square when no avatar is available yet. Hover
 * popover mirrors `HumanMention`'s content so inline `@handle` mentions and
 * header chips read the same.
 */
function HumanMemberChip({
  human,
  avatarObjectUrl,
}: {
  human: HumanMemberDto;
  avatarObjectUrl: string | null;
}): JSX.Element {
  const presence = usePresenceById().get(human.user_id);
  const dot = presenceDotStatus(presence?.presence);
  return (
    <HumanInfoPopover
      human={human}
      userId={human.user_id}
      trigger="hover"
      side="bottom"
      align="end"
      avatarObjectUrl={avatarObjectUrl}
    >
      <button
        type="button"
        aria-label={`@${human.name}`}
        data-member-chip="human"
        data-member-id={human.user_id}
        // No `overflow-hidden` here (unlike a naive avatar box): the status
        // dot below is positioned half-outside the bottom-right corner
        // (translate-x/y-1/2), and clipping the button would cut it off — the
        // exact bug where the human online badge was occluded but the agent's
        // (whose button never clipped) showed fine. The square `rounded-none`
        // img already fills the box exactly via object-cover, so nothing needs
        // clipping. Mirrors the agent chip above.
        data-avatar-ground
        className="relative inline-flex size-6 shrink-0 items-center justify-center rounded-none border border-border-subtle p-0 transition-transform hover:scale-105 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-focus"
      >
        {avatarObjectUrl ? (
          // eslint-disable-next-line jsx-a11y/img-redundant-alt
          <img
            src={avatarObjectUrl}
            alt=""
            className="size-full object-cover"
            draggable={false}
          />
        ) : (
          // Neutral person glyph, never the display-name initial: a letter is a
          // second identity system next to the images and glyphs every other
          // avatar in the app uses, and it is not even identifying — everyone
          // whose name starts with the same letter gets the same chip
          // (#task:1700). `UserAvatar` owns the recipe (ground + glyph ratio),
          // so the fallback here can't drift from the members list.
          <UserAvatar size={AVATAR_PX.sm} />
        )}
        <span
          className={
            'pointer-events-none absolute bottom-0 right-0 size-2 translate-x-1/2 translate-y-1/2 rounded-full border border-bg-floating shadow-sm '
            + STATUS_DOT[dot]
          }
        />
      </button>
    </HumanInfoPopover>
  );
}

/**
 * `+N` overflow chip. Clicking it opens the channel members modal, which is
 * now the one place that lists the whole roster (#task:1687) — the hover
 * popover that used to preview the collapsed members is gone: it duplicated a
 * list the modal owns, and a hover-only preview could not carry the row actions
 * (remove / leave) the modal does. Individual chips keep their hover identity
 * cards.
 */
function MemberOverflowChip({
  overflow,
  totalVisible,
  onOpenMembers,
}: {
  overflow: MemberDto[];
  totalVisible: number;
  onOpenMembers: () => void;
}): JSX.Element {
  return (
    <button
      type="button"
      onClick={onOpenMembers}
      aria-label={`+${overflow.length} more members`}
      title="Members"
      data-member-chip="overflow"
      data-member-total={totalVisible}
      data-avatar-ground
      className="inline-flex size-6 shrink-0 items-center justify-center rounded-none border border-border-subtle p-0 text-[10px] font-semibold text-text-muted transition-transform hover:scale-105 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-focus"
    >
      +{overflow.length}
    </button>
  );
}

/** Presence/run-state dot ground, keyed by the agent run status (humans map
 *  their presence onto the same two of these via `presenceDotStatus`). Exported
 *  because the members modal expresses the SAME state on the SAME dot — one
 *  recipe, two surfaces; the modal dropped its status column precisely because
 *  this dot already says it (shiki, #task:1687). */
export const STATUS_DOT: Record<ConversationAgentDto['status'], string> = {
  active: 'bg-success',
  starting: 'bg-warning',
  crashed: 'bg-error',
  idle: 'bg-text-muted/50',
};
