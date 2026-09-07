import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// #task:1870 — the attention badge roll-up's MEMBERSHIP closure.
//
// Channel membership is a badge input with no badge event of its own: both arms
// of the projection join `conversation_users`, so a self-leave or a third-party
// removal changes the absolute value while `attention_badge_updated` stays
// silent (deliberately — emitting a badge-specific membership frame would encode
// one domain fact as a second dedicated event). The renderer therefore settles
// it by invalidate-and-re-read on `workspace_channels_changed`.
//
// That event is WORKSPACE-scoped, so the closure only holds because a THIRD
// party keeps every one of the viewer's workspace scopes subscribed for the
// app's lifetime: `useForeignWorkspaceChannelRemovalSync` retains
// `workspace:<id>` for all `visibleWorkspaceIds`. The attention listener is
// global (`onWsFrame`), so it sees those frames without subscribing anything
// itself.
//
// This coupling is invisible from either side, and the failure mode is not a
// transient window: these caches are only written by these frames and the client
// sets `refetchOnWindowFocus: false`, so a narrowed subscription set FREEZES a
// wrong badge — including the macOS dock number — until some unrelated event
// happens to arrive. A later bandwidth optimization ("why do we subscribe to
// workspaces the user isn't looking at?") is exactly the plausible change that
// would break it, hence a fence rather than a comment.
//
// Static source fence: the desktop test env is `node` (no jsdom/RTL), same
// approach as `realtime-ingestion-read-inert.test.ts`.

function read(rel: string): string {
  return readFileSync(new URL(rel, import.meta.url), 'utf8');
}

/** Body of `declaration` up to the next top-level `export function`/`function`. */
function sliceFunctionBody(source: string, declaration: string): string {
  const start = source.indexOf(declaration);
  if (start === -1) {
    throw new Error(`could not find "${declaration}" — was it renamed?`);
  }
  const rest = source.slice(start + declaration.length);
  const end = rest.search(/\n(export )?function /);
  return end === -1 ? rest : rest.slice(0, end);
}

describe('attention badge membership closure: every viewer workspace scope stays subscribed', () => {
  it('App mounts the foreign-workspace sync for ALL workspaces, unfiltered', () => {
    const app = read('../conversation-shell/use-conversation-shell.ts') + read('../conversation-shell/use-conversation-invalidation.ts');
    // The id set is every workspace from the authoritative list — a `.filter(`
    // here would silently shrink the badge's live coverage.
    expect(app).toContain('const visibleWorkspaceIds = useMemo(');
    expect(app).toMatch(
      /const visibleWorkspaceIds = useMemo\(\s*\(\) => workspaces\.map\(\(workspace\) => workspace\.id\),/,
    );
    expect(app).toContain('workspaceIds: visibleWorkspaceIds,');
  });

  it('the foreign-workspace sync subscribes every id (the selected skip is handler-only)', () => {
    const src = read('../channels/useViewerChannelRemovalSync.ts');
    const body = sliceFunctionBody(src, 'export function useForeignWorkspaceChannelRemovalSync');
    // `ids` is the whole input set, and the subscribe loop maps over it directly.
    expect(body).toContain("const ids = scopeIdsKey ? scopeIdsKey.split(',') : [];");
    const subscribeAt = body.indexOf('ids.map(id => subscribeWsScope(');
    expect(
      subscribeAt,
      'the per-workspace scope subscription loop was renamed or narrowed — the ' +
        'attention badge depends on it holding EVERY workspace:<id> scope',
    ).toBeGreaterThan(-1);
    // No id is dropped on the way in.
    expect(body.slice(0, subscribeAt)).not.toContain('ids.filter(');
    // The selected-workspace skip must stay DOWNSTREAM of the subscribe loop: it
    // exists so the two reconcilers never race for the pane, NOT to narrow the
    // subscription set. Gating the loop on it would drop the selected
    // workspace's frames from every other global listener too.
    const skipAt = body.indexOf('workspaceId === selectedRef.current');
    expect(skipAt, 'the selected-workspace reconcile skip was renamed').toBeGreaterThan(-1);
    expect(
      skipAt,
      'the selected-workspace skip moved above the subscribe loop — that narrows ' +
        'the subscribed scopes, not just the reconcile',
    ).toBeGreaterThan(subscribeAt);
  });

  it('the attention listener handles workspace_channels_changed on ANY scope', () => {
    const src = read('./hooks.ts');
    const body = sliceFunctionBody(src, 'export function applyAttentionFrame');
    const membershipArm = body.indexOf("frame.kind === 'workspace_channels_changed'");
    const viewerGate = body.indexOf('if (!isViewerScope) return;');
    expect(membershipArm).toBeGreaterThan(-1);
    expect(viewerGate).toBeGreaterThan(-1);
    // The viewer-scope gate belongs to the viewer-scoped kinds BELOW it. Hoisting
    // it above this arm would discard `workspace:<id>` frames — i.e. every
    // membership change in every workspace, since the event is never
    // viewer-scoped.
    expect(
      membershipArm,
      'the viewer-scope gate now precedes the workspace_channels_changed arm — ' +
        'membership changes would no longer settle the badge in ANY workspace',
    ).toBeLessThan(viewerGate);
  });
});
