import { afterEach, describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  ATTACHMENT_CHANGED_EVENT,
  conversationScope,
  conversationSideScope,
  encodeUserPrincipalHeader,
  fixedConversationTitle,
  X_SILVERHAND_LEGACY_USER_ID_HEADER,
  X_SILVERHAND_PRINCIPAL_HEADER,
} from '@silverhand/shared';
import { formatAttachmentSuffix } from '../../src/runtime/stdin-format.js';
import { AttachmentRepo } from '../../src/repos/attachment-repo.js';
import { ConversationRepo } from '../../src/repos/conversation-repo.js';
import { MessageRepo } from '../../src/repos/message-repo.js';
import {
  buildTestApp,
  http,
  issueTestConversationRuntimeToken,
  type TestApp,
} from '../utils/app.js';
import { CURRENT_DESKTOP_EPOCH_HEADERS } from '../utils/desktop-client-epoch.js';

async function createWorkspaceChannel(t: TestApp, members: string[] = ['alice']) {
  const agentIds: Record<string, string> = {};
  for (const name of members) {
    const body = await (
      await http(t).post('/api/agents', { name, runtime: 'claude' })
    ).json() as any;
    agentIds[name] = body.agent.id;
  }
  const workspaceBody = await (
    await http(t).post('/api/workspaces', {
      name: `ws-${crypto.randomUUID().slice(0, 8)}`,
      member_agent_ids: Object.values(agentIds),
    })
  ).json() as any;
  t.fake.starts = [];
  t.fake.delivered = [];
  t.fake.stops = [];
  return {
    workspaceId: workspaceBody.workspace.id as string,
    channelId: workspaceBody.onboarding_channel_id as string,
    agentIds,
  };
}

function authHeaders(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

function internalAuthHeaders(
  t: TestApp,
  conversationId: string,
  agentId: string,
): Record<string, string> {
  return authHeaders(issueTestConversationRuntimeToken(t, conversationId, agentId));
}

/** Direct multipart upload — bypasses the JSON-shaped `http().post`
 *  helper because FormData needs to set its own Content-Type with
 *  boundary.
 *
 *  `target` is the AGENT door's destination address, which travels as a form
 *  field beside the bytes (#task:2021 P4-4). The human channel route carries its
 *  conversation in the path and passes none. */
async function uploadFile(
  t: TestApp,
  path: string,
  filename: string,
  contentType: string,
  bytes: Buffer,
  extraHeaders?: Record<string, string>,
  target?: string,
): Promise<Response> {
  const form = new FormData();
  if (target !== undefined) form.append('target', target);
  form.append('file', new Blob([bytes], { type: contentType }), filename);
  const headers: Record<string, string> = {
    ...CURRENT_DESKTOP_EPOCH_HEADERS,
    ...(extraHeaders ?? {
      'X-Silverhand-User-Id': 'local',
      authorization: `Bearer ${t.authToken}`,
    }),
  };
  return t.app.fetch(
    new Request(`http://localhost${path}`, {
      method: 'POST',
      headers,
      body: form,
    }),
  );
}

const PNG_BYTES = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47]),
  Buffer.alloc(8, 0),
]);

/** Direct multipart PATCH — mirrors `uploadFile` but for the in-place
 *  content-update route (`PATCH .../attachments/:id`). */
async function patchFile(
  t: TestApp,
  path: string,
  filename: string,
  contentType: string,
  bytes: Buffer,
  extraHeaders?: Record<string, string>,
): Promise<Response> {
  const form = new FormData();
  form.append('file', new Blob([bytes], { type: contentType }), filename);
  const headers: Record<string, string> = {
    ...CURRENT_DESKTOP_EPOCH_HEADERS,
    ...(extraHeaders ?? {
      'X-Silverhand-User-Id': 'local',
      authorization: `Bearer ${t.authToken}`,
    }),
  };
  return t.app.fetch(
    new Request(`http://localhost${path}`, {
      method: 'PATCH',
      headers,
      body: form,
    }),
  );
}

