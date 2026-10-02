import {
  createLogicalSend,
  executeLogicalSend,
  matchesLogicalSend,
  prepareLogicalSend,
  type LogicalSend,
} from "./logical-send";
import {
  useMutation,
  useQueryClient,
  type QueryClient,
  type QueryKey,
} from "@tanstack/react-query";
import type {
  AttachmentDto,
  AttachmentRefInput,
  AttachmentSnapshot,
  MessageEventPayload,
  MessageSendAck,
} from "@silverhand/shared";
import {
  apiPaths,
  MAX_MESSAGE_ATTACHMENTS,
  MAX_MESSAGE_CONTENT_LABEL,
  messageContentExceedsLimit,
} from "@silverhand/shared";
import {
  type PendingMessage,
  isCommittedMessage,
  optimisticSelfAuthor,
} from "@/features/channels/pending-message";
import { api, apiUpload } from "@/lib/api";
import { getCurrentUserId } from "@/features/session/current-user";
import { getHydratedViewer } from "@/features/session/hooks";
import { applyCommittedMessage } from "@/features/realtime/conversation-ingestor";
import {
  type MessagesCache,
  type MessagesPageParam,
  messagesKey,
  clusterMessagesKey,
  appendPendingMessage,
  replacePendingMessageInCache,
  rollbackOptimisticSend,
  lastPageIsTail,
} from "@/features/channels/message-cache-core";

export interface SendMessageInput {
  logicalSend?: LogicalSend;
  content: string;
  /** Uploaded attachments to reference. Each carries an optional compose-time
   *  `label` (`Image #N` / `File #N`) — the stable identity assigned when the
   *  file entered the composer, sent verbatim so the agent sees the same
   *  reference the user typed (#task:1324). */
  attachments?: Array<AttachmentDto & { label?: string }>;
}

/**
 * The onMutate → onSuccess/onError hand-off for a send. The three optimistic
 * fields are grouped into ONE optional object so they are present all-together
 * or not-at-all: an optimistic row was inserted, or it was not. This split is
 * what lets the Gate 1 fail-closed path (viewer carrier not hydrated → no
 * optimistic row, #task:1792) still carry the mutation's ACK follow-up —
 * `applyCommittedMessage` must converge the committed row + projections whether
 * or not a temp row exists; only the temp-row REPLACE (onSuccess) and the error
 * ROLLBACK (onError) are conditional on one having been written. A `undefined`
 * context means "no channel", the only genuinely-no-work case.
 */
export interface SendMutationContext {
  optimistic?: {
    /** Temp id of the optimistic row, for the ACK swap. */
    tempId: string;
    /** The pre-send window snapshot, restored on error when nothing concurrent
     *  landed meanwhile. */
    prevWindow: MessagesCache | undefined;
    /** The exact post-write cache reference — the mutation-local CAS token
     *  `rollbackOptimisticSend` compares against to tell "nothing landed since
     *  our write" from "a committed/concurrent fact arrived". */
    writtenRef: MessagesCache | undefined;
  };
}

