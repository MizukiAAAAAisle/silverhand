// Viewer-local projection removal CONTRACT test (#task:1411 → #task:1412).
//
// The behavioural + wiring guards for the removal contract. The COMPILE-TIME
// fail-loud proofs (cleanup mandatory / non-attributed rejected / exhaustive
// dispatch) live in `viewer-removal-contract.type-test.ts`; here we cover:
//   1. WHOLE-CACHE INVARIANT — after removal the workspace appears NOWHERE in
//      the cache (form-agnostic, structured exact match). Also proves the
//      layer-1 sweep drops the whole `['workspaces', wsId, …]` family.
//   2. REGISTRY ↔ SEED lockstep — every registered read model is exercised.
//   3. CLASSIFICATION ↔ REGISTRY consistency + the source smoke (layer 3): every
//      exported read-model key is registry-handled or exempt-with-reason.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { QueryClient } from '@tanstack/react-query';
import {
  activityKey,
  attentionBadgesKey,
  attentionModesKey,
} from '../attention/hooks';
import { favoritesKey } from '../favorites/hooks';
import {
  messageUnreadByConversationKey,
  messageUnreadSummaryKey,
} from '../channels/message-unread';
import {
  handleViewerWorkspaceRemoved,
  VIEWER_LOCAL_KEY_CLASSIFICATION,
  VIEWER_LOCAL_READ_MODELS,
} from './viewer-removal-contract';

const REMOVED = 'ws-removed';
const SURVIVOR = 'ws-survivor';

// Seed each registered read model with the removed + a survivor workspace, keyed
// by registry id. A runtime lockstep test asserts this set equals the registry,
// so a new read model with no seed here is caught.
const SEEDS: Record<string, (qc: QueryClient) => void> = {
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
      // The real DTO carries sort entries whose `entity_id` is the row's
      // `favorite_key` (composite `<kind>:<wsId>`). An empty `entries` here was
      // the false-green Cindy flagged: the removed workspace lingers in the sort
      // state even after the rows are gone. Seed composite + a legacy BARE id so
      // both cleanup branches (removedKeys ∋ entity_id, entity_id === wsId) are
      // exercised, plus the survivor's own entry to prove it is untouched.
      viewer_sort: {
        list_key: 'favorites',
        modes: {},
        entries: [
          { entity_id: `workspace:${REMOVED}`, rank: 1, last_accessed_at: 1, starred_at: 1 },
          { entity_id: REMOVED, rank: 2, last_accessed_at: 1, starred_at: 1 },
          { entity_id: `workspace:${SURVIVOR}`, rank: 3, last_accessed_at: 1, starred_at: 1 },
        ],
      },
    });
  },
  'message-unread-summary': qc => {
    qc.setQueryData(messageUnreadSummaryKey, {
      by_workspace: { [REMOVED]: 3, [SURVIVOR]: 5 },
    });
    // by_conversation is workspace-KEYED — dropped by the layer-1 sweep (and, for
    // belt-and-suspenders, by this read model's cleanup). Seed both partitions.
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
  'attention-badges': qc => {
    qc.setQueryData(attentionBadgesKey(), {
      by_workspace: { [REMOVED]: 4, [SURVIVOR]: 6 },
      total: 10,
      // The mute marker (#task:1877) carries the removed id in a SECOND place
      // inside the same entry, so seeding both proves the cleanup drops the id
      // wherever it appears — not just from the count map.
      muted_workspace_ids: [REMOVED, SURVIVOR],
    });
    // The per-workspace tier batch is NOT `['workspaces', …]`-keyed, so the
    // layer-1 sweep cannot see it — seeding it here is what proves this read
    // model's cleanup drops it (the removed id sits in the KEY, which
    // `cacheMentions` checks).
    qc.setQueryData(attentionModesKey(REMOVED), {
      workspace_id: REMOVED,
      muted: false,
      channels: [
        { conversation_id: 'c-gone', mode: 'all', effective_mode: 'all', directed_unread_count: 0 },
      ],
    });
    qc.setQueryData(attentionModesKey(SURVIVOR), {
      workspace_id: SURVIVOR,
      muted: true,
      channels: [
        { conversation_id: 'c-keep', mode: 'all', effective_mode: 'mute', directed_unread_count: 1 },
      ],
    });
  },
};

