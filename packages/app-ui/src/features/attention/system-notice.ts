import type { MessageAuthorDto, NotificationDto } from "@silverhand/shared";
import { presentAuthor } from "@/features/messages/model/author-presentation";
import { readableExcerpt } from "./mention-toast";

/** An OS notification's lines. The system already names the app, so the title
 *  carries the subject, not "Silverhand". */
export interface SystemNotice {
  title: string;
  subtitle?: string;
  body?: string;
  /** Stacks a conversation's alerts into one group in Notification Center. */
  groupId?: string;
}

export function systemNoticeOf(n: NotificationDto, fallback: string): SystemNotice {
  const groupId = n.conversation_id ?? undefined;
  if (n.kind === "mention_self") {
    const conversationTitle = payloadString(n, "conversation_title");
    const excerpt = payloadString(n, "mention_excerpt");
    return {
      title: senderLabel(n.sender ?? null) ?? payloadString(n, "trigger_name") ?? "Someone",
      subtitle: conversationTitle ? `in #${conversationTitle}` : undefined,
      body: excerpt ? readableExcerpt(excerpt) : "Mentioned you",
      groupId,
    };
  }
  if (n.kind === "agent_start_failed") {
    const name = payloadString(n, "agent_name") ?? n.agent_id ?? "Agent";
    const reason = payloadString(n, "reason");
    if (reason === "init_timeout") {
      return { title: `@${name} timed out while starting`, groupId };
    }
    if (reason === "runtime_crash") {
      const code = n.payload?.["exit_code"];
      return {
        title: `@${name} exited unexpectedly`,
        body: code != null ? `Exit code ${String(code)}` : undefined,
        groupId,
      };
    }
    return {
      title: `@${name} didn't start`,
      body: payloadString(n, "error") ?? "Unknown error",
      groupId,
    };
  }
  return { title: fallback, groupId };
}

function senderLabel(sender: MessageAuthorDto | null): string | null {
  return sender && sender.status !== "unresolved" ? presentAuthor(sender).label : null;
}

export function payloadString(n: NotificationDto, key: string): string | null {
  const value = n.payload?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
