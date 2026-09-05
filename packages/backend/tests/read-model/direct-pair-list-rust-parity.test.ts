import { describe, expect, it } from 'vitest';
import fixture from '../../../shared/tests/fixtures/direct-pair-list.json' with { type: 'json' };
import { listDirectPairs } from '../../src/read-model/direct-pairs.js';
import { openTestDb } from '../utils/db.js';

describe('direct-pair cold-read Rust migration fixture', () => {
  it('is signed by the real TypeScript SQLite read authority', () => {
    const { db, localHostId } = openTestDb({ seedAllFixtureMemberships: false });
    try {
      db.exec(`
        INSERT INTO users (id, name, display_name, created_at, updated_at) VALUES
          ('user-1', 'viewer', 'Viewer', 1, 1),
          ('user-2', 'other', 'Other Human', 2, 2);
        INSERT INTO agents (
          id, name, display_name, runtime, host_id, created_by_user_id, created_at, updated_at
        ) VALUES (
          'agent-1', 'agent', 'Agent One', 'codex', '${localHostId}', 'user-1', 1, 11
        );
        INSERT INTO conversations (
          id, placement_kind, roster_policy, title, status,
          endpoint_a_kind, endpoint_a_id, endpoint_b_kind, endpoint_b_id,
          created_at, updated_at
        ) VALUES
          ('pair-agent', 'direct_pair', 'fixed', '', 'open',
           'agent', 'agent-1', 'human', 'user-1', 100, 100),
          ('pair-human', 'direct_pair', 'fixed', '', 'open',
           'human', 'user-1', 'human', 'user-2', 200, 200);
        INSERT INTO messages (
          id, conversation_id, from_kind, from_agent_id, content, seq, created_at
        ) VALUES ('message-1', 'pair-agent', 'agent', 'agent-1', 'hello', 1, 1);
      `);

      expect(
        listDirectPairs(db, { viewerUserId: fixture.authority_case.viewer_user_id }),
      ).toEqual(fixture.authority_case.response);
    } finally {
      db.close();
    }
  });
});
