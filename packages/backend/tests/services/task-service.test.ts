import { describe, expect, it, vi } from 'vitest';
import { readTaskSystemMetadata } from '@silverhand/shared';
import { AgentRepo } from '../../src/repos/agent-repo.js';
import { ConversationRepo } from '../../src/repos/conversation-repo.js';
import { HostRepo } from '../../src/repos/host-repo.js';
import { MessageRepo } from '../../src/repos/message-repo.js';
import { WorkspaceRepo } from '../../src/repos/workspace-repo.js';
import { TaskService } from '../../src/services/task-service.js';
import { PrincipalConversationMismatchError } from '../../src/auth/principal.js';
import type { BackendLogger } from '../../src/context.js';
import type { ConversationManager } from '../../src/conversation-manager.js';
import { ScopeEventBus } from '../../src/ws/scope-event-bus.js';
import { makeTempSilverhandDir, openTestDb } from '../utils/db.js';

class FakeConversationManager {
  delivered: Array<{ conversationId: string; agentId: string; messageId: string }> = [];
  hangDeliver = false;
  deliverError: Error | null = null;
  onDeliver: (() => void) | null = null;

  async deliverMessage(
    conversationId: string,
    agentId: string,
    messageId: string,
  ): Promise<void> {
    this.onDeliver?.();
    this.delivered.push({ conversationId, agentId, messageId });
    if (this.deliverError) throw this.deliverError;
    if (this.hangDeliver) return new Promise<void>(() => {});
  }

  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  async stopAll(): Promise<void> {}
  resolveRun(): void {}
  resolveConversationRuns(): void {}
  getAgentRunStates(): never[] {
    return [];
  }
  reconcileOnBoot(): void {}
  isRunning(): boolean {
    return false;
  }
  closeActivityLog(): Promise<void> {
    return Promise.resolve();
  }
}

function bootstrap() {
  const { db, localHostId } = openTestDb();
  const tmp = makeTempSilverhandDir();
  new HostRepo(db).ensureLocal();
  const agents = new AgentRepo(db);
  const workspaces = new WorkspaceRepo(db, { workspacesRoot: tmp.workspacesRoot });
  const conversations = new ConversationRepo(db);
  const messages = new MessageRepo(db);
  const events = new ScopeEventBus('test-epoch');
  const fake = new FakeConversationManager();
  const logger: BackendLogger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
  const service = new TaskService({
    db,
    conversations,
    messages,
    agents,
    conversationManager: fake as unknown as ConversationManager,
    events,
    logger,
  });

  const workspace = workspaces.insert({
    name: 'eng',
    description: null,
    workspacePath: tmp.workspacesRoot,
    workspaceHostId: localHostId,
  });
  const alice = agents.create({ name: 'alice', runtime: 'claude' }, localHostId);
  const bob = agents.create({ name: 'bob', runtime: 'claude' }, localHostId);
  workspaces.addMember(workspace.id, alice.id);
  workspaces.addMember(workspace.id, bob.id);
  const channel = conversations.insertChannel({
    workspaceId: workspace.id,
    workspacePath: workspace.workspace_path,
    title: 'main',
  });
  conversations.addAgent(channel.id, alice.id);
  conversations.addAgent(channel.id, bob.id);

  return {
    db,
    tmp,
    agents,
    workspaces,
    conversations,
    messages,
    events,
    fake,
    logger,
    service,
    workspace,
    channel,
    alice,
    bob,
    localHostId,
    cleanup: tmp.cleanup,
  };
}

function createTask(t: ReturnType<typeof bootstrap>, agentId: string, title: string) {
  return t.service.createTasks({
    conversationId: t.channel.id,
    actor: { kind: 'agent', agentId, conversationId: t.channel.id },
    tasks: [{ title }],
  });
}

describe('TaskService.createTasks', () => {
  it('agent member creates 2 tasks: monotonic per workspace, broadcasts message + task_changed', async () => {
    const t = bootstrap();
    try {
      const conversationEvents: Array<{ kind: string }> = [];
      const wsEvents: Array<{ kind: string }> = [];
      const unsubA = t.events.subscribe(t.channel.id, e =>
        conversationEvents.push({ kind: e.kind }),
      );
      const unsubB = t.events.subscribeScope(`workspace:${t.workspace.id}`, e =>
        wsEvents.push({ kind: e.kind }),
      );

      const result = await t.service.createTasks({
        conversationId: t.channel.id,
        actor: { kind: 'agent', agentId: t.alice.id, conversationId: t.channel.id },
        tasks: [{ title: 'first' }, { title: 'second' }],
      });
      unsubA();
      unsubB();

      expect('tasks' in result).toBe(true);
      if (!('tasks' in result)) throw new Error();
      expect(result.tasks.map(x => x.task_number)).toEqual([1, 2]);
      const msgEvents = conversationEvents.filter(e => e.kind === 'message');
      const taskChanges = conversationEvents.filter(e => e.kind === 'task_changed');
      expect(msgEvents.length).toBe(2);
      expect(taskChanges.length).toBe(2);
      expect(wsEvents.filter(e => e.kind === 'task_changed').length).toBe(2);
    } finally {
      t.cleanup();
    }
  });

  it('agent not in conversation → not_conversation_member, no insert', async () => {
    const t = bootstrap();
    try {
      const outsider = t.agents.create({ name: 'out', runtime: 'claude' }, t.localHostId);
      const result = await t.service.createTasks({
        conversationId: t.channel.id,
        actor: { kind: 'agent', agentId: outsider.id, conversationId: t.channel.id },
        tasks: [{ title: 'x' }],
      });
      expect(result).toEqual({ error: 'not_conversation_member' });
      expect(t.service.list({ actor: { kind: 'user', userId: null } })).toEqual([]);
    } finally {
      t.cleanup();
    }
  });

  it('conversation closed → conversation_closed', async () => {
    const t = bootstrap();
    try {
      t.db.prepare(`UPDATE conversations SET closed_at = ? WHERE id = ?`)
        .run(Date.now(), t.channel.id);
      const result = await t.service.createTasks({
        conversationId: t.channel.id,
        actor: { kind: 'agent', agentId: t.alice.id, conversationId: t.channel.id },
        tasks: [{ title: 'x' }],
      });
      expect(result).toEqual({ error: 'conversation_closed' });
    } finally {
      t.cleanup();
    }
  });

  it('conversation missing → conversation_not_found', async () => {
    const t = bootstrap();
    try {
      const result = await t.service.createTasks({
        conversationId: 'missing-conv',
        actor: { kind: 'agent', agentId: t.alice.id, conversationId: 'missing-conv' },
        tasks: [{ title: 'x' }],
      });
      expect(result).toEqual({ error: 'conversation_not_found' });
    } finally {
      t.cleanup();
    }
  });

  it('publishes message before deliver fires', async () => {
    const t = bootstrap();
    try {
      const order: string[] = [];
      t.fake.hangDeliver = true;
      t.fake.onDeliver = () => order.push('deliver');
      const unsub = t.events.subscribe(t.channel.id, e => {
        if (e.kind === 'message') order.push('publish');
      });

      const result = await t.service.createTasks({
        conversationId: t.channel.id,
        actor: { kind: 'agent', agentId: t.alice.id, conversationId: t.channel.id },
        tasks: [{ title: 'x' }],
      });
      unsub();

      expect('tasks' in result).toBe(true);
      expect(order[0]).toBe('publish');
      expect(order).toContain('deliver');
    } finally {
      t.cleanup();
    }
  });
});

