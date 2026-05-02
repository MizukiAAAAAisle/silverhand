import { useState } from 'react';
import { Bookmark, CornerUpLeft, User } from 'lucide-react';
import type { AgentDto, ChannelDto, MessageDto } from '@silverhand/shared';
import { AgentAvatar } from '@/components/AgentAvatar';
import { AgentInfoPopover } from '@/components/AgentInfoPopover';
import { Markdown } from './Markdown';
import { useMessageLayoutMode } from './useMessageLayoutMode';
import { useRelativeTime } from './useRelativeTime';

interface MessageItemProps {
  message: MessageDto;
  /** Session this message belongs to. Forwarded to AgentInfoPopover so
   *  the author/avatar popover can show per-session presence + retry. */
  sessionId: string;
  /** Looked up by `from_agent_id` to resolve display name + runtime
   *  (avatar) and also by mention name (via `agentsByName`). */
  agentsById: Map<string, AgentDto>;
  /** Lookup by `agent.name` (the @mention handle). Threaded to the
   *  Markdown component so inline `@handle` references can resolve. */
  agentsByName: Map<string, AgentDto>;
  /** Lookup by `channel.name` (the #channel handle). Threaded to
   *  the Markdown component so inline `#name` references render
   *  as styled pills. */
  channelsByName: Map<string, ChannelDto>;
  onStartThread?: (msg: MessageDto) => void;
  /** When this message has an open thread anchored to it, the count of
   *  non-system replies in that thread. Drives the button label
   *  `{count} Reply` (clicking opens the existing thread instead of
   *  creating a new one — handler short-circuits the POST). Undefined
   *  = no thread, button shows "Thread". */
  threadReplyCount?: number;
  onSave?: (msg: MessageDto) => void;
  saved?: boolean;
  /** Persistently render the hover frame around this row — used by the
   *  parent pane to mark "the message a thread is anchored to" while
   *  the thread pane is open. Doesn't expose the action bar, since the
   *  highlight is informational, not interactive. */
  highlighted?: boolean;
}

/**
 * Renders a non-system message (user or agent) as a hoverable row with
 * markdown body, role-name + relative time header, and a flat Thread / Save
 * action bar that appears on hover at the bottom-left.
 *
 * Hover affordance: `--bg-floating` (pure white in the default theme)
 * background + 1px `--border-subtle` outline, square corners.
 *
 * Layout: respects `useMessageLayoutMode`. In `'user-right'` mode the
 * current user's messages flush right; in `'all-left'` everything is
 * left-aligned.
 */
