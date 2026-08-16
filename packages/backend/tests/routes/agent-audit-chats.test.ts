/**
 * #task:2036 part ② — the owner-audit read faces:
 *   GET /api/agents/:id/chats                            (the list)
 *   GET /api/agents/:id/chats/:conversationId/messages   (the transcript)
 *
 * @shiki's ruling: the OWNER of an agent may read every conversation the agent
 * is a party to — third-party DMs included — in full and read-only. The owner
 * bears the agent's runtime and already sees the same bytes through it, so
 * hiding it in the UI protects nothing.
 *
 * Each `it` below is the falsifier for one of @Cindy's six load-bearing
 * boundaries (delete the guard and the test goes red):
 *   1. OWNER + read-only only — a non-owner is refused by the two-step
 *      anti-enum ladder (`canViewAgent` → 404, then `canAuditAgentChats` → 403).
 *   2. the owner is NOT disguised as a `direct_pair` endpoint/participant — the
 *      counterpart of a DM row is the agent's OTHER endpoint, never the reader.
 *   3. no send/react/attachment mutation — the transcript carries no
 *      viewer-scoped reactions and the read emits no event frame.
 *   4. the read advances NO endpoint unread/read cursor.
 *   5. third-party conversations do not fan into ordinary viewer scope — no
 *      `direct_pairs_changed` on the reader's own scope.
 *   6. each read leaves operator audit evidence (v1 single-host: the logger IS
 *      the audit trail).
 *
 * Plus the task-body reversals: enumeration = workspace conversations ∪
 * agent-as-endpoint direct_pairs, with the AgentInbox EXCLUDED; the
 * per-conversation gate AGREES with the list; and not-a-party / inbox /
 * non-existent conversation all collapse to ONE 403 so the transcript face is
 * no existence oracle.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  apiPaths,
  DEFAULT_SILVERHAND_LOG_LEVEL,
  encodeUserPrincipalHeader,
  fixedConversationTitle,
  fixedWorkspaceName,
  X_SILVERHAND_PRINCIPAL_HEADER,
  type AgentAuditChatListResponse,
  type AgentAuditChatSummary,
  type AgentAuditTranscriptResponse,
  type AttachmentDto,
} from '@silverhand/shared';
import { buildTestApp, http, type TestApp } from '../utils/app.js';
import { insertAgentScopedAgent } from '../utils/agent-scope.js';
import { ConversationRepo } from '../../src/repos/conversation-repo.js';
import { ConversationReadRepo } from '../../src/repos/conversation-read-repo.js';
import { createCategorizedLoggers, createLogLevelControl } from '../../src/logger.js';
import { MessageRepo } from '../../src/repos/message-repo.js';
import { MessageReactionRepo } from '../../src/repos/message-reaction-repo.js';
import { WorkspaceRepo } from '../../src/repos/workspace-repo.js';

/** The fixture's registered users (`tests/utils/db.ts`). */
const OWNER_ID = 'local'; // the default viewer — creates (and so owns) the agent
const TEAMMATE_ID = 'teammate'; // a different human; the agent's DM counterpart

interface Frame {
  scope: string;
  kind: string;
  payload: unknown;
}

/** Every frame published on EVERY scope while `run` executed — used to prove a
 *  read is inert (no `direct_pairs_changed`, no unread/reaction frame anywhere). */
async function framesDuring(t: TestApp, run: () => Promise<void>): Promise<Frame[]> {
  const frames: Frame[] = [];
  const publish = t.ctx.events.publishToScope.bind(t.ctx.events);
  const spy = vi
    .spyOn(t.ctx.events, 'publishToScope')
    .mockImplementation((scope: string, kind: string, payload: unknown) => {
      frames.push({ scope, kind, payload });
      publish(scope, kind, payload);
    });
  try {
    await run();
  } finally {
    spy.mockRestore();
  }
  return frames;
}

function asUser(userId: string): Record<string, string> {
  return { [X_SILVERHAND_PRINCIPAL_HEADER]: encodeUserPrincipalHeader(userId) };
}

/** Seed one message through the repository contract. A repo append allocates the
 *  seq and bumps the stream head, but it mints NO per-viewer unread cursor (unread
 *  is server-scored at read time) and publishes NO event frame — MessageRepo has
 *  no event bus — so the fixture stays free of the send funnel whose cursors/frames
 *  this suite asserts the ABSENCE of, without reaching past the ports into raw SQL. */
