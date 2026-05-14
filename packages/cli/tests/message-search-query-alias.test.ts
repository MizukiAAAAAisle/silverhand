/**
 * Tests for `silverhand message search` query input — the `--q` /
 * `--query` alias pair.
 *
 * Locks the contract @Alice + @Cindy aligned in #task:274:
 *   - `--q` and `--query` are aliases (same semantics, same length cap).
 *   - Passing both at once fails with `subkind: 'mutually_exclusive'`
 *     (NOT silently picking one). Agents that mix them up should see
 *     a structured failure, not a hidden last-wins choice.
 *   - `--scope` enum failures carry `subkind: 'enum_invalid'` so trace
 *     sinks can group them with the task macro failures.
 */
import { describe, expect, it } from 'vitest';
import { findCommand } from '../src/commands/index.js';
import type { CliEnv } from '../src/env.js';
import type { ParsedArgs } from '../src/parse.js';
import type { CliError } from '../src/errors.js';

interface SearchCall {
  q: string;
  scope: string;
}

function fakeSearchClient(): {
  client: { searchMessages: (input: SearchCall) => Promise<{ hits: [] }> };
  capture: () => SearchCall | null;
} {
  let last: SearchCall | null = null;
  return {
    capture: () => last,
    client: {
      searchMessages: async input => {
        last = input;
        return { hits: [] };
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

const search = findCommand('message', 'search')!;

describe('message search --q / --query alias pair', () => {
  it('accepts --q on its own', async () => {
    const { client, capture } = fakeSearchClient();
    await search.run({
      env,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      client: client as any,
      args: parsedFlags({ q: 'hello world' }),
    });
    expect(capture()!.q).toBe('hello world');
  });

  it('accepts --query on its own (alias)', async () => {
    const { client, capture } = fakeSearchClient();
    await search.run({
      env,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      client: client as any,
      args: parsedFlags({ query: 'hello world' }),
    });
    expect(capture()!.q).toBe('hello world');
  });

  it('rejects --q and --query together with subkind=mutually_exclusive', async () => {
    let caught: unknown;
    try {
      await search.run({
        env,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        client: { searchMessages: async () => ({ hits: [] }) } as any,
        args: parsedFlags({ q: 'foo', query: 'bar' }),
      });
    } catch (e) {
      caught = e;
    }
    const err = caught as CliError;
    expect(err.code).toBe('validation_error');
    expect(err.subkind).toBe('mutually_exclusive');
    // The hint must name BOTH flags explicitly so the agent sees they
    // are aliases — agents reading "pass exactly one" but only seeing
    // `--q` mentioned have re-tried with two flags before.
    expect(err.message).toContain('--q');
    expect(err.message).toContain('--query');
    expect(err.details).toEqual({ flags: ['q', 'query'] });
  });

  it('requires at least one of --q / --query', async () => {
    let caught: unknown;
    try {
      await search.run({
        env,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        client: { searchMessages: async () => ({ hits: [] }) } as any,
        args: parsedFlags({}),
      });
    } catch (e) {
      caught = e;
    }
    const err = caught as CliError;
    expect(err.code).toBe('validation_error');
    expect(err.message).toMatch(/--q.*--query|--query.*--q/);
  });
});

describe('message search --scope enum validation', () => {
  it('rejects an unknown scope with subkind=enum_invalid', async () => {
    let caught: unknown;
    try {
      await search.run({
        env,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        client: { searchMessages: async () => ({ hits: [] }) } as any,
        args: parsedFlags({ q: 'foo', scope: 'global' }),
      });
    } catch (e) {
      caught = e;
    }
    const err = caught as CliError;
    expect(err.code).toBe('validation_error');
    expect(err.subkind).toBe('enum_invalid');
    expect(err.details).toMatchObject({
      flag: 'scope',
      value: 'global',
      allowed: ['current', 'workspace', 'channel'],
    });
  });
});
