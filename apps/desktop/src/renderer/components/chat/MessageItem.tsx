import { type FocusEvent, useCallback, useEffect, useState } from 'react';
import { Bookmark, ClipboardCheck, CornerUpLeft, FileText, User } from 'lucide-react';
import type {
  AgentDto,
  AttachmentSnapshot,
  MessageDto,
  UserDto,
} from '@silverhand/shared';
import { AgentAvatar } from '@/components/AgentAvatar';
import { AgentInfoPopover } from '@/components/AgentInfoPopover';
import { HumanInfoPopover } from '@/components/HumanInfoPopover';
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
  /** Lookup by `user.name` in the same @mention namespace as agents. */
  humansByName?: Map<string, UserDto>;
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
  /** Object URL pointing at the current viewer's avatar blob (or null
   *  if the viewer has no avatar / isn't loaded yet). Lifted into the
   *  parent pane so a single fetch drives every message render in the
   *  list. Resolved by `useViewerAvatarObjectUrl`. */
  viewerAvatarObjectUrl?: string | null;
  /** The current viewer's user row. When present, viewer-authored
   *  message rows wrap their avatar + author label in a
   *  `HumanInfoPopover` so hover gives the same identity card the
   *  member chip / `@mention` surfaces show. Undefined → registration
   *  not complete or still loading; the row falls back to the bare
   *  avatar/label. */
  viewer?: UserDto;
  /** Object-URL map keyed by agent id. The parent pane runs a single
   *  `useAgentAvatarObjectUrls` over the workspace agent list so every
   *  authored message reuses the same blob URL instead of N independent
   *  fetches. Missing entries / `null` fall back to the runtime icon. */
  agentAvatarUrls?: Map<string, string | null>;
  /** Persistently render the hover frame around this row — used by the
   *  parent pane to mark "the message a thread is anchored to" while
   *  the thread pane is open. Doesn't expose the action bar, since the
   *  highlight is informational, not interactive. */
  highlighted?: boolean;
}