describe('TaskService.claimTask — agent actor', () => {
  it('self-claim by taskNumber on unassigned task → success, status=in_progress', async () => {
    const t = bootstrap();
    try {
      await createTask(t, t.bob.id, 'task-1');
      const r = await t.service.claimTask({
        actor: { kind: 'agent', agentId: t.alice.id, conversationId: t.channel.id },
        by: { taskNumber: 1 },
      });
      expect(r).toMatchObject({ success: true, task_number: 1 });
      const fresh = t.service.getByMessageId(r.message_id!, { kind: 'user', userId: null });
      expect(fresh?.status).toBe('in_progress');
      expect(fresh?.assignee?.id).toBe(t.alice.id);
    } finally {
      t.cleanup();
    }
  });

  it('self-claim by messageId where message is already a task → claim semantics', async () => {
    const t = bootstrap();
    try {
      const created = await createTask(t, t.bob.id, 'task-1');
      if (!('tasks' in created)) throw new Error();
      const r = await t.service.claimTask({
        actor: { kind: 'agent', agentId: t.alice.id, conversationId: t.channel.id },
        by: { messageId: created.tasks[0]!.message_id },
      });
      expect(r).toMatchObject({ success: true, task_number: 1 });
    } finally {
      t.cleanup();
    }
  });

  it('self-claim by messageId where message is not yet a task → promote+claim', async () => {
    const t = bootstrap();
    try {
      const msg = t.messages.insertForConversation({
        conversationId: t.channel.id,
        fromKind: 'agent',
        fromAgentId: t.bob.id,
        content: 'a regular message that becomes a task',
      });
      const r = await t.service.claimTask({
        actor: { kind: 'agent', agentId: t.alice.id, conversationId: t.channel.id },
        by: { messageId: msg.id },
      });
      expect(r).toMatchObject({ success: true, task_number: 1, message_id: msg.id });
      const fresh = t.service.getByMessageId(msg.id, { kind: 'user', userId: null });
      expect(fresh?.status).toBe('in_progress');
      expect(fresh?.assignee?.id).toBe(t.alice.id);
    } finally {
      t.cleanup();
    }
  });

  it('claim already-claimed task → already_claimed', async () => {
    const t = bootstrap();
    try {
      await createTask(t, t.bob.id, 'task-1');
      await t.service.claimTask({
        actor: { kind: 'agent', agentId: t.alice.id, conversationId: t.channel.id },
        by: { taskNumber: 1 },
      });
      const r = await t.service.claimTask({
        actor: { kind: 'agent', agentId: t.bob.id, conversationId: t.channel.id },
        by: { taskNumber: 1 },
      });
      expect(r.success).toBe(false);
      expect(r.code).toBe('already_claimed');
      expect(r.reason).toMatch(/already claimed/);
    } finally {
      t.cleanup();
    }
  });

  it('claim with assignee.agentId !== actor.agentId → not_self_assignment', async () => {
    const t = bootstrap();
    try {
      await createTask(t, t.bob.id, 'task-1');
      const r = await t.service.claimTask({
        actor: { kind: 'agent', agentId: t.alice.id, conversationId: t.channel.id },
        by: { taskNumber: 1 },
        assignee: { agentId: t.bob.id },
      });
      expect(r.success).toBe(false);
      expect(r.code).toBe('not_self_assignment');
    } finally {
      t.cleanup();
    }
  });

  it('claim task in another conversation → wrong_conversation', async () => {
    const t = bootstrap();
    try {
      const other = t.conversations.insertChannel({
        workspaceId: t.workspace.id,
        workspacePath: t.workspace.workspace_path,
        title: 'other',
      });
      t.conversations.addAgent(other.id, t.alice.id);
      // create task in `other`
      await t.service.createTasks({
        conversationId: other.id,
        actor: { kind: 'agent', agentId: t.alice.id, conversationId: other.id },
        tasks: [{ title: 'foreign' }],
      });
      // alice tries to claim it from `channel` instead
      const r = await t.service.claimTask({
        actor: { kind: 'agent', agentId: t.alice.id, conversationId: t.channel.id },
        by: { taskNumber: 1 },
      });
      expect(r.success).toBe(false);
      expect(r.code).toBe('wrong_conversation');
      expect(r.owner_conversation?.id).toBe(other.id);
    } finally {
      t.cleanup();
    }
  });

  it('claim done task → task_done', async () => {
    const t = bootstrap();
    try {
      const created = await createTask(t, t.alice.id, 'x');
      if (!('tasks' in created)) throw new Error();
      // mark done directly
      t.db.prepare(`UPDATE messages SET task_status = 'done' WHERE id = ?`)
        .run(created.tasks[0]!.message_id);
      const r = await t.service.claimTask({
        actor: { kind: 'agent', agentId: t.alice.id, conversationId: t.channel.id },
        by: { taskNumber: 1 },
      });
      expect(r.success).toBe(false);
      expect(r.code).toBe('task_done');
    } finally {
      t.cleanup();
    }
  });

  it('claim preserves status when task already in_progress', async () => {
    const t = bootstrap();
    try {
      const created = await createTask(t, t.bob.id, 'x');
      if (!('tasks' in created)) throw new Error();
      // simulate a task in in_review (could happen if user assigned then agent moved)
      t.db.prepare(`UPDATE messages SET task_status = 'in_review' WHERE id = ?`)
        .run(created.tasks[0]!.message_id);
      const r = await t.service.claimTask({
        actor: { kind: 'agent', agentId: t.alice.id, conversationId: t.channel.id },
        by: { taskNumber: 1 },
      });
      expect(r.success).toBe(true);
      const fresh = t.service.getByMessageId(r.message_id!, { kind: 'user', userId: null });
      expect(fresh?.status).toBe('in_review');
    } finally {
      t.cleanup();
    }
  });

  it('claim by messageId, message does not exist → message_not_found', async () => {
    const t = bootstrap();
    try {
      const r = await t.service.claimTask({
        actor: { kind: 'agent', agentId: t.alice.id, conversationId: t.channel.id },
        by: { messageId: 'no-such-message' },
      });
      expect(r.success).toBe(false);
      expect(r.code).toBe('message_not_found');
    } finally {
      t.cleanup();
    }
  });

  it('claim by messageId, message in another conversation → wrong_conversation (no promote)', async () => {
    const t = bootstrap();
    try {
      const other = t.conversations.insertChannel({
        workspaceId: t.workspace.id,
        workspacePath: t.workspace.workspace_path,
        title: 'other',
      });
      const msg = t.messages.insertForConversation({
        conversationId: other.id,
        fromKind: 'agent',
        fromAgentId: t.bob.id,
        content: 'foreign message',
      });
      const r = await t.service.claimTask({
        actor: { kind: 'agent', agentId: t.alice.id, conversationId: t.channel.id },
        by: { messageId: msg.id },
      });
      expect(r.success).toBe(false);
      expect(r.code).toBe('wrong_conversation');
      // verify NO promotion happened
      const after = t.db
        .prepare<[string], { task_number: number | null }>(
          `SELECT task_number FROM messages WHERE id = ?`,
        )
        .get(msg.id);
      expect(after?.task_number).toBe(null);
    } finally {
      t.cleanup();
    }
  });

  it('claim by messageId, system message → cannot_promote_system_message', async () => {
    const t = bootstrap();
    try {
      const sys = t.messages.insertForConversation({
        conversationId: t.channel.id,
        fromKind: 'system',
        content: 'system note',
      });
      const r = await t.service.claimTask({
        actor: { kind: 'agent', agentId: t.alice.id, conversationId: t.channel.id },
        by: { messageId: sys.id },
      });
      expect(r.success).toBe(false);
      expect(r.code).toBe('cannot_promote_system_message');
    } finally {
      t.cleanup();
    }
  });

  it('claim by messageId, thread_anchor → cannot_promote_anchor', async () => {
    const t = bootstrap();
    try {
      const anchor = t.messages.insertForConversation({
        conversationId: t.channel.id,
        fromKind: 'agent',
        fromAgentId: t.alice.id,
        content: 'thread anchor',
        metadata: { subtype: 'thread_anchor' },
      });
      const r = await t.service.claimTask({
        actor: { kind: 'agent', agentId: t.alice.id, conversationId: t.channel.id },
        by: { messageId: anchor.id },
      });
      expect(r.success).toBe(false);
      expect(r.code).toBe('cannot_promote_anchor');
    } finally {
      t.cleanup();
    }
  });
});

