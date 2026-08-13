/**
 * Adapter-level contract tests for the conversation-side persistence
 * composition (#task:1981). Two obligations that only a test at this level can
 * state:
 *
 *  - `ChannelTxChannelsPort.getChannelLikeForUpdate` declares that the value it
 *    reads cannot change before the transaction commits. On SQLite that is TRUE
 *    only because the channel UnitOfWork takes the write lock at BEGIN
 *    (`BEGIN IMMEDIATE`). "There is usually only one writer" is not a
 *    mechanism, so the mechanism gets a second connection pointed at it. The
 *    message UnitOfWork's deliberately-deferred policy is pinned in the same
 *    place, so flipping either one reddens.
 *  - `PrincipalNameSnapshot` is a RUNTIME projection, not a type-level
 *    narrowing: `UserRow` is a structural supertype, so a bare return would
 *    type-check while still shipping `email` / `avatar_storage_key` /
 *    `last_seen_at` into the application (R4).
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Database as Db } from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../../src/db.js';
import { AgentRepo } from '../../src/repos/agent-repo.js';
import { ConversationRepo } from '../../src/repos/conversation-repo.js';
import { createSqliteConversationPersistence } from '../../src/repos/conversation-persistence.js';
import { MessageRepo } from '../../src/repos/message-repo.js';
import { UserRepo } from '../../src/repos/user-repo.js';
import { WorkspaceRepo } from '../../src/repos/workspace-repo.js';
import type { WorkspaceChannelTxScope } from '../../src/services/channel/ports.js';
import { openTestDb } from '../utils/db.js';

describe('SqliteConversationPersistence UnitOfWork policies', () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => {
    for (const fn of cleanups.splice(0)) fn();
  });

  /** Two connections on ONE file-backed DB. `:memory:` cannot express this test
   *  at all — a second connection can never join an in-memory database. Both
   *  sides use `busyTimeoutMs: 0` so contention surfaces as an immediate
   *  `SQLITE_BUSY` instead of a five-second stall. */
  function fileBackedChannel(): { writer: Db; contender: Db; channelId: string } {
    const dir = mkdtempSync(join(tmpdir(), 'silverhand-conv-uow-test-'));
    const dbPath = join(dir, 'silverhand.db');
    const writer = openDatabase(dbPath, { busyTimeoutMs: 0 });
    const contender = openDatabase(dbPath, { busyTimeoutMs: 0 });
    cleanups.push(() => {
      writer.close();
      contender.close();
      rmSync(dir, { recursive: true, force: true });
    });
    const workspace = new WorkspaceRepo(writer).insert({
      name: 'uow-contract',
      description: null,
    });
    const channel = new ConversationRepo(writer).insertChannel({
      workspaceId: workspace.id,
      title: 'before',
    });
    return { writer, contender, channelId: channel.id };
  }

  it('channel UoW: a rival writer cannot touch the channel while the callback runs, and the authoritative read does not drift', () => {
    const { writer, contender, channelId } = fileBackedChannel();
    const persistence = createSqliteConversationPersistence(writer);
    const steal = contender.prepare(
      `UPDATE conversations SET title = 'stolen' WHERE id = ?`,
    );

    let rivalError: unknown;
    const observed = persistence.channel.uow.atomicallyForChannel(channelId, tx => {
      const first = tx.channels.getChannelLikeForUpdate();
      try {
        steal.run(channelId);
      } catch (err) {
        rivalError = err;
      }
      const second = tx.channels.getChannelLikeForUpdate();
      return { first: first?.title, second: second?.title };
    });

    // The load-bearing assertion: the rival was LOCKED OUT, not merely
    // invisible. Under a deferred BEGIN the callback's first statement is a
    // read, the write lock is not held yet, and this write would succeed.
    expect(rivalError).toMatchObject({ code: 'SQLITE_BUSY' });
    expect(observed).toEqual({ first: 'before', second: 'before' });
    expect(new ConversationRepo(writer).getChannelLike(channelId)?.title).toBe(
      'before',
    );
  });

  it('channel UoW: the write lock is taken at BEGIN — contention surfaces before the callback runs a step', () => {
    const { writer, contender, channelId } = fileBackedChannel();
    const persistence = createSqliteConversationPersistence(writer);

    contender.exec('BEGIN IMMEDIATE');
    let callbackRan = false;
    try {
      let thrown: unknown;
      try {
        persistence.channel.uow.atomicallyForChannel(channelId, () => {
          callbackRan = true;
        });
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toMatchObject({ code: 'SQLITE_BUSY' });
    } finally {
      contender.exec('ROLLBACK');
    }
    expect(callbackRan).toBe(false);
  });

  it('channel UoW: immediate policy is root-only and refuses loudly when nested', () => {
    const { db } = openTestDb();
    cleanups.push(() => db.close());
    const persistence = createSqliteConversationPersistence(db);

    db.transaction(() => {
      expect(() =>
        persistence.channel.uow.atomicallyForChannel('any-channel', () => undefined),
      ).toThrow(/root-only/);
    })();
  });

  /**
   * The conversation-keyed axis is KEYED (#task:1987, Cindy `WzFlaHtF_3-4Jdvx`):
   * a plain `atomically(fn)` whose faces still took arbitrary ids was not one, and
   * the adapter could not have bound anything or derived a lock from a key it was
   * never given. With the key at the entry point, "lock channel A, write channel
   * B" needs no runtime refusal — there is no parameter left to say B with.
   */
  it('the conversation-keyed axis can only reach its KEY — no face names a conversation', () => {
    const { db } = openTestDb();
    cleanups.push(() => db.close());
    const conversations = new ConversationRepo(db);
    const workspace = new WorkspaceRepo(db).insert({
      name: 'keyed-axis',
      description: null,
    });
    const a = conversations.insertChannel({ workspaceId: workspace.id, title: 'A' });
    const b = conversations.insertChannel({ workspaceId: workspace.id, title: 'B' });
    const persistence = createSqliteConversationPersistence(db);

    const shape = persistence.channel.uow.atomicallyForChannel(a.id, tx => {
      tx.channels.updateTitle('A renamed');
      tx.messages.insert({ fromKind: 'system', content: 'audit' });
      // The port has no `conversationId`, so this is unreachable through the type
      // — the cast asks the ADAPTER whether the key WINS or is merely a default.
      // `{...args, conversationId: channelId}` (key last) is what makes it win, so
      // this pins the spread order, not just the port shape.
      (tx.messages.insert as (args: unknown) => unknown)({
        fromKind: 'system',
        content: 'smuggled',
        conversationId: b.id,
      });
      return {
        // The key set is the contract: an id-taking face would show up as extra
        // arity, and `getChannelLikeForUpdate` reads the key with no argument.
        arities: {
          updateTitle: tx.channels.updateTitle.length,
          getChannelLikeForUpdate: tx.channels.getChannelLikeForUpdate.length,
          insert: tx.messages.insert.length,
        },
        read: tx.channels.getChannelLikeForUpdate()?.id,
      };
    });

    expect(shape).toEqual({
      arities: { updateTitle: 1, getChannelLikeForUpdate: 0, insert: 1 },
      read: a.id,
    });
    expect(conversations.get(a.id)?.title).toBe('A renamed');
    expect(new MessageRepo(db).listForConversation(a.id)).toHaveLength(2);
    // B is not merely un-refused — it was unaddressable, even by a caller that
    // smuggled its id into the message args.
    expect(conversations.get(b.id)?.title).toBe('B');
    expect(new MessageRepo(db).listForConversation(b.id)).toHaveLength(0);
  });

  it('message UoW: the current SQLite policy stays deferred — a read prelude does not fight for the write lock', () => {
    const { writer, contender, channelId } = fileBackedChannel();
    const persistence = createSqliteConversationPersistence(writer);

    contender.exec('BEGIN IMMEDIATE');
    try {
      // Pins the POLICY (deferred lock window), not a race-freedom claim: this
      // domain's one mechanised race is the stream head via the freshness CAS;
      // its other pre-write reads carry no declared cross-connection isolation
      // obligation. See the `MessageUnitOfWork` port doc.
      const head = persistence.message.uow.atomically(tx =>
        tx.messages.streamHeadLatestSeq(channelId, null),
      );
      expect(head).toBe(0);
    } finally {
      contender.exec('ROLLBACK');
    }
  });
});

