import React from "react";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Markdown } from "./markdown";
import { TaskRefContextProvider } from "@/features/task-shell/components/task-ref-context";
import { useTaskByNumber } from "@/features/task-shell/hooks/use-task-by-number";
import { highlightText } from "@/features/search/highlight";
vi.mock("@/features/task-shell/hooks/use-task-by-number", async (orig) => ({
  ...(await orig<typeof import("@/features/task-shell/hooks/use-task-by-number")>()),
  useTaskByNumber: vi.fn(() => ({ data: null, isLoading: true, isError: false })),
}));
beforeEach(() => vi.clearAllMocks());
const content = "#task:123 / #456 / #1 / #task:0007";
function render(taskReferences?: "raw" | "resolve", text = content) {
  const client = new QueryClient();
  const html = renderToStaticMarkup(
    React.createElement(
      QueryClientProvider,
      { client },
      React.createElement(
        TaskRefContextProvider,
        {
          value: {
            conversationId: "current-channel",
            workspaceId: "current-board",
            onOpenTask: vi.fn(),
          },
        },
        React.createElement(Markdown, { content: text, taskReferences }),
      ),
    ),
  );
  client.clear();
  return html;
}

describe("task numbers stay literal outside chat", () => {
  it.each([
    ["description dialog", "../../task-shell/components/task-detail-dialog.tsx", "detail.content"],
    [
      "description side panel",
      "../../task-shell/components/task-detail-panel.tsx",
      "detail.content",
    ],
    ["saved message", "../../chat-shell/saved-list-view.tsx", "item.message.content"],
  ])("%s opts into raw task text even inside a chat task context", (_, path, expression) => {
    const source = readFileSync(new URL(path, import.meta.url), "utf8");
    expect(source).toContain(`<Markdown content={${expression}} taskReferences="raw" />`);
    expect(source).not.toContain("TaskRefScope");
    const html = render("raw");
    expect(html.replace(/<[^>]*>/g, "")).toBe(content);
    expect(html).not.toMatch(/data-task-ref|<a\b|<button\b/);
    expect(useTaskByNumber).not.toHaveBeenCalled();
  });
  it("search preserves literal text and query highlight without task resolution", () => {
    const source = readFileSync(
      new URL("../../search/search-result-item.tsx", import.meta.url),
      "utf8",
    );
    expect(source).toContain("{highlightText(excerpt, query)}");
    const html = renderToStaticMarkup(
      React.createElement(React.Fragment, null, highlightText(content, "#456")),
    );
    expect(html.replace(/<[^>]*>/g, "")).toBe(content);
    expect(html).toContain("<mark");
    expect(html).not.toMatch(/data-task-ref|<a\b|<button\b/);
    expect(useTaskByNumber).not.toHaveBeenCalled();
  });
  it("chat still resolves explicit and bare task numbers", () => {
    render();
    expect(vi.mocked(useTaskByNumber).mock.calls.map((call) => call[1])).toEqual([123, 456]);
  });
  it("raw task mode preserves other reference kinds", () => {
    const text = "#task:123/#general @Alice";
    const html = render("raw", text);
    expect(html.replace(/<[^>]*>/g, "")).toBe(text);
    expect(html).not.toContain("data-task-ref");
    expect(useTaskByNumber).not.toHaveBeenCalled();
  });
});
