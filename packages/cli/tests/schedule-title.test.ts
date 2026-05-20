import { describe, expect, it } from 'vitest';
import { findCommand } from '../src/commands/index.js';
import type { CliError } from '../src/errors.js';
import type { CliEnv } from '../src/env.js';
import type { ParsedArgs } from '../src/parse.js';

interface CreateScheduleCall {
  title?: string;
  message: string;
  target_conversation_id?: string;
  spec: { kind: 'once'; delay_seconds?: number; fire_at?: number };
}

function parsedFlags(flags: Record<string, string | string[]>): ParsedArgs {
  return { flags, positional: [], rest: [] } as ParsedArgs;
}

const env: CliEnv = {
  conversationId: 'conv',
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
      }),
    });

    expect(call).toMatchObject({
      title: 'Daily check',
      message: 'Review the build and report if it failed.',
      spec: { kind: 'once', delay_seconds: 60 },
    });
  });

  it('requires --title with a structured missing_required_flag error', async () => {
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

  it('forwards --target-conversation-id to the request body (#task:478)', async () => {
    // The schedule's target conversation = the (conversation, owner_agent)
    // session that wakes up to handle the fire AND posts the result.
    // The CLI just plumbs the flag through; backend validates membership
    // and conversation lifecycle.
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
        title: 'Channel cron',
        message: 'fire in the channel',
        kind: 'once',
        'delay-seconds': '60',
        'target-conversation-id': 'conv_target_42',
      }),
    });

    expect(call).toMatchObject({
      title: 'Channel cron',
      target_conversation_id: 'conv_target_42',
      spec: { kind: 'once', delay_seconds: 60 },
    });
  });

  it('omits target_conversation_id from the body when the flag is not set', async () => {
    // Backend defaults to the calling conversation; the CLI must NOT
    // synthesize a value or send `null`/empty string, both of which
    // would either fail zod validation or skip the default-from-cid
    // path on the server.
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
        title: 'Local cron',
        message: 'fire here',
        kind: 'once',
        'delay-seconds': '60',
      }),
    });

    expect(call).not.toBeNull();
    expect(call!).not.toHaveProperty('target_conversation_id');
  });
});
