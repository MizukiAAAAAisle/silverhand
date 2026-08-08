import { type FocusEvent, useCallback, useEffect, useRef, useState } from 'react';
import dayjs from 'dayjs';
import relativeTime from 'dayjs/plugin/relativeTime';
import { Bookmark, Check, Clock, Download, FileText, SmilePlus } from 'lucide-react';
import type {
  AgentDto,
  AttachmentSnapshot,
  MessageAuthorDto,
  ReplyBadgeSummary,
  StreamUnreadDto,
  TaskAssigneeDto,
  ThreadReplyPreviewRow,
  UserDto,
} from '@silverhand/shared';
import { resolveAttachmentLabels } from '@silverhand/shared';
import { ThreadIcon } from '@/components/icons/conversation-icons';
import { AVATAR_PX } from '@/components/avatar-scale';
import { AgentInfoPopover } from '@/components/AgentInfoPopover';
import { HumanInfoPopover } from '@/components/HumanInfoPopover';
import { useNav } from '@/router';
import {
  getAttachmentBlobUrl,
  loadAttachmentBlobUrl,
  useAttachmentBlobToken,
} from '@/lib/attachment-blob-cache';
import {
  formatUserDisplayName,
  isCurrentUserId,
  type UserNameResolver,
} from '@/lib/current-user';
import { Lightbox } from './Lightbox';
import { saveAttachmentToDisk } from './save-attachment';
import { openAttachmentExternally } from './open-attachment';
import { Markdown } from './Markdown';
import { presentAuthor, authorStateLabel, classifyRowAuthor, type AuthorPresentation } from './author-presentation';
import { AuthorAvatarView, AuthorName } from './author-avatar-view';
import type { ChannelReference } from './ChannelRef';
import type { ConversationReference } from './ConversationRef';
import { MessageContextMenu } from './MessageContextMenu';
import type { CachedMessage } from '@/features/channels/pending-message';
import { isCommittedMessage } from '@/features/channels/pending-message';
import { MessageReactions } from './MessageReactions';
import { MessageRowContent } from './MessageRowContent';
import {
  ThreadReplyPreview,
  visibleThreadReplyRows,
} from './ThreadReplyPreview';
import { ReactionPicker } from './ReactionPicker';
import { StatusPicker, taskStatusLabel, TASK_STATUS_ICON } from '@/components/tasks/TaskStatusBadge';
import { useUpdateTaskStatus } from '@/features/tasks/hooks';
import { useToggleReaction } from '@/features/channels/reaction-hooks';
import { useMessageLayoutMode } from './useMessageLayoutMode';

// Idempotent — the reply badge's "{time} ago" label uses dayjs.fromNow().
// Other modules (useRelativeTime) extend the same plugin; re-extending is a
// no-op, so doing it here keeps MessageItem self-contained.
dayjs.extend(relativeTime);

export interface MessageItemProps {
  message: CachedMessage;
  /** Conversation this message belongs to. Forwarded to AgentInfoPopover so
   *  the author/avatar popover can show per-conversation presence + retry. */
  conversationId: string;
  /** Looked up by `from_agent_id` to resolve display name + runtime
   *  (avatar) and also by mention name (via `agentsByName`). */
  agentsById: Map<string, AgentDto>;
  /** Lookup by `agent.name` (the @mention handle). Threaded to the
   *  Markdown component so inline `@handle` references can resolve. */
  agentsByName: Map<string, AgentDto>;
  /** Lookup by `user.name` in the same @mention namespace as agents. */
  humansByName?: Map<string, UserDto>;
  /** Lookup by `users.id`, used to resolve user-authored message rows. */
  humansById?: Map<string, UserDto>;
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
  onStartThread?: (msg: CachedMessage, jumpToMessageId?: string) => void;
  /** When this message has an open thread anchored to it, the count of
   *  non-system replies in that thread. Drives the button label
   *  `{count} Reply` (clicking opens the existing thread instead of
   *  creating a new one — handler short-circuits the POST). Undefined
   *  = no thread, button shows "Thread". */
  threadReplyCount?: number;
  /** Enriched reply-badge data for this root (P1, #task:1073). When present
   *  the inline badge upgrades from "{N} Replies" to a Slack-style strip:
   *  stacked replier avatars + count + last-reply time. Absent → count-only
   *  fallback (driven by `threadReplyCount`). */
  threadReplySummary?: ReplyBadgeSummary;
  /** Per-viewer server-scored unread for this root's reply-cluster, from the
   *  `useConversationUnread` read-model (#task:1226). The SINGLE source of the
   *  chip's "N new" + jump-to-first-unread — unread is server-scored and no
   *  longer lives in `threadReplySummary` (which keeps only the optimistically
   *  patchable count / last-reply / repliers). Absent / sparse-missing ⇒ 0. */
  threadUnread?: StreamUnreadDto;
  /** Most recent replies of this root's cluster (at most 3, ascending time),
   *  rendered as one line each under the row (#task:1745). Mainline-only: the
   *  ThreadPanel shows the real replies, so it never passes this. Absent ⇒ no
   *  preview block, which is also the degradation when the backend sidecar
   *  (#task:1746) is not present — the chip alone stays correct.
   *
   *  READ-INERT: rendering it advances no cursor (`docs/thread-unread-v1.md`
   *  §6 / invariant 2). See `ThreadReplyPreview`. */
  threadReplyPreviews?: ThreadReplyPreviewRow[];
  onSave?: (msg: CachedMessage) => void;
  saved?: boolean;
  /** Whether the viewer may add/remove reactions here. False in a closed or
   *  archived (read-only) channel: the backend rejects the write, so the
   *  React entry, the inline add chip, and chip click-to-toggle are hidden —
   *  existing reaction chips stay visible as display-only counts
   *  (#task:1122 dogfood follow-up). */
  canReact?: boolean;
  /** Whether the viewer is a member who may perform member-only per-message
   *  actions: START a new thread (the hover "Thread" button) and EXPORT an
   *  attachment (download / open-external). Defaults to `true`; `false` for a
   *  non-member browsing a public channel. Opening an EXISTING
   *  thread (the reply badge) and inline attachment PREVIEW stay available —
   *  those are reads. Save/unsave is gated separately via `onSave` (undefined
   *  hides it). */
  canParticipate?: boolean;
  /** Whether the viewer may WRITE the linked task's status from its inline
   *  chip (the "Move to" picker). The write axis, mirroring `canReact`:
   *  `true` only for a member of an open channel. Defaults to `false`
   *  (fail-closed) — a non-member browsing a public channel, or any read-only
   *  surface (screenshot / saved / search preview), still SEES the chip with
   *  identical look + content, but the status picker is inert. Reading the
   *  task's state is public; only the mutation entry is member-gated. */
  canMutateLinkedTask?: boolean;
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
  /** Byline + thread-replier avatar bytes, derived by the parent pane STRICTLY
   *  from the rendered rows' own `MessageAuthorDto`s (#task:1792 B2) via
   *  `useAuthorAvatarObjectUrls` — never a live-directory join. Split by kind.
   *  Only the active author arm carries `avatar_url`, so a deleted / unresolved
   *  author draws its neutral glyph with no lookup and an active author whose
   *  account has left the directory still renders its own snapshot avatar. */
  authorAgentAvatarUrls?: Map<string, string | null>;
  authorUserAvatarUrls?: Map<string, string | null>;
  /** Directory-backed agent avatar batch (workspace `useAgents`), for the
   *  INDEPENDENT axis of inline `@handle` mention pills inside the Markdown
   *  body — a different actor reference than the row's own author. Missing
   *  entries / `null` fall back to the runtime icon. */
  agentAvatarUrls?: Map<string, string | null>;
  /** Persistently render the hover frame around this row — used by the
   *  parent pane to mark "the message a thread is anchored to" while
   *  the thread pane is open. Doesn't expose the action bar, since the
   *  highlight is informational, not interactive. */
  highlighted?: boolean;
  /** Render this row as a CONTINUATION of the message above it — the second and
   *  later rows of a consecutive-same-author run (#task:1737). The avatar and
   *  the author name drop out (the group head already said who), the row's
   *  vertical padding tightens so the run reads as one block, and this row's
   *  timestamp moves into the leading rail where hover reveals it. The decision
   *  is NOT made here: it comes from `authorGroupContinuations`, which is the
   *  single rule shared by the channel stream and the ThreadPanel. Defaults to
   *  false — a row with no known predecessor renders its full header. */
  continuesPrevious?: boolean;
  /** One-shot "jump flash": render the `.msg-jump-flash` animation class
   *  on this row. Declarative (not an imperative `classList.add`) so the
   *  flash survives a Virtuoso remount / refetch-driven window reset — the
   *  failure mode that swallowed the flash when the jump target was already
   *  on-screen (#task:1076). Whichever DOM node renders this id picks the
   *  class up from props and plays the animation from the start. */
  jumpFlash?: boolean;
  /** When the parent's MessageList is in multi-select mode this row
   *  renders a checkbox column on the leading side (mirrored when
   *  `alignRight`). Idle mode: no checkbox, no extra column. */
  selectionMode?: boolean;
  /** Whether this row is currently in the selection set. Drives the
   *  checkbox visual + the row's selected highlight. */
  selected?: boolean;
  /** Toggle this row's selection membership. Required whenever
   *  `selectionMode` is true. */
  onToggleSelected?: (msg: CachedMessage) => void;
  /** Right-click → Copy markdown menu item. Hidden when undefined. */
  onCopyMarkdown?: (msg: CachedMessage) => void;
  /** Right-click → Share… menu item. Hidden when undefined; the
   *  parent only passes this in once the export pipeline is live so
   *  the user never sees a half-baked Share entry (Cindy review). */
  onShare?: (msg: CachedMessage) => void;
  /** Right-click → "Unfollow thread" menu item. Passed in only by the
   *  ThreadPanel and only while the human viewer is following this reply
   *  cluster, so the entry never appears on main-line rows or unfollowed
   *  threads (item 5). */
  onUnfollowThread?: (msg: CachedMessage) => void;
  /** Resolve a `user_id` → display name for surfaces that don't already
   *  carry the user dto (task assignees, foreign-author fallback). Built
   *  by the parent from `useUsersById()` (multi-human audit 2026-06-03
   *  #task:857 P0.10). Optional — when absent, formatUserDisplayName
   *  falls back to the raw id, matching v1 behaviour. */
  userResolver?: UserNameResolver;
  /** In-conversation header find (#task:1335). When set, every occurrence of
   *  this term in the row's markdown body is highlighted (`<mark>`). Threaded
   *  straight to `<Markdown>`. Empty / absent → no highlight. */
  searchQuery?: string;
  /** This row is the CURRENT prev/next find match: it takes the framed look
   *  (same `border-accent bg-bg-floating` as `highlighted`) and its keyword
   *  marks read as "current" via the `data-search-active` hook. */
  searchActive?: boolean;
}

