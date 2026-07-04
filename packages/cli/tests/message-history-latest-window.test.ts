/**
 * CLI contract for `silverhand message history` anchors.
 *
 * #task:1316 changed the common no-anchor call from a validation
 * failure into "read the latest window". Multiple anchors remain a
 * fail-loud input error.
 */
import { describe, expect, it } from 'vitest';
import { findCommand } from '../src/commands/index.js';
import type { CliEnv } from '../src/env.js';
import type { ParsedArgs } from '../src/parse.js';
import type { CliError } from '../src/errors.js';

interface ReadHistoryCall {
  before_seq?: number;
  after_seq?: number;
  around_message_id?: string;
  include_content: boolean;
  include_system: boolean;
  limit: number;
}

function fakeReadHistoryClient(): {
  client: { readHistory: (input: ReadHistoryCall) => Promise<{ target: { thread_root_id: null }; messages: [] }> };
  capture: () => ReadHistoryCall | null;
} {
  let last: ReadHistoryCall | null = null;
  return {
    capture: () => last,
    client: {
      readHistory: async input => {
        last = input;
        return { target: { thread_root_id: null }, messages: [] };
      },
    },
  };
}

const env: CliEnv = {
  conversationId: 'conv',
  agentId: 'agent',
  serverUrl: 'http://localhost',
  authToken: 'tok',
};

function parsedArgs(flags: Record<string, string | string[]>): ParsedArgs {
  return { flags, positional: [], rest: [] } as ParsedArgs;
}

const history = findCommand('message', 'history')!;

describe('message history latest-window default', () => {
  it('omits anchor fields when no anchor flag is supplied', async () => {
    const { client, capture } = fakeReadHistoryClient();
    await history.run({
      env,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      client: client as any,
      args: parsedArgs({}),
    });

    expect(capture()).toEqual({
      include_content: false,
      include_system: true,
      limit: 50,
    });
  });

  it('still rejects multiple anchors', async () => {
    let caught: unknown;
    try {
      await history.run({
        env,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        client: { readHistory: async () => ({ target: { thread_root_id: null }, messages: [] }) } as any,
        args: parsedArgs({ 'before-seq': '10', 'after-seq': '1' }),
      });
    } catch (e) {
      caught = e;
    }
    const err = caught as CliError;
    expect(err.code).toBe('validation_error');
    expect(err.message).toContain('at most one');
    expect(err.message).toContain('latest window');
  });
});
