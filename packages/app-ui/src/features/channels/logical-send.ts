import type { QueryClient } from "@tanstack/react-query";
import type { MessageDto } from "@silverhand/shared";
import { getCurrentUserId } from "@/features/session/current-user";
import type { PreparedSendBody } from "./hooks";
import { messagesKey, clusterMessagesKey, type MessagesCache } from "./message-cache-core";

/** In-memory identity owned by the existing draft; never schedules a retry. */
export interface LogicalSend {
  id: string;
  userId: string;
  conversationId: string;
  threadRootId: string | null;
  canonicalContent?: string;
  prepared?: PreparedSendBody;
  preparing?: Promise<PreparedSendBody>;
  confirmed?: MessageDto;
}
export function createLogicalSend(
  conversationId: string,
  threadRootId: string | null,
): LogicalSend {
  const userId = getCurrentUserId();
  if (!userId) throw new Error("No authenticated sender");
  return { id: crypto.randomUUID(), userId, conversationId, threadRootId };
}
export function matchesLogicalSend(send: LogicalSend, message: MessageDto): boolean {
  return (
    typeof message.seq === "number" &&
    !("pending" in message) &&
    send.userId === getCurrentUserId() &&
    message.from_kind === "user" &&
    message.from_user_id === send.userId &&
    message.conversation_id === send.conversationId &&
    message.thread_root_id === send.threadRootId &&
    message.client_message_id === send.id
  );
}
export async function prepareLogicalSend(
  send: LogicalSend,
  prepare: () => Promise<PreparedSendBody>,
): Promise<PreparedSendBody> {
  if (send.prepared) return send.prepared;
  send.preparing ??= prepare();
  try {
    return (send.prepared = await send.preparing);
  } finally {
    send.preparing = undefined;
  }
}
const active = new WeakMap<QueryClient, Set<{ send: LogicalSend }>>();
export function confirmLogicalSend(qc: QueryClient, message: MessageDto): void {
  for (const { send } of active.get(qc) ?? []) {
    if ("seq" in message && matchesLogicalSend(send, message)) send.confirmed = message;
  }
}
export async function executeLogicalSend<T extends { message: MessageDto }>(
  qc: QueryClient,
  send: LogicalSend,
  execute: () => Promise<T>,
): Promise<T | { message: MessageDto }> {
  if (send.userId !== getCurrentUserId()) throw new Error("Sender changed");
  const sends = active.get(qc) ?? new Set<{ send: LogicalSend }>();
  const entry = { send };
  active.set(qc, sends);
  sends.add(entry);
  // A window read can confirm the send while the original HTTP request is pending.
  const unsubscribe = qc.getQueryCache().subscribe((event) => {
    if (event.type !== "updated") return;
    const targetKey = send.threadRootId
      ? clusterMessagesKey(send.conversationId, send.threadRootId)
      : messagesKey(send.conversationId);
    if (JSON.stringify(event.query.queryKey) !== JSON.stringify(targetKey)) return;
    const data = event.query.state.data as MessagesCache | undefined;
    for (const page of data?.pages ?? []) {
      for (const message of page.messages ?? []) {
        if ("seq" in message && matchesLogicalSend(send, message)) send.confirmed = message;
      }
    }
  });
  try {
    const ack = await execute();
    if (!matchesLogicalSend(send, ack.message))
      throw new Error("Message confirmation identity mismatch");
    send.confirmed = ack.message;
    return ack;
  } catch (error) {
    if (send.confirmed && matchesLogicalSend(send, send.confirmed))
      return { message: send.confirmed };
    throw error;
  } finally {
    unsubscribe();
    sends.delete(entry);
    if (!sends.size) active.delete(qc);
  }
}
