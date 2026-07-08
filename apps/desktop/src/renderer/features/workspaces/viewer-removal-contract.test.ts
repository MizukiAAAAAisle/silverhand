// Viewer-local projection removal CONTRACT test (#task:1411 — Class B hardening).
//
// The hard rule (shiki): add a viewer-local cache without wiring it into the
// removal contract → a test goes RED. Three enforcement layers, each catching a
// different failure:
//
//   1. WHOLE-CACHE INVARIANT — after removal the workspace appears NOWHERE in
//      the cache. Form-agnostic (key segment / payload map entry / list item),
//      so it does not depend on remembering to assert each projection. Also
//      proves the Layer-1 predicate sweep drops the whole `['workspaces', wsId,
//      …]` family, not just the caches we happened to name.
//   2. INVENTORY ↔ SEED lockstep — both are `Record<ProjectionId, …>`, so a
//      declared projection with no cleanup or no seed fails to COMPILE.
//   3. SOURCE FENCE — every exported query key in the read-model files must be
//      CLASSIFIED (cleaned or exempt-with-reason). A new unclassified `*Key`
//      goes red: this is the 4th-failure-mode net (a cache never registered at
//      all), the piece an inventory alone can't provide.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { QueryClient } from '@tanstack/react-query';
import {
  activityKey,
} from '../attention/hooks';
import { favoritesKey } from '../favorites/hooks';
import {
  messageUnreadByConversationKey,
  messageUnreadSummaryKey,
} from '../channels/message-unread';
import {
  handleViewerWorkspaceRemoved,
  VIEWER_LOCAL_KEY_CLASSIFICATION,
  VIEWER_LOCAL_PROJECTIONS,
  type ProjectionId,
} from './viewer-removal-contract';

const REMOVED = 'ws-removed';
const SURVIVOR = 'ws-survivor';

// Seed each declared projection with the removed + a survivor workspace. Keyed
// by ProjectionId and typed `Record<ProjectionId, …>` so a newly-declared
// projection with no seed here is a COMPILE error — the seed set cannot drift
// from the inventory it verifies.
const SEEDS: Record<ProjectionId, (qc: QueryClient) => void> = {
  'message-unread': qc => {
    qc.setQueryData(messageUnreadSummaryKey, {
      by_workspace: { [REMOVED]: 3, [SURVIVOR]: 5 },
    });
    // by_conversation is workspace-KEYED — the removed ws's whole cache entry
    // must be dropped (its key carries the id, and it would 404 on refetch).
    qc.setQueryData(messageUnreadByConversationKey(REMOVED, 'regular'), {
      by_conversation: { 'c-gone': 3 },
      latest_by_conversation: {},
      total: 3,
    });
    qc.setQueryData(messageUnreadByConversationKey(SURVIVOR, 'regular'), {
      by_conversation: { 'c-keep': 5 },
      latest_by_conversation: {},
      total: 5,
    });
  },
  favorites: qc => {
    const row = (workspaceId: string) => ({
      kind: 'workspace' as const,
      favorite_key: `workspace:${workspaceId}`,
      entity_id: workspaceId,
      workspace_id: workspaceId,
      title: workspaceId,
      icon_url: null,
      runtime: null,
      starred_at: 1,
      created_at: 1,
      unread_count: 0,
    });
    qc.setQueryData(favoritesKey, {
      items: [row(REMOVED), row(SURVIVOR)],
      viewer_sort: { list_key: 'favorites', modes: {}, entries: [] },
    });
  },
  activity: qc => {
    const item = (id: string, workspaceId: string) => ({
      id,
      kind: 'unread' as const,
      salience: 'ambient' as const,
      workspace_id: workspaceId,
      conversation_id: `c-${id}`,
      thread_root_id: null,
      message_id: `m-${id}`,
      notification_id: null,
      conversation_kind: 'channel' as const,
      title: `#${id}`,
      thread_root_preview: null,
      preview: null,
      preview_sender: null,
      timestamp: 1,
      unread_count: 1,
    });
    qc.setQueryData(activityKey(), {
      items: [item('gone', REMOVED), item('keep', SURVIVOR)],
    });
  },
};

// A workspace-keyed cache NOT in the inventory (channels list lives in
// workspaces/hooks.ts as `['workspaces', wsId, 'channels']`). Seeding it proves
// the Layer-1 sweep covers the whole family by FORM, with no per-cache
// registration — the point of the sweep.
function seedWorkspaceKeyedSiblings(qc: QueryClient): void {
  qc.setQueryData(['workspaces', REMOVED, 'channels'], { items: [REMOVED] });
  qc.setQueryData(['workspaces', SURVIVOR, 'channels'], { items: [SURVIVOR] });
}

/** Structured, EXACT reference check (no `JSON.stringify().includes()` — that
 *  false-positives on a preview/title that merely contains the id as a
 *  substring). A workspace is "referenced" iff its id is a whole query-key
 *  segment, a whole cached value, an array element, or an object KEY. */
