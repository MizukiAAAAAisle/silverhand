/**
 * RemoveWorkspaceMember — the cascade is decided under the anchor, and the
 * runtime stop is compensated in both directions (#task:1982 W5).
 *
 * The route this replaced listed the workspace's conversations containing the
 * member, stopped their runtimes, and then opened a transaction that cascaded
 * over THAT LIST. Three properties make the replacement correct, and each one
 * needs a test that a list-carrying implementation would fail:
 *
 *  - ADAPTER CONTRACT: the anchor's isolation is the write lock taken at BEGIN.
 *    A second connection holding it means the callback does not run at all — the
 *    cascade never decides anything from a state it does not own.
 *  - FORWARD DRIFT: a conversation the member joins AFTER the hint is listed is
 *    still deleted, still audited, and still stopped (post-commit, over the
 *    authoritative set). Carrying the hint into the transaction would leave a
 *    member of a channel of a workspace it no longer belongs to.
 *  - REVERSE DRIFT: a conversation from the hint that somebody else already
 *    removed produces NO audit message and NO publish. The extra pre-commit stop
 *    is the cheap direction and is allowed to be wasted.
 *
 * The drift tests interpose on `listConversationsWithMember` and mutate the DB
 * as a side effect of the hint being taken. That is exactly the race: the hint
 * is a non-locking read, a concurrent add/remove commits, and only then does the
 * cascade's transaction open.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Database as Db } from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../../src/db.js';
import type { BackendLogger } from '../../src/context.js';
import type {
  AgentMemberRef,
  AgentMembershipTxPort,
  AgentMembershipTxScope,
  HumanMembershipTxScope,
  MembershipAuditMessageInput,
  MembershipConversationRef,
  MembershipCoordinationKey,
  MembershipPersistence,
  MembershipTxScope,
  WorkspaceMemberRef,
} from '../../src/application/membership-ports.js';
import type {
  ConversationMemberAddedActorSnapshot,
  ConversationMemberAddedMemberSnapshot,
} from '../../src/application/conversation-member-audit.js';
import { removeWorkspaceMember } from '../../src/application/remove-workspace-member.js';
import { createSqliteMembershipPersistence } from '../../src/repos/membership-persistence.js';
import { AgentRepo } from '../../src/repos/agent-repo.js';
import { ConversationRepo } from '../../src/repos/conversation-repo.js';
import { HostRepo } from '../../src/repos/host-repo.js';
import { MessageRepo } from '../../src/repos/message-repo.js';
import { UserRepo } from '../../src/repos/user-repo.js';
import { WorkspaceRepo } from '../../src/repos/workspace-repo.js';

const silentLogger: BackendLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
};

const OWNER_USER = 'owner-user';
const OTHER_USER = 'other-user';
/** A user who exists but is NOT a workspace member — the roster add's subject. */
const NEWCOMER = 'newcomer-user';

type Fixture = {
  db: Db;
  /** Same file, for the second connection the contention test needs. */
  dbPath: string;
  workspaceId: string;
  agentId: string;
  conversations: ConversationRepo;
  workspaces: WorkspaceRepo;
  channel: (title: string) => string;
  messageCount: (conversationId: string) => number;
};

/**
 * A file-backed DB seeded through the repos, NOT `openTestDb()`: these tests
 * need a second connection on the same database (impossible with `:memory:`)
 * and they must not have every fixture user auto-joined to every conversation
 * by the test-only seeding triggers — the cascade's input IS the membership set.
 */
