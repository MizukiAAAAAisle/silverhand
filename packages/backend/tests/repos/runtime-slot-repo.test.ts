import { describe, expect, it } from 'vitest';
import { AgentRepo } from '../../src/repos/agent-repo.js';
import { ConversationRepo } from '../../src/repos/conversation-repo.js';
import { RuntimeSlotRepo } from '../../src/repos/runtime-slot-repo.js';
import { WorkspaceRepo } from '../../src/repos/workspace-repo.js';
import { openTestDb } from '../utils/db.js';

function bootstrap() {
  const { db, localHostId, viewerUserId } = openTestDb();
  const agents = new AgentRepo(db);
  const conversations = new ConversationRepo(db);
  const runtimeSlots = new RuntimeSlotRepo(db);
  const workspace = new WorkspaceRepo(db).insert({
    name: 'runtime-slot-authority',
    description: null,
  });
  const conversation = conversations.insertChannel({
    workspaceId: workspace.id,
    title: 'runtime-slot-authority',
  });
  const agent = agents.create(
    { name: 'runtime-slot-agent', runtime: 'codex' },
    localHostId,
    viewerUserId,
  );
  conversations.addAgent(conversation.id, agent.id);
  return { db, runtimeSlots, conversationId: conversation.id, agentId: agent.id };
}