export function useSendMessage(
  channelId: string | null,
  /** When set, the message is a reply into this root's cluster: the
   *  request carries `reply_to_message_id` and all optimistic cache
   *  writes target the cluster window (`clusterMessagesKey`) instead of
   *  the channel's main stream. On ACK the root's reply-count badge and
   *  preview tail converge through the shared committed-message apply seam
   *  ({@link applyCommittedMessage}), not by waiting for the live `message`
   *  event (#task:1749). */
  threadRootId?: string | null,
) {
  const qc = useQueryClient();
  // Optimistic writes land wherever the reply will actually be read: the
  // cluster window for a reply, the main stream otherwise.
  const targetKey =
    channelId && threadRootId
      ? clusterMessagesKey(channelId, threadRootId)
      : channelId
        ? messagesKey(channelId)
        : null;
  return useMutation({
    mutationFn: async (input: SendMessageInput) => {
      if (!channelId) throw new Error("no channel selected");
      const logical = (input.logicalSend ??= createLogicalSend(channelId, threadRootId ?? null));
      if (logical.conversationId !== channelId || logical.threadRootId !== (threadRootId ?? null)) {
        throw new Error("Send target changed");
      }
      return executeLogicalSend(qc, logical, async () => {
        const prepared = await prepareLogicalSend(logical, () =>
          prepareSendMessageBody({ channelId, input, threadRootId }),
        );
        return api<MessageSendAck>(apiPaths.channelMessages(channelId), {
          method: "POST",
          body: JSON.stringify({ ...prepared, client_message_id: logical.id }),
        });
      });
    },
    // Optimistic update: show the message immediately on Enter, before
    // the HTTP response arrives. The temp message uses a `pending-` id;
    // onSuccess replaces it with the real row (live de-dupe prevents a
    // second append when the event arrives after onSuccess).
    onMutate: async (input: SendMessageInput): Promise<SendMutationContext | undefined> => {
      if (!channelId || !targetKey) return undefined;
      const logical = (input.logicalSend ??= createLogicalSend(channelId, threadRootId ?? null));
      if (
        logical.userId !== getCurrentUserId() ||
        logical.conversationId !== channelId ||
        logical.threadRootId !== (threadRootId ?? null)
      ) {
        throw new Error("Send identity changed");
      }
      // Gate 1 — fail-closed optimistic author. The pending row's author is the
      // current viewer, built COMPLETELY from the hydrated `['me']` carrier (a
      // known-true identity, only ever `active`). If the viewer has not
      // hydrated yet, insert NO optimistic row rather than stitch a
      // plausible-but-fake author from a raw id + a literal fallback. Return an
      // empty context (NOT undefined): the send still fires and onSuccess must
      // still converge the committed row + projections — undefined would make
      // onSuccess's guard skip that too, degrading a flaky connection to no
      // feedback at all (Cindy #task:1792). In every real send this branch is
      // unreached — the composer only exists inside the authenticated shell,
      // which mounts on a resolved viewer.
      const author = optimisticSelfAuthor(getHydratedViewer(qc));
      if (!author) return {};
      const key = targetKey;
      await qc.cancelQueries({ queryKey: key });
      const prev = qc.getQueryData<MessagesCache>(key);
      const known = prev?.pages
        .flatMap((page) => page.messages)
        .find((row) => isCommittedMessage(row) && matchesLogicalSend(logical, row));
      if (known && isCommittedMessage(known)) {
        logical.confirmed = known;
        return {};
      }
      // Invariant: never append optimistic messages to a non-tail
      // window. If the user is browsing an `around_message_id` window
      // (or any other state where `lastPage.has_more_after === true`),
      // appending here would visually attach the new message to the
      // mid-history view, which is a lie about position. Rebuild the
      // cache as a tail-only single page so the optimistic insert
      // — and any subsequent live appends — land on a real tail.
      // `has_more_before: true` lets the user scroll up to fetch
      // earlier history once the latest window is established.
      // This rebuild is undone on error only when no committed/concurrent
      // write landed meanwhile (the onError CAS below); if one did, the temp
      // row is removed surgically and the rebuilt tail window is kept.
      if (prev && !lastPageIsTail(prev)) {
        qc.setQueryData<MessagesCache>(key, {
          pages: [
            {
              messages: [],
              reply_counts_by_root: {},
              has_more_before: true,
              has_more_after: false,
              // Carry the real head forward from the discarded window — don't
              // fabricate one. `prev` is non-empty here (lastPageIsTail false
              // implies at least one page), so its last page's head is the
              // freshest server-observed value.
              stream_head_seq: prev.pages[prev.pages.length - 1]!.stream_head_seq,
            },
          ],
          pageParams: [undefined as MessagesPageParam],
        });
      }
      const tempId = `pending-${logical.id}`;
      const snapshots: AttachmentSnapshot[] | null =
        input.attachments && input.attachments.length > 0
          ? input.attachments.map((a) => ({
              id: a.id,
              filename: a.filename,
              size: a.size,
              content_type: a.content_type,
              // Carry the label so the optimistic bubble shows the same
              // reference the server will echo (no flash-to-relabel on commit).
              ...(a.label ? { label: a.label } : {}),
            }))
          : null;
      const tempMsg: PendingMessage = {
        id: tempId,
        client_message_id: logical.id,
        conversation_id: channelId,
        from_kind: "user",
        from_agent_id: null,
        from_user_id: getCurrentUserId(),
        // Resolved display projection of the raw provenance above. Built from
        // the hydrated viewer (Gate 1) and replaced wholesale by the committed
        // row's authoritative author on ACK (Gate 2), so a locally-stale name /
        // avatar cannot outlive the commit.
        author,
        content: input.content,
        metadata: null,
        attachments: snapshots,
        // No `seq`: the server allocates the MessageSeq on commit. `created_at`
        // is the honest local send time (epoch-ms wall-clock), used only for the
        // row timestamp — never ordered against a real MessageSeq (§3.3).
        created_at: Date.now(),
        thread_root_id: threadRootId ?? null,
        linked_task: null,
        reactions: null,
        pending: true,
      };
      qc.setQueryData<MessagesCache>(key, (cur) => appendPendingMessage(cur, tempMsg));
      // Capture the exact post-write cache reference as a mutation-local CAS
      // token. React Query stores our optimistic object by reference; any
      // authoritative WS apply or concurrent write between now and settle
      // replaces it with a NEW reference. onError uses `current === optimistic`
      // to tell "nothing landed since our write" (safe to restore the prior
      // window) from "a committed/concurrent fact arrived" (must not clobber
      // it — remove only our temp row). No persistent coordination state.
      const optimistic = qc.getQueryData<MessagesCache>(key);
      return { optimistic: { tempId, prevWindow: prev, writtenRef: optimistic } };
    },
    onSuccess: (committed, _input, ctx) => {
      if (!channelId) return;
      applySendSuccess(qc, channelId, targetKey, committed, ctx);
    },
    onError: (_err, _input, ctx) => {
      // Roll back ONLY when this mutation actually wrote an optimistic row; the
      // fail-closed path wrote none, so there is nothing to undo.
      if (!targetKey || !ctx?.optimistic) return;
      const { tempId, prevWindow, writtenRef } = ctx.optimistic;
      // An HTTP error is an AMBIGUOUS result, not proof the send did not
      // commit: rollback must undo ONLY this mutation's optimistic temp fact,
      // never overwrite committed/concurrent facts that arrived after onMutate.
      // The mutation-local CAS lives in `rollbackOptimisticSend` (see its
      // contract) — `writtenRef` is the reference we wrote in onMutate.
      const current = qc.getQueryData<MessagesCache>(targetKey);
      qc.setQueryData<MessagesCache | undefined>(
        targetKey,
        rollbackOptimisticSend(current, prevWindow, writtenRef, tempId),
      );
    },
  });
}

