import { DirectorySidebar } from "@/components/layout/directory-shell";
import { Monitor, Plus, User, Users } from "lucide-react";
import { Fragment, useMemo, useState } from "react";
import type { AgentDto, HostDto } from "@silverhand/shared";
import { useAgents, useAgentPresence } from "@/features/agent-shell/hooks/hooks";
import { projectPresence } from "@/features/agent-shell/model/presence-projection";
import { useAgentAvatarObjectUrls } from "@/features/agent-shell/hooks/avatar-hooks";
import { CreateAgentDialog } from "@/features/agent-shell/components/create-agent-dialog";
import { useHostsQuery } from "@/features/computer-shell/hooks/hooks";
import {
  hostDisplayName,
  UNKNOWN_COMPUTER_LABEL,
} from "@/features/computer-shell/model/host-display";
import {
  isBackendUnreachable,
  isRegistrationRequired,
  isUpdateRequired,
  useViewerAvatarObjectUrl,
  useViewerUser,
} from "@/features/session/hooks";
import { useRelatedUsers } from "@/features/users/related-users";
import { usePresenceById, presenceDotStatus } from "@/features/presence/hooks";
import { useUserAvatarObjectUrls } from "@/features/users/avatar-hooks";
import { AgentAvatar } from "@/components/agent-avatar";
import { UserAvatar } from "@/components/user-avatar";
import { AVATAR_PX } from "@/components/avatar-scale";
import { Button } from "@/components/ui/button";
import { CURRENT_USER_SUBTITLE } from "@/features/session/current-user";
import { SidebarRow, SidebarSection } from "@/components/layout/sidebar-shared";

/** HUMANS caps its list here (not counting the pinned viewer row) before the
 *  "Show all" toggle takes over. Above this the roster buries AGENTS; at or
 *  below it the whole list is scannable at a glance. */
const HUMANS_VISIBLE_CAP = 8;

interface AgentSidebarShellProps {
  selectedAgentId?: string | null;
  onSelectAgent?: (id: string) => void;
  selectedUserId?: string | null;
  onSelectUser?: (id: string) => void;
}

