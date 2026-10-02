import { describe, expect, it } from "vitest";
import type { MessageAuthorDto, MessageDto } from "@silverhand/shared";
import { decodeMessageSeq } from "@silverhand/shared";
import {
  buildMarkdownTranscript,
  formatSenderLabel,
  suggestImageFilename,
} from "./markdown-transcript";

// Transcript format is the contract that distinguishes single-message
// `Copy markdown` (pure content) from multi-message `Copy markdown`
// (sender + time header per row, sorted by seq, two-blank-line gaps).
// shiki `vBRFDuOuOqhsYzow` flipped multi-select share from Save → Copy
// (clipboard); transcript shape is unchanged.
//
// Identity comes from the ONE `MessageAuthorDto` seam (#task:1792): the label
// is the send-time snapshot, never a live `from_*_id` directory re-join. This
// text surface keeps the `@`-for-agent decoration on TOP of the seam — but
// only when the seam resolved a real handle (`active`/`deleted`); an
// `unresolved` agent stands alone as "Unknown agent". A frozen export retains
// the deleted state (B3), so a `deleted` author also carries the
// `(deleted account)` suffix.

function activeAgent(id: string, name: string, display: string = name): MessageAuthorDto {
  return {
    status: "active",
    kind: "agent",
    id,
    name,
    display_name: display,
    avatar_url: null,
    runtime: "claude",
  };
}

function activeUser(id: string, name: string, display: string = name): MessageAuthorDto {
  return {
    status: "active",
    kind: "user",
    id,
    name,
    display_name: display,
    avatar_url: null,
    runtime: null,
  };
}

function msg(
  id: string,
  seq: number,
  partial: {
    content?: string;
    created_at?: number;
    /** Omit → an active user; pass `null` for a system row. */
    author?: MessageAuthorDto | null;
  } = {},
): MessageDto {
  const author: MessageAuthorDto | null =
    "author" in partial ? partial.author! : activeUser("u1", "User");
  const fromKind: MessageDto["from_kind"] = author === null ? "system" : author.kind;
  const fromAgentId =
    author && author.kind === "agent" && author.status !== "unresolved" ? author.id : null;
  const fromUserId =
    author && author.kind === "user" && author.status !== "unresolved" ? author.id : null;
  return {
    id,
    conversation_id: "c1",
    from_kind: fromKind,
    from_agent_id: fromAgentId,
    from_user_id: fromUserId,
    author,
    content: partial.content ?? `body-${id}`,
    metadata: null,
    attachments: null,
    seq: decodeMessageSeq(seq),
    created_at: partial.created_at ?? 1_700_000_000_000 + seq * 1000,
    thread_root_id: null,
    linked_task: null,
    reactions: null,
  };
}

describe("formatSenderLabel", () => {
  it('active agent → "@<display_name>" when display set', () => {
    const m = msg("m1", 1, { author: activeAgent("a1", "alice", "Alice") });
    expect(formatSenderLabel(m)).toBe("@Alice");
  });

  it('active agent → "@<name>" when display_name is empty after trim', () => {
    const m = msg("m1", 1, { author: activeAgent("a1", "alice", "   ") });
    expect(formatSenderLabel(m)).toBe("@alice");
  });

  it('deleted agent → "@<snapshot label> (deleted account)" — frozen export retains the state (#task:1792 B3)', () => {
    const m = msg("m1", 1, {
      author: {
        status: "deleted",
        kind: "agent",
        id: "a_gone",
        name: "ghost",
        display_name: "Ghost",
        avatar_url: null,
      },
    });
    expect(formatSenderLabel(m)).toBe("@Ghost (deleted account)");
  });

  it('deleted user → "<snapshot label> (deleted account)" with no leading @', () => {
    const m = msg("m1", 1, {
      author: {
        status: "deleted",
        kind: "user",
        id: "u_gone",
        name: "gone",
        display_name: "Gone",
        avatar_url: null,
      },
    });
    expect(formatSenderLabel(m)).toBe("Gone (deleted account)");
  });

  it('unresolved agent → "Unknown agent" with no leading @ (no handle to prefix)', () => {
    const m = msg("m1", 1, {
      author: {
        status: "unresolved",
        kind: "agent",
        id: null,
        name: null,
        display_name: null,
        avatar_url: null,
      },
    });
    expect(formatSenderLabel(m)).toBe("Unknown agent");
  });

  it("active user → label without a leading @", () => {
    const m = msg("m1", 1, { author: activeUser("u1", "shiki", "Shiki") });
    expect(formatSenderLabel(m)).toBe("Shiki");
  });

  it('unresolved user → "Unknown user"', () => {
    const m = msg("m1", 1, {
      author: {
        status: "unresolved",
        kind: "user",
        id: null,
        name: null,
        display_name: null,
        avatar_url: null,
      },
    });
    expect(formatSenderLabel(m)).toBe("Unknown user");
  });

  it('system row (author === null) → "system"', () => {
    const m = msg("m1", 1, { author: null });
    expect(formatSenderLabel(m)).toBe("system");
  });
});

