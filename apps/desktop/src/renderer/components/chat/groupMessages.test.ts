import { describe, expect, it } from 'vitest';
import type { MessageDto } from '@silverhand/shared';
import { decodeMessageSeq } from '@silverhand/shared';
import {
  ACTIVITY_RUN_GAP_MS,
  CLUSTERABLE_SUBTYPES,
  groupMessages,
  isClusterableMessage,
} from './groupMessages';

/** Minimal MessageDto factory; only the fields grouping reads need
 *  meaningful values. */
function makeMsg(opts: {
  id: string;
  fromKind?: 'user' | 'agent' | 'system';
  subtype?: string;
  createdAt?: number;
}): MessageDto {
  return {
    id: opts.id,
    conversation_id: 'conv-1',
    from_kind: opts.fromKind ?? 'system',
    from_agent_id: null,
    from_user_id: null,
    content: '',
    metadata: opts.subtype ? { subtype: opts.subtype } : null,
    attachments: null,
    seq: decodeMessageSeq(1),
    created_at: opts.createdAt ?? 0,
    thread_root_id: null,
    linked_task: null,
    reactions: null,
  };
}

const T0 = 1_700_000_000_000;

describe('isClusterableMessage', () => {
  it('returns true for system messages with a clusterable subtype', () => {
    for (const subtype of CLUSTERABLE_SUBTYPES) {
      expect(isClusterableMessage(makeMsg({ id: 'a', subtype }))).toBe(true);
    }
  });

  it('returns false for system messages with a non-clusterable subtype', () => {
    // Spot-check the "info block" subtypes that PR-10 deliberately keeps
    // standalone, plus `rename` / `session_cleared` which were removed from
    // the clusterable set in #task:1145 (one-off notices, not bursty).
    for (const subtype of [
      'schedule_fire',
      'thread_anchor',
      'child_context',
      'channel_context',
      'mention_cc',
      'onboarding',
      'rename',
      'session_cleared',
    ]) {
      expect(isClusterableMessage(makeMsg({ id: 'a', subtype }))).toBe(false);
    }
  });

  it('returns false for system messages with no metadata at all', () => {
    expect(isClusterableMessage(makeMsg({ id: 'a' }))).toBe(false);
  });

  it('returns false for system messages whose subtype is non-string (defensive)', () => {
    const m = makeMsg({ id: 'a' });
    m.metadata = { subtype: 42 } as unknown as Record<string, unknown>;
    expect(isClusterableMessage(m)).toBe(false);
  });

  it('returns false for non-system messages even when subtype-shaped', () => {
    expect(
      isClusterableMessage(
        makeMsg({ id: 'a', fromKind: 'user', subtype: 'task_create' }),
      ),
    ).toBe(false);
    expect(
      isClusterableMessage(
        makeMsg({ id: 'a', fromKind: 'agent', subtype: 'task_create' }),
      ),
    ).toBe(false);
  });
});

describe('groupMessages — basic flow', () => {
  it('returns an empty list for empty input', () => {
    expect(groupMessages([])).toEqual([]);
  });

  it('passes a single non-clusterable message through unchanged', () => {
    const m = makeMsg({ id: 'm1', fromKind: 'user', createdAt: T0 });
    expect(groupMessages([m])).toEqual([{ kind: 'message', message: m }]);
  });

  it('wraps a single clusterable message in a 1-element cluster', () => {
    // Even a lone audit row gets the cluster treatment so its visual
    // weight drops below a real message — otherwise a stray task event
    // dropped between two real messages would still look as heavy as a
    // chat reply.
    const m = makeMsg({ id: 'm1', subtype: 'task_create', createdAt: T0 });
    const out = groupMessages([m]);
    expect(out).toEqual([
      { kind: 'cluster', id: 'activity-cluster:m1', messages: [m] },
    ]);
  });

  it('joins two adjacent clusterable messages into one cluster', () => {
    const a = makeMsg({ id: 'a', subtype: 'task_claim', createdAt: T0 });
    const b = makeMsg({ id: 'b', subtype: 'task_status', createdAt: T0 + 1_000 });
    const out = groupMessages([a, b]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      kind: 'cluster',
      id: 'activity-cluster:a',
      messages: [a, b],
    });
  });

  it('mixes different task_* subtypes in the same cluster', () => {
    // The grouping key is "any clusterable subtype + adjacent + 5min" —
    // not "same subtype". A task_claim followed by a task_status is still
    // one activity strip. (`rename` / `session_cleared` are NOT clusterable
    // since #task:1145 — see the non-clusterable spot-check above.)
    const a = makeMsg({ id: 'a', subtype: 'task_claim', createdAt: T0 });
    const b = makeMsg({ id: 'b', subtype: 'task_status', createdAt: T0 + 1_000 });
    const c = makeMsg({ id: 'c', subtype: 'task_unclaim', createdAt: T0 + 2_000 });
    const out = groupMessages([a, b, c]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ kind: 'cluster', messages: [a, b, c] });
  });
});