function openFixtureDb(cleanups: Array<() => void>): { db: Db; dbPath: string } {
  const dir = mkdtempSync(join(tmpdir(), 'silverhand-membership-uow-test-'));
  const dbPath = join(dir, 'silverhand.db');
  const db = openDatabase(dbPath, { busyTimeoutMs: 0 });
  cleanups.push(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return { db, dbPath };
}

function seedUsers(db: Db): void {
  const users = new UserRepo(db);
  users.create({ id: OWNER_USER, name: 'owner-user', displayName: 'Owner' });
  users.create({ id: OTHER_USER, name: 'other-user', displayName: 'Other' });
}

function fixture(cleanups: Array<() => void>): Fixture {
  const { db, dbPath } = openFixtureDb(cleanups);
  seedUsers(db);
  const localHost = new HostRepo(db).ensureLocal();
  const agents = new AgentRepo(db);
  const workspaces = new WorkspaceRepo(db);
  const conversations = new ConversationRepo(db);
  const messages = new MessageRepo(db);

  const agent = agents.create({ name: 'cascade-agent', runtime: 'claude' }, localHost.id, OWNER_USER);
  const workspace = workspaces.insert({ name: 'cascade-ws', description: null });
  workspaces.insertMembership(workspace.id, agent.id);
  workspaces.addUserMember(workspace.id, OWNER_USER, 'owner');
  workspaces.setOwnerUserId(workspace.id, OWNER_USER);
  workspaces.addUserMember(workspace.id, OTHER_USER, 'member');

  return {
    db,
    dbPath,
    workspaceId: workspace.id,
    agentId: agent.id,
    conversations,
    workspaces,
    channel: title => conversations.insertChannel({ workspaceId: workspace.id, title }).id,
    messageCount: conversationId => messages.listForConversation(conversationId).length,
  };
}

const agentSnapshot = (id: string): ConversationMemberAddedMemberSnapshot => ({
  kind: 'agent',
  id,
  name: 'cascade-agent',
  displayName: 'Cascade Agent',
});
const humanSnapshot = (id: string): ConversationMemberAddedMemberSnapshot => ({
  kind: 'human',
  id,
  name: 'other-user',
  displayName: 'Other',
});
const actorSnapshot: ConversationMemberAddedActorSnapshot = {
  kind: 'user',
  id: OWNER_USER,
  name: 'owner-user',
  displayName: 'Owner',
};

/** The coordination key the adapter tests pass — the fixture's agent member. */
const keyFor = (t: Fixture): MembershipCoordinationKey<AgentMemberRef> => ({
  workspaceId: t.workspaceId,
  member: { kind: 'agent', id: t.agentId },
});

/** How many times each conversation was stopped — the pass ORDER is the
 *  adapter's list order and is not part of the contract, the multiplicity is. */
function tally(ids: readonly string[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const id of ids) counts[id] = (counts[id] ?? 0) + 1;
  return counts;
}

/** Swap in a hint read that runs `onHint` as a side effect — the concurrent
 *  add/remove landing after the non-locking list and before the transaction. */
function withDriftingHint(
  persistence: MembershipPersistence,
  onHint: () => void,
): MembershipPersistence {
  return {
    ...persistence,
    read: {
      listConversationsWithMember: (workspaceId, member) => {
        const hint = persistence.read.listConversationsWithMember(workspaceId, member);
        onHint();
        return hint;
      },
    },
  };
}

/**
 * Commit `onBeforeTx` between the use case's pre-transaction work and its
 * `BEGIN` — the general form of the race, and the only form available on the
 * human path, where no runtime stop means the hint is never even read.
 */
function withRaceBeforeTransaction(
  persistence: MembershipPersistence,
  onBeforeTx: () => void,
): MembershipPersistence {
  return {
    read: persistence.read,
    uow: {
      ...persistence.uow,
      atomically: (key, fn) => {
        onBeforeTx();
        return persistence.uow.atomically(key, fn);
      },
    },
  };
}

describe('SqliteMembershipPersistence UnitOfWork isolation', () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => {
    for (const fn of cleanups.splice(0)) fn();
  });

  it('a second connection holding the write lock means the callback never runs', () => {
    const t = fixture(cleanups);
    const contender = openDatabase(t.dbPath, { busyTimeoutMs: 0 });
    cleanups.unshift(() => contender.close());
    const persistence = createSqliteMembershipPersistence(t.db);

    contender.exec('BEGIN IMMEDIATE');
    let callbackRan = false;
    try {
      let thrown: unknown;
      try {
        persistence.uow.atomically(keyFor(t), () => {
          callbackRan = true;
        });
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toMatchObject({ code: 'SQLITE_BUSY' });
    } finally {
      contender.exec('ROLLBACK');
    }
    // The anchor read never happened, so the cascade cannot have been decided
    // from a set another writer was still changing.
    expect(callbackRan).toBe(false);
  });

  it('the immediate policy is root-only and refuses loudly when nested', () => {
    const t = fixture(cleanups);
    const persistence = createSqliteMembershipPersistence(t.db);
    // Nested `.immediate()` degrades to a SAVEPOINT and takes no write lock at
    // all — the anchor would then rest on nothing.
    t.db.transaction(() => {
      expect(() => persistence.uow.atomically(keyFor(t), () => undefined)).toThrow(/root-only/);
    })();
  });

  it('the UnitOfWork reads the anchor itself and hands it to the callback', () => {
    const t = fixture(cleanups);
    const persistence = createSqliteMembershipPersistence(t.db);
    const anchorFor = (member: WorkspaceMemberRef) =>
      persistence.uow.atomically({ workspaceId: t.workspaceId, member }, (_tx, anchor) => anchor);

    // The human governance role comes from the anchor the UoW took, not from a
    // read the caller was trusted to perform.
    expect(anchorFor({ kind: 'human', id: OWNER_USER })).toEqual({ role: 'owner' });
    expect(anchorFor({ kind: 'human', id: OTHER_USER })).toEqual({ role: 'member' });
    // An agent has no governance role; membership presence is the whole answer.
    expect(anchorFor({ kind: 'agent', id: t.agentId })).toEqual({ role: null });
    // Absent anchor row: `null`, and the callback still runs — a missing row is a
    // supported input, which is why the mechanism may not be a row lock.
    expect(anchorFor({ kind: 'human', id: 'never-a-member' })).toBeNull();
  });

  it('the in-transaction scope exposes no anchor face, and each member kind sees only its own capability set', () => {
    const t = fixture(cleanups);
    const persistence = createSqliteMembershipPersistence(t.db);
    const agentScope = persistence.uow.atomically(keyFor(t), tx => ({
      scope: Object.keys(tx).sort(),
      membership: Object.keys(tx.membership).sort(),
      authority: Object.keys(tx.authority).sort(),
    }));
    const humanScope = persistence.uow.atomically(
      { workspaceId: t.workspaceId, member: { kind: 'human', id: OTHER_USER } },
      tx => ({
        scope: Object.keys(tx).sort(),
        membership: Object.keys(tx.membership).sort(),
        authority: Object.keys(tx.authority).sort(),
      }),
    );
    // Key-set, not a type assertion: a locking read reachable from the callback
    // is exactly what let the old shape be called late, twice, or not at all —
    // and a face the other kind cannot own (capability seeding for a human, a
    // read cursor for an agent) must be absent at RUNTIME, not just in the type.
    expect(agentScope.scope).toEqual(['authority', 'membership']);
    expect(humanScope.scope).toEqual(['authority', 'membership']);
    expect(agentScope.membership).toEqual([
      'addConversationMember',
      'insertMembershipAuditMessage',
      'insertWorkspaceMembership',
      'listConversationsWithMemberForUpdate',
      'memberKind',
      'removeConversationMember',
      'removeWorkspaceMembership',
      'seedCapabilityDefaults',
    ]);
    expect(humanScope.membership).toEqual([
      'addConversationMember',
      'addWorkspaceMembership',
      'insertAttentionPreferenceIfAbsent',
      'insertMembershipAuditMessage',
      'listConversationsWithMemberForUpdate',
      'listStreamHeads',
      'markStreamRead',
      'memberKind',
      'readChannelExitFacts',
      'removeConversationMember',
      'removeWorkspaceMembership',
    ]);
    // The ACTOR-authority projection is the same two facts for both kinds — no
    // verdict face, and nothing that could answer about another workspace.
    for (const authority of [agentScope.authority, humanScope.authority]) {
      expect(authority).toEqual(['humanWorkspaceRole', 'isConversationMember']);
    }
  });

  it('the scope is bound to the coordinated key — it cannot act on another member', () => {
    const t = fixture(cleanups);
    const shared = t.channel('shared');
    t.conversations.addAgent(shared, t.agentId);
    t.conversations.addUser(shared, OTHER_USER);
    const persistence = createSqliteMembershipPersistence(t.db);

    // Coordinated on the HUMAN. The write faces take no member argument, so the
    // only thing they can remove is that human's rows.
    persistence.uow.atomically(
      { workspaceId: t.workspaceId, member: { kind: 'human', id: OTHER_USER } },
      tx => {
        expect(tx.membership.listConversationsWithMemberForUpdate()).toEqual([
          { id: shared, workspace_id: t.workspaceId },
        ]);
        tx.membership.removeConversationMember(shared);
        tx.membership.removeWorkspaceMembership();
      },
    );

    expect(t.conversations.getUser(shared, OTHER_USER)).toBeNull();
    expect(t.workspaces.isUserMember(t.workspaceId, OTHER_USER)).toBe(false);
    // The agent shares the conversation and the workspace and is untouched.
    expect(t.conversations.getAgent(shared, t.agentId)).not.toBeNull();
    expect(t.workspaces.isMember(t.workspaceId, t.agentId)).toBe(true);
  });

  /**
   * The workspace BINDING obligation the port contract puts on every face that
   * takes a `conversationId`: the coordination axis is the workspace, so a
   * conversation of another one is a write outside the mechanism this transaction
   * holds ("lock A, write B"). Not filtered, not a silent no-op — it throws, so a
   * caller that reached for another workspace cannot commit half its writes.
   */
  it('a conversation of ANOTHER workspace is refused loudly, and the transaction rolls back', () => {
    const t = fixture(cleanups);
    const mine = t.channel('mine');
    t.conversations.addAgent(mine, t.agentId);
    const foreignWs = t.workspaces.insert({ name: 'foreign-ws', description: null });
    t.workspaces.insertMembership(foreignWs.id, t.agentId);
    const foreign = t.conversations.insertChannel({
      workspaceId: foreignWs.id,
      title: 'theirs',
    }).id;
    t.conversations.addAgent(foreign, t.agentId);
    const persistence = createSqliteMembershipPersistence(t.db);

    const faces: Array<[string, (tx: AgentMembershipTxScope) => unknown]> = [
      ['addConversationMember', tx => tx.membership.addConversationMember(foreign)],
      ['removeConversationMember', tx => tx.membership.removeConversationMember(foreign)],
      [
        'insertMembershipAuditMessage',
        tx =>
          tx.membership.insertMembershipAuditMessage({
            conversationId: foreign,
            content: 'cross-workspace',
            metadata: {},
          }),
      ],
      [
        'isConversationMember',
        tx => tx.authority.isConversationMember(foreign, { kind: 'agent', id: t.agentId }),
      ],
    ];
    for (const [face, call] of faces) {
      expect(() =>
        persistence.uow.atomically(keyFor(t), tx => {
          // A legitimate write FIRST, so the refusal is proven to be a ROLLBACK and
          // not merely a report: this row must still be there afterwards.
          tx.membership.removeConversationMember(mine);
          call(tx);
        }),
      ).toThrow(new RegExp(`belongs to workspace ${foreignWs.id}`));
      expect(t.conversations.getAgent(mine, t.agentId), face).not.toBeNull();
    }
    // Nothing was written into the other workspace either.
    expect(t.conversations.getAgent(foreign, t.agentId)).not.toBeNull();
    expect(t.messageCount(foreign)).toBe(0);
  });

  it('the human-only faces carry the same workspace binding', () => {
    const t = fixture(cleanups);
    const foreignWs = t.workspaces.insert({ name: 'foreign-ws', description: null });
    const foreign = t.conversations.insertChannel({
      workspaceId: foreignWs.id,
      title: 'theirs',
    }).id;
    t.conversations.addUser(foreign, OTHER_USER);
    const persistence = createSqliteMembershipPersistence(t.db);

    const faces: Array<[string, (tx: HumanMembershipTxScope) => unknown]> = [
      [
        'insertAttentionPreferenceIfAbsent',
        tx =>
          tx.membership.insertAttentionPreferenceIfAbsent({
            conversationId: foreign,
            mode: 'mentions',
          }),
      ],
      ['listStreamHeads', tx => tx.membership.listStreamHeads(foreign)],
      [
        'markStreamRead',
        tx => tx.membership.markStreamRead({ conversationId: foreign, threadRootId: null, seq: 1 }),
      ],
      ['readChannelExitFacts', tx => tx.membership.readChannelExitFacts(foreign)],
    ];
    for (const [face, call] of faces) {
      expect(
        () =>
          persistence.uow.atomically(
            { workspaceId: t.workspaceId, member: { kind: 'human', id: OTHER_USER } },
            call,
          ),
        face,
      ).toThrow(new RegExp(`belongs to workspace ${foreignWs.id}`));
    }
    // The foreign edge — the one a leaked write would have used — is untouched.
    expect(t.conversations.getUser(foreign, OTHER_USER)).not.toBeNull();
  });

  /**
   * The ROSTER scope (#task:1987): membership writes for more than one subject in
   * ONE commit, coordinated on the workspace. Everything below is the same
   * obligation set the per-principal scope carries, re-asserted for the second
   * axis — a scope that shares the mechanism but not the checks would be a hole.
   */
  it('the roster scope exposes exactly two faces, no anchor and no per-member capability', () => {
    const t = fixture(cleanups);
    const persistence = createSqliteMembershipPersistence(t.db);
    const observed = persistence.uow.atomicallyForWorkspace(
      t.workspaceId,
      (tx, ...rest) => ({
        scope: Object.keys(tx).sort(),
        roster: Object.keys(tx.roster).sort(),
        // No anchor is handed out, and that is structural: this axis names no
        // single member, so there is no membership row to have read.
        extraArgs: rest.length,
      }),
    );
    expect(observed.scope).toEqual(['roster']);
    expect(observed.roster).toEqual(['addConversationMember', 'addWorkspaceHumanMembership']);
    expect(observed.extraArgs).toBe(0);
  });

  it('the roster transaction is root-only, like every other membership boundary', () => {
    const t = fixture(cleanups);
    const persistence = createSqliteMembershipPersistence(t.db);
    t.db.transaction(() => {
      expect(() =>
        persistence.uow.atomicallyForWorkspace(t.workspaceId, () => undefined),
      ).toThrow(/root-only/);
    })();
  });

  it('the roster faces decide `created` under the lock, for either member kind', () => {
    const t = fixture(cleanups);
    const channelId = t.channel('roster');
    const persistence = createSqliteMembershipPersistence(t.db);
    const place = () =>
      persistence.uow.atomicallyForWorkspace(t.workspaceId, tx => [
        tx.roster.addConversationMember(channelId, { kind: 'agent', id: t.agentId }),
        tx.roster.addConversationMember(channelId, { kind: 'human', id: OTHER_USER }),
      ]);
    expect(place()).toEqual([{ created: true }, { created: true }]);
    // Idempotent, and the SECOND pass says so — which is what keeps the caller's
    // exactly-once fan-out from firing twice.
    expect(place()).toEqual([{ created: false }, { created: false }]);
    expect(t.conversations.getAgent(channelId, t.agentId)).not.toBeNull();
    expect(t.conversations.getUser(channelId, OTHER_USER)).not.toBeNull();
  });

  it('the roster workspace-membership face grants plain `member` and never demotes', () => {
    const t = fixture(cleanups);
    const persistence = createSqliteMembershipPersistence(t.db);
    // A real user row: `workspace_users.user_id` is a foreign key, so an invented
    // id would fail the insert rather than exercise the role default.
    new UserRepo(t.db).create({ id: NEWCOMER, name: 'newcomer', displayName: 'New' });
    persistence.uow.atomicallyForWorkspace(t.workspaceId, tx => {
      tx.roster.addWorkspaceHumanMembership(NEWCOMER);
      // The owner is already a member at a HIGHER role; re-running must not
      // rewrite it (INSERT OR IGNORE, not upsert).
      tx.roster.addWorkspaceHumanMembership(OWNER_USER);
    });
    expect(t.workspaces.getUserRole(t.workspaceId, NEWCOMER)).toBe('member');
    expect(t.workspaces.getUserRole(t.workspaceId, OWNER_USER)).toBe('owner');
  });

  it('the roster face carries the SAME workspace binding, and the whole transaction rolls back', () => {
    const t = fixture(cleanups);
    const mine = t.channel('mine');
    const foreignWs = t.workspaces.insert({ name: 'foreign-ws', description: null });
    const foreign = t.conversations.insertChannel({
      workspaceId: foreignWs.id,
      title: 'theirs',
    }).id;
    new UserRepo(t.db).create({ id: NEWCOMER, name: 'newcomer', displayName: 'New' });
    const persistence = createSqliteMembershipPersistence(t.db);

    expect(() =>
      persistence.uow.atomicallyForWorkspace(t.workspaceId, tx => {
        // A LEGITIMATE write first: the refusal below has to undo this, or the
        // "lock A, write B" refusal would be a report rather than a rollback.
        tx.roster.addConversationMember(mine, { kind: 'agent', id: t.agentId });
        tx.roster.addWorkspaceHumanMembership(NEWCOMER);
        tx.roster.addConversationMember(foreign, { kind: 'human', id: OTHER_USER });
      }),
    ).toThrow(new RegExp(`belongs to workspace ${foreignWs.id}`));
    expect(t.conversations.getAgent(mine, t.agentId)).toBeNull();
    expect(t.workspaces.getUserRole(t.workspaceId, NEWCOMER)).toBeNull();
    expect(t.conversations.getUser(foreign, OTHER_USER)).toBeNull();
  });

  it('the hint projects only id + workspace_id — no conversation read model reaches the domain (R4)', () => {
    const t = fixture(cleanups);
    const channelId = t.channel('projected');
    t.conversations.addAgent(channelId, t.agentId);
    const persistence = createSqliteMembershipPersistence(t.db);

    expect(
      persistence.read.listConversationsWithMember(t.workspaceId, {
        kind: 'agent',
        id: t.agentId,
      }),
    ).toEqual([{ id: channelId, workspace_id: t.workspaceId }]);
  });
});

