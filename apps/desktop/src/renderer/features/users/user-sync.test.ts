import { describe, expect, it } from 'vitest';
import type { ServerFrame } from '@silverhand/shared';
import { decideUserSyncAction, userSyncTouchesViewer } from './user-sync';

describe('decideUserSyncAction', () => {
  const evt = (scope: string, kind: string, payload: unknown): ServerFrame =>
    ({ type: 'event', scope, seq: 1, epoch: 'e', kind, payload }) as ServerFrame;

  it('reseats on a valid app-scope user_changed event, carrying the subject', () => {
    expect(decideUserSyncAction(evt('app', 'user_changed', { user_id: 'u1' }))).toEqual({
      kind: 'invalidate',
      userId: 'u1',
    });
  });

  it('ignores user_changed on a non-app scope', () => {
    expect(
      decideUserSyncAction(evt('workspace:w1', 'user_changed', { user_id: 'u1' })),
    ).toBeNull();
  });

  it('ignores a different event kind on app scope', () => {
    expect(decideUserSyncAction(evt('app', 'agent_changed', { agent_id: 'a1' }))).toBeNull();
  });

  it('ignores a malformed payload (user_id missing / wrong type)', () => {
    expect(decideUserSyncAction(evt('app', 'user_changed', {}))).toBeNull();
    expect(decideUserSyncAction(evt('app', 'user_changed', { user_id: 5 }))).toBeNull();
  });

  it('reseats with an unknown subject on app-scope snapshot_required', () => {
    const frame = {
      type: 'snapshot_required',
      scope: 'app',
      reason: 'epoch_mismatch',
    } as unknown as ServerFrame;
    expect(decideUserSyncAction(frame)).toEqual({ kind: 'invalidate', userId: null });
  });

  it('ignores snapshot_required for another scope', () => {
    const frame = {
      type: 'snapshot_required',
      scope: 'conversation:c1',
      reason: 'replay_gap',
    } as unknown as ServerFrame;
    expect(decideUserSyncAction(frame)).toBeNull();
  });
});

describe('userSyncTouchesViewer', () => {
  it('re-reads /api/me only when the subject is the viewer', () => {
    expect(userSyncTouchesViewer({ kind: 'invalidate', userId: 'u1' }, 'u1')).toBe(true);
    expect(userSyncTouchesViewer({ kind: 'invalidate', userId: 'u2' }, 'u1')).toBe(false);
  });

  it('re-reads on a replay recovery — the lost frame may have been the viewer\'s', () => {
    expect(userSyncTouchesViewer({ kind: 'invalidate', userId: null }, 'u1')).toBe(true);
    expect(userSyncTouchesViewer({ kind: 'invalidate', userId: null }, null)).toBe(true);
  });

  it('does not re-read for a named subject while the viewer id is unknown', () => {
    expect(userSyncTouchesViewer({ kind: 'invalidate', userId: 'u1' }, null)).toBe(false);
  });
});