/**
 * The onSuccess seam for a send. Extracted (and exported) so the contract Cindy
 * flagged (#task:1792) is testable without a rendered hook: the committed
 * apply must run WHETHER OR NOT an optimistic row was inserted. Only the
 * temp-row swap is conditional on `ctx.optimistic` — the Gate 1 fail-closed
 * path (viewer not hydrated) writes no temp row but its HTTP ACK still has to
 * converge the committed row + projections, or a flaky connection degrades to
 * no immediate feedback.
 *
 * The swap removes the temp id AND any row a WS echo already appended
 * (`replacePendingMessageInCache` filters both), so ACK↔WS in either order
 * converges to a single row. The shared apply seam has no once-only guard: its
 * effects are data-idempotent (by-id/absolute writes), so this plane and the WS
 * echo may each apply the same committed message safely; only invalidate-only
 * effects may refetch once more (accepted best-effort). It writes no transport
 * water, so the settles are voided (satisfaction is the WS wrapper's job).
 */
export function applySendSuccess(
  qc: QueryClient,
  channelId: string,
  targetKey: QueryKey | null,
  committed: MessageEventPayload,
  ctx: SendMutationContext | undefined,
): void {
  const { message, projections } = committed;
  if (targetKey && ctx?.optimistic) {
    const { tempId } = ctx.optimistic;
    qc.setQueryData<MessagesCache | undefined>(targetKey, (cur) =>
      replacePendingMessageInCache(cur, tempId, message),
    );
  }
  void applyCommittedMessage(qc, channelId, message, projections);
}

