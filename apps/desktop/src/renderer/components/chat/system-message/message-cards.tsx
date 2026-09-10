import { useState } from "react";
import { AtSign, ChevronRight, Pencil, RotateCcw, UserMinus, UserPlus } from "lucide-react";
import {
  type ConversationMemberChangeMetadata,
  type SessionClearedMetadata,
  readConversationMemberChangeMetadata,
  readRenameMetadata,
  readSessionClearedMetadata,
} from "@silverhand/shared";
import { useMessage } from "@/features/messages/hooks";
import { formatUserDisplayName, isCurrentUserId } from "@/features/session/current-user";
import { Markdown } from "@/components/chat/markdown";
import { presentAuthor } from "@/components/chat/author-presentation";
import { AuthorName } from "@/components/chat/author-avatar-view";
import { type RendererProps, GenericNarrationFallback, firstLine, useUserResolver } from "./shared";

// ─── mention_cc card ───────────────────────────────────────────────────

/**
 * Compact render for `mention_cc` system messages: an origin reference
 * (workspace · conversation) plus the original message body. The verbose
 * imperative wrap stays in `message.content` for the agent's stdin only.
 *
 * The mentioning author is named ONLY when they are someone other than the
 * reader — see the collapse below. Since #task:2072 the copy lands in the
 * author's own direct line with the agent, so the common row's byline would
 * name the reader to the reader.
 */
export function MentionCcCard({
  message,
  conversationRefsById,
  onOpenConversationRef,
  channelsByName,
  onOpenChannelRef,
  humansByName,
}: RendererProps): JSX.Element {
  const [expanded, setExpanded] = useState(false);

  const meta = (message.metadata ?? {}) as Record<string, unknown>;

  const workspaceName =
    typeof meta["source_workspace_name"] === "string"
      ? (meta["source_workspace_name"] as string)
      : null;
  const conversationTitle =
    typeof meta["source_conversation_title"] === "string"
      ? (meta["source_conversation_title"] as string)
      : null;
  const inlineOriginal =
    typeof meta["source_message_content"] === "string"
      ? (meta["source_message_content"] as string)
      : null;
  const sourceMessageId =
    typeof meta["source_message_id"] === "string" ? (meta["source_message_id"] as string) : null;
  const sourceConversationId =
    typeof meta["source_conversation_id"] === "string"
      ? (meta["source_conversation_id"] as string)
      : null;
  const sourceFromKind =
    typeof meta["source_from_kind"] === "string" ? (meta["source_from_kind"] as string) : null;
  const sourceFromUserId =
    typeof meta["source_from_user_id"] === "string"
      ? (meta["source_from_user_id"] as string)
      : null;
  // Legacy rows (pre-`source_message_content`) fall back to fetching
  // the original message by id. Hook stays disabled when the inline
  // copy is present so we don't pay the round-trip on new rows.
  const { data: fetched } = useMessage(inlineOriginal ? null : sourceMessageId);
  const original = inlineOriginal ?? fetched?.message.content ?? null;
  const userResolver = useUserResolver();
  // Source author through the ONE author-presentation seam (#task:1795 fixes a
  // literal `'user'` hardcode here; seam is #task:1792). When the source message
  // is available its authoritative `author` DTO renders like every other byline
  // (snapshot name + quiet `deleted` marker). But this is an EVENT-TIME context
  // card ("who mentioned you, where, then") — NOT a live byline: the common
  // cross-workspace path carries only inline metadata (`source_from_kind`, +
  // `source_from_user_id` for users), no agent name and no author snapshot, so
  // an agent source degrades to a neutral "an agent" — never mislabeled a user,
  // never guessing deleted. By product decision (shiki 2026-08-03) the card does
  // NOT track the source account's later deletion; that would require a backend
  // read-time author resolve this historical card is deliberately not worth. Do
  // not "upgrade" this into a dynamic deleted-tracking read-model.
  const sourcePresentation = fetched?.message.author ? presentAuthor(fetched.message.author) : null;
  const sourceFallbackLabel =
    sourceFromKind === "user" || fetched?.message.from_kind === "user"
      ? formatUserDisplayName(sourceFromUserId ?? fetched?.message.from_user_id, userResolver)
      : sourceFromKind === "agent" || fetched?.message.from_kind === "agent"
        ? "an agent"
        : null;

  // In-card nav to the origin conversation. The `mention_external`
  // notification for this same mention anchors at the SOURCE message
  // (option A, #task:2089) — this link is not a fallback for it, it is the
  // affordance for a reader already sitting in the direct line who wants the
  // surrounding context. No message anchor: `onOpenConversationRef` only
  // takes a conversation id, and landing in the source conversation is the
  // intended scope.
  const canJumpSource = !!(sourceConversationId && onOpenConversationRef);
  const handleOpenSource = canJumpSource
    ? () => onOpenConversationRef!(sourceConversationId!)
    : null;
  const sourceLocationLabel = workspaceName
    ? conversationTitle
      ? `${workspaceName} · ${conversationTitle}`
      : workspaceName
    : (conversationTitle ?? null);
  // Collapse the byline when the mention's author IS the reader. The card
  // cannot know which conversation it is being read in — only its metadata —
  // so it asks the one question it can answer locally, and that question is
  // right in every generation. Since #task:2072 the copy lands in the author's
  // direct line with the agent, so the author is the only human reader there
  // and the byline would name the reader to the reader. Pre-`25e089d1` copies
  // landed in a per-agent `Mentions` DM that admitted every mentioning human,
  // so rows by OTHER authors are human-readable in it — and for those the
  // predicate is false, which is the right answer: they keep the byline. Same
  // for any row whose origin is unknown. A location is required too, because
  // after the collapse the origin reference IS the line — with nothing to point
  // at, a lone glyph would say less than the byline it replaced.
  const readerIsMentionAuthor = sourceFromKind === "user" && isCurrentUserId(sourceFromUserId);
  const collapseByline = readerIsMentionAuthor && sourceLocationLabel !== null;
  const sourceLocationNode = sourceLocationLabel ? (
    handleOpenSource ? (
      <button
        type="button"
        onClick={handleOpenSource}
        className="text-text-secondary underline-offset-2 hover:text-accent hover:underline"
        data-mention-cc-source="1"
      >
        {sourceLocationLabel}
      </button>
    ) : (
      <span className="text-text-secondary">{sourceLocationLabel}</span>
    )
  ) : null;

  return (
    <div className="w-full min-w-0 max-w-full px-4 py-2 [contain:inline-size]">
      <div className="flex flex-wrap items-center justify-center gap-2 text-center text-xs leading-5 text-text-muted">
        <AtSign aria-hidden className="size-3.5 shrink-0" />
        {collapseByline ? (
          <span>Mention in {sourceLocationNode}</span>
        ) : (
          <span>
            {sourcePresentation ? (
              <AuthorName presentation={sourcePresentation} className="text-text-secondary" />
            ) : sourceFallbackLabel ? (
              <span className="text-text-secondary">{sourceFallbackLabel}</span>
            ) : null}
            {sourcePresentation || sourceFallbackLabel ? " mentioned" : "Mention"}
            {sourceLocationNode ? (
              <>
                {" in "}
                {sourceLocationNode}
              </>
            ) : null}
          </span>
        )}
        <button
          type="button"
          className="w-24 shrink-0 whitespace-nowrap text-text-secondary underline-offset-2 hover:text-text-primary hover:underline"
          aria-expanded={expanded}
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded ? "Hide message" : "View message"}
        </button>
      </div>
      {expanded ? (
        <div className="mt-3 w-full min-w-0 max-w-full overflow-x-auto wrap-anywhere rounded-(--control-radius) bg-bg-message-context px-3 py-2 text-left text-text-primary">
          {original ? (
            <Markdown
              content={original}
              conversationRefsById={conversationRefsById}
              onOpenConversationRef={onOpenConversationRef}
              channelsByName={channelsByName}
              onOpenChannelRef={onOpenChannelRef}
              humansByName={humansByName}
            />
          ) : (
            <div className="text-xs text-text-muted">(loading original…)</div>
          )}
        </div>
      ) : null}
    </div>
  );
}

