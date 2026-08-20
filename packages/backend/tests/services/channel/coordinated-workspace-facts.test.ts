// THE FENCE THE DOCBLOCK CLAIMED — `CoordinatedWorkspaceFacts` is exact, and the
// adapter really projects (#task:2082).
//
// `services/channel/ports.ts` says a creation transaction may decide on this field
// set and no more. Until this file existed that sentence had no machine behind it,
// and a type-level narrowing is not one: structural typing means
// `{ ...row }` satisfies a one-field interface while every surplus column keeps
// flowing at runtime, so the callback could decide on `archived_at` — a fact this
// port never promised to have read under the lock (R4). The assertion is therefore
// on the RUNTIME KEY SET of what the adapter returns, in the same style as
// `tests/runtime/runtime-fanout-adapter.test.ts`.
//
// Two directions, because a key-set cell alone would also pass for a projection
// that returns a constant: the home arm asserts the value is the OWNING AGENT's
// id, which is what the `agent_home` creation callback goes on to use.
//
// The second describe pins the OTHER half of the concept's contract: the id
// convention and the ownership relation are two authorities for "is this an agent
// home", and their agreement is an invariant of one writer rather than a
// coincidence — `agent-home-workspace.ts` says so in prose and points here.
import { describe, expect, it } from 'vitest';
import {
  fixedWorkspaceName,
  isAgentHomeWorkspace,
  isAgentHomeWorkspaceId,
  isAgentHomeWorkspaceOf,
} from '@silverhand/shared';
import { AgentRepo } from '../../../src/repos/agent-repo.js';
import { WorkspaceRepo } from '../../../src/repos/workspace-repo.js';
import { createSqliteConversationPersistence } from '../../../src/repos/conversation-persistence.js';
import { openTestDb } from '../../utils/db.js';

/** Exactly the fields `CoordinatedWorkspaceFacts` declares. */
const COORDINATED_WORKSPACE_FACT_KEYS = ['owner_agent_id'];

/** Physical `workspaces` columns a creation callback must not be able to consult.
 *  Named individually rather than derived from the row: the point is that adding a
 *  column to the table does not weaken this cell, while spreading the row into the
 *  projection breaks it. */
const SURPLUS_COLUMNS = [
  'id',
  'name',
  'name_key',
  'description',
  'owner_user_id',
  'archived_at',
  'created_at',
  'updated_at',
];

function fixture() {
  const { db, viewerUserId, localHostId } = openTestDb();
  const workspaces = new WorkspaceRepo(db);
  const regular = workspaces.insert({
    name: fixedWorkspaceName('coordinated-facts'),
    description: null,
  });
  const agent = new AgentRepo(db).create(
    { name: 'agent-coordinated', runtime: 'claude', host_id: localHostId },
    localHostId,
    viewerUserId,
  );
  const home = workspaces.insertAgentHome({ agent });
  const persistence = createSqliteConversationPersistence(db);
  const factsOf = (workspaceId: string) =>
    persistence.channel.uow.atomicallyInWorkspace(workspaceId, tx =>
      tx.workspace.get(),
    );
  return { db, agent, regular, home, factsOf };
}

describe('a creation transaction sees the ownership relation and nothing else', () => {
  it('projects one field for a regular container, not the row', () => {
    const f = fixture();
    try {
      const facts = f.factsOf(f.regular.id);
      expect(facts).not.toBeNull();
      expect(Object.keys(facts!).sort()).toEqual(COORDINATED_WORKSPACE_FACT_KEYS);
      for (const surplus of SURPLUS_COLUMNS) {
        expect(facts!, surplus).not.toHaveProperty(surplus);
      }
      expect(isAgentHomeWorkspace(facts!)).toBe(false);
    } finally {
      f.db.close();
    }
  });

  it('projects the OWNING AGENT for an agent home — the value the callback needs', () => {
    const f = fixture();
    try {
      const facts = f.factsOf(f.home.id);
      expect(facts).not.toBeNull();
      expect(Object.keys(facts!).sort()).toEqual(COORDINATED_WORKSPACE_FACT_KEYS);
      expect(facts!.owner_agent_id).toBe(f.agent.id);
      expect(isAgentHomeWorkspace(facts!)).toBe(true);
      expect(isAgentHomeWorkspaceOf(facts!, f.agent.id)).toBe(true);
      // The identity half of the question: another agent's home is an agent home,
      // but it is not THIS agent's, and the capability exemption turns on that.
      expect(isAgentHomeWorkspaceOf(facts!, 'someoneElse00000')).toBe(false);
    } finally {
      f.db.close();
    }
  });

  it('answers null for a container that is not there', () => {
    const f = fixture();
    try {
      expect(f.factsOf('wsMissing0000000')).toBeNull();
    } finally {
      f.db.close();
    }
  });
});

describe('the id convention and the ownership relation cannot disagree', () => {
  it('one writer mints both facts, so both authorities answer the same', () => {
    // Why this is pinned rather than argued: consumers that hold only ids (the
    // daemon's `agent_workspace_index`, `runtime_start` ref resolution) decide by
    // the id form, and every server-side read point decides by the relation. If
    // `insertAgentHome` ever derived the id from anything but the owner it writes,
    // those two populations would silently diverge — and the id-form consumers are
    // the ones that resolve filesystem coordinates.
    const f = fixture();
    try {
      expect(isAgentHomeWorkspaceId(f.home.id, f.agent.id)).toBe(true);
      expect(isAgentHomeWorkspace(f.home)).toBe(true);
      expect(f.home.owner_agent_id).toBe(f.agent.id);
      // Both authorities also agree on the negative, and for the regular container
      // the id form has no owner to be derived from at all.
      expect(isAgentHomeWorkspace(f.regular)).toBe(false);
      expect(isAgentHomeWorkspaceId(f.regular.id, f.agent.id)).toBe(false);
    } finally {
      f.db.close();
    }
  });
});
