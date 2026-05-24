import type { AgentDto, MessageDto, UserDto } from '@silverhand/shared';
import { User } from 'lucide-react';
import { AgentAvatar } from '@/components/AgentAvatar';
import { Markdown } from './Markdown';
import type { ChannelReference } from './ChannelRef';
import type { ConversationReference } from './ConversationRef';

/**
 * Static, NON-interactive renderer for the image-export pipeline.
 *
 * Deliberately does NOT reuse `MessageItem` because that component
 * carries per-row hover state, action buttons, popovers, TaskRef
 * interaction surfaces, and a bunch of branching that's irrelevant
 * to a screenshot. Every interaction prop is omitted here so the
 * rendered DOM contains zero event handlers — html-to-image is then
 * deterministic, can't trip over a stray `<button>` portal, and the
 * captured image is identical run-to-run.
 *
 * Per Cindy's review #6: lookup maps (agentsById, viewer,
 * channelsByName, etc.) are passed in EXPLICITLY rather than reaching
 * into hooks, so the screenshot view's dependencies are obvious and
 * an offscreen render in a different React tree still resolves
 * names/avatars consistently.
 *
 * What we render per row (per @shiki spec): avatar + display name +
 * absolute time + markdown body + attachment chips. NOT rendered:
 * reactions, saved indicator, hover bar, checkbox, thread-replies
 * badge, task tag, system rows.
 */
export function MessageScreenshotView({
  messages,
  agentsById,
  agentsByName,
  humansByName,
  channelsByName,
  conversationRefsById,
  agentAvatarUrls,
  viewer,
  viewerAvatarObjectUrl,
  channelTitle,
  channelKind,
}: {
  messages: readonly MessageDto[];
  agentsById: ReadonlyMap<string, AgentDto>;
  agentsByName: ReadonlyMap<string, AgentDto>;
  humansByName?: ReadonlyMap<string, UserDto>;
  channelsByName?: ReadonlyMap<string, ChannelReference | null>;
  conversationRefsById?: ReadonlyMap<string, ConversationReference>;
  agentAvatarUrls?: ReadonlyMap<string, string | null>;
  viewer?: UserDto;
  viewerAvatarObjectUrl?: string | null;
  channelTitle?: string | null;
  channelKind?: 'channel' | 'dm' | null;
}): JSX.Element {
  return (
    <div
      data-screenshot-root
      className="flex w-[760px] flex-col gap-3 bg-bg-floating p-6 text-text-primary"
    >
      {channelTitle ? (
        <div className="border-b border-border-subtle pb-2 text-sm font-semibold">
          {channelKind === 'dm' ? '@' : '#'}
          {channelTitle}
        </div>
      ) : null}
      {messages.map(m => (
        <ScreenshotRow
          key={m.id}
          message={m}
          agentsById={agentsById}
          agentsByName={agentsByName}
          humansByName={humansByName}
          channelsByName={channelsByName}
          conversationRefsById={conversationRefsById}
          agentAvatarUrls={agentAvatarUrls}
          viewer={viewer}
          viewerAvatarObjectUrl={viewerAvatarObjectUrl}
        />
      ))}
    </div>
  );
}