/**
 * Renders a non-system message (user or agent) as a hoverable row with
 * markdown body, role-name + absolute time header, and a Slack-style
 * pair of action affordances:
 *
 * - **Frame-corner action controls** (Save + Thread) — absolutely
 *   pinned to the top-right of the OUTER hover frame (mirrored to
 *   top-left in user-right mode), each rendered as an icon-only
 *   button using `ActionButton` (the label survives as `title` +
 *   `aria-label` for tooltip / screen readers). They sit on the
 *   framed card, NOT over the markdown body. Default hidden via
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
/**
 * The message row's HOOKS-FREE classifier boundary (#task:1792, Cindy). It runs
 * NO hooks and switches on the actor-row classification, so the actor arm mounts
 * a distinct component (`ActorMessageItem`) that always runs a fixed hook set. A
 * carrier that hydrates `null → actor` for the same message key is then a clean
 * unmount→mount across component TYPES — never a changing hook count on one
 * instance (which React rejects with "Rendered more hooks than during the
 * previous render"). A conditional early-return inside the hook-bearing body
 * could not give that guarantee once `missing` (carrier absent) is reachable.
 *
 *  - `actor`   → the full row.
 *  - `system`  → nothing. The list/thread parents already route `from_kind ===
 *                'system'` to SystemMessage, so this arm is unreachable here; it
 *                stays inert rather than inventing a system byline.
 *  - `missing` → a fail-closed diagnostic (carrier absent, or a raw-vs-DTO kind
 *                mismatch). Never fabricates an identity, and is not the actor
 *                hook lifecycle.
 */
export function MessageItem(props: MessageItemProps): JSX.Element | null {
  const rowAuthor = classifyRowAuthor(
    props.message.from_kind,
    props.message.author,
  );
  if (rowAuthor.kind === 'actor') {
    return <ActorMessageItem {...props} author={rowAuthor.author} />;
  }
  if (rowAuthor.kind === 'missing') {
    return <MissingAuthorRow message={props.message} reason={rowAuthor.reason} />;
  }
  return null; // 'system' — parents route these to SystemMessage.
}

/**
 * The fail-closed path for a row whose author carrier is a data-contract breach
 * — absent for a non-system row, or a `from_kind`/`author.kind` mismatch
 * (#task:1792, Alice + Cindy). Neither is reachable on a healthy path (the
 * resolver derives `author.kind` from `from_kind`, and every non-system message
 * carries a resolved author), so this is a defensive surface, not a display
 * state. It is its OWN component so it never shares `ActorMessageItem`'s hook
 * lifecycle, and it makes the breach OBSERVABLE at the boundary (a logged
 * contract violation) instead of hiding the row as a silent gap — while still
 * refusing to fabricate the name / avatar the removed `?? unresolvedAuthorFor`
 * used to invent. There is deliberately no user-facing identity for an
 * unreachable corruption state; the signal is for whoever broke the contract.
 */
function MissingAuthorRow({
  message,
  reason,
}: {
  message: CachedMessage;
  reason: 'absent' | 'kind-mismatch';
}): null {
  useEffect(() => {
    console.error(
      `[MessageItem] actor row ${message.id} has no presentable author ` +
        `(${reason}); rendered inert. from_kind=${message.from_kind}`,
    );
  }, [message.id, message.from_kind, reason]);
  return null;
}

/** The actor-row author + all shared props. `author` is the NON-NULL resolved
 *  DTO the wrapper narrowed to (active / deleted / unresolved); this component
 *  never sees `null`, so it runs a FIXED hook set unconditionally. */
type ActorMessageItemProps = MessageItemProps & { author: MessageAuthorDto };

