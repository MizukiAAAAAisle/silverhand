import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

// Architecture scan, not a behavior test: the shared layers stay domain-neutral,
// so nothing under them may import a feature. Domain UI that needs feature data
// belongs in that feature (see readme.md).

const ROOT = fileURLToPath(new URL(".", import.meta.url));
const SHARED_LAYERS = ["components", "hooks", "lib", "navigation", "icons"];
const FEATURE_IMPORT = /(?:from\s+|import\(\s*)["'](?:@\/features\/|(?:\.\.\/)+features\/)/;

/** Files that predate the fence. The list only shrinks. */
const KNOWN_OFFENDERS: readonly string[] = [
  "components/agent-info-popover.tsx",
  "components/chat/attachment-html-preview.tsx",
  "components/chat/author-avatar-hooks.ts",
  "components/chat/author-grouping.ts",
  "components/chat/channel-message-item.tsx",
  "components/chat/composer-activity-header.tsx",
  "components/chat/composer.tsx",
  "components/chat/conversation-ref.tsx",
  "components/chat/group-messages.ts",
  "components/chat/image-preview-modal.tsx",
  "components/chat/locator-ref.tsx",
  "components/chat/mention.tsx",
  "components/chat/message-item.tsx",
  "components/chat/message-reactions.tsx",
  "components/chat/message-screenshot-view.tsx",
  "components/chat/quoted-message-preview.tsx",
  "components/chat/selection-quote-toolbar.tsx",
  "components/chat/system-message/context-cards.tsx",
  "components/chat/system-message/message-cards.tsx",
  "components/chat/system-message/shared.tsx",
  "components/chat/system-message/task-event.tsx",
  "components/chat/task-ref.tsx",
  "components/chat/thread-anchor.ts",
  "components/chat/use-message-action-surface.ts",
  "components/chat/use-message-render-context.ts",
  "components/human-info-popover.tsx",
  "components/layout/list-drag-sort.tsx",
  "components/layout/nav-rail.tsx",
  "components/layout/titlebar-search.tsx",
  "components/ui/sender-filter-select.tsx",
  "components/ui/workspace-filter-select.tsx",
  "hooks/use-appearance.ts",
];

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      out.push(...walk(path));
    } else if (/\.(ts|tsx)$/.test(name) && !/\.test\.(ts|tsx)$/.test(name)) {
      out.push(path);
    }
  }
  return out;
}

function offenders(): string[] {
  return SHARED_LAYERS.flatMap((layer) => walk(join(ROOT, layer)))
    .filter((file) => FEATURE_IMPORT.test(readFileSync(file, "utf8")))
    .map((file) => relative(ROOT, file).split(sep).join("/"))
    .sort();
}

describe("shared layers never import features", () => {
  it("only known offenders import @/features from a shared layer", () => {
    expect(offenders()).toEqual([...KNOWN_OFFENDERS].sort());
  });
});