describe('Attachment routes', () => {
  let t: TestApp | null = null;
  afterEach(() => {
    t?.cleanup();
    t = null;
  });

  it('uploads through the channel route and the row resolves to the channel', async () => {
    t = buildTestApp();
    const viewer = http(t, { 'X-Silverhand-User-Id': 'local' });
    const { channelId } = await createWorkspaceChannel(t);
    const res = await uploadFile(
      t,
      `/api/channels/${channelId}/attachments`,
      'shot.png',
      'image/png',
      PNG_BYTES,
    );
    expect(res.status).toBe(201);
    const dto = await res.json() as any;
    expect(dto.channel_id).toBe(channelId);
    expect(dto.content_type).toBe('image/png');
    expect(dto.created_by_kind).toBe('user');

    // Download via GET /api/attachments/:id returns the bytes.
    const get = await viewer.get(`/api/attachments/${dto.id}`);
    expect(get.status).toBe(200);
    expect(get.headers.get('content-type')).toBe('image/png');
    const bytes = Buffer.from(await get.arrayBuffer());
    expect(bytes[0]).toBe(0x89);
  });

  it('rejects attachment download without or with the wrong bearer token', async () => {
    t = buildTestApp();
    const { channelId } = await createWorkspaceChannel(t);
    const dto = await (
      await uploadFile(
        t,
        `/api/channels/${channelId}/attachments`,
        'shot.png',
        'image/png',
        PNG_BYTES,
      )
    ).json() as any;

    const noBearer = await t.app.fetch(
      new Request(`http://localhost/api/attachments/${dto.id}`, {
        headers: {
          ...CURRENT_DESKTOP_EPOCH_HEADERS,
          'X-Silverhand-User-Id': 'local',
        },
      }),
    );
    expect(noBearer.status).toBe(401);

    const wrongBearer = await t.app.fetch(
      new Request(`http://localhost/api/attachments/${dto.id}`, {
        headers: {
          ...CURRENT_DESKTOP_EPOCH_HEADERS,
          'X-Silverhand-User-Id': 'local',
          authorization: 'Bearer wrong',
        },
      }),
    );
    expect(wrongBearer.status).toBe(401);
  });

  it('returns the same 404 body for missing and ACL-denied downloads', async () => {
    t = buildTestApp();
    const viewer = http(t, { 'X-Silverhand-User-Id': 'local' });
    const { channelId } = await createWorkspaceChannel(t);
    const dto = await (
      await uploadFile(
        t,
        `/api/channels/${channelId}/attachments`,
        'shot.png',
        'image/png',
        PNG_BYTES,
      )
    ).json() as any;

    const missing = await viewer.get('/api/attachments/does-not-exist');
    expect(missing.status).toBe(404);
    const missingBody = await missing.json() as any;

    // Simulate an ACL denial without adding a second human user yet: keep the
    // row and blob, but make the channel boundary unreadable.
    t.ctx.db.pragma('foreign_keys = OFF');
    try {
      t.ctx.db
        .prepare('UPDATE attachments SET channel_id = ? WHERE id = ?')
        .run('missing-channel', dto.id);
    } finally {
      t.ctx.db.pragma('foreign_keys = ON');
    }

    const denied = await viewer.get(`/api/attachments/${dto.id}`);
    expect(denied.status).toBe(404);
    expect(await denied.json()).toEqual(missingBody);
  });

  it('rejects multipart payloads without a `file` field', async () => {
    t = buildTestApp();
    const { channelId } = await createWorkspaceChannel(t);
    const form = new FormData();
    form.append('not_file', new Blob([Buffer.from('x')]), 'x.png');
    const res = await t.app.fetch(
      new Request(`http://localhost/api/channels/${channelId}/attachments`, {
        method: 'POST',
        headers: {
          ...CURRENT_DESKTOP_EPOCH_HEADERS,
          'X-Silverhand-User-Id': 'local',
          authorization: `Bearer ${t.authToken}`,
        },
        body: form,
      }),
    );
    expect(res.status).toBe(400);
  });

  it('embeds the snapshot when a user message references the attachment id', async () => {
    t = buildTestApp();
    const viewer = http(t, { 'X-Silverhand-User-Id': 'local' });
    const { channelId } = await createWorkspaceChannel(t);
    const dto = await (
      await uploadFile(
        t,
        `/api/channels/${channelId}/attachments`,
        'shot.png',
        'image/png',
        PNG_BYTES,
      )
    ).json() as any;

    const msg = await viewer.post(`/api/channels/${channelId}/messages`, {
      content: 'with file',
      attachment_ids: [dto.id],
    });
    expect(msg.status).toBe(201);
    const body = await msg.json() as any;
    expect(body.message.attachments).toHaveLength(1);
    expect(body.message.attachments[0]).toMatchObject({
      id: dto.id,
      filename: 'shot.png',
      content_type: 'image/png',
    });
  });

  it('accepts an attachment-only user message', async () => {
    t = buildTestApp();
    const viewer = http(t, { 'X-Silverhand-User-Id': 'local' });
    const { channelId } = await createWorkspaceChannel(t);
    const dto = await (
      await uploadFile(
        t,
        `/api/channels/${channelId}/attachments`,
        'shot.png',
        'image/png',
        PNG_BYTES,
      )
    ).json() as any;

    const msg = await viewer.post(`/api/channels/${channelId}/messages`, {
      content: '',
      attachment_ids: [dto.id],
    });
    expect(msg.status).toBe(201);
    const body = await msg.json() as any;
    expect(body.message.content).toBe('');
    expect(body.message.attachments).toHaveLength(1);
    expect(body.message.attachments[0]).toMatchObject({
      id: dto.id,
      filename: 'shot.png',
      content_type: 'image/png',
    });
  });

  it('rejects send-message with an attachment that belongs to a different channel', async () => {
    t = buildTestApp();
    const viewer = http(t, { 'X-Silverhand-User-Id': 'local' });
    const a = await createWorkspaceChannel(t, ['alice']);
    const b = await createWorkspaceChannel(t, ['bob']);
    const aDto = await (
      await uploadFile(
        t,
        `/api/channels/${a.channelId}/attachments`,
        'shot.png',
        'image/png',
        PNG_BYTES,
      )
    ).json() as any;

    const msg = await viewer.post(`/api/channels/${b.channelId}/messages`, {
      content: 'cross',
      attachment_ids: [aDto.id],
    });
    expect(msg.status).toBe(400);
    const body = await msg.json() as any;
    expect(body.attachment_id).toBe(aDto.id);
  });
});