function seedMessage(
  t: TestApp,
  conversationId: string,
  from: { kind: 'agent'; id: string } | { kind: 'user'; id: string },
  content: string,
): void {
  new MessageRepo(t.ctx.db).insertForConversation({
    conversationId,
    fromKind: from.kind,
    fromAgentId: from.kind === 'agent' ? from.id : null,
    fromUserId: from.kind === 'user' ? from.id : null,
    content,
  });
}

/** Seed one real, servable attachment INTO a conversation, uploaded by the given
 *  endpoint. Goes through the production `AttachmentService.upload` so the blob is
 *  actually stored and the row's `channel_id` is the conversation — exactly the
 *  shape the owner-audit bytes face and the creator-only PATCH gate read. */
function seedAttachment(
  t: TestApp,
  conversationId: string,
  uploader: { kind: 'user' | 'agent'; id: string },
  content: string,
): Promise<AttachmentDto> {
  return t.ctx.attachmentService.upload({
    sourceConversationId: conversationId,
    filename: 'dm-secret.txt',
    contentType: 'text/plain',
    buffer: Buffer.from(content, 'utf8'),
    createdByKind: uploader.kind,
    createdById: uploader.id,
  });
}

interface Fixture {
  /** The agent the owner audits. */
  agentId: string;
  /** A workspace channel the agent is a roster member of. */
  channelId: string;
  channelTitle: string;
  workspaceId: string;
  /** A `direct_pair` between the agent and the TEAMMATE (a third party — the
   *  owner is not an endpoint of it). */
  pairId: string;
  /** The agent's own inbox — a participation the list must NOT surface. */
  inboxId: string;
  /** A workspace channel the agent is NOT in — the not-a-party 403 case. */
  outsideChannelId: string;
}

/**
 * Build the audit surface. Memberships are seeded explicitly
 * (`seedAllFixtureMemberships: false`) so the list reflects exactly the agent's
 * real participations and the 404-vs-403 ladder can be exercised — a trigger that
 * snapshots every fixture principal into every conversation would answer before
 * the code under test does.
 */
async function seedFixture(t: TestApp): Promise<Fixture> {
  // The agent under audit is an agent-scoped CLONE of an owner-created parent: it
  // inherits `created_by = OWNER_ID` (so the owner audits it) and is provisioned
  // with ONLY its AgentInbox — no `agent_home` DM/onboarding channels — so its
  // participation set is exactly what this fixture seeds below, and the list is
  // deterministic. (The parent is created solely to be cloned from.)
  const parent = await http(t).post('/api/agents', { name: 'parent', runtime: 'claude' });
  expect(parent.status).toBe(201);
  const parentId = ((await parent.json()) as { agent: { id: string } }).agent.id;
  const agentId = insertAgentScopedAgent(t, parentId, 'assistant');

  const conversations = new ConversationRepo(t.ctx.db);
  const workspaces = new WorkspaceRepo(t.ctx.db);

  const ws = workspaces.insert({ name: fixedWorkspaceName('audit-ws'), description: null });
  // Roster membership: this is what puts the channel in the agent's chats list.
  // Workspace membership: what lets a NON-owner who shares the workspace VIEW the
  // agent (the 403 rung of the ladder) without owning it.
  const channel = conversations.insertChannel({
    workspaceId: ws.id,
    title: fixedConversationTitle('audit-room'),
  });
  conversations.addAgent(channel.id, agentId);
  workspaces.insertMembership(ws.id, agentId);
  seedMessage(t, channel.id, { kind: 'agent', id: agentId }, 'channel line one');
  seedMessage(t, channel.id, { kind: 'agent', id: agentId }, 'channel line two');

  // A DM the agent has with a DIFFERENT human — the third-party transcript the
  // ruling is about. The owner is not an endpoint. Opened AFTER the channel so the
  // list's creation order is [channel, pair].
  const pair = conversations.getOrCreateDirectPair(
    { kind: 'agent', id: agentId },
    { kind: 'human', id: TEAMMATE_ID },
    Date.now() + 1_000_000,
  ).conversation;
  seedMessage(t, pair.id, { kind: 'agent', id: agentId }, 'dm from the agent');
  seedMessage(t, pair.id, { kind: 'user', id: TEAMMATE_ID }, 'dm from the teammate');

  const inbox = conversations.getAgentInbox(agentId);
  if (!inbox) throw new Error('fixture agent has no inbox');

  // A channel the agent is NOT a member of — the not-a-party case for the
  // per-conversation gate.
  const outside = conversations.insertChannel({
    workspaceId: ws.id,
    title: fixedConversationTitle('outside-room'),
  });

  return {
    agentId,
    channelId: channel.id,
    channelTitle: String(channel.title),
    workspaceId: ws.id,
    pairId: pair.id,
    inboxId: inbox.id,
    outsideChannelId: outside.id,
  };
}