/**
 * Renders a non-system message (user or agent) as a hoverable row with
 * markdown body, role-name + relative time header, and a Slack-style
 * pair of action affordances:
 *
 * - **Frame-corner action controls** (Save + Thread) — absolutely
 *   pinned to the top-right of the OUTER hover frame (mirrored to
 *   top-left in user-right mode), each rendered as a small icon +
 *   label pair using `ActionButton`. They sit on the framed card,
 *   NOT over the markdown body. Default hidden via
 *   `pointer-events-none opacity-0`; revealed on row hover OR
 *   `focus-within`, so a keyboard user can tab to them. They do not
 *   reserve vertical space, so two consecutive messages now sit
 *   tight against each other instead of being padded apart by an
 *   always-on action row.
 * - **Inline "{N} Reply" badge** — rendered below the body only when
 *   the message has an open thread. Carries real information, so it
 *   earns persistent space.
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
  humansByName,
  channelsByName,
  onOpenChannelRef,
  conversationRefsById,
  onOpenConversationRef,
  onStartThread,
  threadReplyCount,
  onSave,
  saved = false,
  highlighted = false,
  viewerAvatarObjectUrl = null,
  viewer,
  agentAvatarUrls,
}: MessageItemProps): JSX.Element {
  const isUser = message.from_kind === 'user';
  const isCurrentUser = isUser && isCurrentUserId(message.from_user_id);
  const mode = useMessageLayoutMode();
  const alignRight = mode === 'user-right' && isCurrentUser;
  const agent = !isUser && message.from_agent_id
    ? agentsById.get(message.from_agent_id)
    : undefined;
  // Author avatar URL resolved by the parent's batch hook. `undefined`
  // means the parent didn't thread the map (legacy / non-channel
  // surfaces) — pass `undefined` straight through so AgentInfoPopover
  // falls back to its own single-agent fetch. `null` means the agent
  // simply has no avatar (or it's still loading); render the runtime
  // tint, no fetch.
  const agentAvatarObjectUrl =
    agent && agentAvatarUrls
      ? agentAvatarUrls.get(agent.id) ?? null
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
  // React-driven focus-within: tracking it as state and OR-ing into
  // the visibility class is more reliable than relying on Tailwind's
  // `focus-within:` utility, which generates a same-specificity rule
  // (`(0,1,0)`) that loses to a later-declared `opacity-0` in the
  // compiled CSS — leaving keyboard users tabbing onto invisible
  // controls. `onFocus`/`onBlur` bubble in React, so we treat any
  // focus inside the actions wrapper as wrapper focus, and only clear
  // when focus leaves the wrapper subtree (not when it just hops
  // between sibling buttons inside).
  const [focusWithin, setFocusWithin] = useState(false);
  const handleActionsBlur = useCallback(
    (event: FocusEvent<HTMLDivElement>) => {
      const next = event.relatedTarget as Node | null;
      if (!event.currentTarget.contains(next)) {
        setFocusWithin(false);
      }
    },
    [],
  );
  // Visual-only: highlight forces the framed look; only real hover
  // reveals the action bar.
  const framed = hover || highlighted;

  return (
    <div
      id={`msg-${message.id}`}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      className={
        'relative flex items-start gap-3 border-2 px-2 py-1.5 transition-colors ' +
        (alignRight ? 'flex-row-reverse' : 'flex-row') +
        ' ' +
        (framed
          ? 'border-accent bg-bg-floating'
          : 'border-transparent')
      }
    >
      <Avatar
        isUser={isUser}
        isCurrentUser={isCurrentUser}
        viewer={viewer}
        viewerAvatarObjectUrl={viewerAvatarObjectUrl}
        agent={agent}
        agentAvatarObjectUrl={
          agent ? agentAvatarUrls?.get(agent.id) ?? null : null
        }
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
              <span className="ml-2 inline-block">
                <AuthorLabel
                  isUser={isUser}
                  isCurrentUser={isCurrentUser}
                  viewer={viewer}
                  agent={agent}
                  conversationId={conversationId}
                  routeKind={routeKind}
                  agentAvatarObjectUrl={agentAvatarObjectUrl}
                  viewerAvatarObjectUrl={viewerAvatarObjectUrl}
                  displayLabel={displayLabel}
                  onNavigateAgent={navigateToAgent}
                />
              </span>
              {taskTag}
            </>
          ) : (
            <>
              <AuthorLabel
                isUser={isUser}
                isCurrentUser={isCurrentUser}
                viewer={viewer}
                agent={agent}
                conversationId={conversationId}
                routeKind={routeKind}
                agentAvatarObjectUrl={agentAvatarObjectUrl}
                viewerAvatarObjectUrl={viewerAvatarObjectUrl}
                displayLabel={displayLabel}
                onNavigateAgent={navigateToAgent}
              />
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
            humansByName={humansByName}
            agentAvatarUrls={agentAvatarUrls}
            channelsByName={channelsByName}
            onOpenChannelRef={onOpenChannelRef}
            conversationRefsById={conversationRefsById}
            onOpenConversationRef={onOpenConversationRef}
          />
          {message.attachments && message.attachments.length > 0 ? (
            <AttachmentList attachments={message.attachments} alignRight={alignRight} />
          ) : null}
        </div>

        {/* Inline thread-replies badge — only rendered when
            `threadReplyCount !== undefined`. It carries real
            information ("this message has N replies, click to open"),
            so it earns its space below the bubble and stays visible
            without hover. */}
        {threadReplyCount !== undefined && onStartThread ? (
          <div
            className={
              'mt-1 flex h-5 items-center text-xs ' +
              (alignRight ? 'justify-end' : 'justify-start')
            }
          >
            <ActionButton
              icon={<CornerUpLeft className="size-3.5" />}
              label={`${threadReplyCount} Reply`}
              active
              onClick={() => onStartThread(message)}
              alwaysVisible
              hovered={hover}
            />
          </div>
        ) : null}
      </div>

      {/* Frame-corner action controls (Save + Thread) — absolutely
          pinned to the top-right of the framed message row (mirrored
          to top-left in user-right mode so they sit on the side away
          from the avatar). Anchored to the OUTER row container (which
          carries the hover frame's `border-accent bg-bg-floating`),
          NOT to the inner content column — that way the controls
          visually belong to the "card" instead of floating over the
          markdown body.

          Visibility: gated by hover OR focus-within so a keyboard
          user can tab to them without sighted-only hover access; on
          either trigger the wrapper flips to opacity-100 +
          pointer-events-auto. Both signals are React state — the
          Tailwind `focus-within:` utility variant has the same
          specificity as the base `opacity-0` and loses to it in the
          compiled CSS, so we drive the class directly from a
          `focusWithin` state instead. The controls re-use
          ActionButton so they match the inline "{N} Reply" badge's
          visual language — icon + small label, color-only hover, no
          container chrome.

          The Thread button is suppressed when `threadReplyCount` is
          already set — the inline "{N} Reply" badge is the discovery
          affordance in that case, so a duplicate "go to thread" icon
          would just be noise. */}
      <div
        onFocus={() => setFocusWithin(true)}
        onBlur={handleActionsBlur}
        className={
          'absolute top-1 z-10 flex items-center gap-3 text-xs transition-opacity ' +
          (alignRight ? 'left-2' : 'right-2') +
          ' ' +
          (hover || focusWithin ? 'opacity-100' : 'pointer-events-none opacity-0')
        }
      >
        {onStartThread && threadReplyCount === undefined ? (
          <ActionButton
            icon={<CornerUpLeft className="size-3.5" />}
            label="Thread"
            onClick={() => onStartThread(message)}
            alwaysVisible
            hovered={hover}
          />
        ) : null}
        <ActionButton
          icon={<Bookmark className={'size-3.5 ' + (saved ? 'fill-current' : '')} />}
          label={saved ? 'Saved' : 'Save'}
          active={saved}
          onClick={() => onSave?.(message)}
          alwaysVisible
          hovered={hover}
        />
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
      <ClipboardCheck className="size-3 shrink-0" aria-hidden />
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
  isCurrentUser,
  viewer,
  viewerAvatarObjectUrl,
  agent,
  agentAvatarObjectUrl,
  conversationId,
  routeKind,
  onNavigateAgent,
}: {
  isUser: boolean;
  /** True iff `from_user_id` resolves to the registered viewer (legacy
   *  null-author rows count as the viewer). Other-user messages would
   *  fall through to the placeholder. */
  isCurrentUser: boolean;
  /** Viewer's user row. When present + `isCurrentUser`, the avatar is
   *  wrapped in a `HumanInfoPopover` so hover gives the same identity
   *  card the chip strip and `@mention` show. */
  viewer: UserDto | undefined;
  viewerAvatarObjectUrl: string | null;
  agent: AgentDto | undefined;
  /** This message's authoring-agent avatar object URL, looked up by the
   *  parent from the workspace-wide `agentAvatarUrls` map. `null` falls
   *  back to the runtime icon. */
  agentAvatarObjectUrl: string | null;
  conversationId: string;
  routeKind: 'channel' | 'thread';
  onNavigateAgent: (agentId: string) => void;
}): JSX.Element {
  if (isUser) {
    const inner = isCurrentUser && viewerAvatarObjectUrl ? (
      <span
        className="mt-0.5 inline-block size-8 shrink-0 overflow-hidden rounded-none border border-border-subtle bg-bg-elevated"
        aria-hidden
      >
        {/* eslint-disable-next-line jsx-a11y/img-redundant-alt */}
        <img
          src={viewerAvatarObjectUrl}
          alt="Your avatar"
          className="size-full object-cover"
        />
      </span>
    ) : (
      <span
        className="mt-0.5 inline-flex size-8 shrink-0 items-center justify-center rounded-none border border-border-subtle bg-bg-elevated text-text-muted"
        aria-hidden
      >
        <User className="size-4" />
      </span>
    );
    if (isCurrentUser && viewer) {
      return (
        <HumanInfoPopover
          human={viewer}
          trigger="hover"
          avatarObjectUrl={viewerAvatarObjectUrl}
        >
          <button
            type="button"
            aria-label={`@${viewer.name}`}
            className="rounded-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-focus"
          >
            {inner}
          </button>
        </HumanInfoPopover>
      );
    }
    return inner;
  }
  if (agent) {
    return (
      <AgentInfoPopover
        agent={agent}
        conversationId={conversationId}
        routeKind={routeKind}
        trigger="hover"
        avatarObjectUrl={agentAvatarObjectUrl}
      >
        <button
          type="button"
          aria-label={`@${agent.name}`}
          onClick={event => {
            event.preventDefault();
            onNavigateAgent(agent.id);
          }}
          className="mt-0.5 rounded-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-focus"
        >
          <AgentAvatar
            runtime={agent.runtime}
            size={32}
            className="border border-border-subtle"
            avatarObjectUrl={agentAvatarObjectUrl}
            alt={agent.display_name || agent.name}
          />
        </button>
      </AgentInfoPopover>
    );
  }
  return (
    <span
      className="mt-0.5 inline-flex size-8 shrink-0 items-center justify-center rounded-none border border-border-subtle bg-bg-elevated text-text-muted"
      aria-hidden
    >
      <User className="size-4" />
    </span>
  );
}

