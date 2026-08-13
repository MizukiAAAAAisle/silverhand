import { describe, expect, it, vi } from 'vitest';
import {
  AgentDeletingError,
  AgentHomeMutationCoordinator,
} from '../src/daemon/agent-home-mutation-coordinator.js';
import {
  agentHomeCommandEffect,
  commandAgentId,
  isAgentHomeMutatorEffect,
} from '../src/agent-home-command-effect.js';
import { IntentDispatcher } from '../src/daemon/dispatcher.js';

const success = (quiesced = 0) => ({
  ok: true as const,
  purged_count: 1,
  quiesced_count: quiesced,
});

describe('AgentHomeMutationCoordinator', () => {
  it('rejects a purge-capable supervisor wired to a different owner', () => {
    const dispatcherOwner = new AgentHomeMutationCoordinator();
    const supervisorOwner = new AgentHomeMutationCoordinator();
    expect(
      () =>
        new IntentDispatcher({
          logger: {} as never,
          agentHomeMutationCoordinator: dispatcherOwner,
          supervisor: {
            agentHomeMutationCoordinator: () => supervisorOwner,
            fenceAndQuiesceAgent: async () => ({ quiesced_count: 0 }),
          } as never,
        }),
    ).toThrow('split agent-home fence authorities');
  });

  it('installs the terminal fence synchronously and waits pre-fence work', async () => {
    const coordinator = new AgentHomeMutationCoordinator();
    let release!: () => void;
    const admitted = coordinator.runBounded(
      'a1',
      () => new Promise<void>(resolve => { release = resolve; }),
    );
    const rm = vi.fn(async () => success());

    const purge = coordinator.runPurge('a1', rm);
    expect(coordinator.isFenced('a1')).toBe(true);
    await expect(
      coordinator.runBounded('a1', async () => undefined),
    ).rejects.toBeInstanceOf(AgentDeletingError);
    expect(rm).not.toHaveBeenCalled();

    release();
    await admitted;
    await expect(purge).resolves.toEqual(success());
    expect(rm).toHaveBeenCalledTimes(1);
  });

  it('joins concurrent purge, caches success, and retries failures without reopening', async () => {
    const coordinator = new AgentHomeMutationCoordinator();
    let releaseFirst!: () => void;
    const firstFn = vi.fn(
      () => new Promise<ReturnType<typeof success>>(resolve => {
        releaseFirst = () => resolve(success(2));
      }),
    );
    const first = coordinator.runPurge('a1', firstFn);
    const joined = coordinator.runPurge('a1', vi.fn(async () => success(99)));
    expect(joined).toBe(first);
    await Promise.resolve();
    releaseFirst();
    await expect(first).resolves.toEqual(success(2));
    await expect(coordinator.runPurge('a1', firstFn)).resolves.toEqual(success(2));
    expect(firstFn).toHaveBeenCalledTimes(1);

    const retryable = new AgentHomeMutationCoordinator();
    await expect(
      retryable.runPurge('a2', async () => { throw new Error('partial'); }),
    ).rejects.toThrow('partial');
    expect(retryable.isFenced('a2')).toBe(true);
    await expect(
      retryable.runBounded('a2', async () => undefined),
    ).rejects.toBeInstanceOf(AgentDeletingError);
    await expect(
      retryable.runPurge('a2', async () => success(1)),
    ).resolves.toEqual(success(1));
  });
});

describe('agent-home command effect catalogue', () => {
  it('classifies every known writer and leaves reads/control outside the fence', () => {
    for (const kind of [
      'runtime_start',
      'runtime_deliver',
      'agent_materialize',
      'agent_l2_seed',
      'agent_profile_mcp_write',
      'mcp_probe',
      'agent_stale_receive',
    ] as const) {
      expect(isAgentHomeMutatorEffect(agentHomeCommandEffect(kind))).toBe(true);
    }
    expect(agentHomeCommandEffect('agent_files_purge')).toBe('purge');
    expect(agentHomeCommandEffect('agent_profile_mcp_read')).toBe('read_only');
    expect(agentHomeCommandEffect('runtime_stop')).toBe('runtime_control');
    expect(agentHomeCommandEffect('rotate_token')).toBe('none');
  });

  it('projects the same fence key from direct and MCP-source agent scopes', () => {
    expect(commandAgentId({ agent_id: 'agent-direct' })).toBe('agent-direct');
    expect(
      commandAgentId({
        source: { kind: 'profile', agent_id: 'agent-profile' },
        server_name: 'demo',
      }),
    ).toBe('agent-profile');
  });
});
