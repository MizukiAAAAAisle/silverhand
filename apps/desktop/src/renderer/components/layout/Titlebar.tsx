import { Settings, MessageSquarePlus, Users, CheckSquare } from 'lucide-react';
import type { ChannelKind } from '@silverhand/shared';
import { ManageMembersPopover } from '@/features/workspaces/ManageMembersPopover';

interface TitlebarProps {
  channelId: string | null;
  channelName: string | null;
  channelKind: ChannelKind | null;
  workspacePath: string | null;
  /** epoch ms when the channel was archived; null for active channels.
   *  Drives the inline `Archived` pill so the user knows why this
   *  channel is missing from the main sidebar list. */
  channelArchivedAt: number | null;
  onOpenChannelSettings?: () => void;
  onCreateSession?: () => void;
  /** Tasks panel trigger. Provided only when a chat channel is selected.
   *  Click opens the channel-wide tasks dialog (4-column kanban). */
  onOpenTasks?: () => void;
  /** Active-task count for the channel — drives the small badge next to
   *  the Tasks button. Hidden when 0 / undefined. */
  taskCount?: number;
}

/**
 * Window-wide titlebar — drag region with the current channel's name,
 * its primary actions (Settings, Manage Members, New Session), and the
 * workspace path right-aligned with rtl ellipsis so the path tail
 * stays visible. Channel info starts at `--sidebar-width` so it sits
 * directly above the SessionsSidebar column it describes (the leftmost
 * Sidebar column gets an empty drag area that also doubles as the
 * macOS traffic-lights inset). Spans the full window so it doubles as
 * the native title bar (`titleBarStyle: 'hiddenInset'` on macOS — see
 * main/index.ts).
 */
export function Titlebar({
  channelId,
  channelName,
  channelKind,
  workspacePath,
  channelArchivedAt,
  onOpenChannelSettings,
  onCreateSession,
  onOpenTasks,
  taskCount,
}: TitlebarProps): JSX.Element {
  const hasChannel = channelName !== null;
  const showManageMembers = hasChannel && channelKind !== 'dm' && !!channelId;
  const showCreateSession = hasChannel && !!onCreateSession;
  const showSettings = hasChannel && !!onOpenChannelSettings;
  const showTasks = hasChannel && !!onOpenTasks;
  const isArchived = channelArchivedAt !== null;

  return (
    <header
      className={
        'drag-region flex h-[var(--titlebar-height)] shrink-0 items-center ' +
        'gap-2 border-b border-border-subtle bg-bg-primary text-xs'
      }
    >
      {/* Spacer matches the leftmost NavRail + channels Sidebar so the
        * channel info that follows lines up with the SessionsSidebar
        * boundary. The macOS traffic-lights sit inside this region. */}
      <div className="w-[calc(var(--nav-rail-width)+var(--sidebar-width))] shrink-0" />

      <span className="truncate font-serif text-sm font-semibold text-text-primary">
        {hasChannel ? channelName : '—'}
        {channelKind === 'dm' && hasChannel ? (
          <span className="ml-1 text-text-muted">· DM</span>
        ) : null}
      </span>

      {isArchived ? (
        <span className="rounded-full bg-bg-elevated px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-text-muted">
          archived
        </span>
      ) : null}

      {showCreateSession ? (
        <button
          type="button"
          onClick={onCreateSession}
          aria-label="新建 Channel"
          title="新建 Channel"
          className="no-drag flex size-6 items-center justify-center rounded text-text-muted hover:bg-bg-hover hover:text-text-primary"
        >
          <MessageSquarePlus className="size-3.5" />
        </button>
      ) : null}

      {showTasks ? (
        <button
          type="button"
          onClick={onOpenTasks}
          aria-label="Tasks"
          title="Tasks"
          className="no-drag relative flex size-6 items-center justify-center rounded text-text-muted hover:bg-bg-hover hover:text-text-primary"
        >
          <CheckSquare className="size-3.5" />
          {taskCount && taskCount > 0 ? (
            <span className="absolute -right-1 -top-1 min-w-[14px] rounded-full bg-accent px-1 text-[9px] font-medium leading-[14px] text-text-on-accent">
              {taskCount}
            </span>
          ) : null}
        </button>
      ) : null}

      {showManageMembers ? (
        <ManageMembersPopover channelId={channelId!}>
          <button
            type="button"
            aria-label="管理成员"
            title="管理成员"
            className="no-drag flex size-6 items-center justify-center rounded text-text-muted hover:bg-bg-hover hover:text-text-primary"
          >
            <Users className="size-3.5" />
          </button>
        </ManageMembersPopover>
      ) : null}

      {showSettings ? (
          <button
            type="button"
            onClick={onOpenChannelSettings}
          aria-label="Workspace 设置"
          title="Workspace 设置"
          className="no-drag flex size-6 items-center justify-center rounded text-text-muted hover:bg-bg-hover hover:text-text-primary"
        >
          <Settings className="size-3.5" />
        </button>
      ) : null}

      {/* Workspace path sits inline right after the action icons —
        * not pushed to the far right. rtl ellipsis preserves the path
        * tail (the most useful segment) when space runs out. The bare
        * span is itself a drag handle since it lives in the .drag-region
        * header without an explicit .no-drag opt-out. */}
      {workspacePath ? (
        <div className="min-w-0 max-w-[40%] truncate text-text-muted">
          <span title={workspacePath} dir="rtl">
            {workspacePath}
          </span>
        </div>
      ) : null}

      {/* Trailing spacer keeps a small breathable margin at the right
        * edge of the window. */}
      <div className="ml-auto w-3 shrink-0" />
    </header>
  );
}