describe('removeWorkspaceMember drift compensation', () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => {
    for (const fn of cleanups.splice(0)) fn();
  });

  it('FORWARD drift: a conversation joined after the hint is still removed, audited and stopped', async () => {
    const t = fixture(cleanups);
    const hinted = t.channel('hinted');
    const joinedLate = t.channel('joined-late');
    t.conversations.addAgent(hinted, t.agentId);

    const stops: string[] = [];
    const persistence = withDriftingHint(createSqliteMembershipPersistence(t.db), () => {
      // The concurrent add: it commits after the hint was listed, so the hint
      // names `hinted` only.
      t.conversations.addAgent(joinedLate, t.agentId);
    });

    const result = await removeWorkspaceMember(
      {
        persistence,
        stopRuntime: async conversationId => {
          stops.push(conversationId);
        },
        logger: silentLogger,
      },
      {
        workspaceId: t.workspaceId,
        actor: actorSnapshot,
        member: agentSnapshot(t.agentId),
      },
    );

    expect(result.kind).toBe('removed');
    if (result.kind !== 'removed') return;
    // The authoritative set is the recompute, not the hint: both conversations
    // are audited and reported to the publish plan.
    expect(result.removed.map(entry => entry.conversation.id).sort()).toEqual(
      [hinted, joinedLate].sort(),
    );
    expect(t.messageCount(hinted)).toBe(1);
    expect(t.messageCount(joinedLate)).toBe(1);
    // No orphans: neither the conversation rows nor the workspace row survive.
    expect(t.conversations.getAgent(hinted, t.agentId)).toBeNull();
    expect(t.conversations.getAgent(joinedLate, t.agentId)).toBeNull();
    expect(t.workspaces.isMember(t.workspaceId, t.agentId)).toBe(false);
    // Pre-commit pass saw the hint; the post-commit pass covers the whole
    // authoritative set, so the late conversation IS stopped. `stop` is
    // idempotent, which is what makes the repeated one harmless.
    expect(tally(stops)).toEqual({ [hinted]: 2, [joinedLate]: 1 });
  });

  it('REVERSE drift: a conversation removed by somebody else gets no audit and no publish', async () => {
    const t = fixture(cleanups);
    const kept = t.channel('kept');
    const removedByOther = t.channel('removed-by-other');
    t.conversations.addAgent(kept, t.agentId);
    t.conversations.addAgent(removedByOther, t.agentId);

    const stops: string[] = [];
    const persistence = withDriftingHint(createSqliteMembershipPersistence(t.db), () => {
      // Somebody else's removal commits between the hint and the transaction.
      t.conversations.removeAgent(removedByOther, t.agentId);
    });

    const result = await removeWorkspaceMember(
      {
        persistence,
        stopRuntime: async conversationId => {
          stops.push(conversationId);
        },
        logger: silentLogger,
      },
      {
        workspaceId: t.workspaceId,
        actor: actorSnapshot,
        member: agentSnapshot(t.agentId),
      },
    );

    expect(result.kind).toBe('removed');
    if (result.kind !== 'removed') return;
    expect(result.removed.map(entry => entry.conversation.id)).toEqual([kept]);
    // The load-bearing half: no phantom audit message and no publish for a
    // membership this request did not remove.
    expect(t.messageCount(removedByOther)).toBe(0);
    expect(t.messageCount(kept)).toBe(1);
    // The wasted pre-commit stop is allowed; the post-commit pass only covers
    // the authoritative set, so the drifted-away conversation is stopped once
    // (from the hint) and never again.
    expect(tally(stops)).toEqual({ [kept]: 2, [removedByOther]: 1 });
  });

  it('a stop failure does not fail the removal — the durable answer is the commit', async () => {
    const t = fixture(cleanups);
    const channelId = t.channel('unreachable-runtime');
    t.conversations.addAgent(channelId, t.agentId);

    const result = await removeWorkspaceMember(
      {
        persistence: createSqliteMembershipPersistence(t.db),
        stopRuntime: async () => {
          throw new Error('daemon unreachable');
        },
        logger: silentLogger,
      },
      {
        workspaceId: t.workspaceId,
        actor: actorSnapshot,
        member: agentSnapshot(t.agentId),
      },
    );

    expect(result.kind).toBe('removed');
    expect(t.conversations.getAgent(channelId, t.agentId)).toBeNull();
    expect(t.workspaces.isMember(t.workspaceId, t.agentId)).toBe(false);
  });

  it('a human removal runs the same cascade with no runtime stop at all', async () => {
    const t = fixture(cleanups);
    const channelId = t.channel('human-member');
    t.conversations.addUser(channelId, OTHER_USER);

    const stops: string[] = [];
    const result = await removeWorkspaceMember(
      {
        persistence: createSqliteMembershipPersistence(t.db),
        // A human runs no process; passing a stop here proves the use case
        // refuses to call it for a non-agent member rather than relying on the
        // caller to omit it.
        stopRuntime: async conversationId => {
          stops.push(conversationId);
        },
        logger: silentLogger,
      },
      {
        workspaceId: t.workspaceId,
        actor: actorSnapshot,
        member: humanSnapshot(OTHER_USER),
      },
    );

    expect(result.kind).toBe('removed');
    expect(stops).toEqual([]);
    expect(t.conversations.getUser(channelId, OTHER_USER)).toBeNull();
    expect(t.workspaces.isUserMember(t.workspaceId, OTHER_USER)).toBe(false);
  });

  it('dangling conversation rows are cleaned even with no workspace-membership row — the anchor is a coordination point, not a precondition', async () => {
    const t = fixture(cleanups);
    const channelId = t.channel('dangling');
    t.conversations.addAgent(channelId, t.agentId);
    // The exact state this cleanup exists for: a conversation membership whose
    // workspace membership is already gone.
    t.workspaces.removeMember(t.workspaceId, t.agentId);

    const result = await removeWorkspaceMember(
      { persistence: createSqliteMembershipPersistence(t.db), logger: silentLogger },
      {
        workspaceId: t.workspaceId,
        actor: actorSnapshot,
        member: agentSnapshot(t.agentId),
      },
    );

    expect(result.kind).toBe('removed');
    expect(t.conversations.getAgent(channelId, t.agentId)).toBeNull();
    expect(t.messageCount(channelId)).toBe(1);
  });

  it('the OWNER refusal is read from the anchor: a promotion racing the request still writes nothing', async () => {
    const t = fixture(cleanups);
    const channelId = t.channel('owner-race');
    t.conversations.addUser(channelId, OTHER_USER);
    const persistence = withRaceBeforeTransaction(
      createSqliteMembershipPersistence(t.db),
      () => {
        // The route's own pre-check saw `member`; this promotion commits before
        // the transaction opens. Deciding from that snapshot would remove an
        // owner. `setUserRole` refuses `owner` (transfer is unsupported), so the
        // promotion goes through the repo path that grants it.
        t.workspaces.setOwnerUserId(t.workspaceId, OTHER_USER);
      },
    );

    const result = await removeWorkspaceMember(
      { persistence, logger: silentLogger },
      {
        workspaceId: t.workspaceId,
        actor: actorSnapshot,
        member: humanSnapshot(OTHER_USER),
      },
    );

    expect(result).toEqual({ kind: 'ownerRemovalUnsupported' });
    expect(t.conversations.getUser(channelId, OTHER_USER)).not.toBeNull();
    expect(t.workspaces.isUserMember(t.workspaceId, OTHER_USER)).toBe(true);
    expect(t.messageCount(channelId)).toBe(0);
  });

  it('a failing audit insert rolls the whole cascade back — the removal is one commit', async () => {
    const t = fixture(cleanups);
    const first = t.channel('first');
    const second = t.channel('second');
    t.conversations.addAgent(first, t.agentId);
    t.conversations.addAgent(second, t.agentId);
    const persistence = createSqliteMembershipPersistence(t.db);
    const failing: MembershipPersistence = {
      read: persistence.read,
      uow: {
        ...persistence.uow,
        atomically: (key, fn) =>
          persistence.uow.atomically(key, (tx, anchor) => {
            let inserts = 0;
            const membership = {
              ...tx.membership,
              insertMembershipAuditMessage: (input: MembershipAuditMessageInput) => {
                if (++inserts === 2) throw new Error('audit insert failed');
                return tx.membership.insertMembershipAuditMessage(input);
              },
            };
            // The one cast a test double owes: it decorates the scope the real
            // adapter built for this key, so its kind is whatever that key's is.
            return fn({ membership } as MembershipTxScope as never, anchor);
          }),
      },
    };

    await expect(
      removeWorkspaceMember(
        { persistence: failing, logger: silentLogger },
        {
          workspaceId: t.workspaceId,
          actor: actorSnapshot,
          member: agentSnapshot(t.agentId),
        },
      ),
    ).rejects.toThrow(/audit insert failed/);

    // Nothing partial survives: not the first conversation's delete, not its
    // audit message, not the workspace row.
    expect(t.conversations.getAgent(first, t.agentId)).not.toBeNull();
    expect(t.conversations.getAgent(second, t.agentId)).not.toBeNull();
    expect(t.workspaces.isMember(t.workspaceId, t.agentId)).toBe(true);
    expect(t.messageCount(first)).toBe(0);
    expect(t.messageCount(second)).toBe(0);
  });
});