describe("buildMarkdownTranscript", () => {
  const fixedTime = (epoch: number): string => `T${epoch}`;

  it("produces header + blank line + content for a single message", () => {
    const m1 = msg("m1", 1, {
      author: activeAgent("a1", "alice", "Alice"),
      content: "hello",
      created_at: 1000,
    });
    const out = buildMarkdownTranscript([m1], { formatTime: fixedTime });
    // Trailing newline is intentional — POSIX-friendly file ending.
    expect(out).toBe("## @Alice T1000\n\nhello\n");
  });

  it("always includes the sender header even for a single-message transcript", () => {
    // This is the key boundary: single-message export still uses the
    // transcript shape (header included). Single-message Copy markdown
    // is the pure-content path, NOT this one.
    const m1 = msg("m1", 1, {
      author: activeUser("u1", "shiki", "Shiki"),
      content: "shiki says hi",
      created_at: 1000,
    });
    const out = buildMarkdownTranscript([m1], { formatTime: fixedTime });
    expect(out).toContain("## Shiki T1000");
    expect(out).toContain("shiki says hi");
  });

  it("separates consecutive messages with two blank lines", () => {
    const m1 = msg("m1", 1, {
      author: activeAgent("a1", "alice", "Alice"),
      content: "first",
      created_at: 1000,
    });
    const m2 = msg("m2", 2, {
      author: activeUser("u1", "shiki", "Shiki"),
      content: "second",
      created_at: 2000,
    });
    const out = buildMarkdownTranscript([m1, m2], { formatTime: fixedTime });
    expect(out).toBe("## @Alice T1000\n\nfirst\n\n\n## Shiki T2000\n\nsecond\n");
  });

  it("preserves the order in which messages are passed in", () => {
    // The function does NOT re-sort — production callers run it on
    // selectionSorted() which is already canonical. This test pins
    // that contract (no hidden re-sort).
    const m1 = msg("m1", 5, {
      author: activeAgent("a2", "cindy", "Cindy"),
      content: "fifth",
      created_at: 5000,
    });
    const m2 = msg("m2", 1, {
      author: activeAgent("a1", "alice", "Alice"),
      content: "first",
      created_at: 1000,
    });
    const out = buildMarkdownTranscript([m1, m2], { formatTime: fixedTime });
    // Cindy first, then Alice — matches input order, not seq order.
    expect(out.indexOf("Cindy")).toBeLessThan(out.indexOf("Alice"));
  });

  it("falls back to ISO time when no formatter passed", () => {
    const m1 = msg("m1", 1, {
      author: activeAgent("a1", "alice", "Alice"),
      created_at: Date.UTC(2026, 4, 25, 0, 0, 0),
    });
    const out = buildMarkdownTranscript([m1]);
    expect(out).toContain("2026-05-25T00:00:00.000Z");
  });

  it("handles multi-paragraph content without mangling internal newlines", () => {
    const m1 = msg("m1", 1, {
      author: activeAgent("a1", "alice", "Alice"),
      content: "line one\n\nline two",
      created_at: 1000,
    });
    const out = buildMarkdownTranscript([m1], { formatTime: fixedTime });
    expect(out).toContain("line one\n\nline two");
  });
});

describe("suggestImageFilename", () => {
  const m = msg("m1", 42);

  it("combines sanitized title and first-message seq for png", () => {
    expect(suggestImageFilename([m], "design discussion")).toBe("design-discussion-42.png");
  });

  it("strips path-unsafe characters", () => {
    expect(suggestImageFilename([m], 'a/b\\c:d*e?f"g<h>i|j')).toBe("abcdefghij-42.png");
  });

  it("falls back when title is null", () => {
    expect(suggestImageFilename([m], null)).toBe("transcript-42.png");
  });

  it("uses 0 seq when messages array is empty", () => {
    expect(suggestImageFilename([], "foo")).toBe("foo-0.png");
  });

  it("truncates very long titles to keep the filename usable", () => {
    const long = "x".repeat(200);
    const out = suggestImageFilename([m], long);
    // 80-char prefix + "-42.png"
    expect(out.length).toBeLessThanOrEqual(80 + "-42.png".length);
  });
});
