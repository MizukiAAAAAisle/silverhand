import { useEffect, useState } from 'react';
import {
  Activity,
  CalendarClock,
  FolderTree,
  Lock,
  User,
} from 'lucide-react';
import type {
  AgentDto,
  AgentRuntimeConversation,
  AgentRuntimeStateDto,
} from '@silverhand/shared';
import { cn } from '@/lib/cn';
import { AgentAvatar } from '@/components/AgentAvatar';
import { AVATAR_PX } from '@/components/avatar-scale';
import { SidePanelHeader } from '@/components/layout/SidePanelHeader';
import { AgentHeader } from './AgentHeader';
import { AgentProfileCard } from './AgentProfileCard';
import { AgentSchedulesCard } from './AgentSchedulesCard';
import { AgentWorkspaceContainer, AgentWorkspacePane } from './AgentWorkspacePane';
import { AgentMcpPane } from './AgentMcpPane';
import { AgentActivityPane } from './AgentActivityPane';
import { AgentActivityTimeline } from './AgentActivityTimeline';
import { AgentSidebar, type AgentSection } from './AgentSidebar';
import {
  useAgent,
  useAgentRuntimeState,
} from './hooks';
import { canManageAgentSchedules, canViewAgentFiles } from './permissions';
import { useAgentAvatarObjectUrl } from './avatar-hooks';
import { isBackendUnreachable, isUpdateRequired, useViewerUser } from '@/features/me/hooks';

const SECTION_STORAGE_KEY = 'silverhand:layout.agent-section';
const VALID_SECTIONS: ReadonlyArray<AgentSection> = [
  'profile',
  'workspace',
  'mcp',
  'activity',
  'schedules',
];

function readSection(): AgentSection {
  try {
    const raw = localStorage.getItem(SECTION_STORAGE_KEY);
    if (raw && (VALID_SECTIONS as readonly string[]).includes(raw)) {
      return raw as AgentSection;
    }
  } catch {
    /* private mode / quota — fall back to default */
  }
  return 'profile';
}

export type AgentViewVariant = 'full' | 'side';

interface AgentViewProps {
  agentId: string;
  /** Called after a successful delete so the parent can navigate
   *  away (back to channels, typically). */
  onDeleted: () => void;
  /** Click "Open" on a conversation row → switch the main view to that
   *  channel/thread. Optional: if not provided, the column is
   *  still shown but rows aren't actionable. */
  onOpenConversation?: (s: AgentRuntimeConversation) => void;
  /** `full` (default) = the members-section page with the vertical section
   *  rail + hero header. `side` = the compact right-pane panel docked beside
   *  a channel (#task:1189): horizontal tabs, no hero chrome, Activity locked
   *  to the docked channel. Same data/content components, two layout shells. */
  variant?: AgentViewVariant;
  /** side only: the conversation the panel is docked beside. The Activity
   *  tab locks to this channel (no roster picker) — that's the dual-screen
   *  "watch this channel's agent activity" use case (A, shiki #task:1189). */
  contextConversationId?: string | null;
  /** side only: the workspace the docked channel belongs to. The Workspace tab
   *  scopes to this workspace's L2 memory (#task:1191). A DM/agent-home id
   *  resolves back to the agent home dir on the backend — no frontend branch. */
  contextWorkspaceId?: string | null;
  /** side only: close the panel (the × button). */
  onClose?: () => void;
}