describe('Channel attachment list (GET /api/channels/:id/attachments)', () => {
  let t: TestApp | null = null;
  afterEach(() => {
    t?.cleanup();
    t = null;
  });

  async function uploadAndReference(
    tt: TestApp,
    channelId: string,
    filename: string,
    contentType: string,
  ) {
    const dto = await (
      await uploadFile(
        tt,
        `/api/channels/${channelId}/attachments`,
        filename,
        contentType,
        PNG_BYTES,
      )
    ).json() as any;
    const viewer = http(tt, { 'X-Silverhand-User-Id': 'local' });
    const msg = await viewer.post(`/api/channels/${channelId}/messages`, {
      content: filename,
      attachment_ids: [dto.id],
    });
    expect(msg.status).toBe(201);
    return { attachment: dto, message: (await msg.json() as any).message };
  }

  it('returns referenced attachments with the AttachmentListPage shape', async () => {
    t = buildTestApp();
    const viewer = http(t, { 'X-Silverhand-User-Id': 'local' });
    const { channelId } = await createWorkspaceChannel(t);
    const { attachment, message } = await uploadAndReference(
      t,
      channelId,
      'first.png',
      'image/png',
    );

    const res = await viewer.get(`/api/channels/${channelId}/attachments`);
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(Array.isArray(body.items)).toBe(true);
    expect(body.items).toHaveLength(1);
    expect(body.next_cursor).toBeNull();
    const item = body.items[0];
    expect(item.attachment.id).toBe(attachment.id);
    expect(item.attachment.channel_id).toBe(channelId);
    expect(item.source.message_id).toBe(message.id);
    expect(item.source.conversation_id).toBe(channelId);
    expect(item.source.thread_root_id).toBeNull();
    expect(item.source.from_kind).toBe('user');
    expect(item.source.from_user_id).toBe('local');
    expect(typeof item.source.appeared_at).toBe('number');
    expect(typeof item.source.message_seq).toBe('number');
  });

  it('excludes uploaded-but-unsent orphan attachments', async () => {
    t = buildTestApp();
    const viewer = http(t, { 'X-Silverhand-User-Id': 'local' });
    const { channelId } = await createWorkspaceChannel(t);
    // Upload without ever referencing in a message.
    await uploadFile(
      t,
      `/api/channels/${channelId}/attachments`,
      'orphan.png',
      'image/png',
      PNG_BYTES,
    );

    const res = await viewer.get(`/api/channels/${channelId}/attachments`);
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.items).toEqual([]);
    expect(body.next_cursor).toBeNull();
  });

  it('returns 404 for an unknown channel id', async () => {
    t = buildTestApp();
    const viewer = http(t, { 'X-Silverhand-User-Id': 'local' });
    await createWorkspaceChannel(t);

    const res = await viewer.get('/api/channels/no-such-channel/attachments');
    expect(res.status).toBe(404);
  });

  it('rejects a tampered cursor with 400 / invalid_cursor', async () => {
    t = buildTestApp();
    const viewer = http(t, { 'X-Silverhand-User-Id': 'local' });
    const { channelId } = await createWorkspaceChannel(t);

    const res = await viewer.get(
      `/api/channels/${channelId}/attachments?cursor=not-a-real-cursor!!!`,
    );
    expect(res.status).toBe(400);
    const body = await res.json() as any;
    expect(body.code).toBe('invalid_cursor');
  });

  it('paginates via next_cursor across the full result set', async () => {
    t = buildTestApp();
    const viewer = http(t, { 'X-Silverhand-User-Id': 'local' });
    const { channelId } = await createWorkspaceChannel(t);
    // Three referenced attachments so a limit=2 page splits cleanly.
    const first = await uploadAndReference(t, channelId, 'a1.png', 'image/png');
    const second = await uploadAndReference(t, channelId, 'a2.png', 'image/png');
    const third = await uploadAndReference(t, channelId, 'a3.png', 'image/png');

    const page1 = await viewer.get(`/api/channels/${channelId}/attachments?limit=2`);
    expect(page1.status).toBe(200);
    const body1 = await page1.json() as any;
    expect(body1.items).toHaveLength(2);
    expect(body1.next_cursor).toBeTypeOf('string');
    // DESC order — the most recent reference comes first.
    expect(body1.items[0].attachment.id).toBe(third.attachment.id);
    expect(body1.items[1].attachment.id).toBe(second.attachment.id);

    const page2 = await viewer.get(
      `/api/channels/${channelId}/attachments?limit=2&cursor=${encodeURIComponent(body1.next_cursor)}`,
    );
    expect(page2.status).toBe(200);
    const body2 = await page2.json() as any;
    expect(body2.items).toHaveLength(1);
    expect(body2.items[0].attachment.id).toBe(first.attachment.id);
    expect(body2.next_cursor).toBeNull();
  });

  it('lists via the underlying repo API to prove the DTO shape end-to-end', async () => {
    // A defense-in-depth check that the route and repo agree on the wire shape:
    // insert directly via the repo, then read via the route.
    t = buildTestApp();
    const viewer = http(t, { 'X-Silverhand-User-Id': 'local' });
    const { channelId } = await createWorkspaceChannel(t);
    await uploadAndReference(t, channelId, 'shape.png', 'image/png');

    const res = await viewer.get(`/api/channels/${channelId}/attachments`);
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    // Rehydrate the same page via the repo — same set, same order.
    const repo = new AttachmentRepo(t.ctx.db);
    const direct = repo.listChannelReferences(channelId, { limit: 100 });
    expect(direct.items.map(i => i.attachment.id)).toEqual(
      body.items.map((i: any) => i.attachment.id),
    );
  });

  it('returns 403 for a workspace member who is not a conversation member', async () => {
    // Route boundary: `canViewConversation` requires the caller be an explicit
    // `conversation_users` member of THIS channel — workspace membership alone
    // is not enough. Test-fixture users are auto-seeded as workspace owners on
    // registration (user-service backfill), so we KEEP teammate's
    // `workspace_users` row (proves the workspace gate would let them
    // through) and only strip the channel-level `conversation_users` row.
    // If the route ever regressed to `canViewWorkspace`-only, this test
    // would flip to 200 and catch the drift.
    t = buildTestApp();
    const { workspaceId, channelId } = await createWorkspaceChannel(t);
    await uploadAndReference(t, channelId, 'private.png', 'image/png');
    t.ctx.db
      .prepare('DELETE FROM conversation_users WHERE conversation_id = ? AND user_id = ?')
      .run(channelId, 'teammate');
    // Sanity: teammate is still a workspace member — the failure below
    // must come from the conversation-membership gate, not workspace denial.
    const wsRow = t.ctx.db
      .prepare('SELECT 1 AS hit FROM workspace_users WHERE workspace_id = ? AND user_id = ?')
      .get(workspaceId, 'teammate');
    expect(wsRow).not.toBeUndefined();

    const teammate = http(t, {
      [X_SILVERHAND_PRINCIPAL_HEADER]: encodeUserPrincipalHeader('teammate'),
    });
    const res = await teammate.get(`/api/channels/${channelId}/attachments`);
    expect(res.status).toBe(403);
  });

  it('resolves and lists via getChannelLike when the target is a dm_channel', async () => {
    // `getChannelLike` covers both `channel` and `dm_channel` — a bare
    // `getChannel` would 404 the DM branch. Falsifier: swap the route
    // resolver to `getChannel` and this test fails on the GET.
    t = buildTestApp();
    const viewer = http(t, { 'X-Silverhand-User-Id': 'local' });
    const { workspaceId } = await createWorkspaceChannel(t);
    const conversations = new ConversationRepo(t.ctx.db);
    const dm = conversations.insertDmChannel({
      workspaceId,
      title: fixedConversationTitle('dm'),
    });
    // Seed the 'local' user as a dm_channel member so canViewConversation
    // resolves to true — otherwise this test would land on the 403 branch
    // and prove nothing about kind resolution.
    conversations.addUser(dm.id, 'local');
    await uploadAndReference(t, dm.id, 'dm-only.png', 'image/png');

    const res = await viewer.get(`/api/channels/${dm.id}/attachments`);
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.items).toHaveLength(1);
    expect(body.items[0].source.conversation_id).toBe(dm.id);
  });

  it('lists an archived channel as long as the caller can still view it', async () => {
    // Archive is an admin/governance state — it hides the channel from the
    // active-channel index, but existing members can still read its
    // messages, attachments, and by extension this panel. Falsifier: an
    // over-broad guard that filters `archived_at IS NULL` in the route
    // would return an empty list or 404 here.
    t = buildTestApp();
    const viewer = http(t, { 'X-Silverhand-User-Id': 'local' });
    const { channelId } = await createWorkspaceChannel(t);
    const { attachment } = await uploadAndReference(
      t,
      channelId,
      'kept.png',
      'image/png',
    );
    const conversations = new ConversationRepo(t.ctx.db);
    const archived = conversations.setArchived(channelId, true);
    expect(archived?.archived_at).not.toBeNull();

    const res = await viewer.get(`/api/channels/${channelId}/attachments`);
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.items.map((i: any) => i.attachment.id)).toEqual([attachment.id]);
  });
});

