import { afterEach, describe, expect, it } from 'vitest';
import {
  AgentSendMessageOutputSchema,
  fixedConversationTitle,
  internalPaths,
  X_SILVERHAND_PRINCIPAL_HEADER,
} from '@silverhand/shared';
import {
  buildTestApp,
  http,
  issueTestConversationRuntimeToken,
  type TestApp,
} from '../utils/app.js';
import {
  agentSlotAuth,
  drainInput,
  enqueueUndeliveredInput,
  insertAgentScopedAgent,
} from '../utils/agent-scope.js';

async function setupSession(
  t: TestApp,
  members: string[] = ['alice', 'bob'],
): Promise<{
  conversationId: string;
  channelId: string;
  agentIds: Record<string, string>;
}> {
  const agentIds: Record<string, string> = {};
  for (const name of members) {
    const r = await (
      await http(t).post('/api/agents', { name, runtime: 'claude' })
    ).json() as any;
    agentIds[name] = r.agent.id;
  }
  const ws = await (
    await http(t).post('/api/workspaces', {
      name: 'eng',
      member_agent_ids: Object.values(agentIds),
    })
  ).json() as any;
  // reset spawn sinks
  t.fake.starts = [];
  t.fake.delivered = [];
  t.fake.stops = [];
  return {
    conversationId: ws.onboarding_channel_id,
    channelId: ws.workspace.id,
    agentIds,
  };
}