describe('TaskService.claimTask — user actor', () => {
  it('user claim with agentId on todo task → status=in_progress, assignee set', async () => {
    const t = bootstrap();
    try {
      await createTask(t, t.alice.id, 'x');
      const r = await t.service.claimTask({
        actor: { kind: 'user', userId: 'local' },
        by: { messageId: (await firstMsgId(t)) },
        assignee: { agentId: t.bob.id },
      });
      expect(r.success).toBe(true);
      const fresh = t.service.getByMessageId(r.message_id!, { kind: 'user', userId: null });
      expect(fresh?.status).toBe('in_progress');
      expect(fresh?.assignee?.id).toBe(t.bob.id);
    } finally {
      t.cleanup();
    }
  });

  it('user claim WITHOUT agentId on todo task → status lifts to in_progress, assignee=null', async () => {
    const t = bootstrap();
    try {
      await createTask(t, t.alice.id, 'x');
      const msgId = await firstMsgId(t);
      const r = await t.service.claimTask({
        actor: { kind: 'user', userId: 'local' },
        by: { messageId: msgId },
      });
      expect(r.success).toBe(true);
      const fresh = t.service.getByMessageId(msgId, { kind: 'user', userId: null });
      expect(fresh?.status).toBe('in_progress');
      expect(fresh?.assignee).toBe(null);
    } finally {
      t.cleanup();
    }
  });

  it('user claim with agentId on in_progress task → assignee overridden, status preserved', async () => {
    const t = bootstrap();
    try {
      await createTask(t, t.alice.id, 'x');
      const msgId = await firstMsgId(t);
      // bob claims first
      await t.service.claimTask({
        actor: { kind: 'agent', agentId: t.bob.id, conversationId: t.channel.id },
        by: { taskNumber: 1 },
      });
      // user reassigns to alice
      const r = await t.service.claimTask({
        actor: { kind: 'user', userId: 'local' },
        by: { messageId: msgId },
        assignee: { agentId: t.alice.id },
      });
      expect(r.success).toBe(true);
      const fresh = t.service.getByMessageId(msgId, { kind: 'user', userId: null });
      expect(fresh?.status).toBe('in_progress');
      expect(fresh?.assignee?.id).toBe(t.alice.id);
    } finally {
      t.cleanup();
    }
  });

  it('user claim assigning to agent not in conversation → assignee_not_conversation_member', async () => {
    const t = bootstrap();
    try {
      await createTask(t, t.alice.id, 'x');
      const outsider = t.agents.create({ name: 'out', runtime: 'claude' }, t.localHostId);
      const r = await t.service.claimTask({
        actor: { kind: 'user', userId: 'local' },
        by: { messageId: (await firstMsgId(t)) },
        assignee: { agentId: outsider.id },
      });
      expect(r.success).toBe(false);
      expect(r.code).toBe('assignee_not_conversation_member');
    } finally {
      t.cleanup();
    }
  });

  it('user claim on non-task messageId → not_a_task (no promote for user)', async () => {
    const t = bootstrap();
    try {
      const msg = t.messages.insertForConversation({
        conversationId: t.channel.id,
        fromKind: 'agent',
        fromAgentId: t.alice.id,
        content: 'not a task',
      });
      const r = await t.service.claimTask({
        actor: { kind: 'user', userId: 'local' },
        by: { messageId: msg.id },
      });
      expect(r.success).toBe(false);
      expect(r.code).toBe('not_a_task');
      const after = t.db
        .prepare<[string], { task_number: number | null }>(
          `SELECT task_number FROM messages WHERE id = ?`,
        )
        .get(msg.id);
      expect(after?.task_number).toBe(null);
    } finally {
      t.cleanup();
    }
  });
});