function ActorMessageItem({
  message,
  author,
  conversationId,
  agentsById,
  agentsByName,
  humansByName,
  humansById,
  channelsByName,
  onOpenChannelRef,
  conversationRefsById,
  onOpenConversationRef,
  onStartThread,
  threadReplyCount,
  threadReplySummary,
  threadUnread,
  threadReplyPreviews,
  onSave,
  saved = false,
  canReact = true,
  canParticipate = true,
  canMutateLinkedTask = false,
  highlighted = false,
  continuesPrevious = false,
  jumpFlash = false,
  viewerAvatarObjectUrl = null,
  viewer,
  authorAgentAvatarUrls,
  authorUserAvatarUrls,
  agentAvatarUrls,
  selectionMode = false,
  selected = false,
  onToggleSelected,
  onCopyMarkdown,
  onShare,
  onUnfollowThread,
  userResolver,
  searchQuery,
  searchActive = false,
}: ActorMessageItemProps): JSX.Element {
  const isUser = message.from_kind === 'user';
  // A pending optimistic row has no server id/seq: every action that needs a
  // real server row (reaction, thread, save, share, copy, select) is not just
  // no-op'd in the handler — its affordance is not rendered at all, so the row
  // reads as "not operable yet" instead of showing a dead button (#task:1267
  // slice B, Cindy review). The action-surface handlers keep their committed
  // guard as defense-in-depth, but rendering is gated here.
  const committed = isCommittedMessage(message);
  const isCurrentUser = isUser && isCurrentUserId(message.from_user_id);
  const mode = useMessageLayoutMode();
  const alignRight = mode === 'user-right' && isCurrentUser;
  // Identity / label / avatar all read the server-authoritative author DTO
  // (#task:1792) — NEVER a live-directory re-join by `from_*_id`, which loses a
  // hard-deleted actor's name and would guess "deleted" from a roster miss. The
  // DTO carries a send-time snapshot, so a deleted author stays named + marked;
  // an `unresolved` author (no FK, no snapshot) is a neutral "Unknown …". Raw
  // provenance (`from_user_id`) still drives viewer→"you" alignment above — that
  // is about the CURRENT viewer, not the author's display identity.
  const presentation = presentAuthor(author);
  // The live actor row is looked up ONLY for an active author's hover popover
  // (presence + retry need the full dto). A deleted / unresolved author has no
  // live row and no profile to open, so neither is fetched. The viewer's own
  // row wins for a self-send so the popover matches the member chip.
  const liveAgent =
    presentation.status === 'active' && presentation.kind === 'agent'
      ? agentsById.get(presentation.navigableId ?? '')
      : undefined;
  const liveHuman =
    presentation.status === 'active' && presentation.kind === 'user'
      ? isCurrentUser
        ? viewer ?? humansById?.get(presentation.navigableId ?? '')
        : humansById?.get(presentation.navigableId ?? '')
      : undefined;
  // The byline avatar's bytes come from the author-DTO-derived batch (#task:1792
  // B2 — keyed by the active author's own id, never the live directory), and a
  // self-send prefers the viewer's resolved blob so it matches the composer.
  // Neutral arms (deleted / unresolved) fetch nothing.
  const viewerAvatarOverride =
    isCurrentUser && viewerAvatarObjectUrl ? viewerAvatarObjectUrl : undefined;
  const bylineAvatarUrl =
    presentation.avatar.variant === 'agent'
      ? authorAgentAvatarUrls?.get(presentation.avatar.id) ?? null
      : presentation.avatar.variant === 'user'
        ? viewerAvatarOverride ?? authorUserAvatarUrls?.get(presentation.avatar.id) ?? null
        : null;
  // Absolute time stamp (shiki #task:918): the header shows the literal
  // wall-clock value (`MM/DD HH:mm`) instead of "3 分钟前", and the
  // tooltip carries the fuller `YYYY-MM-DD HH:mm:ss` for precise
  // reference. Computed inline — no minute-tick re-render needed since
  // the absolute value is immutable.
  const createdAt = dayjs(message.created_at);
  const timeLabel = createdAt.format('MM/DD HH:mm');
  const timeTooltip = createdAt.format('YYYY-MM-DD HH:mm:ss');
  // Continuation rail (#task:1737) — clock only, no date: a group never spans
  // a day boundary, so the head's `MM/DD` already dates every row under it,
  // and `HH:mm` is what fits the avatar-width rail.
  const continuationTimeLabel = createdAt.format('HH:mm');
  const { openAgentPanel, toMembersUser } = useNav();
  // Clicking an agent avatar/name in the message stream opens the agent's
  // compact side panel (`?agent=`) instead of jumping to the full members
  // page — so the channel stays put and Activity reads beside it
  // (dual-screen, #task:1189). The full page is still reachable via the
  // panel's ⤢ expand button or the Members section.
  const navigateToAgent = useCallback(
    (agentId: string) => openAgentPanel(agentId),
    [openAgentPanel],
  );
  const navigateToHuman = useCallback(
    (userId: string) => toMembersUser(userId),
    [toMembersUser],
  );
  const taskTag =
    message.linked_task !== null ? (
      <MessageTaskTag
        message={message}
        agentsById={agentsById}
        userResolver={userResolver}
        canMutate={canMutateLinkedTask}
      />
    ) : null;
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
  // Pins the row "framed" + keeps the hover-revealed corner controls visible
  // while a reaction picker (corner or inline) is open — the picker portals
  // out, so the row would otherwise collapse from under it.
  const [reactionPickerOpen, setReactionPickerOpen] = useState(false);
  const toggleReaction = useToggleReaction();
  // The reaction delta's routing identity, read off this row (#task:1753) — the
  // ACK's authoritative recovery needs the channel + thread context, not just the
  // message id, to reach every projection that displays the row.
  const reactionTarget = {
    channelId: message.conversation_id,
    messageId: message.id,
    threadRootId: message.thread_root_id,
  };
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
  // reveals the action bar. Selection-mode also keeps the frame on
  // selected rows so the user can see at a glance which messages are
  // in the export queue.
  const framed =
    hover || highlighted || reactionPickerOpen || searchActive || (selectionMode && selected);

  // "{N} Reply/Replies" — pluralized to match the ThreadPanel header
  // (which says "N replies"); the badge previously hard-coded "Reply".
  const replyBadgeLabel =
    threadReplyCount === undefined
      ? ''
      : `${threadReplyCount} ${threadReplyCount === 1 ? 'Reply' : 'Replies'}`;

  // P1 (#task:1073): when the enriched summary is present, the badge upgrades
  // to avatars + count + last-reply time. `repliers.length > 0` guards the
  // avatar strip; otherwise we keep the count-only label.
  const enrichedReply =
    threadReplySummary && threadReplySummary.repliers.length > 0
      ? threadReplySummary
      : null;
  const replyRelativeTime = enrichedReply
    ? dayjs(enrichedReply.last_reply_at).fromNow()
    : '';
  // Surface 3 (#task:1226): per-viewer unread for this reply-cluster, read from
  // the `useConversationUnread` read-model (threaded in as `threadUnread`) — the
  // SINGLE source of truth, NOT the message-window summary (which can't score
  // per-viewer unread). When > 0 the chip's trailing segment swaps the
  // last-reply time for a text-form "N new" modifier in the unread hue (ink,
  // not a filled sticker — see the trailing-node comment for the volume-budget
  // rationale) and the chip click jumps to the first unread reply instead of
  // the thread tail. Follow-agnostic — unread is independent of whether the
  // viewer follows.
  const threadUnreadCount = threadUnread?.unread_count ?? 0;
  const threadFirstUnreadId = threadUnread?.first_unread_message_id ?? null;
  // Unread is the FIRST-priority title, independent of `enrichedReply` — the
  // "N new" visual now renders in both the enriched and fallback branches, so
  // the tooltip/aria-label must announce it in both too (else a fallback chip
  // reads "2 Replies" to a screen reader while the eye sees "2 Replies · 1 new"
  // — #task:1519 P2). Only when there's no unread does the label diverge: the
  // enriched chip appends the last-reply time, the fallback stays bare.
  const replyBadgeTitle =
    threadUnreadCount > 0
      ? `${replyBadgeLabel} · ${threadUnreadCount} new — jump to first unread`
      : enrichedReply
        ? `${replyBadgeLabel} · last reply ${replyRelativeTime}`
        : replyBadgeLabel;
  // Thread repliers now arrive as the SAME server-authoritative
  // {@link MessageAuthorDto} the byline uses (#task:1791/#task:1792), so their
  // face + name flow through the ONE seam — a deleted replier keeps its snapshot
  // name + neutral avatar, an unresolved one degrades to "Unknown …", and no
  // surface re-joins the directory by a raw id.
  const renderReplierAvatar = (
    author: MessageAuthorDto,
    size: number,
    key: string,
  ): JSX.Element => {
    const p = presentAuthor(author);
    return (
      <AuthorAvatarView
        key={key}
        avatar={p.avatar}
        size={size}
        label={authorStateLabel(p)}
        agentAvatarUrls={authorAgentAvatarUrls}
        humanAvatarUrls={authorUserAvatarUrls}
      />
    );
  };

  // The reply-preview replier NAME carries its deleted state through the ONE
  // shared primitive (#task:1792 B3) — same marker the byline shows — so a
  // visible text name in the preview never drops the state to the avatar
  // tooltip alone. The preview block owns the width cap; this node owns weight /
  // color / marker.
  const renderReplierName = (author: MessageAuthorDto): JSX.Element => (
    <AuthorName
      presentation={presentAuthor(author)}
      className="font-medium text-text-secondary"
    />
  );

  // ── MessageRowContent slot nodes ────────────────────────────────────────
  // The shared content layer owns section order + layout; MessageItem fills
  // each (required) slot with its INTERACTIVE node. Anything default-visible
  // must flow through a slot here — that is the anti-drift contract with the
  // static export path (see MessageRowContent). `taskTag`/`trailing` are
  // live-only adornments; the export passes `null` for them explicitly.
  const authorNode = (
    <AuthorLabel
      presentation={presentation}
      conversationId={conversationId}
      liveAgent={liveAgent}
      liveHuman={liveHuman}
      avatarObjectUrl={bylineAvatarUrl}
      onNavigateAgent={navigateToAgent}
      onNavigateHuman={navigateToHuman}
    />
  );
  const timestampNode = (
    <time
      dateTime={new Date(message.created_at).toISOString()}
      title={timeTooltip}
      className="text-[length:var(--text-meta)] text-text-muted"
    >
      {timeLabel}
    </time>
  );
  // `null` when the message is attachment-only (the composer allows an empty
  // draft as long as an upload finished): rendering an empty Markdown tree is
  // invisible, but the own-message bubble it now sits in is not — it would be
  // a padded blob above the attachments (#task:1838).
  const bodyNode = message.content.trim() ? (
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
      searchQuery={searchQuery}
    />
  ) : null;
  const attachmentsNode =
    message.attachments && message.attachments.length > 0 ? (
      <AttachmentList
        attachments={message.attachments}
        alignRight={alignRight}
        canExport={canParticipate}
      />
    ) : null;
  // Null when the message has no reactions — keeps the shared bottom row
  // (task tag · replies · reactions) from rendering an empty slot.
  const reactionsNode =
    isCommittedMessage(message) &&
    message.reactions &&
    message.reactions.length > 0 ? (
      <MessageReactions
        message={message}
        alignRight={alignRight}
        canReact={canReact}
        onReact={(emoji, remove) =>
          toggleReaction.mutate({ target: reactionTarget, emoji, remove })
        }
        onPickerOpenChange={setReactionPickerOpen}
      />
    ) : null;
  // Inline thread-replies badge — only when the message has an open thread.
  // Carries real information (N replies, click to open), so it earns persistent
  // space below the bubble. Live-only: the export omits it (passes `null`). A
  // bare inline element either way: whichever container it lands in — the shared
  // bottom row or the preview block's header — owns its spacing and alignment.
  //
  // ONE shape, not an enriched/fallback pair: `ThreadIcon` + `N replies` +
  // trailing modifier. The stacked replier avatars were removed once the reply
  // preview began rendering the same identities one line each directly below
  // (shiki 2026-07-31): the same faces twice in ~20px of vertical space read as
  // repetition and crowding, and identity belongs on the line that says what
  // the person actually wrote. The avatars were only ever standing in for
  // content that now exists. `enrichedReply` therefore no longer switches the
  // chip's composition — it only decides whether the last-reply time can be
  // stated (it is the sole carrier of that fact), so the chip no longer changes
  // silhouette when the summary loads.
  //
  // Unread signal as a TEXT modifier, not a filled sticker. The chip is a
  // LOCAL affordance (already a full click target); the loud filled square
  // belongs to the GLOBAL pressure signals (sidebar badge / Threads list
  // followed-row), so borrowing it here overspends the volume budget and
  // crowds the `N replies` subject (shiki dogfood `dSjdBvz4`). Keep the single
  // unread hue as INK (`text-accent` deep magenta, AA on light) + medium
  // weight. Derived SOLELY from `threadUnreadCount` (the authoritative
  // per-stream read-model), so it renders whether or not the enriched summary
  // has loaded — the enriched read-model is a freshness surface, NOT the fact
  // (§12.1#5). Gating it on `enrichedReply` previously made the "N new" chip
  // vanish until the summary refetched (ghost-unread, #task:1519). Click still
  // jumps to first unread.
  const threadUnreadNode =
    threadUnreadCount > 0 ? (
      <span className="shrink-0 whitespace-nowrap font-medium text-accent">
        {threadUnreadCount > 99 ? '99+' : threadUnreadCount} new
      </span>
    ) : null;
  // The badge and the preview lines are ONE object when there are lines to head
  // (shiki 2026-07-31) — see ThreadReplyPreview for why. Resolved once, here,
  // because it decides BOTH where the badge renders and whether the block
  // exists: deriving it separately in each place would let the two answers
  // drift. Same `onStartThread` gate as the badge — a surface that cannot open a
  // thread must not render a target that claims it can.
  const threadPreviewRows = onStartThread
    ? visibleThreadReplyRows(threadReplyPreviews)
    : [];
  // The block exists only when it can have its HEADER. Two independent cache
  // maps feed this row — the count (`replyCountsByRoot`) and the tail
  // (`replyPreviewsByRoot`) — so a tail can be present while the count is still
  // absent, either in a transitional apply or from a malformed payload. Deriving
  // the block from the tail ALONE would then render a wash with reply lines and
  // no `N replies` header: the header is the block's click entry and its only
  // expression of unread, so a headerless block is a target that states nothing
  // (Cindy, #task:1751). Requiring both makes that state unrepresentable rather
  // than asserted, and the degradation is the plain root row — the same thing
  // the reader saw one frame earlier.
  const badgeHeadsPreview =
    threadPreviewRows.length > 0 && threadReplyCount !== undefined;
  const replyBadgeNode =
    threadReplyCount !== undefined && onStartThread ? (
      <button
        type="button"
        data-panel-pill="thread"
        onClick={() => onStartThread(message, threadFirstUnreadId ?? undefined)}
        title={replyBadgeTitle}
        aria-label={replyBadgeTitle}
        className={
          // ONE metric for every box on this row: `leading-none` makes the copy's
          // line box exactly its 12px font size, and both glyphs are `size-3`
          // (12px) to match it, so icon and text share a height instead of the
          // glyph standing 2px taller than the words next to it (shiki
          // 2026-07-31). The row's height is therefore its text metric, not a
          // number chosen for it.
          //
          // `min-w-0` + the children's own no-wrap/truncate rules are what keep
          // that true: this row USED to pin `h-[18px]` while its children were
          // free to wrap, so in a narrow bubble the time segment relaid out to
          // three 12px lines (36px) inside an 18px box and spilled — which is
          // exactly the "height is 30" misalignment. A row that states one fact
          // must stay one line high; when it cannot fit, the time segment gives
          // way (see below) rather than the row growing.
          'inline-flex min-w-0 max-w-full items-center gap-1.5 text-xs leading-none text-text-muted transition-colors hover:text-text-primary focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-border-focus ' +
          // Mirrored ONLY as the preview block's header, and only for an
          // own-message row (#task:1855). The badge's glyph is this block's
          // COLUMN MARKER — it is supposed to sit in the same column as the
          // lines' avatars, which is what makes the badge read as their header
          // — and those lines are themselves `flex-row-reverse` under
          // `alignRight`, so their avatars are in the RIGHT column. Left
          // unmirrored, the header's marker sat a whole line-width away from
          // the faces it heads.
          //
          // Deliberately NOT applied to the standalone pill: there the glyph
          // has no column to line up with, and `icon → N replies → freshness`
          // is one PHRASE (type marker, subject, modifier), which reads
          // left-to-right on either side of the room. user-right mirrors the
          // ARRANGEMENT of siblings (the bottom adornment row reverses so the
          // task tag hugs the reading edge; the reaction row justifies to the
          // end) and never the word order inside a single label — the same
          // reason the prose keeps `text-align: left` in a right-hugging
          // bubble (shiki 2026-08-06). Reaction chips are the other precedent:
          // `emoji → count` does not flip either.
          (badgeHeadsPreview && alignRight ? 'flex-row-reverse ' : '') +
          // Its own fill / corner / inset ONLY when it stands alone. Inside the
          // preview block the wrapper owns all three: two stacked translucent
          // fills of the same token compose darker and would redraw the seam
          // that block exists to remove. The glyph then sits in the same
          // column as the lines' avatars — left, or right on an own-message
          // row (see the mirror above) — so the badge reads as their header.
          //
          // The fixed height belongs to the same branch, because it is PILL
          // geometry (fill + corner + inset need breathing room around the
          // 12px content), not a property of the row: as the preview block's
          // header there is no fill, so 18px would only add 6px of dead space
          // above lines that are themselves content-height.
          (badgeHeadsPreview
            ? ''
            : 'h-[18px] rounded-[var(--chip-radius)] bg-[var(--chip-bg)] px-2 hover:bg-[var(--chip-bg-hover)]')
        }
      >
        <ThreadIcon className="size-3 shrink-0" />
        {/* The subject of the row: it never wraps and never shrinks, so the
            count stays readable at any row width. */}
        <span className="shrink-0 whitespace-nowrap font-medium">
          {replyBadgeLabel}
        </span>
        {threadUnreadNode ??
          (enrichedReply ? (
            // Freshness is the row's DECORATION, so it is the segment that
            // gives way when the row is too narrow: it shrinks and truncates
            // (`truncate` also forbids the wrap that used to make this span
            // three lines tall inside a one-line row). The clock keeps its
            // 12px box so the glyph matches the words beside it.
            <span className="inline-flex min-w-0 shrink items-center gap-0.5 text-text-muted">
              <Clock className="size-3 shrink-0" />
              <span className="truncate">{replyRelativeTime}</span>
            </span>
          ) : null)}
      </button>
    ) : null;
  // Exactly one of these is non-null: the badge either stands on the shared
  // bottom line (#task:1185) or heads the preview block. `badgeHeadsPreview`
  // now implies the badge EXISTS, so the block can never be handed a null
  // header (#task:1751).
  const trailingNode = badgeHeadsPreview ? null : replyBadgeNode;
  // The cluster's most recent replies, one line each (#task:1745). Read-inert by
  // construction: no cursor is touched here (see ThreadReplyPreview).
  const threadPreviewNode = badgeHeadsPreview ? (
    <ThreadReplyPreview
      rows={threadPreviewRows}
      badge={replyBadgeNode}
      alignRight={alignRight}
      title={replyBadgeTitle}
      onOpen={() => onStartThread?.(message, threadFirstUnreadId ?? undefined)}
      renderAuthorAvatar={renderReplierAvatar}
      renderAuthorName={renderReplierName}
    />
  ) : null;

  const row = (
    <div
      id={`msg-${message.id}`}
      data-message-row
      data-search-active={searchActive || undefined}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onClickCapture={
        // shiki `0eolIYXZmVVYAjrM`: when MessageList is in selection
        // mode, clicking anywhere on the row toggles selection — not
        // just the checkbox. Capture phase is intentional: it fires
        // BEFORE any nested onClick (TaskRef navigation, attachment
        // open, link follow), so `preventDefault + stopPropagation`
        // suppresses every child interaction in selection mode. The
        // checkbox's own onClick is also intercepted; the row's toggle
        // handler covers it. Outside selection mode this branch is a
        // no-op so links / attachments / popovers still work.
        selectionMode && committed
          ? event => {
              event.preventDefault();
              event.stopPropagation();
              onToggleSelected?.(message);
            }
          : undefined
      }
      className={
        // Row radius routed via `--row-radius` token (#task:912 review
        // round 2). The framed (saved/replying) outer ring picks up
        // 6px in slack-dark and stays 0 in warm/forza6 — the soft hover
        // box is invisible at 0 radius anyway, so consistency here is
        // about *framed* presentations.
        //
        // A grouped continuation row (#task:1737) tightens its vertical
        // padding so the run reads as ONE block instead of N evenly-spaced
        // rows; the horizontal padding and the leading-column width are
        // untouched, so every body in the group stays on the same text
        // baseline as its head.
        'relative flex items-start gap-3 rounded-[var(--row-radius)] border-2 px-2 transition-colors ' +
        (continuesPrevious ? 'py-0.5 ' : 'py-1.5 ') +
        (jumpFlash ? 'msg-jump-flash ' : '') +
        (selectionMode && committed ? 'cursor-pointer ' : '') +
        (alignRight ? 'flex-row-reverse' : 'flex-row') +
        ' ' +
        (framed
          ? 'border-accent bg-bg-floating'
          : 'border-transparent')
      }
    >
      {selectionMode && committed ? (
        <SelectionCheckbox
          checked={selected}
          onChange={() => onToggleSelected?.(message)}
        />
      ) : null}
      {continuesPrevious ? (
        /* Continuation rail — occupies the avatar column's exact WIDTH (`w-8`)
           so the body lands on the same text baseline as the group head's, but
           only ONE body line of HEIGHT: a taller rail would pad the row back
           out and undo the tightening that makes a run read as one block. The
           line box is taken off the same Appearance token `.markdown-body`
           uses (see `[data-message-continuation-rail]` in global.css), so it
           still matches the body's first line at any font-size slider value.

           It carries THIS row's own clock time, revealed on row hover: the
           time is never lost to grouping, it just stops competing for
           attention on every line. Driven by the row's `hover` state rather
           than a `group-hover:` variant — same reason as the action controls
           below, Tailwind's variant ties with the base opacity class and loses
           in the compiled sheet. Only opacity animates, so the time stays in
           the a11y tree throughout rather than being `aria-hidden` while
           invisible. */
        <time
          data-message-continuation-rail
          dateTime={new Date(message.created_at).toISOString()}
          title={timeTooltip}
          className={
            'w-8 shrink-0 select-none text-[length:var(--text-badge)] text-text-muted transition-opacity ' +
            (alignRight ? 'text-left ' : 'text-right ') +
            (hover ? 'opacity-100' : 'opacity-0')
          }
        >
          {continuationTimeLabel}
        </time>
      ) : (
        <Avatar
          presentation={presentation}
          avatarObjectUrl={bylineAvatarUrl}
          liveAgent={liveAgent}
          liveHuman={liveHuman}
          conversationId={conversationId}
          onNavigateAgent={navigateToAgent}
          onNavigateHuman={navigateToHuman}
        />
      )}
      <MessageRowContent
        alignRight={alignRight}
        // Hug-content bubble by default (`max-w-[85%]`, no grow). A root that
        // heads a reply-preview block instead FILLS that 85% (`w-full`) so the
        // cluster reads at one stable width across every root, rather than
        // adapting to each root's own body width and rendering ragged (shiki).
        // The blast radius is exactly the rows that show the block —
        // reply-less messages keep hugging their content.
        columnClassName={
          'min-w-0 max-w-[85%]' + (badgeHeadsPreview ? ' w-full' : '')
        }
        /* A continuation row states neither author nor time in the content
           column: the group head already named the author, and this row's own
           time sits in the hover rail beside it. Both null ⇒ MessageRowContent
           drops the whole header element (#task:1737). */
        author={continuesPrevious ? null : authorNode}
        timestamp={continuesPrevious ? null : timestampNode}
        taskTag={taskTag}
        body={bodyNode}
        attachments={attachmentsNode}
        reactions={reactionsNode}
        trailing={trailingNode}
        threadPreview={threadPreviewNode}
      />

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
          ActionButton so they share its visual language — icon-only,
          color-only hover, no container chrome (the text label lives
          in `title` / `aria-label`).

          The Thread button is suppressed when `threadReplyCount` is
          already set — the inline "{N} Reply" badge is the discovery
          affordance in that case, so a duplicate "go to thread" icon
          would just be noise. */}
      {committed ? (
      <div
        onFocus={() => setFocusWithin(true)}
        onBlur={handleActionsBlur}
        className={
          'absolute top-1 z-[var(--z-raised)] flex items-center gap-3 text-xs transition-opacity ' +
          (alignRight ? 'left-2' : 'right-2') +
          ' ' +
          (hover || focusWithin || reactionPickerOpen
            ? 'opacity-100'
            : 'pointer-events-none opacity-0')
        }
      >
        {canReact ? (
          <ReactionPicker
            // The cluster itself is mirrored (`left-2` above), so the picker's
            // growth direction has to mirror with it: a popover always opens
            // from the trigger's own edge INTO the row, never out of it.
            // `end` grows leftward, `start` rightward — so the left-hand
            // cluster of an own message takes `start` (shiki 2026-08-06
            // 「user message 的 reaction 在左侧,如果 popover 也往左,那么就
            // 超出了」, #task:1840).
            align={alignRight ? 'start' : 'end'}
            onOpenChange={setReactionPickerOpen}
            onPick={emoji =>
              toggleReaction.mutate({
                target: reactionTarget,
                emoji,
                remove: false,
              })
            }
            trigger={
              <button
                type="button"
                title="React"
                aria-label="React"
                className="flex items-center rounded-sm text-text-muted transition-colors hover:text-text-primary focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-border-focus"
              >
                <SmilePlus className="size-3.5" />
              </button>
            }
          />
        ) : null}
        {onStartThread && threadReplyCount === undefined && canParticipate ? (
          <ActionButton
            icon={<ThreadIcon className="size-3.5" />}
            label="Thread"
            onClick={() => onStartThread(message)}
            alwaysVisible
            hovered={hover}
          />
        ) : null}
        {onSave ? (
          <ActionButton
            icon={<Bookmark className={'size-3.5 ' + (saved ? 'fill-current' : '')} />}
            label={saved ? 'Saved' : 'Save'}
            active={saved}
            onClick={() => onSave(message)}
            alwaysVisible
            hovered={hover}
          />
        ) : null}
      </div>
      ) : null}
    </div>
  );

  return (
    <MessageContextMenu
      trigger={row}
      saved={saved}
      onCopyMarkdown={
        committed && onCopyMarkdown ? () => onCopyMarkdown(message) : undefined
      }
      onToggleSave={committed && onSave ? () => onSave(message) : undefined}
      onShare={committed && onShare ? () => onShare(message) : undefined}
      onUnfollowThread={
        committed && onUnfollowThread
          ? () => onUnfollowThread(message)
          : undefined
      }
    />
  );
}

