import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// In a public channel, task state is readable by anyone but only members may
// WRITE. The inline task chip (`MessageTaskTag`) therefore gates its status
// picker (the mutation entry) on `canMutateLinkedTask`: a member of an open
// channel gets the interactive "Move to" picker; a non-member (or any read-only
// surface) sees the SAME chip — identical glyph / colour / number / assignee —
// as an inert `<span>` with no mutation path. Reading the task state is public;
// only the write is member-gated.
//
// This is a security write-boundary decision branch + an a11y difference, not
// painting — so it earns a test. The desktop test env is `node` (no
// jsdom/RTL), so — like the sibling fences — we assert the source structure
// rather than render.

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

describe("MessageTaskTag — status-picker mutation is member-gated", () => {
  const source = read("./MessageItem.tsx");

  it("has exactly one status mutation entry — the read-only branch cannot write", () => {
    const mutations = source.split("updateStatus.mutate(").length - 1;
    expect(mutations).toBe(1);
  });

  it("early-returns the read-only chip before the mutation branch", () => {
    const guardAt = source.indexOf("if (!canMutate)");
    const mutateAt = source.indexOf("updateStatus.mutate(");
    expect(guardAt).toBeGreaterThan(-1);
    expect(mutateAt).toBeGreaterThan(-1);
    // The `!canMutate` early-return sits before the only mutation call, so a
    // non-member never reaches a writable picker.
    expect(guardAt).toBeLessThan(mutateAt);
  });

  it("the interactive chip is wrapped in StatusPicker; the read-only chip is a bare span", () => {
    // The read-only branch renders a `<span data-message-task-tag` (no picker);
    // the writable branch wraps a `<button` in `<StatusPicker`.
    expect(source).toContain("<span\n        data-message-task-tag");
    expect(source).toContain("<StatusPicker");
  });

  it("names the write affordance on the interactive chip (button role exposes aria-label)", () => {
    expect(source).toContain("(${label}) — click to change status`}");
  });

  it("exposes status to assistive tech on the read-only chip via real sr-only text", () => {
    // The status glyph is aria-hidden and the fill colour is visual-only; a
    // generic span's aria-label is not reliably exposed, so the status name
    // must be real screen-reader text, not an aria-label on the span.
    expect(source).toContain('<span className="sr-only">{label}</span>');
    expect(source).not.toContain("aria-label={`Task #${linkedTask.task_number}（${label}）`}");
  });
});

describe("canMutateLinkedTask is threaded on the write axis", () => {
  it("defaults fail-closed in MessageItem and the list", () => {
    expect(read("./MessageItem.tsx")).toContain("canMutateLinkedTask = false");
    expect(read("../layout/channel-view/message-list.tsx")).toContain(
      "canMutateLinkedTask = false",
    );
  });

  it("ChannelView gates it on membership write access (gate.allowMutations)", () => {
    expect(read("../layout/ChannelView.tsx")).toContain(
      "canMutateLinkedTask={!closed && !isArchived && gate.allowMutations}",
    );
  });

  it("ThreadPanel gates it on membership write access (gate.allowMutations)", () => {
    expect(read("../layout/ThreadPanel.tsx")).toContain(
      "canMutateLinkedTask={!closed && !archived && gate.allowMutations}",
    );
  });
});