/** Upload the final oversized draft as a `text/plain` attachment in the
 *  target channel. Exported for tests. */
export async function uploadContentAsTextAttachment(
  channelId: string,
  content: string,
): Promise<AttachmentDto> {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const file = new File([content], `message-body-${stamp}.txt`, {
    type: "text/plain",
  });
  const form = new FormData();
  form.append("file", file, file.name);
  return await apiUpload<AttachmentDto>(apiPaths.channelAttachments(channelId), form);
}

export interface PreparedSendBody {
  content: string;
  attachment_ids?: Array<string | AttachmentRefInput>;
  reply_to_message_id?: string;
}

/**
 * Build the send-message request body from the final draft. This is the
 * authoritative oversized-content conversion point: whatever path
 * produced the draft (multiple pastes, quote insertion, restored
 * draft), content over the byte cap is uploaded as a text attachment
 * and replaced by a short pointer line — the backend would 413 it.
 * Exactly-at-cap content is sent as-is.
 */
export async function prepareSendMessageBody(opts: {
  channelId: string;
  input: SendMessageInput;
  threadRootId?: string | null;
  /** Injectable for tests; defaults to the real channel upload. */
  uploadText?: typeof uploadContentAsTextAttachment;
}): Promise<PreparedSendBody> {
  const upload = opts.uploadText ?? uploadContentAsTextAttachment;
  let content = opts.input.content;
  let convertedAttachment: AttachmentDto | null = null;
  if (messageContentExceedsLimit(content)) {
    // Capacity check BEFORE uploading: with the composer already at the
    // attachment cap there is no slot for the auto-converted body, and
    // uploading first would leave an invisible orphan attachment on
    // every retry (the send would only fail later at the schema's
    // max-count). Fail fast; the composer's error path restores the
    // draft and pending list intact.
    if ((opts.input.attachments?.length ?? 0) >= MAX_MESSAGE_ATTACHMENTS) {
      throw new Error(
        `The body is over ${MAX_MESSAGE_CONTENT_LABEL} and has to be sent as an attachment, but this message already carries ${MAX_MESSAGE_ATTACHMENTS}. Remove one attachment, or shorten the body.`,
      );
    }
    convertedAttachment = await upload(opts.channelId, content);
    const kb = Math.round(convertedAttachment.size / 1024);
    content = `Sent the long body as a text attachment (${convertedAttachment.filename}, ${kb} KB)`;
  }
  const body: PreparedSendBody = { content };
  const attachmentRefs: Array<string | AttachmentRefInput> = [];
  if (opts.input.attachments && opts.input.attachments.length > 0) {
    // Send `{id, label}` when the composer assigned a stable label, bare id
    // otherwise. The backend normalizes the union and echoes the label —
    // never recomputes it — so chip / body / payload / suffix stay in sync
    // (#task:1324).
    attachmentRefs.push(
      ...opts.input.attachments.map((a) => (a.label ? { id: a.id, label: a.label } : a.id)),
    );
  }
  if (convertedAttachment) {
    attachmentRefs.push(convertedAttachment.id);
  }
  if (attachmentRefs.length > 0) {
    body.attachment_ids = attachmentRefs;
  }
  if (opts.threadRootId) {
    body.reply_to_message_id = opts.threadRootId;
  }
  return body;
}
