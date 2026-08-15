/**
 * AgentTeardownUnitOfWork adapter tests (#task:1987 D) — the FK CASCADE
 * PERSISTENCE CONTRACT.
 *
 * `deleteAgentRow()` issues ONE `DELETE FROM agents`. Everything else the
 * teardown destroys — the agent's memberships, its capability grants, its
 * conversation participation, its pending inbox deliveries, its schedules, its
 * own `agent_home` workspace with that home's DM channel and attachment rows —
 * disappears because the SCHEMA says so, not because any code enumerates it.
 * That makes the cascade a contract of the persistence layer, and this file is
 * where it is pinned: a future PG adapter MUST re-run this suite and satisfy the
 * same row-level outcomes, or the use cases silently start leaking rows the
 * SQLite schema used to clean up.
 *
 * Two halves, and both matter:
 *  - what DIES: every table that hangs off `agents` by `ON DELETE CASCADE`,
 *    including `workspace_agent_capabilities`, which has NO direct FK to
 *    `agents` at all — it cascades TRANSITIVELY through its composite FK to
 *    `workspace_members`. A schema that kept only the direct edges would leak
 *    capability grants for an id that no longer exists.
 *  - what SURVIVES: the regular workspace, its channel, its messages, and a
 *    BYSTANDER agent's rows in exactly those places. Deleting one agent is not
 *    a workspace delete (relocation-v1 §7-4) and not a history delete: the
 *    authored message stays, `from_agent_id` goes NULL by `ON DELETE SET NULL`,
 *    and the send-time `author_id` / `author_name` snapshot (which carries no
 *    FK) keeps naming the deleted author — that snapshot is what lets clients
 *    resolve the row to `deleted` rather than `unresolved` (#task:1791).
 *
 * Every assertion reads the RAW tables. A repo read would join `agents` and
 * therefore report an orphaned `conversation_agents` row as absent — it would
 * pass whether or not the cascade fired, which is the one thing this file may
 * not do. The `foreign_keys = OFF` falsifier below proves the instrument works:
 * with enforcement off, the same delete leaves every one of those rows behind.
 */
import { fixedWorkspaceName } from '@silverhand/shared';
import { describe, expect, it } from 'vitest';
import type { Database as Db } from 'better-sqlite3';
import { AGENT_CAPABILITIES, fixedConversationTitle } from '@silverhand/shared';
import { AgentCapabilityRepo } from '../../src/repos/agent-capability-repo.js';
import { AgentRepo } from '../../src/repos/agent-repo.js';
import { AttachmentRepo } from '../../src/repos/attachment-repo.js';
import { ConversationInboxRepo } from '../../src/repos/conversation-inbox-repo.js';
import { ConversationRepo } from '../../src/repos/conversation-repo.js';
import { RuntimeSlotRepo } from '../../src/repos/runtime-slot-repo.js';
import { HostRepo } from '../../src/repos/host-repo.js';
import { MessageRepo } from '../../src/repos/message-repo.js';
import { ScheduleRepo } from '../../src/repos/schedule-repo.js';
import { WorkspaceRepo } from '../../src/repos/workspace-repo.js';
import { createSqliteAgentTeardownPersistence } from '../../src/repos/agent-teardown-persistence.js';
import { openTestDb } from '../utils/db.js';

/**
 * One agent (`subject`) fully wired into a shared regular workspace AND owning
 * its own home + DM, plus a `bystander` agent wired into the SAME workspace,
 * channel and capability set. The bystander is the scope witness: every count
 * below is asserted per agent, so a cascade that over-reaches (a `DELETE FROM
 * workspace_members WHERE workspace_id = …` shape, say) reddens instead of
 * looking like a clean teardown.
 */
