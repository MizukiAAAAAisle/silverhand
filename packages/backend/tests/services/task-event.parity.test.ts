// TS→Rust parity oracle for the task lifecycle system-event vocabulary, PRODUCTION-
// SIGNED by the real `TaskService` mutation path.
//
// The `task_*` event `content` line + `metadata` JSON are a DRIFT-PRONE boundary: the
// Rust `task::event` composer must emit byte-identical output to the current
// production TS. This oracle does NOT re-hand-write the templates (that would be a
// second template signing the first). Instead it drives the REAL `TaskService`
// (create/claim/unclaim/status/edit, agent + human) over the real SQLite persistence,
// captures the exact `content` + `metadata` the production `systemEvents.insert` path
// emitted (off the published `message` scope event), and:
//
//   * with UPDATE_TASK_EVENT_FIXTURE=1 (re)writes the @generated Rust cell
//     rust/crates/backend-core/.../task/event_ts_fixture.rs the Rust replay consumes;
//   * otherwise asserts the committed cell still matches, so a production
//     task-service.ts template/metadata change fails here until the cell is
//     regenerated and the Rust composer realigned.
//
// Because the outputs come from the real service, a template edit in task-service.ts
// with no matching Rust change makes this test go red — the property the earlier
// hand-mirrored version could not provide.
//
// Regenerate: UPDATE_TASK_EVENT_FIXTURE=1 pnpm --filter @silverhand/backend exec \
//   vitest run tests/services/task-event.parity.test.ts

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { fixedConversationTitle, fixedWorkspaceName } from '@silverhand/shared';
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

