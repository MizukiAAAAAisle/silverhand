import { describe, expect, it, vi } from 'vitest';
import {
  fixedConversationTitle,
  readTaskSystemMetadata,
  type CreateTasksResult,
} from '@silverhand/shared';
import { AgentRepo } from '../../src/repos/agent-repo.js';
import { ConversationRepo } from '../../src/repos/conversation-repo.js';
import { HostRepo } from '../../src/repos/host-repo.js';
import { MessageRepo } from '../../src/repos/message-repo.js';
import { WorkspaceRepo } from '../../src/repos/workspace-repo.js';
import { createSqliteTaskPersistence } from '../../src/repos/task-persistence.js';
import { TaskService, type TaskServiceOptions } from '../../src/services/task-service.js';
import type { BackendLogger } from '../../src/context.js';
import type { AgentRuntimeHost } from '../../src/runtime/agent-runtime-host.js';
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

function bootstrap(
  capChecker: (
    actor: { agentId: string },
    workspaceId: string,
    capability: string,
  ) => boolean = () => true,
) {
  const { db, localHostId } = openTestDb();
  const tmp = makeTempSilverhandDir();
  new HostRepo(db).ensureLocal();
  const agents = new AgentRepo(db);
  const workspaces = new WorkspaceRepo(db);
  const conversations = new ConversationRepo(db);
  const messages = new MessageRepo(db);
  const events = new ScopeEventBus('test-epoch');
  const fake = new FakeConversationManager();
  const logger: BackendLogger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
  const taskPersistence = createSqliteTaskPersistence(db, { messages });
  const service = new TaskService({
    read: taskPersistence.read,
    board: taskPersistence.board,
    conversations: taskPersistence.conversations,
    uow: taskPersistence.uow,
    agents,
    workspaces,
    runtimeHost: fake as unknown as AgentRuntimeHost,
    events,
    logger,
    canUseCapability: capChecker as unknown as TaskServiceOptions['canUseCapability'],
  });

  const workspace = workspaces.insert({
    name: 'eng',
    description: null,
  });
  const alice = agents.create({ name: 'alice', runtime: 'claude' }, localHostId, 'local');
  const bob = agents.create({ name: 'bob', runtime: 'claude' }, localHostId, 'local');
  workspaces.insertMembership(workspace.id, alice.id);
  workspaces.insertMembership(workspace.id, bob.id);
  const channel = conversations.insertChannel({
    workspaceId: workspace.id,
    title: fixedConversationTitle('main'),
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

/** Extract the created task's identity (`tasks.id`) — the canonical key that
 *  replaced the old anchor `message_id` when a task became a first-class
 *  aggregate. */
function taskId(r: CreateTasksResult): string {
  if (!('tasks' in r)) throw new Error('createTasks failed');
  return r.tasks[0]!.id;
}

/** Re-fetch a task's current state as the local user, keyed by task id. */
function refetch(t: ReturnType<typeof bootstrap>, id: string) {
  return t.service.getTaskDetail(id, { kind: 'user', userId: 'local' });
}

describe('TaskService.createTasks', () => {
  it('agent member creates 2 tasks: monotonic per workspace, broadcasts message + task_changed', async () => {
    const t = bootstrap();
    try {
      const conversationEvents: Array<{ kind: string }> = [];
      const viewerEvents: Array<{ kind: string }> = [];
      const unsubA = t.events.subscribe(t.channel.id, e =>
        conversationEvents.push({ kind: e.kind }),
      );
      // Cross-conversation board fanout is per-viewer (member-gated), not
      // workspace-wide. 'local' is a human member of the task channel.
      const unsubB = t.events.subscribeScope(`viewer:local`, e =>
        viewerEvents.push({ kind: e.kind }),
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
      expect(viewerEvents.filter(e => e.kind === 'task_changed').length).toBe(2);
    } finally {
      t.cleanup();
    }
  });

  it('createTasks with a thread target places the task + task_create event in that thread stream', async () => {
    const t = bootstrap();
    try {
      const root = t.messages.insertForConversation({
        conversationId: t.channel.id,
        fromKind: 'agent',
        fromAgentId: t.bob.id,
        content: 'root message',
      });
      const reply = t.messages.insertForConversation({
        conversationId: t.channel.id,
        fromKind: 'agent',
        fromAgentId: t.bob.id,
        content: 'existing reply',
        threadRootId: root.id,
      });

      const result = await t.service.createTasks({
        conversationId: t.channel.id,
        actor: { kind: 'agent', agentId: t.alice.id, conversationId: t.channel.id },
        tasks: [{ title: 'thread task' }],
        target: { kind: 'thread', message_id: reply.id },
      });

      expect('tasks' in result).toBe(true);
      if (!('tasks' in result)) throw new Error();
      const id = result.tasks[0]!.id;
      // The task aggregate row records the thread placement.
      const taskRow = t.db
        .prepare<[string], { thread_root_id: string | null }>(
          `SELECT thread_root_id FROM tasks WHERE id = ?`,
        )
        .get(id);
      expect(taskRow?.thread_root_id).toBe(root.id);
      const summaries = t.service.list({
        actor: { kind: 'user', userId: 'local' },
      });
      expect(summaries.find(x => x.id === id)).toMatchObject({
        thread_root_id: root.id,
      });

      const createRows = fetchSystemRows(t, 'task_create');
      expect(createRows).toHaveLength(1);
      expect(readTaskSystemMetadata(createRows[0]!.metadata)?.task_id).toBe(id);
      expect(createRows[0]!.thread_root_id).toBe(root.id);
    } finally {
      t.cleanup();
    }
  });

  it('createTasks with a missing or cross-conversation thread target fails without inserting', async () => {
    const t = bootstrap();
    try {
      const other = t.conversations.insertChannel({
        workspaceId: t.workspace.id,
        title: fixedConversationTitle('other'),
      });
      t.conversations.addAgent(other.id, t.alice.id);
      const otherMsg = t.messages.insertForConversation({
        conversationId: other.id,
        fromKind: 'agent',
        fromAgentId: t.alice.id,
        content: 'other channel message',
      });

      const missing = await t.service.createTasks({
        conversationId: t.channel.id,
        actor: { kind: 'agent', agentId: t.alice.id, conversationId: t.channel.id },
        tasks: [{ title: 'missing target' }],
        target: { kind: 'thread', message_id: 'missing-message' },
      });
      expect(missing).toEqual({ error: 'reply_target_not_found' });

      const cross = await t.service.createTasks({
        conversationId: t.channel.id,
        actor: { kind: 'agent', agentId: t.alice.id, conversationId: t.channel.id },
        tasks: [{ title: 'cross target' }],
        target: { kind: 'thread', message_id: otherMsg.id },
      });
      expect(cross).toEqual({ error: 'reply_target_not_found' });

      const count = t.db
        .prepare<[], { count: number }>(`SELECT COUNT(*) AS count FROM tasks`)
        .get();
      expect(count?.count).toBe(0);
    } finally {
      t.cleanup();
    }
  });

  it('agent not in conversation → not_conversation_member, no insert', async () => {
    const t = bootstrap();
    try {
      const outsider = t.agents.create({ name: 'out', runtime: 'claude' }, t.localHostId, 'local');
      const result = await t.service.createTasks({
        conversationId: t.channel.id,
        actor: { kind: 'agent', agentId: outsider.id, conversationId: t.channel.id },
        tasks: [{ title: 'x' }],
      });
      expect(result).toEqual({ error: 'not_conversation_member' });
      expect(t.service.list({ actor: { kind: 'user', userId: 'local' } })).toEqual([]);
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

  it('conversation archived → conversation_archived (agent path; shared write invariant)', async () => {
    const t = bootstrap();
    try {
      const countTasks = () =>
        (
          t.db
            .prepare(`SELECT COUNT(*) AS n FROM tasks WHERE conversation_id = ?`)
            .get(t.channel.id) as { n: number }
        ).n;
      const countSys = () =>
        (
          t.db
            .prepare(`SELECT COUNT(*) AS n FROM messages WHERE conversation_id = ? AND from_kind = 'system'`)
            .get(t.channel.id) as { n: number }
        ).n;
      const tasksBefore = countTasks();
      const sysBefore = countSys();
      t.db.prepare(`UPDATE conversations SET archived_at = ? WHERE id = ?`)
        .run(Date.now(), t.channel.id);
      const result = await t.service.createTasks({
        conversationId: t.channel.id,
        actor: { kind: 'agent', agentId: t.alice.id, conversationId: t.channel.id },
        tasks: [{ title: 'x' }],
      });
      expect(result).toEqual({ error: 'conversation_archived' });
      // Zero task, zero event: the reject is in the shared service, so the
      // agent create path never lands a row or `task_create` event in an
      // archived conversation — same as the ordinary message write path. Count
      // BOTH the tasks table and the system event: a system-message delta alone
      // would miss a future branch that inserts the row before returning.
      expect(countTasks() - tasksBefore).toBe(0);
      expect(countSys() - sysBefore).toBe(0);
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
      const created = await createTask(t, t.bob.id, 'task-1');
      const id = taskId(created);
      const r = await t.service.claimTask({
        actor: { kind: 'agent', agentId: t.alice.id, conversationId: t.channel.id },
        by: { taskNumber: 1 },
      });
      expect(r).toMatchObject({ success: true, task_number: 1, id });
      const fresh = refetch(t, id);
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

  it('claim task in another conversation (same workspace) → succeeds (cross-channel allowed)', async () => {
    const t = bootstrap();
    try {
      const other = t.conversations.insertChannel({
        workspaceId: t.workspace.id,
        title: fixedConversationTitle('other'),
      });
      t.conversations.addAgent(other.id, t.alice.id);
      // create task in `other`
      const created = await t.service.createTasks({
        conversationId: other.id,
        actor: { kind: 'agent', agentId: t.alice.id, conversationId: other.id },
        tasks: [{ title: 'foreign' }],
      });
      const id = taskId(created);
      // alice claims from `channel`; since both convs share workspace,
      // the cross-channel lift gates this through (#task:530).
      const r = await t.service.claimTask({
        actor: { kind: 'agent', agentId: t.alice.id, conversationId: t.channel.id },
        by: { taskNumber: 1 },
      });
      expect(r.success).toBe(true);
      // Task now assigned to alice.
      const fresh = refetch(t, id);
      expect(fresh?.assignee?.id).toBe(t.alice.id);
      expect(fresh?.conversation.id).toBe(other.id);
    } finally {
      t.cleanup();
    }
  });

  it('claim done task → task_done', async () => {
    const t = bootstrap();
    try {
      const created = await createTask(t, t.alice.id, 'x');
      const id = taskId(created);
      // mark done directly
      t.db.prepare(`UPDATE tasks SET status = 'done' WHERE id = ?`).run(id);
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
      const id = taskId(created);
      // simulate a task in in_review (could happen if user assigned then agent moved)
      t.db.prepare(`UPDATE tasks SET status = 'in_review' WHERE id = ?`).run(id);
      const r = await t.service.claimTask({
        actor: { kind: 'agent', agentId: t.alice.id, conversationId: t.channel.id },
        by: { taskNumber: 1 },
      });
      expect(r.success).toBe(true);
      const fresh = refetch(t, id);
      expect(fresh?.status).toBe('in_review');
    } finally {
      t.cleanup();
    }
  });
  it('agent claim on a migrated user-assigned row → already_claimed, no write, no broadcast', async () => {
    const t = bootstrap();
    try {
      const created = await createTask(t, t.bob.id, 'x');
      const id = taskId(created);
      // A user assignee only exists on migrated rows, but it is a legal
      // persisted fact: the row HAS an owner. Claiming must fail typed, not
      // write a second assignee onto the row (schema CHECK → raw SQLite error).
      t.db.prepare(`UPDATE tasks SET assignee_user_id = 'local' WHERE id = ?`).run(id);

      const seen: string[] = [];
      const unsub = t.events.subscribe(t.channel.id, e => seen.push(e.kind));
      try {
        const r = await t.service.claimTask({
          actor: { kind: 'agent', agentId: t.alice.id, conversationId: t.channel.id },
          by: { taskNumber: 1 },
        });
        expect(r.success).toBe(false);
        expect(r.code).toBe('already_claimed');
      } finally {
        unsub();
      }
      const fresh = refetch(t, id);
      expect(fresh?.assignee?.type).toBe('user');
      expect(fresh?.status).toBe('todo');
      expect(seen).toEqual([]);
    } finally {
      t.cleanup();
    }
  });
});

describe('TaskService.claimTask — user actor', () => {
  it('user claim with agentId on todo task → assignee set AND status in_progress (dispatch)', async () => {
    const t = bootstrap();
    try {
      const created = await createTask(t, t.alice.id, 'x');
      const id = taskId(created);
      const r = await t.service.claimTask({
        actor: { kind: 'user', userId: 'local' },
        by: { taskId: id },
        assignee: { agentId: t.bob.id },
      });
      expect(r.success).toBe(true);
      const fresh = refetch(t, id);
      // Handing a `todo` task to an agent IS dispatching it: `todo + assignee`
      // has no legal exit (`task status` cannot walk `todo → in_progress` and
      // `assignSelf` refuses an assigned row), so the two writes are atomic.
      expect(fresh?.status).toBe('in_progress');
      expect(fresh?.assignee?.id).toBe(t.bob.id);
    } finally {
      t.cleanup();
    }
  });

  it('user claim on an in_review task only changes hands (dispatch never rewinds)', async () => {
    const t = bootstrap();
    try {
      const created = await createTask(t, t.alice.id, 'x');
      const id = taskId(created);
      await t.service.claimTask({
        actor: { kind: 'agent', agentId: t.bob.id, conversationId: t.channel.id },
        by: { taskNumber: 1 },
      });
      await t.service.updateStatus({
        actor: { kind: 'user', userId: 'local' },
        by: { taskId: id },
        status: 'in_review',
      });

      const r = await t.service.claimTask({
        actor: { kind: 'user', userId: 'local' },
        by: { taskId: id },
        assignee: { agentId: t.alice.id },
      });
      expect(r.success).toBe(true);
      const fresh = refetch(t, id);
      // Reassignment is not a restart: pulling this back to `in_progress` would
      // drop it out of the human approval queue.
      expect(fresh?.status).toBe('in_review');
      expect(fresh?.assignee?.id).toBe(t.alice.id);
    } finally {
      t.cleanup();
    }
  });

  it('user claim replaces a legacy user assignee (never two assignees on a row)', async () => {
    const t = bootstrap();
    try {
      const created = await createTask(t, t.alice.id, 'x');
      const id = taskId(created);
      // Migrated rows are the only source of a user assignee; the schema CHECK
      // allows at most one, so the assignment write has to clear the other col.
      t.db
        .prepare(`UPDATE tasks SET assignee_user_id = 'local' WHERE id = ?`)
        .run(id);

      const r = await t.service.claimTask({
        actor: { kind: 'user', userId: 'local' },
        by: { taskId: id },
        assignee: { agentId: t.bob.id },
      });
      expect(r.success).toBe(true);
      const fresh = refetch(t, id);
      expect(fresh?.assignee?.type).toBe('agent');
      expect(fresh?.assignee?.id).toBe(t.bob.id);
      // Still a dispatch: a migrated `todo` row is started as well.
      expect(fresh?.status).toBe('in_progress');
    } finally {
      t.cleanup();
    }
  });

  it('user claim on a `done` task → task_done (assignment is frozen in terminal states)', async () => {
    const t = bootstrap();
    try {
      const created = await createTask(t, t.alice.id, 'x');
      const id = taskId(created);
      await t.service.updateStatus({
        actor: { kind: 'user', userId: 'local' },
        by: { taskId: id },
        status: 'done',
      });
      const r = await t.service.claimTask({
        actor: { kind: 'user', userId: 'local' },
        by: { taskId: id },
        assignee: { agentId: t.bob.id },
      });
      expect(r.success).toBe(false);
      expect(r.code).toBe('task_done');
      expect(refetch(t, id)?.assignee).toBe(null);
    } finally {
      t.cleanup();
    }
  });

  it('user claim with agentId on in_progress task → assignee overridden, status preserved', async () => {
    const t = bootstrap();
    try {
      const created = await createTask(t, t.alice.id, 'x');
      const id = taskId(created);
      // bob claims first
      await t.service.claimTask({
        actor: { kind: 'agent', agentId: t.bob.id, conversationId: t.channel.id },
        by: { taskNumber: 1 },
      });
      // user reassigns to alice
      const r = await t.service.claimTask({
        actor: { kind: 'user', userId: 'local' },
        by: { taskId: id },
        assignee: { agentId: t.alice.id },
      });
      expect(r.success).toBe(true);
      const fresh = refetch(t, id);
      expect(fresh?.status).toBe('in_progress');
      expect(fresh?.assignee?.id).toBe(t.alice.id);
    } finally {
      t.cleanup();
    }
  });

  it('user claim assigning to agent not in conversation → assignee_not_conversation_member', async () => {
    const t = bootstrap();
    try {
      const created = await createTask(t, t.alice.id, 'x');
      const id = taskId(created);
      const outsider = t.agents.create({ name: 'out', runtime: 'claude' }, t.localHostId, 'local');
      const r = await t.service.claimTask({
        actor: { kind: 'user', userId: 'local' },
        by: { taskId: id },
        assignee: { agentId: outsider.id },
      });
      expect(r.success).toBe(false);
      expect(r.code).toBe('assignee_not_conversation_member');
    } finally {
      t.cleanup();
    }
  });
});

describe('TaskService.unclaimTask', () => {
  it('agent unclaim of self-owned task → assignee=null, status=todo', async () => {
    const t = bootstrap();
    try {
      const created = await createTask(t, t.alice.id, 'x');
      const id = taskId(created);
      await t.service.claimTask({
        actor: { kind: 'agent', agentId: t.alice.id, conversationId: t.channel.id },
        by: { taskNumber: 1 },
      });
      const r = await t.service.unclaimTask({
        actor: { kind: 'agent', agentId: t.alice.id, conversationId: t.channel.id },
        by: { taskNumber: 1 },
      });
      expect(r).toEqual({ success: true });
      const fresh = refetch(t, id);
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

  it('agent unclaim cross-channel (same workspace) → succeeds when actor is assignee', async () => {
    const t = bootstrap();
    try {
      const other = t.conversations.insertChannel({
        workspaceId: t.workspace.id,
        title: fixedConversationTitle('other'),
      });
      t.conversations.addAgent(other.id, t.alice.id);
      // Alice creates AND claims in `other`.
      await t.service.createTasks({
        conversationId: other.id,
        actor: { kind: 'agent', agentId: t.alice.id, conversationId: other.id },
        tasks: [{ title: 'foreign' }],
      });
      await t.service.claimTask({
        actor: { kind: 'agent', agentId: t.alice.id, conversationId: other.id },
        by: { taskNumber: 1 },
      });
      // Now unclaim from `channel` — cross-channel within workspace.
      const r = await t.service.unclaimTask({
        actor: { kind: 'agent', agentId: t.alice.id, conversationId: t.channel.id },
        by: { taskNumber: 1 },
      });
      expect(r.success).toBe(true);
      const list = t.service.list({ actor: { kind: 'user', userId: 'local' } });
      expect(list[0]!.assignee).toBe(null);
      expect(list[0]!.status).toBe('todo');
    } finally {
      t.cleanup();
    }
  });

  it('user unclaim clears the assignee and leaves a non-terminal status untouched', async () => {
    for (const status of ['todo', 'in_progress', 'in_review'] as const) {
      const t = bootstrap();
      try {
        const created = await createTask(t, t.alice.id, 'x');
        const id = taskId(created);
        // Agent claim assigns and lifts todo → in_progress; the human status
        // override then parks the task in the status under test (the assignee
        // survives a status write).
        await t.service.claimTask({
          actor: { kind: 'agent', agentId: t.alice.id, conversationId: t.channel.id },
          by: { taskNumber: 1 },
        });
        if (status !== 'in_progress') {
          await t.service.updateStatus({
            actor: { kind: 'user', userId: 'local' },
            by: { taskId: id },
            status,
          });
        }
        expect(refetch(t, id)?.assignee?.id).toBe(t.alice.id);

        const r = await t.service.unclaimTask({
          actor: { kind: 'user', userId: 'local' },
          by: { taskId: id },
        });
        expect(r).toEqual({ success: true });
        const fresh = refetch(t, id);
        expect(fresh?.assignee).toBe(null);
        expect(fresh?.status).toBe(status);
        expect(fresh?.closed_at).toBe(null);
      } finally {
        t.cleanup();
      }
    }
  });

  it('user unclaim clears a user assignee too (one DTO field, one write)', async () => {
    const t = bootstrap();
    try {
      const created = await createTask(t, t.alice.id, 'x');
      const id = taskId(created);
      // Only migrated rows carry a user assignee — no live write path sets it,
      // but the DTO still surfaces it as `assignee`, so clearing must reach it.
      t.db
        .prepare(
          `UPDATE tasks SET assignee_agent_id = NULL, assignee_user_id = 'local' WHERE id = ?`,
        )
        .run(id);
      expect(refetch(t, id)?.assignee?.type).toBe('user');

      const r = await t.service.unclaimTask({
        actor: { kind: 'user', userId: 'local' },
        by: { taskId: id },
      });
      expect(r).toEqual({ success: true });
      expect(refetch(t, id)?.assignee).toBe(null);
    } finally {
      t.cleanup();
    }
  });

  it('user unclaim on a terminal task is refused: no write, no broadcast', async () => {
    for (const [status, code] of [
      ['done', 'task_done'],
      ['closed', 'task_closed'],
    ] as const) {
      const t = bootstrap();
      try {
        const created = await createTask(t, t.alice.id, 'x');
        const id = taskId(created);
        await t.service.claimTask({
          actor: { kind: 'agent', agentId: t.alice.id, conversationId: t.channel.id },
          by: { taskNumber: 1 },
        });
        await t.service.updateStatus({
          actor: { kind: 'user', userId: 'local' },
          by: { taskId: id },
          status,
        });
        const before = refetch(t, id);

        const seen: string[] = [];
        const unsub = t.events.subscribe(t.channel.id, e => seen.push(e.kind));
        const r = await t.service.unclaimTask({
          actor: { kind: 'user', userId: 'local' },
          by: { taskId: id },
        });
        unsub();

        expect(r.success).toBe(false);
        expect(r.code).toBe(code);
        expect(seen).toEqual([]);
        const after = refetch(t, id);
        expect(after?.assignee?.id).toBe(t.alice.id);
        expect(after?.status).toBe(status);
        expect(after?.closed_at).toBe(before?.closed_at ?? null);
      } finally {
        t.cleanup();
      }
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

  it('agent can close and reopen its own task through status', async () => {
    const t = bootstrap();
    try {
      const created = await createTask(t, t.alice.id, 'x');
      const id = taskId(created);
      await t.service.claimTask({
        actor: { kind: 'agent', agentId: t.alice.id, conversationId: t.channel.id },
        by: { taskNumber: 1 },
      });
      const closed = await t.service.updateStatus({
        actor: { kind: 'agent', agentId: t.alice.id, conversationId: t.channel.id },
        by: { taskNumber: 1 },
        status: 'closed',
      });
      expect(closed).toEqual({ success: true });
      const closedItem = t.service.list({
        actor: { kind: 'user', userId: 'local' },
        status: ['closed'],
      })[0]!;
      expect(closedItem.status).toBe('closed');
      expect(closedItem.closed_at).toEqual(expect.any(Number));

      const reopened = await t.service.updateStatus({
        actor: { kind: 'agent', agentId: t.alice.id, conversationId: t.channel.id },
        by: { taskNumber: 1 },
        status: 'todo',
      });
      expect(reopened).toEqual({ success: true });
      const fresh = refetch(t, id);
      expect(fresh?.status).toBe('todo');
      expect(fresh?.closed_at).toBeNull();
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

  it('agent updates task in other conversation (same workspace) → succeeds when assignee', async () => {
    const t = bootstrap();
    try {
      const other = t.conversations.insertChannel({
        workspaceId: t.workspace.id,
        title: fixedConversationTitle('other'),
      });
      t.conversations.addAgent(other.id, t.alice.id);
      await t.service.createTasks({
        conversationId: other.id,
        actor: { kind: 'agent', agentId: t.alice.id, conversationId: other.id },
        tasks: [{ title: 'foreign' }],
      });
      await t.service.claimTask({
        actor: { kind: 'agent', agentId: t.alice.id, conversationId: other.id },
        by: { taskNumber: 1 },
      });
      const r = await t.service.updateStatus({
        actor: { kind: 'agent', agentId: t.alice.id, conversationId: t.channel.id },
        by: { taskNumber: 1 },
        status: 'in_review',
      });
      expect(r.success).toBe(true);
      const list = t.service.list({ actor: { kind: 'user', userId: 'local' } });
      expect(list[0]!.status).toBe('in_review');
    } finally {
      t.cleanup();
    }
  });

  it('user can override to any non-current status (todo → done)', async () => {
    const t = bootstrap();
    try {
      const created = await createTask(t, t.alice.id, 'x');
      const id = taskId(created);
      const r = await t.service.updateStatus({
        actor: { kind: 'user', userId: 'local' },
        by: { taskId: id },
        status: 'done',
      });
      expect(r.success).toBe(true);
      const fresh = refetch(t, id);
      expect(fresh?.status).toBe('done');
    } finally {
      t.cleanup();
    }
  });

  it('user same status → already_at_status', async () => {
    const t = bootstrap();
    try {
      const created = await createTask(t, t.alice.id, 'x');
      const id = taskId(created);
      const r = await t.service.updateStatus({
        actor: { kind: 'user', userId: 'local' },
        by: { taskId: id },
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

describe('TaskService.list / getTaskDetail', () => {
  it('closed is a task status with closed_at metadata', async () => {
    const t = bootstrap();
    try {
      const created = await createTask(t, t.alice.id, 'close me');
      const id = taskId(created);
      const conversationEvents: Array<{ kind: string; payload?: unknown }> = [];
      const viewerEvents: Array<{ kind: string; payload?: unknown }> = [];
      const unsubA = t.events.subscribe(t.channel.id, e => conversationEvents.push(e));
      const unsubB = t.events.subscribeScope(`viewer:local`, e =>
        viewerEvents.push(e),
      );

      const closed = await t.service.updateStatus({
        actor: { kind: 'user', userId: 'local' },
        by: { taskId: id },
        status: 'closed',
      });
      unsubA();
      unsubB();

      expect(closed).toEqual({ success: true });
      const conversationTaskChanges = conversationEvents.filter(e => e.kind === 'task_changed');
      expect(conversationTaskChanges).toHaveLength(1);
      expect(viewerEvents.map(e => e.kind)).toEqual(['task_changed']);
      const event = conversationTaskChanges[0]!.payload as {
        kind: string;
        status: string;
        closed_at: number | null;
      };
      expect(event.kind).toBe('status');
      expect(event.status).toBe('closed');
      expect(event.closed_at).toEqual(expect.any(Number));

      const closedList = t.service.list({
        actor: { kind: 'user', userId: 'local' },
        status: ['closed'],
      });
      expect(closedList).toHaveLength(1);
      expect(closedList[0]).toMatchObject({
        id,
        status: 'closed',
        title: 'close me',
      });
      expect(closedList[0]!.closed_at).toEqual(expect.any(Number));

      const reopened = await t.service.updateStatus({
        actor: { kind: 'user', userId: 'local' },
        by: { taskId: id },
        status: 'todo',
      });
      expect(reopened).toEqual({ success: true });
      expect(t.service.list({ actor: { kind: 'user', userId: 'local' } })).toHaveLength(1);
      expect(refetch(t, id)?.closed_at).toBeNull();
    } finally {
      t.cleanup();
    }
  });

  it('user list global sees tasks across all workspaces', async () => {
    const t = bootstrap();
    try {
      const ws2 = t.workspaces.insert({
        name: 'ws2',
        description: null,
      });
      t.workspaces.insertMembership(ws2.id, t.alice.id);
      const ch2 = t.conversations.insertChannel({
        workspaceId: ws2.id,
        title: fixedConversationTitle('ch2'),
      });
      t.conversations.addAgent(ch2.id, t.alice.id);
      await createTask(t, t.alice.id, 'task1');
      await t.service.createTasks({
        conversationId: ch2.id,
        actor: { kind: 'agent', agentId: t.alice.id, conversationId: ch2.id },
        tasks: [{ title: 'task2' }],
      });
      const r = t.service.list({ actor: { kind: 'user', userId: 'local' } });
      expect(r.length).toBe(2);
    } finally {
      t.cleanup();
    }
  });

  it('user list and getTaskDetail require conversation membership', async () => {
    const t = bootstrapTwoWorkspaces();
    try {
      await createTask(t, t.alice.id, 'visible');
      const hidden = await t.service.createTasks({
        conversationId: t.ws2Channel.id,
        actor: { kind: 'agent', agentId: t.bob.id, conversationId: t.ws2Channel.id },
        tasks: [{ title: 'hidden' }],
      });
      const hiddenId = taskId(hidden);

      t.conversations.removeUser(t.ws2Channel.id, 'local');

      const list = t.service.list({ actor: { kind: 'user', userId: 'local' } });
      expect(list.map(x => x.title)).toEqual(['visible']);
      expect(
        t.service.getTaskDetail(hiddenId, { kind: 'user', userId: 'local' }),
      ).toBe(null);
    } finally {
      t.cleanup();
    }
  });

  it('user task-id mutations hide tasks outside conversation membership', async () => {
    const t = bootstrapTwoWorkspaces();
    try {
      const hidden = await t.service.createTasks({
        conversationId: t.ws2Channel.id,
        actor: { kind: 'agent', agentId: t.bob.id, conversationId: t.ws2Channel.id },
        tasks: [{ title: 'hidden' }],
      });
      const hiddenId = taskId(hidden);

      t.conversations.removeUser(t.ws2Channel.id, 'local');

      const claim = await t.service.claimTask({
        actor: { kind: 'user', userId: 'local' },
        by: { taskId: hiddenId },
        assignee: { agentId: t.bob.id },
      });
      expect(claim.success).toBe(false);
      expect(claim.code).toBe('task_not_found');

      const unclaim = await t.service.unclaimTask({
        actor: { kind: 'user', userId: 'local' },
        by: { taskId: hiddenId },
      });
      expect(unclaim.success).toBe(false);
      expect(unclaim.code).toBe('task_not_found');

      const status = await t.service.updateStatus({
        actor: { kind: 'user', userId: 'local' },
        by: { taskId: hiddenId },
        status: 'in_review',
      });
      expect(status.success).toBe(false);
      expect(status.code).toBe('task_not_found');
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
      });
      t.workspaces.insertMembership(ws2.id, t.alice.id);
      const ch2 = t.conversations.insertChannel({
        workspaceId: ws2.id,
        title: fixedConversationTitle('ch2'),
      });
      t.conversations.addAgent(ch2.id, t.alice.id);
      await createTask(t, t.alice.id, 'task1');
      await t.service.createTasks({
        conversationId: ch2.id,
        actor: { kind: 'agent', agentId: t.alice.id, conversationId: ch2.id },
        tasks: [{ title: 'task2' }],
      });
      const r = t.service.list({
        actor: { kind: 'user', userId: 'local' },
        workspaceId: ws2.id,
      });
      expect(r.length).toBe(1);
      expect(r[0]?.title).toBe('task2');
    } finally {
      t.cleanup();
    }
  });

  it('agent list honors explicit workspaceId (#task:530 — route validates membership)', async () => {
    const t = bootstrap();
    try {
      const ws2 = t.workspaces.insert({
        name: 'ws2',
        description: null,
      });
      t.workspaces.insertMembership(ws2.id, t.alice.id);
      const ch2 = t.conversations.insertChannel({
        workspaceId: ws2.id,
        title: fixedConversationTitle('ch2'),
      });
      t.conversations.addAgent(ch2.id, t.alice.id);
      await createTask(t, t.alice.id, 'in-channel');
      await t.service.createTasks({
        conversationId: ch2.id,
        actor: { kind: 'agent', agentId: t.alice.id, conversationId: ch2.id },
        tasks: [{ title: 'in-ch2' }],
      });
      // Default (no workspaceId) → actor's current ws (t.channel.workspace_id).
      const defaultList = t.service.list({
        actor: { kind: 'agent', agentId: t.alice.id, conversationId: t.channel.id },
      });
      expect(defaultList.map(r => r.title)).toEqual(['in-channel']);
      // Explicit workspaceId → respected (route layer is responsible
      // for membership pre-check before calling the service).
      const explicit = t.service.list({
        actor: { kind: 'agent', agentId: t.alice.id, conversationId: t.channel.id },
        workspaceId: ws2.id,
      });
      expect(explicit.map(r => r.title)).toEqual(['in-ch2']);
    } finally {
      t.cleanup();
    }
  });

  it('agent list with conversationId filter inside actor workspace narrows', async () => {
    const t = bootstrap();
    try {
      const sibling = t.conversations.insertChannel({
        workspaceId: t.workspace.id,
        title: fixedConversationTitle('sibling'),
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
      });
      t.workspaces.insertMembership(ws2.id, t.alice.id);
      const ch2 = t.conversations.insertChannel({
        workspaceId: ws2.id,
        title: fixedConversationTitle('ch2'),
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

  it('agent getTaskDetail for task in another workspace returns null', async () => {
    const t = bootstrap();
    try {
      const ws2 = t.workspaces.insert({
        name: 'ws2',
        description: null,
      });
      t.workspaces.insertMembership(ws2.id, t.alice.id);
      const ch2 = t.conversations.insertChannel({
        workspaceId: ws2.id,
        title: fixedConversationTitle('ch2'),
      });
      t.conversations.addAgent(ch2.id, t.alice.id);
      const created = await t.service.createTasks({
        conversationId: ch2.id,
        actor: { kind: 'agent', agentId: t.alice.id, conversationId: ch2.id },
        tasks: [{ title: 'foreign' }],
      });
      const id = taskId(created);
      const r = t.service.getTaskDetail(id, {
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
  it('createTasks: actor origin conversation may differ from the destination — authorization is by DESTINATION membership, not a principal-conversation match (#task:1738)', async () => {
    const t = bootstrap();
    try {
      // alice runs in `other` (her origin conversation) but files the task into
      // `t.channel` (the destination) where she IS a member. The old
      // principal-conversation-mismatch throw is gone: `input.conversationId` is
      // the destination authority, and the destination-membership floor is the
      // sole service-level gate (the route holds the create-specific narrow
      // authorization). So this SUCCEEDS and the row belongs to the destination.
      const other = t.conversations.insertChannel({
        workspaceId: t.workspace.id,
        title: fixedConversationTitle('other'),
      });
      const result = await t.service.createTasks({
        conversationId: t.channel.id,
        actor: { kind: 'agent', agentId: t.alice.id, conversationId: other.id },
        tasks: [{ title: 'filed cross-channel' }],
      });
      expect('tasks' in result).toBe(true);
      const listed = t.service.list({ actor: { kind: 'user', userId: 'local' } });
      expect(listed.map(x => x.title)).toContain('filed cross-channel');
      expect(listed.every(x => x.conversation.id === t.channel.id)).toBe(true);
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
      const outsider = t.agents.create({ name: 'out', runtime: 'claude' }, t.localHostId, 'local');
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
      const outsider = t.agents.create({ name: 'out', runtime: 'claude' }, t.localHostId, 'local');
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
      const outsider = t.agents.create({ name: 'out', runtime: 'claude' }, t.localHostId, 'local');
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
});

describe('TaskService board-fanout event', () => {
  it('task_changed fires for both the conversation scope and per-viewer board scope per mutation', async () => {
    const t = bootstrap();
    try {
      const convEvents: string[] = [];
      const viewerEvents: string[] = [];
      t.events.subscribe(t.channel.id, e => {
        if (e.kind === 'task_changed') convEvents.push('conv');
      });
      // Board fanout is per-viewer to the channel's human members, not
      // workspace-wide. 'local' is a member of the task channel.
      t.events.subscribeScope(`viewer:local`, e => {
        if (e.kind === 'task_changed') viewerEvents.push('viewer');
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
      expect(viewerEvents.length).toBe(3);
    } finally {
      t.cleanup();
    }
  });

  it('board fanout never leaks to the workspace scope, nor to a non-member viewer', async () => {
    const t = bootstrap();
    try {
      const wsEvents: string[] = [];
      const nonMemberEvents: string[] = [];
      const memberEvents: string[] = [];
      // The board fanout goes per-viewer to the task channel's HUMAN members
      // only — never to `workspace:<id>` (which would leak a private channel's
      // task snapshot to every workspace member).
      t.events.subscribeScope(`workspace:${t.workspace.id}`, e => {
        if (e.kind === 'task_changed') wsEvents.push('ws');
      });
      // A viewer id that is NOT a member of the task channel must receive nothing.
      t.events.subscribeScope(`viewer:not-a-channel-member`, e => {
        if (e.kind === 'task_changed') nonMemberEvents.push('leak');
      });
      t.events.subscribeScope(`viewer:local`, e => {
        if (e.kind === 'task_changed') memberEvents.push('ok');
      });
      await createTask(t, t.alice.id, 'x');
      expect(wsEvents).toEqual([]); // no workspace-wide leak
      expect(nonMemberEvents).toEqual([]); // no leak to non-member viewer
      expect(memberEvents).toEqual(['ok']); // member's board still live
    } finally {
      t.cleanup();
    }
  });
});

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

function fetchSystemRows(
  t: ReturnType<typeof bootstrap>,
  subtype: string,
): { metadata: Record<string, unknown>; thread_root_id: string | null }[] {
  const rows = t.db
    .prepare<[], { metadata: string | null; thread_root_id: string | null }>(
      `SELECT metadata, thread_root_id
       FROM messages
       WHERE from_kind = 'system'
       ORDER BY created_at ASC, id ASC`,
    )
    .all();
  return rows
    .map(r => ({
      metadata: r.metadata ? (JSON.parse(r.metadata) as Record<string, unknown>) : null,
      thread_root_id: r.thread_root_id,
    }))
    .filter((r): r is { metadata: Record<string, unknown>; thread_root_id: string | null } =>
      r.metadata !== null && (r.metadata as { subtype?: string }).subtype === subtype,
    );
}

describe('TaskService system message metadata enrichment (PR-2)', () => {
  it('task_create writes full enriched metadata: subtype, task_id, title, status, assignee, actor', async () => {
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
      expect(meta!.task_id).toBe(created.id);
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
      expect(meta!.task_id).toBeTypeOf('string');
      expect(meta!.task_title).toBe('task-claim-meta');
    } finally {
      t.cleanup();
    }
  });

  it('task_claim by an agent on an in_review task reports in_review (no fixed lifecycle pair)', async () => {
    const t = bootstrap();
    try {
      const created = await createTask(t, t.bob.id, 'task-claim-in-review-meta');
      const id = taskId(created);
      // `assignSelf` only bumps a `todo` task; an unassigned `in_review` task is
      // claimable and keeps its status. So the wire fact must be read from
      // `task_status`, never derived from the `task_claim` subtype.
      await t.service.updateStatus({
        actor: { kind: 'user', userId: 'local' },
        by: { taskId: id },
        status: 'in_progress',
      });
      await t.service.updateStatus({
        actor: { kind: 'user', userId: 'local' },
        by: { taskId: id },
        status: 'in_review',
      });

      const r = await t.service.claimTask({
        actor: { kind: 'agent', agentId: t.alice.id, conversationId: t.channel.id },
        by: { taskNumber: 1 },
      });
      expect(r.success).toBe(true);

      const rows = fetchSystemMetadata(t, 'task_claim');
      expect(rows.length).toBe(1);
      const meta = readTaskSystemMetadata(rows[0]!);
      expect(meta!.task_status).toBe('in_review');
      expect(meta!.task_assignee!.id).toBe(t.alice.id);
      expect(meta!.actor.kind).toBe('agent');
    } finally {
      t.cleanup();
    }
  });

  it('task_claim by a user on a todo task reports the DISPATCHED status (in_progress)', async () => {
    const t = bootstrap();
    try {
      const created = await createTask(t, t.bob.id, 'task-dispatch-meta');
      const id = taskId(created);

      await t.service.claimTask({
        actor: { kind: 'user', userId: 'local' },
        by: { taskId: id },
        assignee: { agentId: t.alice.id },
      });

      const rows = fetchSystemMetadata(t, 'task_claim');
      expect(rows.length).toBe(1);
      const meta = readTaskSystemMetadata(rows[0]!);
      expect(meta).not.toBeNull();
      // The woken assignee reads its work state off this event, so the after-state
      // must be the dispatched one — reporting `todo` would tell the agent the
      // task is still unstarted while the row says otherwise.
      expect(meta!.task_status).toBe('in_progress');
      expect(meta!.task_assignee!.id).toBe(t.alice.id);
      expect(meta!.actor.kind).toBe('user');
      expect(refetch(t, id)?.status).toBe('in_progress');
    } finally {
      t.cleanup();
    }
  });

  it('task_claim by a user on an in_review task reports in_review (reassignment is not a restart)', async () => {
    const t = bootstrap();
    try {
      const created = await createTask(t, t.bob.id, 'task-reassign-meta');
      const id = taskId(created);
      await t.service.claimTask({
        actor: { kind: 'agent', agentId: t.alice.id, conversationId: t.channel.id },
        by: { taskNumber: 1 },
      });
      await t.service.updateStatus({
        actor: { kind: 'user', userId: 'local' },
        by: { taskId: id },
        status: 'in_review',
      });

      await t.service.claimTask({
        actor: { kind: 'user', userId: 'local' },
        by: { taskId: id },
        assignee: { agentId: t.bob.id },
      });

      const rows = fetchSystemMetadata(t, 'task_claim');
      // Two claim events: alice's self-claim, then the human reassignment. Pick
      // the human one by actor rather than by row order.
      expect(rows.length).toBe(2);
      const metas = rows.map(r => readTaskSystemMetadata(r));
      const meta = metas.find(m => m?.actor.kind === 'user');
      expect(meta).toBeDefined();
      expect(meta!.task_status).toBe('in_review');
      expect(meta!.task_assignee!.id).toBe(t.bob.id);
    } finally {
      t.cleanup();
    }
  });

  it('task_unclaim by a user reports the UNCHANGED status (assignment-only write)', async () => {
    const t = bootstrap();
    try {
      const created = await createTask(t, t.bob.id, 'task-unassign-meta');
      const id = taskId(created);
      await t.service.claimTask({
        actor: { kind: 'agent', agentId: t.alice.id, conversationId: t.channel.id },
        by: { taskNumber: 1 },
      });
      await t.service.updateStatus({
        actor: { kind: 'user', userId: 'local' },
        by: { taskId: id },
        status: 'in_review',
      });

      await t.service.unclaimTask({
        actor: { kind: 'user', userId: 'local' },
        by: { taskId: id },
      });

      const rows = fetchSystemMetadata(t, 'task_unclaim');
      expect(rows.length).toBe(1);
      const meta = readTaskSystemMetadata(rows[0]!);
      expect(meta).not.toBeNull();
      // The wire fact agents read must match the row: clearing the assignee
      // does not rewind the workflow, so this is `in_review`, not `todo`.
      expect(meta!.task_status).toBe('in_review');
      expect(meta!.task_assignee).toBeNull();
      expect(meta!.actor.kind).toBe('user');
    } finally {
      t.cleanup();
    }
  });

  it('task claim/status system messages inherit the task thread stream', async () => {
    const t = bootstrap();
    try {
      const root = t.messages.insertForConversation({
        conversationId: t.channel.id,
        fromKind: 'agent',
        fromAgentId: t.bob.id,
        content: 'root message',
      });
      // Create the task INSIDE root's reply cluster (thread target). Do this
      // BEFORE subscribing so the 'create' event is not counted — the test
      // asserts on the claim + status events only.
      const created = await t.service.createTasks({
        conversationId: t.channel.id,
        actor: { kind: 'agent', agentId: t.bob.id, conversationId: t.channel.id },
        tasks: [{ title: 'task inside thread' }],
        target: { kind: 'thread', message_id: root.id },
      });
      const id = taskId(created);

      const taskEvents: unknown[] = [];
      const unsub = t.events.subscribe(t.channel.id, e => {
        if (e.kind === 'task_changed') taskEvents.push(e.payload);
      });

      const claim = await t.service.claimTask({
        actor: { kind: 'agent', agentId: t.alice.id, conversationId: t.channel.id },
        by: { taskNumber: 1 },
      });
      expect(claim).toMatchObject({ success: true, id });

      const status = await t.service.updateStatus({
        actor: { kind: 'agent', agentId: t.alice.id, conversationId: t.channel.id },
        by: { taskNumber: 1 },
        status: 'in_review',
      });
      unsub();
      expect(status).toEqual({ success: true });

      const claimRows = fetchSystemRows(t, 'task_claim');
      const statusRows = fetchSystemRows(t, 'task_status');
      expect(claimRows).toHaveLength(1);
      expect(statusRows).toHaveLength(1);
      expect(readTaskSystemMetadata(claimRows[0]!.metadata)?.task_id).toBe(id);
      expect(readTaskSystemMetadata(statusRows[0]!.metadata)?.task_id).toBe(id);
      expect(claimRows[0]!.thread_root_id).toBe(root.id);
      expect(statusRows[0]!.thread_root_id).toBe(root.id);
      expect(taskEvents).toHaveLength(2);
      expect(taskEvents).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            kind: 'claim',
            thread_root_id: root.id,
          }),
          expect.objectContaining({
            kind: 'status',
            thread_root_id: root.id,
          }),
        ]),
      );
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

  it('user actor produces actor.kind=user with the principal user id on user-driven mutations', async () => {
    const t = bootstrap();
    try {
      const created = await createTask(t, t.alice.id, 'user-actor-meta');
      const id = taskId(created);
      await t.service.unclaimTask({
        actor: { kind: 'user', userId: 'local' },
        by: { taskId: id },
      });
      const rows = fetchSystemMetadata(t, 'task_unclaim');
      expect(rows.length).toBe(1);
      const meta = readTaskSystemMetadata(rows[0]!);
      expect(meta).not.toBeNull();
      expect(meta!.actor.kind).toBe('user');
      if (meta!.actor.kind !== 'user') throw new Error();
      expect(meta!.actor.id).toBe('local');
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

// ── #task:530: workspace-scoped agent task ops ───────────────────────
//
// Cross-channel ops within the same workspace now succeed by default.
// Cross-workspace ops require `--workspace-id` / `--workspace <name>`
// and that the actor agent is a member of the resolved workspace.

function bootstrapTwoWorkspaces() {
  const t = bootstrap();
  // Second regular workspace, alice is NOT a member by default.
  const ws2 = t.workspaces.insert({
    name: 'platform',
    description: null,
  });
  const ws2Channel = t.conversations.insertChannel({
    workspaceId: ws2.id,
    title: fixedConversationTitle('platform-main'),
  });
  t.conversations.addAgent(ws2Channel.id, t.bob.id);
  t.workspaces.insertMembership(ws2.id, t.bob.id);
  return { ...t, ws2, ws2Channel };
}

describe('#task:530 — workspace selector + cross-workspace permission', () => {
  it('cross-workspace claim without selector → task_not_found (lookup scoped to current ws)', async () => {
    const t = bootstrapTwoWorkspaces();
    try {
      // Bob creates a task in ws2.
      await t.service.createTasks({
        conversationId: t.ws2Channel.id,
        actor: { kind: 'agent', agentId: t.bob.id, conversationId: t.ws2Channel.id },
        tasks: [{ title: 'ws2 work' }],
      });
      // Alice in ws1 tries to claim #1 without selector; her ws lookup
      // misses (no task #1 in ws1 yet).
      const r = await t.service.claimTask({
        actor: { kind: 'agent', agentId: t.alice.id, conversationId: t.channel.id },
        by: { taskNumber: 1 },
      });
      expect(r.success).toBe(false);
      expect(r.code).toBe('task_not_found');
    } finally {
      t.cleanup();
    }
  });

  it('cross-workspace claim with --workspace-id but not a member → workspace_membership_required', async () => {
    const t = bootstrapTwoWorkspaces();
    try {
      await t.service.createTasks({
        conversationId: t.ws2Channel.id,
        actor: { kind: 'agent', agentId: t.bob.id, conversationId: t.ws2Channel.id },
        tasks: [{ title: 'ws2 work' }],
      });
      const r = await t.service.claimTask({
        actor: { kind: 'agent', agentId: t.alice.id, conversationId: t.channel.id },
        by: { taskNumber: 1 },
        workspaceSelector: { workspaceId: t.ws2.id },
      });
      expect(r.success).toBe(false);
      expect(r.code).toBe('workspace_membership_required');
    } finally {
      t.cleanup();
    }
  });

  it('cross-workspace claim with --workspace-id as member → succeeds', async () => {
    const t = bootstrapTwoWorkspaces();
    try {
      await t.service.createTasks({
        conversationId: t.ws2Channel.id,
        actor: { kind: 'agent', agentId: t.bob.id, conversationId: t.ws2Channel.id },
        tasks: [{ title: 'ws2 work' }],
      });
      // Add alice as ws2 member.
      t.workspaces.insertMembership(t.ws2.id, t.alice.id);
      const r = await t.service.claimTask({
        actor: { kind: 'agent', agentId: t.alice.id, conversationId: t.channel.id },
        by: { taskNumber: 1 },
        workspaceSelector: { workspaceId: t.ws2.id },
      });
      expect(r.success).toBe(true);
      // Audit line emitted (warn-level per Cindy `JLdi59K-TD11CAWy`).
      const cross = (t.logger.warn as ReturnType<typeof vi.fn>).mock.calls.filter(
        c => (c[0] as { op?: string }).op === 'task_cross_op',
      );
      expect(cross.length).toBeGreaterThan(0);
      expect(cross[0]![1]).toBe('task-service: audit cross-conversation task op');
    } finally {
      t.cleanup();
    }
  });

  it('--workspace-id pointing at non-existent workspace → unknown_workspace', async () => {
    const t = bootstrapTwoWorkspaces();
    try {
      const r = await t.service.claimTask({
        actor: { kind: 'agent', agentId: t.alice.id, conversationId: t.channel.id },
        by: { taskNumber: 1 },
        workspaceSelector: { workspaceId: 'no-such-ws' },
      });
      expect(r.success).toBe(false);
      expect(r.code).toBe('unknown_workspace');
    } finally {
      t.cleanup();
    }
  });

  it('--workspace <name> ambiguous → ambiguous_workspace + candidates', async () => {
    const t = bootstrapTwoWorkspaces();
    try {
      // Create an agent_home workspace named "eng" — same as the
      // regular ws name used in bootstrap.
      const carolAgent = t.agents.create(
        { name: 'eng', runtime: 'claude' },
        t.localHostId,
        'local',
      );
      t.workspaces.insertAgentHome({
        agent: { id: carolAgent.id, name: 'eng' },
      });
      const r = await t.service.claimTask({
        actor: { kind: 'agent', agentId: t.alice.id, conversationId: t.channel.id },
        by: { taskNumber: 1 },
        workspaceSelector: { workspaceName: 'eng' },
      });
      expect(r.success).toBe(false);
      expect(r.code).toBe('ambiguous_workspace');
      expect(r.workspace_candidates?.length).toBe(2);
    } finally {
      t.cleanup();
    }
  });

  it('--workspace <name> 0 matches → unknown_workspace', async () => {
    const t = bootstrapTwoWorkspaces();
    try {
      const r = await t.service.claimTask({
        actor: { kind: 'agent', agentId: t.alice.id, conversationId: t.channel.id },
        by: { taskNumber: 1 },
        workspaceSelector: { workspaceName: 'no-such-name' },
      });
      expect(r.success).toBe(false);
      expect(r.code).toBe('unknown_workspace');
    } finally {
      t.cleanup();
    }
  });

  it('--workspace <name> unique → resolves and checks membership', async () => {
    const t = bootstrapTwoWorkspaces();
    try {
      await t.service.createTasks({
        conversationId: t.ws2Channel.id,
        actor: { kind: 'agent', agentId: t.bob.id, conversationId: t.ws2Channel.id },
        tasks: [{ title: 'ws2' }],
      });
      // Alice not yet member of platform → membership required.
      const r1 = await t.service.claimTask({
        actor: { kind: 'agent', agentId: t.alice.id, conversationId: t.channel.id },
        by: { taskNumber: 1 },
        workspaceSelector: { workspaceName: 'platform' },
      });
      expect(r1.code).toBe('workspace_membership_required');
      // Add alice → succeeds.
      t.workspaces.insertMembership(t.ws2.id, t.alice.id);
      const r2 = await t.service.claimTask({
        actor: { kind: 'agent', agentId: t.alice.id, conversationId: t.channel.id },
        by: { taskNumber: 1 },
        workspaceSelector: { workspaceName: 'platform' },
      });
      expect(r2.success).toBe(true);
    } finally {
      t.cleanup();
    }
  });

  // ── Permission matrix (Cindy `S-RgXd_GWAHu4f0E` + `hBb0MPcTSPh9bJiQ`)
  //
  // assignee==self                          → allow (regardless of creator kind)
  // assignee==null + creator==self(agent)   → allow (creator-self fallback)
  // assignee==null + creator==human/other   → reject (not_assignee)
  // assignee==other-agent                   → reject (not_assignee)

  it('updateStatus: human-created + assignee=self → succeeds (assignee path)', async () => {
    const t = bootstrap();
    try {
      // Human user creates and assigns to alice.
      const created = await t.service.createTasks({
        conversationId: t.channel.id,
        actor: { kind: 'user', userId: 'local' },
        tasks: [{ title: 'human task' }],
      });
      const id = taskId(created);
      await t.service.claimTask({
        actor: { kind: 'user', userId: 'local' },
        by: { taskId: id },
        assignee: { agentId: t.alice.id },
      });
      // Assignment is ownership only, so the human also moves the lifecycle —
      // two orthogonal writes (§4.4).
      await t.service.updateStatus({
        actor: { kind: 'user', userId: 'local' },
        by: { taskId: id },
        status: 'in_progress',
      });
      // alice advances → assignee path
      const r = await t.service.updateStatus({
        actor: { kind: 'agent', agentId: t.alice.id, conversationId: t.channel.id },
        by: { taskNumber: 1 },
        status: 'in_review',
      });
      expect(r.success).toBe(true);
    } finally {
      t.cleanup();
    }
  });

  it('updateStatus: creator-self fallback does NOT reach past a migrated user assignee', async () => {
    const t = bootstrap();
    try {
      // alice creates the task, so the creator-self branch would otherwise
      // apply — but the row carries a (migrated) user assignee, i.e. it has an
      // owner. "Unassigned" means BOTH assignee columns null (§4.5).
      const created = await createTask(t, t.alice.id, 'creator stale but user-owned');
      const id = taskId(created);
      t.db
        .prepare(
          `UPDATE tasks SET assignee_agent_id = NULL, assignee_user_id = 'local',
                            status = 'in_progress' WHERE id = ?`,
        )
        .run(id);

      const seen: string[] = [];
      const unsub = t.events.subscribe(t.channel.id, e => seen.push(e.kind));
      try {
        const r = await t.service.updateStatus({
          actor: { kind: 'agent', agentId: t.alice.id, conversationId: t.channel.id },
          by: { taskNumber: 1 },
          status: 'done',
        });
        expect(r.success).toBe(false);
        expect(r.code).toBe('not_assignee');
      } finally {
        unsub();
      }
      const fresh = refetch(t, id);
      expect(fresh?.status).toBe('in_progress');
      expect(fresh?.assignee?.type).toBe('user');
      expect(seen).toEqual([]);
    } finally {
      t.cleanup();
    }
  });

  it('updateStatus: human-created + null-assignee → not_assignee (creator path does NOT apply)', async () => {
    const t = bootstrap();
    try {
      // Human creates an unassigned task and advances it to in_progress
      // (so the transition is otherwise valid).
      const created = await t.service.createTasks({
        conversationId: t.channel.id,
        actor: { kind: 'user', userId: 'local' },
        tasks: [{ title: 'human stale' }],
      });
      const id = taskId(created);
      t.db.prepare(`UPDATE tasks SET status = 'in_progress' WHERE id = ?`).run(id);
      const r = await t.service.updateStatus({
        actor: { kind: 'agent', agentId: t.alice.id, conversationId: t.channel.id },
        by: { taskNumber: 1 },
        status: 'done',
      });
      expect(r.success).toBe(false);
      expect(r.code).toBe('not_assignee');
    } finally {
      t.cleanup();
    }
  });

  it('updateStatus: agent self-created + null-assignee + in_progress → creator-self completes', async () => {
    const t = bootstrap();
    try {
      const created = await t.service.createTasks({
        conversationId: t.channel.id,
        actor: { kind: 'agent', agentId: t.alice.id, conversationId: t.channel.id },
        tasks: [{ title: 'self stale' }],
      });
      const id = taskId(created);
      // Force to in_progress + null-assignee — the in-the-wild shape
      // you'd see after a user-driven unclaim.
      t.db
        .prepare(
          `UPDATE tasks SET status = 'in_progress', assignee_agent_id = NULL WHERE id = ?`,
        )
        .run(id);
      const r = await t.service.updateStatus({
        actor: { kind: 'agent', agentId: t.alice.id, conversationId: t.channel.id },
        by: { taskNumber: 1 },
        status: 'done',
      });
      expect(r.success).toBe(true);
    } finally {
      t.cleanup();
    }
  });

  it('updateStatus: assignee=other agent → not_assignee (no fallback even if creator==self)', async () => {
    const t = bootstrap();
    try {
      const created = await t.service.createTasks({
        conversationId: t.channel.id,
        actor: { kind: 'agent', agentId: t.alice.id, conversationId: t.channel.id },
        tasks: [{ title: 'alice created' }],
      });
      const id = taskId(created);
      // Bob is now the assignee, in_progress.
      t.db
        .prepare(
          `UPDATE tasks SET status = 'in_progress', assignee_agent_id = ? WHERE id = ?`,
        )
        .run(t.bob.id, id);
      const r = await t.service.updateStatus({
        actor: { kind: 'agent', agentId: t.alice.id, conversationId: t.channel.id },
        by: { taskNumber: 1 },
        status: 'done',
      });
      expect(r.success).toBe(false);
      expect(r.code).toBe('not_assignee');
    } finally {
      t.cleanup();
    }
  });
});

describe('TaskService — write_tasks capability gate (graded-permissions cut 2)', () => {
  // The service-level gate uses the injected checker; a denial must surface
  // the typed `{ code: 'capability_denied', capability: 'write_tasks' }`
  // shape (not a downgrade to forbidden / task_not_found). The checker is a
  // live closure so the test can set up state with write_tasks allowed,
  // then flip it off before the gated mutation.
  let denyWriteTasks = false;
  const makeT = () =>
    bootstrap((_actor, _ws, cap) => !(denyWriteTasks && cap === 'write_tasks'));

  it('claim denied → typed capability_denied/write_tasks', async () => {
    denyWriteTasks = false;
    const t = makeT();
    try {
      await createTask(t, t.bob.id, 'task-1');
      denyWriteTasks = true;
      const r = await t.service.claimTask({
        actor: { kind: 'agent', agentId: t.alice.id, conversationId: t.channel.id },
        by: { taskNumber: 1 },
      });
      expect(r.success).toBe(false);
      expect(r.code).toBe('capability_denied');
      expect(r.capability).toBe('write_tasks');
    } finally {
      denyWriteTasks = false;
      t.cleanup();
    }
  });

  it('unclaim denied → typed capability_denied/write_tasks', async () => {
    denyWriteTasks = false;
    const t = makeT();
    try {
      await createTask(t, t.alice.id, 'x');
      await t.service.claimTask({
        actor: { kind: 'agent', agentId: t.alice.id, conversationId: t.channel.id },
        by: { taskNumber: 1 },
      });
      denyWriteTasks = true;
      const r = await t.service.unclaimTask({
        actor: { kind: 'agent', agentId: t.alice.id, conversationId: t.channel.id },
        by: { taskNumber: 1 },
      });
      expect(r.success).toBe(false);
      expect(r.code).toBe('capability_denied');
      expect(r.capability).toBe('write_tasks');
    } finally {
      denyWriteTasks = false;
      t.cleanup();
    }
  });

  it('updateStatus denied → typed capability_denied/write_tasks', async () => {
    denyWriteTasks = false;
    const t = makeT();
    try {
      await createTask(t, t.alice.id, 'x');
      await t.service.claimTask({
        actor: { kind: 'agent', agentId: t.alice.id, conversationId: t.channel.id },
        by: { taskNumber: 1 },
      });
      denyWriteTasks = true;
      const r = await t.service.updateStatus({
        actor: { kind: 'agent', agentId: t.alice.id, conversationId: t.channel.id },
        by: { taskNumber: 1 },
        status: 'in_review',
      });
      expect(r.success).toBe(false);
      expect(r.code).toBe('capability_denied');
      expect(r.capability).toBe('write_tasks');
    } finally {
      denyWriteTasks = false;
      t.cleanup();
    }
  });
});

describe('TaskService — claim capability gate (write_tasks)', () => {
  // Claiming an already-numbered task is pure mutation: it needs write_tasks
  // only, NOT create_tasks. (Promotion — which used to also require
  // create_tasks — was removed; a plain message can no longer become a task
  // via claim.) The checker is keyed by capability so a case can deny exactly
  // one bucket.
  const denied = new Set<string>();
  const makeT = () =>
    bootstrap((_actor, _ws, cap) => !denied.has(cap));

  it('existing numbered-task claim does NOT require create_tasks', async () => {
    // Deny create_tasks but allow write_tasks; claiming an already-numbered
    // task must still succeed (it is pure mutation, not creation).
    denied.clear();
    denied.add('create_tasks');
    const t = makeT();
    try {
      // createTasks (service) is not capability-gated — the gate is on the
      // route; this sets up a numbered task regardless of the checker.
      await createTask(t, t.bob.id, 'numbered');
      const r = await t.service.claimTask({
        actor: { kind: 'agent', agentId: t.alice.id, conversationId: t.channel.id },
        by: { taskNumber: 1 },
      });
      expect(r).toMatchObject({ success: true, task_number: 1 });
    } finally {
      denied.clear();
      t.cleanup();
    }
  });
});

describe('TaskService.createTasks — source provenance + --claim', () => {
  it('stores source_message_id and self-claims when claim=true', async () => {
    const t = bootstrap();
    try {
      const src = t.messages.insertForConversation({
        conversationId: t.channel.id,
        fromKind: 'user',
        fromUserId: 'local',
        content: 'the prompting message',
      });
      const r = await t.service.createTasks({
        conversationId: t.channel.id,
        actor: { kind: 'agent', agentId: t.alice.id, conversationId: t.channel.id },
        tasks: [{ title: 'derived task', body: 'do the thing', sourceMessageId: src.id }],
        claim: true,
      });
      const id = taskId(r);
      const detail = t.service.getTaskDetail(id, {
        kind: 'user',
        userId: 'local',
      });
      expect(detail?.source_message_id).toBe(src.id);
      expect(detail?.content).toBe('do the thing');
      expect(detail?.status).toBe('in_progress');
      expect(detail?.assignee?.id).toBe(t.alice.id);
    } finally {
      t.cleanup();
    }
  });

  it('empty body stores "" (not a title duplicate)', async () => {
    const t = bootstrap();
    try {
      const r = await t.service.createTasks({
        conversationId: t.channel.id,
        actor: { kind: 'agent', agentId: t.alice.id, conversationId: t.channel.id },
        tasks: [{ title: 'titled but bodyless' }],
      });
      const id = taskId(r);
      const detail = t.service.getTaskDetail(id, {
        kind: 'user',
        userId: 'local',
      });
      expect(detail?.content).toBe('');
    } finally {
      t.cleanup();
    }
  });

  it('second task from the same source (any status) → source_conflict + existing_task', async () => {
    const t = bootstrap();
    try {
      const src = t.messages.insertForConversation({
        conversationId: t.channel.id,
        fromKind: 'user',
        fromUserId: 'local',
        content: 'source',
      });
      const first = await t.service.createTasks({
        conversationId: t.channel.id,
        actor: { kind: 'agent', agentId: t.alice.id, conversationId: t.channel.id },
        tasks: [{ title: 'first', sourceMessageId: src.id }],
      });
      if (!('tasks' in first)) throw new Error('first create failed');
      // Close the first task — a permanent 1:1 source does NOT release on close.
      await t.service.updateStatus({
        actor: { kind: 'agent', agentId: t.alice.id, conversationId: t.channel.id },
        by: { taskNumber: first.tasks[0]!.task_number },
        status: 'closed',
      });
      const second = await t.service.createTasks({
        conversationId: t.channel.id,
        actor: { kind: 'agent', agentId: t.alice.id, conversationId: t.channel.id },
        tasks: [{ title: 'second', sourceMessageId: src.id }],
      });
      expect('error' in second && second.error).toBe('source_conflict');
      if (!('error' in second)) throw new Error('expected conflict');
      expect(second.existing_task?.task_number).toBe(first.tasks[0]!.task_number);
      expect(second.existing_task?.status).toBe('closed');
    } finally {
      t.cleanup();
    }
  });

  it('a same-batch duplicate source surfaces as a DRIVER-FREE source_conflict and rolls the whole batch back', async () => {
    const t = bootstrap();
    try {
      // Both pre-checks pass (no task exists yet), then the SECOND row insert
      // collides on UNIQUE(source_message_id) INSIDE the transaction. This is
      // the only path that exercises the adapter's driver-dialect translation
      // (`SqliteTaskRepo.isSourceUniqueCollision → TaskSourceConflictError`):
      // the service must receive a typed `source_conflict`, never a raw
      // driver error, and the whole batch (both rows) must roll back.
      const src = t.messages.insertForConversation({
        conversationId: t.channel.id,
        fromKind: 'user',
        fromUserId: 'local',
        content: 'source',
      });
      const actor = { kind: 'agent' as const, agentId: t.alice.id, conversationId: t.channel.id };
      const tasksBefore = t.service.list({ actor });

      const convKinds: string[] = [];
      const unsub = t.events.subscribe(t.channel.id, e => convKinds.push(e.kind));
      t.fake.delivered = [];

      const result = await t.service.createTasks({
        conversationId: t.channel.id,
        actor,
        tasks: [
          { title: 'first', sourceMessageId: src.id },
          { title: 'second', sourceMessageId: src.id },
        ],
      });
      unsub();

      // Typed driver-free conflict — not a thrown SqliteError.
      expect('error' in result && result.error).toBe('source_conflict');
      // The whole batch rolled back: neither task is visible.
      const after = t.service.list({ actor });
      expect(after).toHaveLength(tasksBefore.length);
      expect(after.some(x => x.title === 'first' || x.title === 'second')).toBe(false);
      // No publish/deliver escaped.
      expect(convKinds).toEqual([]);
      expect(t.fake.delivered).toEqual([]);
    } finally {
      t.cleanup();
    }
  });

  it('source message that does not exist → source_message_not_found', async () => {
    const t = bootstrap();
    try {
      const r = await t.service.createTasks({
        conversationId: t.channel.id,
        actor: { kind: 'agent', agentId: t.alice.id, conversationId: t.channel.id },
        tasks: [{ title: 'x', sourceMessageId: 'no-such-message' }],
      });
      expect('error' in r && r.error).toBe('source_message_not_found');
    } finally {
      t.cleanup();
    }
  });

  it('source message in a different conversation (even same workspace) → source_conversation_mismatch', async () => {
    const t = bootstrap();
    try {
      // v1 contract: source and task must share ONE conversation. A sibling
      // channel in the SAME workspace is not close enough — same-workspace is
      // not sufficient, only same-conversation is.
      const sibling = t.conversations.insertChannel({
        workspaceId: t.workspace.id,
        title: fixedConversationTitle('sibling'),
      });
      t.conversations.addAgent(sibling.id, t.alice.id);
      const siblingSrc = t.messages.insertForConversation({
        conversationId: sibling.id,
        fromKind: 'agent',
        fromAgentId: t.alice.id,
        content: 'sibling source',
      });
      const r = await t.service.createTasks({
        conversationId: t.channel.id,
        actor: { kind: 'agent', agentId: t.alice.id, conversationId: t.channel.id },
        tasks: [{ title: 'x', sourceMessageId: siblingSrc.id }],
      });
      expect('error' in r && r.error).toBe('source_conversation_mismatch');
    } finally {
      t.cleanup();
    }
  });

  it('nav becomes unavailable once the declared source is gone (never falls back to the created-event nav)', async () => {
    const t = bootstrap();
    try {
      // v1 contract: source shares the task's conversation, so a viewer who can
      // read the task can read the source — UNLESS the source itself disappears.
      // Source deletion is the falsifier: nav must go `unavailable`, never
      // silently fall back to the created-event nav (the nav semantic is
      // "go to source").
      const src = t.messages.insertForConversation({
        conversationId: t.channel.id,
        fromKind: 'agent',
        fromAgentId: t.alice.id,
        content: 'the source',
      });
      const created = await t.service.createTasks({
        conversationId: t.channel.id,
        actor: { kind: 'agent', agentId: t.alice.id, conversationId: t.channel.id },
        tasks: [{ title: 'derived', sourceMessageId: src.id }],
      });
      const id = taskId(created);
      // The source message is removed (the task keeps its immutable provenance id).
      t.db.prepare('DELETE FROM messages WHERE id = ?').run(src.id);
      const resolved = t.service.resolveAgentDetailWorkspace(
        { kind: 'agent', agentId: t.alice.id, conversationId: t.channel.id },
        undefined,
      );
      if ('code' in resolved) throw new Error('workspace resolve failed');
      const detail = t.service.getTaskDetail(
        id,
        { kind: 'agent', agentId: t.alice.id, conversationId: t.channel.id },
        resolved.workspaceId,
      );
      expect(detail?.source_message_id).toBe(src.id); // provenance identity kept
      // A declared source that is gone → unavailable
      // (never silently falls back to the created-event nav).
      expect(detail?.nav).toEqual({ kind: 'unavailable' });
    } finally {
      t.cleanup();
    }
  });
});

describe('TaskService.editTask', () => {
  it('title+body edit stamps last editor and returns full detail', async () => {
    const t = bootstrap();
    try {
      await createTask(t, t.alice.id, 'old title');
      const r = await t.service.editTask({
        actor: { kind: 'agent', agentId: t.alice.id, conversationId: t.channel.id },
        by: { taskNumber: 1 },
        title: 'new title',
        body: 'new content',
      });
      expect(r.success).toBe(true);
      if (!r.success) throw new Error('expected success');
      expect(r.task.title).toBe('new title');
      expect(r.task.content).toBe('new content');
      expect(r.task.last_editor?.kind).toBe('agent');
      expect(r.task.last_editor?.id).toBe(t.alice.id);
      expect(r.task.last_edited_at).not.toBeNull();
    } finally {
      t.cleanup();
    }
  });

  it('body-only edit leaves title unchanged; empty body clears content', async () => {
    const t = bootstrap();
    try {
      await t.service.createTasks({
        conversationId: t.channel.id,
        actor: { kind: 'agent', agentId: t.alice.id, conversationId: t.channel.id },
        tasks: [{ title: 'keep me', body: 'original body' }],
      });
      const r = await t.service.editTask({
        actor: { kind: 'agent', agentId: t.alice.id, conversationId: t.channel.id },
        by: { taskNumber: 1 },
        title: null,
        body: '',
      });
      expect(r.success).toBe(true);
      if (!r.success) throw new Error('expected success');
      expect(r.task.title).toBe('keep me');
      expect(r.task.content).toBe('');
    } finally {
      t.cleanup();
    }
  });

  it('cross-workspace edit by --workspace-id succeeds and returns full detail (row workspace ≠ actor current-conversation workspace)', async () => {
    const t = bootstrap();
    try {
      // Second workspace where alice is a full member with her own channel.
      const otherWs = t.workspaces.insert({
        name: 'other',
        description: null,
      });
      t.workspaces.insertMembership(otherWs.id, t.alice.id);
      const otherChannel = t.conversations.insertChannel({
        workspaceId: otherWs.id,
        title: fixedConversationTitle('other-main'),
      });
      t.conversations.addAgent(otherChannel.id, t.alice.id);
      // Task lives in otherWs (task_number 1 in that workspace).
      await t.service.createTasks({
        conversationId: otherChannel.id,
        actor: { kind: 'agent', agentId: t.alice.id, conversationId: otherChannel.id },
        tasks: [{ title: 'foreign task', body: 'foreign body' }],
      });
      // Edit it while ACTING from the main-workspace channel, pointing the
      // selector at the row's own workspace (otherWs) — the row's workspace
      // authorizes, not the actor's current conversation.
      const r = await t.service.editTask({
        actor: { kind: 'agent', agentId: t.alice.id, conversationId: t.channel.id },
        by: { taskNumber: 1 },
        title: 'edited across workspaces',
        body: null,
        workspaceSelector: { workspaceId: otherWs.id },
      });
      expect(r.success).toBe(true);
      if (!r.success) throw new Error('expected cross-workspace success');
      expect(r.task.title).toBe('edited across workspaces');
    } finally {
      t.cleanup();
    }
  });

  it('agent with write_tasks but NOT read_tasks is denied — no definition leaks via the edit response', async () => {
    // read_tasks gates task reads; edit returns the full definition on success.
    // An agent holding write but not read must be denied BEFORE any content
    // crosses the boundary.
    const t = bootstrap((_actor, _workspaceId, capability) => capability !== 'read_tasks');
    try {
      await createTask(t, t.alice.id, 'secret title');
      const r = await t.service.editTask({
        actor: { kind: 'agent', agentId: t.alice.id, conversationId: t.channel.id },
        by: { taskNumber: 1 },
        title: 'x',
        body: null,
      });
      expect(r.success).toBe(false);
      if (r.success) throw new Error('expected capability denial');
      expect(r.code).toBe('capability_denied');
      expect('capability' in r && r.capability).toBe('read_tasks');
      // Nothing readable leaked — the failure carries no `task`.
      expect('task' in r).toBe(false);
    } finally {
      t.cleanup();
    }
  });

  it('a real edit fires a task_edit event (+ task_changed) and wakes EVERY channel agent except the editor', async () => {
    const t = bootstrap();
    try {
      // Body carries a sentinel so we can prove it never leaks into the notice
      // (neither the message content nor its metadata). Bob owns the task
      // (self-claim → assignee=bob, in_progress); Alice edits the title. Carol
      // is a third channel member who is NEITHER assignee NOR editor — she
      // proves the wake widened past assignee-only (#task:1542).
      const SENTINEL = 'SENTINEL_BODY_do_not_leak_9f3a';
      const carol = t.agents.create({ name: 'carol', runtime: 'claude' }, t.localHostId, 'local');
      t.workspaces.insertMembership(t.workspace.id, carol.id);
      t.conversations.addAgent(t.channel.id, carol.id);
      await t.service.createTasks({
        conversationId: t.channel.id,
        actor: { kind: 'agent', agentId: t.bob.id, conversationId: t.channel.id },
        tasks: [{ title: 'old title', body: SENTINEL }],
      });
      await t.service.claimTask({
        actor: { kind: 'agent', agentId: t.bob.id, conversationId: t.channel.id },
        by: { taskNumber: 1 },
      });

      const convKinds: string[] = [];
      const unsub = t.events.subscribe(t.channel.id, e => convKinds.push(e.kind));
      t.fake.delivered = []; // isolate the edit wake from create/claim deliveries

      const r = await t.service.editTask({
        actor: { kind: 'agent', agentId: t.alice.id, conversationId: t.channel.id },
        by: { taskNumber: 1 },
        title: 'new title',
        body: null,
      });
      unsub();
      expect(r.success).toBe(true);

      // Durable + conversation-visible: exactly one task_edit system message,
      // one message event, one task_changed.
      const rows = fetchSystemMetadata(t, 'task_edit');
      expect(rows.length).toBe(1);
      const meta = readTaskSystemMetadata(rows[0]!);
      expect(meta?.subtype).toBe('task_edit');
      expect(meta?.task_status).toBe('in_progress'); // an edit never moves status
      expect(meta?.task_title).toBe('new title');
      // The body never leaks into the notice — assert against the FULL message
      // row (content AND metadata), not just metadata (which structurally can't
      // hold it). The task body still holds the sentinel; the notice must not.
      const editRow = t.db
        .prepare<[], { content: string; metadata: string | null }>(
          `SELECT content, metadata FROM messages
           WHERE from_kind = 'system'
             AND json_extract(metadata, '$.subtype') = 'task_edit'
           ORDER BY created_at DESC, id DESC LIMIT 1`,
        )
        .get();
      expect(editRow).toBeTruthy();
      expect(editRow!.content).not.toContain(SENTINEL);
      expect(editRow!.metadata ?? '').not.toContain(SENTINEL);
      // The body itself is untouched by a title-only edit — the sentinel still
      // lives on the task, it just never reached the notice.
      expect(refetch(t, rows[0]!.task_id as string)?.content).toBe(SENTINEL);
      expect(convKinds.filter(k => k === 'message').length).toBe(1);
      expect(convKinds.filter(k => k === 'task_changed').length).toBe(1);

      // Wake reaches every channel agent EXCEPT the editor (alice): the
      // assignee (bob) AND the uninvolved member (carol), each exactly once.
      const woken = t.fake.delivered.map(d => d.agentId).sort();
      expect(woken).toEqual([t.bob.id, carol.id].sort());
      expect(woken).not.toContain(t.alice.id); // editor never self-woken
      expect(new Set(woken).size).toBe(woken.length); // each at most once
      expect(t.fake.delivered.every(d => d.conversationId === t.channel.id)).toBe(true);
    } finally {
      t.cleanup();
    }
  });

  it('a same-value save is a full no-op: no event, no task_changed, no wake, no last_editor stamp', async () => {
    const t = bootstrap();
    try {
      await t.service.createTasks({
        conversationId: t.channel.id,
        actor: { kind: 'agent', agentId: t.alice.id, conversationId: t.channel.id },
        tasks: [{ title: 'same title', body: 'same body' }],
      });
      await t.service.claimTask({
        actor: { kind: 'agent', agentId: t.alice.id, conversationId: t.channel.id },
        by: { taskNumber: 1 },
      });

      const convKinds: string[] = [];
      const unsub = t.events.subscribe(t.channel.id, e => convKinds.push(e.kind));
      t.fake.delivered = [];

      const r = await t.service.editTask({
        actor: { kind: 'agent', agentId: t.alice.id, conversationId: t.channel.id },
        by: { taskNumber: 1 },
        title: 'same title', // canonically identical to stored
        body: 'same body',
      });
      unsub();

      // Idempotent: still returns the current detail…
      expect(r.success).toBe(true);
      if (!r.success) throw new Error('expected success');
      expect(r.task.title).toBe('same title');
      // …but wrote NOTHING: no task_edit event, no task_changed, no wake, and the
      // last_editor was never stamped (the claim doesn't stamp it either).
      expect(fetchSystemMetadata(t, 'task_edit').length).toBe(0);
      expect(convKinds).toEqual([]);
      expect(t.fake.delivered).toEqual([]);
      expect(r.task.last_editor).toBeNull();
    } finally {
      t.cleanup();
    }
  });

  it('a self-edit by the assignee skips only the editor and still wakes the other members', async () => {
    const t = bootstrap();
    try {
      await createTask(t, t.bob.id, 'old');
      await t.service.claimTask({
        actor: { kind: 'agent', agentId: t.bob.id, conversationId: t.channel.id },
        by: { taskNumber: 1 },
      });
      t.fake.delivered = [];

      const r = await t.service.editTask({
        actor: { kind: 'agent', agentId: t.bob.id, conversationId: t.channel.id },
        by: { taskNumber: 1 },
        title: 'bob edits his own task',
        body: null,
      });
      expect(r.success).toBe(true);
      // The durable event still fires (history + board)…
      expect(fetchSystemMetadata(t, 'task_edit').length).toBe(1);
      // …and every OTHER channel agent is woken; only the editor (bob, who here
      // is also the assignee) is skipped — no self-wake loop.
      expect(t.fake.delivered.map(d => d.agentId)).toEqual([t.alice.id]);
    } finally {
      t.cleanup();
    }
  });

  it('an edit to a terminal (closed) task STILL wakes the members (its spec change may affect dependents/reviewers)', async () => {
    const t = bootstrap();
    try {
      await createTask(t, t.bob.id, 'old');
      await t.service.claimTask({
        actor: { kind: 'agent', agentId: t.bob.id, conversationId: t.channel.id },
        by: { taskNumber: 1 },
      });
      await t.service.updateStatus({
        actor: { kind: 'agent', agentId: t.bob.id, conversationId: t.channel.id },
        by: { taskNumber: 1 },
        status: 'closed',
      });
      t.fake.delivered = [];

      const r = await t.service.editTask({
        actor: { kind: 'agent', agentId: t.alice.id, conversationId: t.channel.id },
        by: { taskNumber: 1 },
        title: 'edited after close',
        body: null,
      });
      expect(r.success).toBe(true);
      expect(fetchSystemMetadata(t, 'task_edit').length).toBe(1);
      // Terminal no longer gates the wake (#task:1542): a closed task's spec
      // change still wakes every channel agent except the editor (alice) — here
      // that's bob, even though the task is done being executed.
      expect(t.fake.delivered.map(d => d.agentId)).toEqual([t.bob.id]);
    } finally {
      t.cleanup();
    }
  });

  it('an edit to an UNASSIGNED task still wakes every channel agent except the editor', async () => {
    const t = bootstrap();
    try {
      // Never claimed → no assignee. The wake used to require an agent assignee;
      // #task:1542 drops that, so the edit still wakes the members who might
      // pick the task up.
      await createTask(t, t.bob.id, 'unowned');
      t.fake.delivered = [];

      const r = await t.service.editTask({
        actor: { kind: 'agent', agentId: t.alice.id, conversationId: t.channel.id },
        by: { taskNumber: 1 },
        title: 'edited while unassigned',
        body: null,
      });
      expect(r.success).toBe(true);
      expect(fetchSystemMetadata(t, 'task_edit').length).toBe(1);
      // Editor is alice → bob (the only other agent) is woken despite no assignee.
      expect(t.fake.delivered.map(d => d.agentId)).toEqual([t.bob.id]);
    } finally {
      t.cleanup();
    }
  });

  it('a human editor is not an agent, so EVERY channel agent is woken (no self-skip)', async () => {
    const t = bootstrap();
    try {
      const created = await createTask(t, t.bob.id, 'old');
      const id = taskId(created);
      await t.service.claimTask({
        actor: { kind: 'agent', agentId: t.bob.id, conversationId: t.channel.id },
        by: { taskNumber: 1 },
      });
      t.fake.delivered = [];

      const r = await t.service.editTask({
        actor: { kind: 'user', userId: 'local' },
        by: { taskId: id },
        title: 'human refines the spec',
        body: null,
      });
      expect(r.success).toBe(true);
      expect(fetchSystemMetadata(t, 'task_edit').length).toBe(1);
      // The editor-skip only excludes an AGENT editor; a human editor skips
      // no one, so both channel agents are woken, each exactly once.
      const woken = t.fake.delivered.map(d => d.agentId).sort();
      expect(woken).toEqual([t.alice.id, t.bob.id].sort());
      expect(new Set(woken).size).toBe(woken.length);
    } finally {
      t.cleanup();
    }
  });

  it('notice INSERT failure rolls back the whole edit (proves UPDATE + INSERT share one txn)', async () => {
    const t = bootstrap();
    try {
      const created = await t.service.createTasks({
        conversationId: t.channel.id,
        actor: { kind: 'agent', agentId: t.bob.id, conversationId: t.channel.id },
        tasks: [{ title: 'orig title', body: 'orig body' }],
      });
      const id = taskId(created);
      await t.service.claimTask({
        actor: { kind: 'agent', agentId: t.bob.id, conversationId: t.channel.id },
        by: { taskNumber: 1 },
      });

      const convKinds: string[] = [];
      const unsub = t.events.subscribe(t.channel.id, e => convKinds.push(e.kind));
      t.fake.delivered = [];
      // Fault injection: make the task_edit notice INSERT throw — it is the first
      // (and only) insertForConversation the edit performs, after create/claim
      // already ran. If the UPDATE and this INSERT truly share ONE transaction,
      // the thrown insert rolls the UPDATE back too. This falsifies "atomicity"
      // by behavior, not by reading the code layout — it fails the day someone
      // moves emitSystemMessage out of the transaction.
      const insertSpy = vi
        .spyOn(t.messages, 'insertForConversation')
        .mockImplementationOnce(() => {
          throw new Error('injected notice insert failure');
        });

      await expect(
        t.service.editTask({
          actor: { kind: 'agent', agentId: t.alice.id, conversationId: t.channel.id },
          by: { taskNumber: 1 },
          title: 'edited title',
          body: 'edited body',
        }),
      ).rejects.toThrow('injected notice insert failure');
      unsub();
      expect(insertSpy).toHaveBeenCalledTimes(1);
      insertSpy.mockRestore();

      // The UPDATE rolled back with the failed INSERT: title/content AND the
      // last_editor stamp are all still the pre-edit values.
      const after = refetch(t, id);
      expect(after?.title).toBe('orig title');
      expect(after?.content).toBe('orig body');
      expect(after?.last_editor).toBeNull();
      // No durable event, no conversation publish, no wake — nothing escaped.
      expect(fetchSystemMetadata(t, 'task_edit').length).toBe(0);
      expect(convKinds).toEqual([]);
      expect(t.fake.delivered).toEqual([]);
    } finally {
      t.cleanup();
    }
  });

  it('notice INSERT failure rolls back claim: status unchanged, zero external effects', async () => {
    const t = bootstrap();
    try {
      const created = await t.service.createTasks({
        conversationId: t.channel.id,
        actor: { kind: 'agent', agentId: t.bob.id, conversationId: t.channel.id },
        tasks: [{ title: 'claim rollback' }],
      });
      const id = taskId(created);

      const convKinds: string[] = [];
      const unsub = t.events.subscribe(t.channel.id, e => convKinds.push(e.kind));
      t.fake.delivered = [];
      const insertSpy = vi
        .spyOn(t.messages, 'insertForConversation')
        .mockImplementationOnce(() => {
          throw new Error('injected claim notice failure');
        });

      await expect(
        t.service.claimTask({
          actor: { kind: 'agent', agentId: t.bob.id, conversationId: t.channel.id },
          by: { taskNumber: 1 },
        }),
      ).rejects.toThrow('injected claim notice failure');
      unsub();
      expect(insertSpy).toHaveBeenCalledTimes(1);
      insertSpy.mockRestore();

      // The claim write rolled back with the failed event insert.
      const after = refetch(t, id);
      expect(after?.status).toBe('todo');
      expect(after?.assignee).toBeNull();
      // No durable event, no publish, no wake.
      expect(fetchSystemMetadata(t, 'claim').length).toBe(0);
      expect(convKinds).toEqual([]);
      expect(t.fake.delivered).toEqual([]);
    } finally {
      t.cleanup();
    }
  });

  it('notice INSERT failure rolls back unclaim: status/assignee unchanged, zero external effects', async () => {
    const t = bootstrap();
    try {
      const created = await t.service.createTasks({
        conversationId: t.channel.id,
        actor: { kind: 'agent', agentId: t.bob.id, conversationId: t.channel.id },
        tasks: [{ title: 'unclaim rollback' }],
      });
      const id = taskId(created);
      await t.service.claimTask({
        actor: { kind: 'agent', agentId: t.bob.id, conversationId: t.channel.id },
        by: { taskNumber: 1 },
      });

      // Clean the create/claim deliveries so the assertion below is exact.
      t.fake.delivered = [];
      const convKinds: string[] = [];
      const unsub = t.events.subscribe(t.channel.id, e => convKinds.push(e.kind));
      const insertSpy = vi
        .spyOn(t.messages, 'insertForConversation')
        .mockImplementationOnce(() => {
          throw new Error('injected unclaim notice failure');
        });

      await expect(
        t.service.unclaimTask({
          actor: { kind: 'agent', agentId: t.bob.id, conversationId: t.channel.id },
          by: { taskNumber: 1 },
        }),
      ).rejects.toThrow('injected unclaim notice failure');
      unsub();
      expect(insertSpy).toHaveBeenCalledTimes(1);
      insertSpy.mockRestore();

      // The release write rolled back: the task is still claimed (in_progress,
      // assigned to bob) — the unclaim did not escape.
      const after = refetch(t, id);
      expect(after?.status).toBe('in_progress');
      expect(after?.assignee).toMatchObject({ type: 'agent', id: t.bob.id });
      expect(fetchSystemMetadata(t, 'unclaim').length).toBe(0);
      expect(convKinds).toEqual([]);
      expect(t.fake.delivered).toEqual([]);
    } finally {
      t.cleanup();
    }
  });

  it('notice INSERT failure rolls back status: task status unchanged, zero external effects', async () => {
    const t = bootstrap();
    try {
      const created = await t.service.createTasks({
        conversationId: t.channel.id,
        actor: { kind: 'agent', agentId: t.bob.id, conversationId: t.channel.id },
        tasks: [{ title: 'status rollback' }],
      });
      const id = taskId(created);
      await t.service.claimTask({
        actor: { kind: 'agent', agentId: t.bob.id, conversationId: t.channel.id },
        by: { taskNumber: 1 },
      });

      t.fake.delivered = [];
      const convKinds: string[] = [];
      const unsub = t.events.subscribe(t.channel.id, e => convKinds.push(e.kind));
      const insertSpy = vi
        .spyOn(t.messages, 'insertForConversation')
        .mockImplementationOnce(() => {
          throw new Error('injected status notice failure');
        });

      await expect(
        t.service.updateStatus({
          actor: { kind: 'agent', agentId: t.bob.id, conversationId: t.channel.id },
          by: { taskNumber: 1 },
          status: 'in_review',
        }),
      ).rejects.toThrow('injected status notice failure');
      unsub();
      expect(insertSpy).toHaveBeenCalledTimes(1);
      insertSpy.mockRestore();

      // The status write rolled back: still in_progress (the claim), not in_review.
      const after = refetch(t, id);
      expect(after?.status).toBe('in_progress');
      expect(fetchSystemMetadata(t, 'status').length).toBe(0);
      expect(convKinds).toEqual([]);
      expect(t.fake.delivered).toEqual([]);
    } finally {
      t.cleanup();
    }
  });

  it('create is a single atomic capability: a failed SECOND batch step rolls back the whole batch, and the next create still gets a unique number in the committed set', async () => {
    const t = bootstrap();
    try {
      // The write port exposes NO allocator primitive (#task:1980): numbering is
      // internal to createTaskRow, so application code cannot split
      // allocate/insert into a TOCTOU. This is enforced structurally at compile
      // time; the behavior below pins the create+rollback contract through the
      // OBSERVABLE read port — no native SQL in this test (native-SQL debt is
      // shrink-only).
      const actor = { kind: 'agent' as const, agentId: t.bob.id, conversationId: t.channel.id };
      // Baseline: a committed task whose number anchors the later assertions
      // (so the numbering check is not vacuous — the failed batch + success
      // must not reuse or reorder below it).
      const baseline = await t.service.createTasks({
        conversationId: t.channel.id,
        actor,
        tasks: [{ title: 'baseline' }],
      });
      if (!('tasks' in baseline)) throw new Error('baseline create failed');
      const baselineNumber = baseline.tasks[0]!.task_number;
      const tasksBefore = t.service.list({ actor });
      const eventsBefore = fetchSystemMetadata(t, 'create').length;

      // Fault the SECOND event insert in a two-task batch: task A's row + event
      // A succeed first, then event B throws. If create were not one atomic
      // capability, A would remain visible — this proves the WHOLE batch
      // (both rows + the first event) rolls back together, not just the
      // failing task's.
      const originalInsert = t.messages.insertForConversation.bind(t.messages);
      const insertSpy = vi.spyOn(t.messages, 'insertForConversation');
      let insertCalls = 0;
      // NOTE: `insertForConversation` is SYNCHRONOUS (better-sqlite3) — the
      // mock must throw synchronously, or the rejected Promise would escape the
      // transaction callback unawaited and the batch would commit.
      insertSpy.mockImplementation(((...args: Parameters<typeof t.messages.insertForConversation>) => {
        insertCalls += 1;
        if (insertCalls === 2) throw new Error('injected create notice failure');
        return originalInsert(...args);
      }) as never);

      const convKinds: string[] = [];
      const unsub = t.events.subscribe(t.channel.id, e => convKinds.push(e.kind));
      t.fake.delivered = [];

      await expect(
        t.service.createTasks({
          conversationId: t.channel.id,
          actor,
          tasks: [{ title: 'A' }, { title: 'B' }],
        }),
      ).rejects.toThrow('injected create notice failure');
      expect(insertSpy).toHaveBeenCalledTimes(2);
      unsub();
      insertSpy.mockRestore();

      // No visible task rows, no durable events, no publish/deliver escaped.
      const after = t.service.list({ actor });
      expect(after).toHaveLength(tasksBefore.length);
      expect(after.some(x => x.title === 'A' || x.title === 'B')).toBe(false);
      expect(fetchSystemMetadata(t, 'create').length).toBe(eventsBefore);
      expect(convKinds).toEqual([]);
      expect(t.fake.delivered).toEqual([]);

      // A subsequent successful create commits. Its number must be unique in
      // the committed set AND strictly greater than the baseline (reusing a
      // rolled-back number is allowed — we assert uniqueness/order, not
      // gap-freeness). We do NOT rely on list order (the board is DESC).
      const created = await t.service.createTasks({
        conversationId: t.channel.id,
        actor,
        tasks: [{ title: 'post-rollback' }],
      });
      if (!('tasks' in created)) throw new Error('createTasks failed');
      const newNumber = created.tasks[0]!.task_number;
      const nums = t.service.list({ actor }).map(x => x.task_number);
      expect(new Set(nums).size).toBe(nums.length); // no duplicates in committed set
      expect(nums).toContain(baselineNumber);
      expect(newNumber).toBeGreaterThan(baselineNumber);
    } finally {
      t.cleanup();
    }
  });
});