/**
 * Task tag for a message linked to a task.
 *
 * Lives at the message's BOTTOM edge — its own row ahead of reactions and
 * the thread-reply badge (shiki #task:1185), aligned to the message's
 * reading edge.
 *
 * It is ONE cohesive tag (shiki review: the split lead + chip read as
 * scattered). The whole tag is a single button: `<status-icon> #<num> ·
 * <assignee>`, status-coloured via the shared `[data-task-status]` token
 * contract (so it states its status at a glance and matches every other
 * status chip per theme — incl. forza6's poster caps / 0-radius). The status
 * is carried by the leading glyph (from the shared `TASK_STATUS_ICON` source,
 * so it tracks the kanban board) + the fill colour — no redundant status
 * text. For a member of an open channel (`canMutate`), clicking anywhere on the
 * tag opens the "Move to" picker, which drives `useUpdateTaskStatus`
 * (`POST /api/tasks/:id/status`) — the same any→any path the inline `#task:N`
 * reference uses. For a non-member (public channel = read-only) or any
 * read-only surface, the chip renders identically — same glyph, colour, number,
 * assignee — but as an inert `<span>`: the status is public to read, only the
 * mutation entry is member-gated. The task title lives in the tooltip.
 *
 * Renders nothing when the message has no linked task.
 */
