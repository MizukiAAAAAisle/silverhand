import { describe, expect, it } from 'vitest';
import { findCommand } from '../src/commands/index.js';
import type { BackendClient } from '../src/client.js';

/**
 * `silverhand profile get` dispatch (#task:1823).
 *
 * The peer read is the ONLY read under this noun with a second subject, and
 * which subject you get is decided entirely by CLI flag parsing. The backend
 * suite cannot see that decision, so the three user-visible branches are
 * locked here:
 *   - no flags        → the SELF read, and the peer client method is untouched;
 *   - `--handle`      → the PEER read, handle forwarded VERBATIM (the backend
 *                       owns `@`-normalization — one authority, not two), with
 *                       `--workspace-id` forwarded when present and `undefined`
 *                       when absent (so the backend's "source workspace"
 *                       default is what applies);
 *   - `--workspace-id`
 *     without a handle → `validation_error` with ZERO requests, because a
 *                        workspace scope is meaningless for the self read and
 *                        silently ignoring it would answer a question the
 *                        caller did not ask.
 */

interface Calls {
  self: number;
  peer: Array<{ handle: string; workspaceId?: string }>;
}

function fakeClient(): { client: BackendClient; calls: Calls } {
  const calls: Calls = { self: 0, peer: [] };
  const client = {
    getProfile: async () => {
      calls.self += 1;
      return { profile: { id: 'self', name: 'me' } };
    },
    getPeerProfile: async (handle: string, workspaceId?: string) => {
      calls.peer.push({ handle, workspaceId });
      return { profile: { id: 'peer', name: handle } };
    },
  } as unknown as BackendClient;
  return { client, calls };
}

function run(flags: Record<string, unknown>, client: BackendClient): Promise<unknown> {
  const cmd = findCommand('profile', 'get')!;
  return cmd.run({
    env: {
      conversationId: 'conv',
      agentId: 'agent',
      serverUrl: 'http://127.0.0.1:4488',
      authToken: 'token',
    },
    client,
    args: { flags, positional: [], rest: [] },
  } as any);
}

describe('profile get — self vs peer dispatch (#task:1823)', () => {
  it('reads SELF when no flags are given', async () => {
    const { client, calls } = fakeClient();
    const profile = await run({}, client);
    expect(profile).toMatchObject({ id: 'self' });
    expect(calls.self).toBe(1);
    expect(calls.peer).toEqual([]);
  });

  it('reads the PEER when --handle is given, forwarding the handle verbatim', async () => {
    const { client, calls } = fakeClient();
    const profile = await run({ handle: '@bob' }, client);
    expect(profile).toMatchObject({ id: 'peer', name: '@bob' });
    // Verbatim: the `@` is stripped by the backend's shared normalizer, so the
    // CLI is not a second place that decides what a handle means.
    expect(calls.peer).toEqual([{ handle: '@bob', workspaceId: undefined }]);
    expect(calls.self).toBe(0);
  });

  it('forwards --workspace-id with a peer lookup', async () => {
    const { client, calls } = fakeClient();
    await run({ handle: 'bob', 'workspace-id': 'ws_1' }, client);
    expect(calls.peer).toEqual([{ handle: 'bob', workspaceId: 'ws_1' }]);
    expect(calls.self).toBe(0);
  });

  it('rejects --workspace-id without --handle, and issues no request at all', async () => {
    const { client, calls } = fakeClient();
    await expect(run({ 'workspace-id': 'ws_1' }, client)).rejects.toMatchObject({
      code: 'validation_error',
    });
    expect(calls.self).toBe(0);
    expect(calls.peer).toEqual([]);
  });
});
