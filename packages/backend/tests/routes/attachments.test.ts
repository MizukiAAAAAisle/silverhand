import { afterEach, describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { X_SILVERHAND_LEGACY_USER_ID_HEADER } from '@silverhand/shared';
import { formatAttachmentSuffix } from '../../src/runtime/stdin-format.js';
import { AttachmentRepo } from '../../src/repos/attachment-repo.js';
import { buildTestApp, http, type TestApp } from '../utils/app.js';

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
  return authHeaders(t.ctx.agentTokens.issue(conversationId, agentId));
}

/** Direct multipart upload — bypasses the JSON-shaped `http().post`
 *  helper because FormData needs to set its own Content-Type with
 *  boundary. */
async function uploadFile(
  t: TestApp,
  path: string,
  filename: string,
  contentType: string,
  bytes: Buffer,
  extraHeaders?: Record<string, string>,
): Promise<Response> {
  const form = new FormData();
  form.append('file', new Blob([bytes], { type: contentType }), filename);
  const headers: Record<string, string> = extraHeaders ?? {
    'X-Silverhand-User-Id': 'local',
    authorization: `Bearer ${t.authToken}`,
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
        headers: { 'X-Silverhand-User-Id': 'local' },
      }),
    );
    expect(noBearer.status).toBe(401);

    const wrongBearer = await t.app.fetch(
      new Request(`http://localhost/api/attachments/${dto.id}`, {
        headers: {
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
    );
    expect(res.status).toBe(403);
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
      )
    ).json() as any;

    const send = await http(t).post(
      `/internal/conversations/${channelId}/agents/${aliceId}/send-message`,
      { content: 'with file', attachment_ids: [dto.id] },
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
      )
    ).json() as any;

    const res = await http(t).post(
      `/internal/conversations/${b.channelId}/agents/${aliceB}/send-message`,
      { content: 'cross', attachment_ids: [foreign.id] },
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
      { content: 'forged' },
      { headers: internalAuthHeaders(t, a.channelId, b.agentIds.bob!) },
    );
    expect(res.status).toBe(403);
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
    const localPath = join(t.ctx.silverhandDir, 'blobs', row!.storage_key);
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
    const localPath = join(t.ctx.silverhandDir, 'blobs', row!.storage_key);
    expect(existsSync(localPath)).toBe(true);

    // Direct fetch — http() helper sets content-type=application/json on
    // DELETE without a body, but agent DELETE requires a confirm flag.
    const del = await t.app.fetch(
      new Request(`http://localhost/api/agents/${created.agent.id}`, {
        method: 'DELETE',
        headers: {
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
    const localPath = join(t.ctx.silverhandDir, 'blobs', row!.storage_key);
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
      )
    ).json() as any;

    const del = await viewer.del(`/api/attachments/${dto.id}`);
    expect(del.status).toBe(403);
    expect(new AttachmentRepo(t.ctx.db).getById(dto.id)).not.toBeNull();
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