function authHeaders(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

describe('Internal route auth', () => {
  let t: TestApp | null = null;
  afterEach(() => {
    t?.cleanup();
    t = null;
  });

  it('rejects request with no Authorization header (401)', async () => {
    t = buildTestApp();
    const { conversationId, agentIds } = await setupSession(t);
    const r = await http(t.app).post(
      `/internal/agents/${agentIds.alice}/send-message`,
      { content: 'hi', target: `#conv:${conversationId}` },
    );
    expect(r.status).toBe(401);
  });

  it('rejects request with wrong bearer token (401)', async () => {
    t = buildTestApp();
    const { conversationId, agentIds } = await setupSession(t);
    const r = await http(t).post(
      `/internal/agents/${agentIds.alice}/send-message`,
      { content: 'hi', target: `#conv:${conversationId}` },
      { headers: authHeaders('wrong') },
    );
    expect(r.status).toBe(401);
  });

  it('does not mount the retired conversation-anchored route family', async () => {
    t = buildTestApp();
    const { conversationId, agentIds } = await setupSession(t, ['alice']);
    const response = await http(t).post(
      `/internal/conversations/${conversationId}/agents/${agentIds.alice}/send-message`,
      { content: 'retired route' },
      {
        headers: authHeaders(issueTestConversationRuntimeToken(
          t,
          conversationId,
          agentIds.alice!,
        )),
      },
    );
    expect(response.status).toBe(404);
  });

  it('accepts a live runtime token on the agent-global route', async () => {
    t = buildTestApp();
    const { conversationId, agentIds } = await setupSession(t);
    const token = issueTestConversationRuntimeToken(t, conversationId, agentIds.alice!);
    const r = await http(t).post(
      `/internal/agents/${agentIds.alice}/send-message`,
      { content: 'hi', target: `#conv:${conversationId}` },
      { headers: authHeaders(token) },
    );
    expect(r.status).toBe(200);
  });

  it('agent-global routes authenticate without an ambient conversation coordinate', async () => {
    t = buildTestApp();
    const { conversationId, agentIds } = await setupSession(t, ['alice']);
    const agentId = agentIds.alice!;
    const token = issueTestConversationRuntimeToken(t, conversationId, agentId);
    const headers = authHeaders(token);

    const response = await http(t).get(
      internalPaths.agentListConversationTasks(agentId),
      { headers },
    );
    expect(response.status).toBe(200);
  });

  it('canonical family requires an explicit target conversation coordinate', async () => {
    t = buildTestApp();
    const { conversationId, agentIds } = await setupSession(t, ['alice']);
    const agentId = agentIds.alice!;
    const token = issueTestConversationRuntimeToken(t, conversationId, agentId);
    const response = await http(t).post(
      `/internal/agents/${agentId}/send-message`,
      { content: 'missing target' },
      { headers: authHeaders(token) },
    );
    expect(response.status).toBe(400);
  });

  it('collapses unknown and unauthorized canonical targets to the same response', async () => {
    t = buildTestApp();
    const { conversationId, channelId, agentIds } = await setupSession(t, ['alice']);
    const agentId = agentIds.alice!;
    const token = issueTestConversationRuntimeToken(t, conversationId, agentId);
    const unauthorized = t.persistence.repos.conversations.insertChannel({
      workspaceId: channelId,
      title: fixedConversationTitle('known but unauthorized'),
    });
    const request = (targetConversationId: string) => http(t!).post(
      internalPaths.agentSendConversationMessage(agentId),
      { content: 'probe', target: `#conv:${targetConversationId}` },
      { headers: authHeaders(token) },
    );
    const known = await request(unauthorized.id);
    const unknown = await request('unknownConv00000');
    expect(known.status).toBe(404);
    expect(unknown.status).toBe(known.status);
    expect(await unknown.json()).toEqual(await known.json());
  });

  it('rejects a token scoped to a different agent URL (401)', async () => {
    t = buildTestApp();
    const { conversationId, agentIds } = await setupSession(t, ['alice', 'bob']);
    const aliceToken = issueTestConversationRuntimeToken(t, conversationId, agentIds.alice!);
    const r = await http(t).post(
      `/internal/agents/${agentIds.bob}/send-message`,
      { content: 'hi', target: `#conv:${conversationId}` },
      { headers: authHeaders(aliceToken) },
    );
    expect(r.status).toBe(401);
  });

  it.each(['agent:forged', 'user:local'])(
    'rejects principal header %s on internal routes (400)',
    async principalHeader => {
      t = buildTestApp();
      const { conversationId, agentIds } = await setupSession(t);
      const r = await http(t).post(
        `/internal/agents/${agentIds.alice}/send-message`,
        { content: 'hi', target: `#conv:${conversationId}` },
        {
          headers: {
            ...authHeaders(t.authToken),
            [X_SILVERHAND_PRINCIPAL_HEADER]: principalHeader,
          },
        },
      );
      expect(r.status).toBe(400);
      const body = await r.json() as any;
      expect(body.error).toBe('principal header is not allowed on internal routes');
    },
  );

  it('rejects a forged principal header on the canonical family', async () => {
    t = buildTestApp();
    const { conversationId, agentIds } = await setupSession(t, ['alice']);
    const agentId = agentIds.alice!;
    const token = issueTestConversationRuntimeToken(t, conversationId, agentId);
    const response = await http(t).post(
      internalPaths.agentSendConversationMessage(agentId),
      { content: 'forged' },
      {
        headers: {
          ...authHeaders(token),
          [X_SILVERHAND_PRINCIPAL_HEADER]: 'agent:forged',
        },
      },
    );
    expect(response.status).toBe(400);
  });
});

describe('POST /internal/.../send-message', () => {
  let t: TestApp | null = null;
  afterEach(() => {
    t?.cleanup();
    t = null;
  });

  it('writes the message to self target + distributes to other agents (not the sender)', async () => {
    t = buildTestApp();
    const { conversationId, agentIds } = await setupSession(t, ['alice', 'bob']);
    const viewerEvents: Array<{ kind: string; payload: unknown }> = [];
    const unsubViewer = t.ctx.events.subscribeScope('viewer:local', e => {
      viewerEvents.push({ kind: e.kind, payload: e.payload });
    });
    const r = await http(t).post(
      `/internal/agents/${agentIds.alice}/send-message`,
      { content: 'hello team', target: `#conv:${conversationId}` },
      {
        headers: authHeaders(issueTestConversationRuntimeToken(
          t,
          conversationId,
          agentIds.alice!,
        )),
      },
    );
    unsubViewer();
    expect(r.status).toBe(200);
    const body = await r.json() as any;
    expect(typeof body.message_id).toBe('string');
    expect(typeof body.message_seq).toBe('number');

    // Sender (alice) is excluded; bob gets the delivery.
    expect(t.fake.delivered.map(d => d.agentId)).toEqual([agentIds.bob]);
    expect(t.fake.delivered[0]!.conversationId).toBe(conversationId);

    const msgs = await (
      await http(t).get(`/api/channels/${conversationId}/messages`)
    ).json() as any;
    const inserted = msgs.messages.find((m: any) => m.id === body.message_id);
    expect(inserted.seq).toBe(body.message_seq);
    expect(inserted.from_kind).toBe('agent');
    expect(inserted.from_agent_id).toBe(agentIds.alice);
    expect(inserted.content).toBe('hello team');
    // #task:1283: message variant enriched with absolute counts; assert the
    // discriminator + presence of the enriched fields.
    expect(viewerEvents).toContainEqual(
      expect.objectContaining({
        kind: 'unread_updated',
        payload: expect.objectContaining({
          conversation_id: conversationId,
          conversation_unread_count: expect.any(Number),
          workspace_unread_count: expect.any(Number),
        }),
      }),
    );
  });

  it('tells the SENDER which of its references addressed nobody, and says nothing when they all landed (#task:2021 P4-5-b)', async () => {
    t = buildTestApp();
    const { conversationId, agentIds } = await setupSession(t, ['alice', 'bob']);
    const send = (content: string) => http(t!).post(
      internalPaths.agentSendConversationMessage(agentIds.alice!),
      { content, target: `#conv:${conversationId}` },
      {
        headers: authHeaders(issueTestConversationRuntimeToken(
          t!,
          conversationId,
          agentIds.alice!,
        )),
      },
    );

    const landed = await send('<silverhand://agent/bob> ping');
    expect(landed.status).toBe(200);
    const landedBody = AgentSendMessageOutputSchema.parse(await landed.json());
    // ABSENT, not `[]`: an empty array on every ordinary send would be noise on
    // the one surface an agent reads after each of its own messages. The service
    // field is total; the wire's is present only when it says something.
    expect('unresolved_references' in landedBody).toBe(false);

    const missed = await send('<silverhand://agent/nosuchagent> ping');
    expect(missed.status).toBe(200);
    const missedBody = AgentSendMessageOutputSchema.parse(await missed.json());
    // Parsed through the shared output schema on purpose: the shape the daemon and
    // the CLI will read is the shape asserted here, and it carries no reason.
    expect(missedBody.unresolved_references).toEqual([
      { kind: 'agent', handle: 'nosuchagent' },
    ]);
    // The send still succeeded — the message is in the channel and bob got it.
    expect(t.fake.delivered.map(d => d.messageId)).toContain(missedBody.message_id);
  });

  it('returns a stale_event_id when a same-conversation agent send finds undelivered input', async () => {
    t = buildTestApp();
    const { conversationId, agentIds } = await setupSession(t, ['alice', 'bob']);
    // The freshness miss is an undelivered inbox row for alice: her runtime
    // still holds input it must consume (#task:2095). There is no seq pair —
    // the guard is a boolean EXISTS over her undelivered set, not a per-stream
    // CAS — so the send carries no `seen_up_to_seq`.
    enqueueUndeliveredInput(t, conversationId, agentIds.alice!);

    const r = await http(t).post(
      `/internal/agents/${agentIds.alice}/send-message`,
      { content: 'stale draft', target: `#conv:${conversationId}` },
      {
        headers: authHeaders(issueTestConversationRuntimeToken(
          t,
          conversationId,
          agentIds.alice!,
        )),
      },
    );

    expect(r.status).toBe(409);
    const body = await r.json() as any;
    expect(body.error.code).toBe('conflict');
    expect(body.error.details.subkind).toBe('message_stale');
    expect(typeof body.error.details.stale_event_id).toBe('string');
    // F6: the 409 is signal-only. `current_seq` addressed the retired
    // per-stream CAS and has no referent in the RuntimeScope model.
    expect(body.error.details.current_seq).toBeUndefined();
  });

  it('guards a NAME-FORM (#<workspace>/<title>) first send on the AGENT arm identically — the address form cannot un-guard it (验收①)', async () => {
    t = buildTestApp();
    const { conversationId, channelId: workspaceId, agentIds } =
      await setupSession(t, ['seed', 'bob']);
    // The格 the ticket exists FOR, in its ORIGINAL shape: an agent-scoped
    // runtime (session_scope='agent') sending to a READABLE address head
    // (`#<workspace>/<title>` — the token the runtime pastes verbatim from its
    // prompt). The old hole was structural AND lived in the AgentSlot path
    // specifically: that head resolved through a per-address memo that was COLD
    // on its first use each session, so the first send skipped the per-stream
    // CAS and was silently un-guarded. The RuntimeScope model has NO per-address
    // memo: it resolves the address to a stream, THEN evaluates the guard on the
    // actor's undelivered set via the AGENT arm (`hasUndeliveredForAgent`),
    // which does not look at the target at all. So the address FORM is
    // immaterial — a name-form first send must 409 exactly like a `#conv:<id>`
    // form. Without this格 the suite only proves "the new machine works", not
    // "the old class of hole cannot come back".
    const aliceId = insertAgentScopedAgent(t, agentIds.seed!, 'alice-global');
    t.persistence.repos.workspaces.insertMembership(workspaceId, aliceId);
    t.persistence.repos.conversations.addAgent(conversationId, aliceId);
    t.persistence.repos.agentCapabilities.replaceSet(
      workspaceId,
      aliceId,
      ['send_messages'],
    );
    // Undelivered input for her runtime ⇒ the agent-arm guard's EXISTS is true.
    enqueueUndeliveredInput(t, conversationId, aliceId);

    // Workspace is 'eng' (setupSession) and the onboarding channel's title is
    // the code-owned literal 'Onboarding'; the named lookup case-folds.
    const r = await http(t).post(
      internalPaths.agentSendConversationMessage(aliceId),
      { content: 'stale draft via readable address', target: '#eng/Onboarding' },
      { headers: agentSlotAuth(t, aliceId) },
    );

    // 409, not 200: proves the name-form path resolved and routed through the
    // SAME agent-arm guard. A sanity 404/target_unresolved here would mean the
    // address didn't resolve — then the test proves nothing; the assertion on
    // subkind pins that it was the freshness guard, not a resolution miss.
    expect(r.status).toBe(409);
    const body = await r.json() as any;
    expect(body.error.details.subkind).toBe('message_stale');
    expect(typeof body.error.details.stale_event_id).toBe('string');
  });

  it('rechecks participation before retrying a held stale draft and writes nothing after revocation', async () => {
    t = buildTestApp();
    const { conversationId, channelId: workspaceId, agentIds } =
      await setupSession(t, ['seed', 'bob']);
    const aliceId = insertAgentScopedAgent(t, agentIds.seed!, 'alice-global');
    t.persistence.repos.workspaces.insertMembership(workspaceId, aliceId);
    t.persistence.repos.conversations.addAgent(conversationId, aliceId);
    t.persistence.repos.agentCapabilities.replaceSet(
      workspaceId,
      aliceId,
      ['send_messages'],
    );
    const auth = agentSlotAuth(t, aliceId);
    const target = `#conv:${conversationId}`;
    const send = (body: Record<string, unknown>) => http(t!).post(
      internalPaths.agentSendConversationMessage(aliceId),
      body,
      { headers: auth },
    );

    // Alice's runtime holds undelivered input ⇒ her next send is held (409),
    // yielding an arming id she replays on the retry. No seq boundary — the
    // guard is a boolean EXISTS over her undelivered set.
    enqueueUndeliveredInput(t, conversationId, aliceId);
    const stale = await send({
      content: 'held draft',
      target,
    });
    expect(stale.status).toBe(409);
    const staleBody = await stale.json() as any;
    const staleEventId = staleBody.error.details.stale_event_id as string;
    const beforeRetry = t.persistence.repos.messages.listForConversation(
      conversationId,
      1_000,
    ).length;

    // A held event remembers freshness only. Revoking participation after the
    // 409 must make the raw target go through the resolver again; the memoized
    // conversation id is never a capability token or a direct-write path.
    t.persistence.repos.conversations.removeAgent(conversationId, aliceId);
    const retry = await send({
      content: 'held draft, revised',
      target,
      stale_event_id: staleEventId,
      stale_resolution_reason: 'revised',
    });

    expect(retry.status).toBe(404);
    expect(await retry.json()).toEqual({
      error: 'target names no stream you can use',
      code: 'target_unresolved',
    });
    expect(
      t.persistence.repos.messages.listForConversation(conversationId, 1_000),
    ).toHaveLength(beforeRetry);
  });

  it('accepts obsolete stale-resolution telemetry without sending a message', async () => {
    t = buildTestApp();
    const { conversationId, agentIds } = await setupSession(t, ['alice']);
    const r = await http(t).post(
      `/internal/agents/${agentIds.alice}/stale-message-resolution`,
      {
        conversation_id: conversationId,
        stale_event_id: 'evt-obsolete',
        resolution_reason: 'obsolete',
      },
      {
        headers: authHeaders(issueTestConversationRuntimeToken(
          t,
          conversationId,
          agentIds.alice!,
        )),
      },
    );

    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ ok: true });
  });

});