// A workspace-keyed cache NOT in the registry (channels list lives in
// workspaces/hooks.ts as `['workspaces', wsId, 'channels']`). Seeding it proves
// the layer-1 sweep covers the whole family by FORM, with no registration.
function seedWorkspaceKeyedSiblings(qc: QueryClient): void {
  qc.setQueryData(['workspaces', REMOVED, 'channels'], { items: [REMOVED] });
  qc.setQueryData(['workspaces', SURVIVOR, 'channels'], { items: [SURVIVOR] });
}

/** Structured reference check (no `JSON.stringify().includes()` — that
 *  false-positives on a preview/title CONTAINING the id as a substring). A
 *  workspace is "referenced" iff its id is a whole cached value / array element /
 *  object key, OR a whole DELIMITED SEGMENT of a composite key (favorites' sort
 *  id `workspace:<wsId>`, `dm:<wsId>`). Segment-split on `:` / `/` — not
 *  substring — so an incidental preview like `"…ws-removed…"` is NOT a hit but a
 *  real composite id IS (the exact-match blind spot Cindy flagged: an exact-only
 *  matcher passes a lingering `workspace:<wsId>` sort entry as green). */
function stringReferences(value: string, workspaceId: string): boolean {
  return value === workspaceId || value.split(/[:/]/).includes(workspaceId);
}

function valueReferences(value: unknown, workspaceId: string): boolean {
  if (typeof value === 'string') return stringReferences(value, workspaceId);
  if (Array.isArray(value)) {
    return value.some(v => valueReferences(v, workspaceId));
  }
  if (value && typeof value === 'object') {
    return Object.entries(value).some(
      ([k, v]) => stringReferences(k, workspaceId) || valueReferences(v, workspaceId),
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
        q.queryKey.some(
          seg => typeof seg === 'string' && stringReferences(seg, workspaceId),
        );
      const inData = valueReferences(q.state.data ?? null, workspaceId);
      return inKey || inData;
    });
}

describe('viewer-local projection removal contract (#task:1412)', () => {
  it('registry & seed set stay in lockstep (every read model is exercised)', () => {
    const registered = VIEWER_LOCAL_READ_MODELS.map(m => m.id).sort();
    const seeded = Object.keys(SEEDS).sort();
    expect(seeded).toEqual(registered);
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

  describe('classification is registry-anchored (layer 3, not a drifting hand-list)', () => {
    it('the `cleaned` set corresponds 1:1 to the registry keys', () => {
      // Map each cleaned symbol name to its actual key value.
      const keyBySymbol: Record<string, unknown> = {
        activityKey: activityKey(),
        favoritesKey,
        messageUnreadSummaryKey,
        attentionBadgesKey: attentionBadgesKey(),
      };
      // Every cleaned symbol is a known key…
      for (const name of VIEWER_LOCAL_KEY_CLASSIFICATION.cleaned) {
        expect(keyBySymbol[name]).toBeDefined();
      }
      // …and every registry entry's key is one of the cleaned symbols' keys, and
      // the counts match — so `cleaned` cannot drift from the registry.
      const cleanedKeys = VIEWER_LOCAL_KEY_CLASSIFICATION.cleaned.map(n =>
        JSON.stringify(keyBySymbol[n]),
      );
      for (const rm of VIEWER_LOCAL_READ_MODELS) {
        expect(cleanedKeys).toContain(JSON.stringify(rm.key));
      }
      expect(VIEWER_LOCAL_KEY_CLASSIFICATION.cleaned.length).toBe(
        VIEWER_LOCAL_READ_MODELS.length,
      );
    });

    it('cleaned ∩ exempt = ∅ and every exempt has a reason', () => {
      const cleaned = new Set<string>(VIEWER_LOCAL_KEY_CLASSIFICATION.cleaned);
      for (const name of Object.keys(VIEWER_LOCAL_KEY_CLASSIFICATION.exempt)) {
        expect(cleaned.has(name)).toBe(false);
      }
      for (const reason of Object.values(VIEWER_LOCAL_KEY_CLASSIFICATION.exempt)) {
        expect(reason.length).toBeGreaterThan(0);
      }
    });
  });

  // Layer 3 smoke: a viewer-local cache added to a read-model file without a
  // removal decision must not slip through unclassified.
  describe('source smoke: every exported read-model key is classified', () => {
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

    it('finds keys to check (smoke is not vacuous)', () => {
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
              `Register it in VIEWER_LOCAL_READ_MODELS (then add its symbol to ` +
              `VIEWER_LOCAL_KEY_CLASSIFICATION.cleaned) or add it to .exempt with a reason.`,
          ).toBe(true);
        }
      });
    }
  });
});