// ─── session_cleared audit row ────────────────────────────────────────

export function SessionClearedCard({
  message,
  conversationRefsById,
  onOpenConversationRef,
  channelsByName,
  onOpenChannelRef,
  humansByName,
}: RendererProps): JSX.Element {
  const meta = readSessionClearedMetadata(message.metadata);
  if (meta) return <SessionClearedRow meta={meta} />;
  return (
    <div
      className="flex items-center justify-center gap-2 px-4 py-1 text-center text-text-muted"
      data-session-cleared-legacy="1"
    >
      <RotateCcw aria-hidden className="size-3.5 shrink-0 opacity-60" />
      <div className="min-w-0">
        <Markdown
          content={message.content}
          conversationRefsById={conversationRefsById}
          onOpenConversationRef={onOpenConversationRef}
          channelsByName={channelsByName}
          onOpenChannelRef={onOpenChannelRef}
          humansByName={humansByName}
        />
      </div>
    </div>
  );
}

function SessionClearedRow({ meta }: { meta: SessionClearedMetadata }): JSX.Element {
  // `actor_user_id: null` in this metadata means "principal info wasn't
  // recorded at insert time" (per shared schema docstring), NOT "current
  // viewer" — the latter is the v1 message-row convention used by
  // `formatUserDisplayName`. Run the helper only when the id is set;
  // otherwise render a generic "a user" so the audit row doesn't
  // misattribute the action to the current viewer.
  const userResolver = useUserResolver();
  const actorLabel = meta.actor_user_id
    ? formatUserDisplayName(meta.actor_user_id, userResolver)
    : "a user";
  return (
    <div
      className="flex flex-wrap items-center justify-center gap-x-1.5 gap-y-0.5 px-4 py-1 text-center text-text-muted"
      data-session-cleared="1"
    >
      <RotateCcw aria-hidden className="size-3.5 shrink-0 opacity-60" />
      <span
        className="text-text-secondary"
        data-session-cleared-actor={meta.actor_user_id ?? "unknown"}
      >
        {actorLabel}
      </span>
      <span>reset</span>
      <span className="font-medium text-text-primary">{meta.agent_name}</span>
      <span>'s session context</span>
    </div>
  );
}