describe('Channel attachment list — sender/time filters', () => {
  let t: TestApp | null = null;
  afterEach(() => {
    t?.cleanup();
    t = null;
  });

  async function uploadAndReference(
    tt: TestApp,
    channelId: string,
    filename: string,
  ) {
    const dto = await (
      await uploadFile(
        tt,
        `/api/channels/${channelId}/attachments`,
        filename,
        'image/png',
        PNG_BYTES,
      )
    ).json() as any;
    const viewer = http(tt, { 'X-Silverhand-User-Id': 'local' });
    const msg = await viewer.post(`/api/channels/${channelId}/messages`, {
      content: filename,
      attachment_ids: [dto.id],
    });
    expect(msg.status).toBe(201);
    return dto;
  }

  // ── 400 validation matrix: a malformed filter is rejected, never
  //    silently served as the unfiltered list under a filtered UI. ──
  const badFilters: Array<[string, string]> = [
    ['unknown sender_kind', 'sender_kind=ghost'],
    ['sender_id without sender_kind', 'sender_id=local'],
    ['system sender_kind carrying sender_id', 'sender_kind=system&sender_id=x'],
    ['user sender_kind missing sender_id', 'sender_kind=user'],
    ['agent sender_kind missing sender_id', 'sender_kind=agent'],
    ['user sender_kind with empty sender_id', 'sender_kind=user&sender_id='],
    ['user sender_kind with whitespace-only sender_id', 'sender_kind=user&sender_id=%20%20'],
    ['non-integer since', 'since=abc'],
    ['negative since', 'since=-1'],
    ['decimal until', 'until=1.5'],
    ['since equal to until', 'since=1000&until=1000'],
    ['since greater than until', 'since=2000&until=1000'],
  ];
  for (const [label, query] of badFilters) {
    it(`rejects ${label} with 400 / invalid_filter`, async () => {
      t = buildTestApp();
      const viewer = http(t, { 'X-Silverhand-User-Id': 'local' });
      const { channelId } = await createWorkspaceChannel(t);
      const res = await viewer.get(
        `/api/channels/${channelId}/attachments?${query}`,
      );
      expect(res.status).toBe(400);
      const body = await res.json() as any;
      expect(body.code).toBe('invalid_filter');
    });
  }

  it('accepts a well-formed system sender filter (no sender_id) as 200', async () => {
    t = buildTestApp();
    const viewer = http(t, { 'X-Silverhand-User-Id': 'local' });
    const { channelId } = await createWorkspaceChannel(t);
    const res = await viewer.get(
      `/api/channels/${channelId}/attachments?sender_kind=system`,
    );
    expect(res.status).toBe(200);
  });

  it('filters by sender identity — matching id returns, other id is empty', async () => {
    t = buildTestApp();
    const viewer = http(t, { 'X-Silverhand-User-Id': 'local' });
    const { channelId } = await createWorkspaceChannel(t);
    const a = await uploadAndReference(t, channelId, 'a.png');
    const b = await uploadAndReference(t, channelId, 'b.png');

    const mine = await viewer.get(
      `/api/channels/${channelId}/attachments?sender_kind=user&sender_id=local`,
    );
    expect(mine.status).toBe(200);
    const mineBody = await mine.json() as any;
    expect(mineBody.items.map((i: any) => i.attachment.id).sort()).toEqual(
      [a.id, b.id].sort(),
    );

    const other = await viewer.get(
      `/api/channels/${channelId}/attachments?sender_kind=user&sender_id=nobody`,
    );
    expect(other.status).toBe(200);
    const otherBody = await other.json() as any;
    expect(otherBody.items).toEqual([]);
  });

  it('passes the time window through to the repo (since far-future → empty)', async () => {
    t = buildTestApp();
    const viewer = http(t, { 'X-Silverhand-User-Id': 'local' });
    const { channelId } = await createWorkspaceChannel(t);
    await uploadAndReference(t, channelId, 'now.png');

    // since=0 is inclusive of every real timestamp → the attachment is present.
    const all = await viewer.get(
      `/api/channels/${channelId}/attachments?since=0`,
    );
    expect(((await all.json()) as any).items).toHaveLength(1);

    // A far-future lower bound excludes every reference.
    const none = await viewer.get(
      `/api/channels/${channelId}/attachments?since=99999999999999`,
    );
    expect(((await none.json()) as any).items).toEqual([]);
  });
});

describe('Channel attachment sender facets (GET .../attachments/senders)', () => {
  let t: TestApp | null = null;
  afterEach(() => {
    t?.cleanup();
    t = null;
  });

  async function referenceAsUser(tt: TestApp, channelId: string, filename: string) {
    const dto = await (
      await uploadFile(
        tt,
        `/api/channels/${channelId}/attachments`,
        filename,
        'image/png',
        PNG_BYTES,
      )
    ).json() as any;
    const viewer = http(tt, { 'X-Silverhand-User-Id': 'local' });
    const msg = await viewer.post(`/api/channels/${channelId}/messages`, {
      content: filename,
      attachment_ids: [dto.id],
    });
    expect(msg.status).toBe(201);
    return dto;
  }

  it('returns the distinct canonical-source actors in deterministic order', async () => {
    t = buildTestApp();
    const viewer = http(t, { 'X-Silverhand-User-Id': 'local' });
    const { channelId, agentIds } = await createWorkspaceChannel(t, ['alice']);
    const agentId = agentIds.alice!;
    // One user-sourced attachment via the public path.
    await referenceAsUser(t, channelId, 'u.png');
    // One agent-sourced attachment — inserted directly (the public compose
    // path is user-only); the blob still needs a real row for the boundary
    // join, so upload it first, then attribute the reference to the agent.
    const agentDto = await (
      await uploadFile(
        t,
        `/api/channels/${channelId}/attachments`,
        'a.png',
        'image/png',
        PNG_BYTES,
      )
    ).json() as any;
    new MessageRepo(t.ctx.db).insertForConversation({
      conversationId: channelId,
      fromKind: 'agent',
      fromAgentId: agentId,
      content: 'from agent',
      attachments: [
        { id: agentDto.id, filename: 'a.png', size: 1, content_type: 'image/png' },
      ],
    });

    const res = await viewer.get(
      `/api/channels/${channelId}/attachments/senders`,
    );
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    // from_kind ASC ('agent' before 'user'); identity-only, no display_name.
    expect(body.senders).toEqual([
      { from_kind: 'agent', from_user_id: null, from_agent_id: agentId },
      { from_kind: 'user', from_user_id: 'local', from_agent_id: null },
    ]);
  });

  it('returns 404 for an unknown channel id', async () => {
    t = buildTestApp();
    const viewer = http(t, { 'X-Silverhand-User-Id': 'local' });
    await createWorkspaceChannel(t);
    const res = await viewer.get('/api/channels/no-such/attachments/senders');
    expect(res.status).toBe(404);
  });

  it('returns 403 for a workspace member who is not a conversation member', async () => {
    // Same view gate as the list: workspace membership alone is insufficient.
    t = buildTestApp();
    const { workspaceId, channelId } = await createWorkspaceChannel(t);
    await referenceAsUser(t, channelId, 'private.png');
    t.ctx.db
      .prepare('DELETE FROM conversation_users WHERE conversation_id = ? AND user_id = ?')
      .run(channelId, 'teammate');
    const wsRow = t.ctx.db
      .prepare('SELECT 1 AS hit FROM workspace_users WHERE workspace_id = ? AND user_id = ?')
      .get(workspaceId, 'teammate');
    expect(wsRow).not.toBeUndefined();

    const teammate = http(t, {
      [X_SILVERHAND_PRINCIPAL_HEADER]: encodeUserPrincipalHeader('teammate'),
    });
    const res = await teammate.get(
      `/api/channels/${channelId}/attachments/senders`,
    );
    expect(res.status).toBe(403);
  });
});

