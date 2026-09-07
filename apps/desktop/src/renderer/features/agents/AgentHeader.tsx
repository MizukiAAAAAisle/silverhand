import { useState, type CSSProperties, type ReactNode } from 'react';
import { MessageSquare, Power, Trash2 } from 'lucide-react';
import type { AgentDto, AgentRuntimeStateDto } from '@silverhand/shared';
import { AgentAvatar } from '@/components/AgentAvatar';
import { AVATAR_PX } from '@/components/avatar-scale';
import { SidePanelHeader } from '@/components/layout/SidePanelHeader';
import { Button } from '@/components/ui/button';
import { neutralAction } from '@/features/common/ControlInkBorder';
import { destructiveAction, DESTRUCTIVE_TRIGGER } from '@/features/common/DestructiveAction';
import { useAgentPresence, useStopAgent } from './hooks';
import { projectPresence, PRESENCE_TONE_DOT } from './presence-projection';
import { useAgentAvatarObjectUrl } from './avatar-hooks';
import { DeleteAgentDialog } from './DeleteAgentDialog';

interface AgentHeaderProps {
  agent: AgentDto;
  runtimeState: AgentRuntimeStateDto | undefined;
  onDeleted: () => void;
  onClose?: () => void;
  compact?: boolean;
  onMessageAgent?: (agentId: string) => void;
}

export function AgentHeader({
  agent,
  runtimeState,
  onDeleted,
  onMessageAgent,
  onClose,
  compact = false,
}: AgentHeaderProps): JSX.Element {
  const [deleteOpen, setDeleteOpen] = useState(false);

  const stopAgent = useStopAgent(agent.id);
  const avatarObjectUrl = useAgentAvatarObjectUrl(agent.avatar_url);
  const presence = useAgentPresence(agent.id);

  // Availability describes the agent globally; seats only decide whether Stop is actionable.
  const runningCount = (runtimeState?.seats ?? []).filter(
    (seat) => seat.status === 'starting' || seat.status === 'active',
  ).length;
  const canMessage = Boolean(onMessageAgent) && agent.session_scope === 'agent';
  const displayName = agent.display_name || agent.name;
  const presenceDisplay = presence === null ? null : projectPresence({ scope: 'global', presence });

  const statusDot = presenceDisplay ? (
    <span
      role="img"
      aria-label={presenceDisplay.a11yLabel}
      title={presenceDisplay.detail}
      className={`size-1.5 shrink-0 self-center rounded-full ${PRESENCE_TONE_DOT[presenceDisplay.tone]}`}
    />
  ) : null;

  const avatar = (
    <AgentAvatar
      runtime={agent.runtime}
      size={compact ? AVATAR_PX.md : AVATAR_PX.xl}
      avatarObjectUrl={avatarObjectUrl}
      alt={displayName}
    />
  );

  const actions = (
    <>
      {canMessage && onMessageAgent ? (
        <HeaderAction
          compact={compact}
          label="Message"
          title={`Message @${agent.name}`}
          onClick={() => onMessageAgent(agent.id)}
        >
          <MessageSquare className="size-3.5" />
        </HeaderAction>
      ) : null}
      <HeaderAction
        compact={compact}
        label="Stop"
        title={
          runningCount === 0
            ? 'Nothing is running'
            : `Hard-stop ${runningCount} running session${runningCount === 1 ? '' : 's'}`
        }
        disabled={runningCount === 0 || stopAgent.isPending}
        onClick={() => stopAgent.mutate()}
      >
        <Power className="size-3.5" />
      </HeaderAction>
      {!compact ? (
        <HeaderAction
          compact={compact}
          label="Delete"
          title="Delete agent…"
          destructive
          onClick={() => setDeleteOpen(true)}
        >
          <Trash2 className="size-3.5" />
        </HeaderAction>
      ) : null}
    </>
  );

  const content = (
    <AgentHeaderContent
      compact={compact}
      avatar={avatar}
      displayName={displayName}
      status={statusDot}
      description={agent.description}
      actions={actions}
    />
  );

  return (
    <>
      {compact ? (
        <SidePanelHeader onClose={onClose}>{content}</SidePanelHeader>
      ) : (
        <header className="agent-header-full">{content}</header>
      )}
      <DeleteAgentDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        agent={agent}
        onDeleted={onDeleted}
      />
    </>
  );
}

function AgentHeaderContent({
  compact,
  avatar,
  displayName,
  status,
  description,
  actions,
}: {
  compact: boolean;
  avatar: ReactNode;
  displayName: string;
  status: ReactNode;
  description: string | null;
  actions: ReactNode;
}): JSX.Element {
  return (
    <div
      className="agent-header-content"
      data-compact={compact}
      style={
        {
          '--agent-header-avatar-size': `${compact ? AVATAR_PX.md : AVATAR_PX.xl}px`,
        } as CSSProperties
      }
    >
      <div className="shrink-0">{avatar}</div>
      <div className="agent-header-identity">
        <div className="agent-header-name-row">
          <span className="agent-header-name" title={displayName}>
            {displayName}
          </span>
          {status}
        </div>
        {description?.trim() ? (
          <p className="agent-header-description" title={description}>
            {description}
          </p>
        ) : null}
      </div>
      <div data-channel-actions={compact ? '' : undefined} className="agent-header-actions">
        {actions}
      </div>
    </div>
  );
}

function HeaderAction({
  compact,
  label,
  title,
  onClick,
  disabled,
  destructive = false,
  children,
}: {
  compact: boolean;
  label: string;
  title: string;
  onClick: () => void;
  disabled?: boolean;
  destructive?: boolean;
  children: ReactNode;
}): JSX.Element {
  if (compact) {
    return (
      <button
        type="button"
        aria-label={label}
        title={title}
        onClick={onClick}
        disabled={disabled}
        data-sticker
        data-sticker-size="md"
        data-sticker-tone="neutral"
        className={`flex size-7 shrink-0 items-center justify-center rounded-[var(--control-radius)] transition-colors hover:bg-bg-hover focus-outline disabled:pointer-events-none disabled:opacity-50 ${destructive ? 'text-error' : 'text-text-muted hover:text-text-primary'}`}
      >
        {children}
      </button>
    );
  }

  return (
    <Button
      variant="outline"
      size="sm"
      title={title}
      onClick={onClick}
      disabled={disabled}
      {...(destructive ? destructiveAction(DESTRUCTIVE_TRIGGER) : neutralAction())}
    >
      {children}
      {label}
    </Button>
  );
}
