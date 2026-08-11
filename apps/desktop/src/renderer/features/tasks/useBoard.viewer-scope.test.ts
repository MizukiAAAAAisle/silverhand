import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// The human task board is the viewer's cross-conversation aggregate, so its live
// refresh must ride the viewer's own private scope (`viewer:<userId>`), NOT a
// workspace-wide scope. The server fans `task_changed` out only to the human
// members of the task's conversation, so a private-channel task never reaches a
// non-member's viewer scope. If the board ever re-subscribed a `workspace:<id>`
// scope it would receive task_changed for channels the viewer isn't a member of.
// So the client-side invariant worth locking is structural + security: the board
// consumes only the current viewer's scope, never a workspace one.
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

describe('board refresh is viewer-scoped, never workspace-scoped', () => {
  const source = readFileSync(
    fileURLToPath(new URL('./useBoard.ts', import.meta.url)),
    'utf8',
  );
  const projection = readFileSync(
    fileURLToPath(new URL('./taskProjection.ts', import.meta.url)),
    'utf8',
  );

  it('subscribes the current viewer scope', () => {
    expect(source).toContain('subscribeViewerScope()');
  });

  it('gates task_changed frames on the current viewer scope', () => {
    expect(source).toContain('isCurrentViewerScope(frame.scope)');
  });

  it('never subscribes or matches a workspace scope for the board', () => {
    // No `workspace:<id>` scope literal, and no generic scope subscribe — the
    // board has exactly one carrier (the viewer scope).
    expect(source).not.toContain('workspace:${');
    expect(source).not.toContain('subscribeWsScope');
  });

  it('applies the absolute task_changed snapshot through the shared applier', () => {
    // The board convergence still flows through the shared idempotent applier
    // (unit-tested separately), so live + replay both settle to the snapshot.
    expect(source).toContain('applyTaskChangedToProjections(qc, payload)');
    // …and that applier is still the one keeping the inline `#task:<n>` chips
    // coherent by exact key (the one path that also repairs a cached MISS).
    expect(projection).toContain('applyTaskChangedToTaskByNumberCache(qc, event)');
  });
});