describe('Internal agent attachment routes', () => {
  let t: TestApp | null = null;
  afterEach(() => {
    t?.cleanup();
    t = null;
  });

  it('agent uploads via the internal route and locate returns the local path', async () => {
    t = buildTestApp();
    const { channelId, agentIds } = await createWorkspaceChannel(t, ['alice']);
    const aliceId = agentIds.alice!;

    const upload = await uploadFile(
      t,
      `/internal/conversations/${channelId}/agents/${aliceId}/attachments`,
      'agent.png',
      'image/png',
      PNG_BYTES,
      internalAuthHeaders(t, channelId, aliceId),
      `#conv:${channelId}`,
    );
    expect(upload.status).toBe(201);
    const dto = await upload.json() as any;
    expect(dto.channel_id).toBe(channelId);
    expect(dto.created_by_kind).toBe('agent');
    expect(dto.created_by_id).toBe(aliceId);

    const locate = await t.app.fetch(
      new Request(
        `http://localhost/internal/conversations/${channelId}/agents/${aliceId}/attachments/${dto.id}/locate`,
        { headers: internalAuthHeaders(t, channelId, aliceId) },
      ),
    );
    expect(locate.status).toBe(200);
    const body = await locate.json() as any;
    expect(body.storage).toBe('local');
    expect(body.local_path.length).toBeGreaterThan(0);
    expect(body.filename).toBe('agent.png');
  });

  it('locate denies access when the attachment is from another channel (404)', async () => {
    t = buildTestApp();
    const a = await createWorkspaceChannel(t, ['alice1']);
    const b = await createWorkspaceChannel(t, ['alice2']);
    const aliceA = a.agentIds.alice1!;
    const aliceB = b.agentIds.alice2!;

    const dto = await (
      await uploadFile(
        t,
        `/internal/conversations/${a.channelId}/agents/${aliceA}/attachments`,
        'a.png',
        'image/png',
        PNG_BYTES,
        internalAuthHeaders(t, a.channelId, aliceA),
        `#conv:${a.channelId}`,
      )
    ).json() as any;

    const cross = await t.app.fetch(
      new Request(
        `http://localhost/internal/conversations/${b.channelId}/agents/${aliceB}/attachments/${dto.id}/locate`,
        { headers: internalAuthHeaders(t, b.channelId, aliceB) },
      ),
    );
    expect(cross.status).toBe(404);
  });

  it('agent downloads attachment bytes through the internal route after same-channel ACL', async () => {
    t = buildTestApp();
    const { channelId, agentIds } = await createWorkspaceChannel(t, ['alice']);
    const aliceId = agentIds.alice!;

    const upload = await uploadFile(
      t,
      `/internal/conversations/${channelId}/agents/${aliceId}/attachments`,
      'agent.png',
      'image/png',
      PNG_BYTES,
      internalAuthHeaders(t, channelId, aliceId),
      `#conv:${channelId}`,
    );
    expect(upload.status).toBe(201);
    const dto = await upload.json() as any;

    const download = await t.app.fetch(
      new Request(
        `http://localhost/internal/conversations/${channelId}/agents/${aliceId}/attachments/${dto.id}/download`,
        { headers: internalAuthHeaders(t, channelId, aliceId) },
      ),
    );
    expect(download.status).toBe(200);
    expect(download.headers.get('content-type')).toBe('image/png');
    expect(Buffer.from(await download.arrayBuffer())).toEqual(PNG_BYTES);
  });

  it('download denies access when the attachment is from another channel (404)', async () => {
    t = buildTestApp();
    const a = await createWorkspaceChannel(t, ['alice1']);
    const b = await createWorkspaceChannel(t, ['alice2']);
    const aliceA = a.agentIds.alice1!;
    const aliceB = b.agentIds.alice2!;

    const dto = await (
      await uploadFile(
        t,
        `/internal/conversations/${a.channelId}/agents/${aliceA}/attachments`,
        'a.png',
        'image/png',
        PNG_BYTES,
        internalAuthHeaders(t, a.channelId, aliceA),
        `#conv:${a.channelId}`,
      )
    ).json() as any;

    const cross = await t.app.fetch(
      new Request(
        `http://localhost/internal/conversations/${b.channelId}/agents/${aliceB}/attachments/${dto.id}/download`,
        { headers: internalAuthHeaders(t, b.channelId, aliceB) },
      ),
    );
    expect(cross.status).toBe(404);
  });

  it('upload is rejected when the agent is not a member of the conversation (403)', async () => {
    t = buildTestApp();
    const a = await createWorkspaceChannel(t, ['alice']);
    const b = await createWorkspaceChannel(t, ['bob']);
    // bob is not a member of channel a
    const res = await uploadFile(
      t,
      `/internal/conversations/${a.channelId}/agents/${b.agentIds.bob}/attachments`,
      'x.png',
      'image/png',
      PNG_BYTES,
      internalAuthHeaders(t, a.channelId, b.agentIds.bob!),
      `#conv:${a.channelId}`,
    );
    expect(res.status).toBe(401);
  });

  it('agent send-message embeds attachment snapshots when channel ownership matches', async () => {
    t = buildTestApp();
    const { channelId, agentIds } = await createWorkspaceChannel(t, ['alice']);
    const aliceId = agentIds.alice!;
    const dto = await (
      await uploadFile(
        t,
        `/internal/conversations/${channelId}/agents/${aliceId}/attachments`,
        'a.png',
        'image/png',
        PNG_BYTES,
        internalAuthHeaders(t, channelId, aliceId),
        `#conv:${channelId}`,
      )
    ).json() as any;

    const send = await http(t).post(
      `/internal/conversations/${channelId}/agents/${aliceId}/send-message`,
      { content: 'with file', attachment_ids: [dto.id], target: `#conv:${channelId}` },
      { headers: internalAuthHeaders(t, channelId, aliceId) },
    );
    expect(send.status).toBe(200);
    const body = await send.json() as any;
    expect(typeof body.message_id).toBe('string');

    // Confirm the snapshot landed on the persisted message via the
    // public messages route.
    const messages = await (
      await http(t).get(`/api/channels/${channelId}/messages`, {
        headers: { 'X-Silverhand-User-Id': 'local' },
      })
    ).json() as any;
    const stored = messages.messages.find((m: any) => m.id === body.message_id);
    expect(stored.attachments).toHaveLength(1);
    expect(stored.attachments[0]).toMatchObject({
      id: dto.id,
      filename: 'a.png',
      content_type: 'image/png',
    });
  });

  it('agent send-message accepts attachment-only content', async () => {
    t = buildTestApp();
    const { channelId, agentIds } = await createWorkspaceChannel(t, ['alice']);
    const aliceId = agentIds.alice!;
    const dto = await (
      await uploadFile(
        t,
        `/internal/conversations/${channelId}/agents/${aliceId}/attachments`,
        'a.png',
        'image/png',
        PNG_BYTES,
        internalAuthHeaders(t, channelId, aliceId),
        `#conv:${channelId}`,
      )
    ).json() as any;

    const send = await http(t).post(
      `/internal/conversations/${channelId}/agents/${aliceId}/send-message`,
      { content: '', attachment_ids: [dto.id], target: `#conv:${channelId}` },
      { headers: internalAuthHeaders(t, channelId, aliceId) },
    );
    expect(send.status).toBe(200);
    const body = await send.json() as any;

    const messages = await (
      await http(t).get(`/api/channels/${channelId}/messages`, {
        headers: { 'X-Silverhand-User-Id': 'local' },
      })
    ).json() as any;
    const stored = messages.messages.find((m: any) => m.id === body.message_id);
    expect(stored.content).toBe('');
    expect(stored.attachments).toHaveLength(1);
    expect(stored.attachments[0]).toMatchObject({
      id: dto.id,
      filename: 'a.png',
      content_type: 'image/png',
    });
  });

  it('agent send-message rejects attachment ids from another channel (400)', async () => {
    t = buildTestApp();
    const a = await createWorkspaceChannel(t, ['alice1']);
    const b = await createWorkspaceChannel(t, ['alice2']);
    const aliceA = a.agentIds.alice1!;
    const aliceB = b.agentIds.alice2!;
    const foreign = await (
      await uploadFile(
        t,
        `/internal/conversations/${a.channelId}/agents/${aliceA}/attachments`,
        'x.png',
        'image/png',
        PNG_BYTES,
        internalAuthHeaders(t, a.channelId, aliceA),
        `#conv:${a.channelId}`,
      )
    ).json() as any;

    const res = await http(t).post(
      `/internal/conversations/${b.channelId}/agents/${aliceB}/send-message`,
      { content: 'cross', attachment_ids: [foreign.id], target: `#conv:${b.channelId}` },
      { headers: internalAuthHeaders(t, b.channelId, aliceB) },
    );
    expect(res.status).toBe(400);
    const body = await res.json() as any;
    expect(body.attachment_id).toBe(foreign.id);
  });

  it('agent send-message is rejected when the agent is not a member (403)', async () => {
    t = buildTestApp();
    const a = await createWorkspaceChannel(t, ['alice']);
    const b = await createWorkspaceChannel(t, ['bob']);
    const res = await http(t).post(
      `/internal/conversations/${a.channelId}/agents/${b.agentIds.bob}/send-message`,
      { content: 'forged', target: `#conv:${a.channelId}` },
      { headers: internalAuthHeaders(t, a.channelId, b.agentIds.bob!) },
    );
    expect(res.status).toBe(401);
  });
});