export function AgentView({
  agentId,
  onDeleted,
  onOpenConversation,
  variant = 'full',
  contextConversationId = null,
  contextWorkspaceId = null,
  onClose,
}: AgentViewProps): JSX.Element {
  const agentQuery = useAgent(agentId);
  const runtimeQuery = useAgentRuntimeState(agentId);
  const viewerQuery = useViewerUser();

  // Selected section persists globally (not per-agent) so the user
  // doesn't have to re-pick after switching agents — the more common
  // case is repeatedly viewing the same section across different agents.
  const [section, setSection] = useState<AgentSection>(() => readSection());
  const agentForPermissions = agentQuery.data;
  const viewerForPermissions =
    viewerQuery.data && !isBackendUnreachable(viewerQuery.data) && !isUpdateRequired(viewerQuery.data)
      ? viewerQuery.data
      : undefined;
  const scheduleAccessKnown = Boolean(agentForPermissions && viewerForPermissions);
  const canManageSchedules = agentForPermissions && viewerForPermissions
    ? canManageAgentSchedules(viewerForPermissions, agentForPermissions)
    : false;
  // Agent workspace files (L1 home + L2 workspace memory) are owner-private —
  // mirror the backend owner gate so non-owners get a neutral private state and
  // we never fire the doomed tree/file requests (#task:1220 / #task:1219).
  const fileAccessKnown = Boolean(agentForPermissions && viewerForPermissions);
  const canViewFiles = agentForPermissions && viewerForPermissions
    ? canViewAgentFiles(viewerForPermissions, agentForPermissions)
    : false;

  useEffect(() => {
    try {
      localStorage.setItem(SECTION_STORAGE_KEY, section);
    } catch {
      /* ignore */
    }
  }, [section]);

  if (agentQuery.isLoading) {
    return variant === 'side' ? (
      <SidePanelShell onClose={onClose}>
        <div className="flex flex-1 items-center justify-center text-sm text-text-muted">
          Loading agent…
        </div>
      </SidePanelShell>
    ) : (
      <main
        className="flex h-full flex-1 items-center justify-center bg-bg-base text-sm text-text-muted"
        style={{
          borderRadius: 'var(--card-radius, 0)',
          boxShadow: 'var(--card-shadow, none)',
          overflow: 'hidden',
        }}
      >
        Loading agent…
      </main>
    );
  }
  if (agentQuery.isError || !agentQuery.data) {
    return variant === 'side' ? (
      <SidePanelShell onClose={onClose}>
        <div className="flex flex-1 items-center justify-center text-sm text-text-muted">
          Agent not found.
        </div>
      </SidePanelShell>
    ) : (
      <main
        className="flex h-full flex-1 items-center justify-center bg-bg-base text-sm text-text-muted"
        style={{
          borderRadius: 'var(--card-radius, 0)',
          boxShadow: 'var(--card-shadow, none)',
          overflow: 'hidden',
        }}
      >
        Agent not found.
      </main>
    );
  }

  const agent = agentQuery.data;

  if (variant === 'side') {
    return (
      <AgentSidePanel
        agent={agent}
        runtimeState={runtimeQuery.data}
        canManageSchedules={canManageSchedules}
        scheduleAccessKnown={scheduleAccessKnown}
        canViewFiles={canViewFiles}
        fileAccessKnown={fileAccessKnown}
        contextConversationId={contextConversationId}
        contextWorkspaceId={contextWorkspaceId}
        onClose={onClose}
      />
    );
  }

  return (
    <main
      className="flex h-full flex-1 flex-col overflow-hidden bg-bg-base"
      style={{
        borderRadius: 'var(--card-radius, 0)',
        boxShadow: 'var(--card-shadow, none)',
      }}
    >
      <AgentHeader
        agent={agent}
        runtimeState={runtimeQuery.data}
        onDeleted={onDeleted}
      />

      <div className="flex min-h-0 flex-1">
        <AgentSidebar active={section} onChange={setSection} />

        <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
          {section === 'workspace' ? (
            // Workspace pane manages its own scrolling — file tree and
            // preview each scroll internally. The outer column must NOT
            // add a vertical scrollbar of its own (would defeat the
            // two-internal-scroll design and chop the pane off below
            // the fold). #task:812.
            <div className="flex min-h-0 flex-1 flex-col px-8 py-6">
              {canViewFiles ? (
                <AgentWorkspacePane
                  agentId={agent.id}
                />
              ) : (
                <AgentWorkspaceFilesPermissionState loading={!fileAccessKnown} />
              )}
            </div>
          ) : section === 'activity' ? (
            // Activity is a master-detail surface (conversation rail +
            // per-conversation timeline) that owns its own two scroll
            // regions — like the workspace pane, no outer padding/scroll.
            <AgentActivityPane
              agentId={agent.id}
              state={runtimeQuery.data}
              onOpenConversation={onOpenConversation}
            />
          ) : (
            // Reserve scrollbar width only for profile editing; MCP and
            // schedules retain their full width.
            <div
              className={cn(
                'flex-1 overflow-y-auto',
                section === 'profile' && '[scrollbar-gutter:stable]',
              )}
            >
              <div className="px-8 py-6">
                {section === 'profile' ? (
                  <AgentProfileCard agent={agent} />
                ) : null}
                {section === 'mcp' ? (
                  <AgentMcpPane agentId={agent.id} runtime={agent.runtime} />
                ) : null}
                {section === 'schedules' ? (
                  canManageSchedules ? (
                    <AgentSchedulesCard agentId={agent.id} />
                  ) : (
                    <AgentSchedulesPermissionState
                      loading={!scheduleAccessKnown}
                    />
                  )
                ) : null}
              </div>
            </div>
          )}
        </div>
      </div>
    </main>
  );
}