export function OnboardingRow({
  message,
  conversationRefsById,
  onOpenConversationRef,
  channelsByName,
  onOpenChannelRef,
  humansByName,
}: RendererProps): JSX.Element {
  const [expanded, setExpanded] = useState(false);

  return (
    <div
      className="w-full min-w-0 rounded-(--control-radius) bg-bg-message-context px-3 py-2 text-left text-text-muted"
      data-onboarding-row="1"
    >
      <button
        type="button"
        onClick={() => setExpanded((value) => !value)}
        className="mb-1 flex items-center gap-2 rounded-(--control-radius) hover:text-text-primary"
        aria-expanded={expanded}
      >
        <ChevronRight
          aria-hidden
          className={
            "size-3 shrink-0 text-text-muted/60 transition-transform " +
            (expanded ? "rotate-90" : "")
          }
        />
        <span
          className="inline-flex items-center text-(length:--text-badge) font-semibold uppercase tracking-wider text-accent"
          data-onboarding-badge="1"
        >
          Onboarding
        </span>
      </button>
      <div className={"w-full min-w-0 " + (expanded ? "" : "truncate")}>
        {expanded ? (
          <Markdown
            content={message.content}
            conversationRefsById={conversationRefsById}
            onOpenConversationRef={onOpenConversationRef}
            channelsByName={channelsByName}
            onOpenChannelRef={onOpenChannelRef}
            humansByName={humansByName}
          />
        ) : (
          <span>{firstLine(message.content)}</span>
        )}
      </div>
    </div>
  );
}

export function RenameRow(props: RendererProps): JSX.Element {
  const meta = readRenameMetadata(
    (props.message.metadata ?? null) as Record<string, unknown> | null,
  );
  if (!meta) {
    return <GenericNarrationFallback {...props} />;
  }

  const isConversation = meta.scope === "conversation";
  return (
    <div
      data-rename-row="1"
      className="flex flex-wrap items-center justify-center gap-1.5 px-4 py-1 text-text-muted"
    >
      <Pencil aria-hidden className="size-3.5 shrink-0 opacity-60" />
      <span>{isConversation ? "channel renamed" : "workspace renamed"}</span>
      <span className="text-text-secondary">{meta.old_name}</span>
      <span aria-hidden>→</span>
      <span className="font-medium text-text-primary">{meta.new_name}</span>
    </div>
  );
}

// ─── conversation_member_added / _removed row ───────────────────────────

/**
 * One renderer for both member-change events so add and remove read
 * identically (same chrome / centered narration / name-label treatment) —
 * only the icon, verb, and preposition swap off `subtype`. Before this,
 * remove had no structured renderer and fell through to the generic
 * markdown fallback, rendering the raw `@actor removed @member …` text as
 * italic with a pink auto-linked mention — visibly different from add
 * (shiki hYkvtpZXDsU3PEkb).
 */
export function ConversationMemberChangeRow(props: RendererProps): JSX.Element {
  const meta = readConversationMemberChangeMetadata(
    (props.message.metadata ?? null) as Record<string, unknown> | null,
  );
  if (!meta) {
    return <GenericNarrationFallback {...props} />;
  }
  const removed = meta.subtype === "conversation_member_removed";
  const Icon = removed ? UserMinus : UserPlus;
  return (
    <div
      data-conversation-member-change={removed ? "removed" : "added"}
      className="flex flex-wrap items-center justify-center gap-1.5 px-4 py-1 text-text-muted"
    >
      <Icon aria-hidden className="size-3.5 shrink-0 opacity-60" />
      <span className="text-text-secondary">
        {participantLabel({
          kind: meta.actor_kind,
          name: meta.actor_name,
          displayName: meta.actor_display_name,
        })}
      </span>
      <span>{removed ? "removed" : "added"}</span>
      <span className="font-medium text-text-primary">
        {participantLabel({
          kind: meta.member_kind,
          name: meta.member_name,
          displayName: meta.member_display_name,
        })}
      </span>
      <span>{removed ? "from this conversation" : "to this conversation"}</span>
    </div>
  );
}

function participantLabel(input: {
  kind:
    | ConversationMemberChangeMetadata["actor_kind"]
    | ConversationMemberChangeMetadata["member_kind"];
  name: string;
  displayName: string | null;
}): string {
  if (input.kind === "system") return "system";
  // Recognition surface (system-message narration), not a mention — plain
  // display name, no `@` handle
  return input.displayName?.trim() || input.name;
}
