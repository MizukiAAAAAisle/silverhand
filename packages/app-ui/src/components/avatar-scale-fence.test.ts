import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

// Mechanism-layer fence for the identity-avatar square scale (#task:1440,
// Cindy review invariant #4 + follow-up). Every identity-avatar square — the
// read-only `<AgentAvatar>` / `<UserAvatar>` AND the editable/picker branches of
// the SAME profile surface (`<EditableAgentAvatar>` / `<AvatarPickerButton>`) —
// must take its size from the `AVATAR_PX` scale, NOT a hand-written numeric
// literal. Without this, "peer rows share a token" and "no size sprawl" are only
// a post-migration convention: any future TSX could write `size={56}` again and
// the read-only vs editable branches of one card would silently re-drift (the
// exact hole Cindy caught: readonly `AgentAvatar` was `3xl` while the editable
// `EditableAgentAvatar` / `AvatarPickerButton` stayed bare `56`). This scans
// renderer source and asserts no such tag carries a numeric `size={NN}`.
//
// Allowed forms: `size={AVATAR_PX.xs}`, `size={size}` (passthrough), or no size
// (defaults to md). Only a raw digit is an offender.

const RENDERER_ROOT = fileURLToPath(new URL("..", import.meta.url));

// Match the OPENING tag of any identity-avatar component. `EditableAgentAvatar`
// / `AvatarPickerButton` are not self-closing and carry arrow-function props
// (`onPick={f => ...}`), so `(?:=>|[^>])` skips a literal `=>` before treating
// `>` as the tag terminator; `\/?>` then matches both `/>` and a plain `>`.
// Anchored at `<` so it matches JSX usage, never the `function` definitions.
const AVATAR_TAG =
  /<(?:AgentAvatar|UserAvatar|EditableAgentAvatar|AvatarPickerButton)\b(?:=>|[^>])*?\/?>/g;
const NUMERIC_SIZE = /\bsize=\{\s*\d/;

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      out.push(...walk(p));
    } else if (/\.(ts|tsx)$/.test(name) && !/\.test\.(ts|tsx)$/.test(name)) {
      out.push(p);
    }
  }
  return out;
}

describe("avatar size is scale-only, never a hand-written literal (#task:1440)", () => {
  it("no identity-avatar tag uses a numeric size={NN} — all go through AVATAR_PX", () => {
    const offenders: string[] = [];
    for (const file of walk(RENDERER_ROOT)) {
      const src = readFileSync(file, "utf8");
      for (const tag of src.match(AVATAR_TAG) ?? []) {
        if (NUMERIC_SIZE.test(tag)) {
          const rel = relative(RENDERER_ROOT, file).split(sep).join("/");
          offenders.push(`${rel}: ${tag.replace(/\s+/g, " ").trim()}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
