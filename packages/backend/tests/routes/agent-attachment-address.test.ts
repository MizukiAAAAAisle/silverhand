import { afterEach, describe, expect, it } from 'vitest';
import { internalPaths } from '@silverhand/shared';
import { AgentCapabilityRepo } from '../../src/repos/agent-capability-repo.js';
import { AttachmentRepo } from '../../src/repos/attachment-repo.js';
import { ConversationRepo } from '../../src/repos/conversation-repo.js';
import {
  buildTestApp,
  conversationSlotAuth,
  http,
  issueTestConversationRuntimeToken,
  type TestApp,
} from '../utils/app.js';
import { agentSlotAuth, insertAgentScopedAgent } from '../utils/agent-scope.js';

/**
 * #task:2021 P4-4: the agent's upload door takes ONE absolute address.
 *
 * An attachment is owned by a CONVERSATION, while the runtime credential carries
 * custody rather than a route destination, so the destination is its own fact,
 * carried as a form field beside the bytes. These are the
 * differentials that would still pass if the route quietly kept uploading into
 * the credential's conversation, or accepted a `/thread:` suffix and dropped it,
 * or judged the capability where the token lives instead of where the file
 * lands, or kept the old roster gate that refused every rosterless placement.
 *
 * HOW FAR the address may reach is the credential's own axis (ruled 2026-08-15,
 * §7.1): `file_upload` from a ConversationSlot acts only in its own stream, so the
 * cross-stream cases below carry a real AgentSlot bearer. The confinement itself,
 * per door and per slot kind, is `delivery-reach-slot-scope.test.ts`.
 */

const PNG_BYTES = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47]),
  Buffer.alloc(8, 0),
]);

async function makeAgent(t: TestApp, name: string): Promise<string> {
  const created = (await (
    await http(t).post('/api/agents', { name, runtime: 'claude' })
  ).json()) as any;
  t.fake.starts = [];
  t.fake.delivered = [];
  return created.agent.id;
}

async function makeWorkspace(
  t: TestApp,
  name: string,
  memberAgentIds: string[],
): Promise<{ workspaceId: string; channelId: string }> {
  const created = (await (
    await http(t).post('/api/workspaces', { name, member_agent_ids: memberAgentIds })
  ).json()) as any;
  t.fake.starts = [];
  t.fake.delivered = [];
  return {
    workspaceId: created.workspace.id as string,
    channelId: created.onboarding_channel_id as string,
  };
}

async function createChannel(
  t: TestApp,
  workspaceId: string,
  title: string,
  memberAgentIds: string[],
): Promise<string> {
  const created = (await (
    await http(t).post(`/api/workspaces/${workspaceId}/channels`, {
      title,
      member_agent_ids: memberAgentIds,
    })
  ).json()) as any;
  t.fake.starts = [];
  t.fake.delivered = [];
  return created.channel.id as string;
}

/**
 * Multipart upload through the agent door, exactly as the CLI shapes it: the
 * address is a form field, and `target: null` omits the field entirely (the
 * hand-rolled-client path — the CLI refuses a missing `--target` locally).
 *
 * `credential.conversationId` is used only to mint the default ConversationSlot
 * bearer. Which bearer signs the agent-global route decides how far the address
 * may reach (#task:2021 P4-4): `file_upload` is confined to a ConversationSlot's
 * own stream, so every cross-stream case here is signed by a real AgentSlot — the
 * credential kind that reaches by participation.
 */
async function upload(
  t: TestApp,
  credential: { conversationId: string; agentId: string },
  target: string | null,
  auth?: { authorization: string },
): Promise<Response> {
  const form = new FormData();
  if (target !== null) form.append('target', target);
  form.append('file', new Blob([PNG_BYTES], { type: 'image/png' }), 'shot.png');
  return t.app.fetch(
    new Request(
      `http://localhost${internalPaths.agentUploadAttachment(
        credential.agentId,
      )}`,
      {
        method: 'POST',
        headers: {
          authorization:
            auth?.authorization
            ?? `Bearer ${issueTestConversationRuntimeToken(
              t,
              credential.conversationId,
              credential.agentId,
            )}`,
        },
        body: form,
      },
    ),
  );
}

/**
 * "Nothing was stored" is asked of every conversation the request could have
 * landed in, through the repo rather than raw SQL: a refusal that quietly wrote
 * into the credential's conversation is exactly the failure mode these tests
 * exist to catch, so both candidates are checked.
 */
function attachmentsIn(t: TestApp, conversationId: string): number {
  return new AttachmentRepo(t.ctx.db).listByChannel(conversationId).length;
}