function MessageTaskTag({
  message,
  agentsById,
  userResolver,
  canMutate,
}: {
  message: CachedMessage;
  agentsById: Map<string, AgentDto>;
  userResolver?: UserNameResolver;
  canMutate: boolean;
}): JSX.Element | null {
  const updateStatus = useUpdateTaskStatus();
  const linkedTask = message.linked_task;
  if (linkedTask === null) return null;

  const status = linkedTask.status;
  const label = taskStatusLabel(status);
  const StatusIcon = TASK_STATUS_ICON[status];
  const assignee = linkedTask.assignee
    ? formatTaskAssignee(linkedTask.assignee, agentsById, userResolver)
    : null;
  const title = [`Task #${linkedTask.task_number}`, label, assignee, linkedTask.title]
    .filter(Boolean)
    .join(' · ');

  // Shared chip body — identical glyph / number / assignee across both the
  // interactive and read-only forms, so a non-member reads the exact same
  // task state a member does.
  const body = (
    <>
      {/* Status glyph from the shared TASK_STATUS_ICON source (kanban /
          drawer use the same), so a future icon swap updates everywhere. */}
      <StatusIcon className="size-3 shrink-0" aria-hidden />
      {/* No `font-mono` on the number — it inherits the chip's typeface, so
          it matches the `· assignee` next to it (and forza6's
          `[data-task-status]` display face applies to the whole chip rather
          than to the label alone). Space Mono digits read poorly in forza6
          (@shiki `sLh6CqwNw0uAtThk`, #task:1757). */}
      <span className="shrink-0">#{linkedTask.task_number}</span>
      {assignee ? (
        <span className="min-w-0 truncate font-normal">· {assignee}</span>
      ) : null}
    </>
  );

  // Read-only chip (non-member / read-only surface): same look + content, no
  // picker, no mutation, no interactive affordances. The click falls through
  // to the row's normal selection/jump behaviour.
  if (!canMutate) {
    return (
      <span
        data-message-task-tag
        // Same `[data-task-status]` token contract as the interactive form —
        // fill / border / radius stay in lockstep with the board chips.
        data-task-status={status}
        title={title}
        className="inline-flex h-[18px] max-w-[220px] cursor-default items-center gap-1.5 whitespace-nowrap rounded-[var(--chip-radius)] px-2 text-[length:var(--text-meta)] font-medium leading-none"
      >
        {/* The status glyph is aria-hidden and the fill colour is visual-only,
            and a generic span's aria-label is not reliably exposed — so carry
            the status name as real screen-reader text. The #number + assignee
            are already read from the body's visible text nodes. */}
        <span className="sr-only">{label}</span>
        {body}
      </span>
    );
  }

  return (
    <StatusPicker
      current={status}
      onChange={next =>
        updateStatus.mutate({ taskId: linkedTask.task_id, status: next })
      }
    >
      <button
        type="button"
        data-message-task-tag
        // Status colour / border / radius all flow from the shared
        // `[data-task-status]` token contract (global.css + per-theme),
        // so this tag stays in lockstep with the board chips. No bg /
        // border / colour utilities here — they would fight the tokens.
        data-task-status={status}
        title={title}
        aria-label={`Task #${linkedTask.task_number} (${label}) — click to change status`}
        // Stop the click from reaching the row's selection/jump capture.
        onClick={e => e.stopPropagation()}
        className="inline-flex h-[18px] max-w-[220px] cursor-pointer items-center gap-1.5 whitespace-nowrap rounded-[var(--chip-radius)] px-2 text-[length:var(--text-meta)] font-medium leading-none transition-opacity hover:opacity-80 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-border-focus"
      >
        {body}
      </button>
    </StatusPicker>
  );
}