async function listChats(
  t: TestApp,
  agentId: string,
  userId?: string,
): Promise<AgentAuditChatSummary[]> {
  const r = await http(t, userId === undefined ? undefined : asUser(userId)).get(
    apiPaths.agentChats(agentId),
  );
  expect(r.status).toBe(200);
  return ((await r.json()) as AgentAuditChatListResponse).chats;
}

describe('GET /api/agents/:id/chats (owner-audit list)', () => {
  let t: TestApp | null = null;
  afterEach(() => {
    t?.cleanup();
    t = null;
  });

  it('lists the agent\'s workspace channels ∪ agent-as-endpoint DMs, oldest first, inbox excluded', async () => {
    t = buildTestApp({ seedAllFixtureMemberships: false });
    const f = await seedFixture(t);

    const chats = await listChats(t, f.agentId);

    // Exactly the two seeded participations, in creation order (channel, then the
    // later-opened DM). The AgentInbox is NOT here — it is the agent's own
    // participation, excluded by the enumeration and by the per-conversation gate.
    expect(chats.map(c => c.conversation_id)).toEqual([f.channelId, f.pairId]);
    expect(chats.map(c => c.conversation_id)).not.toContain(f.inboxId);

    const channelArm = chats.find(c => c.conversation_id === f.channelId);
    expect(channelArm).toMatchObject({
      placement_kind: 'workspace',
      title: f.channelTitle,
      workspace_id: f.workspaceId,
      workspace_name: 'audit-ws',
    });

    // Boundary 2: the DM counterpart is the agent's OTHER endpoint (the teammate),
    // NEVER the reading owner — the owner is not modelled as a participant.
    const pairArm = chats.find(c => c.conversation_id === f.pairId);
    expect(pairArm).toMatchObject({
      placement_kind: 'direct_pair',
      counterpart: { status: 'active', kind: 'human', id: TEAMMATE_ID },
      read_only: false,
    });
    expect(
      pairArm && pairArm.placement_kind === 'direct_pair' && pairArm.counterpart.id,
    ).not.toBe(OWNER_ID);
  });

  it('leaves audit evidence for the owner\'s list read (boundary 6)', async () => {
    const info = vi.fn();
    t = buildTestApp({
      seedAllFixtureMemberships: false,
      logger: { info, warn() {}, error() {} },
    });
    const f = await seedFixture(t);
    info.mockClear(); // ignore any provisioning logs from seedFixture

    await listChats(t, f.agentId);

    expect(info).toHaveBeenCalledWith(
      expect.objectContaining({ user_id: OWNER_ID, agent_id: f.agentId }),
      'agent chats listed by owner (audit)',
    );
  });

  it('refuses a NON-owner who cannot even view the agent — 404 (anti-enum), boundary 1', async () => {
    t = buildTestApp({ seedAllFixtureMemberships: false });
    const f = await seedFixture(t);

    // The teammate shares no workspace with the agent, so `canViewAgent` fails and
    // the id is indistinguishable from a bogus one: 404, not 403.
    const r = await http(t, asUser(TEAMMATE_ID)).get(apiPaths.agentChats(f.agentId));
    expect(r.status).toBe(404);

    // A genuinely non-existent id is the SAME 404 — no existence oracle.
    const bogus = await http(t).get(apiPaths.agentChats('agent_does_not_exist'));
    expect(bogus.status).toBe(404);
  });

  it('refuses a viewer who CAN view the agent but does not own it — 403, boundary 1', async () => {
    t = buildTestApp({ seedAllFixtureMemberships: false });
    const f = await seedFixture(t);
    // Put the teammate in the agent's workspace: now `canViewAgent` passes (shared
    // workspace), so step 1 admits — and the NAMED audit gate is what refuses at
    // 403. Delete `canAuditAgentChats` and this teammate wrongly reads the list.
    new WorkspaceRepo(t.ctx.db).addUserMember(f.workspaceId, TEAMMATE_ID);

    const r = await http(t, asUser(TEAMMATE_ID)).get(apiPaths.agentChats(f.agentId));
    expect(r.status).toBe(403);
  });
});