describe('Attachment lifecycle on workspace delete', () => {
  let t: TestApp | null = null;
  afterEach(() => {
    t?.cleanup();
    t = null;
  });

  it('sweeps physical blobs when a workspace is deleted', async () => {
    t = buildTestApp();
    const { workspaceId, channelId } = await createWorkspaceChannel(t, ['alice']);
    const dto = await (
      await uploadFile(
        t,
        `/api/channels/${channelId}/attachments`,
        'a.png',
        'image/png',
        PNG_BYTES,
      )
    ).json() as any;

    // Resolve the on-disk path through the row's storage_key so the
    // assertion stays robust to namespace / extension changes.
    const row = new AttachmentRepo(t.ctx.db).getById(dto.id);
    expect(row).not.toBeNull();
    const localPath = join(t.silverhandDir, 'blobs', row!.storage_key);
    expect(existsSync(localPath)).toBe(true);

    const del = await http(t).del(`/api/workspaces/${workspaceId}`);
    expect(del.status).toBe(204);

    expect(existsSync(localPath)).toBe(false);
  });

  it('sweeps DM attachment blobs when an agent is deleted', async () => {
    t = buildTestApp();
    // Auto-creates a DM channel.
    const created = await (
      await http(t).post('/api/agents', { name: 'alice', runtime: 'claude' })
    ).json() as any;
    const dmChannelId = created.dm_channel_id as string;

    const dto = await (
      await uploadFile(
        t,
        `/api/channels/${dmChannelId}/attachments`,
        'dm.png',
        'image/png',
        PNG_BYTES,
      )
    ).json() as any;

    const row = new AttachmentRepo(t.ctx.db).getById(dto.id);
    expect(row).not.toBeNull();
    const localPath = join(t.silverhandDir, 'blobs', row!.storage_key);
    expect(existsSync(localPath)).toBe(true);

    // Direct fetch — http() helper sets content-type=application/json on
    // DELETE without a body, but agent DELETE requires a confirm flag.
    const del = await t.app.fetch(
      new Request(`http://localhost/api/agents/${created.agent.id}`, {
        method: 'DELETE',
        headers: {
          ...CURRENT_DESKTOP_EPOCH_HEADERS,
          'content-type': 'application/json',
          authorization: `Bearer ${t.authToken}`,
          [X_SILVERHAND_LEGACY_USER_ID_HEADER]: 'local',
        },
        body: JSON.stringify({ confirm: true }),
      }),
    );
    expect(del.status).toBe(204);

    // Regression: ordering bug used to leave the DM blob behind because
    // listDmChannelsForAgent was called AFTER conversation_agents had
    // been wiped, returning an empty list.
    expect(existsSync(localPath)).toBe(false);
  });
});

