// Attention gap-path convergence (#task:1870, @Cindy's second MUST FIX).
//
// The live-event closure is fenced structurally in
// `attention-badge-scope-coverage.test.ts`. This file covers the OTHER half: the
// `snapshot_required` (reconnect / gap-too-large) path, which is not a
// nice-to-have here. Channel membership is a badge input whose ONLY carrier is
// the workspace-scoped `workspace_channels_changed` — nothing viewer-scoped
// restates it — so if the transport swallows one and reports the gap on
// `workspace:<id>`, a viewer-scope-only snapshot arm leaves the badge (and the
// macOS dock number) permanently wrong: these caches are written by these frames
// alone and the client sets `refetchOnWindowFocus: false`.
//
// Behavioural, not a source fence: what matters is WHICH keys a given frame
// invalidates, so the applier is exercised against a real QueryClient. It is a
// pure function of (frame, isViewerScope) precisely so this needs no DOM.
import { describe, expect, it, vi } from 'vitest';
import { QueryClient } from '@tanstack/react-query';
import type { ServerFrame } from '@silverhand/shared';
import { decodeTransportEpoch, decodeTransportSeq } from '@silverhand/shared';
import {
  applyAttentionFrame,
  attentionBadgesKey,
  attentionModesKey,
} from './hooks';

const SELECTED = 'ws_selected';
const OTHER = 'ws_nonselected';
const EPOCH = decodeTransportEpoch('e1');

function snapshotRequired(scope: string): ServerFrame {
  return {
    type: 'snapshot_required',
    scope,
    reason: 'gap_too_large',
    epoch: EPOCH,
    currentSeq: decodeTransportSeq(42),
  };
}

/** Records the query keys handed to `invalidateQueries`, in order. */
function trackInvalidations(qc: QueryClient): string[] {
  const seen: string[] = [];
  vi.spyOn(qc, 'invalidateQueries').mockImplementation((filters?: unknown) => {
    const key = (filters as { queryKey?: unknown } | undefined)?.queryKey;
    seen.push(JSON.stringify(key));
    return Promise.resolve();
  });
  return seen;
}

describe('attention snapshot_required gap path (#task:1870)', () => {
  it('a NON-selected workspace scope re-reads the roll-up and that workspace tier batch', () => {
    const qc = new QueryClient();
    const seen = trackInvalidations(qc);

    applyAttentionFrame(qc, snapshotRequired(`workspace:${OTHER}`), false);

    expect(seen).toContain(JSON.stringify(attentionBadgesKey()));
    expect(seen).toContain(JSON.stringify(attentionModesKey(OTHER)));
    // Narrow on purpose: the gap is confined to that scope, so another
    // workspace's loaded tier batch must not be thrown away with it.
    expect(seen).not.toContain(JSON.stringify(attentionModesKey(SELECTED)));
  });

  it('the viewer scope re-reads the roll-up and EVERY tier batch', () => {
    const qc = new QueryClient();
    const seen = trackInvalidations(qc);

    applyAttentionFrame(qc, snapshotRequired('viewer:u1'), true);

    expect(seen).toContain(JSON.stringify(attentionBadgesKey()));
    // The viewer scope carries the pref / notification / unread frames every
    // batch's `directed_unread_count` rides, so the whole prefix re-reads.
    expect(seen).toContain(JSON.stringify(['attention', 'modes']));
  });

  it('scope families carrying no attention input invalidate nothing', () => {
    // Otherwise every unrelated conversation gap would become an attention
    // refetch — and `conversation-side:` must not be captured by a loose
    // `conversation:`-style prefix test either.
    for (const scope of [
      'conversation:c_1',
      'conversation-side:c_1',
      'app',
      `workspace-ish:${OTHER}`,
    ]) {
      const qc = new QueryClient();
      const seen = trackInvalidations(qc);
      applyAttentionFrame(qc, snapshotRequired(scope), false);
      expect(seen, `${scope} must not touch the attention caches`).toEqual([]);
    }
  });

  it('a workspace-scoped membership event still settles both caches', () => {
    // The live half, asserted behaviourally next to the gap half so the two
    // paths can be read as one contract.
    const qc = new QueryClient();
    const seen = trackInvalidations(qc);

    applyAttentionFrame(
      qc,
      {
        type: 'event',
        scope: `workspace:${OTHER}`,
        seq: decodeTransportSeq(7),
        epoch: EPOCH,
        kind: 'workspace_channels_changed',
        payload: { workspace_id: OTHER, channel_id: 'c_1' },
      },
      false,
    );

    expect(seen).toContain(JSON.stringify(attentionBadgesKey()));
    expect(seen).toContain(JSON.stringify(['attention', 'modes']));
  });

  it('a WORKSPACE-level pref change re-reads the roll-up, a channel-level one does not', () => {
    // The liveness obligation `muted_workspace_ids` brings with it (#task:1877):
    // muting a workspace that sits at 0 moves no number, so there is no badge
    // frame behind this one — the marker's ONLY carrier is this invalidation.
    const prefFrame = (conversationId: string | null): ServerFrame => ({
      type: 'event',
      scope: 'viewer:u1',
      seq: decodeTransportSeq(8),
      epoch: EPOCH,
      kind: 'attention_pref_changed',
      payload: { workspace_id: OTHER, conversation_id: conversationId },
    });

    const wsQc = new QueryClient();
    const wsSeen = trackInvalidations(wsQc);
    applyAttentionFrame(wsQc, prefFrame(null), true);
    expect(wsSeen).toContain(JSON.stringify(attentionBadgesKey()));

    // A channel tier moving cannot change the workspace suppressor, and the
    // count it does move rides its own badge frame — so this arm must stay off
    // the roll-up rather than re-reading it on every menu click.
    const chQc = new QueryClient();
    const chSeen = trackInvalidations(chQc);
    applyAttentionFrame(chQc, prefFrame('c_1'), true);
    expect(chSeen).not.toContain(JSON.stringify(attentionBadgesKey()));
    expect(chSeen).toContain(JSON.stringify(attentionModesKey(OTHER)));
  });
});
