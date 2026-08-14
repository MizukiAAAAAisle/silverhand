import { describe, expect, it } from 'vitest';
import { ConversationNameRepo } from '../../src/repos/conversation-name-repo.js';
import { ConversationRepo } from '../../src/repos/conversation-repo.js';
import { AgentRepo } from '../../src/repos/agent-repo.js';
import { WorkspaceRepo } from '../../src/repos/workspace-repo.js';
import { openTestDb } from '../utils/db.js';

// The workspace NAME NAMESPACE as the application sees it (#task:2016, P0-c).
//
// migration-level falsifiers — the illegal-SQL battery, the birth guard, the
// backfill — live in `tests/conversation-names-migration.test.ts`, because those
// claims are about the DATABASE refusing writes no repo issues today. This file
// owns the half that is about the code: what an address resolves to, that names
// never resolve across workspaces, that a conversation is born with an address
// and cannot be deleted without giving it up, and — the property SQLite cannot
// state — that TOTALITY holds and is detectable when a fault breaks it.

function fixture() {
  const { db, localHostId } = openTestDb();
  const workspaces = new WorkspaceRepo(db);
  const conversations = new ConversationRepo(db);
  const names = new ConversationNameRepo(db);
  const agents = new AgentRepo(db);
  const eng = workspaces.insert({ name: 'eng', description: null });
  const ops = workspaces.insert({ name: 'ops', description: null });
  return { db, localHostId, workspaces, conversations, names, agents, eng, ops };
}

describe('conversation names — resolution (#task:2016)', () => {
  it('resolves a current address to its conversation', () => {
    const t = fixture();
    const channel = t.conversations.insertChannel({
      workspaceId: t.eng.id,
      title: 'Planning',
      name: 'planning',
    });

    expect(channel.name).toBe('planning');
    expect(t.names.resolve(t.eng.id, 'planning')).toEqual({
      kind: 'ok',
      conversationId: channel.id,
    });
  });

  it('answers unknown for a name nobody ever allocated', () => {
    const t = fixture();
    expect(t.names.resolve(t.eng.id, 'never-existed')).toEqual({ kind: 'unknown' });
  });

  it('a retired address still names its conversation AND carries the successor', () => {
    const t = fixture();
    const channel = t.conversations.insertChannel({
      workspaceId: t.eng.id,
      title: 'Planning',
      name: 'planning',
    });
    const retiredAt = Date.now();
    expect(t.names.retireCurrent(channel.id, retiredAt)).toBe('planning');
    t.names.allocate({
      workspaceId: t.eng.id,
      name: 'roadmap',
      conversationId: channel.id,
      assignedAt: retiredAt,
    });

    // "It moved, and here is where" — the answer a stale reference needs, and the
    // reason the retired row is kept rather than deleted.
    expect(t.names.resolve(t.eng.id, 'planning')).toEqual({
      kind: 'retired',
      conversationId: channel.id,
      retiredAt,
      successorName: 'roadmap',
    });
    expect(t.names.resolve(t.eng.id, 'roadmap')).toEqual({
      kind: 'ok',
      conversationId: channel.id,
    });
  });

  it('a retired address with no successor reports the half-state, not a resolution', () => {
    const t = fixture();
    const channel = t.conversations.insertChannel({
      workspaceId: t.eng.id,
      title: 'Planning',
      name: 'planning',
    });
    t.names.retireCurrent(channel.id, 1_700_000_000_000);

    expect(t.names.resolve(t.eng.id, 'planning')).toEqual({
      kind: 'retired',
      conversationId: channel.id,
      retiredAt: 1_700_000_000_000,
      successorName: null,
    });
  });

  it('never resolves a name into another workspace, even for the same conversation id', () => {
    const t = fixture();
    const engChannel = t.conversations.insertChannel({
      workspaceId: t.eng.id,
      title: 'General',
      name: 'general',
    });
    const opsChannel = t.conversations.insertChannel({
      workspaceId: t.ops.id,
      title: 'General',
      name: 'general',
    });

    // The SAME name is legal in both namespaces and means a different thing in
    // each: that is what makes `name` an address rather than an identifier.
    expect(t.names.resolve(t.eng.id, 'general')).toEqual({
      kind: 'ok',
      conversationId: engChannel.id,
    });
    expect(t.names.resolve(t.ops.id, 'general')).toEqual({
      kind: 'ok',
      conversationId: opsChannel.id,
    });
    expect(engChannel.id).not.toBe(opsChannel.id);

    // And a name cannot be allocated ACROSS namespaces at all: the birth guard
    // refuses a target belonging to another workspace, so the id-only-join hole
    // has no data to exploit even before resolution asks. `workspace_id` is
    // immutable, so no later write can move a conversation out from under its
    // address either.
    expect(() =>
      t.names.allocate({
        workspaceId: t.ops.id,
        name: 'eng-pointer',
        conversationId: engChannel.id,
        assignedAt: Date.now(),
      }),
    ).toThrow(/workspace-placed conversation of the same workspace/);
    expect(t.names.resolve(t.ops.id, 'eng-pointer')).toEqual({ kind: 'unknown' });
  });

  it('an inbox holds no address: it is not resolvable and reports no current name', () => {
    const t = fixture();
    const agent = t.agents.create({ name: 'alice', runtime: 'claude' }, t.localHostId, 'local');
    const inbox = t.conversations.insertAgentInbox(agent.id, Date.now());

    expect(t.names.currentNameOf(inbox.id)).toBeNull();
    expect(t.names.resolve(t.eng.id, 'alice')).toEqual({ kind: 'unknown' });
  });
});

