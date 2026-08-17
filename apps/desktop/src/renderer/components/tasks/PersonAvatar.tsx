import { useMemo } from 'react';
import { User } from 'lucide-react';
import type { AgentDto } from '@silverhand/shared';
import { AgentAvatar } from '@/components/AgentAvatar';
import { UserAvatar } from '@/components/UserAvatar';
import { AVATAR_PX, type AvatarSize } from '@/components/avatar-scale';
import { useAgents } from '@/features/agents/hooks';
import { useAgentAvatarObjectUrls } from '@/features/agents/avatar-hooks';
import { useUsersById } from '@/features/users/hooks';
import { useUserAvatarObjectUrls } from '@/features/users/avatar-hooks';
import type { PersonRef } from '@/features/tasks/taskFilters';

/** The directory + resolved object URLs a {@link PersonAvatar} needs. Resolved
 *  ONCE per surface (see {@link usePersonDirectory}) and passed down, so a
 *  surface with several people on screen doesn't re-resolve per row. */
export interface PersonDirectory {
  agentsById: ReadonlyMap<string, AgentDto>;
  agentAvatarUrls: ReadonlyMap<string, string | null>;
  userAvatarUrls: ReadonlyMap<string, string | null>;
}

/**
 * A task person's avatar — the same identity primitives as everywhere else
 * (agent → runtime-tinted `AgentAvatar`, human → neutral `UserAvatar`), sized to
 * the `xs` (16px) meta-row scale. Falls back to the generic person glyph if an
 * agent id isn't in the directory (e.g. a deleted agent still on old tasks), so
 * a row never renders a broken avatar (shiki #task:1441).
 *
 * Shared by the board's Assignee / From dropdowns and the detail modal's
 * metadata sidebar: one entity, one component. A second copy would be a second
 * answer to "what does this person look like".
 */
export function PersonAvatar({
  person,
  name,
  size = 'xs',
  agentsById,
  agentAvatarUrls,
  userAvatarUrls,
}: {
  person: PersonRef;
  name: string;
  /** Surface density tier (default `xs`, the meta-row scale). The board-scope
   *  filter TRIGGER passes `chip` (14px) so a selected direct line's counterpart
   *  avatar sits height-uniform with the sibling filter glyphs and never drifts
   *  taller than the control row (#task:1437 / #task:2041). */
  size?: AvatarSize;
} & PersonDirectory): JSX.Element {
  const px = AVATAR_PX[size];
  if (person.type === 'agent') {
    const runtime = agentsById.get(person.id)?.runtime;
    if (runtime) {
      return (
        <AgentAvatar
          runtime={runtime}
          size={px}
          avatarObjectUrl={agentAvatarUrls.get(person.id) ?? null}
          alt={name}
        />
      );
    }
    return <User size={px} className="shrink-0 text-text-muted" />;
  }
  return (
    <UserAvatar
      size={px}
      avatarObjectUrl={userAvatarUrls.get(person.id) ?? null}
      alt={name}
    />
  );
}

/**
 * Resolve the agent + user directories and their avatar object URLs for a
 * surface that renders people. Both `AgentDto` and `UserDto` expose
 * `{id, avatar_url}` and the batch hooks session-cache by url, so this is cheap
 * — but it must stay at the SURFACE, never inside `PersonAvatar`: a leaf that
 * fetched its own avatar would issue one request per row.
 */
export function usePersonDirectory(): PersonDirectory {
  const { data: agents = [] } = useAgents();
  const agentsById = useMemo<ReadonlyMap<string, AgentDto>>(
    () => new Map(agents.map(a => [a.id, a])),
    [agents],
  );
  const agentAvatarUrls = useAgentAvatarObjectUrls(agents);
  const usersById = useUsersById();
  const userList = useMemo(() => [...usersById.values()], [usersById]);
  const userAvatarUrls = useUserAvatarObjectUrls(userList);
  return { agentsById, agentAvatarUrls, userAvatarUrls };
}