// A runtime host stub: the task service only needs delivery to not throw.
class NoopRuntimeHost {
  async deliverMessage(): Promise<void> {}
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

interface Captured {
  content: string;
  metadata: Record<string, unknown>;
}

/** A real bootstrap: SQLite persistence + repos + a member human ('local') + two
 *  member agents (alice/bob), a channel, and a SECOND channel for the
 *  cross-conversation create. Everything the production path reads is real. */
function bootstrap() {
  const { db, localHostId } = openTestDb();
  const tmp = makeTempSilverhandDir();
  new HostRepo(db).ensureLocal();
  const agents = new AgentRepo(db);
  const workspaces = new WorkspaceRepo(db);
  const conversations = new ConversationRepo(db);
  const messages = new MessageRepo(db);
  const events = new ScopeEventBus('test-epoch');
  const logger: BackendLogger = {
    info: () => {},
    warn: () => {},
    error: () => {},
  };
  const taskPersistence = createSqliteTaskPersistence(db, { messages });
  const service = new TaskService({
    read: taskPersistence.read,
    board: taskPersistence.board,
    conversations: taskPersistence.conversations,
    uow: taskPersistence.uow,
    agents,
    workspaces,
    runtimeHost: new NoopRuntimeHost() as unknown as AgentRuntimeHost,
    events,
    logger,
    canUseCapability: (() => true) as unknown as TaskServiceOptions['canUseCapability'],
    canPostToConversation: () => true,
  });

  const workspace = workspaces.insert({ name: fixedWorkspaceName('eng'), description: null });
  const alice = agents.create({ name: 'alice', runtime: 'claude' }, localHostId, 'local');
  const bob = agents.create({ name: 'bob', runtime: 'claude' }, localHostId, 'local');
  agents.update(alice.id, { display_name: 'Alice Cooper' });
  agents.update(bob.id, { display_name: 'Bob Builder' });
  workspaces.insertMembership(workspace.id, alice.id);
  workspaces.insertMembership(workspace.id, bob.id);
  const channel = conversations.insertChannel({
    workspaceId: workspace.id,
    title: fixedConversationTitle('main'),
  });
  const origin = conversations.insertChannel({
    workspaceId: workspace.id,
    title: fixedConversationTitle('origin'),
  });
  conversations.addAgent(channel.id, alice.id);
  conversations.addAgent(channel.id, bob.id);
  conversations.addAgent(origin.id, alice.id);
  conversations.addAgent(origin.id, bob.id);

  return { db, tmp, service, events, workspace, channel, origin, alice, bob };
}

/** Drive `mutate` and capture the ONE `task_*` message the production path
 *  published to `conversationId` (content + metadata). */
async function capture(
  t: ReturnType<typeof bootstrap>,
  conversationId: string,
  mutate: () => Promise<unknown>,
): Promise<Captured> {
  const seen: Captured[] = [];
  const unsub = t.events.subscribe(conversationId, e => {
    if (e.kind === 'message') {
      const message = (e.payload as { message: { content: string; metadata: Record<string, unknown> } }).message;
      seen.push({ content: message.content, metadata: message.metadata });
    }
  });
  await mutate();
  unsub();
  if (seen.length !== 1) {
    throw new Error(`expected exactly one task message on ${conversationId}, got ${seen.length}`);
  }
  return seen[0]!;
}

// A conversation-frame actor (create files INTO a conversation).
const agentFrame = (t: ReturnType<typeof bootstrap>, id: string, conv: string) =>
  ({ kind: 'agent', runtimeScope: 'conversation', agentId: id, conversationId: conv }) as const;
// An agent-slot actor: the ONLY scope with a by-id mutation surface (§4.5), used for
// the by-id edit/status/claim/unclaim drives.
const agentSlot = (id: string) =>
  ({ kind: 'agent', runtimeScope: 'agent', agentId: id, conversationId: null }) as const;
const userActor = { kind: 'user', userId: 'local' } as const;

async function makeTask(t: ReturnType<typeof bootstrap>, conv: string): Promise<string> {
  const r = await t.service.createTasks({
    conversationId: conv,
    actor: agentFrame(t, t.alice.id, conv),
    tasks: [{ title: 'Ship it' }],
  });
  if (!('tasks' in r)) throw new Error('createTasks failed in harness');
  return r.tasks[0]!.id;
}

interface Case {
  name: string;
  rustKind: string;
  drive: (t: ReturnType<typeof bootstrap>) => Promise<Captured>;
}

// Each case drives the REAL service and captures the REAL emitted event. The Rust
// arm string is how the replay reconstructs the same input for the composer.
const CASES: Case[] = [
  {
    name: 'edit_agent_actor',
    rustKind: 'Kind::Edit',
    drive: async t => {
      const id = await makeTask(t, t.channel.id);
      return capture(t, t.channel.id, () =>
        t.service.editTask({ actor: agentSlot(t.alice.id), by: { taskId: id }, title: 'Ship it 2', body: null }),
      );
    },
  },
  {
    name: 'edit_user_actor',
    rustKind: 'Kind::Edit',
    drive: async t => {
      const id = await makeTask(t, t.channel.id);
      return capture(t, t.channel.id, () =>
        t.service.editTask({ actor: userActor, by: { taskId: id }, title: 'Ship it 3', body: null }),
      );
    },
  },
  {
    name: 'status_agent_actor',
    rustKind: 'Kind::Status',
    drive: async t => {
      const id = await makeTask(t, t.channel.id);
      await t.service.claimTask({ actor: agentSlot(t.alice.id), by: { taskId: id } });
      return capture(t, t.channel.id, () =>
        t.service.updateStatus({ actor: agentSlot(t.alice.id), by: { taskId: id }, status: 'in_review' }),
      );
    },
  },
  {
    name: 'status_user_actor',
    rustKind: 'Kind::Status',
    drive: async t => {
      const id = await makeTask(t, t.channel.id);
      return capture(t, t.channel.id, () =>
        t.service.updateStatus({ actor: userActor, by: { taskId: id }, status: 'in_progress' }),
      );
    },
  },
  {
    name: 'claim_agent_self',
    rustKind: 'Kind::Claim',
    drive: async t => {
      const id = await makeTask(t, t.channel.id);
      return capture(t, t.channel.id, () =>
        t.service.claimTask({ actor: agentSlot(t.alice.id), by: { taskId: id } }),
      );
    },
  },
  {
    name: 'claim_human_assigns_agent',
    rustKind: 'Kind::Claim',
    drive: async t => {
      const id = await makeTask(t, t.channel.id);
      return capture(t, t.channel.id, () =>
        t.service.claimTask({ actor: userActor, by: { taskId: id }, assignee: { agentId: t.bob.id } }),
      );
    },
  },
  {
    name: 'unclaim_agent',
    rustKind: 'Kind::Unclaim',
    drive: async t => {
      const id = await makeTask(t, t.channel.id);
      await t.service.claimTask({ actor: agentSlot(t.alice.id), by: { taskId: id } });
      return capture(t, t.channel.id, () =>
        t.service.unclaimTask({ actor: agentSlot(t.alice.id), by: { taskId: id } }),
      );
    },
  },
  {
    name: 'unclaim_human',
    rustKind: 'Kind::Unclaim',
    drive: async t => {
      const id = await makeTask(t, t.channel.id);
      await t.service.claimTask({ actor: agentSlot(t.alice.id), by: { taskId: id } });
      return capture(t, t.channel.id, () =>
        t.service.unclaimTask({ actor: userActor, by: { taskId: id } }),
      );
    },
  },
  {
    name: 'create_filed_agent',
    rustKind: 'Kind::Create',
    drive: async t =>
      capture(t, t.channel.id, () =>
        t.service.createTasks({ conversationId: t.channel.id, actor: agentFrame(t, t.alice.id, t.channel.id), tasks: [{ title: 'Ship it' }] }),
      ),
  },
  {
    name: 'create_claimed_agent',
    rustKind: 'Kind::Create',
    drive: async t =>
      capture(t, t.channel.id, () =>
        t.service.createTasks({ conversationId: t.channel.id, actor: agentFrame(t, t.alice.id, t.channel.id), tasks: [{ title: 'Ship it' }], claim: true }),
      ),
  },
  {
    name: 'create_cross_conversation',
    rustKind: 'Kind::Create',
    // Actor runs in `origin`, files into `channel` — the cross-conversation branch.
    drive: async t =>
      capture(t, t.channel.id, () =>
        t.service.createTasks({ conversationId: t.channel.id, actor: agentFrame(t, t.alice.id, t.origin.id), tasks: [{ title: 'Ship it' }] }),
      ),
  },
  {
    name: 'create_filed_human',
    rustKind: 'Kind::Create',
    drive: async t =>
      capture(t, t.channel.id, () =>
        t.service.createTasks({ conversationId: t.channel.id, actor: userActor, tasks: [{ title: 'Ship it' }] }),
      ),
  },
];

// ── Rust cell rendering (the @generated fixture, from REAL captured output) ──

function rustStr(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/→/g, '\\u{2192}');
}