export function AgentSidebarShell({
  selectedAgentId,
  onSelectAgent,
  selectedUserId,
  onSelectUser,
}: AgentSidebarShellProps): JSX.Element {
  const [open, setOpen] = useState(false);
  // AGENTS lists only the agents the login user CREATED (#task:1256, shiki
  // option A). The narrowing is defined by the backend `?scope=owned` contract
  // — we pass the flag and never re-filter here, so "my agents" has one
  // definition shared with the CLI and every other consumer.
  const { data: agents = [] } = useAgents({ scope: "owned" });
  const agentAvatarUrls = useAgentAvatarObjectUrls(agents);
  // Rail groups agents by the computer they run on (`agent.host_id`). The
  // name comes from the host DTO via the shared resolver — never from `kind`
  // or provisioning. Computers the viewer no longer owns (deleted / revoked)
  // collapse into one restrained "Unknown computer" group at the end.
  const hostsQuery = useHostsQuery();
  const hostsById = useMemo(
    () => new Map((hostsQuery.data?.hosts ?? []).map((h) => [h.id, h] as const)),
    [hostsQuery.data],
  );
  const agentGroups = useMemo(() => {
    const known = new Map<string, { host: HostDto; agents: AgentDto[] }>();
    const unknown: AgentDto[] = [];
    for (const a of agents) {
      const host = hostsById.get(a.host_id);
      if (host) {
        const group = known.get(host.id);
        if (group) {
          group.agents.push(a);
        } else {
          known.set(host.id, { host, agents: [a] });
        }
      } else {
        unknown.push(a);
      }
    }
    const groups = [...known.values()]
      .map((g) => ({ key: g.host.id, name: hostDisplayName(g.host), agents: g.agents }))
      .sort((a, b) => a.name.localeCompare(b.name));
    if (unknown.length > 0) {
      groups.push({ key: "__unknown__", name: UNKNOWN_COMPUTER_LABEL, agents: unknown });
    }
    return groups;
  }, [agents, hostsById]);
  // Only group once it's meaningful (≥2 computers). A single computer would
  // just add a redundant header, so those agents render flat as before.
  const showGroups = agentGroups.length >= 2;

  const renderAgentRow = (a: AgentDto): JSX.Element => (
    <AgentRow
      key={a.id}
      agent={a}
      avatarObjectUrl={agentAvatarUrls.get(a.id) ?? null}
      selected={selectedAgentId === a.id}
      onSelect={onSelectAgent}
    />
  );
  const viewerQuery = useViewerUser();
  const viewerAvatarObjectUrl = useViewerAvatarObjectUrl();
  const viewer =
    viewerQuery.data &&
    !isRegistrationRequired(viewerQuery.data) &&
    !isBackendUnreachable(viewerQuery.data) &&
    !isUpdateRequired(viewerQuery.data)
      ? viewerQuery.data
      : null;

  const { data: relatedUsers = [] } = useRelatedUsers(viewer?.id ?? null);

  const otherHumans = viewer ? relatedUsers.filter((u) => u.id !== viewer.id) : [];
  const otherAvatarUrls = useUserAvatarObjectUrls(otherHumans);
  const humansCount = (viewer ? 1 : 0) + otherHumans.length;

  const presenceById = usePresenceById();

  // HUMANS can run to dozens (one workspace, everyone the viewer has touched)
  // and would otherwise bury AGENTS under an unbounded list. Cap the list at
  // HUMANS_VISIBLE_CAP and let the viewer expand — the viewer's own row lives
  // in the first slot, so the cap never hides "you". The toggle resets nothing
  // else; it is local view state, not a stored preference like the section's
  // own collapse.
  const [showAllHumans, setShowAllHumans] = useState(false);
  const humansOverflow = otherHumans.length > HUMANS_VISIBLE_CAP;
  const visibleOtherHumans =
    showAllHumans || !humansOverflow ? otherHumans : otherHumans.slice(0, HUMANS_VISIBLE_CAP);

  return (
    <DirectorySidebar>
      <SidebarSection
        label="AGENTS"
        icon={<Users className="size-3.5" />}
        count={agents.length}
        collapsible
        defaultExpanded
        persistId="agent-directory-agents"
        actionAlwaysVisible
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
          <li className="px-2 py-2 text-xs text-text-muted">No agents</li>
        ) : showGroups ? (
          agentGroups.map((group) => (
            <Fragment key={group.key}>
              <li
                data-agent-group-header
                className="flex items-center gap-1.5 px-2 pb-0.5 pt-2 text-(length:--text-meta) font-medium text-text-muted"
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

      <SidebarSection
        label="HUMANS"
        icon={<User className="size-3.5" />}
        count={humansCount}
        collapsible
        defaultExpanded
        persistId="agent-directory-humans"
      >
        {viewer ? (
          <SidebarRow
            key={viewer.id}
            className="h-8"
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
            onClick={onSelectUser ? () => onSelectUser(viewer.id) : undefined}
          />
        ) : null}
        {visibleOtherHumans.map((u) => {
          const avatarObjectUrl = otherAvatarUrls.get(u.id) ?? null;
          return (
            <SidebarRow
              key={u.id}
              className="h-8"
              icon={
                <HumanRowIcon avatarObjectUrl={avatarObjectUrl} alt={u.display_name || u.name} />
              }
              title={u.display_name || u.name}
              subtitle={<span className="font-mono">@{u.name}</span>}
              status={presenceDotStatus(presenceById.get(u.id)?.presence)}
              selected={selectedUserId === u.id}
              onClick={onSelectUser ? () => onSelectUser(u.id) : undefined}
            />
          );
        })}
        {humansOverflow ? (
          <li>
            <button
              type="button"
              onClick={() => setShowAllHumans((prev) => !prev)}
              className="flex w-full items-center px-2 py-1 text-xs font-medium text-text-muted transition-colors hover:text-text-primary"
            >
              {showAllHumans ? "Show fewer" : `Show all ${humansCount}`}
            </button>
          </li>
        ) : null}
        {!viewer && otherHumans.length === 0 ? (
          <li className="px-2 py-2 text-xs text-text-muted">No humans</li>
        ) : null}
      </SidebarSection>

      <CreateAgentDialog open={open} onOpenChange={setOpen} />
    </DirectorySidebar>
  );
}

function AgentRow({
  agent,
  avatarObjectUrl,
  selected,
  onSelect,
}: {
  agent: AgentDto;
  avatarObjectUrl: string | null;
  selected: boolean;
  onSelect?: (id: string) => void;
}): JSX.Element {
  const presence = useAgentPresence(agent.id);

  const display = presence === null ? null : projectPresence({ scope: "global", presence });
  return (
    <SidebarRow
      className="h-8"
      icon={
        <AgentAvatar
          runtime={agent.runtime}
          size={AVATAR_PX.xs}
          avatarObjectUrl={avatarObjectUrl}
          alt={agent.display_name || agent.name}
        />
      }
      title={agent.display_name || agent.name}
      // Runtime rendered as a CHIP, not bare grey text: an agent's subtitle
      // (codex / claude) and a human's subtitle (@handle) were the same muted
      // small text, so the two entity kinds read as one list. The chip gives
      // the agent row a shape the human row does not have; the fill stays very
      // faint (`--chip-bg`) so it reads as a quiet ground, not a badge.
      subtitle={
        <span
          data-agent-runtime
          className="rounded-(--chip-radius) bg-(--chip-bg) px-1 py-px text-(length:--text-badge) font-medium uppercase tracking-wide text-text-muted"
        >
          {agent.runtime}
        </span>
      }
      // A row always carries a status dot so the column reads consistently:
      // online (green), crashed (red), and every other state (idle / away /
      // offline) the shared muted "idle" dot. Only an unsettled read (`null`)
      // draws nothing.
      status={
        display === null
          ? null
          : display.tone === "online"
            ? "active"
            : display.tone === "failed"
              ? "crashed"
              : "idle"
      }
      selected={selected}
      onClick={onSelect ? () => onSelect(agent.id) : undefined}
    />
  );
}

function HumanRowIcon({
  avatarObjectUrl,
  alt,
}: {
  avatarObjectUrl: string | null | undefined;
  alt: string;
}): JSX.Element {
  return <UserAvatar size={AVATAR_PX.xs} avatarObjectUrl={avatarObjectUrl} alt={alt} />;
}
