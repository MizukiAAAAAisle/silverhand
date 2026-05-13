import { AtSign, CornerDownRight, Hash } from 'lucide-react';
import { HoverPopover } from './HoverPopover';

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
  /** Current-workspace metadata when available. Cross-workspace refs
   *  are resolved in PR-2; until then they still open the side pane as
   *  an unresolved placeholder. */
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
 * Hover ≥500ms surfaces a popover with the conversation's full
 * metadata — kind, parent (for threads), and id. Falls back to a
 * skeleton when the chip rendered before its metadata resolved.
 */
export function ConversationRef({
  id,
  conversation,
  onOpen,
}: ConversationRefProps): JSX.Element {
  const label = conversation
    ? conversationDisplayName(conversation)
    : `#conv:${shortConversationId(id)}`;
  const tooltip = conversation
    ? `${kindLabel(conversation.kind)} · ${conversationDisplayName(conversation)}`
    : `Open conversation #conv:${id}`;
  const icon = conversationIcon(conversation?.kind);
  const chipBody = (
    <>
      {icon}
      <span className="truncate">{label}</span>
    </>
  );

  const inertChip = (
    <span
      className="inline-flex max-w-[220px] items-center gap-0.5 rounded bg-bg-elevated px-1.5 -mx-0.5 font-medium text-text-muted"
      title={tooltip}
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
      title={tooltip}
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

  return (
    <HoverPopover
      trigger={onOpen ? interactiveChip : inertChip}
      content={
        conversation ? (
          <ConversationPopoverBody id={id} conversation={conversation} />
        ) : (
          <UnresolvedConversationPopoverBody id={id} />
        )
      }
      isContentReady={!!conversation}
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
 * Popover for refs we couldn't resolve — clicking the chip still
 * opens the side pane (which renders its own unresolved placeholder),
 * so the popover only documents the id we *do* have.
 */
function UnresolvedConversationPopoverBody({ id }: { id: string }): JSX.Element {
  return (
    <div className="space-y-2">
      <p className="text-xs text-text-muted">
        Conversation metadata not available in this workspace.
      </p>
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
