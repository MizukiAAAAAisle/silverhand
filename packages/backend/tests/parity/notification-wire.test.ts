import { afterEach, describe, expect, it, vi } from 'vitest';
import type { NotificationDto } from '@silverhand/shared';
import { AttentionBadgeRepo } from '../../src/repos/attention-badge-repo.js';
import { NotificationRepo } from '../../src/repos/notification-repo.js';
import { buildTestApp, http, type TestApp } from '../utils/app.js';
import fixture from '../fixtures/notification-wire.json' with { type: 'json' };

const notification: NotificationDto = {
  id: 'notification-1',
  kind: 'agent_start_failed',
  user_id: 'user-1',
  agent_id: null,
  workspace_id: null,
  conversation_id: null,
  message_id: null,
  thread_root_id: null,
  source_workspace_id: null,
  source_conversation_id: null,
  source_message_id: null,
  payload: { code: 'missing-runtime' },
  read_at: null,
  created_at: 100,
};

function fixtureCase(name: string): any {
  const found = fixture.find(entry => entry.name === name);
  if (!found) throw new Error(`missing notification fixture case ${name}`);
  return found;
}

function expectedBody(entry: any): unknown {
  return entry.body_case ? expectedBody(fixtureCase(entry.body_case)) : entry.body;
}

describe('notification wire is signed by the production TypeScript routes', () => {
  // The shared fixture is the ACCEPTED-plane parity oracle: list projection, the
  // parseInt/clamp/default accepted set, selector precedence (including an empty
  // high-priority id falling through) and unknown-field stripping — the drift-prone
  // behaviour the Rust migration must keep byte-for-byte. The refusal plane
  // deliberately DIVERGES between implementations (TS Zod returns
  // `400 {error,issues}`; the Rust route returns native structural 400/415/422 and a
  // minimal semantic `422 {error:"invalid input"}` with no issue array), so those
  // cases are pinned per-implementation, not through this shared oracle.
  let t: TestApp | null = null;
  afterEach(() => {
    t?.cleanup();
    t = null;
    vi.restoreAllMocks();
  });

  it('consumes the closed set of list, unread and clear wire cases', async () => {
    const seen = new Map<string, string[]>();
    for (const entry of fixture as any[]) {
      t = buildTestApp();
      const calls: string[] = [];
      vi.spyOn(NotificationRepo.prototype, 'list').mockImplementation(opts => {
        opts ??= {};
        calls.push(`list:${opts.unread === true}:${opts.limit}`);
        return [notification];
      });
      vi.spyOn(NotificationRepo.prototype, 'unreadCount').mockImplementation(() => {
        calls.push('summary');
        return 3;
      });
      vi.spyOn(NotificationRepo.prototype, 'unreadCountsByWorkspace').mockReturnValue(
        new Map([['workspace-1', 2]]),
      );
      vi.spyOn(NotificationRepo.prototype, 'latestUnreadByWorkspace').mockReturnValue(
        new Map([
          [
            'workspace-1',
            {
              conversation_id: 'conversation-1',
              message_id: 'message-1',
              thread_root_id: null,
            },
          ],
        ]),
      );
      vi.spyOn(NotificationRepo.prototype, 'markRead').mockImplementation(() => {
        calls.push('id');
        return true;
      });
      vi.spyOn(NotificationRepo.prototype, 'markWorkspaceRead').mockImplementation(() => {
        calls.push('workspace');
        return 2;
      });
      vi.spyOn(NotificationRepo.prototype, 'markConversationRead').mockImplementation(() => {
        calls.push('conversation');
        return 3;
      });
      vi.spyOn(NotificationRepo.prototype, 'markAllRead').mockImplementation(() => {
        calls.push('all');
        return 4;
      });
      vi.spyOn(AttentionBadgeRepo.prototype, 'badgeCountsByWorkspace').mockReturnValue({});

      const response = entry.method === 'GET'
        ? await http(t).get(entry.path)
        : entry.raw_request
          ? await http(t).post(entry.path, undefined, { body: entry.raw_request })
          : await http(t).post(entry.path, entry.request);
      expect(response.status, entry.name).toBe(entry.status);
      expect(await response.json(), entry.name).toEqual(expectedBody(entry));
      expect(calls, `${entry.name}: exact production owner`).toEqual(
        entry.call ? [entry.call] : [],
      );
      seen.set(entry.name, calls);
      t.cleanup();
      t = null;
      vi.restoreAllMocks();
    }

    expect([...new Set((fixture as any[]).map(entry => entry.surface))].sort()).toEqual([
      'clear',
      'list',
      'unread',
    ]);
    expect(seen.size).toBe(fixture.length);
  });
});