describe('removeWorkspaceMember scope usage', () => {
  it('every persistence touch inside the transaction comes from the scope (R1)', async () => {
    // A synthetic scope: it answers the recompute and records the writes in
    // order. No DB, so anything the use case reached for outside the scope
    // would have to be a repo it does not hold.
    const calls: string[] = [];
    const targets: MembershipConversationRef[] = [
      { id: 'conv-a', workspace_id: 'ws-1' },
      { id: 'conv-b', workspace_id: 'ws-1' },
    ];
    const member: AgentMemberRef = { kind: 'agent', id: 'agent-1' };
    // Typed as the FULL agent scope: the add-side faces are present and record
    // themselves, so "the cascade never adds a row or seeds a capability" is a
    // recorded fact rather than an absence in the type.
    const membership: AgentMembershipTxPort = {
      memberKind: 'agent',
      listConversationsWithMemberForUpdate: () => {
        calls.push('recompute');
        return targets;
      },
      addConversationMember: conversationId => {
        calls.push(`addConv:${conversationId}`);
        return { created: true };
      },
      removeConversationMember: conversationId => {
        calls.push(`removeConv:${conversationId}`);
        return { removed: true };
      },
      insertMembershipAuditMessage: input => {
        calls.push(`audit:${input.conversationId}`);
        return { id: `msg-${input.conversationId}` } as never;
      },
      removeWorkspaceMembership: () => calls.push('removeWorkspace'),
      insertWorkspaceMembership: () => {
        calls.push('insertWorkspace');
        return { created: true } as never;
      },
      seedCapabilityDefaults: () => calls.push('seedCapabilities'),
    };
    /** The UnitOfWork's own obligations, in the order the port contract fixes
     *  them: coordinate on the key, read the anchor, THEN run the callback. */
    const keys: MembershipCoordinationKey[] = [];

    const result = await removeWorkspaceMember(
      {
        persistence: {
          read: {
            listConversationsWithMember: () => {
              calls.push('hint');
              return [];
            },
          },
          uow: {
            // This path never opens a roster transaction; a call would be the
            // test's own bug, so it fails loudly instead of silently passing.
            atomicallyForWorkspace: () => {
              throw new Error('unexpected roster transaction');
            },
            atomically: (key, fn) => {
              keys.push(key);
              calls.push('anchor');
              // Same test-double cast as above: this synthetic scope is the agent
              // one, and the command below coordinates on an agent.
              return fn({ membership } as never, { role: null });
            },
          },
        },
        stopRuntime: async () => {
          calls.push('stop');
        },
        logger: silentLogger,
      },
      {
        workspaceId: 'ws-1',
        actor: actorSnapshot,
        member: agentSnapshot(member.id),
      },
    );

    expect(result.kind).toBe('removed');
    // The cascade coordinates on exactly the commanded (workspace, member) — it
    // has no way to name another one, so this is the whole coordination input.
    expect(keys).toEqual([{ workspaceId: 'ws-1', member }]);
    // The anchor precedes the scope's first statement, and the workspace row is
    // deleted last — after every conversation row it owns.
    expect(calls).toEqual([
      'hint',
      'anchor',
      'recompute',
      'removeConv:conv-a',
      'audit:conv-a',
      'removeConv:conv-b',
      'audit:conv-b',
      'removeWorkspace',
      'stop',
      'stop',
    ]);
  });
});
