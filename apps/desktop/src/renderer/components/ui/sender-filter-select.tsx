import { useMemo } from 'react';
import * as Select from '@radix-ui/react-select';
import { Bot, ChevronDown, Search as SearchIcon } from 'lucide-react';
import type { AgentDto, UserDto } from '@silverhand/shared';
import { AgentAvatar } from '@/components/AgentAvatar';
import { UserAvatar } from '@/components/UserAvatar';
import { AVATAR_PX } from '@/components/avatar-scale';
import { useAgentAvatarObjectUrls } from '@/features/agents/avatar-hooks';
import { useUserAvatarObjectUrls } from '@/features/users/avatar-hooks';
import {
  FilterSelectItem,
  FILTER_SELECT_TRIGGER_CLASS,
  FILTER_SELECT_CONTENT_CLASS,
} from '@/components/ui/filter-select';
import {
  formatUserDisplayName,
  getCurrentUserId,
  type UserNameResolver,
} from '@/lib/current-user';

/**
 * Shared "filter by sender" dropdown — one control, one item design: Humans
 * (viewer first) then Agents, each row wearing its own identity primitive
 * (`UserAvatar` / `AgentAvatar`). SearchPanel and SavedListView both render
 * through THIS rather than each keeping a private copy (#task:2062; Search had
 * the original, Saved would have been the second).
 *
 * The control does NOT fetch its own options: callers pass `agents` / `users` /
 * `userResolver`. The option domain is a product decision per surface (Saved's
 * comes from the server directory read faces, shiki 2026-08-18 "服务端"), and a
 * self-fetching control would freeze all callers onto one domain — the
 * per-channel actor list in `ChannelAttachmentsPanel` is a THIRD domain, so it
 * deliberately keeps its own value type and is not merged here.
 *
 * Single-select this version (shiki 2026-08-18 "这版先单选"), so the value is one
 * of three shapes and `'all'` is a renderer-only sentinel: on the wire the two
 * scoped shapes become two mutually-exclusive optionals (`user_id` / `agent_id`)
 * and `'all'` sends neither — "no sender filter" and "filtered to someone" stay
 * structurally distinguishable.
 */
export type SenderFilterValue = 'all' | `user:${string}` | `agent:${string}`;

/** Wire params for the selection — `{}` for the "all" sentinel. */
export function parseSenderFilter(value: SenderFilterValue): {
  userId?: string;
  agentId?: string;
} {
  if (value.startsWith('user:')) return { userId: value.slice('user:'.length) };
  if (value.startsWith('agent:')) return { agentId: value.slice('agent:'.length) };
  return {};
}

