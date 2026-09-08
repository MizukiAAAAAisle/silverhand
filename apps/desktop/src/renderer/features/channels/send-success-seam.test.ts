import { afterEach, describe, expect, it, vi } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import type { MessageAuthorDto, MessageDto, MessageEventPayload } from "@silverhand/shared";
import { decodeMessageSeq } from "@silverhand/shared";
import { applySendSuccess } from "./hooks";
import { appendPendingMessage, messagesKey, type MessagesCache } from "./message-cache-core";
import type { PendingMessage } from "./pending-message";

// The onSuccess seam contract (#task:1792): the committed apply must run
// WHETHER OR NOT an optimistic row was inserted. The Gate 1 fail-closed path
// (viewer carrier not hydrated) writes no temp row, but its HTTP ACK must still
// converge the committed row + projections — otherwise a flaky connection
// degrades to no immediate feedback. Only the temp-row swap is conditional.
//
// `applyCommittedMessage` is the shared convergence seam (already tested in
// conversation-ingestor.test.ts); here it is mocked so the test asserts ONE
// thing — that applySendSuccess CALLS it unconditionally — rather than
// re-testing what it does.
vi.mock("@/features/realtime/conversation-ingestor", () => ({
  applyCommittedMessage: vi.fn(),
}));
import { applyCommittedMessage } from "@/features/realtime/conversation-ingestor";

const applyMock = vi.mocked(applyCommittedMessage);

afterEach(() => {
  applyMock.mockClear();
});

const AUTHOR: MessageAuthorDto = {
  status: "active",
  kind: "user",
  id: "u1",
  name: "u1",
  display_name: "User One",
  avatar_url: null,
  runtime: null,
};

function committed(id: string, seq: number): MessageDto {
  return {
    id,
    conversation_id: "c1",
    from_kind: "user",
    from_agent_id: null,
    from_user_id: "u1",
    author: AUTHOR,
    content: id,
    metadata: null,
    attachments: null,
    seq: decodeMessageSeq(seq),
    created_at: 0,
    thread_root_id: null,
    linked_task: null,
    reactions: null,
  };
}

function pending(tempId: string): PendingMessage {
  return {
    id: tempId,
    conversation_id: "c1",
    from_kind: "user",
    from_agent_id: null,
    from_user_id: "u1",
    author: AUTHOR,
    content: "draft",
    metadata: null,
    attachments: null,
    created_at: 0,
    thread_root_id: null,
    linked_task: null,
    reactions: null,
    pending: true,
  };
}

function payload(message: MessageDto): MessageEventPayload {
  return { message, projections: undefined };
}

function ids(cache: MessagesCache | undefined): string[] {
  return (cache?.pages ?? []).flatMap((p) => p.messages.map((m) => m.id));
}

describe("applySendSuccess — committed apply runs regardless of an optimistic row (#task:1792)", () => {
  it("Gate 1 fail-closed (ctx has no optimistic row): still applies the committed message", () => {
    const qc = new QueryClient();
    const msg = committed("m10", 10);

    // No temp row was ever written (viewer carrier not hydrated).
    applySendSuccess(qc, "c1", messagesKey("c1"), payload(msg), {});

    // The convergence seam must still fire — this is the exact branch that a
    // bare `if (!ctx) return` used to skip, leaving only the WS echo.
    expect(applyMock).toHaveBeenCalledTimes(1);
    expect(applyMock).toHaveBeenCalledWith(qc, "c1", msg, undefined);
    // And no attempt to swap a temp row that does not exist.
    expect(ids(qc.getQueryData<MessagesCache>(messagesKey("c1")))).toEqual([]);
  });

  it("undefined ctx (defensive) also converges", () => {
    const qc = new QueryClient();
    const msg = committed("m11", 11);

    applySendSuccess(qc, "c1", messagesKey("c1"), payload(msg), undefined);

    expect(applyMock).toHaveBeenCalledTimes(1);
  });

  it("with an optimistic row: swaps the temp row AND converges", () => {
    const qc = new QueryClient();
    const key = messagesKey("c1");
    const cache = appendPendingMessage(undefined, pending("pending-1"));
    qc.setQueryData<MessagesCache>(key, cache);
    const msg = committed("m10", 10);

    applySendSuccess(qc, "c1", key, payload(msg), {
      optimistic: { tempId: "pending-1", prevWindow: undefined, writtenRef: cache },
    });

    // Temp row replaced by the committed one (applyCommittedMessage is mocked,
    // so this reflects the swap step alone).
    expect(ids(qc.getQueryData<MessagesCache>(key))).toEqual(["m10"]);
    expect(applyMock).toHaveBeenCalledTimes(1);
  });
});