describe('GET /api/agents/:id/chats/:conversationId/messages (owner-audit transcript)', () => {
  let t: TestApp | null = null;
  beforeEach(() => {
    // no-op; kept for symmetry with the list suite
  });
  afterEach(() => {
    t?.cleanup();
    t = null;
  });

  function getTranscript(
    t: TestApp,
    agentId: string,
    conversationId: string,
    userId?: string,
  ): Promise<Response> {
    return http(t, userId === undefined ? undefined : asUser(userId)).get(
      apiPaths.agentChatTranscript(agentId, conversationId),
    );
  }

  it('reads a THIRD-PARTY DM in full, read-only, without joining it (the ruling)', async () => {
    t = buildTestApp({ seedAllFixtureMemberships: false });
    const f = await seedFixture(t);

    const r = await getTranscript(t, f.agentId, f.pairId);
    expect(r.status).toBe(200);
    const body = (await r.json()) as AgentAuditTranscriptResponse;

    // Full transcript: both seeded messages, both authors server-resolved.
    expect(body.messages.map(m => m.content)).toEqual([
      'dm from the agent',
      'dm from the teammate',
    ]);
    expect(body.messages.map(m => m.author?.id)).toEqual([f.agentId, TEAMMATE_ID]);

    // Boundary 3: the response is viewer-neutral — no reaction relation is
    // enriched, and its key set is exactly the windowed transcript shape (no
    // stream-head snapshot, no per-viewer cursor).
    expect(body.messages.every(m => m.reactions === null)).toBe(true);
    expect(Object.keys(body).sort()).toEqual([
      'has_more_after',
      'has_more_before',
      'messages',
      'reply_counts_by_root',
    ]);
  });

  it('reads a workspace channel transcript the agent participates in', async () => {
    t = buildTestApp({ seedAllFixtureMemberships: false });
    const f = await seedFixture(t);

    const r = await getTranscript(t, f.agentId, f.channelId);
    expect(r.status).toBe(200);
    const body = (await r.json()) as AgentAuditTranscriptResponse;
    expect(body.messages.map(m => m.content)).toEqual([
      'channel line one',
      'channel line two',
    ]);
  });

  it('advances NO cursor and emits NO frame — the read is inert (boundaries 3, 4, 5)', async () => {
    t = buildTestApp({ seedAllFixtureMemberships: false });
    const app = t; // narrow once; a nested closure below would otherwise see TestApp | null
    const f = await seedFixture(app);
    const reads = new ConversationReadRepo(app.ctx.db);

    const teammateUnreadBefore = reads.unreadCountForConversation(f.pairId, TEAMMATE_ID);

    const frames = await framesDuring(app, async () => {
      const r = await getTranscript(app, f.agentId, f.pairId);
      expect(r.status).toBe(200);
    });

    // No event of any kind — not a list invalidation on the owner's scope, not an
    // unread bump for an endpoint.
    expect(frames).toEqual([]);
    // The counterpart's unread is exactly what it was: an audit read is not a read
    // BY an endpoint.
    expect(reads.unreadCountForConversation(f.pairId, TEAMMATE_ID)).toBe(
      teammateUnreadBefore,
    );
  });

  it('leaves audit evidence for the owner\'s transcript read (boundary 6)', async () => {
    const info = vi.fn();
    t = buildTestApp({
      seedAllFixtureMemberships: false,
      logger: { info, warn() {}, error() {} },
    });
    const f = await seedFixture(t);
    info.mockClear();

    const r = await getTranscript(t, f.agentId, f.pairId);
    expect(r.status).toBe(200);
    expect(info).toHaveBeenCalledWith(
      expect.objectContaining({
        user_id: OWNER_ID,
        agent_id: f.agentId,
        conversation_id: f.pairId,
      }),
      'agent chat transcript read by owner (audit)',
    );
  });

  it('collapses not-a-party, inbox, and non-existent into ONE 403 — no oracle', async () => {
    t = buildTestApp({ seedAllFixtureMemberships: false });
    const f = await seedFixture(t);

    // A real conversation the agent is NOT a party to.
    const notParty = await getTranscript(t, f.agentId, f.outsideChannelId);
    // The agent's OWN inbox — a participation deliberately outside the audit face.
    const inbox = await getTranscript(t, f.agentId, f.inboxId);
    // A conversation id that does not exist at all.
    const bogus = await getTranscript(t, f.agentId, 'conv_does_not_exist');

    expect([notParty.status, inbox.status, bogus.status]).toEqual([403, 403, 403]);
  });

  it('the per-conversation gate AGREES with the list: every listed chat opens, the inbox does not', async () => {
    t = buildTestApp({ seedAllFixtureMemberships: false });
    const f = await seedFixture(t);

    const chats = await listChats(t, f.agentId);
    for (const chat of chats) {
      const r = await getTranscript(t, f.agentId, chat.conversation_id);
      expect(r.status).toBe(200);
    }
    // The inbox is absent from the list AND refused by the gate — the two faces
    // draw the same boundary.
    expect(chats.map(c => c.conversation_id)).not.toContain(f.inboxId);
    expect((await getTranscript(t, f.agentId, f.inboxId)).status).toBe(403);
  });

  it('refuses a non-owner at the transcript face too — 404 anti-enum', async () => {
    t = buildTestApp({ seedAllFixtureMemberships: false });
    const f = await seedFixture(t);
    const r = await getTranscript(t, f.agentId, f.pairId, TEAMMATE_ID);
    expect(r.status).toBe(404);
  });
});

