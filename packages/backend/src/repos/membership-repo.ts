import type { Database as Db } from 'better-sqlite3';
import type {
  AgentDto,
  AgentRow,
  ChannelDto,
  ChannelMemberDto,
  ChannelMemberRow,
  ChannelRow,
} from '@silverhand/shared';

export class MembershipRepo {
  constructor(private readonly db: Db) {}

  listForChannel(channelId: string): AgentDto[] {
    const rows = this.db
      .prepare<[string], AgentRow>(
        `SELECT a.*
         FROM agents a
         JOIN channel_members m ON m.agent_id = a.id
         WHERE m.channel_id = ?
         ORDER BY m.joined_at ASC`,
      )
      .all(channelId);
    return rows.map(r => ({ ...r }));
  }

  /** Every channel this agent is a member of, ordered by join time. */
  listForAgent(agentId: string): ChannelDto[] {
    const rows = this.db
      .prepare<[string], ChannelRow>(
        `SELECT c.*
         FROM channels c
         JOIN channel_members m ON m.channel_id = c.id
         WHERE m.agent_id = ?
         ORDER BY m.joined_at ASC`,
      )
      .all(agentId);
    return rows.map(r => ({ ...r }));
  }

  isMember(channelId: string, agentId: string): boolean {
    const row = this.db
      .prepare<[string, string], { c: number }>(
        `SELECT COUNT(*) AS c FROM channel_members WHERE channel_id = ? AND agent_id = ?`,
      )
      .get(channelId, agentId);
    return (row?.c ?? 0) > 0;
  }

  add(channelId: string, agentId: string): ChannelMemberDto {
    const now = Date.now();
    this.db
      .prepare(
        `INSERT OR IGNORE INTO channel_members (channel_id, agent_id, joined_at)
         VALUES (?, ?, ?)`,
      )
      .run(channelId, agentId, now);
    const row = this.db
      .prepare<[string, string], ChannelMemberRow>(
        `SELECT * FROM channel_members WHERE channel_id = ? AND agent_id = ?`,
      )
      .get(channelId, agentId);
    if (!row) throw new Error('membership not found after insert');
    return { ...row };
  }

  remove(channelId: string, agentId: string): void {
    this.db
      .prepare(`DELETE FROM channel_members WHERE channel_id = ? AND agent_id = ?`)
      .run(channelId, agentId);
  }
}