function ScreenshotRow({
  message,
  agentsById,
  agentsByName,
  humansByName,
  channelsByName,
  conversationRefsById,
  agentAvatarUrls,
  viewer,
  viewerAvatarObjectUrl,
}: {
  message: MessageDto;
  agentsById: ReadonlyMap<string, AgentDto>;
  agentsByName: ReadonlyMap<string, AgentDto>;
  humansByName?: ReadonlyMap<string, UserDto>;
  channelsByName?: ReadonlyMap<string, ChannelReference | null>;
  conversationRefsById?: ReadonlyMap<string, ConversationReference>;
  agentAvatarUrls?: ReadonlyMap<string, string | null>;
  viewer?: UserDto;
  viewerAvatarObjectUrl?: string | null;
}): JSX.Element {
  const isUser = message.from_kind === 'user';
  const agent = !isUser && message.from_agent_id
    ? agentsById.get(message.from_agent_id)
    : undefined;
  const isViewer = isUser && viewer && message.from_user_id === viewer.id;
  const senderName = isUser
    ? isViewer
      ? viewer.display_name?.trim() || viewer.name
      : message.from_user_id ?? 'user'
    : `@${agent?.display_name?.trim() || agent?.name || 'agent'}`;
  const time = formatExportTime(message.created_at);

  return (
    <div className="flex items-start gap-3">
      <ScreenshotAvatar
        isUser={!!isUser}
        isViewer={!!isViewer}
        agent={agent}
        agentAvatarObjectUrl={
          agent ? agentAvatarUrls?.get(agent.id) ?? null : null
        }
        viewerAvatarObjectUrl={viewerAvatarObjectUrl ?? null}
      />
      <div className="min-w-0 max-w-[640px] flex-1">
        <header className="mb-1 flex items-baseline gap-2 text-xs">
          <span
            className={
              'font-medium ' + (isUser ? 'text-text-primary' : 'text-accent')
            }
          >
            {senderName}
          </span>
          <span className="text-[11px] text-text-muted">{time}</span>
        </header>
        <div className="text-sm text-text-primary">
          {/* Reuse Markdown renderer but omit every interaction
              callback. Inline @-mention / #-channel pills still
              resolve via the explicit lookup maps; click handlers
              are intentionally absent so the captured DOM contains
              no buttons. */}
          <Markdown
            content={message.content}
            conversationId={message.conversation_id}
            agentsByName={new Map(agentsByName)}
            humansByName={humansByName ? new Map(humansByName) : undefined}
            agentAvatarUrls={
              agentAvatarUrls
                ? new Map(agentAvatarUrls)
                : undefined
            }
            channelsByName={
              channelsByName ? new Map(channelsByName) : undefined
            }
            conversationRefsById={
              conversationRefsById
                ? new Map(conversationRefsById)
                : undefined
            }
          />
          {message.attachments && message.attachments.length > 0 ? (
            <div className="mt-2 flex flex-wrap gap-2">
              {message.attachments.map(a => (
                <div
                  key={a.id}
                  className="inline-flex items-center gap-1 rounded-md border border-border-subtle bg-bg-elevated px-2 py-1 text-[11px] text-text-secondary"
                >
                  <span className="truncate max-w-[200px]">{a.filename}</span>
                  <span className="text-text-muted">
                    ({formatBytes(a.size)})
                  </span>
                </div>
              ))}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function ScreenshotAvatar({
  isUser,
  isViewer,
  agent,
  agentAvatarObjectUrl,
  viewerAvatarObjectUrl,
}: {
  isUser: boolean;
  isViewer: boolean;
  agent: AgentDto | undefined;
  agentAvatarObjectUrl: string | null;
  viewerAvatarObjectUrl: string | null;
}): JSX.Element {
  if (isUser) {
    if (isViewer && viewerAvatarObjectUrl) {
      return (
        <span
          className="inline-flex size-8 shrink-0 items-center justify-center overflow-hidden rounded-none border-[length:var(--border-avatar-width)] border-border-avatar bg-bg-elevated"
          aria-hidden
        >
          {/* eslint-disable-next-line jsx-a11y/img-redundant-alt */}
          <img
            src={viewerAvatarObjectUrl}
            alt="avatar"
            className="size-full object-cover"
            draggable={false}
          />
        </span>
      );
    }
    return (
      <span
        className="inline-flex size-8 shrink-0 items-center justify-center rounded-none border-[length:var(--border-avatar-width)] border-border-avatar bg-bg-elevated text-text-muted"
        aria-hidden
      >
        <User className="size-4" />
      </span>
    );
  }
  if (agent) {
    return (
      <AgentAvatar
        runtime={agent.runtime}
        size={32}
        className="border-[length:var(--border-avatar-width)] border-border-avatar"
        avatarObjectUrl={agentAvatarObjectUrl}
        alt={agent.display_name || agent.name}
      />
    );
  }
  return (
    <span
      className="inline-flex size-8 shrink-0 items-center justify-center rounded-none border-[length:var(--border-avatar-width)] border-border-avatar bg-bg-elevated text-text-muted"
      aria-hidden
    >
      <User className="size-4" />
    </span>
  );
}

function formatExportTime(epochMs: number): string {
  const d = new Date(epochMs);
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const mi = String(d.getMinutes()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd} ${hh}:${mi}`;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(1)} GB`;
}
