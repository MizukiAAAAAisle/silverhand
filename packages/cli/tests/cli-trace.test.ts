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
let trace: typeof import('../src/cli-trace.js');

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
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    // A fresh module models the CLI's per-process state without a production
    // reset API that no real caller needs.
    vi.resetModules();
    trace = await import('../src/cli-trace.js');
    for (const [key, value] of Object.entries(FULL_ENV)) vi.stubEnv(key, value);
    fetchMock = vi.fn().mockResolvedValue(new Response('{"ok":true}'));
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it('posts a trace to the cli-trace endpoint when env is loadable', async () => {
    await trace.reportPreflightFailure({
      noun: 'task',
      verb: 'list',
      flags_seen: ['task-numbers'],
      error_code: 'validation_error',
      error_message: 'unknown flag --task-numbers',
      duration_ms: 4.2,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('http://localhost:9999/internal/agents/agent-1/cli-trace');
    expect(init.method).toBe('POST');
    expect(init.headers.authorization).toBe('Bearer tok-1');
    expect(init.headers['Content-Type']).toBe('application/json');
    const body = JSON.parse(init.body as string);
    expect(body).toEqual({
      noun: 'task',
      verb: 'list',
      flags_seen: ['task-numbers'],
      error_code: 'validation_error',
      error_message: 'unknown flag --task-numbers',
      duration_ms: 4.2,
    });
  });

  // Subkind is the *structured* failure reason — the daily report
  // groups by it instead of regex'ing the message string. The trace
  // payload must round-trip every subkind the CLI emits today.
  it.each([
    'flag_removed',
    'verb_removed',
    'missing_required_flag',
    'unknown_flag',
    'enum_invalid',
    'mutually_exclusive',
    'unexpected_arguments',
    'stdin_is_tty',
    'empty_stdin',
    'invalid_utf8',
  ] as const)('forwards error_subkind=%s verbatim to the trace payload', async (subkind) => {
    await trace.reportPreflightFailure({
      noun: 'task',
      verb: 'list',
      error_code: 'validation_error',
      error_subkind: subkind,
    });
    const [, init] = fetchMock.mock.calls.at(-1)!;
    const body = JSON.parse(init.body as string);
    expect(body.error_subkind).toBe(subkind);
  });

  it('is suppressed when a business request was already attempted', async () => {
    trace.markRequestAttempted();
    expect(trace.wasRequestAttempted()).toBe(true);

    await trace.reportPreflightFailure({
      noun: 'task',
      verb: 'list',
      error_code: 'validation_error',
    });

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('silently no-ops when env is incomplete', async () => {
    vi.stubEnv(ENV_KEYS.token, undefined);
    await trace.reportPreflightFailure({
      noun: 'task',
      error_code: 'validation_error',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(['success', 'network error'] as const)(
    'settles after %s without leaving a late abort',
    async (outcome) => {
      vi.useFakeTimers();
      if (outcome === 'network error') {
        fetchMock.mockRejectedValue(new Error('connection refused'));
      }

      await expect(
        trace.reportPreflightFailure({ error_code: 'validation_error' }),
      ).resolves.toBeUndefined();

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const signal = fetchMock.mock.calls[0]![1].signal as AbortSignal;
      await vi.advanceTimersByTimeAsync(100);
      expect(signal.aborted).toBe(false);
    },
  );

  it('aborts a pending fetch at 50ms and swallows its rejection', async () => {
    vi.useFakeTimers();
    fetchMock.mockImplementation(
      (_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          // No independent timer: only the production cancellation can finish
          // this request, unlike a mock that rejects itself after 100ms.
          init.signal!.addEventListener('abort', () => reject(init.signal!.reason), { once: true });
        }),
    );
    let settled = false;
    const reporting = trace.reportPreflightFailure({ error_code: 'validation_error' }).then(() => {
      settled = true;
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const signal = fetchMock.mock.calls[0]![1].signal as AbortSignal;
    await vi.advanceTimersByTimeAsync(49);
    expect(signal.aborted).toBe(false);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(signal.aborted).toBe(true);
    await expect(reporting).resolves.toBeUndefined();
    expect(settled).toBe(true);
  });

  it.each([
    [
      'POSIX path',
      'cannot open /Users/alice/private/file.txt: ENOENT',
      'cannot open <path>: ENOENT',
    ],
    [
      'Windows path',
      'cannot open C:\\Users\\alice\\file.txt: ENOENT',
      'cannot open <path>: ENOENT',
    ],
    ['flag value', 'invalid --task-number abc123', 'invalid --task-number <value>'],
    ['double quotes', 'unknown noun "tsk"', 'unknown noun "<value>"'],
    ['single quotes', "got 'invalid'", "got '<value>'"],
    [
      'path flag value',
      'cannot read --path /Users/alice/secrets/token.txt: ENOENT',
      'cannot read --path <value> ENOENT',
    ],
    [
      'unknown flag names',
      'unknown flag --task-numbers; did you mean --task-number?',
      'unknown flag --task-numbers; did you mean --task-number?',
    ],
    ['length limit', 'x'.repeat(2000), 'x'.repeat(500)],
  ])('sanitizes %s in the emitted trace payload', async (_name, input, expected) => {
    await trace.reportPreflightFailure({
      noun: 'task',
      error_code: 'validation_error',
      error_message: input,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0]!;
    expect(JSON.parse(init.body as string).error_message).toBe(expected);
  });
});
