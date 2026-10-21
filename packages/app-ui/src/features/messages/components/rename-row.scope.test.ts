import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { MessageDto } from "@silverhand/shared";
import { decodeMessageSeq } from "@silverhand/shared";
import { SystemMessage } from "./system-message";
import { t } from "@/lib/i18n";

/** Minimal rename system message. `RenameRow` reads the structured
 *  `RenameMetadata` (old_name / new_name / scope), so only the metadata
 *  shape matters here. */
function renameMessage(meta: Record<string, unknown>): MessageDto {
  return {
    id: "sys-rename-1",
    conversation_id: "conv-1",
    from_kind: "system",
    from_agent_id: null,
    from_user_id: null,
    author: null,
    content: "",
    metadata: { subtype: "rename", ...meta },
    attachments: null,
    seq: decodeMessageSeq(1),
    created_at: 0,
    thread_root_id: null,
    linked_task: null,
    reactions: null,
  };
}

describe("RenameRow scope (#task:1109)", () => {
  it("defaults to a workspace rename when legacy rows carry no scope", () => {
    const html = renderToStaticMarkup(
      React.createElement(SystemMessage, {
        message: renameMessage({ old_name: "设计 评审", new_name: "beta" }),
      }),
    );
    // `scope` splits only the VERB (a workspace rename broadcasts to every
    // channel, a channel rename does not) — and legacy rows without it default
    // to 'workspace'.
    expect(html).toContain(t("messages.projectRenamed"));
    // A workspace name is a free-text label since #task:1827 — Chinese and
    // spaces are legal and it is not `#`-addressable, so BOTH scopes render the
    // bare name. A `#` prefix would spell a channel reference resolving to
    // nothing.
    expect(html).toContain("设计 评审");
    expect(html).toContain("beta");
    expect(html).not.toContain("#设计");
    expect(html).not.toContain("#beta");
  });

  it("renders a channel rename without the # sigil for conversation scope", () => {
    const html = renderToStaticMarkup(
      React.createElement(SystemMessage, {
        message: renameMessage({
          old_name: "old room",
          new_name: "UI/UX 优化",
          scope: "conversation",
        }),
      }),
    );
    expect(html).toContain(t("messages.channelRenamed"));
    // Freeform titles (spaces / CJK) render bare, same as workspace labels.
    expect(html).toContain("UI/UX 优化");
    expect(html).not.toContain("#UI/UX");
    expect(html).not.toContain("#old room");
  });
});
