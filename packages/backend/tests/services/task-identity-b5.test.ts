// P0-g B5 (#task:2018 review round 1) — canonical identity survives the
// transaction boundary.
//
// The failure mode under test: a by-id mutation prechecks the row, keeps only
// `(workspace_id, task_number)`, and the transaction re-reads BY NUMBER. If
// the original row disappears between precheck and tx (cascade-shaped) and
// the board's max number is reallocated, the write lands on ANOTHER task
// after passing the replacement's participation. Post-fix, all three
// workflow transactions re-read by the ORIGINAL selector, so a swapped
// same-number row is a `task_not_found` for the id arm with zero writes —
// while the by-number arm, whose contract IS the local shorthand, still hits
// whatever the number names.
//
// The swap is injected between precheck and tx through a wrapped UnitOfWork;
// the replacement is minted through the real repo write port so the number
// reallocation is the production allocator's own behavior (MAX+1 after the
// max row vanished). The one native DELETE stands in for the cascade because
// no product task-deletion path exists (ledgered in db-boundary inventory).
import { fixedWorkspaceName } from '@silverhand/shared';
import { describe, expect, it, vi } from 'vitest';
import { fixedConversationTitle } from '@silverhand/shared';
import { AgentRepo } from '../../src/repos/agent-repo.js';
import { ConversationRepo } from '../../src/repos/conversation-repo.js';
import { HostRepo } from '../../src/repos/host-repo.js';
import { MessageRepo } from '../../src/repos/message-repo.js';
import { WorkspaceRepo } from '../../src/repos/workspace-repo.js';
import { createSqliteTaskPersistence } from '../../src/repos/task-persistence.js';
import { TaskService, type TaskServiceOptions } from '../../src/services/task-service.js';
import type {
  TaskUnitOfWork,
  TaskWriteAuthorityPort,
} from '../../src/services/task/ports.js';
import type { BackendLogger } from '../../src/context.js';
import type { AgentRuntimeHost } from '../../src/runtime/agent-runtime-host.js';
import { ScopeEventBus } from '../../src/ws/scope-event-bus.js';
import { makeTempSilverhandDir, openTestDb } from '../utils/db.js';

function bootstrap() {
  const { db, localHostId } = openTestDb();
  const tmp = makeTempSilverhandDir();
  new HostRepo(db).ensureLocal();
  const agents = new AgentRepo(db);
  const workspaces = new WorkspaceRepo(db);
  const conversations = new ConversationRepo(db);
  const messages = new MessageRepo(db);
  const events = new ScopeEventBus('test-epoch');
  const logger: BackendLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const persistence = createSqliteTaskPersistence(db, { messages });
  const writeAuthority: TaskWriteAuthorityPort = {
    canPostToConversation: () => true,
  };

  /** One-shot interposer: runs `swap` after any precheck reads, immediately
   *  before the next workflow transaction begins. */
  let pendingSwap: (() => void) | null = null;
  const trippedUow: TaskUnitOfWork = {
    atomically(authority, fn) {
      if (pendingSwap) {
        const swap = pendingSwap;
        pendingSwap = null;
        swap();
      }
      return persistence.uow.atomically(authority, fn);
    },
  };

  const serviceOptions = (uow: TaskUnitOfWork): TaskServiceOptions => ({
    read: persistence.read,
    board: persistence.board,
    conversations: persistence.conversations,
    uow,
    agents,
    workspaces,
    runtimeHost: { deliverMessage: async () => {} } as unknown as AgentRuntimeHost,
    events,
    logger,
    canUseCapability: (() => true) as unknown as TaskServiceOptions['canUseCapability'],
    canPostToConversation: writeAuthority.canPostToConversation,
  });
  const service = new TaskService(serviceOptions(trippedUow));

  const workspace = workspaces.insert({ name: fixedWorkspaceName('eng'), description: null });
  const alice = agents.create({ name: 'alice', runtime: 'claude' }, localHostId, 'local');
  workspaces.insertMembership(workspace.id, alice.id);
  const channel = conversations.insertChannel({
    workspaceId: workspace.id,
    title: fixedConversationTitle('main'),
  });
  conversations.addAgent(channel.id, alice.id);

  const actor = {
    kind: 'agent',
    runtimeScope: 'agent',
    agentId: alice.id,
    conversationId: channel.id,
  } as const;

  /** Delete the victim row (cascade stand-in, native — no product deletion
   *  path exists) and mint a replacement through the REAL write port, letting
   *  the production allocator reuse the vacated max number. */
  const armSwap = (victimTaskId: string): { replacement: () => { id: string; taskNumber: number } } => {
    let minted: { id: string; taskNumber: number } | null = null;
    pendingSwap = () => {
      db.prepare('DELETE FROM tasks WHERE id = ?').run(victimTaskId);
      minted = persistence.uow.atomically(writeAuthority, tx =>
        tx.tasks.createTaskRow({
          conversationId: channel.id,
          threadRootId: null,
          title: 'replacement',
          content: '',
          creatorKind: 'agent',
          creatorAgentId: alice.id,
          creatorUserId: null,
          sourceMessageId: null,
          claimByAgentId: null,
          createdAt: Date.now(),
        }),
      );
    };
    return {
      replacement: () => {
        if (!minted) throw new Error('swap never fired');
        return minted;
      },
    };
  };

  async function mintVictim(title: string): Promise<{ id: string; task_number: number }> {
    const created = (await service.createTasks({
      conversationId: channel.id,
      actor,
      tasks: [{ title }],
    })) as { tasks: Array<{ id: string; task_number: number }> };
    return created.tasks[0]!;
  }

  return { db, tmp, service, persistence, actor, armSwap, mintVictim, cleanup: tmp.cleanup };
}

