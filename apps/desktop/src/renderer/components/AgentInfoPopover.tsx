import * as Popover from '@radix-ui/react-popover';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { AlertTriangle, Eraser, Power, RefreshCw, UserMinus } from 'lucide-react';
import type { AgentDto, ConversationAgentStatus } from '@silverhand/shared';
import {
  useChannelAgents,
  useChannelAgentRuntime,
  useClearAgentSession,
  useRemoveAgentFromChannel,
  useStartAgent,
  useStopAgent,
} from '@/features/channels/hooks';
import {
  canEditAgentProfile,
  canRemoveAgentFromChannel,
} from '@/features/agents/permissions';
import { useConversationById } from '@/features/conversations/useConversationById';
import { useWorkspaceMemberLists } from '@/features/workspaces/hooks';
import { useAgentAvatarObjectUrl } from '@/features/agents/avatar-hooks';
import {
  isBackendUnreachable,
  isUpdateRequired,
  useViewerUser,
} from '@/features/me/hooks';
import { Button } from '@/components/ui/button';
import {
  destructiveAction,
  destructiveCancel,
} from '@/features/common/DestructiveAction';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { AgentAvatar } from './AgentAvatar';
import { AVATAR_PX } from './avatar-scale';

interface AgentInfoPopoverProps {
  agent: AgentDto;
  /** The element that triggers the popover (rendered via Radix
   *  `asChild`). */
  children: ReactNode;
  side?: 'top' | 'bottom' | 'left' | 'right';
  align?: 'start' | 'center' | 'end';
  /** When set, looks up the agent's per-conversation status to render an
   *  IM-style presence line + (when crashed) a retry action. */
  conversationId?: string | null;
  /** `'click'` (default) opens on click for standalone controls.
   *  `'hover'` opens on pointer-enter and
   *  closes on pointer-leave with a small grace window so the user
   *  can move into the popover content. Used by inline mention pills,
   *  message author/avatar controls, and the member strip. */
  trigger?: 'click' | 'hover';
  /**
   * Avatar object URL resolved by the parent's batch hook.
   *
   * - `undefined` (omitted) — caller is a standalone surface with no
   *   batch context (settings page, dev tools); fall back to an internal
   *   single-agent `useAgentAvatarObjectUrl` so the popover still shows
   *   the right image.
   * - `null` — parent looked it up and the agent has no avatar (or it
   *   is still loading); render the runtime tint, no fetch.
   * - `string` — use the parent's blob URL directly.
   *
   * Required for high-frequency render sites (timeline message authors,
   * inline `@mentions`, header member chips). Without it, every popover
   * instance would fire its own GET — which destroys the batch-hook
   * contract. PR-2 review caught this and made the prop the canonical
   * path for those callers.
   */
  avatarObjectUrl?: string | null;
}

const HOVER_OPEN_DELAY_MS = 80;
const HOVER_CLOSE_DELAY_MS = 120;

/**
 * Compact agent info card. Shows avatar, display name + handle,
 * runtime/model, presence (per-conversation), and an optional retry
 * affordance when the agent has crashed in this conversation.
 *
 * Two trigger modes: click (standalone controls) and hover
 * (inline mentions, message author/avatar, and member strip in conversation header). Hover mode is implemented via
 * controlled `open` rather than a separate Radix HoverCard primitive
 * to keep the dep surface narrow.
 *
 * Single visual contract — the same card renders on every surface
 * (header member chip, message stream avatar/author, inline @mention).
 * Per-conversation management actions render in the top-right when the
 * viewer can edit the agent and a `conversationId` is provided; that
 * gating is internal to `AgentManagementActions`. There is no per-call
 * `management` switch (#task:912 review round 8 — the user noted that
 * the chip and the message-stream popover should not diverge).
 */
