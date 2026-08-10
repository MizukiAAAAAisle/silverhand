/**
 * Tests for `silverhand task list --status` filter macros and
 * `silverhand task status --status` mutation guards.
 *
 * Locks the contract @Alice + @Cindy aligned in #task:274:
 *   - `task list` accepts `active|open|pending|all` as filter macros
 *     plus comma-joined values, expanded server-side to canonical
 *     `TaskStatus` values.
 *   - `task status` is the mutation; macros must be rejected with
 *     `subkind: 'enum_invalid'` and a message that points back to
 *     `task list`. This is the boundary that prevents an agent from
 *     writing an aggregate "active" word into the DB.
 */
import { describe, expect, it } from 'vitest';
import { findCommand } from '../src/commands/index.js';
import type { CliEnv } from '../src/env.js';
import type { ParsedArgs } from '../src/parse.js';
import type { CliError } from '../src/errors.js';

interface ListTasksCall {
  status?: readonly string[];
  task_number?: readonly number[];
}

function fakeListClient(): {
  client: { listTasks: (input: ListTasksCall) => Promise<{ tasks: [] }> };
  capture: () => ListTasksCall | null;
} {
  let last: ListTasksCall | null = null;
  return {
    capture: () => last,
    client: {
      listTasks: async (input: ListTasksCall) => {
        last = input;
        return { tasks: [] };
      },
    },
  };
}

