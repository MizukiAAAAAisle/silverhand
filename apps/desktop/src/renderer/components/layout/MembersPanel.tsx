import { Monitor, Plus, User, Users } from 'lucide-react';
import { Fragment, useMemo, useState } from 'react';
import type { AgentDto, HostDto } from '@silverhand/shared';
import { useAgents } from '@/features/agents/hooks';
import { useAgentAvatarObjectUrls } from '@/features/agents/avatar-hooks';
import { CreateAgentDialog } from '@/features/agents/CreateAgentDialog';
import { useAgentOnlineByHost, useHostsQuery } from '@/features/hosts/hooks';
import {
  hostDisplayName,
  UNKNOWN_COMPUTER_LABEL,
} from '@/features/hosts/host-display';
import {
  isBackendUnreachable,
  isRegistrationRequired,
  isUpdateRequired,
  useViewerAvatarObjectUrl,
  useViewerUser,
} from '@/features/me/hooks';
import { useUsers } from '@/features/users/hooks';
import { usePresenceById, presenceDotStatus } from '@/features/presence/hooks';
import { useUserAvatarObjectUrls } from '@/features/users/avatar-hooks';
import { AgentAvatar } from '@/components/AgentAvatar';
import { UserAvatar } from '@/components/UserAvatar';
import { AVATAR_PX } from '@/components/avatar-scale';
import { Button } from '@/components/ui/button';
import { CURRENT_USER_SUBTITLE } from '@/lib/current-user';
import { SidebarRow, SidebarSection } from './sidebar-shared';

interface MembersPanelProps {
  selectedAgentId?: string | null;
  onSelectAgent?: (id: string) => void;
  /** Currently focused human-id in the right pane (`/members/u/:id`).
   *  Used to highlight the corresponding HUMANS row. */
  selectedUserId?: string | null;
  /** Click handler for HUMANS rows. Wired to `nav.toMembersUser(id)` in
   *  the App. When omitted the rows render but aren't clickable —
   *  matches the pre-#314 behaviour for surfaces that just want the
   *  list. */
  onSelectUser?: (id: string) => void;
}

