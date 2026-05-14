import { AtSign, CornerDownRight, Hash } from 'lucide-react';
import { HoverPopover } from './HoverPopover';
import {
  useConversationById,
  type ConversationByIdStatus,
} from '@/features/conversations/useConversationById';

export interface ConversationReference {
  id: string;
  kind: 'channel' | 'dm_channel' | 'thread';
  title: string;
  parent_channel_id?: string | null;
  parent_title?: string | null;
}

interface ConversationRefProps {
  /** Raw conversation id from `#conv:<id>`. */
  id: string;
  /** Current-workspace metadata when available. Acts as a synchronous
   *  fast path — avoids a brief loading flash on chips that point at a
   *  channel/thread already in the current workspace's lookup map. The
   *  authoritative source is `useConversationById(id)` below, which
   *  also handles cross-workspace refs the lookup map can't see. */
  conversation: ConversationReference | undefined;
  onOpen?: (id: string) => void;
}

/**
 * Inline rendering of a `#conv:<conversation_id>` reference.
 *
 * Unlike `#name`, this is id-addressed and intentionally clickable even
 * when metadata is unavailable: the side pane can surface the unresolved
 * placeholder instead of silently dropping a reference.
 *
 * Resolution: `useConversationById(id)` is the authoritative source of
 * conversation metadata. The optional `conversation` prop is a
 * synchronous fast path that avoids a loading flash when the id is
 * already in the current-workspace channels map (PR-2 review by
 * @Cindy on commit 3 — the prop alone fails for any cross-workspace
 * `#conv:<id>` since the map is workspace-scoped). React Query
 * dedupes the underlying GET so adding this hook to every chip
 * doesn't multiply network calls.
 *
 * Hover ≥500ms surfaces a popover with the conversation's full
 * metadata. Loading shows a skeleton; 403/404 from the cross-
 * workspace endpoint render an explicit "unavailable" body so we
 * never sit on a forever-skeleton popover.
 */
export function ConversationRef({
  id,
  conversation,
  onOpen,
}: ConversationRefProps): JSX.Element {
  const hookResult = useConversationById(id);
  // Prefer the prop (current-workspace fast path) over the hook
  // result; both shapes are fine, the prop just avoids a loading
  // flash for the common case.
  const resolved: ConversationReference | null =
    conversation ??
    (hookResult.status === 'resolved' && hookResult.ref
      ? {
          id: hookResult.ref.id,
          kind: hookResult.ref.kind,
          title: hookResult.ref.title,
          parent_channel_id: hookResult.ref.parent_channel_id,
          parent_title: hookResult.ref.parent_title,
        }
      : null);
  // Three-state for popover purposes:
  //   - 'resolved'    → render real metadata
  //   - 'unavailable' → 403 / 404, render explicit body (NOT skeleton —
  //                     a forever-skeleton popover is what Cindy review
  //                     of `45fca42` flagged on cross-workspace ids)
  //   - 'loading'     → skeleton via HoverPopover.isContentReady=false
  const popoverStatus: 'resolved' | 'unavailable' | 'loading' = resolved
    ? 'resolved'
    : hookResult.status === 'not_found' || hookResult.status === 'unauthorized'
      ? 'unavailable'
      : 'loading';

  const label = resolved
    ? conversationDisplayName(resolved)
    : `#conv:${shortConversationId(id)}`;
  const tooltip = resolved
    ? `${kindLabel(resolved.kind)} · ${conversationDisplayName(resolved)}`
    : `Open conversation #conv:${id}`;
  const icon = conversationIcon(resolved?.kind);
  const chipBody = (
    <>
      {icon}
      <span className="truncate">{label}</span>
    </>
  );

  const inertChip = (
    <span
      className="inline-flex max-w-[220px] items-center gap-0.5 rounded bg-bg-elevated px-1.5 -mx-0.5 font-medium text-text-muted"
      // Wrapped in HoverPopover below — `aria-label` instead of the
      // native `title` attribute. macOS browsers schedule the native
      // tooltip on a 2-3s cycle that competes with Radix HoverCard
      // (the OS tooltip overlays the trigger area, mouse "leaves" the
      // trigger → popover closes; mouseenter reopens after the 500ms
      // grace, producing a periodic flicker — @shiki report
      // `NbcXUOnFDKfXYRxV`).
      aria-label={tooltip}
      data-conversation-ref={id}
    >
      {chipBody}
    </span>
  );

  const interactiveChip = (
    <span
      role="button"
      tabIndex={0}
      className="inline-flex max-w-[220px] cursor-pointer items-center gap-0.5 rounded bg-accent-soft px-1.5 -mx-0.5 font-medium text-accent transition-colors hover:bg-accent hover:text-text-on-accent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-border-focus"
      aria-label={tooltip}
      data-conversation-ref={id}
      onClick={event => {
        event.preventDefault();
        event.stopPropagation();
        onOpen?.(id);
      }}
      onKeyDown={event => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        event.stopPropagation();
        onOpen?.(id);
      }}
    >
      {chipBody}
    </span>
  );

  const popoverContent =
    popoverStatus === 'resolved' && resolved ? (
      <ConversationPopoverBody id={id} conversation={resolved} />
    ) : popoverStatus === 'unavailable' ? (
      <UnresolvedConversationPopoverBody
        id={id}
        reason={hookResult.status as ConversationByIdStatus}
      />
    ) : null;

  return (
    <HoverPopover
      trigger={onOpen ? interactiveChip : inertChip}
      content={popoverContent}
      isContentReady={popoverStatus !== 'loading'}
    />
  );
}

