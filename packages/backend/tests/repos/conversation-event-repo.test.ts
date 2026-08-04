import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { AgentRepo } from '../../src/repos/agent-repo.js';
import { ConversationEventRepo } from '../../src/repos/conversation-event-repo.js';
import { ConversationRepo } from '../../src/repos/conversation-repo.js';
import { WorkspaceRepo } from '../../src/repos/workspace-repo.js';
import { makeTempSilverhandDir, openTestDb } from '../utils/db.js';

function bootstrap() {
  const { db, localHostId } = openTestDb();
  const tmp = makeTempSilverhandDir();
  const agents = new AgentRepo(db);
  const conversations = new ConversationRepo(db);
  const workspaces = new WorkspaceRepo(db);
  const agent = agents.create(
    { name: 'activity-agent', runtime: 'claude' },
    localHostId,
    'local',
  );
  const workspace = workspaces.insert({
    name: 'activity',
    description: null,
  });
  const channel = conversations.insertChannel({
    workspaceId: workspace.id,
    title: 'Activity',
  });
  conversations.addAgent(channel.id, agent.id);

  return {
    db,
    agent,
    channel,
    cleanup: tmp.cleanup,
  };
}

describe('ConversationEventRepo', () => {
  it('stores structured parsed events with marker-only tool_output payloads', () => {
    const t = bootstrap();
    try {
      const repo = new ConversationEventRepo(t.db);
      const huge = 'x'.repeat(2_000);

      repo.recordParsedEvent({
        conversationId: t.channel.id,
        agentId: t.agent.id,
        event: {
          kind: 'tool_call',
          name: 'Bash',
          toolCallId: 'tool-1',
          input: { command: huge },
        },
        createdAt: 1_700_000_000_000,
      });
      repo.recordParsedEvent({
        conversationId: t.channel.id,
        agentId: t.agent.id,
        event: {
          kind: 'tool_output',
          name: 'Bash',
          toolCallId: 'tool-1',
        },
        createdAt: 1_700_000_000_001,
      });
      const unknown = repo.recordParsedEvent({
        conversationId: t.channel.id,
        agentId: t.agent.id,
        event: {
          kind: 'unknown',
          raw: 'unstructured line that must not be persisted',
        },
        createdAt: 1_700_000_000_002,
      });
      expect(unknown).toBeNull();

      const page = repo.listForConversationAgent({
        conversationId: t.channel.id,
        agentId: t.agent.id,
        limit: 10,
      });

      expect(page.events.map(e => e.kind)).toEqual([
        'tool_call',
        'tool_output',
      ]);
      const toolCall = page.events[0]!.payload as {
        name: string;
        tool_call_id: string;
        input: { command: string };
      };
      expect(toolCall.name).toBe('Bash');
      expect(toolCall.tool_call_id).toBe('tool-1');
      expect(toolCall.input.command.length).toBeLessThan(huge.length);
      expect(toolCall.input.command).toContain('<truncated');
      expect(page.events[1]!.payload).toEqual({
        name: 'Bash',
        tool_call_id: 'tool-1',
      });
      expect(page.events[1]!.payload).not.toHaveProperty('output');
      expect(page.events[1]!.payload).not.toHaveProperty('result');
    } finally {
      t.cleanup();
    }
  });

  it('paginates newest activity and prunes per conversation-agent by count', () => {
    const t = bootstrap();
    try {
      const repo = new ConversationEventRepo(t.db, {
        maxEventsPerConversationAgent: 3,
        retentionDays: 30,
      });
      for (let i = 1; i <= 5; i += 1) {
        repo.recordParsedEvent({
          conversationId: t.channel.id,
          agentId: t.agent.id,
          event: { kind: 'text', text: `event-${i}` },
          createdAt: 1_700_000_000_000 + i,
        });
      }

      const firstPage = repo.listForConversationAgent({
        conversationId: t.channel.id,
        agentId: t.agent.id,
        limit: 2,
      });
      expect(firstPage.events.map(e => e.payload)).toEqual([
        { text: 'event-4' },
        { text: 'event-5' },
      ]);
      expect(firstPage.next_before_id).toBe(firstPage.events[0]!.id);

      const secondPage = repo.listForConversationAgent({
        conversationId: t.channel.id,
        agentId: t.agent.id,
        limit: 2,
        beforeId: firstPage.next_before_id,
      });
      expect(secondPage.events.map(e => e.payload)).toEqual([
        { text: 'event-3' },
      ]);
      expect(secondPage.next_before_id).toBeNull();
    } finally {
      t.cleanup();
    }
  });

  it('updates a live text block in place instead of creating fragment rows', () => {
    const t = bootstrap();
    try {
      const repo = new ConversationEventRepo(t.db);

      const first = repo.upsertTextBlock({
        conversationId: t.channel.id,
        agentId: t.agent.id,
        kind: 'thinking',
        text: 'find',
        createdAt: 1_700_000_000_000,
      });
      const second = repo.upsertTextBlock({
        conversationId: t.channel.id,
        agentId: t.agent.id,
        kind: 'thinking',
        text: 'finding',
        createdAt: 1_700_000_000_001,
        previousEventId: first!.id,
      });

      expect(second!.id).toBe(first!.id);
      const page = repo.listForConversationAgent({
        conversationId: t.channel.id,
        agentId: t.agent.id,
        limit: 10,
      });
      expect(page.events).toHaveLength(1);
      expect(page.events[0]).toMatchObject({
        id: first!.id,
        kind: 'thinking',
        payload: { text: 'finding' },
        created_at: 1_700_000_000_000,
      });
    } finally {
      t.cleanup();
    }
  });

  it('falls back to a new text block when the previous block id is absent', () => {
    const t = bootstrap();
    try {
      const repo = new ConversationEventRepo(t.db);

      const row = repo.upsertTextBlock({
        conversationId: t.channel.id,
        agentId: t.agent.id,
        kind: 'text',
        text: 'body',
        createdAt: 1_700_000_000_000,
        previousEventId: 999_999,
      });

      expect(row).toMatchObject({
        kind: 'text',
        payload: { text: 'body' },
      });
      const page = repo.listForConversationAgent({
        conversationId: t.channel.id,
        agentId: t.agent.id,
        limit: 10,
      });
      expect(page.events).toHaveLength(1);
    } finally {
      t.cleanup();
    }
  });

  it('prunes expired rows for the same conversation-agent pair', () => {
    const t = bootstrap();
    try {
      const repo = new ConversationEventRepo(t.db, {
        maxEventsPerConversationAgent: 2_000,
        retentionDays: 1,
      });
      const now = 1_700_000_000_000;
      repo.recordParsedEvent({
        conversationId: t.channel.id,
        agentId: t.agent.id,
        event: { kind: 'text', text: 'expired' },
        createdAt: now - 2 * 24 * 60 * 60 * 1_000,
      });
      repo.recordParsedEvent({
        conversationId: t.channel.id,
        agentId: t.agent.id,
        event: { kind: 'text', text: 'fresh' },
        createdAt: now,
      });

      const page = repo.listForConversationAgent({
        conversationId: t.channel.id,
        agentId: t.agent.id,
        limit: 10,
      });
      expect(page.events.map(e => e.payload)).toEqual([{ text: 'fresh' }]);
    } finally {
      t.cleanup();
    }
  });
});
