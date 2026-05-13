import { AtSign, CornerDownRight, Hash } from 'lucide-react';

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
  const content = (
    <>
      {icon}
      <span className="truncate">{label}</span>
    </>
  );

  if (!onOpen) {
    return (
      <span
        className="inline-flex max-w-[220px] items-center gap-0.5 rounded bg-bg-elevated px-1.5 -mx-0.5 font-medium text-text-muted"
        title={tooltip}
        data-conversation-ref={id}
      >
        {content}
      </span>
    );
  }

  return (
    <span
      role="button"
      tabIndex={0}
      className="inline-flex max-w-[220px] cursor-pointer items-center gap-0.5 rounded bg-accent-soft px-1.5 -mx-0.5 font-medium text-accent transition-colors hover:bg-accent hover:text-text-on-accent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-border-focus"
      title={tooltip}
      data-conversation-ref={id}
      onClick={event => {
        event.preventDefault();
        event.stopPropagation();
        onOpen(id);
      }}
      onKeyDown={event => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        event.stopPropagation();
        onOpen(id);
      }}
    >
      {content}
    </span>
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
