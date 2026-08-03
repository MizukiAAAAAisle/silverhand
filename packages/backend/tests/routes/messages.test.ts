import { afterEach, describe, expect, it } from 'vitest';
import {
  encodeUserPrincipalHeader,
  X_SILVERHAND_PRINCIPAL_HEADER,
} from '@silverhand/shared';
import { MessageRepo } from '../../src/repos/message-repo.js';
import { buildTestApp, http, type TestApp } from '../utils/app.js';

async function makeAgent(t: TestApp, name: string): Promise<string> {
  const created = await (
    await http(t).post('/api/agents', { name, runtime: 'claude' })
  ).json() as any;
  return created.agent.id;
}

async function createWorkspaceChannel(
  t: TestApp,
  names: string[],
): Promise<{ workspaceId: string; channelId: string; agentIds: Record<string, string> }> {
  const agentIds: Record<string, string> = {};
  for (const name of names) {
    agentIds[name] = await makeAgent(t, name);
  }
  const workspace = await (
    await http(t).post('/api/workspaces', {
      name: `ws-${names.join('-')}`,
      member_agent_ids: Object.values(agentIds),
    })
  ).json() as any;
  t.fake.starts = [];
  t.fake.delivered = [];
  t.fake.resolvedRuns = [];
  return {
    workspaceId: workspace.workspace.id,
    channelId: workspace.onboarding_channel_id,
    agentIds,
  };
}

describe('message routes', () => {
  let t: TestApp | null = null;
  afterEach(() => {
    t?.cleanup();
    t = null;
  });

  it('routes user requests through the session bearer subject', async () => {
    t = buildTestApp();
    const { channelId } = await createWorkspaceChannel(t, ['alice']);
    const post = await http(t).post(
      `/api/channels/${channelId}/messages`,
      { content: 'from teammate' },
      {
        headers: {
          [X_SILVERHAND_PRINCIPAL_HEADER]: encodeUserPrincipalHeader('teammate'),
        },
      },
    );
    expect(post.status).toBe(201);
    const body = await post.json() as any;
    expect(body.message.from_user_id).toBe('teammate');
  });
});

describe('GET /api/channels/:id/messages — reply_summaries_by_root (P1)', () => {
  let t: TestApp | null = null;
  afterEach(() => {
    t?.cleanup();
    t = null;
  });

  it('returns the enriched reply-badge sidecar keyed like reply_counts_by_root', async () => {
    t = buildTestApp();
    const { channelId, agentIds } = await createWorkspaceChannel(t, ['alice']);
    const messages = new MessageRepo(t.ctx.db);

    const root = messages.insertForConversation({
      conversationId: channelId,
      fromKind: 'user',
      fromUserId: 'local',
      content: 'has a thread',
    });
    messages.insertForConversation({
      conversationId: channelId,
      fromKind: 'agent',
      fromAgentId: agentIds.alice!,
      content: 'a reply',
      threadRootId: root.id,
    });
    // A main-line message with no replies — appears in counts (0) but not in
    // the summaries sidecar.
    messages.insertForConversation({
      conversationId: channelId,
      fromKind: 'user',
      fromUserId: 'local',
      content: 'no thread',
    });

    const body = (await (
      await http(t).get(`/api/channels/${channelId}/messages`)
    ).json()) as any;

    const summaries = body.reply_summaries_by_root;
    expect(summaries).toBeDefined();
    expect(summaries[root.id]).toBeDefined();
    // Mirrors the count sidecar exactly.
    expect(summaries[root.id].reply_count).toBe(body.reply_counts_by_root[root.id]);
    expect(summaries[root.id].reply_count).toBe(1);
    expect(summaries[root.id].repliers).toEqual([
      {
        kind: 'agent',
        status: 'active',
        id: agentIds.alice,
        name: 'alice',
        display_name: 'alice',
        avatar_url: null,
        // active-agent arm carries the CURRENT runtime (#task:1791, option (b)).
        runtime: 'claude',
      },
    ]);
    expect(summaries[root.id].replier_total).toBe(1);
    expect(typeof summaries[root.id].last_reply_at).toBe('number');
    // Per-viewer unread no longer rides on the reply-summary sidecar — it is
    // server-scored and served by the dedicated conversation-unread read-model
    // (`GET /api/conversations/:id/unread`), so the chip and the Threads list
    // read the same fact and the sidecar carries only optimistic reply metadata.
    expect(summaries[root.id]).not.toHaveProperty('unread_count');
    // Open-time snapshot of the opened (mainline) stream, captured in the same
    // read as the window — drives the `observe()` at_seq clear without
    // swallowing a tail.
    expect(typeof body.stream_head_seq).toBe('number');
    expect(body.stream_head_seq).toBeGreaterThan(0);
    // Every summary key is a count key (never widens the root set).
    for (const k of Object.keys(summaries)) {
      expect(body.reply_counts_by_root).toHaveProperty(k);
    }
  });
});

