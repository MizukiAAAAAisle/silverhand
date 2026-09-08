import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// The human task board is the viewer's cross-conversation aggregate, so its
// `task_changed` refresh must ride the viewer's own private scope
// (`viewer:<userId>`), NEVER a workspace-wide scope. The server fans
// `task_changed` out only to the human members of the task's conversation
// (`broadcaster.ts:216` — a `workspace:<id>` publish is explicitly refused there
// because it would leak a private channel's task snapshot to every workspace
// member). If the board APPLIED a `task_changed` it matched on a workspace scope,
// it would ingest a task for a channel the viewer isn't a member of. So the
// invariant worth locking is structural + security: task data is written into the
// board cache in exactly ONE place, gated on the current viewer scope.
//
// A workspace-scope SUBSCRIPTION is NOT itself the hazard — and after #task:2041
// the board legitimately has one. §4-A of the placement contract makes a card's
// `channel_name` a LIVE projection: a channel rename/archive fires
// `workspace_channels_changed` on that channel's `workspace:<id>` scope with no
// `task_changed`, so the board subscribes those scopes to re-read the fresh name.
// That path is safe because (a) the server never publishes `task_changed` on a
// workspace scope, so none is delivered there to match, and (b) the handler's only
// side effect is to INVALIDATE the board columns, re-reading through the
// ACL-gated board endpoint — it never writes a task payload into the cache. The
// fence therefore locks the write path (one applier call, viewer-gated), not the
// mere presence of a workspace subscription.
//
// This fence reads `useBoard.ts`, which owns the board's single app-level
// listener (`useTaskBoardRealtime`). It used to read `hooks.ts`, where the
// listener lived inside the retired fetch-all `useTasks` (#task:1892) — and
// `hooks.ts` still subscribes the viewer scope for the DETAIL modal, so leaving
// the fence pointed there would have kept passing while covering a different
// projection. A fence that survives the removal of its subject by silently
// changing subject is worse than a red one.
//
// Live vs replay convergence is NOT a separate path: replay re-delivers the same
// `event` frames through the identical `onWsFrame` handler, and the cache
// application (`applyTaskChangedToProjections`, which routes the inline-chip half
// through `applyTaskChangedToTaskByNumberCache`) is unit-tested in
// `taskProjection.test.ts` / `useTaskByNumber.test.ts`. This fence covers the
// scope boundary only.
//
// Desktop test env is `node` (no jsdom/RTL), so — like the sibling fences — we
// assert the source structure rather than render the hook.

describe("board refresh: task_changed is viewer-scoped; workspace scope only invalidates", () => {
  const source = readFileSync(fileURLToPath(new URL("./useBoard.ts", import.meta.url)), "utf8");
  const projection = readFileSync(
    fileURLToPath(new URL("./taskProjection.ts", import.meta.url)),
    "utf8",
  );

  it("subscribes the current viewer scope as the task_changed carrier", () => {
    expect(source).toContain("subscribeViewerScope()");
  });

  it("gates task_changed frames on the current viewer scope", () => {
    expect(source).toContain("isCurrentViewerScope(frame.scope)");
  });

  it("writes task data into the board cache in exactly one (viewer-gated) place", () => {
    // The single cache-writing call. Exactly one occurrence means no workspace-
    // scope handler can also apply a task snapshot — the security boundary. It is
    // the viewer-gated `payload`, so a task the viewer isn't a member of never
    // reaches the cache.
    const applierCalls = source.match(/applyTaskChangedToProjections\(/g) ?? [];
    expect(applierCalls).toHaveLength(1);
    expect(source).toContain("applyTaskChangedToProjections(qc, payload)");
    // Count-of-one does NOT by itself prove WHERE that call sits: moving the
    // single applier into the §4-A workspace-scope handler would keep both the
    // count and the `isCurrentViewerScope` assertion above green, which is
    // exactly the hazard this fence claims to prevent (@Paul review). So bind it
    // to position — nothing from the §4-A channel-name effect onward may apply a
    // task payload; the applier lives in the viewer block, before it. The marker
    // guard fails loudly if that comment is renamed, rather than slicing at -1
    // and passing vacuously.
    const S4A_MARKER = "§4-A channel-name fact edge";
    expect(source).toContain(S4A_MARKER);
    const afterS4A = source.slice(source.indexOf(S4A_MARKER));
    expect(afterS4A).not.toContain("applyTaskChangedToProjections(");
    // …and that applier is still the one keeping the inline `#task:<n>` chips
    // coherent by exact key (the one path that also repairs a cached MISS).
    expect(projection).toContain("applyTaskChangedToTaskByNumberCache(qc, event)");
  });

  it("subscribes workspace scopes ONLY for the §4-A channel-name edge, and only to invalidate", () => {
    // The board DOES subscribe workspace scopes now (channel-name liveness), but
    // the ONLY frame kind it acts on there is `workspace_channels_changed`, and
    // the ONLY side effect is a board-column re-read. No `task_changed` is matched
    // or applied from a workspace scope (the applier count above is 1, in the
    // viewer block), so a private-channel task still cannot reach a non-member.
    expect(source).toContain("frame.kind === 'workspace_channels_changed'");
    expect(source).toContain("queryKey: ['tasks', 'board', 'column']");
  });
});
