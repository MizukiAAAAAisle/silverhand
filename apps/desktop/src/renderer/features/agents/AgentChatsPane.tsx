import { useEffect, useMemo, useState, type JSX, type ReactNode } from 'react';
import { FolderTree, MessagesSquare } from 'lucide-react';
import type {
  AgentAuditChatSummary,
  DirectPairCounterpart,
  MessageDto,
} from '@silverhand/shared';
import { resolveAttachmentLabels } from '@silverhand/shared';
import { cn } from '@/lib/cn';
import { AVATAR_PX } from '@/components/avatar-scale';
import { Markdown } from '@/components/chat/Markdown';
import { presentAuthor } from '@/components/chat/author-presentation';
import { openAuditAttachmentExternally } from '@/components/chat/open-attachment';
import {
  AuthorAvatarView,
  AuthorName,
} from '@/components/chat/author-avatar-view';
import { useAgentAuditChats, useAgentChatTranscript } from './audit-hooks';
import { flattenTranscriptPages } from './audit-transcript-paging';

interface AgentChatsPaneProps {
  agentId: string;
}

/**
 * Owner-only, read-only audit of an agent's conversations (#task:2036 part ②).
 * Master-detail like {@link AgentActivityPane}: a rail of the agent's chats
 * (workspace conversations + its DirectPair lines; the AgentInbox is excluded by
 * the backend) and a read-only transcript on the right.
 *
 * READ-ONLY BY CONSTRUCTION: there is no composer, no reaction affordance, no
 * context menu, and no cursor write anywhere in this tree. It reuses the pure
 * presentation helpers (`Markdown` in non-interactive mode, `presentAuthor`) and
 * never the interactive `MessageItem`, so a mutation path cannot leak in through
 * a prop. Attachments are fetched through the dedicated owner-audit bytes face
 * (`agentChatAttachment`), never the membership-scoped `GET /api/attachments/:id`
 * — the owner is auditing a third party's DM, not participating in it.
 *
 * The section itself is owner-gated by the caller ({@link canAuditAgentChats});
 * the backend re-checks (404 then 403) on every request here.
 */
export function AgentChatsPane({ agentId }: AgentChatsPaneProps): JSX.Element {
  const chatsQuery = useAgentAuditChats(agentId, true);
  const chats = chatsQuery.data?.chats;
  const [selectedId, setSelectedId] = useState<string | null>(null);

  // Default the selection to the first chat once the list lands; if the
  // selected chat drops out of a refetched list, fall back to the first again.
  useEffect(() => {
    if (!chats || chats.length === 0) {
      if (selectedId !== null) setSelectedId(null);
      return;
    }
    if (!selectedId || !chats.some(c => c.conversation_id === selectedId)) {
      setSelectedId(chats[0]!.conversation_id);
    }
  }, [chats, selectedId]);

  return (
    <div className="flex min-h-0 flex-1">
      <aside className="flex h-full w-[240px] shrink-0 flex-col overflow-y-auto border-r border-border-subtle bg-bg-floating py-2">
        {chatsQuery.isPending ? (
          <PaneNote>Loading chats…</PaneNote>
        ) : chatsQuery.isError ? (
          <PaneNote>Couldn’t load this agent’s chats.</PaneNote>
        ) : !chats || chats.length === 0 ? (
          <PaneNote>This agent has no conversations yet.</PaneNote>
        ) : (
          chats.map(chat => (
            <ChatRow
              key={chat.conversation_id}
              chat={chat}
              selected={chat.conversation_id === selectedId}
              onSelect={() => setSelectedId(chat.conversation_id)}
            />
          ))
        )}
      </aside>

      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
        {selectedId ? (
          <AgentChatTranscript agentId={agentId} conversationId={selectedId} />
        ) : (
          <div className="flex flex-1 items-center justify-center text-sm text-text-muted">
            Select a conversation to read it.
          </div>
        )}
      </div>
    </div>
  );
}

function PaneNote({ children }: { children: ReactNode }): JSX.Element {
  return <div className="px-3 py-2 text-xs text-text-muted">{children}</div>;
}

/** The counterpart of a DirectPair is the endpoint that is NOT the audited agent
 *  — resolved server-side. Render its display name, or a neutral label when the
 *  other side was deleted. */
function counterpartLabel(counterpart: DirectPairCounterpart): string {
  if (counterpart.status === 'deleted') {
    return counterpart.kind === 'agent' ? 'Deleted agent' : 'Deleted user';
  }
  return counterpart.display_name.trim() || counterpart.name;
}

function ChatRow({
  chat,
  selected,
  onSelect,
}: {
  chat: AgentAuditChatSummary;
  selected: boolean;
  onSelect: () => void;
}): JSX.Element {
  const isWorkspace = chat.placement_kind === 'workspace';
  const title = isWorkspace ? chat.title : counterpartLabel(chat.counterpart);
  const meta = isWorkspace
    ? chat.workspace_name
    : 'Direct message';
  const Icon = isWorkspace ? FolderTree : MessagesSquare;
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-current={selected ? 'true' : undefined}
      className={cn(
        'flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs transition-colors',
        selected
          ? 'bg-bg-hover/60 text-text-primary'
          : 'text-text-muted hover:bg-bg-hover/40 hover:text-text-primary',
      )}
    >
      <Icon className="size-3.5 shrink-0" />
      <span className="flex min-w-0 flex-col">
        <span className="truncate font-medium text-text-primary">{title}</span>
        <span className="truncate text-[length:var(--text-badge)] text-text-muted">
          {meta}
          {chat.archived_at !== null ? ' · archived' : ''}
        </span>
      </span>
    </button>
  );
}

