import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { decideTextareaCommit } from "./inline-textarea";

describe("decideTextareaCommit — nullable long-form", () => {
  it("commits null when clearing an existing description", () => {
    expect(decideTextareaCommit("", "Old text")).toEqual({
      commit: true,
      next: null,
    });
  });
  it("rejects clearing an already-null value (still empty)", () => {
    expect(decideTextareaCommit("", null)).toEqual({ commit: false });
  });
  it("rejects a no-op edit (same content)", () => {
    expect(decideTextareaCommit("Same body", "Same body")).toEqual({
      commit: false,
    });
  });
  it("commits a real change", () => {
    expect(decideTextareaCommit("New body", "Old body")).toEqual({
      commit: true,
      next: "New body",
    });
  });
  it("preserves internal whitespace (only empty-string clears to null)", () => {
    expect(decideTextareaCommit(" ", null)).toEqual({
      commit: true,
      next: " ",
    });
  });
});

describe("InlineTextarea component source — no-blur invariant", () => {
  // Structural regression lock (mirrors InlineText): the edit-mode
  // textarea must not attach an onBlur handler. Long-form drafts must
  // survive focus loss.
  it("the source file contains no onBlur handler", () => {
    const src = readFileSync(
      fileURLToPath(new URL("./inline-textarea.tsx", import.meta.url)),
      "utf8",
    );
    const codeOnly = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
    expect(codeOnly).not.toMatch(/onBlur\s*=/);
  });
});