// ── side-panel variant (#task:1189) ─────────────────────────────────────────

const SIDE_SECTION_STORAGE_KEY = 'silverhand:layout.agent-side-section';

interface SideSectionItem {
  id: 'activity' | 'workspace' | 'profile' | 'schedules';
  label: string;
  icon: typeof Activity;
}

// Activity is first because the dock's whole reason to exist is watching a
// channel's activity beside the chat (shiki #task:1189). Workspace shows the
// current workspace's L2 memory in a compact single-column form (#task:1191) —
// the wide two-column file browser lives on the full members page; it sits after
// Profile (shiki). MCP (raw config) stays full-page-only: a wide power-user
// surface that doesn't belong in a narrow dock.
const SIDE_SECTIONS: ReadonlyArray<SideSectionItem> = [
  { id: 'activity', label: 'Activity', icon: Activity },
  { id: 'profile', label: 'Profile', icon: User },
  { id: 'workspace', label: 'Workspace', icon: FolderTree },
  { id: 'schedules', label: 'Schedules', icon: CalendarClock },
];

function readSideSection(): SideSectionItem['id'] {
  try {
    const raw = localStorage.getItem(SIDE_SECTION_STORAGE_KEY);
    if (
      raw === 'activity' ||
      raw === 'workspace' ||
      raw === 'profile' ||
      raw === 'schedules'
    ) {
      return raw;
    }
  } catch {
    /* private mode / quota — fall back to default */
  }
  return 'activity';
}

/** Event that redirects an ALREADY-mounted docked agent panel to a section.
 *  The fresh-open / different-agent cases remount and read the section from
 *  localStorage on mount; this event only covers "the panel already sits on
 *  this agent but another tab". Carries `agentId` so a panel showing a
 *  different agent ignores it. */
const AGENT_SIDE_SECTION_FOCUS_EVENT = 'silverhand:agent-side-section-focus';

interface AgentSideSectionFocusDetail {
  agentId: string;
  section: SideSectionItem['id'];
}

/**
 * Open-intent for the docked agent panel's section. Persists the choice as the
 * SoT — so the next reopen honors it too, keeping the sticky section in sync
 * with an explicit jump (cross-panel contract, #task:1539) — AND signals any
 * already-mounted panel for `agentId` to switch reactively. Call it right
 * before `openAgentPanel(agentId)` when a caller must land on a specific tab
 * (e.g. the Activity bubble → Activity), regardless of the last-used tab.
 */
export function focusAgentSideSection(
  agentId: string,
  section: SideSectionItem['id'],
): void {
  try {
    localStorage.setItem(SIDE_SECTION_STORAGE_KEY, section);
  } catch {
    /* private mode / quota — the reactive event still fires */
  }
  window.dispatchEvent(
    new CustomEvent<AgentSideSectionFocusDetail>(AGENT_SIDE_SECTION_FOCUS_EVENT, {
      detail: { agentId, section },
    }),
  );
}

/**
 * Bare panel chrome (header + close) used by the side variant's loading /
 * error states so they still read as a dockable panel, not a full page.
 */
function SidePanelShell({
  header,
  onClose,
  children,
}: {
  /** Identity content rendered at the START of the fixed-height header row
   *  (avatar + name/description). Omitted for the loading / error states,
   *  which show only the close affordance. */
  header?: React.ReactNode;
  onClose?: () => void;
  children: React.ReactNode;
}): JSX.Element {
  return (
    <section
      className="flex h-full min-h-0 flex-1 flex-col overflow-hidden bg-bg-chat"
      style={{
        borderRadius: 'var(--card-radius, 0)',
        boxShadow: 'var(--card-shadow, none)',
      }}
    >
      {/* Header row is the shared `SidePanelHeader` (components/layout), so the
          agent panel's height is locked to the channel header's `h-12` (48px)
          structurally — the same row every side panel (thread / threads /
          attachments) flows through. This is what closed the old 51px drift
          (shiki 2026-07-21). Only the card `<section>` frame is panel-specific.
          `header` (avatar + name/description) is omitted for the loading / error
          states, which show only the close affordance. */}
      <SidePanelHeader onClose={onClose}>{header}</SidePanelHeader>
      <div className="flex min-h-0 flex-1 flex-col">{children}</div>
    </section>
  );
}

