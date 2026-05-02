import { describe, expect, it } from 'vitest';
import { AgentRepo } from '../../src/repos/agent-repo.js';
import { ChannelRepo } from '../../src/repos/channel-repo.js';
import { MembershipRepo } from '../../src/repos/membership-repo.js';
import { openTestDb } from '../utils/db.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function bootstrapChannelAndAgents() {
  const { db, localHostId } = openTestDb();
  const workspacesRoot = join(tmpdir(), 'silverhand-mem-test');
  const channels = new ChannelRepo(db, { workspacesRoot });
  const agents = new AgentRepo(db);
  const memb = new MembershipRepo(db);

  const ch = channels.insert({
    name: 'ops',
    description: null,
    kind: 'regular',
    workspace_path: channels.workspacePathFor('ops'),
    workspace_host_id: localHostId,
    dm_agent_id: null,
  });
  const a = agents.create({ name: 'a', runtime: 'claude' }, localHostId);
  const b = agents.create({ name: 'b', runtime: 'claude' }, localHostId);
  return { db, ch, a, b, memb };
}

describe('MembershipRepo', () => {
  it('add is idempotent (INSERT OR IGNORE) and isMember reflects state', () => {
    const { ch, a, memb } = bootstrapChannelAndAgents();
    expect(memb.isMember(ch.id, a.id)).toBe(false);

    memb.add(ch.id, a.id);
    expect(memb.isMember(ch.id, a.id)).toBe(true);

    // double-add should not throw and should not duplicate
    memb.add(ch.id, a.id);
    expect(memb.listForChannel(ch.id)).toHaveLength(1);
  });

  it('listForChannel returns agents in joined_at order', () => {
    const { ch, a, b, memb } = bootstrapChannelAndAgents();
    memb.add(ch.id, b.id);
    // pause to guarantee distinct joined_at
    const now = Date.now();
    while (Date.now() === now) { /* spin */ }
    memb.add(ch.id, a.id);

    const list = memb.listForChannel(ch.id);
    expect(list.map(x => x.id)).toEqual([b.id, a.id]);
  });

  it('remove deletes only the targeted membership', () => {
    const { ch, a, b, memb } = bootstrapChannelAndAgents();
    memb.add(ch.id, a.id);
    memb.add(ch.id, b.id);

    memb.remove(ch.id, a.id);
    expect(memb.isMember(ch.id, a.id)).toBe(false);
    expect(memb.isMember(ch.id, b.id)).toBe(true);
  });
});