describe('POST /internal/.../create-channel', () => {
  let t: TestApp | null = null;
  afterEach(() => {
    t?.cleanup();
    t = null;
  });

  it('creates a top-level channel in the current workspace with all current members', async () => {
    t = buildTestApp();
    const { conversationId, channelId, agentIds } = await setupSession(t, ['alice', 'bob']);
    const outsider = await (
      await http(t).post('/api/agents', { name: 'mallory', runtime: 'claude' })
    ).json() as any;
    t.fake.starts = [];
    t.fake.delivered = [];
    const workspaceEvents: Array<{ kind: string; payload: any }> = [];
    const unsubscribe = t.ctx.events.subscribeScope(
      `workspace:${channelId}`,
      e => workspaceEvents.push({ kind: e.kind, payload: e.payload }),
    );

    const r = await http(t).post(
      `/internal/agents/${agentIds.alice}/create-channel`,
      {
        title: 'release signing',
        context_summary: 'user explicitly asked to split release signing out',
        initial_prompt: 'Discuss release signing separately.',
        target: `#conv:${conversationId}`,
        channel_id: 'other-channel',
        members: [outsider.agent.id],
      },
      {
        headers: authHeaders(issueTestConversationRuntimeToken(
          t,
          conversationId,
          agentIds.alice!,
        )),
      },
    );
    unsubscribe();
    expect(r.status).toBe(200);
    const body = await r.json() as any;
    expect(typeof body.channel_id).toBe('string');
    expect(Object.keys(body)).toEqual(['channel_id']);

    const created = await (
      await http(t).get(`/api/channels/${body.channel_id}`)
    ).json() as any;
    expect(created.channel.workspace_id).toBe(channelId);
    expect(created.channel.spawned_by_agent_id).toBe(agentIds.alice);
    expect(workspaceEvents).toContainEqual({
      kind: 'workspace_channels_changed',
      payload: {
        workspace_id: channelId,
        channel_id: body.channel_id,
      },
    });

    const channelAgents = await (
      await http(t).get(`/api/channels/${body.channel_id}/agents`)
    ).json() as any;
    expect(channelAgents.agents.map((a: any) => a.agent_id).sort()).toEqual([
      agentIds.alice,
      agentIds.bob,
    ].sort());
    expect(
      channelAgents.agents.map((a: any) => a.agent_id),
    ).not.toContain(outsider.agent.id);

    const msgs = await (
      await http(t).get(`/api/channels/${body.channel_id}/messages`)
    ).json() as any;
    expect(msgs.messages).toHaveLength(2);
    expect(msgs.messages[0].from_kind).toBe('system');
    expect(msgs.messages[0].content).toContain('release signing out');
    expect(msgs.messages[1].from_kind).toBe('agent');
    expect(msgs.messages[1].from_agent_id).toBe(agentIds.alice);
    expect(msgs.messages[1].content).toBe('Discuss release signing separately.');

    expect(t.fake.delivered).toEqual([
      {
        conversationId: body.channel_id,
        agentId: agentIds.alice,
        messageId: msgs.messages[0].id,
      },
      {
        conversationId: body.channel_id,
        agentId: agentIds.bob,
        messageId: msgs.messages[1].id,
      },
    ]);
    expect(t.fake.starts).toHaveLength(2);
    expect(t.fake.starts).toEqual(expect.arrayContaining([
      { conversationId: body.channel_id, agentId: agentIds.alice },
      { conversationId: body.channel_id, agentId: agentIds.bob },
    ]));
  });

  it('requires an initial_prompt', async () => {
    t = buildTestApp();
    const { conversationId, agentIds } = await setupSession(t, ['alice']);
    const r = await http(t).post(
      `/internal/agents/${agentIds.alice}/create-channel`,
      {
        title: 'missing prompt',
        context_summary: 'x',
        target: `#conv:${conversationId}`,
      },
      {
        headers: authHeaders(issueTestConversationRuntimeToken(
          t,
          conversationId,
          agentIds.alice!,
        )),
      },
    );
    expect(r.status).toBe(400);
  });

  it('returns not found for a missing actor agent', async () => {
    t = buildTestApp();
    const { conversationId } = await setupSession(t, ['alice']);
    const r = await http(t).post(
      `/internal/agents/missing-agent/create-channel`,
      {
        title: 'missing actor',
        context_summary: 'x',
        initial_prompt: 'go',
        target: `#conv:${conversationId}`,
      },
      { headers: authHeaders(t.authToken) },
    );
    expect(r.status).toBe(401);
  });
});