export function MessageItem({
  message,
  sessionId,
  agentsById,
  agentsByName,
  channelsByName,
  onStartThread,
  threadReplyCount,
  onSave,
  saved = false,
  highlighted = false,
}: MessageItemProps): JSX.Element {
  const isUser = message.from_kind === 'user';
  const mode = useMessageLayoutMode();
  const alignRight = mode === 'user-right' && isUser;
  const agent = !isUser && message.from_agent_id
    ? agentsById.get(message.from_agent_id)
    : undefined;
  const name = isUser ? 'you' : agent?.name ?? 'agent';
  const displayLabel = isUser
    ? 'you'
    : `@${agent?.display_name?.trim() || name}`;
  const { relative, absolute } = useRelativeTime(message.created_at);
  const [hover, setHover] = useState(false);
  // Visual-only: highlight forces the framed look; only real hover
  // reveals the action bar.
  const framed = hover || highlighted;

  return (
    <div
      id={`msg-${message.id}`}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      className={
        'flex items-start gap-3 border-2 px-4 py-2 transition-colors ' +
        (alignRight ? 'flex-row-reverse' : 'flex-row') +
        ' ' +
        (framed
          ? 'border-accent bg-bg-floating'
          : 'border-transparent')
      }
    >
      <Avatar isUser={isUser} agent={agent} sessionId={sessionId} />
      <div className="min-w-0 max-w-[85%]">
        <header className={'mb-1 text-xs ' + (alignRight ? 'text-right' : '')}>
          {alignRight ? (
            <>
              <time
                dateTime={new Date(message.created_at).toISOString()}
                title={absolute}
                className="text-text-muted"
              >
                {relative}
              </time>
              <span
                className={
                  'ml-2 font-medium ' +
                  (isUser ? 'text-text-primary' : 'text-accent')
                }
              >
                {displayLabel}
              </span>
            </>
          ) : (
            <>
              {agent ? (
                <AgentInfoPopover agent={agent} sessionId={sessionId}>
                  <button
                    type="button"
                    className="rounded font-medium text-accent hover:underline focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-border-focus"
                  >
                    {displayLabel}
                  </button>
                </AgentInfoPopover>
              ) : (
                <span
                  className={
                    'font-medium ' +
                    (isUser ? 'text-text-primary' : 'text-accent')
                  }
                >
                  {displayLabel}
                </span>
              )}
              <time
                dateTime={new Date(message.created_at).toISOString()}
                title={absolute}
                className="ml-2 text-text-muted"
              >
                {relative}
              </time>
            </>
          )}
        </header>

        <div
          className={
            'text-sm text-text-primary ' + (alignRight ? 'text-right' : '')
          }
        >
          <Markdown
            content={message.content}
            sessionId={sessionId}
            agentsByName={agentsByName}
            channelsByName={channelsByName}
          />
        </div>

        {/* Action bar — flat, inline below the content. Mirrors to the
            right edge in user-right mode so it sits under the message
            instead of jumping to the far left.

            Per-item visibility: when the message has an open thread,
            the "{N} Reply" badge stays visible so the user can see the
            thread exists without hovering; Save stays hover-only. */}
        <div
          className={
            'mt-1 flex h-5 items-center gap-3 text-xs ' +
            (alignRight ? 'justify-end' : 'justify-start')
          }
        >
          {onStartThread ? (
            <ActionButton
              icon={<CornerUpLeft className="size-3.5" />}
              label={
                threadReplyCount !== undefined
                  ? `${threadReplyCount} Reply`
                  : 'Thread'
              }
              active={threadReplyCount !== undefined}
              onClick={() => onStartThread(message)}
              alwaysVisible={threadReplyCount !== undefined}
              hovered={hover}
            />
          ) : null}
          <ActionButton
            icon={<Bookmark className={'size-3.5 ' + (saved ? 'fill-current' : '')} />}
            label={saved ? 'Saved' : 'Save'}
            active={saved}
            onClick={() => onSave?.(message)}
            hovered={hover}
          />
        </div>
      </div>
    </div>
  );
}

function Avatar({
  isUser,
  agent,
  sessionId,
}: {
  isUser: boolean;
  agent: AgentDto | undefined;
  sessionId: string;
}): JSX.Element {
  if (isUser) {
    return (
      <span
        className="mt-0.5 inline-flex size-8 shrink-0 items-center justify-center rounded-full bg-bg-elevated text-text-muted"
        aria-hidden
      >
        <User className="size-4" />
      </span>
    );
  }
  if (agent) {
    return (
      <AgentInfoPopover agent={agent} sessionId={sessionId}>
        <button
          type="button"
          aria-label={`@${agent.name}`}
          className="mt-0.5 rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-focus"
        >
          <AgentAvatar runtime={agent.runtime} size={32} />
        </button>
      </AgentInfoPopover>
    );
  }
  return (
    <span
      className="mt-0.5 inline-flex size-8 shrink-0 items-center justify-center rounded-full bg-bg-elevated text-text-muted"
      aria-hidden
    >
      <User className="size-4" />
    </span>
  );
}

function ActionButton({
  icon,
  label,
  onClick,
  active = false,
  hovered,
  alwaysVisible = false,
}: {
  icon: React.ReactNode;
  label: string;
  onClick?: () => void;
  active?: boolean;
  /** Whether the parent row is currently hovered. Drives visibility
   *  unless `alwaysVisible` overrides it. */
  hovered: boolean;
  /** Force the button to render at full opacity regardless of hover —
   *  used for the persistent "{N} Reply" badge so the user can see at
   *  a glance that a message has an open thread. */
  alwaysVisible?: boolean;
}): JSX.Element {
  const visible = alwaysVisible || hovered;
  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      className={
        'flex items-center gap-1 transition-colors transition-opacity ' +
        (visible ? 'opacity-100' : 'pointer-events-none opacity-0') +
        ' ' +
        (active
          ? 'text-accent'
          : 'text-text-muted hover:text-text-primary')
      }
    >
      {icon}
      <span>{label}</span>
    </button>
  );
}
