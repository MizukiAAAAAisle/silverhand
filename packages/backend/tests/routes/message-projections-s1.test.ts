import { afterEach, describe, expect, it } from 'vitest';
import type { MessageEventPayload } from '@silverhand/shared';
import { buildTestApp, http, type TestApp } from '../utils/app.js';

// S1 projection-level recovery, P1 (#task:1276). Asserts the backend attaches an
// authoritative `thread_root_reply_count` projection to the `message` event for a
// thread reply, computed IN the send transaction (so it includes the just-inserted
// reply — never a future-seq value), and attaches nothing for a main-line send.
// Canonical: docs/projection-recovery-s1-v1.md §4/§5.

async function makeAgent(t: TestApp, name: string): Promise<string> {
  const created = (await (
    await http(t).post('/api/agents', { name, runtime: 'claude' })
  ).json()) as any;
  return created.agent.id;
}

async function createWorkspaceChannel(
  t: TestApp,
  names: string[],
): Promise<{ channelId: string; agentIds: Record<string, string> }> {
  const agentIds: Record<string, string> = {};
  for (const name of names) {
    agentIds[name] = await makeAgent(t, name);
  }
  const workspace = (await (
    await http(t).post('/api/workspaces', {
      name: `s1-proj-${names.join('-')}`,
      member_agent_ids: Object.values(agentIds),
    })
  ).json()) as any;
  t.fake.starts = [];
  t.fake.delivered = [];
  return { channelId: workspace.onboarding_channel_id, agentIds };
}

describe('S1 P1 — message event reply_count projection', () => {
  let t: TestApp | null = null;
  afterEach(() => {
    t?.cleanup();
    t = null;
  });

  it('attaches the in-tx authoritative reply_count for a thread reply, absent for main-line', async () => {
    t = buildTestApp();
    const { channelId } = await createWorkspaceChannel(t, ['alice']);

    const messageEvents: MessageEventPayload[] = [];
    const unsub = t.ctx.events.subscribe(channelId, e => {
      if (e.kind === 'message') messageEvents.push(e.payload as MessageEventPayload);
    });

    // Root message (main-line) — no projections.
    const rootPost = (await (
      await http(t).post(`/api/channels/${channelId}/messages`, {
        content: 'root topic',
      })
    ).json()) as any;
    const rootId: string = rootPost.message.id;

    // First reply → count becomes 1.
    const reply1 = (await (
      await http(t).post(`/api/channels/${channelId}/messages`, {
        content: 'first reply',
        reply_to_message_id: rootId,
      })
    ).json()) as any;

    // Second reply → count becomes 2 (authoritative, includes this insert).
    const reply2 = (await (
      await http(t).post(`/api/channels/${channelId}/messages`, {
        content: 'second reply',
        reply_to_message_id: rootId,
      })
    ).json()) as any;

    unsub();

    const eventFor = (id: string): MessageEventPayload => {
      const found = messageEvents.find(p => p.message.id === id);
      expect(found, `message event for ${id}`).toBeDefined();
      return found!;
    };

    // Main-line root: no projections sidecar.
    expect(eventFor(rootId).projections).toBeUndefined();

    // First reply: absolute reply_count = 1, keyed by the root.
    const p1 = eventFor(reply1.message.id).projections;
    expect(p1?.thread_root_reply_count).toEqual({
      root_id: rootId,
      reply_count: 1,
    });
    // P2: the threads-list entry rides the SAME frame, keyed by the root, with
    // the authoritative in-tx count + last-reply identity.
    expect(p1?.threads_list_entry?.entry).toMatchObject({
      root_message_id: rootId,
      reply_count: 1,
      last_reply_message_id: reply1.message.id,
    });
    // Viewer-invariant: the entry never carries the per-viewer follow bit.
    expect(
      'viewer_following' in (p1!.threads_list_entry!.entry as object),
    ).toBe(false);
    // root_seq (keyset tie-break) is exposed.
    expect(p1!.threads_list_entry!.entry.root_seq).toBeGreaterThan(0);

    // Second reply: absolute count = 2 (in-tx, includes the just-inserted reply),
    // and the entry's last_reply advances to this reply.
    const p2 = eventFor(reply2.message.id).projections;
    expect(p2?.thread_root_reply_count).toEqual({
      root_id: rootId,
      reply_count: 2,
    });
    expect(p2?.threads_list_entry?.entry).toMatchObject({
      root_message_id: rootId,
      reply_count: 2,
      last_reply_message_id: reply2.message.id,
    });
  });
});