describe('agent send-message — content byte cap', () => {
  let t: TestApp | null = null;
  afterEach(() => {
    t?.cleanup();
    t = null;
  });

  it('rejects content over 64KiB (UTF-8 bytes) with 413 content_too_large', async () => {
    t = buildTestApp();
    const { conversationId, agentIds } = await setupSession(t);
    const token = issueTestConversationRuntimeToken(t, conversationId, agentIds.alice!);
    const r = await http(t).post(
      `/internal/agents/${agentIds.alice}/send-message`,
      { content: 'a'.repeat(64 * 1024 + 1), target: `#conv:${conversationId}` },
      { headers: authHeaders(token) },
    );
    expect(r.status).toBe(413);
    const body = await r.json() as any;
    expect(body.code).toBe('content_too_large');
    expect(body.max_bytes).toBe(64 * 1024);
  });
});

describe('agent send-message — pre-parse body bound', () => {
  let t: TestApp | null = null;
  afterEach(() => {
    t?.cleanup();
    t = null;
  });

  it('rejects an oversized declared body (explicit Content-Length) before the handler', async () => {
    t = buildTestApp();
    const { conversationId, agentIds } = await setupSession(t);
    const token = issueTestConversationRuntimeToken(t, conversationId, agentIds.alice!);
    // Build the body by hand with an explicit Content-Length so this
    // exercises the limiter's header fast-path, not the streaming
    // counter (the in-memory Request the json helper builds carries no
    // Content-Length header).
    const raw = JSON.stringify({ content: 'a'.repeat(2 * 1024 * 1024) });
    const r = await http(t).post(
      `/internal/agents/${agentIds.alice}/send-message`,
      undefined,
      {
        body: raw,
        headers: {
          ...authHeaders(token),
          'content-type': 'application/json',
          'content-length': String(Buffer.byteLength(raw)),
        },
      },
    );
    expect(r.status).toBe(413);
    const body = await r.json() as any;
    expect(body.code).toBe('content_too_large');
    expect(body.max_body_bytes).toBeDefined();
  });

  it('rejects an oversized chunked body without Content-Length before the handler', async () => {
    t = buildTestApp();
    const { conversationId, agentIds } = await setupSession(t);
    const token = issueTestConversationRuntimeToken(t, conversationId, agentIds.alice!);
    const payload = Buffer.from(
      JSON.stringify({ content: 'a'.repeat(2 * 1024 * 1024) }),
      'utf8',
    );
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let i = 0; i < payload.byteLength; i += 64 * 1024) {
          controller.enqueue(payload.subarray(i, i + 64 * 1024));
        }
        controller.close();
      },
    });
    const r = await http(t).post(
      `/internal/agents/${agentIds.alice}/send-message`,
      undefined,
      {
        body: stream,
        // duplex is required for stream request bodies in Node's fetch.
        duplex: 'half',
        headers: { ...authHeaders(token), 'content-type': 'application/json' },
      } as RequestInit,
    );
    expect(r.status).toBe(413);
    const body = await r.json() as any;
    expect(body.code).toBe('content_too_large');
  });
});