export function SenderFilterSelect({
  value,
  agents,
  users,
  userResolver,
  onChange,
  ariaLabel = 'Sender filter',
}: {
  value: SenderFilterValue;
  agents: AgentDto[];
  users: UserDto[];
  userResolver: UserNameResolver;
  onChange: (value: SenderFilterValue) => void;
  ariaLabel?: string;
}): JSX.Element {
  const agentAvatarUrls = useAgentAvatarObjectUrls(agents);
  const userAvatarUrls = useUserAvatarObjectUrls(users);
  const selected = senderFilterLabel(
    value,
    agents,
    userResolver,
    agentAvatarUrls,
    userAvatarUrls,
  );
  // Sort humans: viewer always first (when known), then alphabetic by
  // display name so the selector is stable.
  const viewerId = getCurrentUserId();
  const sortedUsers = useMemo(() => {
    const copy = [...users];
    copy.sort((a, b) => {
      if (viewerId && a.id === viewerId) return -1;
      if (viewerId && b.id === viewerId) return 1;
      const left = (a.display_name || a.name).toLowerCase();
      const right = (b.display_name || b.name).toLowerCase();
      return left.localeCompare(right);
    });
    return copy;
  }, [users, viewerId]);

  return (
    <Select.Root value={value} onValueChange={v => onChange(v as SenderFilterValue)}>
      <Select.Trigger aria-label={ariaLabel} className={FILTER_SELECT_TRIGGER_CLASS}>
        <span className="flex min-w-0 items-center gap-1.5">
          {selected.icon}
          <span className="truncate">{selected.label}</span>
        </span>
        <Select.Icon>
          <ChevronDown className="size-3.5 text-text-muted" />
        </Select.Icon>
      </Select.Trigger>
      <Select.Portal>
        <Select.Content
          position="popper"
          sideOffset={4}
          data-dropdown-frame
          className={FILTER_SELECT_CONTENT_CLASS}
        >
          <Select.Viewport className="p-1">
            <FilterSelectItem value="all" icon={<SearchIcon className="size-3.5" />}>
              All senders
            </FilterSelectItem>
            <Select.Group>
              <Select.Label className="px-2 pb-1 pt-2 text-[length:var(--text-badge)] font-semibold uppercase tracking-wider text-text-muted">
                Humans
              </Select.Label>
              {sortedUsers.length === 0 ? (
                // Viewer-less fallback (registration in progress / users
                // endpoint still loading) — still allow the viewer to
                // pick "self" so the filter is usable on first paint.
                <FilterSelectItem
                  value={`user:${viewerId ?? 'self'}`}
                  icon={<UserAvatar size={AVATAR_PX.xs} />}
                >
                  {formatUserDisplayName(viewerId, userResolver)}
                </FilterSelectItem>
              ) : (
                sortedUsers.map(user => (
                  <FilterSelectItem
                    key={user.id}
                    value={`user:${user.id}`}
                    icon={
                      <UserAvatar
                        size={AVATAR_PX.xs}
                        avatarObjectUrl={userAvatarUrls.get(user.id) ?? null}
                        alt={user.display_name || user.name}
                      />
                    }
                    suffix={user.id === viewerId ? 'you' : undefined}
                  >
                    {user.display_name || user.name}
                  </FilterSelectItem>
                ))
              )}
            </Select.Group>
            <Select.Group>
              <Select.Label className="px-2 pb-1 pt-2 text-[length:var(--text-badge)] font-semibold uppercase tracking-wider text-text-muted">
                Agents
              </Select.Label>
              {agents.length === 0 ? (
                <div className="px-2 py-1.5 text-xs italic text-text-muted">
                  No agents
                </div>
              ) : (
                agents.map(agent => (
                  <FilterSelectItem
                    key={agent.id}
                    value={`agent:${agent.id}`}
                    icon={
                      <AgentAvatar
                        runtime={agent.runtime}
                        size={AVATAR_PX.xs}
                        avatarObjectUrl={agentAvatarUrls.get(agent.id) ?? null}
                        alt={agent.display_name?.trim() || agent.name}
                      />
                    }
                    suffix={agent.runtime}
                  >
                    {agent.display_name?.trim() || agent.name}
                  </FilterSelectItem>
                ))
              )}
            </Select.Group>
          </Select.Viewport>
        </Select.Content>
      </Select.Portal>
    </Select.Root>
  );
}

function senderFilterLabel(
  value: SenderFilterValue,
  agents: AgentDto[],
  userResolver: UserNameResolver,
  agentAvatarUrls?: Map<string, string | null>,
  userAvatarUrls?: Map<string, string | null>,
): { label: string; icon: JSX.Element } {
  if (value.startsWith('user:')) {
    const userId = value.slice('user:'.length);
    const label = formatUserDisplayName(userId, userResolver);
    return {
      label,
      icon: (
        <UserAvatar
          size={AVATAR_PX.xs}
          avatarObjectUrl={userAvatarUrls?.get(userId) ?? null}
          alt={label}
        />
      ),
    };
  }
  if (value.startsWith('agent:')) {
    const agentId = value.slice('agent:'.length);
    const agent = agents.find(a => a.id === agentId);
    const label = `@${agent?.display_name?.trim() || agent?.name || agentId}`;
    return {
      label,
      icon: agent ? (
        <AgentAvatar
          runtime={agent.runtime}
          size={AVATAR_PX.xs}
          avatarObjectUrl={agentAvatarUrls?.get(agentId) ?? null}
          alt={label}
        />
      ) : (
        <Bot className="size-3.5" />
      ),
    };
  }
  return { label: 'All senders', icon: <SearchIcon className="size-3.5" /> };
}