describe('conversation names — allocation is permanent (#task:2016)', () => {
  it('reports a retired name as allocated, so a request for it is refused not aborted', () => {
    const t = fixture();
    const channel = t.conversations.insertChannel({
      workspaceId: t.eng.id,
      title: 'Planning',
      name: 'planning',
    });
    t.names.retireCurrent(channel.id, Date.now());

    // `isAllocated` ignores `retired_at` ON PURPOSE: it answers the question the
    // primary key answers. A check that looked only at current rows would call
    // this address free and then abort the whole transaction on the key.
    expect(t.names.isAllocated(t.eng.id, 'planning')).toBe(true);
    expect(t.names.isAllocated(t.ops.id, 'planning')).toBe(false);
    expect(() =>
      t.names.allocate({
        workspaceId: t.eng.id,
        name: 'planning',
        conversationId: channel.id,
        assignedAt: Date.now(),
      }),
    ).toThrow(/UNIQUE|PRIMARY KEY/i);
  });

  it('deleting a conversation gives up its address in the same transaction', () => {
    const t = fixture();
    const channel = t.conversations.insertChannel({
      workspaceId: t.eng.id,
      title: 'Planning',
      name: 'planning',
    });

    t.conversations.delete(channel.id);

    // The row is gone, the allocation is retired (not deleted — the trigger
    // refuses that), and the address is still un-takeable forever.
    expect(t.conversations.get(channel.id)).toBeNull();
    expect(t.names.currentNameOf(channel.id)).toBeNull();
    expect(t.names.isAllocated(t.eng.id, 'planning')).toBe(true);
    expect(t.names.resolve(t.eng.id, 'planning')).toEqual({ kind: 'conversation_gone' });
    // …and the leak the retirement prevents: no conversation is left holding an
    // address that no operation could ever free.
    expect(t.names.listWorkspacePlacementsWithoutCurrentName()).toEqual([]);
  });
});