/// Normalize the volatile identifiers the real DB generated (random `tasks.id` +
/// agent ids) to STABLE, role-derived ids, so the signed cell is deterministic
/// across regenerations while preserving every relationship the metadata encodes
/// (a self-claim keeps actor.id === task_assignee.id, distinct actors stay
/// distinct). The Rust replay reconstructs facts from these ids, so their exact
/// value is immaterial — only their validity + relationships are — but a stable
/// value is what lets the committed cell be byte-compared in CI.
function normalize(captured: Captured, t: ReturnType<typeof bootstrap>): Captured {
  const md = structuredClone(captured.metadata) as Record<string, unknown>;
  md.task_id = 'task-1';
  // Map the two generated agent ids to stable role ids. Do NOT derive the id from
  // metadata.name: this fixture intentionally makes handle and display_name differ.
  const stable = (holder: Record<string, unknown> | null | undefined) => {
    if (!holder) return;
    const kind = (holder.kind ?? holder.type) as string | undefined;
    if (kind === 'agent' && holder.id === t.alice.id) holder.id = 'agent-alice';
    if (kind === 'agent' && holder.id === t.bob.id) holder.id = 'agent-bob';
    // user actors keep their literal id ('local'); no rewrite needed.
  };
  stable(md.actor as Record<string, unknown>);
  stable(md.task_assignee as Record<string, unknown> | null);
  return { content: captured.content, metadata: md };
}

async function renderCell(): Promise<string> {
  const header = [
    '// @generated by packages/backend/tests/services/task-event.parity.test.ts',
    '// PRODUCTION-SIGNED: content + metadata are captured from the real TaskService',
    '// mutation path (task-service.ts), not re-hand-written. DO NOT EDIT BY HAND.',
    '// Regenerate: UPDATE_TASK_EVENT_FIXTURE=1 pnpm --filter @silverhand/backend exec \\',
    '//   vitest run tests/services/task-event.parity.test.ts',
    '//',
    '// Coverage denominator = 12 real captured cases across all 5 kinds, agent/user',
    "// actor, null/agent assignee, and create's Filed/Claimed/CrossConversation.",
    '&[',
  ].join('\n');
  const rows: string[] = [];
  for (const c of CASES) {
    const t = bootstrap();
    let captured: Captured;
    try {
      captured = normalize(await c.drive(t), t);
    } finally {
      t.tmp.cleanup();
    }
    rows.push(
      [
        '    Case {',
        `        name: "${c.name}",`,
        `        kind: ${c.rustKind},`,
        `        content: "${rustStr(captured.content)}",`,
        `        metadata: r#"${JSON.stringify(captured.metadata)}"#,`,
        '    },',
      ].join('\n'),
    );
  }
  return `${header}\n${rows.join('\n')}\n]\n`;
}

const CELL_PATH =
  process.env.TASK_EVENT_FIXTURE_OUT ??
  resolve(
    dirname(fileURLToPath(import.meta.url)),
    '../../../../rust/crates/backend-core/src/conversation_messaging/messaging/task/event_ts_fixture.rs',
  );

describe('task-event TS→Rust parity fixture (production-signed)', () => {
  it('is the committed @generated Rust cell (regenerate with UPDATE_TASK_EVENT_FIXTURE=1)', async () => {
    const cell = await renderCell();
    if (process.env.UPDATE_TASK_EVENT_FIXTURE === '1') {
      writeFileSync(CELL_PATH, cell, 'utf8');
      return;
    }
    expect(existsSync(CELL_PATH), `missing fixture cell at ${CELL_PATH}`).toBe(true);
    expect(readFileSync(CELL_PATH, 'utf8')).toBe(cell);
  });
});