function fakeUpdateClient(): {
  client: {
    updateTaskStatus: (input: {
      task_number: number;
      status: string;
    }) => Promise<{ ok: true }>;
  };
  capture: () => { task_number: number; status: string } | null;
} {
  let last: { task_number: number; status: string } | null = null;
  return {
    capture: () => last,
    client: {
      updateTaskStatus: async input => {
        last = input;
        return { ok: true } as const;
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

function parsedFlags(flags: Record<string, string | string[]>): ParsedArgs {
  return { flags, positional: [], rest: [] } as ParsedArgs;
}

/** `task status` takes the task number as a positional operand; only
 *  `--status` remains a flag. */
function parsedStatusArgs(
  taskNumber: string,
  flags: Record<string, string | string[]>,
): ParsedArgs {
  return { flags, positional: [taskNumber], rest: [] } as ParsedArgs;
}

describe('task list --status filter macros', () => {
  const list = findCommand('task', 'list');
  if (!list) throw new Error('task list command missing');

  it('passes canonical statuses through verbatim', async () => {
    const { client, capture } = fakeListClient();
    await list.run({
      env,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      client: client as any,
      args: parsedFlags({ status: ['todo', 'in_review', 'closed'] }),
    });
    const call = capture();
    expect(call).not.toBeNull();
    expect(call!.status).toEqual(['todo', 'in_review', 'closed']);
  });

  it('expands `active` to todo + in_progress + in_review', async () => {
    const { client, capture } = fakeListClient();
    await list.run({
      env,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      client: client as any,
      args: parsedFlags({ status: ['active'] }),
    });
    expect(capture()!.status).toEqual(['todo', 'in_progress', 'in_review']);
  });

  it('treats `open` as a synonym of `active`', async () => {
    const { client, capture } = fakeListClient();
    await list.run({
      env,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      client: client as any,
      args: parsedFlags({ status: ['open'] }),
    });
    expect(capture()!.status).toEqual(['todo', 'in_progress', 'in_review']);
  });

  it('expands `pending` to just todo', async () => {
    const { client, capture } = fakeListClient();
    await list.run({
      env,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      client: client as any,
      args: parsedFlags({ status: ['pending'] }),
    });
    expect(capture()!.status).toEqual(['todo']);
  });

  it('treats `all` as a no-filter sentinel (status field is omitted from the request)', async () => {
    // `all` semantically means "do not narrow the board" — NOT
    // "include every status currently in the enum". Treating it as
    // the latter would still emit a `status` query key (polluting
    // cli-*.log) AND silently exclude any new canonical status added
    // in the future. The contract: `all` short-circuits the expansion
    // and the request omits the filter entirely.
    const { client, capture } = fakeListClient();
    await list.run({
      env,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      client: client as any,
      args: parsedFlags({ status: ['all'] }),
    });
    expect(capture()!.status).toBeUndefined();
  });

  it('lets `all` override narrower tokens supplied alongside it', async () => {
    // `--status all,done` is contradictory ("everything" + "only
    // done"). The broadest token wins so an agent typing `all`
    // anywhere in the list reliably gets the no-filter view.
    const { client, capture } = fakeListClient();
    await list.run({
      env,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      client: client as any,
      args: parsedFlags({ status: ['done', 'all', 'active'] }),
    });
    expect(capture()!.status).toBeUndefined();
  });

  it('splits comma-joined values', async () => {
    const { client, capture } = fakeListClient();
    await list.run({
      env,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      client: client as any,
      args: parsedFlags({ status: ['active,done'] }),
    });
    // active expands to 3, then done is added → 4 distinct values.
    expect(capture()!.status).toEqual([
      'todo',
      'in_progress',
      'in_review',
      'done',
    ]);
  });

  it('deduplicates overlapping macros without losing order', async () => {
    const { client, capture } = fakeListClient();
    await list.run({
      env,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      client: client as any,
      args: parsedFlags({ status: ['active', 'pending', 'todo'] }),
    });
    // active → [todo,in_progress,in_review], pending → [todo] dup,
    // todo → dup. Result preserves the order in which each canonical
    // status was first inserted.
    expect(capture()!.status).toEqual(['todo', 'in_progress', 'in_review']);
  });

  it('rejects an unknown status with subkind=enum_invalid and details', async () => {
    let caught: unknown;
    try {
      await list.run({
        env,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        client: { listTasks: async () => ({ tasks: [] }) } as any,
        args: parsedFlags({ status: ['bogus'] }),
      });
    } catch (e) {
      caught = e;
    }
    const err = caught as CliError;
    expect(err.code).toBe('validation_error');
    expect(err.subkind).toBe('enum_invalid');
    expect(err.message).toContain('--status');
    expect(err.message).toContain('bogus');
    expect(err.details).toMatchObject({ flag: 'status', value: 'bogus' });
    expect(err.details!.allowed).toEqual(
      expect.arrayContaining(['todo', 'active', 'all']),
    );
  });
});

describe('task status --status mutation guards', () => {
  const status = findCommand('task', 'status');
  if (!status) throw new Error('task status command missing');

  it('accepts a canonical update status', async () => {
    const { client, capture } = fakeUpdateClient();
    await status.run({
      env,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      client: client as any,
      args: parsedStatusArgs('7', { status: 'in_review' }),
    });
    expect(capture()).toEqual({ task_number: 7, status: 'in_review' });
  });

  it('accepts closed as a writable status', async () => {
    const { client, capture } = fakeUpdateClient();
    await status.run({
      env,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      client: client as any,
      args: parsedStatusArgs('7', { status: 'closed' }),
    });
    expect(capture()).toEqual({ task_number: 7, status: 'closed' });
  });

  it('accepts todo as a writable status for closed-task reopen', async () => {
    const { client, capture } = fakeUpdateClient();
    await status.run({
      env,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      client: client as any,
      args: parsedStatusArgs('7', { status: 'todo' }),
    });
    expect(capture()).toEqual({ task_number: 7, status: 'todo' });
  });

  it.each(['active', 'open', 'pending', 'all'] as const)(
    'rejects list-only macro %s with enum_invalid + reason=list_only_macro',
    async macro => {
      let caught: unknown;
      try {
        await status.run({
          env,
          client: {
            updateTaskStatus: async () => ({ ok: true } as const),
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
          } as any,
          args: parsedStatusArgs('7', { status: macro }),
        });
      } catch (e) {
        caught = e;
      }
      const err = caught as CliError;
      expect(err.code).toBe('validation_error');
      expect(err.subkind).toBe('enum_invalid');
      expect(err.message).toContain(macro);
      // Must point the agent at the list command — without this, the
      // agent reads the failure as a typo and just guesses again.
      expect(err.message).toContain('silverhand task list');
      expect(err.details).toMatchObject({
        flag: 'status',
        value: macro,
        reason: 'list_only_macro',
      });
      expect(err.details!.allowed).toEqual([
        'todo',
        'in_progress',
        'in_review',
        'done',
        'closed',
      ]);
    },
  );
});
