import type { ConversationLatest } from "@/features/conversations/latest/use-conversation-latest";

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

const REFERENCE_RE = /<silverhand:\/\/(?:human|agent)\/([^>\s]+)>/g;
const LOCATOR_RE = /<silverhand:\/\/(workspace|dm)\/([^>\s]+)>/g;
const EMPHASIS_RE = /\*\*|__|`/g;

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/** The preview arrives as the author's Markdown source. One line of muted text
 *  cannot draw chips or emphasis, so references read as the names the message
 *  shows (`@shiki`, `#ui polish`) and emphasis marks drop away. */
export function plainPreview(source: string): string {
  return source
    .replace(REFERENCE_RE, (_, handle: string) => `@${handle}`)
    .replace(LOCATOR_RE, (_, root: string, path: string) => {
      const segments = path.split("/").map(decodeSegment);
      if (root === "dm") {
        return segments
          .slice(0, 2)
          .map((handle) => `@${handle}`)
          .join(", ");
      }

      return segments.length >= 2 ? `#${segments[1]}` : segments[0]!;
    })
    .replace(EMPHASIS_RE, "");
}

/** The preview line as text: the message, else how many files it carries. */
export function recentPreviewText(latest: ConversationLatest): string {
  if (latest.preview) {
    return plainPreview(latest.preview);
  }
  if (latest.attachment_count === 0) {
    return "";
  }

  return latest.attachment_count === 1 ? "Attachment" : `${latest.attachment_count} attachments`;
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
