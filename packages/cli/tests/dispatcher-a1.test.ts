/**
 * End-to-end verification for the dispatcher's A1 hard guard:
 *
 *   silverhand <noun> <verb> [...flags] <unexpected positional or rest>
 *     → exit 1, stderr JSON `code=validation_error subkind=unexpected_arguments`
 *
 * Why a real subprocess: the guard lives at the very top of the dispatch
 * function and runs before any business code. Its purpose is precisely to
 * catch shell-quoting accidents (the original product-base bug where bash
 * word-split a `--content "..."` value into `args.positional`). An
 * in-process unit test that hand-builds `ParsedArgs` would miss the
 * shell-layer interaction; here we boot the real CLI with `tsx` and feed
 * argv that mimics the shape the dispatcher would actually see.
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI_SRC = resolve(__dirname, '..', 'src', 'cli.ts');
// `tsx` is hoisted under packages/cli/node_modules/.bin in this pnpm
// workspace. Resolving relative to this test file makes the path
// stable regardless of how vitest's cwd is set.
const TSX_BIN = resolve(__dirname, '..', 'node_modules', '.bin', 'tsx');

interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

function runCli(argv: readonly string[], opts: { stdin?: string } = {}): Promise<RunResult> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(TSX_BIN, [CLI_SRC, ...argv], {
      stdio: ['pipe', 'pipe', 'pipe'],
      // Strip SILVERHAND_* env so the dispatcher must hit the A1 guard
      // BEFORE loadEnv runs. (The guard does run before loadEnv, but
      // belt-and-suspenders: if anyone ever flips that order, this test
      // turns into a clean failure rather than a missing-env distraction.)
      env: {
        ...process.env,
        SILVERHAND_CONVERSATION_ID: undefined as unknown as string,
        SILVERHAND_AGENT_ID: undefined as unknown as string,
        SILVERHAND_SERVER_URL: undefined as unknown as string,
        SILVERHAND_AUTH_TOKEN: undefined as unknown as string,
      },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', reject);
    child.on('close', code => resolvePromise({ code, stdout, stderr }));
    if (opts.stdin !== undefined) child.stdin.end(opts.stdin);
    else child.stdin.end();
  });
}

function parseStderrJson(stderr: string): { error: { code: string; subkind?: string; message: string; retriable: boolean; details?: Record<string, unknown> } } {
  // The dispatcher prints exactly one JSON line on stderr; find it.
  const line = stderr.split(/\r?\n/).find(l => l.trim().startsWith('{'));
  if (!line) throw new Error(`no JSON line in stderr:\n${stderr}`);
  return JSON.parse(line);
}

describe('dispatcher A1 hard guard (real subprocess)', () => {
  it('rejects an unexpected positional with subkind=unexpected_arguments', async () => {
    // `task list` accepts no value-bearing flags except --status etc.
    // A bare positional `extra` should fall into args.positional.
    const r = await runCli(['task', 'list', 'extra']);
    expect(r.code).toBe(1);
    const body = parseStderrJson(r.stderr);
    expect(body.error.code).toBe('validation_error');
    expect(body.error.subkind).toBe('unexpected_arguments');
    expect(body.error.retriable).toBe(false);
    expect(body.error.details).toEqual({ positional: ['extra'], rest: [] });
  });

  it('rejects tokens after `--` (parsed into args.rest) with the same subkind', async () => {
    const r = await runCli(['task', 'list', '--', 'stray']);
    expect(r.code).toBe(1);
    const body = parseStderrJson(r.stderr);
    expect(body.error.code).toBe('validation_error');
    expect(body.error.subkind).toBe('unexpected_arguments');
    expect(body.error.details).toEqual({ positional: [], rest: ['stray'] });
  });

  it('reports BOTH positional and rest when both present', async () => {
    const r = await runCli(['task', 'list', 'foo', '--', 'bar']);
    expect(r.code).toBe(1);
    const body = parseStderrJson(r.stderr);
    expect(body.error.subkind).toBe('unexpected_arguments');
    expect(body.error.details).toEqual({
      positional: ['foo'],
      rest: ['bar'],
    });
    expect(body.error.message).toContain('positional');
    expect(body.error.message).toContain('after-`--`');
  });

  it('the no-positional / no-rest happy path falls through to handler (proven by the next failure being env, not A1)', async () => {
    // `task list` with no extra tokens passes A1 → tries to loadEnv →
    // throws because env vars are stripped. The error code is a
    // validation_error from loadEnv but the subkind must NOT be
    // unexpected_arguments (otherwise A1 fired wrongly).
    const r = await runCli(['task', 'list']);
    expect(r.code).not.toBe(0);
    const body = parseStderrJson(r.stderr);
    expect(body.error.subkind).not.toBe('unexpected_arguments');
  });

  // ── verb_removed migration hint ────────────────────────────────────
  // 5/14 daily report logged one `unknown verb message read` failure.
  // Pointing the typo at the canonical verb (`history`) saves a retry
  // round AND keeps the agent inside the command surface they meant.
  // Asserting via real subprocess so the dispatcher wiring is covered
  // end-to-end (group lookup → removedVerbs resolution → CliError shape).
  it('rejects message read with subkind=verb_removed and points at history', async () => {
    const r = await runCli(['message', 'read']);
    expect(r.code).toBe(1);
    const body = parseStderrJson(r.stderr);
    expect(body.error.code).toBe('validation_error');
    expect(body.error.subkind).toBe('verb_removed');
    // Dispatcher prefixes "silverhand <noun> <verb> is not a verb;"
    // already; the hint must NOT repeat that phrase. We assert the
    // dispatcher prefix appears exactly once and the redirect is
    // present right after.
    const phrase = 'silverhand message read is not a verb';
    const occurrences = body.error.message.split(phrase).length - 1;
    expect(occurrences).toBe(1);
    expect(body.error.message).toContain('silverhand message history');
    expect(body.error.details).toMatchObject({
      noun: 'message',
      verb: 'read',
      replacement: 'history',
    });
  });

  it('a genuinely unknown verb still falls back to plain `unknown verb` (no subkind)', async () => {
    // `message bogus` is not in `removedVerbs`, so the migration hint
    // path must not fire. Locks the precedence: explicit redirect
    // first, generic fallback second.
    const r = await runCli(['message', 'bogus']);
    expect(r.code).toBe(1);
    const body = parseStderrJson(r.stderr);
    expect(body.error.code).toBe('validation_error');
    expect(body.error.subkind).toBeUndefined();
    expect(body.error.message).toContain('unknown verb');
  });

  // ── task create --message → flag_removed ──────────────────────────
  // 5/14 daily report logged one `unknown flag --message` for
  // `task create`. Routing it through the `flag_removed` mechanism
  // gives the agent an actionable migration line instead of a typo
  // suggestion that's too far for Levenshtein to bridge.
  it('rejects task create --message with subkind=flag_removed and replacement=title+body', async () => {
    const r = await runCli(['task', 'create', '--message', 'do the thing']);
    expect(r.code).toBe(1);
    const body = parseStderrJson(r.stderr);
    expect(body.error.code).toBe('validation_error');
    expect(body.error.subkind).toBe('flag_removed');
    expect(body.error.message).toContain('--message was removed');
    expect(body.error.message).toContain('--title');
    expect(body.error.message).toContain('--body');
    expect(body.error.details).toEqual({
      flag: 'message',
      replacement: 'title+body',
    });
  });
}, { timeout: 20_000 });