function formatTaskAssignee(
  assignee: TaskAssigneeDto,
  agentsById: Map<string, AgentDto>,
  userResolver?: UserNameResolver,
): string {
  if (assignee.type === 'user') {
    return formatUserDisplayName(assignee.id, userResolver);
  }
  const agent = agentsById.get(assignee.id);
  const name = (
    agent?.display_name?.trim() ||
    agent?.name ||
    assignee.name.trim() ||
    assignee.id
  ).replace(/^@/, '');
  // In-message task cards are a recognition surface: plain names for both
  // kinds, no leading `@` (the user branch above is already bare). Every task
  // assignee/creator DISPLAY reads the same way now — board cards, the drawer,
  // TasksSection, the filter, and the TaskRef popover all show the plain
  // display name (the dto's `name` is the denormalized display_name, never a
  // handle). `@` is reserved for surfaces that show a real handle: mentions,
  // the composer, and the assignee picker — split by surface, not by actor
  // kind (shiki 2026-08-01, #task:1768).
  return name;
}

function Avatar({
  presentation,
  avatarObjectUrl,
  liveAgent,
  liveHuman,
  conversationId,
  onNavigateAgent,
  onNavigateHuman,
}: {
  presentation: AuthorPresentation;
  /** The author's resolved avatar bytes (active arms only); neutral arms ignore
   *  it and draw the runtime-free placeholder. */
  avatarObjectUrl: string | null;
  /** Live actor rows, present only for an active author — they wrap the avatar
   *  in the hover identity card. A deleted / unresolved author renders the bare
   *  neutral square: there is no profile to open. */
  liveAgent: AgentDto | undefined;
  liveHuman: UserDto | undefined;
  conversationId: string;
  onNavigateAgent: (agentId: string) => void;
  onNavigateHuman: (userId: string) => void;
}): JSX.Element {
  // Make the avatar's outermost element (button when wrapped, span when not)
  // carry the explicit size box so the focus ring stays square regardless of the
  // image's natural aspect ratio (@shiki `4TU4EBHr70R-YMgc`).
  const avatar = (
    <AuthorAvatarView
      avatar={presentation.avatar}
      size={AVATAR_PX.lg}
      label={presentation.label}
      className="border-[length:var(--border-avatar-width)] border-border-avatar"
      objectUrlOverride={avatarObjectUrl}
    />
  );
  if (presentation.status === 'active' && liveAgent) {
    return (
      <AgentInfoPopover
        agent={liveAgent}
        conversationId={conversationId}
        trigger="hover"
        avatarObjectUrl={avatarObjectUrl}
      >
        <button
          type="button"
          aria-label={`@${liveAgent.name}`}
          onClick={event => {
            event.preventDefault();
            onNavigateAgent(liveAgent.id);
          }}
          className="mt-0.5 rounded-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-focus"
        >
          {avatar}
        </button>
      </AgentInfoPopover>
    );
  }
  if (presentation.status === 'active' && liveHuman) {
    return (
      <HumanInfoPopover
        human={liveHuman}
        userId={liveHuman.id}
        trigger="hover"
        avatarObjectUrl={avatarObjectUrl}
      >
        <button
          type="button"
          aria-label={`@${liveHuman.name}`}
          onClick={event => {
            event.preventDefault();
            onNavigateHuman(liveHuman.id);
          }}
          className="mt-0.5 rounded-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-focus"
        >
          {avatar}
        </button>
      </HumanInfoPopover>
    );
  }
  // Deleted / unresolved (or an active author whose live row hasn't loaded):
  // the neutral / snapshot avatar, non-navigable.
  return <span className="mt-0.5 inline-flex">{avatar}</span>;
}