describe('Single attachment DELETE (orphan-only)', () => {
  let t: TestApp | null = null;
  afterEach(() => {
    t?.cleanup();
    t = null;
  });

  it('deletes an unsent upload and removes the blob (204)', async () => {
    t = buildTestApp();
    const viewer = http(t, { 'X-Silverhand-User-Id': 'local' });
    const { channelId } = await createWorkspaceChannel(t);
    const dto = await (
      await uploadFile(
        t,
        `/api/channels/${channelId}/attachments`,
        'orphan.png',
        'image/png',
        PNG_BYTES,
      )
    ).json() as any;
    const row = new AttachmentRepo(t.ctx.db).getById(dto.id);
    const localPath = join(t.silverhandDir, 'blobs', row!.storage_key);
    expect(existsSync(localPath)).toBe(true);

    const del = await viewer.del(`/api/attachments/${dto.id}`);
    expect(del.status).toBe(204);
    expect(new AttachmentRepo(t.ctx.db).getById(dto.id)).toBeNull();
    expect(existsSync(localPath)).toBe(false);
  });

  it('rejects DELETE of an attachment referenced by a message (409)', async () => {
    t = buildTestApp();
    const viewer = http(t, { 'X-Silverhand-User-Id': 'local' });
    const { channelId } = await createWorkspaceChannel(t);
    const dto = await (
      await uploadFile(
        t,
        `/api/channels/${channelId}/attachments`,
        'attached.png',
        'image/png',
        PNG_BYTES,
      )
    ).json() as any;
    const send = await viewer.post(`/api/channels/${channelId}/messages`, {
      content: 'with file',
      attachment_ids: [dto.id],
    });
    expect(send.status).toBe(201);

    const del = await viewer.del(`/api/attachments/${dto.id}`);
    expect(del.status).toBe(409);
    expect(new AttachmentRepo(t.ctx.db).getById(dto.id)).not.toBeNull();
  });

  it('returns 404 when the attachment id is unknown', async () => {
    t = buildTestApp();
    const viewer = http(t, { 'X-Silverhand-User-Id': 'local' });
    const del = await viewer.del('/api/attachments/does-not-exist');
    expect(del.status).toBe(404);
  });

  it('rejects DELETE for an agent-uploaded attachment from a user (403)', async () => {
    t = buildTestApp();
    const viewer = http(t, { 'X-Silverhand-User-Id': 'local' });
    const { channelId, agentIds } = await createWorkspaceChannel(t, ['alice']);
    const aliceId = agentIds.alice!;
    const dto = await (
      await uploadFile(
        t,
        `/internal/conversations/${channelId}/agents/${aliceId}/attachments`,
        'a.png',
        'image/png',
        PNG_BYTES,
        internalAuthHeaders(t, channelId, aliceId),
        `#conv:${channelId}`,
      )
    ).json() as any;

    const del = await viewer.del(`/api/attachments/${dto.id}`);
    expect(del.status).toBe(403);
    expect(new AttachmentRepo(t.ctx.db).getById(dto.id)).not.toBeNull();
  });
});

describe('Attachment content update (PATCH)', () => {
  let t: TestApp | null = null;
  afterEach(() => {
    t?.cleanup();
    t = null;
  });

  const NEXT_PNG = Buffer.concat([PNG_BYTES, Buffer.from('revised')]);

  it('creator updates in place: same id, bumped revision, new bytes on download', async () => {
    t = buildTestApp();
    const viewer = http(t, { 'X-Silverhand-User-Id': 'local' });
    const { channelId } = await createWorkspaceChannel(t);
    const dto = await (
      await uploadFile(
        t,
        `/api/channels/${channelId}/attachments`,
        'mockup.png',
        'image/png',
        PNG_BYTES,
      )
    ).json() as any;
    expect(dto.content_revision).toBe(1);

    const patched = await patchFile(
      t,
      `/api/attachments/${dto.id}`,
      'ignored-on-update.png',
      'image/png',
      NEXT_PNG,
    );
    expect(patched.status).toBe(200);
    const updated = await patched.json() as any;
    expect(updated.id).toBe(dto.id);
    expect(updated.filename).toBe('mockup.png'); // locked
    expect(updated.content_type).toBe('image/png'); // locked
    expect(updated.content_revision).toBe(2);
    expect(updated.size).toBe(NEXT_PNG.length);

    const get = await viewer.get(`/api/attachments/${dto.id}`);
    expect(Buffer.from(await get.arrayBuffer())).toEqual(NEXT_PNG);
  });

  it('rejects a cross-type update with 400 (type lock enforced from bytes, not the declared type)', async () => {
    t = buildTestApp();
    const viewer = http(t, { 'X-Silverhand-User-Id': 'local' });
    const { channelId } = await createWorkspaceChannel(t);
    const dto = await (
      await uploadFile(
        t,
        `/api/channels/${channelId}/attachments`,
        'mockup.png',
        'image/png',
        PNG_BYTES,
      )
    ).json() as any;

    // PDF bytes, even with a declared `image/png` part type, must be rejected:
    // the lock is checked against the sniffed magic family, never the caller's
    // declared type (declaring png is exactly the impersonation this blocks).
    const patched = await patchFile(
      t,
      `/api/attachments/${dto.id}`,
      'mockup.png',
      'image/png',
      Buffer.from('%PDF-1.4\n'),
    );
    expect(patched.status).toBe(400);
    const body = await patched.json() as any;
    expect(body.code).toBe('content_type_mismatch');

    // Row untouched — still revision 1 and the original PNG bytes.
    const get = await viewer.get(`/api/attachments/${dto.id}`);
    expect(Buffer.from(await get.arrayBuffer())).toEqual(PNG_BYTES);
  });

  it('does not advance the message stream, and emits attachment_changed on the side channel', async () => {
    t = buildTestApp();
    const { channelId } = await createWorkspaceChannel(t);
    const dto = await (
      await uploadFile(
        t,
        `/api/channels/${channelId}/attachments`,
        'a.png',
        'image/png',
        PNG_BYTES,
      )
    ).json() as any;

    // Capture the message-stream seq (freshness floor) before the update.
    const msgScope = conversationScope(channelId);
    const seqBefore = t.ctx.events.currentSeq(msgScope);

    const sideEvents: Array<{ kind: string; payload: any }> = [];
    const unsub = t.ctx.events.subscribeScope(
      conversationSideScope(channelId),
      e => sideEvents.push({ kind: e.kind, payload: e.payload }),
    );
    try {
      const patched = await patchFile(
        t,
        `/api/attachments/${dto.id}`,
        'a.png',
        'image/png',
        NEXT_PNG,
      );
      expect(patched.status).toBe(200);
    } finally {
      unsub();
    }

    // Freshness exclusion: the message stream never advanced (no new message,
    // no unread bump, no read-cursor movement).
    expect(t.ctx.events.currentSeq(msgScope)).toBe(seqBefore);
    // …but a cursor-inert cache-bust landed on the side channel, naming the id
    // and its new revision (not the bytes).
    expect(sideEvents).toEqual([
      {
        kind: ATTACHMENT_CHANGED_EVENT,
        payload: { attachment_id: dto.id, content_revision: 2 },
      },
    ]);
  });

  it('allows updating an attachment already referenced by a message (contrast DELETE 409)', async () => {
    t = buildTestApp();
    const viewer = http(t, { 'X-Silverhand-User-Id': 'local' });
    const { channelId } = await createWorkspaceChannel(t);
    const dto = await (
      await uploadFile(
        t,
        `/api/channels/${channelId}/attachments`,
        'sent.png',
        'image/png',
        PNG_BYTES,
      )
    ).json() as any;
    const send = await viewer.post(`/api/channels/${channelId}/messages`, {
      content: 'with file',
      attachment_ids: [dto.id],
    });
    expect(send.status).toBe(201);

    // DELETE is refused for an in-use attachment…
    const del = await viewer.del(`/api/attachments/${dto.id}`);
    expect(del.status).toBe(409);
    // …but PATCH (update) is allowed — updating referenced bytes is the point.
    const patched = await patchFile(
      t,
      `/api/attachments/${dto.id}`,
      'sent.png',
      'image/png',
      NEXT_PNG,
    );
    expect(patched.status).toBe(200);
  });

  it('rejects a non-creator (user updating an agent-uploaded attachment) with 403', async () => {
    t = buildTestApp();
    const { channelId, agentIds } = await createWorkspaceChannel(t, ['alice']);
    const aliceId = agentIds.alice!;
    const dto = await (
      await uploadFile(
        t,
        `/internal/conversations/${channelId}/agents/${aliceId}/attachments`,
        'a.png',
        'image/png',
        PNG_BYTES,
        internalAuthHeaders(t, channelId, aliceId),
        `#conv:${channelId}`,
      )
    ).json() as any;

    const patched = await patchFile(
      t,
      `/api/attachments/${dto.id}`,
      'a.png',
      'image/png',
      NEXT_PNG,
    );
    expect(patched.status).toBe(403);
  });

  it('returns 404 for an unknown attachment id', async () => {
    t = buildTestApp();
    await createWorkspaceChannel(t);
    const patched = await patchFile(
      t,
      '/api/attachments/does-not-exist',
      'a.png',
      'image/png',
      NEXT_PNG,
    );
    expect(patched.status).toBe(404);
  });

  it('agent updates its own attachment via the internal route', async () => {
    t = buildTestApp();
    const { channelId, agentIds } = await createWorkspaceChannel(t, ['alice']);
    const aliceId = agentIds.alice!;
    const dto = await (
      await uploadFile(
        t,
        `/internal/conversations/${channelId}/agents/${aliceId}/attachments`,
        'agent.png',
        'image/png',
        PNG_BYTES,
        internalAuthHeaders(t, channelId, aliceId),
        `#conv:${channelId}`,
      )
    ).json() as any;

    const patched = await patchFile(
      t,
      `/internal/conversations/${channelId}/agents/${aliceId}/attachments/${dto.id}`,
      'agent.png',
      'image/png',
      NEXT_PNG,
      internalAuthHeaders(t, channelId, aliceId),
    );
    expect(patched.status).toBe(200);
    const updated = await patched.json() as any;
    expect(updated.id).toBe(dto.id);
    expect(updated.content_revision).toBe(2);

    // The agent-visible download now streams the new bytes.
    const download = await t.app.fetch(
      new Request(
        `http://localhost/internal/conversations/${channelId}/agents/${aliceId}/attachments/${dto.id}/download`,
        { headers: internalAuthHeaders(t, channelId, aliceId) },
      ),
    );
    expect(Buffer.from(await download.arrayBuffer())).toEqual(NEXT_PNG);
  });

  it('agent update denies a cross-channel attachment with 404 (no existence leak)', async () => {
    t = buildTestApp();
    const a = await createWorkspaceChannel(t, ['alice1']);
    const b = await createWorkspaceChannel(t, ['alice2']);
    const aliceA = a.agentIds.alice1!;
    const aliceB = b.agentIds.alice2!;
    const dto = await (
      await uploadFile(
        t,
        `/internal/conversations/${a.channelId}/agents/${aliceA}/attachments`,
        'a.png',
        'image/png',
        PNG_BYTES,
        internalAuthHeaders(t, a.channelId, aliceA),
        `#conv:${a.channelId}`,
      )
    ).json() as any;

    const cross = await patchFile(
      t,
      `/internal/conversations/${b.channelId}/agents/${aliceB}/attachments/${dto.id}`,
      'a.png',
      'image/png',
      NEXT_PNG,
      internalAuthHeaders(t, b.channelId, aliceB),
    );
    expect(cross.status).toBe(404);
  });

  it('agent update is rejected when the agent is not a member (403)', async () => {
    t = buildTestApp();
    const a = await createWorkspaceChannel(t, ['alice']);
    const b = await createWorkspaceChannel(t, ['bob']);
    const dto = await (
      await uploadFile(
        t,
        `/internal/conversations/${a.channelId}/agents/${a.agentIds.alice}/attachments`,
        'a.png',
        'image/png',
        PNG_BYTES,
        internalAuthHeaders(t, a.channelId, a.agentIds.alice!),
        `#conv:${a.channelId}`,
      )
    ).json() as any;

    const res = await patchFile(
      t,
      `/internal/conversations/${a.channelId}/agents/${b.agentIds.bob}/attachments/${dto.id}`,
      'a.png',
      'image/png',
      NEXT_PNG,
      internalAuthHeaders(t, a.channelId, b.agentIds.bob!),
    );
    expect(res.status).toBe(401);
  });
});