export function MembersPanel({
  selectedAgentId,
  onSelectAgent,
  selectedUserId,
  onSelectUser,
}: MembersPanelProps): JSX.Element {
  const [open, setOpen] = useState(false);
  // AGENTS lists only the agents the login user CREATED (#task:1256, shiki
  // option A). The narrowing is defined by the backend `?scope=owned` contract
  // — we pass the flag and never re-filter here, so "my agents" has one
  // definition shared with the CLI and every other consumer.
  const { data: agents = [] } = useAgents({ scope: 'owned' });
  const agentAvatarUrls = useAgentAvatarObjectUrls(agents);
  // Rail groups agents by the computer they run on (`agent.host_id`). The
  // name comes from the host DTO via the shared resolver — never from `kind`
  // or provisioning. Computers the viewer no longer owns (deleted / revoked)
  // collapse into one restrained "Unknown computer" group at the end.
  const hostsQuery = useHostsQuery();
  const hostsById = useMemo(
    () => new Map((hostsQuery.data?.hosts ?? []).map(h => [h.id, h] as const)),
    [hostsQuery.data],
  );
  // Rail dot = whether the agent's daemon runtime is live on its computer,
  // read from that computer's `/status.agents[].online` (host live status) —
  // NOT the conversation `/runtime-state`, which only reports mid-turn
  // activity and shows a chattable daemon agent as offline (#task:1361).
  const agentHostIds = useMemo(
    () => [...new Set(agents.map(a => a.host_id).filter(id => hostsById.has(id)))],
    [agents, hostsById],
  );
  const agentOnline = useAgentOnlineByHost(agentHostIds);
  const agentGroups = useMemo(() => {
    const known = new Map<string, { host: HostDto; agents: AgentDto[] }>();
    const unknown: AgentDto[] = [];
    for (const a of agents) {
      const host = hostsById.get(a.host_id);
      if (host) {
        const group = known.get(host.id);
        if (group) group.agents.push(a);
        else known.set(host.id, { host, agents: [a] });
      } else {
        unknown.push(a);
      }
    }
    const groups = [...known.values()]
      .map(g => ({ key: g.host.id, name: hostDisplayName(g.host), agents: g.agents }))
      .sort((a, b) => a.name.localeCompare(b.name));
    if (unknown.length > 0) {
      groups.push({ key: '__unknown__', name: UNKNOWN_COMPUTER_LABEL, agents: unknown });
    }
    return groups;
  }, [agents, hostsById]);
  // Only group once it's meaningful (≥2 computers). A single computer would
  // just add a redundant header, so those agents render flat as before.
  const showGroups = agentGroups.length >= 2;

  const renderAgentRow = (a: AgentDto): JSX.Element => (
    <SidebarRow
      key={a.id}
      className="h-[32px]"
      icon={
        <AgentAvatar
          runtime={a.runtime}
          size={AVATAR_PX.xs}
          avatarObjectUrl={agentAvatarUrls.get(a.id) ?? null}
          alt={a.display_name || a.name}
        />
      }
      title={a.display_name || a.name}
      subtitle={<span data-agent-runtime>{a.runtime}</span>}
      status={agentOnline.get(a.id) ? 'active' : 'idle'}
      selected={selectedAgentId === a.id}
      onClick={onSelectAgent ? () => onSelectAgent(a.id) : undefined}
    />
  );
  const viewerQuery = useViewerUser();
  const viewerAvatarObjectUrl = useViewerAvatarObjectUrl();
  const viewer =
    viewerQuery.data
    && !isRegistrationRequired(viewerQuery.data)
    && !isBackendUnreachable(viewerQuery.data) && !isUpdateRequired(viewerQuery.data)
      ? viewerQuery.data
      : null;
  // Multi-human audit 2026-06-03 #task:857 P0.6: HUMANS is the global
  // people directory (per shiki D3: "允许的, 这样更加方便拉人协作"). The
  // viewer is always first; other humans follow. Until /api/users
  // hydrates we fall back to just the viewer so the section is never
  // empty for a signed-in install.
  const { data: allUsers = [] } = useUsers();
  // Other humans = directory minus viewer. Stable ordering: the server
  // returns alphabetized-by-name; we preserve that.
  const otherHumans = viewer
    ? allUsers.filter(u => u.id !== viewer.id)
    : allUsers;
  const otherAvatarUrls = useUserAvatarObjectUrls(otherHumans);
  const humansCount = (viewer ? 1 : 0) + otherHumans.length;
  // Human online/offline pip — online → green `active`, offline/unknown →
  // muted `idle`, reusing the AGENTS dot vocabulary. Cache kept live by
  // usePresenceSync() in the app shell. See docs/human-presence-v1.md.
  const presenceById = usePresenceById();

  return (
    <>
      <SidebarSection
        label="AGENTS"
        icon={<Users className="size-3.5" />}
        count={agents.length}
        action={
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6"
            onClick={() => setOpen(true)}
            aria-label="New agent"
          >
            <Plus className="size-3.5" />
          </Button>
        }
      >
        {agents.length === 0 ? (
          <li className="px-2 py-2 text-xs text-text-muted">
            No agents yet. Use + to create one.
          </li>
        ) : showGroups ? (
          agentGroups.map(group => (
            <Fragment key={group.key}>
              <li
                data-agent-group-header
                className="flex items-center gap-1.5 px-2 pb-0.5 pt-2 text-[length:var(--text-meta)] font-medium text-text-muted"
              >
                <Monitor className="size-3 shrink-0" />
                <span className="truncate">{group.name}</span>
              </li>
              {group.agents.map(renderAgentRow)}
            </Fragment>
          ))
        ) : (
          agents.map(renderAgentRow)
        )}
      </SidebarSection>

      <SidebarSection label="HUMANS" icon={<User className="size-3.5" />} count={humansCount}>
        {viewer ? (
          <SidebarRow
            key={viewer.id}
            className="h-[32px]"
            icon={
              <HumanRowIcon
                avatarObjectUrl={viewerAvatarObjectUrl}
                alt={viewer.display_name || viewer.name}
              />
            }
            title={viewer.display_name || viewer.name}
            subtitle={CURRENT_USER_SUBTITLE}
            status={presenceDotStatus(presenceById.get(viewer.id)?.presence)}
            selected={selectedUserId === viewer.id}
            onClick={
              onSelectUser ? () => onSelectUser(viewer.id) : undefined
            }
          />
        ) : null}
        {otherHumans.map(u => {
          const avatarObjectUrl = otherAvatarUrls.get(u.id) ?? null;
          return (
            <SidebarRow
              key={u.id}
              className="h-[32px]"
              icon={
                <HumanRowIcon
                  avatarObjectUrl={avatarObjectUrl}
                  alt={u.display_name || u.name}
                />
              }
              title={u.display_name || u.name}
              subtitle={`@${u.name}`}
              status={presenceDotStatus(presenceById.get(u.id)?.presence)}
              selected={selectedUserId === u.id}
              onClick={onSelectUser ? () => onSelectUser(u.id) : undefined}
            />
          );
        })}
        {!viewer && otherHumans.length === 0 ? (
          <li className="px-2 py-2 text-xs text-text-muted">
            No human registered yet.
          </li>
        ) : null}
      </SidebarSection>

      <CreateAgentDialog open={open} onOpenChange={setOpen} />
    </>
  );
}

/**
 * 16×16 frame for human rows. Both AGENTS and HUMANS rows pass this
 * size; MembersPanel targets a 32px-tall row (icon 16 + py-1.5 / 12 +
 * border 4) for IM-sidebar density (#task:912 review round 5 — earlier
 * the rows had mismatched icons + ran 36-38.5px tall, which read as
 * "settings list" rather than "Slack sidebar").
 *
 * **Why literal px instead of `size-4`**: the desktop app pins
 * `html { font-size: 14px }` (global.css), so Tailwind's `size-4`
 * (`1rem`) would compute to 14px, not 16px. AgentAvatar uses an inline
 * `style={{ width: size, height: size }}` for the same reason — literal
 * pixels are theme- and root-font-size-independent. `UserAvatar` takes
 * the same px `size`, which is why this row can just use it (#task:1699;
 * the local copy this replaced had drifted onto `bg-bg-row-hover`, a
 * class `@theme` never generated, so the fallback square had no ground
 * at all).
 */
function HumanRowIcon({
  avatarObjectUrl,
  alt,
}: {
  avatarObjectUrl: string | null | undefined;
  alt: string;
}): JSX.Element {
  return (
    <UserAvatar size={AVATAR_PX.xs} avatarObjectUrl={avatarObjectUrl} alt={alt} />
  );
}