describe('agent send-message — signal-only stale contract (#task:1561)', () => {
  let t: TestApp | null = null;
  afterEach(() => {
    t?.cleanup();
    t = null;
  });

  it('the 409 carries NO bodies — only signal metadata; the guard drains only on real admission', async () => {
    t = buildTestApp();
    const { conversationId, agentIds } = await setupSession(t);
    const token = issueTestConversationRuntimeToken(t, conversationId, agentIds.alice!);
    // Alice's runtime holds one undelivered inbox row — the freshness miss.
    // Its content is distinctive so we can prove the 409 never echoes the
    // unseen message back: bodies are released exactly once, through normal
    // delivery, never through this rejection.
    enqueueUndeliveredInput(t, conversationId, agentIds.alice!, 'SECRET_UNSEEN_BODY');

    const r = await http(t).post(
      `/internal/agents/${agentIds.alice}/send-message`,
      { content: 'stale draft', target: `#conv:${conversationId}` },
      { headers: authHeaders(token) },
    );
    expect(r.status).toBe(409);
    const details = ((await r.json()) as any).error.details;
    expect(details.subkind).toBe('message_stale');
    expect(typeof details.stale_event_id).toBe('string');
    expect(typeof details.hint).toBe('string');
    // Signal only (#task:2095 F6/F13): every field of the retired per-stream
    // CAS is gone, and — deliberately — there is NO count of undelivered input
    // (the EXISTS probe makes a COUNT cheap, which is exactly why it must be
    // refused; an in-flight-inclusive count would also over-report).
    expect(details.newer_messages).toBeUndefined();
    expect(details.returned_through_seq).toBeUndefined();
    expect(details.stream_key).toBeUndefined();
    expect(details.seen_up_to_seq).toBeUndefined();
    expect(details.current_seq).toBeUndefined();
    expect(details.unseen_count).toBeUndefined();
    // The unseen body is never echoed back through the rejection.
    expect(JSON.stringify(details)).not.toContain('SECRET_UNSEEN_BODY');

    // The 409 disarms nothing: an uninformed retry — one that has NOT consumed
    // the pending input — still finds the same undelivered row and is rejected
    // again. Only real admission unlocks the guard.
    const r2 = await http(t).post(
      `/internal/agents/${agentIds.alice}/send-message`,
      { content: 'stale draft 2', target: `#conv:${conversationId}` },
      { headers: authHeaders(token) },
    );
    expect(r2.status).toBe(409);

    // Once the runtime has actually consumed its input (the analogue of a
    // completed `stale-receive`), its undelivered set is empty and the send
    // goes through — no bypass, the guard simply admits.
    drainInput(t, conversationId, agentIds.alice!);
    const r3 = await http(t).post(
      `/internal/agents/${agentIds.alice}/send-message`,
      { content: 'fresh send', target: `#conv:${conversationId}` },
      { headers: authHeaders(token) },
    );
    expect(r3.status).toBe(200);
  });
});