describe('groupMessages — adjacency rule', () => {
  it('a non-clusterable message between two clusterable ones flushes the run', () => {
    const a = makeMsg({ id: 'a', subtype: 'task_claim', createdAt: T0 });
    const real = makeMsg({ id: 'real', fromKind: 'user', createdAt: T0 + 1_000 });
    const c = makeMsg({ id: 'c', subtype: 'task_status', createdAt: T0 + 2_000 });
    const out = groupMessages([a, real, c]);
    expect(out).toHaveLength(3);
    expect(out[0]).toMatchObject({ kind: 'cluster', messages: [a] });
    expect(out[1]).toEqual({ kind: 'message', message: real });
    expect(out[2]).toMatchObject({ kind: 'cluster', messages: [c] });
  });

  it('an info-block system message (schedule_fire) also breaks the run', () => {
    // Drift guard: info-block subtypes (schedule_fire / context-card series /
    // mention_cc / onboarding)
    // must NOT be sucked into a cluster — they're real information,
    // not lifecycle noise.
    const a = makeMsg({ id: 'a', subtype: 'task_claim', createdAt: T0 });
    const fire = makeMsg({ id: 'fire', subtype: 'schedule_fire', createdAt: T0 + 1_000 });
    const c = makeMsg({ id: 'c', subtype: 'task_status', createdAt: T0 + 2_000 });
    const out = groupMessages([a, fire, c]);
    expect(out).toHaveLength(3);
    expect(out[0]).toMatchObject({ kind: 'cluster', messages: [a] });
    expect(out[1]).toEqual({ kind: 'message', message: fire });
    expect(out[2]).toMatchObject({ kind: 'cluster', messages: [c] });
  });
});

describe('groupMessages — time gap rule', () => {
  it('keeps two clusterable messages in one cluster when gap <= 5min', () => {
    const a = makeMsg({ id: 'a', subtype: 'task_claim', createdAt: T0 });
    const b = makeMsg({
      id: 'b',
      subtype: 'task_status',
      createdAt: T0 + ACTIVITY_RUN_GAP_MS, // exactly at the boundary; <= passes
    });
    const out = groupMessages([a, b]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ kind: 'cluster', messages: [a, b] });
  });

  it('starts a new cluster when gap > 5min, even with no real message between', () => {
    // The headline reason this rule exists: an idle channel overnight
    // shouldn't fold morning audit rows into yesterday afternoon's run.
    const a = makeMsg({ id: 'a', subtype: 'task_claim', createdAt: T0 });
    const b = makeMsg({
      id: 'b',
      subtype: 'task_status',
      createdAt: T0 + ACTIVITY_RUN_GAP_MS + 1, // just past the boundary
    });
    const out = groupMessages([a, b]);
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ kind: 'cluster', messages: [a] });
    expect(out[1]).toMatchObject({ kind: 'cluster', id: 'activity-cluster:b', messages: [b] });
  });
});