/**
 * Boundary 6, made real (B1): in the v1 single-host model the system logger IS
 * the audit trail, so "leaves audit evidence" is only true if the record SURVIVES
 * to disk at the SHIPPED default level. The default is `warn`, and an ordinary
 * `info` line is dropped there — so the three audit lines must ride a named
 * always-write category, not the info level. This drives a REAL `createFileLogger`
 * (via the production `createCategorizedLoggers` wiring, which is what registers
 * the category) at the default level, hits all three faces, and reads the file
 * back. A plain uncategorized `info` line is the negative control: it must be
 * ABSENT, proving the audit lines are durable because of their category and not
 * because the level happened to be permissive.
 */
describe('owner-audit records are durable at the default log level (boundary 6, disk)', () => {
  let t: TestApp | null = null;
  let logDir: string | null = null;
  afterEach(() => {
    t?.cleanup();
    t = null;
    if (logDir) rmSync(logDir, { recursive: true, force: true });
    logDir = null;
  });

  it('writes all three audit lines (list, transcript, attachment) to the system log at default warn', async () => {
    // The level this test asserts against IS the shipped default. If that default
    // ever changes, this assertion forces the durability argument to be re-made.
    expect(DEFAULT_SILVERHAND_LOG_LEVEL).toBe('warn');

    logDir = mkdtempSync(join(tmpdir(), 'agent-audit-log-'));
    const loggers = createCategorizedLoggers({
      dir: logDir,
      alsoConsole: false,
      logControl: createLogLevelControl(DEFAULT_SILVERHAND_LOG_LEVEL),
    });
    t = buildTestApp({ seedAllFixtureMemberships: false, logger: loggers.system });
    const f = await seedFixture(t);

    // Negative control: an ordinary info line with no audit category. At warn it
    // must NOT reach disk — so any audit line that does is there by category.
    loggers.system.info(
      { probe: 'audit-durability-negative-control' },
      'PLAIN_INFO_MUST_NOT_SURVIVE_WARN',
    );

    await listChats(t, f.agentId);
    const transcript = await http(t).get(
      apiPaths.agentChatTranscript(f.agentId, f.pairId),
    );
    expect(transcript.status).toBe(200);

    // The attachment BYTES face is the third audit record. Its category is
    // registered independently of the other two, so its durability must be
    // exercised here too — otherwise the shipped set can claim three durable
    // reads while the disk falsifier only proves two (the B1 re-review gap:
    // renaming this route's category to an unregistered name left the suite
    // green while the sole audit record was silently dropped at warn).
    const att = await seedAttachment(
      t,
      f.pairId,
      { kind: 'user', id: TEAMMATE_ID },
      'audit-durability attachment bytes',
    );
    const attachment = await http(t).get(
      apiPaths.agentChatAttachment(f.agentId, f.pairId, att.id),
    );
    expect(attachment.status).toBe(200);

    // Flush the stream before reading the file back.
    await loggers.system.close();

    const files = readdirSync(logDir).filter(name => name.startsWith('backend-'));
    expect(files.length).toBe(1);
    const contents = readFileSync(join(logDir, files[0]!), 'utf8');

    // All three audit records survived, each carrying its named category.
    expect(contents).toContain('agent chats listed by owner (audit)');
    expect(contents).toContain('"category":"agent_audit.chats_listed"');
    expect(contents).toContain('agent chat transcript read by owner (audit)');
    expect(contents).toContain('"category":"agent_audit.transcript_read"');
    expect(contents).toContain('agent chat attachment read by owner (audit)');
    expect(contents).toContain('"category":"agent_audit.attachment_read"');

    // The uncategorized info line was dropped — durability is the category's doing.
    expect(contents).not.toContain('PLAIN_INFO_MUST_NOT_SURVIVE_WARN');
  });
});