/**
 * The workspace-keyed second axis (#task:1987). Channel creation writes the
 * channel row, one membership row per founding member and the seed messages, and
 * every one of those rows belongs to ONE workspace — so the coordination axis is
 * the workspace and it is an ARGUMENT of the entry point. Three obligations only
 * an adapter-level test can state:
 *
 *  - the two axes are ONE mechanism (the port doc's requirement): the second one
 *    takes the same root-only `BEGIN IMMEDIATE`, so a rename cannot interleave
 *    with the creation whose title it would read;
 *  - every face taking a `conversationId` is BOUND to the coordinated workspace,
 *    and the refusal rolls the whole transaction back rather than reporting;
 *  - the capability sets are disjoint, so neither scope can perform the other's
 *    writes — the reason for a second axis instead of one wider port.
 */
describe('SqliteConversationPersistence workspace-keyed channel axis (#task:1987)', () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => {
    for (const fn of cleanups.splice(0)) fn();
  });

  /** One in-memory DB with the founding-member subjects a creation transaction
   *  needs: `conversation_agents` / `conversation_users` are foreign-keyed, so an
   *  invented id would fail the INSERT instead of exercising the binding. */
  function fixture() {
    const { db, localHostId } = openTestDb();
    cleanups.push(() => db.close());
    const workspaces = new WorkspaceRepo(db);
    const conversations = new ConversationRepo(db);
    const mine = workspaces.insert({ name: 'coordinated-ws', description: null });
    const other = workspaces.insert({ name: 'another-ws', description: null });
    const foreignChannel = conversations.insertChannel({
      workspaceId: other.id,
      title: 'theirs',
    }).id;
    const agent = new AgentRepo(db).create(
      { name: 'founder', runtime: 'claude' },
      localHostId,
      'local',
    );
    const user = new UserRepo(db).create({
      id: 'founder-user',
      name: 'founder-user',
      displayName: 'Founder',
    });
    return {
      db,
      conversations,
      workspaces,
      persistence: createSqliteConversationPersistence(db),
      mine: mine.id,
      other: other.id,
      foreignChannel,
      agentId: agent.id,
      userId: user.id,
    };
  }

  it('the two axes carry DISJOINT capability sets — neither can perform the other\'s writes', () => {
    const t = fixture();
    // Read from inside each transaction: the workspace-keyed scope is built PER
    // TRANSACTION because it closes over the key, so its shape only exists here.
    const rename = t.persistence.channel.uow.atomicallyForChannel(t.foreignChannel, tx => ({
      scope: Object.keys(tx).sort(),
      channels: Object.keys(tx.channels).sort(),
    }));
    const create = t.persistence.channel.uow.atomicallyInWorkspace(t.mine, tx => ({
      scope: Object.keys(tx).sort(),
      channels: Object.keys(tx.channels).sort(),
    }));

    // The rename scope structurally cannot place a member or create a channel…
    expect(rename).toEqual({
      scope: ['channels', 'messages'],
      channels: ['getChannelLikeForUpdate', 'updateTitle'],
    });
    // …and the creation scope carries no title write and no locking read, so it
    // cannot be used to perform a rename either. A wider single port would have
    // handed every caller both.
    expect(create).toEqual({
      scope: ['agents', 'channels', 'messages', 'workspace'],
      channels: [
        'addAgent',
        'addUser',
        'get',
        'getAgent',
        'insertChannel',
        'insertDmChannel',
        'listUsers',
      ],
    });
  });

  /** The in-lock fact projection (P1-1). Keyed like every other face on this
   *  axis: it cannot be asked about a workspace this transaction does not
   *  coordinate, so a callback cannot re-derive eligibility against the wrong
   *  roster. The field set is PINNED (Cindy `m6nN9WG8jvusBJA2`): "minimal
   *  projection" is a claim about what the callback may decide on, so widening it
   *  must break a test rather than pass a row through unnoticed. */
  it('exposes a KEYED minimal fact projection of the coordinated workspace', () => {
    const t = fixture();
    t.workspaces.insertMembership(t.mine, t.agentId);
    t.workspaces.addUserMember(t.mine, t.userId, 'admin');

    const facts = t.persistence.channel.uow.atomicallyInWorkspace(t.mine, tx => ({
      keys: Object.keys(tx.workspace).sort(),
      arities: [
        tx.workspace.get.length,
        tx.workspace.hasAgentMember.length,
        tx.workspace.humanRole.length,
      ],
      snapshot: tx.workspace.get(),
      agent: tx.workspace.hasAgentMember(t.agentId),
      human: tx.workspace.humanRole(t.userId),
    }));
    expect(facts).toEqual({
      keys: ['get', 'hasAgentMember', 'humanRole'],
      arities: [0, 1, 1],
      // EXACTLY the deciding facts — no id, name, description or pin state. The
      // callbacks consult `workspace_kind` and (agent_home) `owner_agent_id`, and
      // nothing else may be reachable from a transaction that only promised to
      // have read these under the lock.
      snapshot: { workspace_kind: 'regular', owner_agent_id: null },
      agent: true,
      // The ROLE, not a boolean: the same row answers membership (non-null) and
      // governance (rank), so the two cannot drift apart.
      human: 'admin',
    });

    // Same subjects, OTHER key: the answers follow the key, so a callback cannot
    // accidentally validate against the workspace it is not holding.
    expect(
      t.persistence.channel.uow.atomicallyInWorkspace(t.other, tx => ({
        agent: tx.workspace.hasAgentMember(t.agentId),
        human: tx.workspace.humanRole(t.userId),
      })),
    ).toEqual({ agent: false, human: null });

    // …and a key naming no workspace at all answers `null` rather than some
    // other workspace's facts.
    expect(
      t.persistence.channel.uow.atomicallyInWorkspace('ws-gone', tx =>
        tx.workspace.get(),
      ),
    ).toBeNull();
  });

  it('the created rows take their workspace from the KEY, not from the caller', () => {
    const t = fixture();
    const { channel, dm } = t.persistence.channel.uow.atomicallyInWorkspace(
      t.mine,
      tx => ({
        channel: tx.channels.insertChannel({ title: 'keyed' }),
        dm: tx.channels.insertDmChannel({ title: 'Mentions', agentId: t.agentId }),
      }),
    );
    // Neither write face takes a `workspaceId` at all — "lock workspace A, create
    // a channel in B" is unexpressible, not merely wrong. This pins that the key
    // is what the adapter actually passes down.
    expect([channel.workspace_id, dm.workspace_id]).toEqual([t.mine, t.mine]);
    expect(t.conversations.get(channel.id)?.workspace_id).toBe(t.mine);

    // A SECOND transaction on a DIFFERENT key must not inherit the first one's:
    // the scope is built per transaction precisely so it cannot be hoisted and
    // memoized, which is the mistake this asserts against.
    const second = t.persistence.channel.uow.atomicallyInWorkspace(t.other, tx =>
      tx.channels.insertChannel({ title: 'other-keyed' }),
    );
    expect(second.workspace_id).toBe(t.other);
  });

  it('binds EVERY conversation-taking face, and the refusal rolls the whole transaction back', () => {
    const t = fixture();
    const faces: Array<[string, (tx: WorkspaceChannelTxScope, id: string) => unknown]> = [
      ['channels.addAgent', (tx, id) => tx.channels.addAgent(id, t.agentId)],
      ['channels.addUser', (tx, id) => tx.channels.addUser(id, t.userId)],
      ['channels.get', (tx, id) => tx.channels.get(id)],
      ['channels.getAgent', (tx, id) => tx.channels.getAgent(id, t.agentId)],
      ['channels.listUsers', (tx, id) => tx.channels.listUsers(id)],
      [
        'messages.insert',
        (tx, id) =>
          tx.messages.insert({ conversationId: id, fromKind: 'system', content: 'seed' }),
      ],
    ];

    for (const [label, use] of faces) {
      const created: string[] = [];
      expect(
        () =>
          t.persistence.channel.uow.atomicallyInWorkspace(t.mine, tx => {
            // A LEGITIMATE write first: the refusal has to UNDO this, or the
            // "lock A, write B" refusal would be a report rather than a rollback.
            created.push(tx.channels.insertChannel({ title: `probe-${label}` }).id);
            use(tx, t.foreignChannel);
          }),
        label,
      ).toThrow(new RegExp(`belongs to workspace ${t.other}`));
      expect(created, label).toHaveLength(1);
      expect(t.conversations.get(created[0]!), label).toBeNull();
    }
    // …and the foreign conversation gained neither of the members those faces
    // aimed at it. (Point lookups, not a row dump: this fixture DB autoseeds its
    // own fixture users into every conversation, so an emptiness assertion here
    // would be about the seed, not about the binding.)
    expect(t.conversations.getAgent(t.foreignChannel, t.agentId)).toBeNull();
    expect(t.conversations.getUser(t.foreignChannel, t.userId)).toBeNull();
  });

  it('passes a NON-EXISTENT conversation through so each face answers with its own semantics', () => {
    const t = fixture();
    // Only a real pointer into another workspace is a coordination violation. A
    // missing row is not: a read then answers `null` and a write hits its foreign
    // key — refusing here instead would turn "not found" into "wrong workspace".
    expect(
      t.persistence.channel.uow.atomicallyInWorkspace(t.mine, tx =>
        tx.channels.get('conv-does-not-exist'),
      ),
    ).toBeNull();
    expect(() =>
      t.persistence.channel.uow.atomicallyInWorkspace(t.mine, tx =>
        tx.channels.addAgent('conv-does-not-exist', t.agentId),
      ),
    ).toThrow(/FOREIGN KEY/);
  });

  it('is root-only too: the second axis refuses loudly when nested', () => {
    const t = fixture();
    // Nested, `.immediate()` silently degrades to a savepoint and takes NO write
    // lock — the two axes would then no longer share the mechanism the port
    // contract requires.
    t.db.transaction(() => {
      expect(() =>
        t.persistence.channel.uow.atomicallyInWorkspace(t.mine, () => undefined),
      ).toThrow(/root-only/);
    })();
  });
});

