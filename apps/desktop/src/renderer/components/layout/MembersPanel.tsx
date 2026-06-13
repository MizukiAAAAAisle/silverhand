import { Plus, User, Users } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useAgents, useAgentsPresence } from '@/features/agents/hooks';
import { useAgentAvatarObjectUrls } from '@/features/agents/avatar-hooks';
import { CreateAgentDialog } from '@/features/agents/CreateAgentDialog';
import {
  isBackendUnreachable,
  isRegistrationRequired,
  useViewerAvatarObjectUrl,
  useViewerUser,
} from '@/features/me/hooks';
import { useUsers } from '@/features/users/hooks';
import { usePresenceById, presenceDotStatus } from '@/features/presence/hooks';
import { useUserAvatarObjectUrls } from '@/features/users/avatar-hooks';
import { AgentAvatar } from '@/components/AgentAvatar';
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
  const { data: agents = [] } = useAgents();
  const agentAvatarUrls = useAgentAvatarObjectUrls(agents);
  const agentIds = useMemo(() => agents.map(a => a.id), [agents]);
  const agentPresence = useAgentsPresence(agentIds);
  const viewerQuery = useViewerUser();
  const viewerAvatarObjectUrl = useViewerAvatarObjectUrl();
  const viewer =
    viewerQuery.data
    && !isRegistrationRequired(viewerQuery.data)
    && !isBackendUnreachable(viewerQuery.data)
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
            onClick={() => setOpen(true)}
            aria-label="新建 agent"
          >
            <Plus className="size-3.5" />
          </Button>
        }
      >
        {agents.length === 0 ? (
          <li className="px-2 py-2 text-xs text-text-muted">
            还没有 agent。点 + 创建一个。
          </li>
        ) : (
          agents.map(a => (
            <SidebarRow
              key={a.id}
              className="h-[32px]"
              icon={
                <AgentAvatar
                  runtime={a.runtime}
                  size={16}
                  avatarObjectUrl={agentAvatarUrls.get(a.id) ?? null}
                  alt={a.display_name || a.name}
                />
              }
              title={a.display_name || a.name}
              subtitle={<span data-agent-runtime>{a.runtime}</span>}
              status={agentPresence.get(a.id) ?? 'idle'}
              selected={selectedAgentId === a.id}
              onClick={onSelectAgent ? () => onSelectAgent(a.id) : undefined}
            />
          ))
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
 * pixels are theme- and root-font-size-independent. Mirror that here,
 * including the inline-flex wrapper structure so AGENTS / HUMANS rows
 * are pixel-identical regardless of avatar fallback.
 */
function HumanRowIcon({
  avatarObjectUrl,
  alt,
}: {
  avatarObjectUrl: string | null | undefined;
  alt: string;
}): JSX.Element {
  return (
    <span
      className="inline-flex shrink-0 items-center justify-center overflow-hidden rounded-none bg-bg-row-hover"
      style={{ width: 16, height: 16 }}
    >
      {avatarObjectUrl ? (
        <img src={avatarObjectUrl} alt={alt} className="h-full w-full object-cover" />
      ) : (
        // Inner glyph at 10px (≈ 16 × 0.6) — same `size × 0.6` ratio as
        // AgentAvatar's runtime icons, so the visual mass and baseline
        // match across AGENTS / HUMANS rows.
        <User style={{ width: 10, height: 10 }} />
      )}
    </span>
  );
}
