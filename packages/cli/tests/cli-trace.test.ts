/**
 * Tests for the CLI's fire-and-forget pre-flight failure tracer.
 *
 * The tracer's contract is unusual: every behavior is "do not affect
 * the caller". So most assertions are negative — `did not throw`,
 * `did not fetch`, `did not log`. The positive case verifies the URL
 * + headers + body shape sent when env is loadable AND no business
 * request was attempted yet.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  markRequestAttempted,
  reportPreflightFailure,
  resetTraceStateForTesting,
  sanitizeTraceErrorMessage,
  wasRequestAttempted,
} from '../src/cli-trace.js';

const ENV_KEYS = {
  cid: 'SILVERHAND_CONVERSATION_ID',
  aid: 'SILVERHAND_AGENT_ID',
  url: 'SILVERHAND_SERVER_URL',
  token: 'SILVERHAND_AUTH_TOKEN',
} as const;

const FULL_ENV = {
  [ENV_KEYS.cid]: 'conv-1',
  [ENV_KEYS.aid]: 'agent-1',
  [ENV_KEYS.url]: 'http://localhost:9999',
  [ENV_KEYS.token]: 'tok-1',
};

describe('cli-trace fire-and-forget reporter', () => {
  let originalEnv: NodeJS.ProcessEnv;
  let fetchMock: ReturnType<typeof vi.fn>;
  let originalFetch: typeof globalThis.fetch | undefined;

  beforeEach(() => {
    resetTraceStateForTesting();
    originalEnv = { ...process.env };
    Object.assign(process.env, FULL_ENV);
    fetchMock = vi.fn().mockResolvedValue(new Response('{"ok":true}'));
    originalFetch = globalThis.fetch;
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;
  });

  afterEach(() => {
    process.env = originalEnv;
    if (originalFetch) globalThis.fetch = originalFetch;
    resetTraceStateForTesting();
  });

  it('posts a trace to the cli-trace endpoint when env is loadable', async () => {
    await reportPreflightFailure({
      noun: 'task',
      verb: 'list',
      flags_seen: ['task-numbers'],
      error_code: 'validation_error',
      error_message: 'unknown flag --task-numbers',
      duration_ms: 4.2,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(
      'http://localhost:9999/internal/conversations/conv-1/agents/agent-1/cli-trace',
    );
    expect(init.method).toBe('POST');
    expect(init.headers.authorization).toBe('Bearer tok-1');
    expect(init.headers['Content-Type']).toBe('application/json');
    const body = JSON.parse(init.body as string);
    expect(body).toMatchObject({
      noun: 'task',
      verb: 'list',
      flags_seen: ['task-numbers'],
      error_code: 'validation_error',
    });
  });

  it('is suppressed when a business request was already attempted', async () => {
    markRequestAttempted();
    expect(wasRequestAttempted()).toBe(true);

    await reportPreflightFailure({
      noun: 'task',
      verb: 'list',
      error_code: 'validation_error',
    });

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('silently no-ops when env is incomplete', async () => {
    delete process.env[ENV_KEYS.token];
    await reportPreflightFailure({
      noun: 'task',
      error_code: 'validation_error',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('swallows fetch failures without throwing', async () => {
    fetchMock.mockRejectedValue(new Error('connection refused'));
    await expect(
      reportPreflightFailure({ error_code: 'validation_error' }),
    ).resolves.toBeUndefined();
  });

  it('swallows abort/timeout without throwing', async () => {
    fetchMock.mockImplementation(
      () =>
        new Promise((_resolve, reject) => {
          // Simulate a slow backend; the AbortController inside the
          // tracer must abort after 50ms and the awaiter must not see
          // the rejection.
          setTimeout(() => reject(new Error('aborted')), 100);
        }),
    );
    await expect(
      reportPreflightFailure({ error_code: 'validation_error' }),
    ).resolves.toBeUndefined();
  });

  it('sanitizes error_message before sending (path + flag value redacted)', async () => {
    await reportPreflightFailure({
      noun: 'file',
      verb: 'upload',
      flags_seen: ['path'],
      error_code: 'validation_error',
      error_message:
        'cannot read --path /Users/alice/secrets/token.txt: ENOENT',
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0]!;
    const body = JSON.parse(init.body as string);
    expect(body.error_message).not.toContain('/Users/alice');
    expect(body.error_message).not.toContain('secrets');
    expect(body.error_message).not.toContain('token.txt');
    expect(body.error_message).toContain('--path');
  });

  it('forwards error_subkind through to the trace body when supplied', async () => {
    await reportPreflightFailure({
      noun: 'message',
      verb: 'send',
      flags_seen: ['content', 'target'],
      error_code: 'validation_error',
      error_subkind: 'flag_removed',
      error_message: '--content was removed; pipe content via stdin',
    });
    const [, init] = fetchMock.mock.calls[0]!;
    const body = JSON.parse(init.body as string);
    expect(body.error_subkind).toBe('flag_removed');
  });

  it('NEVER carries a `details` key — privacy contract bound at the CLI source', async () => {
    // Even if a future caller tried to attach details, the
    // `CliTraceInput` type lacks a slot for them, so this should not
    // compile. The runtime check below double-locks: regardless of
    // schema-strictness on the backend, the CLI never sends the field.
    await reportPreflightFailure({
      noun: 'message',
      verb: 'send',
      error_code: 'validation_error',
      error_subkind: 'unexpected_arguments',
      error_message: 'flags only',
      // Intentionally NOT passing details — `CliTraceInput` doesn't have
      // such a field. This is the contract: positional/rest/raw values
      // must not leave the local process.
    });
    const [, init] = fetchMock.mock.calls[0]!;
    const body = JSON.parse(init.body as string);
    expect(body).not.toHaveProperty('details');
    expect(body).not.toHaveProperty('positional');
    expect(body).not.toHaveProperty('rest');
  });
});

describe('sanitizeTraceErrorMessage', () => {
  it('strips POSIX absolute paths', () => {
    const out = sanitizeTraceErrorMessage(
      'cannot open /Users/alice/private/file.txt: ENOENT',
    );
    expect(out).not.toContain('/Users/alice');
    expect(out).not.toContain('file.txt');
    expect(out).toContain('<path>');
  });

  it('strips Windows absolute paths', () => {
    const out = sanitizeTraceErrorMessage(
      'cannot open C:\\Users\\alice\\file.txt: ENOENT',
    );
    expect(out).not.toContain('C:\\');
    expect(out).not.toContain('alice');
    expect(out).toContain('<path>');
  });

  it('replaces flag values after --flag with <value>', () => {
    const out = sanitizeTraceErrorMessage(
      '--task-number must be a positive integer; got abc123',
    );
    expect(out).toContain('--task-number');
    expect(out).toMatch(/--task-number <value>/);
  });

  it('replaces double- and single-quoted strings with <value>', () => {
    expect(sanitizeTraceErrorMessage('unknown noun "tsk"')).toContain('"<value>"');
    expect(sanitizeTraceErrorMessage("got 'invalid'")).toContain("'<value>'");
  });

  it('preserves the unknown-flag form so typos are still observable', () => {
    const out = sanitizeTraceErrorMessage(
      'unknown flag --task-numbers; did you mean --task-number?',
    );
    expect(out).toContain('--task-numbers');
    expect(out).toContain('--task-number');
  });

  it('caps result length at 500 chars', () => {
    const long = 'x'.repeat(2000);
    const out = sanitizeTraceErrorMessage(long);
    expect(out.length).toBeLessThanOrEqual(500);
  });
});