describe('SqliteConversationPersistence: both channel axes share ONE lock mechanism', () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => {
    for (const fn of cleanups.splice(0)) fn();
  });

  it('the workspace-keyed axis takes the write lock at BEGIN, like the conversation-keyed one', () => {
    const dir = mkdtempSync(join(tmpdir(), 'silverhand-conv-ws-uow-test-'));
    const dbPath = join(dir, 'silverhand.db');
    const writer = openDatabase(dbPath, { busyTimeoutMs: 0 });
    const contender = openDatabase(dbPath, { busyTimeoutMs: 0 });
    cleanups.push(() => {
      writer.close();
      contender.close();
      rmSync(dir, { recursive: true, force: true });
    });
    const workspace = new WorkspaceRepo(writer).insert({
      name: 'ws-axis-contract',
      description: null,
    });
    const persistence = createSqliteConversationPersistence(writer);

    contender.exec('BEGIN IMMEDIATE');
    let callbackRan = false;
    try {
      let thrown: unknown;
      try {
        persistence.channel.uow.atomicallyInWorkspace(workspace.id, () => {
          callbackRan = true;
        });
      } catch (err) {
        thrown = err;
      }
      // The claim under test is the port doc's "two coordination axes, ONE
      // mechanism": if this axis were deferred, a creation could interleave with
      // a rename and `getChannelLikeForUpdate`'s obligation would rest on nothing.
      expect(thrown).toMatchObject({ code: 'SQLITE_BUSY' });
    } finally {
      contender.exec('ROLLBACK');
    }
    expect(callbackRan).toBe(false);
  });
});