describe('TaskService.unclaimTask', () => {
  it('agent unclaim of self-owned task → assignee=null, status=todo', async () => {
    const t = bootstrap();
    try {
      await createTask(t, t.alice.id, 'x');
      await t.service.claimTask({
        actor: { kind: 'agent', agentId: t.alice.id, conversationId: t.channel.id },
        by: { taskNumber: 1 },
      });
      const r = await t.service.unclaimTask({
        actor: { kind: 'agent', agentId: t.alice.id, conversationId: t.channel.id },
        by: { taskNumber: 1 },
      });
      expect(r).toEqual({ success: true });
      const fresh = t.service.getByMessageId((await firstMsgId(t)), {
        kind: 'user',
        userId: null,
      });
      expect(fresh?.status).toBe('todo');
      expect(fresh?.assignee).toBe(null);
    } finally {
      t.cleanup();
    }
  });

  it('agent unclaim of task assigned to OTHER agent → not_assignee', async () => {
    const t = bootstrap();
    try {
      await createTask(t, t.alice.id, 'x');
      await t.service.claimTask({
        actor: { kind: 'agent', agentId: t.bob.id, conversationId: t.channel.id },
        by: { taskNumber: 1 },
      });
      const r = await t.service.unclaimTask({
        actor: { kind: 'agent', agentId: t.alice.id, conversationId: t.channel.id },
        by: { taskNumber: 1 },
      });
      expect(r.success).toBe(false);
      expect(r.code).toBe('not_assignee');
    } finally {
      t.cleanup();
    }
  });

  it('agent unclaim of task with no assignee → not_assignee', async () => {
    const t = bootstrap();
    try {
      await createTask(t, t.alice.id, 'x');
      const r = await t.service.unclaimTask({
        actor: { kind: 'agent', agentId: t.alice.id, conversationId: t.channel.id },
        by: { taskNumber: 1 },
      });
      expect(r.success).toBe(false);
      expect(r.code).toBe('not_assignee');
    } finally {
      t.cleanup();
    }
  });

  it('agent unclaim, task in another conversation → wrong_conversation', async () => {
    const t = bootstrap();
    try {
      const other = t.conversations.insertChannel({
        workspaceId: t.workspace.id,
        workspacePath: t.workspace.workspace_path,
        title: 'other',
      });
      t.conversations.addAgent(other.id, t.alice.id);
      await t.service.createTasks({
        conversationId: other.id,
        actor: { kind: 'agent', agentId: t.alice.id, conversationId: other.id },
        tasks: [{ title: 'foreign' }],
      });
      const r = await t.service.unclaimTask({
        actor: { kind: 'agent', agentId: t.alice.id, conversationId: t.channel.id },
        by: { taskNumber: 1 },
      });
      expect(r.success).toBe(false);
      expect(r.code).toBe('wrong_conversation');
    } finally {
      t.cleanup();
    }
  });

  it('user unclaim forces status=todo regardless of prior status', async () => {
    const t = bootstrap();
    try {
      await createTask(t, t.alice.id, 'x');
      await t.service.claimTask({
        actor: { kind: 'agent', agentId: t.alice.id, conversationId: t.channel.id },
        by: { taskNumber: 1 },
      });
      // promote to in_review
      await t.service.updateStatus({
        actor: { kind: 'agent', agentId: t.alice.id, conversationId: t.channel.id },
        by: { taskNumber: 1 },
        status: 'in_review',
      });
      const msgId = await firstMsgId(t);
      const r = await t.service.unclaimTask({
        actor: { kind: 'user', userId: 'local' },
        by: { messageId: msgId },
      });
      expect(r.success).toBe(true);
      const fresh = t.service.getByMessageId(msgId, { kind: 'user', userId: null });
      expect(fresh?.status).toBe('todo');
      expect(fresh?.assignee).toBe(null);
    } finally {
      t.cleanup();
    }
  });

  it('user unclaim on non-task messageId → not_a_task', async () => {
    const t = bootstrap();
    try {
      const msg = t.messages.insertForConversation({
        conversationId: t.channel.id,
        fromKind: 'agent',
        fromAgentId: t.alice.id,
        content: 'not a task',
      });
      const r = await t.service.unclaimTask({
        actor: { kind: 'user', userId: 'local' },
        by: { messageId: msg.id },
      });
      expect(r.success).toBe(false);
      expect(r.code).toBe('not_a_task');
    } finally {
      t.cleanup();
    }
  });
});