describe('groupMessages — unread-boundary split', () => {
  it('splits a run at the unread separator into two clusters', () => {
    // A,B are above the unread cursor; C,D,E are below. Without the
    // split, one giant cluster would visually span both sides of the
    // separator — users would mis-read which half is new.
    const a = makeMsg({ id: 'a', subtype: 'task_claim', createdAt: T0 });
    const b = makeMsg({ id: 'b', subtype: 'task_status', createdAt: T0 + 1_000 });
    const c = makeMsg({ id: 'c', subtype: 'task_create', createdAt: T0 + 2_000 });
    const d = makeMsg({ id: 'd', subtype: 'task_claim', createdAt: T0 + 3_000 });
    const e = makeMsg({ id: 'e', subtype: 'task_status', createdAt: T0 + 4_000 });
    const out = groupMessages([a, b, c, d, e], {
      unreadSeparatorBeforeMessageId: 'c',
    });
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ kind: 'cluster', messages: [a, b] });
    expect(out[1]).toMatchObject({ kind: 'cluster', messages: [c, d, e] });
  });

  it('does not split when the unread separator is at a non-clusterable position', () => {
    // The unread id points at a real message — the separator naturally
    // breaks the run on its own (real message is non-clusterable), so
    // the unread split has nothing extra to do.
    const a = makeMsg({ id: 'a', subtype: 'task_claim', createdAt: T0 });
    const real = makeMsg({ id: 'real', fromKind: 'user', createdAt: T0 + 1_000 });
    const c = makeMsg({ id: 'c', subtype: 'task_status', createdAt: T0 + 2_000 });
    const out = groupMessages([a, real, c], {
      unreadSeparatorBeforeMessageId: 'real',
    });
    expect(out).toHaveLength(3);
    expect(out[0]).toMatchObject({ kind: 'cluster', messages: [a] });
    expect(out[1]).toEqual({ kind: 'message', message: real });
    expect(out[2]).toMatchObject({ kind: 'cluster', messages: [c] });
  });

  it('null / omitted unread id → no split logic applies', () => {
    const a = makeMsg({ id: 'a', subtype: 'task_claim', createdAt: T0 });
    const b = makeMsg({ id: 'b', subtype: 'task_status', createdAt: T0 + 1_000 });
    expect(groupMessages([a, b], {})).toHaveLength(1);
    expect(groupMessages([a, b], { unreadSeparatorBeforeMessageId: null })).toHaveLength(1);
  });
});

describe('groupMessages — cluster id stability', () => {
  it('cluster id uses the first member id (stable under tail-append)', () => {
    // Reconciliation invariant: when a new clusterable message appends
    // and joins an existing cluster, the cluster's React key must NOT
    // change — otherwise React unmounts/remounts the cluster element
    // and the user sees a flicker every time a new audit row arrives
    // in real time. The first member's id is invariant under append,
    // so it's the natural anchor.
    const a = makeMsg({ id: 'a', subtype: 'task_claim', createdAt: T0 });
    const b = makeMsg({ id: 'b', subtype: 'task_status', createdAt: T0 + 1_000 });
    const before = groupMessages([a])[0]!;
    const after = groupMessages([a, b])[0]!;
    expect(before.kind).toBe('cluster');
    expect(after.kind).toBe('cluster');
    if (before.kind === 'cluster' && after.kind === 'cluster') {
      expect(before.id).toBe(after.id);
      expect(before.id).toBe('activity-cluster:a');
      // ...but the contents grew.
      expect(after.messages).toHaveLength(2);
    }
  });

  it('two distinct runs produce two distinct cluster ids', () => {
    const a = makeMsg({ id: 'a', subtype: 'task_claim', createdAt: T0 });
    const real = makeMsg({ id: 'real', fromKind: 'user', createdAt: T0 + 1_000 });
    const c = makeMsg({ id: 'c', subtype: 'task_status', createdAt: T0 + 2_000 });
    const out = groupMessages([a, real, c]);
    const first = out[0]!;
    const third = out[2]!;
    expect(first.kind).toBe('cluster');
    expect(third.kind).toBe('cluster');
    if (first.kind === 'cluster') expect(first.id).toBe('activity-cluster:a');
    if (third.kind === 'cluster') expect(third.id).toBe('activity-cluster:c');
  });
});

describe('groupMessages — purity', () => {
  it('does not mutate the input array or its elements', () => {
    const a = makeMsg({ id: 'a', subtype: 'task_claim', createdAt: T0 });
    const b = makeMsg({ id: 'b', subtype: 'task_status', createdAt: T0 + 1_000 });
    const input: MessageDto[] = [a, b];
    const inputClone = input.map(m => ({ ...m, metadata: m.metadata ? { ...m.metadata } : null }));
    groupMessages(input);
    expect(input).toHaveLength(2);
    expect(input[0]).toBe(a); // identity preserved
    expect(input[1]).toBe(b);
    // Defensive: per-element shape unchanged.
    for (let i = 0; i < input.length; i++) {
      expect(input[i]!.metadata).toEqual(inputClone[i]!.metadata);
    }
  });

  it('repeated calls on the same input produce equal output (deterministic)', () => {
    const msgs = [
      makeMsg({ id: 'a', subtype: 'task_claim', createdAt: T0 }),
      makeMsg({ id: 'real', fromKind: 'user', createdAt: T0 + 1_000 }),
      makeMsg({ id: 'b', subtype: 'task_status', createdAt: T0 + 2_000 }),
      makeMsg({ id: 'c', subtype: 'task_unclaim', createdAt: T0 + 3_000 }),
    ];
    const a = groupMessages(msgs);
    const b = groupMessages(msgs);
    expect(a).toEqual(b);
  });
});