/**
 * Header author label, driven by the resolved {@link AuthorPresentation}:
 * - active agent (live row present) → `<AgentInfoPopover>` + navigable button
 * - active user (live row present) → `<HumanInfoPopover>` + navigable button
 * - deleted → the snapshot name + a quiet "deleted" marker, non-navigable
 * - unresolved / active-without-live-row → the plain label, non-navigable
 */
function AuthorLabel({
  presentation,
  conversationId,
  liveAgent,
  liveHuman,
  avatarObjectUrl,
  onNavigateAgent,
  onNavigateHuman,
}: {
  presentation: AuthorPresentation;
  conversationId: string;
  liveAgent: AgentDto | undefined;
  liveHuman: UserDto | undefined;
  avatarObjectUrl: string | null;
  onNavigateAgent: (agentId: string) => void;
  onNavigateHuman: (userId: string) => void;
}): JSX.Element {
  const label = presentation.label;
  if (presentation.status === 'active' && liveAgent) {
    return (
      <AgentInfoPopover
        agent={liveAgent}
        conversationId={conversationId}
        trigger="hover"
        avatarObjectUrl={avatarObjectUrl}
      >
        <button
          type="button"
          onClick={event => {
            event.preventDefault();
            onNavigateAgent(liveAgent.id);
          }}
          /* `data-message-author` + `data-author-kind` are theme-neutral
           *  identity hooks. BOTH kinds take `text-text-primary` in EVERY theme:
           *  the label is a recognition surface, not a status signal, and agent
           *  and human are isomorphic actors (shiki 2026-08-02). A theme must
           *  not repaint the author name by kind. */
          data-message-author
          data-author-kind="agent"
          className="rounded font-bold text-text-primary focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-border-focus"
        >
          {label}
        </button>
      </AgentInfoPopover>
    );
  }
  if (presentation.status === 'active' && liveHuman) {
    return (
      <HumanInfoPopover
        human={liveHuman}
        userId={liveHuman.id}
        trigger="hover"
        avatarObjectUrl={avatarObjectUrl}
      >
        <button
          type="button"
          onClick={event => {
            event.preventDefault();
            onNavigateHuman(liveHuman.id);
          }}
          data-message-author
          data-author-kind="user"
          className="rounded font-bold text-text-primary focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-border-focus"
        >
          {label}
        </button>
      </HumanInfoPopover>
    );
  }
  // Deleted / unresolved (or active-without-live-row): a non-navigable label.
  // Deleted keeps its snapshot name + the quiet marker; unresolved shows the
  // neutral "Unknown …" the seam already resolved. No popover — there is no
  // profile to open. The name + deleted marker go through the shared
  // `AuthorName` primitive so this surface can't drift from the list / export
  // surfaces on how a deleted author reads.
  return (
    <span
      data-message-author
      data-author-kind={presentation.kind}
      className="inline-flex items-baseline gap-1.5"
    >
      <AuthorName
        presentation={presentation}
        className="font-bold text-text-primary"
      />
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
        'flex items-center rounded-sm transition-colors transition-opacity focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-border-focus ' +
        (visible ? 'opacity-100' : 'pointer-events-none opacity-0') +
        ' ' +
        (active
          ? 'text-accent'
          : 'text-text-muted hover:text-text-primary')
      }
    >
      {icon}
    </button>
  );
}

function AttachmentList({
  attachments,
  alignRight,
  canExport = true,
}: {
  attachments: AttachmentSnapshot[];
  alignRight: boolean;
  /** Whether the viewer may export (download / open-external) an attachment.
   *  `false` for a non-member browsing a public channel: inline
   *  PREVIEW stays, but the download / open affordances are withheld. */
  canExport?: boolean;
}): JSX.Element {
  // Resolve every tile's label once at the list level so ordinals match the
  // agent-facing stdin suffix exactly (same shared resolver). This lets a
  // reader map an agent's "Image #1" back to the actual tile (#task:1324).
  const labels = resolveAttachmentLabels(attachments);
  return (
    <div
      className={
        'mt-2 flex flex-wrap gap-2 ' + (alignRight ? 'justify-end' : 'justify-start')
      }
    >
      {attachments.map((att, i) => (
        <AttachmentTile
          key={att.id}
          attachment={att}
          label={labels[i]}
          canExport={canExport}
        />
      ))}
    </div>
  );
}

