import { describe, expect, it } from "vitest";
import type { ConversationLatest } from "./use-conversation-latest";
import {
  orderRecentRows,
  plainPreview,
  recentPreviewText,
  recentTimeLabel,
  type RecentOrderable,
} from "./recent-rows";
import { t } from "@/lib/i18n";

const latest = (overrides: Partial<ConversationLatest>): ConversationLatest =>
  ({
    conversation_id: "c",
    message_id: "m",
    seq: 1,
    created_at: 0,
    thread_root_id: null,
    sender: {
      status: "unresolved",
      kind: "user",
      id: null,
      name: null,
      display_name: null,
      avatar_url: null,
    },
    preview: null,
    attachment_count: 0,
    ...overrides,
  }) as ConversationLatest;

const row = (id: string, createdAt: number, latestAt?: number): RecentOrderable => ({
  id,
  createdAt,
  latest: latestAt === undefined ? null : latest({ conversation_id: id, created_at: latestAt }),
});

describe("orderRecentRows", () => {
  it("orders by the latest message, falling back to creation time", () => {
    const ordered = orderRecentRows(
      [row("old", 1, 10), row("new-empty", 20), row("busy", 2, 30)],
      new Set(),
    );
    expect(ordered.map((r) => r.id)).toEqual(["busy", "new-empty", "old"]);
  });

  it("puts pinned rows first", () => {
    const ordered = orderRecentRows([row("busy", 1, 30), row("pinned", 1, 5)], new Set(["pinned"]));
    expect(ordered.map((r) => r.id)).toEqual(["pinned", "busy"]);
  });

  it("breaks ties on id", () => {
    expect(orderRecentRows([row("b", 5), row("a", 5)], new Set()).map((r) => r.id)).toEqual([
      "a",
      "b",
    ]);
  });
});

describe("recentPreviewText", () => {
  it("prefers the text, then counts the attachments", () => {
    expect(recentPreviewText(latest({ preview: "hi", attachment_count: 2 }))).toBe("hi");
    expect(recentPreviewText(latest({ attachment_count: 1 }))).toBe(
      t("common.attachmentCount", { count: 1 }),
    );
    expect(recentPreviewText(latest({ attachment_count: 3 }))).toBe("3 attachments");
    expect(recentPreviewText(latest({}))).toBe("");
  });
});

describe("plainPreview", () => {
  it("reads references and locators as the names a message shows", () => {
    expect(plainPreview("<silverhand://human/shiki> done, cc <silverhand://agent/Alice>")).toBe(
      "@shiki done, cc @Alice",
    );
    expect(plainPreview("see <silverhand://workspace/silverhand/ui%20polish>")).toBe(
      "see #ui polish",
    );
    expect(plainPreview("in <silverhand://workspace/silverhand>")).toBe("in silverhand");
    expect(plainPreview("<silverhand://dm/Cindy/shiki/abc>")).toBe("@Cindy, @shiki");
  });

  it("drops emphasis and code marks", () => {
    expect(plainPreview("commit **`266ab4837`** landed")).toBe("commit 266ab4837 landed");
  });

  it("leaves a reference cut off by the length cap as written", () => {
    expect(plainPreview("hi <silverhand://hum")).toBe("hi <silverhand://hum");
  });
});

describe("recentTimeLabel", () => {
  const now = new Date(2026, 9, 15, 23, 0).getTime();

  it("shows the time today, then the date", () => {
    expect(recentTimeLabel(new Date(2026, 9, 15, 9, 5).getTime(), now)).toBe("09:05");
    expect(recentTimeLabel(new Date(2026, 9, 14, 0, 0).getTime(), now)).toBe("10/14");
    expect(recentTimeLabel(new Date(2026, 9, 13, 23, 59).getTime(), now)).toBe("10/13");
    expect(recentTimeLabel(new Date(2026, 8, 1).getTime(), now)).toBe("9/1");
    expect(recentTimeLabel(new Date(2025, 8, 1).getTime(), now)).toBe("2025/9/1");
  });
});