describe('TaskService.updateStatus', () => {
  it('agent in_progress → in_review on own task', async () => {
    const t = bootstrap();
    try {
      await createTask(t, t.alice.id, 'x');
      await t.service.claimTask({
        actor: { kind: 'agent', agentId: t.alice.id, conversationId: t.channel.id },
        by: { taskNumber: 1 },
      });
      const r = await t.service.updateStatus({
        actor: { kind: 'agent', agentId: t.alice.id, conversationId: t.channel.id },
        by: { taskNumber: 1 },
        status: 'in_review',
      });
      expect(r).toEqual({ success: true });
    } finally {
      t.cleanup();
    }
  });

  it('agent invalid transition (in_progress → todo) → invalid_transition', async () => {
    const t = bootstrap();
    try {
      await createTask(t, t.alice.id, 'x');
      await t.service.claimTask({
        actor: { kind: 'agent', agentId: t.alice.id, conversationId: t.channel.id },
        by: { taskNumber: 1 },
      });
      const r = await t.service.updateStatus({
        actor: { kind: 'agent', agentId: t.alice.id, conversationId: t.channel.id },
        by: { taskNumber: 1 },
        status: 'todo',
      });
      expect(r.success).toBe(false);
      expect(r.code).toBe('invalid_transition');
    } finally {
      t.cleanup();
    }
  });

  it('agent updates non-self task → not_assignee', async () => {
    const t = bootstrap();
    try {
      await createTask(t, t.alice.id, 'x');
      await t.service.claimTask({
        actor: { kind: 'agent', agentId: t.bob.id, conversationId: t.channel.id },
        by: { taskNumber: 1 },
      });
      const r = await t.service.updateStatus({
        actor: { kind: 'agent', agentId: t.alice.id, conversationId: t.channel.id },
        by: { taskNumber: 1 },
        status: 'in_review',
      });
      expect(r.success).toBe(false);
      expect(r.code).toBe('not_assignee');
    } finally {
      t.cleanup();
    }
  });

  it('agent updates task in other conversation → wrong_conversation', async () => {
    const t = bootstrap();
    try {
      const other = t.conversations.insertChannel({
        workspaceId: t.workspace.id,
        workspacePath: t.workspace.workspace_path,
        title: 'other',
      });
      t.conversations.addAgent(other.id, t.alice.id);
      await t.service.createTasks({
        conversationId: other.id,
        actor: { kind: 'agent', agentId: t.alice.id, conversationId: other.id },
        tasks: [{ title: 'foreign' }],
      });
      const r = await t.service.updateStatus({
        actor: { kind: 'agent', agentId: t.alice.id, conversationId: t.channel.id },
        by: { taskNumber: 1 },
        status: 'in_review',
      });
      expect(r.success).toBe(false);
      expect(r.code).toBe('wrong_conversation');
    } finally {
      t.cleanup();
    }
  });

  it('user can override to any non-current status (todo → done)', async () => {
    const t = bootstrap();
    try {
      await createTask(t, t.alice.id, 'x');
      const msgId = await firstMsgId(t);
      const r = await t.service.updateStatus({
        actor: { kind: 'user', userId: 'local' },
        by: { messageId: msgId },
        status: 'done',
      });
      expect(r.success).toBe(true);
      const fresh = t.service.getByMessageId(msgId, { kind: 'user', userId: null });
      expect(fresh?.status).toBe('done');
    } finally {
      t.cleanup();
    }
  });

  it('user same status → already_at_status', async () => {
    const t = bootstrap();
    try {
      await createTask(t, t.alice.id, 'x');
      const msgId = await firstMsgId(t);
      const r = await t.service.updateStatus({
        actor: { kind: 'user', userId: 'local' },
        by: { messageId: msgId },
        status: 'todo',
      });
      expect(r.success).toBe(false);
      expect(r.code).toBe('already_at_status');
    } finally {
      t.cleanup();
    }
  });

  it('publish-first ordering for status change', async () => {
    const t = bootstrap();
    try {
      await createTask(t, t.alice.id, 'x');
      await t.service.claimTask({
        actor: { kind: 'agent', agentId: t.alice.id, conversationId: t.channel.id },
        by: { taskNumber: 1 },
      });
      const order: string[] = [];
      t.fake.hangDeliver = true;
      t.fake.onDeliver = () => order.push('deliver');
      const unsub = t.events.subscribe(t.channel.id, e => {
        if (e.kind === 'message') order.push('publish');
      });
      await t.service.updateStatus({
        actor: { kind: 'agent', agentId: t.alice.id, conversationId: t.channel.id },
        by: { taskNumber: 1 },
        status: 'in_review',
      });
      unsub();
      expect(order[0]).toBe('publish');
      expect(order).toContain('deliver');
    } finally {
      t.cleanup();
    }
  });
});

describe('TaskService.list / getByMessageId', () => {
  it('user list global sees tasks across all workspaces', async () => {
    const t = bootstrap();
    try {
      const ws2 = t.workspaces.insert({
        name: 'ws2',
        description: null,
        workspacePath: t.tmp.workspacesRoot,
        workspaceHostId: t.localHostId,
      });
      t.workspaces.addMember(ws2.id, t.alice.id);
      const ch2 = t.conversations.insertChannel({
        workspaceId: ws2.id,
        workspacePath: ws2.workspace_path,
        title: 'ch2',
      });
      t.conversations.addAgent(ch2.id, t.alice.id);
      await createTask(t, t.alice.id, 'task1');
      await t.service.createTasks({
        conversationId: ch2.id,
        actor: { kind: 'agent', agentId: t.alice.id, conversationId: ch2.id },
        tasks: [{ title: 'task2' }],
      });
      const r = t.service.list({ actor: { kind: 'user', userId: null } });
      expect(r.length).toBe(2);
    } finally {
      t.cleanup();
    }
  });

  it('user list filtered by workspaceId narrows to that workspace', async () => {
    const t = bootstrap();
    try {
      const ws2 = t.workspaces.insert({
        name: 'ws2',
        description: null,
        workspacePath: t.tmp.workspacesRoot,
        workspaceHostId: t.localHostId,
      });
      t.workspaces.addMember(ws2.id, t.alice.id);
      const ch2 = t.conversations.insertChannel({
        workspaceId: ws2.id,
        workspacePath: ws2.workspace_path,
        title: 'ch2',
      });
      t.conversations.addAgent(ch2.id, t.alice.id);
      await createTask(t, t.alice.id, 'task1');
      await t.service.createTasks({
        conversationId: ch2.id,
        actor: { kind: 'agent', agentId: t.alice.id, conversationId: ch2.id },
        tasks: [{ title: 'task2' }],
      });
      const r = t.service.list({
        actor: { kind: 'user', userId: null },
        workspaceId: ws2.id,
      });
      expect(r.length).toBe(1);
      expect(r[0]?.title).toBe('task2');
    } finally {
      t.cleanup();
    }
  });

  it('agent list ignores caller workspaceId, derives from actor.conversationId', async () => {
    const t = bootstrap();
    try {
      const ws2 = t.workspaces.insert({
        name: 'ws2',
        description: null,
        workspacePath: t.tmp.workspacesRoot,
        workspaceHostId: t.localHostId,
      });
      t.workspaces.addMember(ws2.id, t.alice.id);
      const ch2 = t.conversations.insertChannel({
        workspaceId: ws2.id,
        workspacePath: ws2.workspace_path,
        title: 'ch2',
      });
      t.conversations.addAgent(ch2.id, t.alice.id);
      await createTask(t, t.alice.id, 'in-channel');
      await t.service.createTasks({
        conversationId: ch2.id,
        actor: { kind: 'agent', agentId: t.alice.id, conversationId: ch2.id },
        tasks: [{ title: 'in-ch2' }],
      });
      // agent on `channel` tries to peek at ws2 — service ignores
      const r = t.service.list({
        actor: { kind: 'agent', agentId: t.alice.id, conversationId: t.channel.id },
        workspaceId: ws2.id, // ignored
      });
      expect(r.length).toBe(1);
      expect(r[0]?.title).toBe('in-channel');
    } finally {
      t.cleanup();
    }
  });

  it('agent list with conversationId filter inside actor workspace narrows', async () => {
    const t = bootstrap();
    try {
      const sibling = t.conversations.insertChannel({
        workspaceId: t.workspace.id,
        workspacePath: t.workspace.workspace_path,
        title: 'sibling',
      });
      t.conversations.addAgent(sibling.id, t.alice.id);
      await createTask(t, t.alice.id, 'main-task');
      await t.service.createTasks({
        conversationId: sibling.id,
        actor: { kind: 'agent', agentId: t.alice.id, conversationId: sibling.id },
        tasks: [{ title: 'sibling-task' }],
      });
      const r = t.service.list({
        actor: { kind: 'agent', agentId: t.alice.id, conversationId: t.channel.id },
        conversationId: sibling.id,
      });
      expect(r.length).toBe(1);
      expect(r[0]?.title).toBe('sibling-task');
    } finally {
      t.cleanup();
    }
  });

  it('agent list with conversationId pointing OUTSIDE actor workspace returns empty', async () => {
    const t = bootstrap();
    try {
      const ws2 = t.workspaces.insert({
        name: 'ws2',
        description: null,
        workspacePath: t.tmp.workspacesRoot,
        workspaceHostId: t.localHostId,
      });
      t.workspaces.addMember(ws2.id, t.alice.id);
      const ch2 = t.conversations.insertChannel({
        workspaceId: ws2.id,
        workspacePath: ws2.workspace_path,
        title: 'ch2',
      });
      t.conversations.addAgent(ch2.id, t.alice.id);
      await t.service.createTasks({
        conversationId: ch2.id,
        actor: { kind: 'agent', agentId: t.alice.id, conversationId: ch2.id },
        tasks: [{ title: 'foreign' }],
      });
      const r = t.service.list({
        actor: { kind: 'agent', agentId: t.alice.id, conversationId: t.channel.id },
        conversationId: ch2.id,
      });
      expect(r.length).toBe(0);
    } finally {
      t.cleanup();
    }
  });

  it('agent getByMessageId for task in another workspace returns null', async () => {
    const t = bootstrap();
    try {
      const ws2 = t.workspaces.insert({
        name: 'ws2',
        description: null,
        workspacePath: t.tmp.workspacesRoot,
        workspaceHostId: t.localHostId,
      });
      t.workspaces.addMember(ws2.id, t.alice.id);
      const ch2 = t.conversations.insertChannel({
        workspaceId: ws2.id,
        workspacePath: ws2.workspace_path,
        title: 'ch2',
      });
      t.conversations.addAgent(ch2.id, t.alice.id);
      const created = await t.service.createTasks({
        conversationId: ch2.id,
        actor: { kind: 'agent', agentId: t.alice.id, conversationId: ch2.id },
        tasks: [{ title: 'foreign' }],
      });
      if (!('tasks' in created)) throw new Error();
      const r = t.service.getByMessageId(created.tasks[0]!.message_id, {
        kind: 'agent',
        agentId: t.alice.id,
        conversationId: t.channel.id,
      });
      expect(r).toBe(null);
    } finally {
      t.cleanup();
    }
  });
});

