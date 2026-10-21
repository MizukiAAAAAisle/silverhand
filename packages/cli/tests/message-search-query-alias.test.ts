/**
 * Tests for `silverhand message search` query input — positional
 * `<query>` plus the `--q` / `--query` alias pair.
 *
 * Locks the contract @Alice + @Cindy aligned in #task:274:
 *   - positional `<query>`, `--q`, and `--query` are aliases (same
 *     semantics, same length cap).
 *   - Passing more than one at once fails with `subkind:
 *     'mutually_exclusive'`
 *     (NOT silently picking one). Agents that mix them up should see
 *     a structured failure, not a hidden last-wins choice.
 *   - `--scope` is gone: the range is the selector itself, and passing
 *     two selectors fails with `subkind: 'mutually_exclusive'`.
 */
import { describe, expect, it } from 'vitest';
import { findCommand } from '../src/commands/index.js';
import type { CliEnv } from '../src/env.js';
import type { ParsedArgs } from '../src/parse.js';
import type { CliError } from '../src/errors.js';

/** The wire body `message search` sends. A type alias (not an interface) so
 *  it carries an implicit index signature and the selector assertions below
 *  can probe it as a plain record. */
type SearchCall = {
  q: string;
  current_workspace?: true;
  workspace_id?: string;
  conversation_id?: string;
  include_system?: boolean;
  limit?: number;
};

function fakeSearchClient(): {
  client: { searchMessages: (input: SearchCall) => Promise<{ hits: [] }> };
  capture: () => SearchCall | null;
} {
  let last: SearchCall | null = null;
  return {
    capture: () => last,
    client: {
      searchMessages: async (input) => {
        last = input;
        return { hits: [] };
      },
    },
  };
}

const env: CliEnv = {
  conversationId: 'conv',
  slot: 'conversation',
  agentId: 'agent',
  serverUrl: 'http://localhost',
  authToken: 'tok',
};

function parsedArgs(
  flags: Record<string, string | string[] | boolean>,
  positional: string[] = [],
): ParsedArgs {
  return { flags, positional, rest: [] } as ParsedArgs;
}

const search = findCommand('message', 'search')!;

