import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import type { UserDto } from "@silverhand/shared";
import { HumanProfileCard } from "./HumanProfileCard";
import { setCurrentUserId } from "@/lib/current-user";

setCurrentUserId("u-self", "Self");

function makeUser(overrides: Partial<UserDto> = {}): UserDto {
  return {
    id: "u-self",
    name: "self",
    display_name: "Self",
    avatar_url: null,
    created_at: 0,
    updated_at: 0,
    ...overrides,
  } as UserDto;
}

function render(user: UserDto, viewerId: string): string {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const viewer: UserDto = {
    id: viewerId,
    name: viewerId,
    display_name: viewerId,
    avatar_url: null,
    created_at: 0,
    updated_at: 0,
  } as UserDto;
  qc.setQueryData(["me"], viewer);
  return renderToStaticMarkup(
    React.createElement(
      MemoryRouter,
      null,
      React.createElement(
        QueryClientProvider,
        { client: qc },
        React.createElement(HumanProfileCard, { user }),
      ),
    ),
  );
}

describe("HumanProfileCard mounts no write surface", () => {
  // Profile editing moved to Settings > Account (#task:1846). The card is
  // read-only for EVERY user now — the viewer included — so `/api/me`
  // keeps exactly one long-lived ownership site.
  it("non-self viewer gets no editable affordances", () => {
    const html = render(makeUser({ id: "u-other", display_name: "Other" }), "u-self");
    expect(html).not.toContain('type="file"');
    expect(html).not.toMatch(/aria-label="(Change|Add) avatar"/);
    expect(html).not.toMatch(/aria-label="Edit display name"/);
  });

  it("self viewer gets no editable affordances or editor navigation", () => {
    const html = render(makeUser({ id: "u-self", display_name: "Self" }), "u-self");
    expect(html).not.toContain('type="file"');
    expect(html).not.toMatch(/aria-label="(Change|Add) avatar"/);
    expect(html).not.toMatch(/aria-label="Edit display name"/);
    expect(html).not.toContain("Edit in Settings");
  });

  it("does not offer the route on another human’s profile", () => {
    const html = render(makeUser({ id: "u-other" }), "u-self");
    expect(html).not.toContain("Edit in Settings");
    expect(html).not.toMatch(/sign in as|log in as|switch user/i);
  });
});

describe("HumanProfileCard source — no /api/me ownership", () => {
  const SRC = readFileSync(
    fileURLToPath(new URL("./HumanProfileCard.tsx", import.meta.url)),
    "utf8",
  );
  const CODE = SRC.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");

  it("imports none of the profile mutation hooks or the avatar picker", () => {
    // A second write surface is what this card must never grow back
    // into: an input here that PATCHes would put display name and avatar
    // under two owners again.
    expect(CODE).not.toMatch(/\buseUpdateProfile\b/);
    expect(CODE).not.toMatch(/\buseUploadAvatar\b/);
    expect(CODE).not.toMatch(/AvatarPickerButton/);
    expect(CODE).not.toMatch(/\bInlineText\b/);
  });

  it("carries no local blur-commit path", () => {
    expect(CODE).not.toMatch(/GhostInput/);
    expect(CODE).not.toMatch(/onBlur\s*=/);
  });
});