describe('TaskService agent-actor validation', () => {
  it('createTasks: actor.conversationId mismatch → PrincipalConversationMismatchError (no insert)', async () => {
    const t = bootstrap();
    try {
      const other = t.conversations.insertChannel({
        workspaceId: t.workspace.id,
        workspacePath: t.workspace.workspace_path,
        title: 'other',
      });
      await expect(
        t.service.createTasks({
          conversationId: t.channel.id,
          actor: { kind: 'agent', agentId: t.alice.id, conversationId: other.id },
          tasks: [{ title: 'x' }],
        }),
      ).rejects.toBeInstanceOf(PrincipalConversationMismatchError);
      expect(t.service.list({ actor: { kind: 'user', userId: null } })).toEqual([]);
    } finally {
      t.cleanup();
    }
  });

  it('createTasks: unknown agent actor → agent_not_found', async () => {
    const t = bootstrap();
    try {
      const result = await t.service.createTasks({
        conversationId: t.channel.id,
        actor: { kind: 'agent', agentId: 'no-such-agent', conversationId: t.channel.id },
        tasks: [{ title: 'x' }],
      });
      expect(result).toEqual({ error: 'agent_not_found' });
    } finally {
      t.cleanup();
    }
  });

  it('claimTask: unknown agent actor → agent_not_found', async () => {
    const t = bootstrap();
    try {
      await createTask(t, t.alice.id, 't');
      const r = await t.service.claimTask({
        actor: { kind: 'agent', agentId: 'no-such-agent', conversationId: t.channel.id },
        by: { taskNumber: 1 },
      });
      expect(r.success).toBe(false);
      if (!r.success) expect(r.code).toBe('agent_not_found');
    } finally {
      t.cleanup();
    }
  });

  it('claimTask: agent not member of source conversation → not_conversation_member', async () => {
    const t = bootstrap();
    try {
      const outsider = t.agents.create({ name: 'out', runtime: 'claude' }, t.localHostId);
      await createTask(t, t.alice.id, 't');
      const r = await t.service.claimTask({
        actor: { kind: 'agent', agentId: outsider.id, conversationId: t.channel.id },
        by: { taskNumber: 1 },
      });
      expect(r.success).toBe(false);
      if (!r.success) expect(r.code).toBe('not_conversation_member');
    } finally {
      t.cleanup();
    }
  });

  it('unclaimTask: unknown agent actor → agent_not_found', async () => {
    const t = bootstrap();
    try {
      await createTask(t, t.alice.id, 't');
      await t.service.claimTask({
        actor: { kind: 'agent', agentId: t.alice.id, conversationId: t.channel.id },
        by: { taskNumber: 1 },
      });
      const r = await t.service.unclaimTask({
        actor: { kind: 'agent', agentId: 'no-such-agent', conversationId: t.channel.id },
        by: { taskNumber: 1 },
      });
      expect(r.success).toBe(false);
      if (!r.success) expect(r.code).toBe('agent_not_found');
    } finally {
      t.cleanup();
    }
  });

  it('unclaimTask: agent not member of source conversation → not_conversation_member', async () => {
    const t = bootstrap();
    try {
      const outsider = t.agents.create({ name: 'out', runtime: 'claude' }, t.localHostId);
      await createTask(t, t.alice.id, 't');
      await t.service.claimTask({
        actor: { kind: 'agent', agentId: t.alice.id, conversationId: t.channel.id },
        by: { taskNumber: 1 },
      });
      const r = await t.service.unclaimTask({
        actor: { kind: 'agent', agentId: outsider.id, conversationId: t.channel.id },
        by: { taskNumber: 1 },
      });
      expect(r.success).toBe(false);
      if (!r.success) expect(r.code).toBe('not_conversation_member');
    } finally {
      t.cleanup();
    }
  });

  it('updateStatus: unknown agent actor → agent_not_found', async () => {
    const t = bootstrap();
    try {
      await createTask(t, t.alice.id, 't');
      await t.service.claimTask({
        actor: { kind: 'agent', agentId: t.alice.id, conversationId: t.channel.id },
        by: { taskNumber: 1 },
      });
      const r = await t.service.updateStatus({
        actor: { kind: 'agent', agentId: 'no-such-agent', conversationId: t.channel.id },
        by: { taskNumber: 1 },
        status: 'in_review',
      });
      expect(r.success).toBe(false);
      if (!r.success) expect(r.code).toBe('agent_not_found');
    } finally {
      t.cleanup();
    }
  });

  it('updateStatus: agent not member of source conversation → not_conversation_member', async () => {
    const t = bootstrap();
    try {
      const outsider = t.agents.create({ name: 'out', runtime: 'claude' }, t.localHostId);
      await createTask(t, t.alice.id, 't');
      await t.service.claimTask({
        actor: { kind: 'agent', agentId: t.alice.id, conversationId: t.channel.id },
        by: { taskNumber: 1 },
      });
      const r = await t.service.updateStatus({
        actor: { kind: 'agent', agentId: outsider.id, conversationId: t.channel.id },
        by: { taskNumber: 1 },
        status: 'in_review',
      });
      expect(r.success).toBe(false);
      if (!r.success) expect(r.code).toBe('not_conversation_member');
    } finally {
      t.cleanup();
    }
  });

  it('unclaimTask by messageId: message in another conversation → wrong_conversation (no UPDATE)', async () => {
    const t = bootstrap();
    try {
      const other = t.conversations.insertChannel({
        workspaceId: t.workspace.id,
        workspacePath: t.workspace.workspace_path,
        title: 'other',
      });
      t.conversations.addAgent(other.id, t.alice.id);
      // Create + claim the task in the OTHER conversation.
      const create = await t.service.createTasks({
        conversationId: other.id,
        actor: { kind: 'agent', agentId: t.alice.id, conversationId: other.id },
        tasks: [{ title: 'foreign' }],
      });
      if (!('tasks' in create)) throw new Error();
      const messageId = create.tasks[0]!.message_id;
      await t.service.claimTask({
        actor: { kind: 'agent', agentId: t.alice.id, conversationId: other.id },
        by: { taskNumber: 1 },
      });
      // Now try to unclaim it as if from t.channel.id — must be rejected.
      const r = await t.service.unclaimTask({
        actor: { kind: 'agent', agentId: t.alice.id, conversationId: t.channel.id },
        by: { messageId },
      });
      expect(r.success).toBe(false);
      if (!r.success) expect(r.code).toBe('wrong_conversation');
      // Task in other conv is still claimed by alice.
      const list = t.service.list({ actor: { kind: 'user', userId: null } });
      expect(list[0]!.assignee?.id).toBe(t.alice.id);
    } finally {
      t.cleanup();
    }
  });

  it('updateStatus by messageId: message in another conversation → wrong_conversation (no UPDATE)', async () => {
    const t = bootstrap();
    try {
      const other = t.conversations.insertChannel({
        workspaceId: t.workspace.id,
        workspacePath: t.workspace.workspace_path,
        title: 'other',
      });
      t.conversations.addAgent(other.id, t.alice.id);
      const create = await t.service.createTasks({
        conversationId: other.id,
        actor: { kind: 'agent', agentId: t.alice.id, conversationId: other.id },
        tasks: [{ title: 'foreign' }],
      });
      if (!('tasks' in create)) throw new Error();
      const messageId = create.tasks[0]!.message_id;
      await t.service.claimTask({
        actor: { kind: 'agent', agentId: t.alice.id, conversationId: other.id },
        by: { taskNumber: 1 },
      });
      const r = await t.service.updateStatus({
        actor: { kind: 'agent', agentId: t.alice.id, conversationId: t.channel.id },
        by: { messageId },
        status: 'in_review',
      });
      expect(r.success).toBe(false);
      if (!r.success) expect(r.code).toBe('wrong_conversation');
      // Status unchanged.
      const list = t.service.list({ actor: { kind: 'user', userId: null } });
      expect(list[0]!.status).toBe('in_progress');
    } finally {
      t.cleanup();
    }
  });
});