describe('message search --q / --query alias pair', () => {
  it('accepts positional <query> on its own', async () => {
    const { client, capture } = fakeSearchClient();
    await search.run({
      env,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      client: client as any,
      args: parsedArgs({}, ['hello world']),
    });
    expect(capture()!.q).toBe('hello world');
  });

  it('accepts --q on its own', async () => {
    const { client, capture } = fakeSearchClient();
    await search.run({
      env,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      client: client as any,
      args: parsedArgs({ q: 'hello world' }),
    });
    expect(capture()!.q).toBe('hello world');
  });

  it('accepts --query on its own (alias)', async () => {
    const { client, capture } = fakeSearchClient();
    await search.run({
      env,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      client: client as any,
      args: parsedArgs({ query: 'hello world' }),
    });
    expect(capture()!.q).toBe('hello world');
  });

  it('rejects multiple query forms with subkind=mutually_exclusive', async () => {
    let caught: unknown;
    try {
      await search.run({
        env,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        client: { searchMessages: async () => ({ hits: [] }) } as any,
        args: parsedArgs({ q: 'foo', query: 'bar' }, ['baz']),
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
    expect(err.message).toContain('<query>');
    expect(err.details).toEqual({ query_forms: ['--q', '--query', '<query>'] });
  });

  it('rejects multiple positional query tokens', async () => {
    let caught: unknown;
    try {
      await search.run({
        env,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        client: { searchMessages: async () => ({ hits: [] }) } as any,
        args: parsedArgs({}, ['hello', 'world']),
      });
    } catch (e) {
      caught = e;
    }
    const err = caught as CliError;
    expect(err.code).toBe('validation_error');
    expect(err.subkind).toBe('unexpected_arguments');
    expect(err.message).toContain('Quote multi-word queries');
    expect(err.details).toEqual({ positional: ['hello', 'world'] });
  });

  it('requires at least one of positional <query> / --q / --query', async () => {
    let caught: unknown;
    try {
      await search.run({
        env,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        client: { searchMessages: async () => ({ hits: [] }) } as any,
        args: parsedArgs({}),
      });
    } catch (e) {
      caught = e;
    }
    const err = caught as CliError;
    expect(err.code).toBe('validation_error');
    expect(err.message).toMatch(/<query>/);
    expect(err.message).toMatch(/--q.*--query|--query.*--q/);
  });
});

describe('message search selector-only range (#task:1945)', () => {
  /** No selector at all: the range is the calling conversation, and the
   *  request must carry NO range field — absence IS the signal, so an
   *  explicit "current" spelling would be a second way to say it. */
  it('omits every selector when none is passed', async () => {
    const { client, capture } = fakeSearchClient();
    await search.run({
      env,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      client: client as any,
      args: parsedArgs({ q: 'foo' }),
    });
    const sent = capture()! as Record<string, unknown>;
    expect(sent.q).toBe('foo');
    expect('current_workspace' in sent).toBe(false);
    expect('workspace_id' in sent).toBe(false);
    expect('conversation_id' in sent).toBe(false);
    expect('scope' in sent).toBe(false);
  });

  it('--current-workspace sends current_workspace: true and nothing else', async () => {
    const { client, capture } = fakeSearchClient();
    await search.run({
      env,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      client: client as any,
      args: parsedArgs({ q: 'foo', 'current-workspace': true }),
    });
    const sent = capture()! as Record<string, unknown>;
    expect(sent.current_workspace).toBe(true);
    expect('workspace_id' in sent).toBe(false);
    expect('conversation_id' in sent).toBe(false);
  });

  it('--workspace-id and --conversation-id each stand alone as the range', async () => {
    const byWorkspace = fakeSearchClient();
    await search.run({
      env,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      client: byWorkspace.client as any,
      args: parsedArgs({ q: 'foo', 'workspace-id': 'ws1' }),
    });
    expect(byWorkspace.capture()! as Record<string, unknown>).toMatchObject({
      workspace_id: 'ws1',
    });
    expect('current_workspace' in (byWorkspace.capture() as object)).toBe(false);

    const byConversation = fakeSearchClient();
    await search.run({
      env,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      client: byConversation.client as any,
      args: parsedArgs({ q: 'foo', 'conversation-id': 'c9' }),
    });
    expect(byConversation.capture()! as Record<string, unknown>).toMatchObject({
      conversation_id: 'c9',
    });
  });

  it('refuses --no-current-workspace instead of reading it as the default', async () => {
    // Presence IS the selector, so negating it names no range. Reading it as
    // "the default" would silently answer `--no-current-workspace
    // --workspace-id ws1`-style calls, and more importantly would let a
    // caller who typed a negation get the NARROWEST range back as if it
    // were the answer to their question.
    let caught: unknown;
    try {
      await search.run({
        env,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        client: {
          searchMessages: async () => {
            throw new Error('must not reach the network');
          },
        } as any,
        args: parsedArgs({ q: 'foo', 'current-workspace': false }),
      });
    } catch (e) {
      caught = e;
    }
    const err = caught as CliError;
    expect(err.code).toBe('validation_error');
    expect(err.subkind).toBe('empty_selector');
    expect(err.details).toEqual({ selector: '--no-current-workspace' });
  });

  it.each([
    ['workspace-id', '--workspace-id'],
    ['conversation-id', '--conversation-id'],
  ])(
    'refuses a blank %s value rather than searching the current conversation',
    async (flag, label) => {
      // `--conversation-id "$CID"` with an unset CID is the real-world shape.
      // Dropping the empty value would narrow a deliberately-named range down
      // to the calling conversation and return a plausible wrong answer.
      let caught: unknown;
      try {
        await search.run({
          env,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          client: {
            searchMessages: async () => {
              throw new Error('must not reach the network');
            },
          } as any,
          args: parsedArgs({ q: 'foo', [flag]: '' }),
        });
      } catch (e) {
        caught = e;
      }
      const err = caught as CliError;
      expect(err.code).toBe('validation_error');
      expect(err.subkind).toBe('empty_selector');
      expect(err.details).toEqual({ selector: label });
    },
  );

  it.each([
    [
      { 'current-workspace': true, 'workspace-id': 'ws1' },
      ['--current-workspace', '--workspace-id'],
    ],
    [
      { 'current-workspace': true, 'conversation-id': 'c9' },
      ['--current-workspace', '--conversation-id'],
    ],
    [{ 'workspace-id': 'ws1', 'conversation-id': 'c9' }, ['--workspace-id', '--conversation-id']],
  ])('rejects two selectors as mutually_exclusive', async (flags, expectedSelectors) => {
    let caught: unknown;
    try {
      await search.run({
        env,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        client: {
          searchMessages: async () => {
            throw new Error('must not reach the network');
          },
        } as any,
        args: parsedArgs({ q: 'foo', ...flags }),
      });
    } catch (e) {
      caught = e;
    }
    const err = caught as CliError;
    expect(err.code).toBe('validation_error');
    expect(err.subkind).toBe('mutually_exclusive');
    expect(err.details).toEqual({ selectors: expectedSelectors });
  });
});
