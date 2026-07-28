// Viewer-identity cache CONTRACT test (#task:1701).
//
// A human's `display_name` / `avatar_url` are denormalized by the backend into
// the global directory (`['users']`) and into EVERY conversation roster
// (`['conversation-members', id]`, re-derived from the users table on each
// read). So a profile write that only seats `['me']` leaves those copies
// serving the old identity — the dogfood repro was removing an avatar in the
// profile and still seeing it in the channel members modal, because the roster
// DTO still carried the old `${path}?v=${updated_at}` url and the session
// avatar-blob cache still had bytes for that key.
//
// Falsifier: drop either `invalidateQueries` from `cacheViewer` and this goes
// red.
import { describe, expect, it } from 'vitest';
import { QueryClient } from '@tanstack/react-query';
import type { UserDto } from '@silverhand/shared';
import { cacheViewer } from './hooks';
import { usersKey } from '../users/hooks';
import { CONVERSATION_MEMBERS_KEY_PREFIX } from '../conversations/useConversationMembers';

const viewer: UserDto = {
  id: 'u1',
  name: 'shiki',
  display_name: 'shiki',
  avatar_url: null, // just cleared
  created_at: 1,
  updated_at: 2,
};

describe('cacheViewer', () => {
  it('reseats every cache that denormalizes the viewer identity', () => {
    const qc = new QueryClient();
    qc.setQueryData(['me'], { ...viewer, avatar_url: '/api/users/u1/avatar?v=1' });
    qc.setQueryData(usersKey, {
      users: [{ ...viewer, avatar_url: '/api/users/u1/avatar?v=1' }],
    });
    for (const id of ['c1', 'c2']) {
      qc.setQueryData(['conversation-members', id], {
        members: [
          {
            kind: 'human',
            user_id: 'u1',
            name: 'shiki',
            display_name: 'shiki',
            avatar_url: '/api/users/u1/avatar?v=1',
          },
        ],
        member_removability: [],
      });
    }

    cacheViewer(qc, viewer);

    expect(qc.getQueryData(['me'])).toEqual(viewer);
    expect(qc.getQueryState(usersKey)?.isInvalidated).toBe(true);
    // Every roster, not just the visible channel's — an unmounted one would
    // otherwise come back stale on next mount.
    for (const id of ['c1', 'c2']) {
      expect(
        qc.getQueryState([...CONVERSATION_MEMBERS_KEY_PREFIX, id])?.isInvalidated,
      ).toBe(true);
    }
  });
});