function AgentChatTranscript({
  agentId,
  conversationId,
}: {
  agentId: string;
  conversationId: string;
}): JSX.Element {
  const query = useAgentChatTranscript(agentId, conversationId, true);

  // Flatten the backward-paged windows into one ascending stream — the order,
  // dedup, and pre-load handling all live in the pure paging seam.
  const messages = useMemo(
    () => flattenTranscriptPages(query.data?.pages),
    [query.data],
  );

  if (query.isPending) {
    return <TranscriptNote>Loading transcript…</TranscriptNote>;
  }
  if (query.isError) {
    return <TranscriptNote>Couldn’t load this transcript.</TranscriptNote>;
  }
  if (messages.length === 0) {
    return <TranscriptNote>No messages in this conversation.</TranscriptNote>;
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-6 py-4">
      {query.hasPreviousPage ? (
        <div className="pb-3 text-center">
          <button
            type="button"
            onClick={() => void query.fetchPreviousPage()}
            disabled={query.isFetchingPreviousPage}
            className="text-[length:var(--text-badge)] text-text-muted underline-offset-2 hover:text-text-primary hover:underline disabled:opacity-60"
          >
            {query.isFetchingPreviousPage
              ? 'Loading older messages…'
              : 'Load older messages'}
          </button>
        </div>
      ) : null}
      <div className="flex flex-col gap-4">
        {messages.map(message => (
          <AuditMessageRow
            key={message.id}
            agentId={agentId}
            conversationId={conversationId}
            message={message}
          />
        ))}
      </div>
    </div>
  );
}

function TranscriptNote({ children }: { children: ReactNode }): JSX.Element {
  return (
    <div className="flex flex-1 items-center justify-center text-sm text-text-muted">
      {children}
    </div>
  );
}

function AuditMessageRow({
  agentId,
  conversationId,
  message,
}: {
  agentId: string;
  conversationId: string;
  message: MessageDto;
}): JSX.Element {
  const presentation = message.author ? presentAuthor(message.author) : null;
  const when = formatTimestamp(message.created_at);

  // System messages have no author — render a quiet, centered notice.
  if (!presentation) {
    return (
      <div className="text-center text-xs text-text-muted">
        <Markdown content={message.content} interactive={false} />
      </div>
    );
  }

  return (
    <div className="flex gap-2.5">
      <AuthorAvatarView
        avatar={presentation.avatar}
        size={AVATAR_PX.sm}
        label={presentation.label}
        className="mt-0.5 shrink-0"
      />
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex items-baseline gap-2">
          <AuthorName
            presentation={presentation}
            className="text-sm font-medium text-text-primary"
          />
          <span className="shrink-0 text-[length:var(--text-badge)] text-text-muted">
            {when}
          </span>
          {message.thread_root_id ? (
            <span className="shrink-0 text-[length:var(--text-badge)] text-text-muted">
              · reply
            </span>
          ) : null}
        </div>
        {message.content ? (
          <div className="text-sm text-text-primary">
            <Markdown content={message.content} interactive={false} />
          </div>
        ) : null}
        {message.attachments && message.attachments.length > 0 ? (
          <AuditAttachments
            agentId={agentId}
            conversationId={conversationId}
            attachments={message.attachments}
          />
        ) : null}
      </div>
    </div>
  );
}

function AuditAttachments({
  agentId,
  conversationId,
  attachments,
}: {
  agentId: string;
  conversationId: string;
  attachments: NonNullable<MessageDto['attachments']>;
}): JSX.Element {
  const labels = useMemo(() => resolveAttachmentLabels(attachments), [attachments]);
  return (
    <div className="mt-1.5 flex flex-wrap gap-1.5">
      {attachments.map((att, i) => (
        <AuditAttachmentChip
          key={att.id}
          agentId={agentId}
          conversationId={conversationId}
          attachmentId={att.id}
          label={labels[i] ?? att.filename}
          filename={att.filename}
        />
      ))}
    </div>
  );
}

function AuditAttachmentChip({
  agentId,
  conversationId,
  attachmentId,
  label,
  filename,
}: {
  agentId: string;
  conversationId: string;
  attachmentId: string;
  label: string;
  filename: string;
}): JSX.Element {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onOpen = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    // Reuse the shared, safe open boundary: bytes come from the dedicated
    // owner-audit face (`agentChatAttachment`) — NOT the membership-scoped
    // `GET /api/attachments/:id` — and the open action goes through the
    // main-process `attachment:openExternal` IPC (safe-extension + temp 0600
    // file + `shell.openPath`). No `window.open`, no object URL: a
    // renderer-scoped `blob:` can't be resolved by `shell.openExternal`
    // anyway (surface-ipc denies it), and the blob-URL path leaks a
    // reference every open (attachments cap at 10MB).
    await openAuditAttachmentExternally(
      { agentId, conversationId, attachmentId, filename },
      { onInlineError: setError },
    );
    setBusy(false);
  };

  return (
    <button
      type="button"
      onClick={() => void onOpen()}
      disabled={busy}
      title={error ?? filename}
      className={cn(
        'inline-flex items-center gap-1.5 rounded-[var(--chip-radius)] border border-border bg-bg-elevated px-2 py-1 text-xs text-text-primary transition-colors hover:bg-bg-hover disabled:opacity-60',
        error && 'border-error text-error',
      )}
    >
      <span className="truncate">{label}</span>
      {busy ? <span className="text-text-muted">…</span> : null}
    </button>
  );
}

function formatTimestamp(ms: number): string {
  try {
    return new Date(ms).toLocaleString();
  } catch {
    return '';
  }
}
