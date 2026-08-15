import { describe, expect, it } from 'vitest';
import { findCommand } from '../src/commands/index.js';
import type { CliError } from '../src/errors.js';
import type { CliEnv } from '../src/env.js';
import type { ParsedArgs } from '../src/parse.js';

interface CreateScheduleCall {
  title?: string;
  message: string;
  target_conversation?: string;
  spec: { kind: 'once'; delay_seconds?: number; fire_at?: number };
}

function parsedFlags(flags: Record<string, string | string[]>): ParsedArgs {
  return { flags, positional: [], rest: [] } as ParsedArgs;
}

const env: CliEnv = {
  conversationId: 'conv',
  slot: 'conversation',
  agentId: 'agent',
  serverUrl: 'http://localhost',
  authToken: 'tok',
};

const create = findCommand('schedule', 'create')!;

describe('schedule create title', () => {
  it('sends title separately from wake message', async () => {
    let call: CreateScheduleCall | null = null;
    await create.run({
      env,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      client: {
        createSchedule: async (input: unknown) => {
          call = input as CreateScheduleCall;
          return { schedule: { id: 's1' } };
        },
      } as any,
      args: parsedFlags({
        title: 'Daily check',
        message: 'Review the build and report if it failed.',
        kind: 'once',
        'delay-seconds': '60',
        'target-conversation': '#conv:conv',
      }),
    });

    expect(call).toMatchObject({
      title: 'Daily check',
      message: 'Review the build and report if it failed.',
      spec: { kind: 'once', delay_seconds: 60 },
    });
  });

  it('requires --title with a structured missing_required_flag error', async () => {
    // Named before the destination is even looked at: this door asks for its own
    // required flags first, so the assertion below does not depend on a target.
    let caught: unknown;
    try {
      await create.run({
        env,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        client: { createSchedule: async () => ({ schedule: { id: 's1' } }) } as any,
        args: parsedFlags({
          message: 'Review the build.',
          kind: 'once',
          'delay-seconds': '60',
        }),
      });
    } catch (e) {
      caught = e;
    }

    const err = caught as CliError;
    expect(err.code).toBe('validation_error');
    expect(err.subkind).toBe('missing_required_flag');
    expect(err.details).toEqual({ command: 'schedule create', flag: 'title' });
    expect(err.message).toContain('--title');
  });

  // The two former tests here — `--target-conversation-id` plumbed through as a
  // bare id, and the body OMITTING it so the backend could default to the calling
  // conversation — pinned a contract that #task:2021 P4-4 retired: the destination
  // is an address, required, with no ambient default. Both facts, plus the
  // removed-flag hint that migrates the old spelling, are asserted together with
  // every other door in `commands.test.ts`.
});
