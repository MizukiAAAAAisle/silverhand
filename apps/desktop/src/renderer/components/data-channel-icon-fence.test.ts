import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

// Mechanism-layer fence (#task:1438, Cindy review). The whole point of the
// ChannelIcon / ConversationGlyph primitives is that the `data-channel-icon`
// theme sticker hook is applied in ONE place — so a compact/utility surface
// can never re-inflate it (#task:1437) and an identity surface can never lose
// it. Without this test that guarantee is only a post-migration convention:
// any future TSX could hand-write the attr and nothing would go red. This
// scans renderer source and asserts the hook lives ONLY in the two primitives.
//
// `data-conversation-hash-icon` (the chat-header hero `#`) is a DIFFERENT hook
// and intentionally NOT covered here — the literal we match, `data-channel-icon`,
// is not a substring of it.

const RENDERER_ROOT = fileURLToPath(new URL("..", import.meta.url));
const HOOK = "data-channel-icon";
const ALLOWED = ["components/ChannelIcon.tsx", "components/ConversationGlyph.tsx"];

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

/** Strip block + line comments so a `data-channel-icon` mention inside prose
 *  (there are several, documenting the hook) doesn't count as usage. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

describe("data-channel-icon is a primitive-only hook (#task:1438)", () => {
  it("only ChannelIcon / ConversationGlyph write the hook — no call-site does", () => {
    const offenders = walk(RENDERER_ROOT)
      .filter((f) => stripComments(readFileSync(f, "utf8")).includes(HOOK))
      .map((f) => relative(RENDERER_ROOT, f).split(sep).join("/"))
      .sort();
    expect(offenders).toEqual(ALLOWED);
  });
});
