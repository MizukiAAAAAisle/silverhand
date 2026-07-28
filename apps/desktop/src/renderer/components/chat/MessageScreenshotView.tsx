import type {
  AgentDto,
  AttachmentSnapshot,
  MessageDto,
  UserDto,
} from '@silverhand/shared';
import { resolveAttachmentLabels } from '@silverhand/shared';
import { FileText, Hash, User } from 'lucide-react';
import { AgentAvatar } from '@/components/AgentAvatar';
import { AVATAR_PX } from '@/components/avatar-scale';
import { getAttachmentBlobUrl } from '@/lib/attachment-blob-cache';
import { Markdown } from './Markdown';
import { MessageRowContent } from './MessageRowContent';
import { ReactionChipRow } from './ReactionChipRow';
import type { ChannelReference } from './ChannelRef';
import type { ConversationReference } from './ConversationRef';
import type { StaticTaskRefSummary } from './TaskRef';

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
 * absolute time + markdown body + attachment chips + reaction chips.
 * Reactions go through the SAME `ReactionChipRow` primitive as the live
 * row (#task:1173) — a static, button/hook/portal-free variant — so a
 * reaction visible in chat is always visible in the screenshot too.
 * NOT rendered (interactive affordances, not default-visible content):
 * saved indicator, hover bar, checkbox, thread-replies badge, task tag,
 * system rows.
 */
export function MessageScreenshotView({
  messages,
  agentsById,
  agentsByName,
  humansByName,
  channelsByName,
  conversationRefsById,
  taskRefsByNumber,
  agentAvatarUrls,
  attachmentImageUrls,
  viewer,
  viewerAvatarObjectUrl,
  channelTitle,
  mermaidSvgByCode,
}: {
  messages: readonly MessageDto[];
  agentsById: ReadonlyMap<string, AgentDto>;
  agentsByName: ReadonlyMap<string, AgentDto>;
  humansByName?: ReadonlyMap<string, UserDto>;
  channelsByName?: ReadonlyMap<string, ChannelReference | null>;
  conversationRefsById?: ReadonlyMap<string, ConversationReference>;
  taskRefsByNumber?: ReadonlyMap<number, StaticTaskRefSummary>;
  agentAvatarUrls?: ReadonlyMap<string, string | null>;
  attachmentImageUrls?: ReadonlyMap<string, string>;
  viewer?: UserDto;
  viewerAvatarObjectUrl?: string | null;
  channelTitle?: string | null;
  /** Mermaid diagrams pre-rendered to SVG before capture (#task:1322), keyed
   *  by trimmed source. Threaded into each row's Markdown so the export shows
   *  rendered diagrams; a diagram absent here falls back to source. */
  mermaidSvgByCode?: ReadonlyMap<string, string>;
}): JSX.Element {
  const safeChannelTitle = channelTitle
    ? sanitizeScreenshotText(channelTitle)
    : null;
  return (
    <div
      data-screenshot-root
      className="flex w-[760px] flex-col gap-3 bg-bg-floating p-6 text-text-primary"
    >
      {safeChannelTitle ? (
        <div className="border-b border-border-subtle pb-2 text-sm font-semibold">
          {/* Every conversation header carries the channel `#` — channel and DM
              alike (matching the live header, #task:1179). No branch: a
              channel-like conversation always earns it (#task:1373). Painted per
              theme via `[data-conversation-hash-icon]` (forza6 = poster
              sticker). */}
          <span
            data-conversation-title
            className="inline-flex items-center font-serif text-base font-semibold text-text-primary"
          >
            <Hash
              data-conversation-hash-icon
              className="size-4 shrink-0 align-[-0.15em]"
            />
            {safeChannelTitle}
          </span>
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
          taskRefsByNumber={taskRefsByNumber}
          agentAvatarUrls={agentAvatarUrls}
          attachmentImageUrls={attachmentImageUrls}
          viewer={viewer}
          viewerAvatarObjectUrl={viewerAvatarObjectUrl}
          mermaidSvgByCode={mermaidSvgByCode}
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
  taskRefsByNumber,
  agentAvatarUrls,
  attachmentImageUrls,
  viewer,
  viewerAvatarObjectUrl,
  mermaidSvgByCode,
}: {
  message: MessageDto;
  agentsById: ReadonlyMap<string, AgentDto>;
  agentsByName: ReadonlyMap<string, AgentDto>;
  humansByName?: ReadonlyMap<string, UserDto>;
  channelsByName?: ReadonlyMap<string, ChannelReference | null>;
  conversationRefsById?: ReadonlyMap<string, ConversationReference>;
  taskRefsByNumber?: ReadonlyMap<number, StaticTaskRefSummary>;
  agentAvatarUrls?: ReadonlyMap<string, string | null>;
  attachmentImageUrls?: ReadonlyMap<string, string>;
  viewer?: UserDto;
  viewerAvatarObjectUrl?: string | null;
  mermaidSvgByCode?: ReadonlyMap<string, string>;
}): JSX.Element {
  const isUser = message.from_kind === 'user';
  const agent = !isUser && message.from_agent_id
    ? agentsById.get(message.from_agent_id)
    : undefined;
  const isViewer = isUser && viewer && message.from_user_id === viewer.id;
  const senderName = sanitizeScreenshotText(
    isUser
      ? isViewer
        ? viewer.display_name?.trim() || viewer.name
        : message.from_user_id ?? 'user'
      : `@${agent?.display_name?.trim() || agent?.name || 'agent'}`,
  );
  const time = formatExportTime(message.created_at);
  const content = sanitizeScreenshotText(message.content);

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
      {/* Shared content layer (#task:1173 P1). The export fills each required
          slot with a STATIC node and passes `null` for the live-only
          adornments (header task tag, thread badge) — making its deliberate
          omission explicit. A new default-visible adornment added to the
          shared registry won't compile here until the export declares it. */}
      <MessageRowContent
        alignRight={false}
        columnClassName="min-w-0 max-w-[640px] flex-1"
        author={
          <span
            className={
              'font-medium ' + (isUser ? 'text-text-primary' : 'text-accent')
            }
          >
            {senderName}
          </span>
        }
        timestamp={<span className="text-[11px] text-text-muted">{time}</span>}
        taskTag={null}
        body={
          /* Reuse Markdown renderer but omit every interaction callback.
             Inline @-mention / #-channel pills still resolve via the explicit
             lookup maps; click handlers are intentionally absent so the
             captured DOM contains no buttons. */
          <Markdown
            content={content}
            conversationId={message.conversation_id}
            agentsByName={new Map(agentsByName)}
            humansByName={humansByName ? new Map(humansByName) : undefined}
            agentAvatarUrls={agentAvatarUrls ? new Map(agentAvatarUrls) : undefined}
            channelsByName={channelsByName ? new Map(channelsByName) : undefined}
            conversationRefsById={
              conversationRefsById ? new Map(conversationRefsById) : undefined
            }
            taskRefsByNumber={
              taskRefsByNumber ? new Map(taskRefsByNumber) : undefined
            }
            interactive={false}
            mermaidSvgByCode={mermaidSvgByCode}
          />
        }
        attachments={
          message.attachments && message.attachments.length > 0 ? (
            <ScreenshotAttachmentList
              attachments={message.attachments}
              imageUrls={attachmentImageUrls}
            />
          ) : null
        }
        reactions={
          message.reactions && message.reactions.length > 0 ? (
            <ReactionChipRow reactions={message.reactions} />
          ) : null
        }
        trailing={null}
      />
    </div>
  );
}

function ScreenshotAttachmentList({
  attachments,
  imageUrls,
}: {
  attachments: AttachmentSnapshot[];
  imageUrls?: ReadonlyMap<string, string>;
}): JSX.Element {
  // Same shared resolver as the live tile + agent suffix, so an exported image
  // shows the identical `Image #N` references (#task:1324).
  const labels = resolveAttachmentLabels(attachments);
  return (
    <div className="mt-2 flex flex-wrap gap-2">
      {attachments.map((attachment, i) => (
        <ScreenshotAttachmentTile
          key={attachment.id}
          attachment={attachment}
          label={labels[i]}
          imageUrl={
            attachment.content_type.startsWith('image/')
              ? imageUrls?.get(attachment.id) ??
                getAttachmentBlobUrl(attachment.id)
              : undefined
          }
        />
      ))}
    </div>
  );
}

function ScreenshotAttachmentTile({
  attachment,
  label,
  imageUrl,
}: {
  attachment: AttachmentSnapshot;
  label?: string;
  imageUrl?: string;
}): JSX.Element {
  const isImage = attachment.content_type.startsWith('image/');
  const filename = sanitizeScreenshotText(attachment.filename);
  const labelBadge = label ? (
    <span className="block w-full text-center font-mono text-[10px] text-text-muted">
      {label}
    </span>
  ) : null;
  if (isImage && imageUrl) {
    return (
      <figure className="flex flex-col gap-1">
        <span className="block overflow-hidden rounded-md border border-border-subtle bg-bg-floating">
          <img
            src={imageUrl}
            alt={filename}
            className="block max-h-64 max-w-[320px] object-contain"
            draggable={false}
          />
        </span>
        {labelBadge}
      </figure>
    );
  }
  return (
    <div className="flex flex-col items-start gap-1">
      <div className="flex max-w-[280px] items-center gap-2 rounded-md border border-border-subtle bg-bg-floating px-2 py-1.5 text-xs text-text-secondary">
        <FileText className="size-4 shrink-0 text-text-muted" />
        <span className="min-w-0 truncate">{filename}</span>
        <span className="shrink-0 text-[10px] text-text-muted">
          {formatBytes(attachment.size)}
        </span>
      </div>
      {labelBadge}
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
          data-avatar-ground
          className="inline-flex size-8 shrink-0 items-center justify-center overflow-hidden rounded-none border-[length:var(--border-avatar-width)] border-border-avatar"
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
        data-avatar-ground
        className="inline-flex size-8 shrink-0 items-center justify-center rounded-none border-[length:var(--border-avatar-width)] border-border-avatar text-text-muted"
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
        size={AVATAR_PX.lg}
        className="border-[length:var(--border-avatar-width)] border-border-avatar"
        avatarObjectUrl={agentAvatarObjectUrl}
        alt={sanitizeScreenshotText(agent.display_name || agent.name)}
      />
    );
  }
  return (
    <span
      data-avatar-ground
      className="inline-flex size-8 shrink-0 items-center justify-center rounded-none border-[length:var(--border-avatar-width)] border-border-avatar text-text-muted"
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

// html-to-image serializes the offscreen DOM through an SVG foreignObject.
// XML 1.0 forbids most C0/C1 control characters; a single pasted backspace
// (`\b`) in message text can make the generated `data:image/svg+xml` fail to
// load. Keep the live message untouched and only strip those invisible controls
// in the static export tree. Preserve whitespace controls that XML allows.
const XML_INVALID_CONTROL_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g;

function sanitizeScreenshotText(value: string): string {
  return value.replace(XML_INVALID_CONTROL_RE, '');
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(1)} GB`;
}