describe('RuntimeSlotRepo scoped custody authority', () => {
  it('changes daemon custody by generation without changing stable slot identity', () => {
    const t = bootstrap();
    try {
      const initial = t.runtimeSlots.getConversation(t.conversationId, t.agentId);
      expect(initial).toMatchObject({ generation: 0, observed_status: 'idle' });

      const first = t.runtimeSlots.claimGeneration({
        scope: {
          kind: 'conversation',
          conversationId: t.conversationId,
          agentId: t.agentId,
        },
        daemonInstanceId: 'daemon-a',
        pid: 101,
      });
      const second = t.runtimeSlots.claimGeneration({
        scope: {
          kind: 'conversation',
          conversationId: t.conversationId,
          agentId: t.agentId,
        },
        daemonInstanceId: 'daemon-b',
        pid: 202,
      });

      expect(first).toMatchObject({
        id: initial!.id,
        generation: 1,
        claimed_by_daemon_instance_id: 'daemon-a',
      });
      expect(second).toMatchObject({
        id: initial!.id,
        generation: 2,
        claimed_by_daemon_instance_id: 'daemon-b',
      });
      expect(
        t.db
          .prepare<[], { count: number }>(
            'SELECT COUNT(*) AS count FROM agent_runtime_slots',
          )
          .get()?.count,
      ).toBe(1);
    } finally {
      t.db.close();
    }
  });

  it('rejects stale generation projections without changing current state or history', () => {
    const t = bootstrap();
    try {
      const scope = {
        kind: 'conversation' as const,
        conversationId: t.conversationId,
        agentId: t.agentId,
      };
      const first = t.runtimeSlots.claimGeneration({
        scope,
        daemonInstanceId: 'daemon-old',
        pid: 111,
      })!;
      const second = t.runtimeSlots.claimGeneration({
        scope,
        daemonInstanceId: 'daemon-current',
        pid: 222,
      })!;
      const eventCount = t.runtimeSlots.listEvents(second.id).length;

      expect(
        t.runtimeSlots.compareAndSetProjection({
          scope,
          expectedGeneration: first.generation,
          expectedDaemonInstanceId: 'daemon-old',
          patch: { status: 'crashed', pid: null },
        }),
      ).toBeNull();
      expect(t.runtimeSlots.get(scope)).toMatchObject({
        generation: second.generation,
        claimed_by_daemon_instance_id: 'daemon-current',
        observed_status: 'starting',
        observed_pid: 222,
      });
      expect(t.runtimeSlots.listEvents(second.id)).toHaveLength(eventCount);
    } finally {
      t.db.close();
    }
  });

  it('makes finalization terminal for the exact generation custody token', () => {
    const t = bootstrap();
    try {
      const scope = {
        kind: 'conversation' as const,
        conversationId: t.conversationId,
        agentId: t.agentId,
      };
      const claimed = t.runtimeSlots.claimGeneration({
        scope,
        daemonInstanceId: 'daemon-finalizing',
        pid: 404,
      })!;
      expect(
        t.runtimeSlots.updateCurrentProjection(scope, {
          status: 'crashed',
          claimedByDaemonInstanceId: null,
        }),
      ).toBeNull();
      expect(
        t.runtimeSlots.compareAndSetProjection({
          scope,
          expectedGeneration: claimed.generation,
          expectedDaemonInstanceId: 'daemon-impostor',
          patch: { status: 'active', pid: 999 },
        }),
      ).toBeNull();
      t.runtimeSlots.compareAndSetProjection({
        scope,
        expectedGeneration: claimed.generation,
        expectedDaemonInstanceId: 'daemon-finalizing',
        patch: { status: 'active', cliSessionId: 'resume-after-exit' },
      });
      const finalized = t.runtimeSlots.finalizeGeneration({
        scope,
        expectedGeneration: claimed.generation,
        expectedDaemonInstanceId: 'daemon-finalizing',
        status: 'idle',
      })!;
      const eventCount = t.runtimeSlots.listEvents(finalized.id).length;

      expect(finalized).toMatchObject({
        generation: claimed.generation,
        claimed_by_daemon_instance_id: null,
        observed_status: 'idle',
        observed_pid: null,
        cli_session_id: 'resume-after-exit',
      });
      expect(
        t.runtimeSlots.compareAndSetProjection({
          scope,
          expectedGeneration: claimed.generation,
          expectedDaemonInstanceId: 'daemon-finalizing',
          patch: { status: 'active', pid: 505 },
        }),
      ).toBeNull();
      expect(
        t.runtimeSlots.finalizeGeneration({
          scope,
          expectedGeneration: claimed.generation,
          expectedDaemonInstanceId: 'daemon-finalizing',
          status: 'crashed',
        }),
      ).toBeNull();
      expect(t.runtimeSlots.get(scope)).toEqual(finalized);
      expect(t.runtimeSlots.listEvents(finalized.id)).toHaveLength(eventCount);
    } finally {
      t.db.close();
    }
  });

  it('refuses nested generation claims before reading or writing the slot', () => {
    const t = bootstrap();
    try {
      const scope = {
        kind: 'conversation' as const,
        conversationId: t.conversationId,
        agentId: t.agentId,
      };
      const before = t.runtimeSlots.get(scope)!;
      const eventCount = t.runtimeSlots.listEvents(before.id).length;

      expect(() =>
        t.db.transaction(() =>
          t.runtimeSlots.claimGeneration({
            scope,
            daemonInstanceId: 'nested-daemon',
          }),
        )(),
      ).toThrow(/requires a root transaction/);
      expect(t.runtimeSlots.get(scope)).toEqual(before);
      expect(t.runtimeSlots.listEvents(before.id)).toHaveLength(eventCount);
    } finally {
      t.db.close();
    }
  });

  it('clears process observation while preserving durable CLI resume state', () => {
    const t = bootstrap();
    try {
      const scope = {
        kind: 'conversation' as const,
        conversationId: t.conversationId,
        agentId: t.agentId,
      };
      t.runtimeSlots.updateCurrentProjection(scope, {
        status: 'active',
        pid: 303,
        cliSessionId: 'resume-session',
      });
      const eventCount = t.runtimeSlots.listEvents(
        t.runtimeSlots.get(scope)!.id,
      ).length;
      t.runtimeSlots.updateCurrentProjection(scope, {
        status: 'active',
        pid: 303,
        cliSessionId: 'resume-session',
      });
      expect(t.runtimeSlots.listEvents(t.runtimeSlots.get(scope)!.id)).toHaveLength(
        eventCount,
      );
      const cleared = t.runtimeSlots.updateCurrentProjection(scope, {
        status: 'idle',
        pid: null,
        claimedByDaemonInstanceId: null,
      });

      expect(cleared).toMatchObject({
        observed_status: 'idle',
        observed_pid: null,
        claimed_by_daemon_instance_id: null,
        cli_session_id: 'resume-session',
      });
    } finally {
      t.db.close();
    }
  });

  it('reads current state only from the slot, never by folding historical events', () => {
    const t = bootstrap();
    try {
      const slot = t.runtimeSlots.getConversation(t.conversationId, t.agentId)!;
      t.db
        .prepare(
          `INSERT INTO agent_runtime_events (
             slot_id, agent_id, conversation_id,
             generation, event_kind, daemon_instance_id,
             observed_status, observed_pid, cli_session_id, occurred_at
           ) VALUES (?, ?, ?, ?, 'projection_updated', ?, 'crashed', ?, ?, ?)`,
        )
        .run(
          slot.id,
          slot.agent_id,
          slot.conversation_id,
          999,
          'historical-daemon',
          999,
          'historical-session',
          Date.now(),
        );

      expect(t.runtimeSlots.getConversation(t.conversationId, t.agentId)).toMatchObject({
        generation: 0,
        claimed_by_daemon_instance_id: null,
        observed_status: 'idle',
        observed_pid: null,
        cli_session_id: null,
      });
    } finally {
      t.db.close();
    }
  });

  it('retains interpretable append-only history after the current slot is deleted', () => {
    const t = bootstrap();
    try {
      const slot = t.runtimeSlots.getConversation(t.conversationId, t.agentId)!;
      t.runtimeSlots.claimGeneration({
        scope: {
          kind: 'conversation',
          conversationId: t.conversationId,
          agentId: t.agentId,
        },
        daemonInstanceId: 'daemon-before-delete',
      });

      t.db.prepare('DELETE FROM agents WHERE id = ?').run(t.agentId);

      expect(t.runtimeSlots.getConversation(t.conversationId, t.agentId)).toBeNull();
      expect(t.runtimeSlots.listEvents(slot.id)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            slot_id: slot.id,
            agent_id: t.agentId,
            conversation_id: t.conversationId,
            event_kind: 'generation_claimed',
          }),
        ]),
      );
      expect(t.db.pragma('foreign_key_check')).toEqual([]);
    } finally {
      t.db.close();
    }
  });
});