function bootstrap() {
  const { db, localHostId } = openTestDb({ seedAllFixtureMemberships: false });
  const agents = new AgentRepo(db);
  const workspaces = new WorkspaceRepo(db);
  const conversations = new ConversationRepo(db);
  const capabilities = new AgentCapabilityRepo(db);
  const inboxes = new ConversationInboxRepo(db);
  const messages = new MessageRepo(db);
  const schedules = new ScheduleRepo(db);
  const attachments = new AttachmentRepo(db);

  const subject = agents.create(
    { name: 'teardown-subject', runtime: 'claude' },
    localHostId,
    'local',
  );
  const bystander = agents.create(
    { name: 'teardown-bystander', runtime: 'claude' },
    localHostId,
    'local',
  );

  // The shared regular workspace: rooted on no computer, owned by no agent, and
  // therefore outside what an agent delete may reach.
  const workspace = workspaces.insert({ name: fixedWorkspaceName('Shared'), description: null });
  const channel = conversations.insertChannel({
    workspaceId: workspace.id,
    title: fixedConversationTitle('general'),
  });
  for (const agent of [subject, bystander]) {
    workspaces.insertMembership(workspace.id, agent.id);
    capabilities.seedDefaults(workspace.id, agent.id);
    conversations.addAgent(channel.id, agent.id);
  }
  const runtimeSlots = new RuntimeSlotRepo(db);
  runtimeSlots.updateCurrentConversationProjection(channel.id, subject.id, {
    status: 'active',
  });
  runtimeSlots.claimGeneration({
    scope: {
      kind: 'conversation',
      conversationId: channel.id,
      agentId: subject.id,
    },
    daemonInstanceId: 'daemon-agent-teardown',
    status: 'active',
  });

  // History authored by the subject, with a pending delivery for it.
  const authored = messages.insertForConversation({
    conversationId: channel.id,
    fromKind: 'agent',
    fromAgentId: subject.id,
    content: 'authored before the delete',
  });
  inboxes.enqueue(channel.id, subject.id, authored.id);
  inboxes.enqueue(channel.id, bystander.id, authored.id);

  const schedule = schedules.insert({
    ownerAgentId: subject.id,
    targetConversationId: channel.id,
    title: 'standup',
    message: 'wake',
    spec: { kind: 'once', fire_at: 1 },
    nextFireAt: 1,
  });

  // The subject's OWN home: this whole subtree is the agent's, so it dies with
  // it — home workspace → DM channel → that channel's attachment rows.
  const home = workspaces.insertAgentHome({ agent: subject });
  const dm = conversations.insertDmChannel({
    workspaceId: home.id,
    title: fixedConversationTitle(subject.name),
    agentId: subject.id,
  });
  conversations.addAgent(dm.id, subject.id);
  attachments.insert({
    channelId: dm.id,
    sourceConversationId: dm.id,
    filename: 'dm-note.bin',
    size: 3,
    contentType: 'application/octet-stream',
    storage: 'local',
    storageKey: 'dm-note-key',
    createdByKind: 'user',
    createdById: 'local',
  });

  return {
    db,
    persistence: createSqliteAgentTeardownPersistence(db),
    subjectId: subject.id,
    bystanderId: bystander.id,
    hostId: localHostId,
    workspaceId: workspace.id,
    channelId: channel.id,
    homeId: home.id,
    dmChannelId: dm.id,
    messageId: authored.id,
    scheduleId: schedule.id,
  };
}

/**
 * Raw per-agent row counts for every table the schema attaches to `agents`.
 * Deliberately joins NOTHING: an orphan row must be visible as a row.
 */
function agentRowCounts(db: Db, agentId: string) {
  const count = (sql: string, param: string): number =>
    db.prepare<[string], { c: number }>(sql).get(param)!.c;
  return {
    agents: count('SELECT COUNT(*) AS c FROM agents WHERE id = ?', agentId),
    workspaceMembers: count(
      'SELECT COUNT(*) AS c FROM workspace_members WHERE agent_id = ?',
      agentId,
    ),
    capabilities: count(
      'SELECT COUNT(*) AS c FROM workspace_agent_capabilities WHERE agent_id = ?',
      agentId,
    ),
    conversationAgents: count(
      'SELECT COUNT(*) AS c FROM conversation_agents WHERE agent_id = ?',
      agentId,
    ),
    inboxes: count(
      'SELECT COUNT(*) AS c FROM conversation_inboxes WHERE agent_id = ?',
      agentId,
    ),
    schedules: count(
      'SELECT COUNT(*) AS c FROM schedules WHERE owner_agent_id = ?',
      agentId,
    ),
    ownedWorkspaces: count(
      'SELECT COUNT(*) AS c FROM workspaces WHERE owner_agent_id = ?',
      agentId,
    ),
  };
}

/** Raw existence of the objects the delete must NOT touch, plus the DM subtree
 *  it must take with the home. */
function structureCounts(t: ReturnType<typeof bootstrap>) {
  const count = (sql: string, param: string): number =>
    t.db.prepare<[string], { c: number }>(sql).get(param)!.c;
  return {
    sharedWorkspace: count(
      'SELECT COUNT(*) AS c FROM workspaces WHERE id = ?',
      t.workspaceId,
    ),
    sharedChannel: count(
      'SELECT COUNT(*) AS c FROM conversations WHERE id = ?',
      t.channelId,
    ),
    sharedMessages: count(
      'SELECT COUNT(*) AS c FROM messages WHERE conversation_id = ?',
      t.channelId,
    ),
    home: count('SELECT COUNT(*) AS c FROM workspaces WHERE id = ?', t.homeId),
    dmChannel: count(
      'SELECT COUNT(*) AS c FROM conversations WHERE id = ?',
      t.dmChannelId,
    ),
    dmAttachments: count(
      'SELECT COUNT(*) AS c FROM attachments WHERE channel_id = ?',
      t.dmChannelId,
    ),
  };
}