/**
 * Popover body for resolved conversation refs — kind, full title,
 * parent (threads), and the id (small + monospace) so the user can
 * eyeball-match the reference if needed.
 */
function ConversationPopoverBody({
  id,
  conversation,
}: {
  id: string;
  conversation: ConversationReference;
}): JSX.Element {
  return (
    <div className="space-y-2">
      <div className="flex items-baseline gap-2">
        <span className="rounded bg-bg-elevated px-1 py-0.5 text-[9px] font-medium uppercase tracking-wide text-text-muted">
          {kindLabel(conversation.kind)}
        </span>
      </div>
      <p className="line-clamp-2 break-words text-xs font-medium text-text-primary">
        {conversation.title}
      </p>
      {conversation.kind === 'thread' && conversation.parent_title ? (
        <dl className="grid grid-cols-[auto_1fr] gap-x-2 gap-y-1 text-[11px]">
          <dt className="text-text-muted">In</dt>
          <dd
            className="truncate text-text-secondary"
            title={conversation.parent_title}
          >
            #{conversation.parent_title}
          </dd>
        </dl>
      ) : null}
      <p
        className="truncate font-mono text-[10px] text-text-muted"
        title={id}
      >
        {id}
      </p>
    </div>
  );
}

/**
 * Popover for refs where the backend said 403 or 404 — clicking the
 * chip still opens the side pane (which renders its own placeholder),
 * so the popover only documents the id and the reason we couldn't
 * resolve. Visible state is "decided" — `isContentReady=true` — so
 * the user gets a clear "unavailable" message instead of a forever-
 * skeleton. Cindy review of commit 3.
 */
function UnresolvedConversationPopoverBody({
  id,
  reason,
}: {
  id: string;
  reason: ConversationByIdStatus;
}): JSX.Element {
  const message =
    reason === 'unauthorized'
      ? "You don't have access to this conversation in its workspace."
      : reason === 'not_found'
        ? 'Conversation not found — it may have been deleted.'
        : 'Conversation metadata not available.';
  return (
    <div className="space-y-2">
      <p className="text-xs text-text-muted">{message}</p>
      <p
        className="truncate font-mono text-[10px] text-text-muted"
        title={id}
      >
        {id}
      </p>
    </div>
  );
}

export function shortConversationId(id: string): string {
  return id.length > 16 ? `${id.slice(0, 6)}...${id.slice(-4)}` : id;
}

function conversationDisplayName(conversation: ConversationReference): string {
  if (conversation.kind === 'thread') {
    const parentTitle = conversation.parent_title?.trim();
    return parentTitle
      ? `${parentTitle}:${conversation.title}`
      : conversation.title;
  }
  return conversation.title;
}

function kindLabel(kind: ConversationReference['kind']): string {
  if (kind === 'thread') return 'Thread';
  if (kind === 'dm_channel') return 'DM';
  return 'Channel';
}

function conversationIcon(kind: ConversationReference['kind'] | undefined): JSX.Element {
  if (kind === 'thread') {
    return <CornerDownRight className="size-3 shrink-0 self-center" />;
  }
  if (kind === 'dm_channel') {
    return <AtSign className="size-3 shrink-0 self-center" />;
  }
  return <Hash className="size-3 shrink-0 self-center" />;
}
