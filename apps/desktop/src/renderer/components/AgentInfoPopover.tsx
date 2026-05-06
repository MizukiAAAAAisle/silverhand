import * as Popover from '@radix-ui/react-popover';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { AgentDto, ConversationAgentStatus } from '@silverhand/shared';
import { useChannelAgents, useStartAgent } from '@/features/channels/hooks';
import { AgentAvatar } from './AgentAvatar';

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
  routeKind?: 'channel' | 'thread';
  /** `'click'` (default) opens on click — used by mention pills /
   *  message author labels. `'hover'` opens on pointer-enter and
   *  closes on pointer-leave with a small grace window so the user
   *  can move into the popover content. Used by the member strip in
   *  the conversation header. */
  trigger?: 'click' | 'hover';
}

const HOVER_OPEN_DELAY_MS = 80;
const HOVER_CLOSE_DELAY_MS = 120;

/**
 * Compact agent info card. Shows avatar, display name + handle,
 * runtime/model, presence (per-conversation), and an optional retry
 * affordance when the agent has crashed in this conversation.
 *
 * Two trigger modes: click (mention pills, message author) and hover
 * (member strip in conversation header). Hover mode is implemented via
 * controlled `open` rather than a separate Radix HoverCard primitive
 * to keep the dep surface narrow.
 */
export function AgentInfoPopover({
  agent,
  children,
  side = 'bottom',
  align = 'start',
  conversationId,
  routeKind = 'channel',
  trigger = 'click',
}: AgentInfoPopoverProps): JSX.Element {
  const [hoverOpen, setHoverOpen] = useState(false);
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
      ? { open: hoverOpen, onOpenChange: setHoverOpen }
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
          className="z-50 w-[260px] rounded-md border border-border bg-bg-floating p-3 shadow-lg outline-none"
        >
          <div className="flex items-start gap-3">
            <AgentAvatar runtime={agent.runtime} size={36} />
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-semibold text-text-primary">
                {agent.display_name || agent.name}
              </div>
              <div className="truncate font-mono text-xs text-text-muted">
                @{agent.name}
              </div>
              {conversationId ? (
                <PresenceLine
                  agentId={agent.id}
                  conversationId={conversationId}
                  routeKind={routeKind}
                />
              ) : null}
            </div>
          </div>
          <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-2 gap-y-1 text-xs">
            <dt className="text-text-muted">Runtime</dt>
            <dd className="text-text-primary capitalize">{agent.runtime}</dd>
            {agent.model ? (
              <>
                <dt className="text-text-muted">Model</dt>
                <dd className="truncate text-text-primary">{agent.model}</dd>
              </>
            ) : null}
            {agent.reasoning_effort ? (
              <>
                <dt className="text-text-muted">Effort</dt>
                <dd className="text-text-primary">{agent.reasoning_effort}</dd>
              </>
            ) : null}
          </dl>
          {agent.description ? (
            <p className="mt-2 line-clamp-4 whitespace-pre-wrap text-xs text-text-secondary">
              {agent.description}
            </p>
          ) : null}
          {conversationId ? (
            <RetryRow
              agentId={agent.id}
              conversationId={conversationId}
              routeKind={routeKind}
            />
          ) : null}
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

function PresenceLine({
  agentId,
  conversationId,
  routeKind = 'channel',
}: {
  agentId: string;
  conversationId: string;
  routeKind?: 'channel' | 'thread';
}): JSX.Element {
  const { data: sa = [] } = useChannelAgents(conversationId, routeKind);
  const row = sa.find(s => s.agent_id === agentId);
  if (!row) {
    return (
      <div className="mt-1 text-xs text-text-muted">Not in this conversation</div>
    );
  }
  return (
    <div className="mt-1 flex items-center gap-1.5 text-xs text-text-muted">
      <span className={'size-1.5 rounded-full ' + PRESENCE_DOT[row.status]} />
      <span>{PRESENCE_LABEL[row.status]}</span>
    </div>
  );
}

function RetryRow({
  agentId,
  conversationId,
  routeKind = 'channel',
}: {
  agentId: string;
  conversationId: string;
  routeKind?: 'channel' | 'thread';
}): JSX.Element | null {
  const { data: sa = [] } = useChannelAgents(conversationId, routeKind);
  const start = useStartAgent(conversationId, routeKind);
  const row = sa.find(s => s.agent_id === agentId);
  if (!row || row.status !== 'crashed') return null;
  return (
    <div className="mt-3 border-t border-border-subtle pt-2">
      <button
        type="button"
        onClick={() => start.mutate(agentId)}
        disabled={start.isPending}
        className="text-xs text-accent hover:underline disabled:opacity-50"
      >
        {start.isPending ? '启动中…' : '重新启动'}
      </button>
    </div>
  );
}