/**
 * B2 — the owner-audit attachment BYTES face
 * (`GET /api/agents/:id/chats/:conversationId/attachments/:attachmentId`). A DM
 * whose content is a file is only fully readable if the owner can fetch the blob,
 * so the audit face reads bytes read-only under a compound gate: owner(agent) ∧
 * agent participates(conversation) ∧ attachment BELONGS to that conversation. It
 * does NOT loosen the ordinary `canViewAttachment` — the plain `GET
 * /api/attachments/:id` still denies the owner a third-party DM's blob.
 */
describe('GET /api/agents/:id/chats/:conversationId/attachments/:attachmentId (owner-audit bytes)', () => {
  let t: TestApp | null = null;
  afterEach(() => {
    t?.cleanup();
    t = null;
  });

  const SECRET = 'third-party dm attachment bytes — owner audit only';

  it('owner reads a third-party DM attachment in full, while the ordinary endpoint still denies it', async () => {
    t = buildTestApp({ seedAllFixtureMemberships: false });
    const f = await seedFixture(t);
    const att = await seedAttachment(t, f.pairId, { kind: 'user', id: TEAMMATE_ID }, SECRET);

    // The audit face serves the bytes to the owner.
    const audit = await http(t).get(
      apiPaths.agentChatAttachment(f.agentId, f.pairId, att.id),
    );
    expect(audit.status).toBe(200);
    expect(await audit.text()).toBe(SECRET);

    // The ordinary, membership-scoped endpoint is UNCHANGED: the owner is not a
    // member/endpoint of this third-party DM, so it stays closed. If this ever
    // returns 200, `canViewAttachment` was loosened — exactly what B2 forbids.
    const plain = await http(t).get(apiPaths.attachment(att.id));
    expect(plain.status).toBe(404);
  });

  it('the read is inert — no frame, and it is idempotent', async () => {
    t = buildTestApp({ seedAllFixtureMemberships: false });
    const app = t;
    const f = await seedFixture(app);
    const att = await seedAttachment(app, f.pairId, { kind: 'user', id: TEAMMATE_ID }, SECRET);

    const frames = await framesDuring(app, async () => {
      const r = await http(app).get(
        apiPaths.agentChatAttachment(f.agentId, f.pairId, att.id),
      );
      expect(r.status).toBe(200);
    });
    expect(frames).toEqual([]);
  });

  it('refuses a NON-owner — 404 anti-enum, same as the other faces', async () => {
    t = buildTestApp({ seedAllFixtureMemberships: false });
    const f = await seedFixture(t);
    const att = await seedAttachment(t, f.pairId, { kind: 'user', id: TEAMMATE_ID }, SECRET);

    const r = await http(t, asUser(TEAMMATE_ID)).get(
      apiPaths.agentChatAttachment(f.agentId, f.pairId, att.id),
    );
    expect(r.status).toBe(404);
  });

  it('refuses an attachment that belongs to ANOTHER of the agent\'s chats — 404, no cross-conversation reach', async () => {
    t = buildTestApp({ seedAllFixtureMemberships: false });
    const f = await seedFixture(t);
    // The blob lives in the DM; ask for it UNDER the workspace channel (also a
    // chat the agent is a party to). The belongs-to conjunct must refuse it: the
    // face reads only the conversation it audits, not the agent's other chats.
    const att = await seedAttachment(t, f.pairId, { kind: 'user', id: TEAMMATE_ID }, SECRET);
    const r = await http(t).get(
      apiPaths.agentChatAttachment(f.agentId, f.channelId, att.id),
    );
    expect(r.status).toBe(404);
  });

  it('collapses not-a-party conversation to 403 and a bogus attachment id to 404', async () => {
    t = buildTestApp({ seedAllFixtureMemberships: false });
    const f = await seedFixture(t);
    const att = await seedAttachment(t, f.pairId, { kind: 'user', id: TEAMMATE_ID }, SECRET);

    // Conversation the agent is NOT a party to → the conversation gate refuses
    // first (403), before any attachment is resolved.
    const notParty = await http(t).get(
      apiPaths.agentChatAttachment(f.agentId, f.outsideChannelId, att.id),
    );
    expect(notParty.status).toBe(403);

    // A well-formed audit target but an attachment id that does not exist → 404,
    // the same shape as an attachment from another conversation (no oracle).
    const bogus = await http(t).get(
      apiPaths.agentChatAttachment(f.agentId, f.pairId, 'att_does_not_exist'),
    );
    expect(bogus.status).toBe(404);
  });
});

