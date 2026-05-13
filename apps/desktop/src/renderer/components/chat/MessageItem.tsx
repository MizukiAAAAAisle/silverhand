import { useCallback, useEffect, useState } from 'react';
import { Bookmark, CornerUpLeft, FileText, ListTodo, User } from 'lucide-react';
import type { AgentDto, AttachmentSnapshot, MessageDto } from '@silverhand/shared';
import { AgentAvatar } from '@/components/AgentAvatar';
import { AgentInfoPopover } from '@/components/AgentInfoPopover';
import { useNav } from '@/router';
import { fetchAttachmentBlob } from '@/lib/api';
import {
  getAttachmentBlobUrl,
  loadAttachmentBlobUrl,
} from '@/lib/attachment-blob-cache';
import {
  formatUserDisplayName,
  isCurrentUserId,
} from '@/lib/current-user';
import { Lightbox } from './Lightbox';
import { Markdown } from './Markdown';
import type { ChannelReference } from './ChannelRef';
import type { ConversationReference } from './ConversationRef';
import { useMessageLayoutMode } from './useMessageLayoutMode';
import { useRelativeTime } from './useRelativeTime';

interface MessageItemProps {
  message: MessageDto;
  /** Conversation this message belongs to. Forwarded to AgentInfoPopover so
   *  the author/avatar popover can show per-conversation presence + retry. */
  conversationId: string;
  routeKind?: 'channel' | 'thread';
  /** Looked up by `from_agent_id` to resolve display name + runtime
   *  (avatar) and also by mention name (via `agentsByName`). */
  agentsById: Map<string, AgentDto>;
  /** Lookup by `agent.name` (the @mention handle). Threaded to the
   *  Markdown component so inline `@handle` references can resolve. */
  agentsByName: Map<string, AgentDto>;
  /** Lookup by `channel.title` (the #handle used in inline refs).
   *  `null` value = ambiguity sentinel (multiple channels share that
   *  title in this workspace) → chip degrades to inert text. Threaded
   *  to the Markdown component so inline `#name` references render
   *  as clickable pills when unique. */
  channelsByName: Map<string, ChannelReference | null>;
  /** Click handler for resolved channel refs. Wired by the parent
   *  to navigate the right workspace via `nav.toChannel`. */
  onOpenChannelRef?: (channelId: string) => void;
  /** Lookup by conversation id for inline `#conv:<id>` references. */
  conversationRefsById?: Map<string, ConversationReference>;
  onOpenConversationRef?: (id: string) => void;
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
  conversationId,
  routeKind = 'channel',
  agentsById,
  agentsByName,
  channelsByName,
  onOpenChannelRef,
  conversationRefsById,
  onOpenConversationRef,
  onStartThread,
  threadReplyCount,
  onSave,
  saved = false,
  highlighted = false,
}: MessageItemProps): JSX.Element {
  const isUser = message.from_kind === 'user';
  const isCurrentUser = isUser && isCurrentUserId(message.from_user_id);
  const mode = useMessageLayoutMode();
  const alignRight = mode === 'user-right' && isCurrentUser;
  const agent = !isUser && message.from_agent_id
    ? agentsById.get(message.from_agent_id)
    : undefined;
  const name = isUser
    ? formatUserDisplayName(message.from_user_id)
    : agent?.name ?? 'agent';
  const displayLabel = isUser
    ? name
    : `@${agent?.display_name?.trim() || name}`;
  const { relative, absolute } = useRelativeTime(message.created_at);
  const { toMembers } = useNav();
  const navigateToAgent = useCallback(
    (agentId: string) => toMembers(agentId),
    [toMembers],
  );
  const taskTag = <TaskMetaTag message={message} agentsById={agentsById} />;
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
        'flex items-start gap-3 border-2 px-2 py-1.5 transition-colors ' +
        (alignRight ? 'flex-row-reverse' : 'flex-row') +
        ' ' +
        (framed
          ? 'border-accent bg-bg-floating'
          : 'border-transparent')
      }
    >
      <Avatar
        isUser={isUser}
        agent={agent}
        conversationId={conversationId}
        routeKind={routeKind}
        onNavigateAgent={navigateToAgent}
      />
      <div className="min-w-0 max-w-[85%]">
        <header className={'mb-1 text-xs ' + (alignRight ? 'text-right' : '')}>
          {alignRight ? (
            <>
              <time
                dateTime={new Date(message.created_at).toISOString()}
                title={absolute}
                className="text-[11px] text-text-muted"
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
              {taskTag}
            </>
          ) : (
            <>
              {agent ? (
                <AgentInfoPopover
                  agent={agent}
                  conversationId={conversationId}
                  routeKind={routeKind}
                  trigger="hover"
                >
                  <button
                    type="button"
                    onClick={event => {
                      event.preventDefault();
                      navigateToAgent(agent.id);
                    }}
                    className="rounded font-medium text-accent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-border-focus"
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
                className="ml-2 text-[11px] text-text-muted"
              >
                {relative}
              </time>
              {taskTag}
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
            conversationId={conversationId}
            agentsByName={agentsByName}
            channelsByName={channelsByName}
            onOpenChannelRef={onOpenChannelRef}
            conversationRefsById={conversationRefsById}
            onOpenConversationRef={onOpenConversationRef}
          />
          {message.attachments && message.attachments.length > 0 ? (
            <AttachmentList attachments={message.attachments} alignRight={alignRight} />
          ) : null}
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

const TASK_STATUS_LABELS: Record<NonNullable<MessageDto['task_status']>, string> = {
  todo: 'todo',
  in_progress: 'doing',
  in_review: 'review',
  done: 'done',
};

function TaskMetaTag({
  message,
  agentsById,
}: {
  message: MessageDto;
  agentsById: Map<string, AgentDto>;
}): JSX.Element | null {
  if (message.task_number === null) return null;

  const assignee = message.task_assignee
    ? formatTaskAssignee(message.task_assignee, agentsById)
    : null;
  const status = message.task_status
    ? TASK_STATUS_LABELS[message.task_status]
    : null;
  const label = assignee
    ? `#${message.task_number} · ${assignee}`
    : `#${message.task_number}`;
  const title = [
    `Task #${message.task_number}`,
    status,
    assignee,
    message.task_title,
  ]
    .filter(Boolean)
    .join(' · ');

  return (
    <span
      title={title}
      className="ml-2 inline-flex h-5 max-w-[200px] items-center gap-1 border border-[var(--border-task-tag)] bg-[var(--bg-task-tag)] px-1.5 align-middle text-[11px] font-semibold leading-none text-[var(--text-on-task-tag)]"
    >
      <ListTodo className="size-3 shrink-0" aria-hidden />
      <span className="min-w-0 truncate">{label}</span>
    </span>
  );
}

function formatTaskAssignee(
  assignee: NonNullable<MessageDto['task_assignee']>,
  agentsById: Map<string, AgentDto>,
): string {
  if (assignee.type === 'user') {
    return formatUserDisplayName(assignee.id);
  }
  const agent = agentsById.get(assignee.id);
  const name = (
    agent?.display_name?.trim() ||
    agent?.name ||
    assignee.name.trim() ||
    assignee.id
  ).replace(/^@/, '');
  return `@${name}`;
}

function Avatar({
  isUser,
  agent,
  conversationId,
  routeKind,
  onNavigateAgent,
}: {
  isUser: boolean;
  agent: AgentDto | undefined;
  conversationId: string;
  routeKind: 'channel' | 'thread';
  onNavigateAgent: (agentId: string) => void;
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
      <AgentInfoPopover
        agent={agent}
        conversationId={conversationId}
        routeKind={routeKind}
        trigger="hover"
      >
        <button
          type="button"
          aria-label={`@${agent.name}`}
          onClick={event => {
            event.preventDefault();
            onNavigateAgent(agent.id);
          }}
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

function AttachmentList({
  attachments,
  alignRight,
}: {
  attachments: AttachmentSnapshot[];
  alignRight: boolean;
}): JSX.Element {
  return (
    <div
      className={
        'mt-2 flex flex-wrap gap-2 ' + (alignRight ? 'justify-end' : 'justify-start')
      }
    >
      {attachments.map(att => (
        <AttachmentTile key={att.id} attachment={att} />
      ))}
    </div>
  );
}

function AttachmentTile({ attachment }: { attachment: AttachmentSnapshot }): JSX.Element {
  const isImage = attachment.content_type.startsWith('image/');
  // Synchronous cache hit covers both the optimistic-message render
  // (Composer pre-populated the cache from the local File) and any
  // later viewer who has already fetched this attachment in this
  // session — so the swap from optimistic → real message never goes
  // through a "loading" frame.
  const [imageUrl, setImageUrl] = useState<string | null>(() =>
    isImage ? getAttachmentBlobUrl(attachment.id) ?? null : null,
  );
  const [error, setError] = useState<string | null>(null);
  const [lightboxOpen, setLightboxOpen] = useState(false);

  useEffect(() => {
    if (!isImage || imageUrl) return;
    let cancelled = false;
    loadAttachmentBlobUrl(attachment.id)
      .then(url => {
        if (!cancelled) setImageUrl(url);
      })
      .catch(err => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [attachment.id, isImage, imageUrl]);

  // Recover from an evicted-and-revoked URL: drop our stale value
  // and let the effect above re-fetch through loadAttachmentBlobUrl.
  function onImgError(): void {
    setImageUrl(null);
  }

  async function downloadAndOpen(): Promise<void> {
    // Non-image fallback: fetch the bytes once and open in a new
    // window. Image preview goes through the in-app Lightbox below.
    try {
      const res = await fetchAttachmentBlob(attachment.id);
      window.open(res.url, '_blank', 'noopener');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  if (isImage) {
    return (
      <>
        <button
          type="button"
          onClick={() => imageUrl && setLightboxOpen(true)}
          disabled={!imageUrl}
          className="block overflow-hidden rounded-md border border-border-subtle bg-bg-floating focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-focus"
          title={`${attachment.filename} (${formatBytes(attachment.size)})`}
        >
          {imageUrl ? (
            <img
              src={imageUrl}
              alt={attachment.filename}
              onError={onImgError}
              className="block max-h-64 max-w-[320px] cursor-zoom-in object-contain"
            />
          ) : (
            <div className="flex h-32 w-48 items-center justify-center text-xs text-text-muted">
              {error ?? '加载中…'}
            </div>
          )}
        </button>
        {imageUrl ? (
          <Lightbox
            open={lightboxOpen}
            onOpenChange={setLightboxOpen}
            src={imageUrl}
            alt={attachment.filename}
          />
        ) : null}
      </>
    );
  }

  return (
    <button
      type="button"
      onClick={downloadAndOpen}
      className="flex max-w-[280px] items-center gap-2 rounded-md border border-border-subtle bg-bg-floating px-2 py-1.5 text-xs text-text-secondary hover:bg-bg-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-focus"
      title={error ?? `${attachment.filename} (${formatBytes(attachment.size)})`}
    >
      <FileText className="size-4 shrink-0 text-text-muted" />
      <span className="min-w-0 truncate">{attachment.filename}</span>
      <span className="shrink-0 text-[10px] text-text-muted">
        {formatBytes(attachment.size)}
      </span>
    </button>
  );
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(1)} GB`;
}