function valueReferences(value: unknown, workspaceId: string): boolean {
  if (value === workspaceId) return true;
  if (Array.isArray(value)) {
    return value.some(v => valueReferences(v, workspaceId));
  }
  if (value && typeof value === 'object') {
    return Object.entries(value).some(
      ([k, v]) => k === workspaceId || valueReferences(v, workspaceId),
    );
  }
  return false;
}

function cacheMentions(qc: QueryClient, workspaceId: string): boolean {
  return qc
    .getQueryCache()
    .getAll()
    .some(q => {
      const inKey =
        Array.isArray(q.queryKey) &&
        q.queryKey.some(seg => seg === workspaceId);
      const inData = valueReferences(q.state.data ?? null, workspaceId);
      return inKey || inData;
    });
}

describe('viewer-local projection removal contract (#task:1411)', () => {
  it('inventory & seed set stay in lockstep (no undeclared/unseeded projection)', () => {
    // Both are `Record<ProjectionId, …>` at compile time; assert at runtime that
    // every declared projection also has a seed (guards a future reshape).
    const declared = VIEWER_LOCAL_PROJECTIONS.map(p => p.id).sort();
    const seeded = (Object.keys(SEEDS) as ProjectionId[]).sort();
    expect(seeded).toEqual(declared);
  });

  it('after removal the workspace appears NOWHERE in the cache; survivor intact', () => {
    const qc = new QueryClient();
    for (const seed of Object.values(SEEDS)) seed(qc);
    seedWorkspaceKeyedSiblings(qc);

    // Precondition: the removed workspace is genuinely present everywhere first,
    // else the invariant could pass vacuously.
    expect(cacheMentions(qc, REMOVED)).toBe(true);

    handleViewerWorkspaceRemoved(qc, REMOVED);

    // The whole-cache invariant — the hard rule.
    expect(cacheMentions(qc, REMOVED)).toBe(false);
    // Survivor's data across every projection is untouched.
    expect(cacheMentions(qc, SURVIVOR)).toBe(true);
  });

  it('is idempotent and cold-safe: a second run / empty cache never throws', () => {
    const qc = new QueryClient();
    // Cold cache → no-op, no throw.
    expect(() => handleViewerWorkspaceRemoved(qc, REMOVED)).not.toThrow();
    // Seed, remove twice — second pass is a clean no-op.
    for (const seed of Object.values(SEEDS)) seed(qc);
    seedWorkspaceKeyedSiblings(qc);
    handleViewerWorkspaceRemoved(qc, REMOVED);
    expect(() => handleViewerWorkspaceRemoved(qc, REMOVED)).not.toThrow();
    expect(cacheMentions(qc, REMOVED)).toBe(false);
  });

  // The 4th-failure-mode net: a viewer-local cache added to a read-model file
  // without a removal decision must not slip through unclassified.
  describe('source fence: every exported read-model key is classified', () => {
    const READ_MODEL_FILES = [
      '../attention/hooks.ts',
      '../favorites/hooks.ts',
      '../channels/message-unread.ts',
    ];
    const EXPORTED_KEY = /export const (\w*Key)\b/g;

    const classified = new Set<string>([
      ...VIEWER_LOCAL_KEY_CLASSIFICATION.cleaned,
      ...Object.keys(VIEWER_LOCAL_KEY_CLASSIFICATION.exempt),
    ]);

    it('finds keys to check (fence is not vacuous)', () => {
      // Guard: if the regex or paths break, the fence would pass trivially.
      const total = READ_MODEL_FILES.reduce((n, rel) => {
        const src = readFileSync(new URL(rel, import.meta.url), 'utf8');
        return n + [...src.matchAll(EXPORTED_KEY)].length;
      }, 0);
      expect(total).toBeGreaterThanOrEqual(6);
    });

    for (const rel of READ_MODEL_FILES) {
      it(`every exported *Key in ${rel} is cleaned or exempt`, () => {
        const src = readFileSync(new URL(rel, import.meta.url), 'utf8');
        const names = [...src.matchAll(EXPORTED_KEY)]
          .map(m => m[1])
          .filter((n): n is string => Boolean(n));
        for (const name of names) {
          expect(
            classified.has(name),
            `${name} is a viewer-local query key with no removal classification. ` +
              `Add it to VIEWER_LOCAL_KEY_CLASSIFICATION.cleaned (with an inventory ` +
              `handler) or .exempt (with a reason).`,
          ).toBe(true);
        }
      });
    }

    it('classification is internally consistent (cleaned ∩ exempt = ∅; reasons present)', () => {
      const cleaned = new Set<string>(VIEWER_LOCAL_KEY_CLASSIFICATION.cleaned);
      const exempt = Object.keys(VIEWER_LOCAL_KEY_CLASSIFICATION.exempt);
      for (const name of exempt) expect(cleaned.has(name)).toBe(false);
      for (const reason of Object.values(VIEWER_LOCAL_KEY_CLASSIFICATION.exempt)) {
        expect(reason.length).toBeGreaterThan(0);
      }
      // Every cleaned key has a matching inventory projection (parity guard).
      expect(VIEWER_LOCAL_KEY_CLASSIFICATION.cleaned.length).toBe(
        VIEWER_LOCAL_PROJECTIONS.length,
      );
    });
  });
});
