import { useMemo } from 'react';
import type {
  AgentDto,
  ConversationAgentDto,
  HumanMemberDto,
  MemberDto,
} from '@silverhand/shared';
import { AgentAvatar } from '@/components/AgentAvatar';
import { AVATAR_PX } from '@/components/avatar-scale';
import { AgentInfoPopover } from '@/components/AgentInfoPopover';
import { HumanInfoPopover } from '@/components/HumanInfoPopover';
import { HoverPopover } from '@/components/chat/HoverPopover';
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
 *  `+N` chip whose hover popover lists the remaining members. Header
 *  height must not jitter as channels grow membership, so this cap
 *  exists even though current channels rarely exceed it. */
const MEMBER_STRIP_VISIBLE_CAP = 8;

export function MemberStrip({
  channelId,
  conversationAgents,
  agentAvatarUrls,
}: {
  channelId: string;
  conversationAgents: ConversationAgentDto[];
  agentAvatarUrls: Map<string, string | null>;
}): JSX.Element {
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

  // Empty-state: no agents AND no other humans. Keep the original copy
  // when only the agent side is empty (the strip's pre-PR-C contract).
  if (visibleMembers.length === 0 && conversationAgents.length === 0) {
    return (
      <span className="shrink-0 text-[10px] italic text-text-muted">
        Channel 还没有成员
      </span>
    );
  }

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
        />
      ) : null}
    </div>
  );
}

/**
 * Human chip — same footprint as the agent chip (24px square). Renders
 * the human's actual avatar when the parent has resolved one and falls back to
 * the display-name initial when no avatar is available yet. Hover popover
 * mirrors `HumanMention`'s content so inline `@handle` mentions and header
 * chips read the same.
 */
function HumanMemberChip({
  human,
  avatarObjectUrl,
}: {
  human: HumanMemberDto;
  avatarObjectUrl: string | null;
}): JSX.Element {
  const label = human.display_name?.trim() || human.name;
  const initial = label.charAt(0).toUpperCase();
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
        className="relative inline-flex size-6 shrink-0 items-center justify-center rounded-none border border-border-subtle bg-bg-elevated p-0 text-xs font-medium text-text-muted transition-transform hover:scale-105 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-focus"
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
          <span aria-hidden>{initial}</span>
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
 * `+N` overflow chip. Hover opens a popover listing the collapsed
 * members so the cap doesn't hide the room. Click is a no-op (v1):
 * the design rejects navigation from chips, and a dedicated members
 * panel/route is out of scope here.
 */
function MemberOverflowChip({
  overflow,
  totalVisible,
}: {
  overflow: MemberDto[];
  totalVisible: number;
}): JSX.Element {
  const trigger = (
    <button
      type="button"
      aria-label={`+${overflow.length} more members`}
      data-member-chip="overflow"
      className="inline-flex size-6 shrink-0 items-center justify-center rounded-none border border-border-subtle bg-bg-elevated p-0 text-[10px] font-semibold text-text-muted transition-transform hover:scale-105 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-focus"
    >
      +{overflow.length}
    </button>
  );
  return (
    <HoverPopover
      trigger={trigger}
      isContentReady
      openDelayMs={80}
      content={
        <div
          className="flex flex-col gap-2"
          data-member-overflow-list
          data-member-total={totalVisible}
        >
          <div className="text-[11px] uppercase tracking-wider text-text-muted">
            +{overflow.length} more
          </div>
          {overflow.map(m => {
            const id = m.kind === 'agent' ? m.agent_id : m.user_id;
            const label = m.display_name?.trim() || m.name;
            return (
              <div
                key={`${m.kind}:${id}`}
                className="flex items-center gap-2"
                data-member-overflow-row
                data-member-id={id}
                data-member-kind={m.kind}
              >
                <span className="truncate text-sm text-text-primary">
                  {label}
                </span>
                <span className="truncate font-mono text-xs text-text-muted">
                  @{m.name}
                </span>
              </div>
            );
          })}
        </div>
      }
    />
  );
}

const STATUS_DOT: Record<ConversationAgentDto['status'], string> = {
  active: 'bg-success',
  starting: 'bg-warning',
  crashed: 'bg-error',
  idle: 'bg-text-muted/50',
};