/** The exact production commit step, driven through the port: read eligibility,
 *  capture, delete — one `atomicallyForAgent` scope (`commitAgentTeardown` is
 *  its only production caller and adds no persistence behavior of its own). */
function deleteThroughScope(
  t: ReturnType<typeof bootstrap>,
  agentId: string,
) {
  return t.persistence.uow.atomicallyForAgent({ agentId }, tx => {
    const facts = tx.agent.readFacts();
    const capture = tx.agent.capture();
    tx.agent.deleteAgentRow();
    return { facts, capture };
  });
}

describe('AgentTeardownUnitOfWork (SQLite adapter) — FK cascade contract', () => {
  it('one DELETE FROM agents clears every dependent row the schema attaches to it', () => {
    const t = bootstrap();
    // Pre-state: the subject really owns rows in every table asserted below, so
    // the post-state zeros mean "deleted", not "never existed".
    expect(agentRowCounts(t.db, t.subjectId)).toEqual({
      agents: 1,
      workspaceMembers: 1,
      capabilities: AGENT_CAPABILITIES.length,
      conversationAgents: 2, // the shared channel + its own DM
      inboxes: 1,
      schedules: 1,
      ownedWorkspaces: 1,
    });

    deleteThroughScope(t, t.subjectId);

    expect(agentRowCounts(t.db, t.subjectId)).toEqual({
      agents: 0,
      workspaceMembers: 0,
      // NO direct FK to `agents`: this one only reaches zero through the
      // composite (workspace_id, agent_id) → workspace_members edge.
      capabilities: 0,
      conversationAgents: 0,
      inboxes: 0,
      schedules: 0,
      ownedWorkspaces: 0,
    });
  });

  it('the bystander agent keeps every row in the same tables', () => {
    const t = bootstrap();
    deleteThroughScope(t, t.subjectId);
    expect(agentRowCounts(t.db, t.bystanderId)).toEqual({
      agents: 1,
      workspaceMembers: 1,
      capabilities: AGENT_CAPABILITIES.length,
      conversationAgents: 1,
      inboxes: 1,
      schedules: 0,
      ownedWorkspaces: 0,
    });
  });

  it('the owned home subtree dies; the shared workspace, its channel and its history do not', () => {
    const t = bootstrap();
    expect(structureCounts(t)).toEqual({
      sharedWorkspace: 1,
      sharedChannel: 1,
      sharedMessages: 1,
      home: 1,
      dmChannel: 1,
      dmAttachments: 1,
    });

    deleteThroughScope(t, t.subjectId);

    expect(structureCounts(t)).toEqual({
      sharedWorkspace: 1,
      sharedChannel: 1,
      // History is NOT deleted with its author.
      sharedMessages: 1,
      home: 0,
      // The DM went with the home, and its attachment ROWS with the DM — which
      // is exactly why the blob refs must be captured inside the scope.
      dmChannel: 0,
      dmAttachments: 0,
    });
  });

  it('the authored message survives with a NULL live author and an intact send-time snapshot', () => {
    const t = bootstrap();
    deleteThroughScope(t, t.subjectId);
    const row = t.db
      .prepare<
        [string],
        {
          from_agent_id: string | null;
          author_id: string | null;
          author_name: string | null;
        }
      >(
        `SELECT from_agent_id, author_id, author_name FROM messages WHERE id = ?`,
      )
      .get(t.messageId)!;
    // ON DELETE SET NULL on the live FK, and no FK at all on the snapshot: the
    // pair is what resolves this row to `deleted` (named) instead of
    // `unresolved` (anonymous) after the author is gone (#task:1791).
    expect(row.from_agent_id).toBeNull();
    expect(row.author_id).toBe(t.subjectId);
    expect(row.author_name).toBe('teardown-subject');
  });

  /**
   * v73 (#task:2017) — the SAME production delete on an agent that is a
   * `direct_pair` endpoint. Two claims, and both are about what the schema does
   * NOT do:
   *
   *  - the DM is not reached by any cascade. It has no workspace, is not in the
   *    agent's home, and its `endpoint_*_id` columns carry NO foreign key — so
   *    the transcript outlives its participant instead of being collected with
   *    it. `foreign_key_check` stays empty afterwards, which is the assertion
   *    that the coordinate is genuinely reference-free rather than a dangling
   *    FK the pragma would report.
   *  - the delete stamps the endpoint on its way out, in the same transaction,
   *    on the correct side only, with no code enumerating anything. The ACL
   *    consequence (survivor reads, cannot post) is pinned in
   *    `tests/direct-pair-endpoint-acl.test.ts`; here the claim is narrower and
   *    is the one a future adapter must reproduce: the delete SUCCEEDS (a
   *    RESTRICT-shaped endpoint would abort it) and the row is stamped.
   */
  it('an agent that is a direct_pair endpoint: the DM survives the delete, stamped and never cascaded', () => {
    const t = bootstrap();
    const messages = new MessageRepo(t.db);
    // Same-kind endpoints are ordered by id, so the canonical-order CHECK — not
    // the test — decides which side the subject lands on.
    const [lo, hi] =
      t.subjectId < t.bystanderId
        ? [t.subjectId, t.bystanderId]
        : [t.bystanderId, t.subjectId];
    t.db
      .prepare(
        `INSERT INTO conversations
           (id, workspace_id, inbox_agent_id, placement_kind, roster_policy,
            endpoint_a_kind, endpoint_a_id, endpoint_b_kind, endpoint_b_id,
            title, status, created_at, updated_at)
         VALUES ('dp-1', NULL, NULL, 'direct_pair', 'fixed',
                 'agent', ?, 'agent', ?, 'DM', 'idle', ?, ?)`,
      )
      .run(lo, hi, 1, 1);
    const dmMessage = messages.insertForConversation({
      conversationId: 'dp-1',
      fromKind: 'agent',
      fromAgentId: t.subjectId,
      content: 'said in the DM before the delete',
    });

    deleteThroughScope(t, t.subjectId);

    const dm = t.db
      .prepare<
        [],
        {
          c: number;
          endpoint_a_deleted_at: number | null;
          endpoint_b_deleted_at: number | null;
        }
      >(
        `SELECT COUNT(*) AS c, endpoint_a_deleted_at, endpoint_b_deleted_at
           FROM conversations WHERE id = 'dp-1'`,
      )
      .get()!;
    expect(dm.c).toBe(1);
    const [subjectSide, bystanderSide] =
      t.subjectId === lo
        ? [dm.endpoint_a_deleted_at, dm.endpoint_b_deleted_at]
        : [dm.endpoint_b_deleted_at, dm.endpoint_a_deleted_at];
    expect(subjectSide).toBeGreaterThan(0);
    expect(bystanderSide).toBeNull();
    expect(
      t.db
        .prepare<[string], { c: number }>(
          `SELECT COUNT(*) AS c FROM messages WHERE id = ?`,
        )
        .get(dmMessage.id)!.c,
    ).toBe(1);
    expect(t.db.pragma('foreign_key_check')).toEqual([]);
  });

  it('the in-scope capture sees the DM blob refs and the live runtime session the post-commit phase needs', () => {
    const t = bootstrap();
    const { facts, capture } = deleteThroughScope(t, t.subjectId);
    expect(facts).toMatchObject({
      id: t.subjectId,
      hostId: t.hostId,
      materializationStatus: 'active',
    });
    // Captured from the same snapshot the delete consumes — after the commit
    // neither the DM channel nor the session row exists to re-derive them from.
    expect(capture.dmChannelId).toBe(t.dmChannelId);
    expect(capture.dmBlobRefs).toEqual([
      { storage: 'local', storageKey: 'dm-note-key' },
    ]);
    // RAW pairs, both of them: the "which of these is still running" rule is the
    // use case's (`isRunningSession`), so the adapter must not pre-filter — a
    // capture that only carried `active` rows would hide that decision from the
    // layer that owns it.
    expect([...capture.runtimeSessions].sort((a, b) =>
      (a.conversationId ?? '').localeCompare(b.conversationId ?? ''),
    )).toEqual(
      [
        {
          runtimeScope: {
            kind: 'conversation',
            conversationId: t.channelId,
            agentId: t.subjectId,
          },
          conversationId: t.channelId,
          status: 'active',
          runtimeGeneration: 1,
        },
        {
          runtimeScope: {
            kind: 'conversation',
            conversationId: t.dmChannelId,
            agentId: t.subjectId,
          },
          conversationId: t.dmChannelId,
          status: 'idle',
          runtimeGeneration: 0,
        },
      ].sort((a, b) => a.conversationId.localeCompare(b.conversationId)),
    );
    expect(capture.regularWorkspaceCount).toBe(1);
  });

  it('captures one AgentSlot by semantic scope even when no conversation roster row names the running child', () => {
    const { db, localHostId } = openTestDb({ seedAllFixtureMemberships: false });
    const agent = new AgentRepo(db).create(
      {
        name: 'agent-slot-teardown',
        runtime: 'claude',
        session_scope: 'agent',
      },
      localHostId,
      'local',
    );
    const slots = new RuntimeSlotRepo(db);
    slots.claimGeneration({
      scope: { kind: 'agent', agentId: agent.id },
      daemonInstanceId: 'daemon-agent-slot-teardown',
      status: 'active',
    });

    expect(
      createSqliteAgentTeardownPersistence(db).read.listRuntimeSessions(agent.id),
    ).toEqual([
      {
        runtimeScope: { kind: 'agent', agentId: agent.id },
        conversationId: null,
        status: 'active',
        runtimeGeneration: 1,
      },
    ]);
  });

  // The falsifier for THIS FILE: with enforcement off, the identical delete
  // leaves the whole graph orphaned. It proves the cascade — not the raw
  // COUNT(*) instrument, and not some repo-side cleanup — is what makes the
  // assertions above true, and it is the precise obligation a PG adapter
  // inherits: without the same ON DELETE CASCADE edges (direct AND composite)
  // every row below stays behind, invisible to any read that joins `agents`.
  it('falsifier: with foreign_keys OFF the same delete orphans every dependent row', () => {
    const t = bootstrap();
    t.db.pragma('foreign_keys = OFF');
    try {
      deleteThroughScope(t, t.subjectId);
    } finally {
      t.db.pragma('foreign_keys = ON');
    }
    expect(agentRowCounts(t.db, t.subjectId)).toEqual({
      agents: 0,
      workspaceMembers: 1,
      capabilities: AGENT_CAPABILITIES.length,
      conversationAgents: 2,
      inboxes: 1,
      schedules: 1,
      ownedWorkspaces: 1,
    });
    expect(structureCounts(t)).toMatchObject({
      home: 1,
      dmChannel: 1,
      dmAttachments: 1,
    });
  });
});