export function AgentInfoPopover({
  agent,
  children,
  side = 'bottom',
  align = 'start',
  conversationId,
  trigger = 'click',
  avatarObjectUrl,
}: AgentInfoPopoverProps): JSX.Element {
  const [hoverOpen, setHoverOpen] = useState(false);
  const [managementDialogOpen, setManagementDialogOpen] = useState(false);
  // Fallback only when the caller is unbatched (`undefined`). The
  // explicit `null` case from a batched parent means "no avatar yet"
  // and must NOT trigger an internal fetch — that was the PR-2 review
  // blocker (every timeline popover otherwise re-fetched per instance).
  // `useAgentAvatarObjectUrl` short-circuits on null input, so passing
  // `null` here is a deliberate no-fetch path.
  const fallbackAvatarObjectUrl = useAgentAvatarObjectUrl(
    avatarObjectUrl === undefined ? agent.avatar_url : null,
  );
  const resolvedAvatarObjectUrl =
    avatarObjectUrl === undefined ? fallbackAvatarObjectUrl : avatarObjectUrl;
  // Single timer reused for both open and close so consecutive
  // pointer transitions cancel each other out cleanly.
  const timerRef = useRef<number | null>(null);
  const clearTimer = (): void => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  };
  useEffect(() => () => clearTimer(), []);

  const scheduleOpen = (): void => {
    if (trigger !== 'hover') return;
    clearTimer();
    timerRef.current = window.setTimeout(() => setHoverOpen(true), HOVER_OPEN_DELAY_MS);
  };
  const scheduleClose = (): void => {
    if (trigger !== 'hover') return;
    clearTimer();
    timerRef.current = window.setTimeout(() => setHoverOpen(false), HOVER_CLOSE_DELAY_MS);
  };

  const rootProps =
    trigger === 'hover'
      ? { open: hoverOpen || managementDialogOpen, onOpenChange: setHoverOpen }
      : {};

  return (
    <Popover.Root {...rootProps}>
      <Popover.Trigger
        asChild
        onPointerEnter={scheduleOpen}
        onPointerLeave={scheduleClose}
      >
        {children}
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          side={side}
          align={align}
          sideOffset={6}
          collisionPadding={8}
          onPointerEnter={scheduleOpen}
          onPointerLeave={scheduleClose}
          data-popover-frame="info"
          className="z-[var(--z-dialog)] w-[260px] max-w-[calc(100vw-32px)] bg-bg-floating p-3 shadow-popover outline-none data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95"
        >
          {/* v3 layout (#task:912 review round 7 → round 9 final):
                avatar | name + ● presence    [↻ ⏻ ⌫]   ← actions top-right
                       | @handle

              The description was removed from this popover entirely
              (round 9 final — the user's words: "profile card 直接不
              展示 description, 头像也跟着变小, 而且 description 长度也不
              太好控制"). Long-form description copy is hard to truncate
              cleanly inside a 260px card — it dragged the avatar / card
              into resizing dances across rounds 7 → 9. The full
              description still lives in the agent profile's
              Capabilities section; this card is intentionally a
              minimal identity preview (avatar / name + presence /
              handle / actions).

              Avatar is 36px to match the compact two-row layout —
              `items-center` aligns the avatar between the name and
              handle rows. Actions stay icon-only top-right. */}
          <div className="flex items-center gap-3">
            <AgentAvatar
              runtime={agent.runtime}
              size={AVATAR_PX.xl}
              avatarObjectUrl={resolvedAvatarObjectUrl}
              alt={agent.display_name || agent.name}
            />
            <div className="min-w-0 flex-1">
              {/* Name + inline presence dot. Presence sits as the
                  semantic state next to the name; per-conversation
                  only (without conversationId there's no presence to
                  show). */}
              <div className="flex min-w-0 items-center gap-2">
                <span className="min-w-0 truncate text-sm font-semibold text-text-primary">
                  {agent.display_name || agent.name}
                </span>
                {conversationId ? (
                  <PresenceInline
                    agentId={agent.id}
                    conversationId={conversationId}
                  />
                ) : null}
              </div>
              <div className="truncate font-mono text-xs text-text-muted">
                @{agent.name}
              </div>
            </div>
            {/* Top-right icon-only actions. Always rendered when a
                conversationId is in scope; AgentManagementActions
                short-circuits to null when the viewer can't edit
                this agent or the agent isn't a member of this
                conversation, so unauthorized surfaces stay
                informational without callers needing a separate gate
                prop. #task:912 review round 8 — collapsed the prior
                `management` switch so header chips and message-stream
                avatars render the same card. `self-start` overrides
                the row's `items-center` (used to center the avatar
                against the two text rows) so actions still sit in
                the top-right corner instead of riding the row's
                vertical center. */}
            {conversationId ? (
              <div className="self-start">
                <AgentManagementActions
                  agent={agent}
                  conversationId={conversationId}
                  onDialogOpenChange={setManagementDialogOpen}
                />
              </div>
            ) : null}
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

// IM-style presence labels — keep the underlying ConversationAgentStatus
// terminology out of the chat UI. `idle` (no live process) maps to
// "Away" since the runtime spawns lazily on the next message instead
// of requiring user action.
const PRESENCE_LABEL: Record<ConversationAgentStatus, string> = {
  active: 'Online',
  starting: 'Connecting',
  idle: 'Away',
  crashed: 'Offline',
};
const PRESENCE_DOT: Record<ConversationAgentStatus, string> = {
  active: 'bg-success',
  starting: 'bg-warning',
  idle: 'bg-text-muted/40',
  crashed: 'bg-error',
};

function PresenceInline({
  agentId,
  conversationId,
}: {
  agentId: string;
  conversationId: string;
}): JSX.Element {
  const { data: members = [] } = useChannelAgents(conversationId);
  const { data: runtime = [] } = useChannelAgentRuntime(conversationId);
  const member = members.find(s => s.agent_id === agentId);
  const row = runtime.find(s => s.agent_id === agentId);
  // Rendered inline next to the display name (#task:912 review round 7
  // — was a standalone row below; the user noted it took a band of
  // vertical space without earning it). When the agent isn't in this
  // conversation we still want a faint hint, so we render the muted
  // dot + "Not here" rather than collapse silently.
  if (!member) {
    return (
      <span className="inline-flex shrink-0 items-center gap-1 text-[length:var(--text-badge)] text-text-muted">
        <span data-status-pip className="size-1.5 rounded-[var(--pill-radius)] bg-text-muted/40" />
        Not here
      </span>
    );
  }
  const status = row?.status ?? 'idle';
  return (
    <span
      className="inline-flex shrink-0 items-center gap-1 text-[length:var(--text-badge)] text-text-muted"
      title={PRESENCE_LABEL[status]}
    >
      <span data-status-pip className={'size-1.5 rounded-[var(--pill-radius)] ' + PRESENCE_DOT[status]} />
      {PRESENCE_LABEL[status]}
    </span>
  );
}

function AgentManagementActions({
  agent,
  conversationId,
  onDialogOpenChange,
}: {
  agent: AgentDto;
  conversationId: string;
  onDialogOpenChange: (open: boolean) => void;
}): JSX.Element | null {
  const { data: conversationAgents = [] } = useChannelAgents(conversationId);
  const { data: conversationRuntime = [] } = useChannelAgentRuntime(conversationId);
  const start = useStartAgent(conversationId);
  const stop = useStopAgent(conversationId);
  const clearSession = useClearAgentSession(conversationId, agent.session_scope);
  const removeFromChannel = useRemoveAgentFromChannel(conversationId);
  const { data: viewer } = useViewerUser();
  // Resolve the viewer's role in THIS conversation's workspace so the
  // remove gate can honor "workspace owner/admin" without callers having
  // to thread a workspaceId through every popover surface (mentions,
  // message authors, header chips). Both queries are cached and only
  // mount when the popover content opens.
  const conversation = useConversationById(conversationId);
  const { data: memberLists } = useWorkspaceMemberLists(
    conversation.ref?.workspace_id ?? null,
  );
  const [clearOpen, setClearOpen] = useState(false);
  const [removeOpen, setRemoveOpen] = useState(false);
  const row = conversationAgents.find(s => s.agent_id === agent.id);
  const runtimeRow = conversationRuntime.find(s => s.agent_id === agent.id);
  if (!row) return null;
  const viewerForPermissions =
    viewer && (isBackendUnreachable(viewer) || isUpdateRequired(viewer)) ? undefined : viewer;
  // Runtime controls (restart / stop / clear) stay creator-only, mirroring
  // the backend `canEditAgent` gate. Removing from the conversation is a
  // wider governance action — agent owner OR workspace owner/admin
  // (#task:957, plan A: no per-channel owner concept).
  const canManageRuntime = canEditAgentProfile(viewerForPermissions, agent);
  const canRemove = canRemoveAgentFromChannel(
    viewerForPermissions,
    agent,
    memberLists?.viewerRole,
  );
  if (!canManageRuntime && !canRemove) return null;

  const pending = start.isPending || stop.isPending || clearSession.isPending;
  const agentLabel = `@${agent.name}`;
  const convNoun = 'channel';
  const setClearDialogOpen = (open: boolean): void => {
    setClearOpen(open);
    onDialogOpenChange(open);
  };
  const setRemoveDialogOpen = (open: boolean): void => {
    setRemoveOpen(open);
    onDialogOpenChange(open);
  };
  const restart = async (): Promise<void> => {
    if (pending) return;
    await stop.mutateAsync({ agentId: agent.id });
    try {
      await start.mutateAsync(agent.id);
    } catch {
      // useStartAgent owns the visible toast; suppress the rejected click promise.
    }
  };
  const stopAgent = (): void => {
    if (pending) return;
    stop.mutate({ agentId: agent.id });
  };
  const clear = async (): Promise<void> => {
    await clearSession.mutateAsync(agent.id);
    setClearDialogOpen(false);
  };
  const remove = async (): Promise<void> => {
    try {
      await removeFromChannel.mutateAsync(agent.id);
      setRemoveDialogOpen(false);
    } catch {
      // useRemoveAgentFromChannel surfaces the toast; keep the dialog
      // open so the user can retry or cancel.
    }
  };

  return (
    <>
      {/* v3 (#task:912 review round 7) + round 8 + round 9: top-right
          icon-only action group. No bottom-bar label buttons — the
          popover stays identity-led and visually light. All icons sit on
          a uniform `gap-0.5` grid (round 9 — the user flagged the prior
          destructive-spacer break against equal spacing; the destructive
          hover-red + error tint already carries the warning, the gap
          doesn't need to). The Restart icon also covers the crashed →
          restart path; round 8 collapsed the standalone RetryRow because
          the same Restart icon is now always available on every popover
          surface. #task:957: the trailing UserMinus removes the agent
          from THIS conversation; it is gated wider than the creator-only
          runtime trio (agent owner OR workspace owner/admin), so a
          non-creator workspace owner sees only this control. */}
      <div className="flex shrink-0 items-center gap-0.5">
        {canManageRuntime ? (
          <>
            <button
              type="button"
              onClick={restart}
              disabled={pending}
              className="inline-flex size-7 items-center justify-center rounded-[var(--control-radius)] text-text-secondary transition-colors hover:bg-bg-hover hover:text-text-primary disabled:opacity-50 disabled:hover:bg-transparent"
              title={`Restart ${agentLabel}`}
              aria-label={`Restart ${agentLabel}`}
            >
              <RefreshCw className="size-3.5" />
            </button>
            <button
              type="button"
              onClick={stopAgent}
              disabled={pending || !runtimeRow || runtimeRow.status === 'idle'}
              className="inline-flex size-7 items-center justify-center rounded-[var(--control-radius)] text-text-secondary transition-colors hover:bg-bg-hover hover:text-text-primary disabled:opacity-50 disabled:hover:bg-transparent"
              title={`Stop ${agentLabel}`}
              aria-label={`Stop ${agentLabel}`}
            >
              <Power className="size-3.5" />
            </button>
            <button
              type="button"
              onClick={() => setClearDialogOpen(true)}
              disabled={pending}
              className="inline-flex size-7 items-center justify-center rounded-[var(--control-radius)] text-error/70 transition-colors hover:bg-error/10 hover:text-error disabled:opacity-50 disabled:hover:bg-transparent"
              title={`Clear ${agentLabel} session`}
              aria-label={`Clear ${agentLabel} session`}
            >
              <Eraser className="size-3.5" />
            </button>
          </>
        ) : null}
        {canRemove ? (
          <button
            type="button"
            onClick={() => setRemoveDialogOpen(true)}
            disabled={removeFromChannel.isPending}
            className="inline-flex size-7 items-center justify-center rounded-[var(--control-radius)] text-error/70 transition-colors hover:bg-error/10 hover:text-error disabled:opacity-50 disabled:hover:bg-transparent"
            title={`Remove ${agentLabel} from this ${convNoun}`}
            aria-label={`Remove ${agentLabel} from this ${convNoun}`}
          >
            <UserMinus className="size-3.5" />
          </button>
        ) : null}
      </div>
      <Dialog open={clearOpen} onOpenChange={setClearDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-error">
              <AlertTriangle className="size-4" />
              Clear session for {agentLabel}
            </DialogTitle>
            <DialogDescription>
              This removes only this conversation's CLI resume session for{' '}
              {agentLabel}. MEMORY, notes, and queued deliveries are kept. The
              next start will begin with a fresh CLI session.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => setClearDialogOpen(false)}
              disabled={clearSession.isPending}
              {...destructiveCancel()}
            >
              Cancel
            </Button>
            <Button
              type="button"
              variant="danger"
              onClick={clear}
              disabled={clearSession.isPending}
              {...destructiveAction()}
            >
              {clearSession.isPending ? 'Clearing...' : 'Clear session'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog open={removeOpen} onOpenChange={setRemoveDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-error">
              <AlertTriangle className="size-4" />
              Remove {agentLabel} from this {convNoun}
            </DialogTitle>
            <DialogDescription>
              {agentLabel} will no longer be part of this {convNoun}. You can
              add it back anytime.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => setRemoveDialogOpen(false)}
              disabled={removeFromChannel.isPending}
              {...destructiveCancel()}
            >
              Cancel
            </Button>
            <Button
              type="button"
              variant="danger"
              onClick={remove}
              disabled={removeFromChannel.isPending}
              {...destructiveAction()}
            >
              {removeFromChannel.isPending ? 'Removing...' : 'Remove'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