describe('SqliteConversationPersistence user-identity projection (R4)', () => {
  const MINIMAL_KEYS = ['display_name', 'id', 'name'];

  it('both faces return exactly the display identity, with no physical user column', () => {
    const { db } = openTestDb();
    const persistence = createSqliteConversationPersistence(db);

    const insideTx = persistence.message.uow.atomically(tx =>
      tx.users.getByName('local-test'),
    );
    const postCommit = persistence.delivery.read.getUser('local');
    const expected = {
      id: 'local',
      name: 'local-test',
      display_name: 'Local Test User',
    };

    expect(insideTx).toEqual(expected);
    expect(postCommit).toEqual(expected);
    // Key-set equality, not shape assignability: a future bare row return would
    // still satisfy `toEqual`'s sibling checks nowhere near as loudly as this.
    expect(Object.keys(insideTx!).sort()).toEqual(MINIMAL_KEYS);
    expect(Object.keys(postCommit!).sort()).toEqual(MINIMAL_KEYS);

    // A miss is null on both faces (the projection must not invent a row).
    expect(
      persistence.message.uow.atomically(tx => tx.users.getByName('nobody-test')),
    ).toBeNull();
    expect(persistence.delivery.read.getUser('nobody')).toBeNull();

    db.close();
  });
});