/**
 * B3 — the audit face is READ-ONLY, proven by driving real write doors, not by
 * trusting the object-addressed gates (which #task:2030 showed can silently widen
 * across streams). The owner holds no write authority over a THIRD-PARTY DM: this
 * fires three representative mutations with the owner's bearer against the DM the
 * owner is auditing, and asserts each is refused AND that the message / reaction /
 * blob fingerprints are byte-for-byte unchanged afterwards.
 */
describe('owner has NO write authority over an audited third-party DM (B3)', () => {
  let t: TestApp | null = null;
  afterEach(() => {
    t?.cleanup();
    t = null;
  });

  it('rejects message-send, reaction, and attachment-PATCH — leaving every fingerprint unchanged', async () => {
    t = buildTestApp({ seedAllFixtureMemberships: false });
    const f = await seedFixture(t);
    const messages = new MessageRepo(t.ctx.db);
    const reactions = new MessageReactionRepo(t.ctx.db);
    const att = await seedAttachment(t, f.pairId, { kind: 'user', id: TEAMMATE_ID }, 'original bytes');

    // Fingerprints BEFORE: the DM's full message list, one message's reaction
    // count, and the attachment's content revision + served bytes.
    const before = messages.listWindowForConversation(f.pairId, { limit: 100 });
    const targetMessageId = before.messages[0]!.id;
    const EMOJI = '👀';
    const reactionsBefore = reactions.countForEmoji(targetMessageId, EMOJI);

    // Door 1 — send a message into the DM as the owner. The owner is not an
    // endpoint, so `canPostToConversation` refuses at 403 before any persist.
    const send = await http(t).post(apiPaths.channelMessages(f.pairId), {
      content: 'the owner must not be able to post into a third-party DM',
    });
    expect(send.status).toBe(403);

    // Door 2 — add a reaction to a DM message as the owner. Refused (a non-party
    // cannot see or react to the message).
    const react = await http(t).post(apiPaths.messageReactions(targetMessageId), {
      emoji: EMOJI,
    });
    expect(react.status).toBeGreaterThanOrEqual(400);

    // Door 3 — PATCH the DM's attachment bytes as the owner. `canUpdateAttachment`
    // is creator-only AND membership-scoped; the owner is neither, so 403 — and the
    // gate runs before the multipart body is even parsed. This is the mutation the
    // audit read path is deliberately NOT: reading bytes is allowed, replacing
    // them is not.
    const patch = await http(t).patch(apiPaths.attachment(att.id), {});
    expect(patch.status).toBe(403);

    // Fingerprints AFTER: identical. No message appended, no reaction row, no blob
    // swap — the gates held AND nothing leaked past them.
    const after = messages.listWindowForConversation(f.pairId, { limit: 100 });
    expect(after.messages.map(m => m.id)).toEqual(before.messages.map(m => m.id));
    expect(after.messages.map(m => m.content)).toEqual(
      before.messages.map(m => m.content),
    );
    expect(reactions.countForEmoji(targetMessageId, EMOJI)).toBe(reactionsBefore);

    // The blob is byte-for-byte what the teammate uploaded — read it back through
    // the owner-audit bytes face (the read the owner IS allowed).
    const bytes = await http(t).get(
      apiPaths.agentChatAttachment(f.agentId, f.pairId, att.id),
    );
    expect(bytes.status).toBe(200);
    expect(await bytes.text()).toBe('original bytes');
  });
});