function AttachmentTile({
  attachment,
  label,
  canExport = true,
}: {
  attachment: AttachmentSnapshot;
  label?: string;
  canExport?: boolean;
}): JSX.Element {
  const isImage = attachment.content_type.startsWith('image/');
  // Generation token for this attachment (#task:1769). Bumps when the creator
  // updates the bytes in place (`attachment_changed`) or a reconnect gap forces
  // a coarse epoch bump — either way we re-fetch the latest bytes and swap them
  // in below without unmounting the current <img> (no loading flash).
  const token = useAttachmentBlobToken(attachment.id);
  // Synchronous cache hit covers both the optimistic-message render
  // (Composer pre-populated the cache from the local File) and any
  // later viewer who has already fetched this attachment in this
  // session — so the swap from optimistic → real message never goes
  // through a "loading" frame.
  const [imageUrl, setImageUrl] = useState<string | null>(() =>
    isImage ? getAttachmentBlobUrl(attachment.id) ?? null : null,
  );
  // The generation `imageUrl` was fetched under; a token change past this means
  // the displayed bytes are stale and the load effect must refetch.
  const loadedTokenRef = useRef(token);
  const [error, setError] = useState<string | null>(null);
  const [lightboxOpen, setLightboxOpen] = useState(false);
  // Terminal "this image can't be decoded" flag. A first `onError` is treated
  // as a stale/evicted blob url and retried ONCE (see onImgError); a second is
  // taken as "the bytes themselves won't decode" and lands here so we stop
  // retrying. `retriedRef` carries the once-flag across renders without
  // triggering one. Both are GENERATION-scoped: they reset when the tile is
  // pointed at a new attachment OR when the bytes are updated in place (#task:1769)
  // — an undecodable intermediate revision must not permanently poison a later
  // fixed revision.
  const [decodeFailed, setDecodeFailed] = useState(false);
  const retriedRef = useRef(false);

  useEffect(() => {
    // Re-allow load/retry for a new generation without dropping the visible old
    // image (no white flash) — a successful reload swaps it in place below.
    retriedRef.current = false;
    setDecodeFailed(false);
    setError(null);
  }, [attachment.id, token]);

  useEffect(() => {
    if (!isImage || decodeFailed) return;
    // Already showing bytes for the current generation — nothing to do.
    if (imageUrl && loadedTokenRef.current === token) return;
    let cancelled = false;
    loadAttachmentBlobUrl(attachment.id)
      .then(url => {
        if (!cancelled) {
          loadedTokenRef.current = token;
          setImageUrl(url);
          setError(null);
        }
      })
      .catch(err => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [attachment.id, isImage, imageUrl, decodeFailed, token]);

  // Bound the image-error recovery. The FIRST error may be a stale blob url
  // that was evicted + revoked out from under us — drop it and let the effect
  // re-fetch a fresh one, ONCE. A SECOND error (after a known-fresh url) means
  // the bytes are undecodable by Chromium (e.g. a `.tiff`), so we go terminal
  // instead of looping fetch → error → fetch forever — the unbounded version
  // repainted a broken <img> every frame and flickered the whole UI
  // (#task:1581). A decode-failed image then degrades to the downloadable
  // file chip below rather than a dead preview box.
  function onImgError(): void {
    if (retriedRef.current) {
      setDecodeFailed(true);
      return;
    }
    retriedRef.current = true;
    setImageUrl(null);
  }

  async function downloadAndOpen(): Promise<void> {
    // Non-image attachments must NOT be opened via `window.open(blob_url)` —
    // Electron's setWindowOpenHandler hands the URL to
    // `shell.openExternal`, which can't resolve `blob:` URLs (they're
    // scoped to the renderer process). The result was that clicking
    // any non-image attachment silently did nothing — the symptom that
    // surfaced as the original `.html` bug (`#task:383`).
    //
    // Instead: fetch the bytes through the authenticated backend route,
    // ship them to main over IPC, and let main write a temp file +
    // `shell.openPath`. The OS default handler picks the right app from the
    // extension. HTML therefore opens in the user's real browser, not in
    // any Electron-controlled WebContents — which keeps untrusted HTML
    // outside the app's process tree.
    //
    // Main applies a strict extension allowlist (`isSafeOpenExtension`);
    // `unsafe_extension` and IPC failures surface through the shared
    // `open-attachment` helper — this tile shows them as an inline error
    // (the chip has its own error slot); the Attachments panel opts into
    // toasts.
    await openAttachmentExternally(attachment, {
      onInlineError: msg => setError(msg),
    });
  }

  if (isImage && !decodeFailed) {
    return (
      <div className="flex flex-col gap-1">
        <button
          type="button"
          onClick={() => imageUrl && setLightboxOpen(true)}
          disabled={!imageUrl}
          className="block overflow-hidden rounded-[var(--chip-radius)] border border-border-subtle bg-bg-floating focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-focus"
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
              {error ?? 'Loading…'}
            </div>
          )}
        </button>
        {label ? <AttachmentLabelBadge label={label} /> : null}
        {imageUrl ? (
          <Lightbox
            open={lightboxOpen}
            onOpenChange={setLightboxOpen}
            src={imageUrl}
            alt={attachment.filename}
            // Preview stays; download is a member export. Omitting
            // `onDownload` hides the Lightbox's download action (Copy remains).
            onDownload={
              canExport ? () => saveAttachmentToDisk(attachment) : undefined
            }
          />
        ) : null}
      </div>
    );
  }

  if (!canExport) {
    // Non-member preview: a non-image attachment has no inline
    // render, so its "preview" is the file reference itself — a static,
    // non-interactive chip. Clicking would download-and-open (an export), so
    // the whole tile is inert and the explicit Download button is omitted.
    return (
      <div className="flex flex-col items-start gap-1">
        <div
          className="flex max-w-[320px] items-center gap-2 overflow-hidden rounded-[var(--chip-radius)] border border-border-subtle bg-bg-floating px-2 py-1.5 text-xs text-text-secondary"
          title={`${attachment.filename} (${formatBytes(attachment.size)})`}
        >
          <FileText className="size-4 shrink-0 text-text-muted" />
          <span className="min-w-0 truncate">{attachment.filename}</span>
          <span className="shrink-0 text-[length:var(--text-badge)] text-text-muted">
            {formatBytes(attachment.size)}
          </span>
        </div>
        {label ? <AttachmentLabelBadge label={label} /> : null}
      </div>
    );
  }

  return (
    <div className="flex flex-col items-start gap-1">
      <div className="flex max-w-[320px] items-stretch overflow-hidden rounded-[var(--chip-radius)] border border-border-subtle bg-bg-floating focus-within:ring-2 focus-within:ring-border-focus">
        <button
          type="button"
          onClick={downloadAndOpen}
          className="group flex min-w-0 flex-1 items-center gap-2 px-2 py-1.5 text-xs text-text-secondary hover:text-text-primary focus:outline-none"
          title={error ?? `${attachment.filename} (${formatBytes(attachment.size)})`}
        >
          <FileText className="size-4 shrink-0 text-text-muted group-hover:text-text-primary" />
          <span className="min-w-0 truncate">{attachment.filename}</span>
          <span className="shrink-0 text-[length:var(--text-badge)] text-text-muted group-hover:text-text-primary">
            {formatBytes(attachment.size)}
          </span>
        </button>
        <button
          type="button"
          onClick={() => void saveAttachmentToDisk(attachment)}
          className="flex shrink-0 items-center justify-center px-2 text-text-muted hover:text-text-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-border-focus"
          title="Download"
          aria-label={`Download ${attachment.filename}`}
        >
          <Download className="size-3.5" />
        </button>
      </div>
      {label ? <AttachmentLabelBadge label={label} /> : null}
    </div>
  );
}

/** The `Image #N` / `File #N` reference caption under a received attachment
 *  tile (#task:1324). It's a reference identifier, not a status/action badge —
 *  so it's rendered as light, document-caption-style text centered under the
 *  tile, NOT an accent pill (which would over-read as a chip and steal the
 *  saturated-hue budget). Non-interactive here (unlike the composer's insert
 *  button): on a sent message the label is already fixed. */
function AttachmentLabelBadge({ label }: { label: string }): JSX.Element {
  return (
    <span className="block w-full text-center font-mono text-[length:var(--text-badge)] text-text-muted">
      {label}
    </span>
  );
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

/**
 * Visual checkbox column shown when MessageList is in selection mode.
 * Uses a real `<button>` for keyboard access; `aria-pressed` reflects
 * the selection state. We deliberately don't use a native checkbox
 * because the row's flex layout + theme tokens are easier to control
 * with a styled button.
 */
function SelectionCheckbox({
  checked,
  onChange,
}: {
  checked: boolean;
  onChange: () => void;
}): JSX.Element {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      aria-label={checked ? 'Deselect message' : 'Select message'}
      onClick={onChange}
      className={
        'mt-1.5 inline-flex size-4 shrink-0 items-center justify-center rounded-[var(--control-radius)] border transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-border-focus ' +
        (checked
          ? 'border-accent bg-accent text-bg-floating'
          : 'border-border bg-bg-floating text-transparent hover:border-accent')
      }
    >
      <Check className="size-3" strokeWidth={3} />
    </button>
  );
}