describe('conversation names — the terminal writer asserts the grammar (#task:2016)', () => {
  it('refuses an inadmissible name before it reaches SQL, naming the schema', () => {
    const t = fixture();
    const channel = t.conversations.insertChannel({
      workspaceId: t.eng.id,
      title: 'Planning',
      name: 'planning',
    });
    t.names.retireCurrent(channel.id, Date.now());

    // Every case is a name the CHECK would also refuse; what this pins is that
    // the refusal happens at the repo with a message that names the rule, rather
    // than as a bare `SQLITE_CONSTRAINT_CHECK` from whatever statement happened
    // to run. The two guards are deliberately redundant: the DB closes the
    // domain for callers that never come through here (@Cindy's B1), this one
    // makes the failure legible for the callers that do.
    for (const name of ['Planning', '2026-roadmap', '-planning', 'planning-', 'a b', '', 'x'.repeat(65)]) {
      expect(() =>
        t.names.allocate({
          workspaceId: t.eng.id,
          name,
          conversationId: channel.id,
          assignedAt: Date.now(),
        }),
        name,
      ).toThrow(/ConversationNameSchema/);
    }
    // Nothing was written by any of them — the address the channel gave up is
    // still the only row it has, so a rejected allocation cannot leave a
    // conversation looking renamed.
    expect(t.names.currentNameOf(channel.id)).toBeNull();
    expect(t.names.isAllocated(t.eng.id, 'Planning')).toBe(false);
  });
});

describe('conversation names — totality is a property of the write paths (#task:2016)', () => {
  it('every conversation the repo creates is born with exactly one current name', () => {
    const t = fixture();
    const a = t.conversations.insertChannel({
      workspaceId: t.eng.id,
      title: 'General',
      name: 'general',
    });
    const b = t.conversations.insertChannel({
      workspaceId: t.eng.id,
      title: 'Random',
      name: 'random',
    });
    const dm = t.conversations.insertDmChannel({
      workspaceId: t.ops.id,
      title: 'Onboarding',
      name: 'onboarding',
    });
    const agent = t.agents.create({ name: 'alice', runtime: 'claude' }, t.localHostId, 'local');
    t.conversations.insertAgentInbox(agent.id, Date.now());

    expect(t.names.listWorkspacePlacementsWithoutCurrentName()).toEqual([]);
    for (const id of [a.id, b.id, dm.id]) {
      expect(t.names.currentNameOf(id)).not.toBeNull();
    }
  });

  it('detects the created-without-an-address half-state (fault injection)', () => {
    const t = fixture();
    // INJECTED WITH DIRECT SQL because no production face can produce it: `name`
    // is a required argument of both insert faces and the allocation happens in
    // the same transaction as the row. This is the state a crash BETWEEN those
    // two statements would leave if they were ever split — the consistency query
    // exists to name it, so it has to be shown naming it.
    t.db
      .prepare(
        `INSERT INTO conversations
           (id, placement_kind, roster_policy, workspace_id, title, status,
            visibility, created_at, updated_at)
         VALUES ('halfstate', 'workspace', 'open', ?, 'Orphan', 'active',
                 'private', 1, 1)`,
      )
      .run(t.eng.id);

    expect(t.names.listWorkspacePlacementsWithoutCurrentName()).toEqual(['halfstate']);
    // The address the caller MEANT is not reachable: nothing was allocated, so
    // the answer is `unknown`, never a resolution onto the nameless row.
    expect(t.names.resolve(t.eng.id, 'orphan')).toEqual({ kind: 'unknown' });
  });

  it('detects the retired-without-a-successor half-state (fault injection)', () => {
    const t = fixture();
    const channel = t.conversations.insertChannel({
      workspaceId: t.eng.id,
      title: 'Planning',
      name: 'planning',
    });
    // The other half-state, and this one needs no raw SQL: retire-then-allocate
    // is two statements, and committing after only the first is exactly what a
    // fault between them would leave.
    t.names.retireCurrent(channel.id, Date.now());

    expect(t.names.listWorkspacePlacementsWithoutCurrentName()).toEqual([channel.id]);
    // The channel is still addressable-by-id and still reports its DTO — with a
    // null name, which is why `name` is nullable rather than a lie.
    expect(t.conversations.getChannelLike(channel.id)?.name).toBeNull();
  });
});