describe('formatAttachmentSuffix', () => {
  it('returns empty when there are no attachments', () => {
    expect(formatAttachmentSuffix(null)).toBe('');
    expect(formatAttachmentSuffix([])).toBe('');
    expect(formatAttachmentSuffix(undefined)).toBe('');
  });

  it('renders a deterministic silverhand file view block for one attachment', () => {
    const out = formatAttachmentSuffix([
      { id: 'att-1', filename: 'a.png', size: 12, content_type: 'image/png' },
    ]);
    expect(out).toContain('1 attachment');
    expect(out).toContain('silverhand file view --attachment-id <id>');
    expect(out).toContain('id=att-1');
    expect(out).toContain('filename="a.png"');
    expect(out).toContain('content_type=image/png');
  });

  it('leads each line with a positional label when none is stored', () => {
    const out = formatAttachmentSuffix([
      { id: 'att-1', filename: 'a.png', size: 12, content_type: 'image/png' },
      { id: 'att-2', filename: 'b.pdf', size: 200, content_type: 'application/pdf' },
    ]);
    expect(out).toContain('- Image #1 — id=att-1');
    expect(out).toContain('- File #1 — id=att-2');
  });

  it('echoes the sender-stored label instead of a positional fallback', () => {
    const out = formatAttachmentSuffix([
      { id: 'att-1', filename: 'a.png', size: 12, content_type: 'image/png', label: 'Image #3' },
    ]);
    expect(out).toContain('- Image #3 — id=att-1');
    // Not the positional fallback line (the header may mention `Image #1` as an
    // example, so assert on the attachment line, not the whole suffix).
    expect(out).not.toContain('- Image #1 — id=att-1');
  });

  it('lists every attachment and pluralises the header', () => {
    const out = formatAttachmentSuffix([
      { id: 'att-1', filename: 'a.png', size: 12, content_type: 'image/png' },
      { id: 'att-2', filename: 'b.pdf', size: 200, content_type: 'application/pdf' },
    ]);
    expect(out).toContain('2 attachments');
    expect(out).toContain('id=att-1');
    expect(out).toContain('id=att-2');
  });
});
