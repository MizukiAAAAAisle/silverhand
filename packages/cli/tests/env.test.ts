import { describe, expect, it } from 'vitest';
import { loadEnv } from '../src/env.js';
import { CliError } from '../src/errors.js';

describe('loadEnv', () => {
  const happyEnv = {
    SILVERHAND_CONVERSATION_ID: 'c-1',
    SILVERHAND_AGENT_ID: 'a-1',
    SILVERHAND_SERVER_URL: 'http://127.0.0.1:8080',
    SILVERHAND_AUTH_TOKEN: 'tok-abc',
  } as const;

  it('returns a populated CliEnv when all four vars are set', () => {
    const env = loadEnv({ ...happyEnv });
    expect(env).toEqual({
      conversationId: 'c-1',
      slot: 'conversation',
      agentId: 'a-1',
      serverUrl: 'http://127.0.0.1:8080',
      authToken: 'tok-abc',
    });
  });

  it('creates an AgentSlot environment without inventing an ambient conversation', () => {
    const { SILVERHAND_CONVERSATION_ID: _ambient, ...agentSlotEnv } = happyEnv;
    expect(loadEnv(agentSlotEnv)).toEqual({
      conversationId: null,
      slot: 'agent',
      agentId: 'a-1',
      serverUrl: 'http://127.0.0.1:8080',
      authToken: 'tok-abc',
    });
  });

  it('keeps the ConversationSlot ambient coordinate as runtime identity', () => {
    expect(loadEnv({ ...happyEnv })).toMatchObject({
      conversationId: 'c-1',
      slot: 'conversation',
    });
  });

  it('throws a single validation_error listing every missing var', () => {
    let caught: unknown;
    try {
      loadEnv({});
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(CliError);
    const e = caught as CliError;
    expect(e.code).toBe('validation_error');
    expect(e.retriable).toBe(false);
    expect(e.message).not.toContain('SILVERHAND_CONVERSATION_ID');
    expect(e.message).toContain('SILVERHAND_AGENT_ID');
    expect(e.message).toContain('SILVERHAND_SERVER_URL');
    expect(e.message).toContain('SILVERHAND_AUTH_TOKEN');
  });

  it('rejects an invalid SERVER_URL', () => {
    expect(() =>
      loadEnv({ ...happyEnv, SILVERHAND_SERVER_URL: 'not-a-url' }),
    ).toThrow(/is not a valid URL/);
  });
});
