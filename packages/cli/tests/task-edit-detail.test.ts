/**
 * `silverhand task edit` / `task detail` command guards + wire mapping.
 * Locks: edit requires --task-number and at least one of --title / --body,
 * and maps the flags to the last-write-wins wire shape (no expected_revision);
 * detail requires --task-number and resolves by task number.
 */
import { describe, expect, it } from 'vitest';
import { findCommand } from '../src/commands/index.js';
import type { CliEnv } from '../src/env.js';
import type { ParsedArgs } from '../src/parse.js';

const env: CliEnv = {
  conversationId: 'conv',
  agentId: 'agent',
  serverUrl: 'http://localhost',
  authToken: 'tok',
};

function parsedFlags(flags: Record<string, string | string[]>): ParsedArgs {
  return { flags, positional: [], rest: [] } as ParsedArgs;
}

function fakeEditClient(): {
  client: { editTask: (input: Record<string, unknown>) => Promise<{ success: true }> };
  capture: () => Record<string, unknown> | null;
} {
  let last: Record<string, unknown> | null = null;
  return {
    capture: () => last,
    client: {
      editTask: async input => {
        last = input;
        return { success: true } as const;
      },
    },
  };
}

describe('task edit guards + wire mapping', () => {
  const edit = findCommand('task', 'edit');
  if (!edit) throw new Error('task edit command missing');

  it('maps task-number + title/body to the wire shape', async () => {
    const { client, capture } = fakeEditClient();
    await edit.run({
      env,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      client: client as any,
      args: parsedFlags({
        'task-number': '5',
        title: 'new',
        body: 'body',
      }),
    });
    expect(capture()).toEqual({
      task_number: 5,
      title: 'new',
      body: 'body',
    });
  });

  it('passes an explicit empty --body through (clears content)', async () => {
    const { client, capture } = fakeEditClient();
    await edit.run({
      env,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      client: client as any,
      args: parsedFlags({ 'task-number': '7', body: '' }),
    });
    expect(capture()).toEqual({ task_number: 7, body: '' });
  });

  it('rejects a missing --task-number', async () => {
    await expect(
      edit.run({
        env,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        client: {} as any,
        args: parsedFlags({ title: 'x' }),
      }),
    ).rejects.toMatchObject({ subkind: 'missing_required_flag' });
  });

  it('rejects when neither --title nor --body is supplied', async () => {
    await expect(
      edit.run({
        env,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        client: {} as any,
        args: parsedFlags({ 'task-number': '1' }),
      }),
    ).rejects.toMatchObject({ subkind: 'missing_required_flag' });
  });
});

describe('task detail guard', () => {
  const detail = findCommand('task', 'detail');
  if (!detail) throw new Error('task detail command missing');

  it('calls getTaskDetail with the task number', async () => {
    let seen: number | null = null;
    await detail.run({
      env,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      client: {
        getTaskDetail: async (input: { task_number: number }) => {
          seen = input.task_number;
          return { task: {} };
        },
      } as any,
      args: parsedFlags({ 'task-number': '9' }),
    });
    expect(seen).toBe(9);
  });

  it('rejects a missing --task-number', async () => {
    await expect(
      detail.run({
        env,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        client: {} as any,
        args: parsedFlags({}),
      }),
    ).rejects.toMatchObject({ subkind: 'missing_required_flag' });
  });
});