describe('TaskService workspace-scope event', () => {
  it('task_changed fires for both conversation and workspace scopes per mutation', async () => {
    const t = bootstrap();
    try {
      const convEvents: string[] = [];
      const wsEvents: string[] = [];
      t.events.subscribe(t.channel.id, e => {
        if (e.kind === 'task_changed') convEvents.push('conv');
      });
      t.events.subscribeScope(`workspace:${t.workspace.id}`, e => {
        if (e.kind === 'task_changed') wsEvents.push('ws');
      });
      await createTask(t, t.alice.id, 'x');
      await t.service.claimTask({
        actor: { kind: 'agent', agentId: t.alice.id, conversationId: t.channel.id },
        by: { taskNumber: 1 },
      });
      await t.service.updateStatus({
        actor: { kind: 'agent', agentId: t.alice.id, conversationId: t.channel.id },
        by: { taskNumber: 1 },
        status: 'in_review',
      });
      expect(convEvents.length).toBe(3);
      expect(wsEvents.length).toBe(3);
    } finally {
      t.cleanup();
    }
  });
});

async function firstMsgId(t: ReturnType<typeof bootstrap>): Promise<string> {
  const row = t.db
    .prepare<[], { id: string }>(
      `SELECT id FROM messages WHERE task_number = 1 ORDER BY created_at ASC LIMIT 1`,
    )
    .get();
  if (!row) throw new Error('no task message found');
  return row.id;
}

function fetchSystemMetadata(
  t: ReturnType<typeof bootstrap>,
  subtype: string,
): Record<string, unknown>[] {
  const rows = t.db
    .prepare<[], { metadata: string | null }>(
      `SELECT metadata FROM messages WHERE from_kind = 'system' ORDER BY created_at ASC, id ASC`,
    )
    .all();
  return rows
    .map(r => (r.metadata ? (JSON.parse(r.metadata) as Record<string, unknown>) : null))
    .filter((m): m is Record<string, unknown> =>
      m !== null && (m as { subtype?: string }).subtype === subtype,
    );
}