describe('B5 — the id arm never degrades into a number at the tx boundary (#task:2018)', () => {
  it('claim --id on a swapped same-number row: task_not_found, replacement untouched; by-number control hits the number', async () => {
    const t = bootstrap();
    try {
      const victim = await t.mintVictim('victim');
      const swap = t.armSwap(victim.id);
      const r = await t.service.claimTask({ actor: t.actor, by: { taskId: victim.id } });
      expect(r).toEqual({
        success: false,
        code: 'task_not_found',
        reason: 'task not found',
        id: victim.id,
      });
      // The replacement (which inherited the vacated number) was NOT written.
      const rep = swap.replacement();
      expect(rep.taskNumber).toBe(victim.task_number);
      const repRow = t.persistence.read.fetchTaskById(rep.id);
      expect(repRow?.status).toBe('todo');
      expect(repRow?.assignee_agent_id).toBeNull();

      // By-number CONTROL: the local shorthand's contract IS the number, so
      // the same swap timing lands on whatever the number now names.
      const victim2 = await t.mintVictim('victim2');
      const swap2 = t.armSwap(victim2.id);
      const r2 = await t.service.claimTask({
        actor: t.actor,
        by: { taskNumber: victim2.task_number },
      });
      expect(r2.success).toBe(true);
      expect(r2.id).toBe(swap2.replacement().id);
    } finally {
      t.cleanup();
    }
  });

  it('unclaim --id and status --id fold the same way with zero writes to the replacement', async () => {
    const t = bootstrap();
    try {
      for (const verb of ['unclaim', 'status'] as const) {
        const victim = await t.mintVictim(`victim-${verb}`);
        // Claim first so the victim would otherwise be mutable by its assignee.
        const claimed = await t.service.claimTask({ actor: t.actor, by: { taskId: victim.id } });
        expect(claimed.success).toBe(true);
        const swap = t.armSwap(victim.id);
        const result =
          verb === 'unclaim'
            ? await t.service.unclaimTask({ actor: t.actor, by: { taskId: victim.id } })
            : await t.service.updateStatus({
                actor: t.actor,
                by: { taskId: victim.id },
                status: 'in_review',
              });
        expect(result).toEqual({
          success: false,
          code: 'task_not_found',
          reason: 'task not found',
        });
        const rep = t.persistence.read.fetchTaskById(swap.replacement().id);
        expect(rep?.status).toBe('todo');
        expect(rep?.assignee_agent_id).toBeNull();
      }
    } finally {
      t.cleanup();
    }
  });
});