/**
 * Header author label. Renders display name + the right popover trigger:
 * - agent → `<AgentInfoPopover>` (existing behavior)
 * - viewer-authored user message with viewer dto resolved →
 *   `<HumanInfoPopover>` so hover reveals the same identity card the
 *   member chip / `@mention` surfaces show
 * - everything else → plain span (legacy null-author rows, other humans
 *   we can't yet resolve in v1)
 */
function AuthorLabel({
  isUser,
  isCurrentUser,
  viewer,
  agent,
  conversationId,
  routeKind,
  agentAvatarObjectUrl,
  viewerAvatarObjectUrl,
  displayLabel,
  onNavigateAgent,
}: {
  isUser: boolean;
  isCurrentUser: boolean;
  viewer: UserDto | undefined;
  agent: AgentDto | undefined;
  conversationId: string;
  routeKind: 'channel' | 'thread';
  agentAvatarObjectUrl: string | null | undefined;
  viewerAvatarObjectUrl: string | null;
  displayLabel: string;
  onNavigateAgent: (agentId: string) => void;
}): JSX.Element {
  if (agent) {
    return (
      <AgentInfoPopover
        agent={agent}
        conversationId={conversationId}
        routeKind={routeKind}
        trigger="hover"
        avatarObjectUrl={agentAvatarObjectUrl}
      >
        <button
          type="button"
          onClick={event => {
            event.preventDefault();
            onNavigateAgent(agent.id);
          }}
          className="rounded font-medium text-accent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-border-focus"
        >
          {displayLabel}
        </button>
      </AgentInfoPopover>
    );
  }
  if (isUser && isCurrentUser && viewer) {
    return (
      <HumanInfoPopover
        human={viewer}
        trigger="hover"
        avatarObjectUrl={viewerAvatarObjectUrl}
      >
        <button
          type="button"
          className="rounded font-medium text-text-primary focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-border-focus"
        >
          {displayLabel}
        </button>
      </HumanInfoPopover>
    );
  }
  return (
    <span
      className={
        'font-medium ' + (isUser ? 'text-text-primary' : 'text-accent')
      }
    >
      {displayLabel}
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
      aria-label={label}
      className={
        'flex items-center gap-1 rounded-sm transition-colors transition-opacity focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-border-focus ' +
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