describe('TaskService system message metadata enrichment (PR-2)', () => {
  it('task_create writes full enriched metadata: subtype, task_message_id, title, status, assignee, actor', async () => {
    const t = bootstrap();
    try {
      const result = await t.service.createTasks({
        conversationId: t.channel.id,
        actor: { kind: 'agent', agentId: t.alice.id, conversationId: t.channel.id },
        tasks: [{ title: 'task-create-meta' }],
      });
      if (!('tasks' in result)) throw new Error();
      const created = result.tasks[0]!;

      const rows = fetchSystemMetadata(t, 'task_create');
      expect(rows.length).toBe(1);
      const meta = readTaskSystemMetadata(rows[0]!);
      expect(meta).not.toBeNull();
      expect(meta!.subtype).toBe('task_create');
      expect(meta!.task_number).toBe(created.task_number);
      expect(meta!.task_message_id).toBe(created.message_id);
      expect(meta!.task_title).toBe('task-create-meta');
      expect(meta!.task_status).toBe('todo');
      expect(meta!.task_assignee).toBeNull();
      expect(meta!.actor.kind).toBe('agent');
      if (meta!.actor.kind !== 'agent') throw new Error();
      expect(meta!.actor.id).toBe(t.alice.id);
      expect(meta!.actor.name).toBeTypeOf('string');
    } finally {
      t.cleanup();
    }
  });

  it('task_claim writes after-state status=in_progress + assignee snapshot', async () => {
    const t = bootstrap();
    try {
      await createTask(t, t.bob.id, 'task-claim-meta');
      await t.service.claimTask({
        actor: { kind: 'agent', agentId: t.alice.id, conversationId: t.channel.id },
        by: { taskNumber: 1 },
      });
      const rows = fetchSystemMetadata(t, 'task_claim');
      expect(rows.length).toBe(1);
      const meta = readTaskSystemMetadata(rows[0]!);
      expect(meta).not.toBeNull();
      expect(meta!.subtype).toBe('task_claim');
      expect(meta!.task_status).toBe('in_progress');
      expect(meta!.task_assignee).not.toBeNull();
      expect(meta!.task_assignee!.id).toBe(t.alice.id);
      expect(meta!.actor.kind).toBe('agent');
      if (meta!.actor.kind !== 'agent') throw new Error();
      expect(meta!.actor.id).toBe(t.alice.id);
      expect(meta!.task_message_id).toBeTypeOf('string');
      expect(meta!.task_title).toBe('task-claim-meta');
    } finally {
      t.cleanup();
    }
  });

  it('task_unclaim writes after-state status=todo + assignee=null', async () => {
    const t = bootstrap();
    try {
      await createTask(t, t.alice.id, 'task-unclaim-meta');
      await t.service.claimTask({
        actor: { kind: 'agent', agentId: t.alice.id, conversationId: t.channel.id },
        by: { taskNumber: 1 },
      });
      await t.service.unclaimTask({
        actor: { kind: 'agent', agentId: t.alice.id, conversationId: t.channel.id },
        by: { taskNumber: 1 },
      });
      const rows = fetchSystemMetadata(t, 'task_unclaim');
      expect(rows.length).toBe(1);
      const meta = readTaskSystemMetadata(rows[0]!);
      expect(meta).not.toBeNull();
      expect(meta!.subtype).toBe('task_unclaim');
      expect(meta!.task_status).toBe('todo');
      expect(meta!.task_assignee).toBeNull();
      expect(meta!.actor.kind).toBe('agent');
      if (meta!.actor.kind !== 'agent') throw new Error();
      expect(meta!.actor.id).toBe(t.alice.id);
    } finally {
      t.cleanup();
    }
  });

  it('task_status writes after-state status snapshot from agent transition', async () => {
    const t = bootstrap();
    try {
      await createTask(t, t.alice.id, 'task-status-meta');
      await t.service.claimTask({
        actor: { kind: 'agent', agentId: t.alice.id, conversationId: t.channel.id },
        by: { taskNumber: 1 },
      });
      await t.service.updateStatus({
        actor: { kind: 'agent', agentId: t.alice.id, conversationId: t.channel.id },
        by: { taskNumber: 1 },
        status: 'in_review',
      });
      const rows = fetchSystemMetadata(t, 'task_status');
      expect(rows.length).toBe(1);
      const meta = readTaskSystemMetadata(rows[0]!);
      expect(meta).not.toBeNull();
      expect(meta!.subtype).toBe('task_status');
      expect(meta!.task_status).toBe('in_review');
      expect(meta!.actor.kind).toBe('agent');
      if (meta!.actor.kind !== 'agent') throw new Error();
      expect(meta!.actor.id).toBe(t.alice.id);
    } finally {
      t.cleanup();
    }
  });

  it('user actor produces actor.kind=user (id=null for legacy) on user-driven mutations', async () => {
    const t = bootstrap();
    try {
      await createTask(t, t.alice.id, 'user-actor-meta');
      const msgId = await firstMsgId(t);
      await t.service.unclaimTask({
        actor: { kind: 'user', userId: null },
        by: { messageId: msgId },
      });
      const rows = fetchSystemMetadata(t, 'task_unclaim');
      expect(rows.length).toBe(1);
      const meta = readTaskSystemMetadata(rows[0]!);
      expect(meta).not.toBeNull();
      expect(meta!.actor.kind).toBe('user');
      if (meta!.actor.kind !== 'user') throw new Error();
      expect(meta!.actor.id).toBeNull();
      expect(meta!.actor.name).toBe('user');
    } finally {
      t.cleanup();
    }
  });

  it('agent actor uses display_name when set', async () => {
    const t = bootstrap();
    try {
      t.agents.update(t.alice.id, { display_name: 'Alice the Architect' });
      await createTask(t, t.alice.id, 'display-name-meta');
      const rows = fetchSystemMetadata(t, 'task_create');
      const meta = readTaskSystemMetadata(rows[0]!);
      expect(meta!.actor.kind).toBe('agent');
      if (meta!.actor.kind !== 'agent') throw new Error();
      expect(meta!.actor.name).toBe('Alice the Architect');
    } finally {
      t.cleanup();
    }
  });
});
