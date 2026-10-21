import type { ConversationLatest } from "./use-conversation-latest";
import { t } from "@/lib/i18n";
import { plainTextFromMarkdown } from "@/lib/plain-text-from-markdown";

/** What ordering needs from a Recent row. Rows come from the conversation lists
 *  the tree already reads; `latest` only adds the preview and the order. */
export interface RecentOrderable {
  id: string;
  createdAt: number;
  latest: ConversationLatest | null;
}

/** Pinned (starred) rows first, then the rest; inside each group the newest
 *  message leads. A conversation with no message yet sorts by when it was
 *  created. Ties break on id so the order never flickers. */
export function orderRecentRows<T extends RecentOrderable>(
  rows: readonly T[],
  pinned: ReadonlySet<string>,
): T[] {
  const at = (row: T) => row.latest?.created_at ?? row.createdAt;

  return [...rows].sort(
    (a, b) =>
      Number(pinned.has(b.id)) - Number(pinned.has(a.id)) ||
      at(b) - at(a) ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
}

/** The preview line as text: the message, else how many files it carries. */
export function recentPreviewText(latest: ConversationLatest): string {
  if (latest.preview) {
    return plainTextFromMarkdown(latest.preview);
  }
  if (latest.attachment_count === 0) {
    return "";
  }

  return t("common.attachmentCount", { count: latest.attachment_count });
}

/** Today shows the time, older messages the date. */
export function recentTimeLabel(at: number, now: number): string {
  const date = new Date(at);
  const startOfToday = new Date(now).setHours(0, 0, 0, 0);
  if (at >= startOfToday) {
    return date.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  }
  if (date.getFullYear() === new Date(now).getFullYear()) {
    return `${date.getMonth() + 1}/${date.getDate()}`;
  }

  return `${date.getFullYear()}/${date.getMonth() + 1}/${date.getDate()}`;
}