describe('GET /api/channels/:id/messages — reply_previews_by_root (#task:1746)', () => {
  let t: TestApp | null = null;
  afterEach(() => {
    t?.cleanup();
    t = null;
  });

  it('serves the tail-3 inline reply-preview sidecar keyed like reply_counts_by_root', async () => {
    t = buildTestApp();
    const { channelId, agentIds } = await createWorkspaceChannel(t, ['alice']);
    const messages = new MessageRepo(t.ctx.db);

    const root = messages.insertForConversation({
      conversationId: channelId,
      fromKind: 'user',
      fromUserId: 'local',
      content: 'has a thread',
    });
    const r1 = messages.insertForConversation({
      conversationId: channelId,
      fromKind: 'agent',
      fromAgentId: agentIds.alice!,
      content: 'first reply',
      threadRootId: root.id,
    });
    const r2 = messages.insertForConversation({
      conversationId: channelId,
      fromKind: 'user',
      fromUserId: 'local',
      content: 'second reply',
      threadRootId: root.id,
    });
    // A main-line message with no replies — appears in counts (0) but not in
    // the previews sidecar.
    messages.insertForConversation({
      conversationId: channelId,
      fromKind: 'user',
      fromUserId: 'local',
      content: 'no thread',
    });

    const body = (await (
      await http(t).get(`/api/channels/${channelId}/messages`)
    ).json()) as any;

    const previews = body.reply_previews_by_root;
    expect(previews).toBeDefined();
    expect(previews[root.id]).toBeDefined();
    // Time-ASCending tail (both replies, oldest first).
    expect(previews[root.id].map((p: any) => p.message_id)).toEqual([r1.id, r2.id]);
    expect(previews[root.id][0]).toMatchObject({
      author: {
        kind: 'agent',
        status: 'active',
        id: agentIds.alice,
        name: 'alice',
        display_name: 'alice',
        avatar_url: null,
        runtime: 'claude',
      },
      preview: 'first reply',
      attachment_count: 0,
      first_attachment_label: null,
    });
    // Read-inert projection — no per-viewer read/unread state leaks onto a row.
    expect(previews[root.id][0]).not.toHaveProperty('unread_count');
    expect(previews[root.id][0]).not.toHaveProperty('viewer_following');
    // Every preview key is a count key (never widens the root set).
    for (const k of Object.keys(previews)) {
      expect(body.reply_counts_by_root).toHaveProperty(k);
    }
  });
});

describe('POST /api/channels/:id/messages — content byte cap', () => {
  let t: TestApp | null = null;
  afterEach(() => {
    t?.cleanup();
    t = null;
  });

  it('rejects content over 64KiB (UTF-8 bytes) with 413 content_too_large', async () => {
    t = buildTestApp();
    const { channelId } = await createWorkspaceChannel(t, ['alice']);
    const r = await http(t).post(
      `/api/channels/${channelId}/messages`,
      { content: 'a'.repeat(64 * 1024 + 1) },
    );
    expect(r.status).toBe(413);
    const body = await r.json() as any;
    expect(body.code).toBe('content_too_large');
    expect(body.max_bytes).toBe(64 * 1024);
    expect(body.actual_bytes).toBe(64 * 1024 + 1);
  });

  it('measures the cap in UTF-8 bytes, not UTF-16 code units', async () => {
    t = buildTestApp();
    const { channelId } = await createWorkspaceChannel(t, ['alice']);
    // 30k CJK chars = 30k UTF-16 code units but ~90KB UTF-8 bytes.
    const r = await http(t).post(
      `/api/channels/${channelId}/messages`,
      { content: '汉'.repeat(30_000) },
    );
    expect(r.status).toBe(413);
    const body = await r.json() as any;
    expect(body.code).toBe('content_too_large');
    expect(body.actual_bytes).toBe(90_000);
  });

  it('accepts content exactly at the 64KiB boundary', async () => {
    t = buildTestApp();
    const { channelId } = await createWorkspaceChannel(t, ['alice']);
    const r = await http(t).post(
      `/api/channels/${channelId}/messages`,
      { content: 'a'.repeat(64 * 1024) },
    );
    expect(r.status).toBe(201);
  });
});

describe('POST /api/channels/:id/messages — pre-parse body bound', () => {
  let t: TestApp | null = null;
  afterEach(() => {
    t?.cleanup();
    t = null;
  });

  it('rejects an oversized body with a declared Content-Length before the handler', async () => {
    t = buildTestApp();
    const { channelId } = await createWorkspaceChannel(t, ['alice']);
    const body = JSON.stringify({ content: 'a'.repeat(2 * 1024 * 1024) });
    const r = await http(t).post(
      `/api/channels/${channelId}/messages`,
      undefined,
      {
        body,
        headers: {
          'content-type': 'application/json',
          'content-length': String(Buffer.byteLength(body)),
        },
      },
    );
    expect(r.status).toBe(413);
    const parsed = await r.json() as any;
    expect(parsed.code).toBe('content_too_large');
    expect(parsed.max_body_bytes).toBeDefined();
  });

  it('rejects an oversized chunked body without Content-Length before the handler', async () => {
    t = buildTestApp();
    const { channelId } = await createWorkspaceChannel(t, ['alice']);
    const payload = Buffer.from(
      JSON.stringify({ content: 'a'.repeat(2 * 1024 * 1024) }),
      'utf8',
    );
    // Stream the body in chunks with no Content-Length header — the
    // limiter must count bytes as they arrive and cut off mid-stream.
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let i = 0; i < payload.byteLength; i += 64 * 1024) {
          controller.enqueue(payload.subarray(i, i + 64 * 1024));
        }
        controller.close();
      },
    });
    const r = await http(t).post(
      `/api/channels/${channelId}/messages`,
      undefined,
      {
        body: stream,
        // duplex is required for stream request bodies in Node's fetch.
        duplex: 'half',
        headers: { 'content-type': 'application/json' },
      } as RequestInit,
    );
    expect(r.status).toBe(413);
    const parsed = await r.json() as any;
    expect(parsed.code).toBe('content_too_large');
  });
});