/**
 * Compact agent panel for the chat-section right pane. Same content components
 * as the full page (`AgentProfileCard` / `AgentSchedulesCard` / the Activity
 * timeline) — only the shell differs: a slim identity header (avatar, name,
 * description, × close), a horizontal tab bar (Activity / Profile / Workspace /
 * Schedules), and an Activity tab locked to the docked channel (no roster
 * picker). One content layer, two layout shells — so a future change to a
 * section lands in both at once.
 */
function AgentSidePanel({
  agent,
  runtimeState,
  canManageSchedules,
  scheduleAccessKnown,
  canViewFiles,
  fileAccessKnown,
  contextConversationId,
  contextWorkspaceId,
  onClose,
}: {
  agent: AgentDto;
  runtimeState: AgentRuntimeStateDto | undefined;
  canManageSchedules: boolean;
  scheduleAccessKnown: boolean;
  canViewFiles: boolean;
  fileAccessKnown: boolean;
  contextConversationId: string | null;
  contextWorkspaceId: string | null;
  onClose?: () => void;
}): JSX.Element {
  const [section, setSection] = useState<SideSectionItem['id']>(() =>
    readSideSection(),
  );
  useEffect(() => {
    try {
      localStorage.setItem(SIDE_SECTION_STORAGE_KEY, section);
    } catch {
      /* ignore */
    }
  }, [section]);
  // Honor a `focusAgentSideSection` jump when this panel is ALREADY mounted for
  // the target agent (closed / different-agent opens remount and read the
  // section on mount instead). Keeps "click a bubble agent → Activity"
  // converging even when the panel already sits on another tab.
  useEffect(() => {
    const onFocus = (e: Event): void => {
      const detail = (e as CustomEvent<AgentSideSectionFocusDetail>).detail;
      if (detail && detail.agentId === agent.id) setSection(detail.section);
    };
    window.addEventListener(AGENT_SIDE_SECTION_FOCUS_EVENT, onFocus);
    return () =>
      window.removeEventListener(AGENT_SIDE_SECTION_FOCUS_EVENT, onFocus);
  }, [agent.id]);

  const avatarObjectUrl = useAgentAvatarObjectUrl(agent.avatar_url);

  // A=Activity-follows-channel membership gate (#task:1189, Cindy P2): the
  // per-(agent, conversation) activity endpoint is membership-gated, so blindly
  // mounting the timeline for a channel the agent isn't in renders the backend
  // 404 as "Couldn't load activity." — a network-error look for a benign
  // "not in this channel" state. The runtime roster already lists every
  // conversation the agent belongs to, so check it first and show a light empty
  // state instead. `undefined` runtime = not loaded yet → neutral, not absent.
  const runtimeLoaded = runtimeState !== undefined;
  const inThisChannel =
    contextConversationId !== null &&
    (runtimeState?.conversation_agents ?? []).some(
      r => r.conversation_id === contextConversationId,
    );

  return (
    <SidePanelShell
      onClose={onClose}
      header={
        <>
          <AgentAvatar
            runtime={agent.runtime}
            size={AVATAR_PX.md}
            avatarObjectUrl={avatarObjectUrl}
            alt={agent.display_name || agent.name}
          />
          <div className="min-w-0 flex-1 overflow-hidden">
            {/* line 1: handle + description on one line. The handle stays intact
                (`shrink-0`); the description takes the remaining width and
                ellipsis-truncates on overflow (shiki). Two-line block height is
                fixed regardless of description length. */}
            <div className="flex items-baseline gap-1.5">
              <span className="shrink-0 text-[13px] font-semibold leading-tight text-text-primary">
                {agent.display_name || agent.name}
              </span>
              {agent.description ? (
                <span
                  className="min-w-0 flex-1 truncate text-[12px] font-normal leading-tight text-text-muted"
                  title={agent.description}
                >
                  {agent.description}
                </span>
              ) : null}
            </div>
            <p className="truncate text-[11px] capitalize leading-tight text-text-muted">
              {agent.runtime}
              {agent.model ? ` · ${agent.model}` : ''}
            </p>
          </div>
        </>
      }
    >
      {/* horizontal tab bar. Quiet selection (mirrors AgentSidebar's "not a
          primary nav surface" stance): ink underline + bolder text only, no
          fill — the forza6 ink-fill reversal is reserved for sidebar `#`
          identity selection, a section tab doesn't borrow it. No
          `transition-colors` on the active flip (it's a discrete committed
          state, #task:1162); hover tint is the only animated affordance. */}
      <nav
        role="tablist"
        aria-label="Agent panel sections"
        className="flex shrink-0 items-center gap-1 border-b border-border-subtle px-2"
      >
        {SIDE_SECTIONS.map(tab => {
          const selected = tab.id === section;
          const Icon = tab.icon;
          return (
            <button
              key={tab.id}
              type="button"
              role="tab"
              aria-selected={selected}
              onClick={() => setSection(tab.id)}
              className={cn(
                'flex items-center gap-1.5 border-b-2 px-2.5 py-2 text-[12px] -mb-px',
                selected
                  ? 'border-text-primary font-medium text-text-primary'
                  : 'border-transparent text-text-muted hover:text-text-secondary',
              )}
            >
              <Icon className="size-3.5" strokeWidth={selected ? 2.25 : 2} />
              {tab.label}
            </button>
          );
        })}
      </nav>

      {/* content */}
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        {section === 'activity' ? (
          !contextConversationId ? (
            <div className="flex flex-1 items-center justify-center px-6 text-center text-xs text-text-muted">
              Open a channel to see this agent's activity there.
            </div>
          ) : !runtimeLoaded ? (
            <p className="py-8 text-center text-xs text-text-muted">Loading…</p>
          ) : !inThisChannel ? (
            <div className="flex flex-1 items-center justify-center px-6 text-center text-xs text-text-muted">
              {agent.display_name || agent.name} is not in this channel.
            </div>
          ) : (
            <div className="flex min-h-0 flex-1 flex-col">
              <AgentActivityTimeline
                key={contextConversationId}
                conversationId={contextConversationId}
                agentId={agent.id}
              />
            </div>
          )
        ) : section === 'workspace' ? (
          // Current workspace's L2 memory in compact form (#task:1191). The
          // container manages its own scroll, so no padded wrapper. A
          // DM/agent-home context resolves to the agent home dir on the backend
          // (expected overlap) — no frontend branch, and the copy stays neutral
          // about which files appear (it may include system_prompt.md in a DM).
          // Owner-private: non-owners get the neutral state, no requests fire
          // (#task:1220).
          canViewFiles ? (
            <div className="flex min-h-0 flex-1 flex-col">
              <AgentWorkspaceContainer
                // Key by source so switching workspace remounts with fresh
                // selection — a path picked under workspace A never transiently
                // fetches under B (Cindy #task:1191 P1).
                key={contextWorkspaceId ?? 'home'}
                agentId={agent.id}
                source={
                  contextWorkspaceId
                    ? { kind: 'workspace', workspaceId: contextWorkspaceId }
                    : { kind: 'home' }
                }
                layout="compact"
                header={null}
              />
            </div>
          ) : (
            <div className="flex-1 overflow-y-auto px-4 py-4">
              <AgentWorkspaceFilesPermissionState loading={!fileAccessKnown} />
            </div>
          )
        ) : section === 'profile' ? (
          <div className="flex-1 overflow-y-auto px-4 py-4 [scrollbar-gutter:stable]">
            <AgentProfileCard agent={agent} />
          </div>
        ) : canManageSchedules ? (
          <div className="flex-1 overflow-y-auto px-4 py-4">
            <AgentSchedulesCard agentId={agent.id} />
          </div>
        ) : (
          <div className="flex-1 overflow-y-auto px-4 py-4">
            <AgentSchedulesPermissionState loading={!scheduleAccessKnown} />
          </div>
        )}
      </div>
    </SidePanelShell>
  );
}

function AgentSchedulesPermissionState({
  loading,
}: {
  loading: boolean;
}): JSX.Element {
  if (loading) {
    return (
      <div className="py-10 text-center text-sm text-text-muted">
        Loading schedule permissions…
      </div>
    );
  }

  return (
    <div
      data-panel-card="placeholder"
      className="flex flex-col items-center gap-2 border border-border-subtle bg-bg-floating/50 px-4 py-10 text-center"
    >
      <Lock className="size-6 text-text-muted" />
      <p className="max-w-md text-sm text-text-primary">
        Schedules are private to this agent's owner.
      </p>
    </div>
  );
}

function AgentWorkspaceFilesPermissionState({
  loading,
}: {
  loading: boolean;
}): JSX.Element {
  if (loading) {
    return (
      <div className="py-10 text-center text-sm text-text-muted">
        Loading file permissions…
      </div>
    );
  }

  return (
    <div
      data-panel-card="placeholder"
      className="flex flex-col items-center gap-2 border border-border-subtle bg-bg-floating/50 px-4 py-10 text-center"
    >
      <Lock className="size-6 text-text-muted" />
      <p className="max-w-md text-sm text-text-primary">
        Agent workspace files are private to this agent's owner.
      </p>
    </div>
  );
}
