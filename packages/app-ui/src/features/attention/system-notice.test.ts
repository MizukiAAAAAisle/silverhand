import { describe, expect, it } from "vitest";
import type { NotificationDto } from "@silverhand/shared";
import { systemNoticeOf } from "./system-notice";

const notification = (over: Partial<NotificationDto>): NotificationDto => ({
  id: "n-1",
  kind: "mention_self",
  user_id: "u-1",
  agent_id: null,
  workspace_id: "w-1",
  conversation_id: "c-1",
  message_id: "m-1",
  source_workspace_id: null,
  source_conversation_id: null,
  source_message_id: null,
  payload: null,
  read_at: null,
  created_at: 0,
  ...over,
});

describe("systemNoticeOf", () => {
  it("leads a mention with the sender, then where, then what was said", () => {
    const notice = systemNoticeOf(
      notification({
        payload: {
          trigger_name: "alice",
          conversation_title: "design",
          mention_excerpt: "<silverhand://human/bob> take a look",
        },
        sender: {
          kind: "user",
          status: "active",
          id: "u-2",
          name: "alice",
          display_name: "Alice",
          avatar_url: null,
          runtime: null,
        },
      }),
      "fallback",
    );
    expect(notice).toEqual({
      title: "Alice",
      subtitle: "in #design",
      body: "@bob take a look",
      groupId: "c-1",
    });
  });

  it("falls back to the trigger name and a plain line without an excerpt", () => {
    const notice = systemNoticeOf(notification({ payload: { trigger_name: "alice" } }), "x");
    expect([notice.title, notice.subtitle, notice.body]).toEqual([
      "alice",
      undefined,
      "Mentioned you",
    ]);
  });

  it("puts a failed start's reason under the agent", () => {
    const failed = (payload: Record<string, unknown>) =>
      systemNoticeOf(notification({ kind: "agent_start_failed", payload }), "x");
    expect(failed({ agent_name: "toby", error: "no key" })).toMatchObject({
      title: "@toby didn't start",
      body: "no key",
    });
    expect(failed({ agent_name: "toby", reason: "runtime_crash", exit_code: 1 })).toMatchObject({
      title: "@toby exited unexpectedly",
      body: "Exit code 1",
    });
    expect(failed({ agent_name: "toby", reason: "init_timeout" }).body).toBeUndefined();
  });

  it("keeps other kinds as one line, grouped by conversation", () => {
    expect(
      systemNoticeOf(
        notification({ kind: "mention_external", conversation_id: null }),
        "New mention",
      ),
    ).toEqual({ title: "New mention", groupId: undefined });
  });
});