async function patchAttachment(
  t: TestApp,
  agentId: string,
  attachmentId: string,
  auth: { authorization: string },
): Promise<Response> {
  const form = new FormData();
  form.append(
    'file',
    new Blob([Buffer.concat([PNG_BYTES, Buffer.from('revised')])], {
      type: 'image/png',
    }),
    'shot.png',
  );
  return t.app.fetch(
    new Request(
      `http://localhost${internalPaths.agentUpdateAttachment(agentId, attachmentId)}`,
      { method: 'PATCH', headers: auth, body: form },
    ),
  );
}

describe('internal file upload — the address is the destination', () => {
  let t: TestApp | null = null;
  afterEach(() => {
    t?.cleanup();
    t = null;
  });

  it('lands in the conversation the ADDRESS names, independent of runtime provenance', async () => {
    t = buildTestApp();
    const seed = await makeAgent(t, 'seed');
    const alice = insertAgentScopedAgent(t, seed, 'alice');
    const ws = await makeWorkspace(t, 'addressed-upload', [alice]);
    const credentialChannel = await createChannel(t, ws.workspaceId, 'where-i-run', [alice]);
    const destination = await createChannel(t, ws.workspaceId, 'where-it-lands', [alice]);

    const res = await upload(
      t,
      { conversationId: credentialChannel, agentId: alice },
      `#conv:${destination}`,
      agentSlotAuth(t, alice),
    );
    expect(res.status).toBe(201);
    const dto = (await res.json()) as any;
    // `channel_id` is the owning conversation, and it is the destination — not
    // any transport coordinate.
    expect(dto.channel_id).toBe(destination);
    expect(dto.source_conversation_id).toBe(destination);
  });

  it('uploads into a rosterless placement it can address — a pair has no member row to pass', async () => {
    t = buildTestApp();
    const seed = await makeAgent(t, 'seed');
    const alice = insertAgentScopedAgent(t, seed, 'alice');
    const bob = await makeAgent(t, 'bob');
    const ws = await makeWorkspace(t, 'pair-upload', [alice, bob]);

    const res = await upload(
      t,
      { conversationId: ws.channelId, agentId: alice },
      'dm:@bob',
      agentSlotAuth(t, alice),
    );
    expect(res.status).toBe(201);
    const dto = (await res.json()) as any;
    // The door used to ask `conversation_agents` for the path conversation,
    // which no pair and no inbox ever has; the credential gate replaces it, so
    // a DM is now an ordinary destination.
    const pair = new ConversationRepo(t.ctx.db).findDirectPair(
      { kind: 'agent', id: alice },
      { kind: 'agent', id: bob },
    );
    expect(pair).not.toBeNull();
    expect(dto.channel_id).toBe(pair!.id);
  });

  it('answers a conversation it cannot post to exactly like one that does not exist, and stores nothing', async () => {
    t = buildTestApp();
    const alice = await makeAgent(t, 'alice');
    const bob = await makeAgent(t, 'bob');
    const ws = await makeWorkspace(t, 'unknown-equals-unauthorized-upload', [alice, bob]);
    const mine = await createChannel(t, ws.workspaceId, 'mine', [alice]);
    const theirs = await createChannel(t, ws.workspaceId, 'theirs', [bob]);

    const unauthorized = await upload(
      t,
      { conversationId: mine, agentId: alice },
      `#conv:${theirs}`,
    );
    const unknown = await upload(
      t,
      { conversationId: mine, agentId: alice },
      '#conv:AAAAAAAAAAAAAAAA',
    );

    expect(unauthorized.status).toBe(404);
    expect(unknown.status).toBe(404);
    // Byte-identical, not merely same-coded: a differing message is the oracle
    // that tells a non-participant the stream exists.
    expect(await unauthorized.text()).toBe(await unknown.text());
    expect(attachmentsIn(t, theirs)).toBe(0);
    expect(attachmentsIn(t, mine)).toBe(0);
  });

  it('refuses a /thread: suffix instead of silently attaching to the parent', async () => {
    t = buildTestApp();
    const alice = await makeAgent(t, 'alice');
    const ws = await makeWorkspace(t, 'suffix-refused-upload', [alice]);
    const root = (await (
      await http(t).post(`/api/channels/${ws.channelId}/messages`, { content: 'root' })
    ).json()) as any;

    const res = await upload(
      t,
      { conversationId: ws.channelId, agentId: alice },
      `#conv:${ws.channelId}/thread:${root.message.id}`,
    );
    expect(res.status).toBe(400);
    expect((await res.json()) as any).toMatchObject({
      code: 'thread_suffix_not_supported',
    });
    // A reply cluster inherits its parent's files rather than owning any, so
    // there is nothing to degrade to: the ask was refused, not reinterpreted.
    expect(attachmentsIn(t, ws.channelId)).toBe(0);
  });

  it('answers an absent target field as a malformed address, from the one grammar authority', async () => {
    t = buildTestApp();
    const alice = await makeAgent(t, 'alice');
    const ws = await makeWorkspace(t, 'no-target-upload', [alice]);

    const res = await upload(t, { conversationId: ws.channelId, agentId: alice }, null);
    expect(res.status).toBe(400);
    expect((await res.json()) as any).toMatchObject({ code: 'target_malformed' });
    expect(attachmentsIn(t, ws.channelId)).toBe(0);
  });

  it('judges upload_attachments in the DESTINATION workspace, not the credential one', async () => {
    t = buildTestApp();
    const seed = await makeAgent(t, 'seed');
    const alice = insertAgentScopedAgent(t, seed, 'alice');
    const home = await makeWorkspace(t, 'home', [alice]);
    const away = await makeWorkspace(t, 'away', [alice]);
    const caps = new AgentCapabilityRepo(t.ctx.db);
    const auth = agentSlotAuth(t, alice);

    // Full set at home, nothing useful where the file is going.
    caps.replaceSet(away.workspaceId, alice, ['read_messages']);
    const denied = await upload(
      t,
      { conversationId: home.channelId, agentId: alice },
      `#conv:${away.channelId}`,
      auth,
    );
    expect(denied.status).toBe(403);
    expect((await denied.json()) as any).toMatchObject({
      code: 'capability_denied',
      capability: 'upload_attachments',
    });
    expect(attachmentsIn(t, away.channelId)).toBe(0);
    expect(attachmentsIn(t, home.channelId)).toBe(0);

    // Positive control, inverted: the grant that matters is the destination's,
    // and the credential's workspace losing it changes nothing.
    caps.replaceSet(away.workspaceId, alice, ['upload_attachments']);
    caps.replaceSet(home.workspaceId, alice, ['read_messages']);
    const ok = await upload(
      t,
      { conversationId: home.channelId, agentId: alice },
      `#conv:${away.channelId}`,
      auth,
    );
    expect(ok.status).toBe(201);
    expect(((await ok.json()) as any).channel_id).toBe(away.channelId);
  });

  it('keeps object-addressed attachment writes inside a ConversationSlot while AgentSlot remains cross-stream', async () => {
    t = buildTestApp();
    const alice = await makeAgent(t, 'alice');
    const global = insertAgentScopedAgent(t, alice, 'global');
    const ws = await makeWorkspace(t, 'attachment-update-reach', [alice, global]);
    const anchor = await createChannel(t, ws.workspaceId, 'anchor', [alice, global]);
    const owner = await createChannel(t, ws.workspaceId, 'owner', [alice, global]);
    const uploaded = await upload(
      t,
      { conversationId: anchor, agentId: alice },
      `#conv:${owner}`,
      conversationSlotAuth(t, owner, alice),
    );
    expect(uploaded.status).toBe(201);
    const dto = (await uploaded.json()) as { id: string };
    const attachments = new AttachmentRepo(t.ctx.db);

    const confined = await patchAttachment(
      t,
      alice,
      dto.id,
      conversationSlotAuth(t, anchor, alice),
    );
    expect(confined.status).toBe(404);
    expect(await confined.json()).toEqual({ error: 'attachment not found' });
    expect(attachments.getById(dto.id)?.content_revision).toBe(1);

    const ownStream = await patchAttachment(
      t,
      alice,
      dto.id,
      conversationSlotAuth(t, owner, alice),
    );
    expect(ownStream.status).toBe(200);
    expect(((await ownStream.json()) as any).content_revision).toBe(2);
    expect(attachments.getById(dto.id)?.content_revision).toBe(2);

    const globalAuth = agentSlotAuth(t, global);
    const globalUpload = await upload(
      t,
      { conversationId: anchor, agentId: global },
      `#conv:${owner}`,
      globalAuth,
    );
    expect(globalUpload.status).toBe(201);
    const globalDto = (await globalUpload.json()) as { id: string };
    const globalPatch = await patchAttachment(
      t,
      global,
      globalDto.id,
      globalAuth,
    );
    expect(globalPatch.status).toBe(200);
    expect(((await globalPatch.json()) as any).content_revision).toBe(2);
  });
});
