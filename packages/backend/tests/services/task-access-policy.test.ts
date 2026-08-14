// TaskAccessPolicy truth table (P0-g, #task:2018): participation and the
// verb capability are BOTH required, participation is judged on the task's
// OWN conversation (never its board/workspace coordinate), and the policy's
// input surface simply has no board field to consult — Board is a numbering
// namespace, not an ACL unit (agent-scoped-session-v1 §4.4).
import { describe, expect, it } from 'vitest';
import { TaskAccessPolicy } from '../../src/services/task/access-policy.js';
import type { AgentActor } from '../../src/services/task/ports.js';

const actor: AgentActor = { kind: 'agent', runtimeScope: 'conversation', agentId: 'a1', conversationId: 'frame' };
const task = { conversation_id: 'c-task', workspace_id: 'w-task' };

function policy(participates: boolean, capable: boolean): {
  policy: TaskAccessPolicy;
  calls: { participation: string[][]; capability: string[][] };
} {
  const calls = { participation: [] as string[][], capability: [] as string[][] };
  const p = new TaskAccessPolicy(
    {
      isAgentParticipant: (conversationId, agentId) => {
        calls.participation.push([conversationId, agentId]);
        return participates;
      },
    },
    (a, workspaceId, capability) => {
      calls.capability.push([a.agentId, workspaceId, capability]);
      return capable;
    },
  );
  return { policy: p, calls };
}

describe('TaskAccessPolicy (P0-g)', () => {
  it('grants only when participation AND the verb capability both hold', () => {
    expect(policy(true, true).policy.canAgentSeeTask(actor, task, 'read_tasks')).toBe(true);
    expect(policy(false, true).policy.canAgentSeeTask(actor, task, 'read_tasks')).toBe(false);
    expect(policy(true, false).policy.canAgentSeeTask(actor, task, 'read_tasks')).toBe(false);
    expect(policy(false, false).policy.canAgentSeeTask(actor, task, 'read_tasks')).toBe(false);
  });

  it("judges participation on the task's own conversation and capability on its workspace — never the caller's frame", () => {
    const { policy: p, calls } = policy(true, true);
    p.canAgentSeeTask(actor, task, 'write_tasks');
    expect(calls.participation).toEqual([['c-task', 'a1']]);
    expect(calls.capability).toEqual([['a1', 'w-task', 'write_tasks']]);
  });

  it('short-circuits: a non-participant never reaches the capability axis (no oracle through side effects)', () => {
    const { policy: p, calls } = policy(false, true);
    p.canAgentSeeTask(actor, task, 'read_tasks');
    expect(calls.capability).toEqual([]);
  });
});

describe('B1 — scope is a required discriminant, never a defaulted flag (#task:2018 review round 1)', () => {
  it('an agent task actor without a declared runtimeScope does not typecheck', () => {
    // @ts-expect-error — runtimeScope is REQUIRED: "the caller never said
    // which principal kind" must be a compile error, not a silent
    // conversation-scope reinterpretation.
    const missing: AgentActor = { kind: 'agent', agentId: 'a', conversationId: 'c' };
    void missing;
    expect(true).toBe(true);
  });

  it('the task lane holds NO second scope authority: no optional scope, no scope defaulting', async () => {
    const { readFile } = await import('node:fs/promises');
    const { join, dirname } = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const here = dirname(fileURLToPath(import.meta.url));
    const src = (rel: string) => join(here, '..', '..', 'src', rel);
    const surfaces = [
      'services/task/ports.ts',
      'services/task/access-policy.ts',
      'services/task/access.ts',
      'services/task/contracts.ts',
      'services/task-service.ts',
      'routes/internal-agent/task-routes.ts',
    ];
    for (const rel of surfaces) {
      const text = await readFile(src(rel), 'utf8');
      expect(text.includes('runtimeScope?'), `${rel}: optional scope`).toBe(false);
      expect(text.includes('runtimeScope ??'), `${rel}: scope defaulting`).toBe(false);
    }
  });
});
