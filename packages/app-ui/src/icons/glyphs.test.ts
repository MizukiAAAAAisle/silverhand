import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  AiBrain01Icon,
  ArchiveArrowDownIcon,
  LoginSquare01Icon,
  LogoutSquare01Icon,
} from "@hugeicons/core-free-icons";
import { ArchiveIcon, InboxIcon, JoinIcon, LeaveIcon, ThinkingIcon } from "./glyphs";
import { createIcon, type IconNode } from "./icon";

describe("product icon mappings", () => {
  it.each([
    ["leave", LeaveIcon, LogoutSquare01Icon],
    ["join", JoinIcon, LoginSquare01Icon],
    ["thinking", ThinkingIcon, AiBrain01Icon],
    ["inbox", InboxIcon, ArchiveArrowDownIcon],
  ] as const)("uses the selected %s glyph", (name, Icon, node) => {
    const Expected = createIcon(name, node as IconNode);
    expect(renderToStaticMarkup(createElement(Icon))).toBe(
      renderToStaticMarkup(createElement(Expected)),
    );
  });

  it("draws Archive as scalable rounded outlines, including the handle slot", () => {
    const svg = renderToStaticMarkup(createElement(ArchiveIcon, { size: 16 }));
    expect(svg).toContain('viewBox="0 0 24 24"');
    expect(svg).toContain('stroke-linejoin="round"');
    expect(svg).toContain('stroke-linecap="round"');
    expect(svg).toContain('width="20" height="4" rx="1"');
    expect(svg).toContain('width="6" height="3" rx="1"');
    expect(svg).not.toContain("<image");
  });
});