describe('AgentTeardownUnitOfWork (SQLite adapter) — scope mechanism', () => {
  it('both axes are root-only: a nested scope is refused instead of degrading to a lock-free savepoint', () => {
    const t = bootstrap();
    // better-sqlite3 turns `.immediate()` into a SAVEPOINT when a transaction is
    // already open — no write lock is taken, so the in-scope eligibility re-read
    // would rest on nothing. Fail loud instead.
    expect(() =>
      t.db.transaction(() =>
        t.persistence.uow.atomicallyForAgent({ agentId: t.subjectId }, () => 0),
      )(),
    ).toThrow(/root-only/);
    expect(() =>
      t.db.transaction(() =>
        t.persistence.uow.atomicallyForComputer(
          { hostId: t.hostId, userId: 'local' },
          () => 0,
        ),
      )(),
    ).toThrow(/root-only/);
    // Refused, not half-applied.
    expect(agentRowCounts(t.db, t.subjectId).agents).toBe(1);
  });

  it('the computer scope binds its faces to the key: an agent on another computer aborts the whole scope', () => {
    const t = bootstrap();
    // A second computer with its own agent, so the key names one computer and
    // the id names something on another.
    const foreign = new HostRepo(t.db).createUserInvite({ userId: 'local' });
    const outsider = new AgentRepo(t.db).create(
      { name: 'outsider', runtime: 'claude' },
      foreign.id,
      'local',
    );

    expect(() =>
      t.persistence.uow.atomicallyForComputer(
        { hostId: t.hostId, userId: 'local' },
        tx => {
          // Deleting the agent that IS on the key's computer first proves the
          // throw rolls a real write back, not just an empty scope.
          tx.computer.forAgent(t.subjectId).deleteAgentRow();
          return tx.computer.forAgent(outsider.id).deleteAgentRow();
        },
      ),
    ).toThrow(/is not on coordinated computer/);

    expect(agentRowCounts(t.db, t.subjectId).agents).toBe(1);
    expect(agentRowCounts(t.db, outsider.id).agents).toBe(1);
  });

  it('listAgentsForUpdate is scoped to the key, and reads it under the lock', () => {
    const t = bootstrap();
    const ids = t.persistence.uow.atomicallyForComputer(
      { hostId: t.hostId, userId: 'local' },
      tx => tx.computer.listAgentsForUpdate().map(agent => agent.id),
    );
    expect([...ids].sort()).toEqual([t.subjectId, t.bystanderId].sort());
  });
});
