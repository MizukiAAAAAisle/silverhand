/**
 * End-to-end verification for `silverhand task create` / `task edit` after
 * the `--body` stdin-only cutover (#task:1779).
 *
 * Scope:
 *   - `--body` is a value-less switch: bytes piped on stdin become the body,
 *   - an EMPTY stdin pipe under `--body` is REFUSED (`empty_stdin`) and writes
 *     NOTHING — a forgotten heredoc must never silently clear a task body,
 *   - clearing a body is the explicit `task edit --clear-body`, which is
 *     mutually exclusive with `--body` (`mutually_exclusive`),
 *   - an INLINE `--body <value>` / `--body=<value>` is rejected as
 *     `body_requires_stdin` — and that rejection is fail-fast (never blocks
 *     on a read),
 *   - omitting `--body` sends no body field (unchanged) and never reads stdin,
 *   - a TTY on stdin under `--body` is rejected as `stdin_is_tty`,
 *   - invalid UTF-8 on stdin is rejected as `invalid_utf8` (no U+FFFD),
 *   - required-flag validation precedes the blocking stdin read.
 *
 * Why a real subprocess: the failure modes here are cross-process (TTY
 * detection, raw byte passthrough through a Node ReadStream, fail-fast vs
 * hang). An in-process mock of `process.stdin` would not exercise the cutover
 * — the same rationale as `message-send-stdin.test.ts`, whose harness this
 * mirrors.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI_SRC = resolve(__dirname, '..', '..', 'src', 'cli.ts');
const TSX_BIN = resolve(__dirname, '..', '..', 'node_modules', '.bin', 'tsx');

interface CapturedRequest {
  method: string;
  path: string;
  bodyBytes: Buffer;
}

let server: Server;
let serverUrl: string;
const captured: CapturedRequest[] = [];
let nextResponse: { status: number; body: unknown } | null = null;

beforeAll(async () => {
  server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      captured.push({
        method: req.method ?? '',
        path: req.url ?? '',
        bodyBytes: Buffer.concat(chunks),
      });
      const reply = nextResponse;
      nextResponse = null;
      res.statusCode = reply?.status ?? 200;
      res.setHeader('content-type', 'application/json');
      // Default success shapes: create wants a tasks[] envelope with no
      // `error`; edit is happy with any non-error body.
      res.end(JSON.stringify(reply?.body ?? { tasks: [{ task_number: 1 }], task: {} }));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('no addr');
  serverUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

/** `task create` files against ONE addressed stream, and the flag is required
 *  (#task:2021 P4-4). These cases are about the --body switch, so they all use the
 *  same plain id-form address; `conv-1` is the ROUTE (the credential's path) and is
 *  not an address at all. */
const CREATE_TARGET = ['--target', '#conv:Conversation0001'] as const;

const ENV = {
  SILVERHAND_CONVERSATION_ID: 'conv-1',
  SILVERHAND_AGENT_ID: 'agent-1',
  SILVERHAND_AUTH_TOKEN: 'tok-1',
};

interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
  /** True when a process that should have failed fast instead blocked on a
   *  read it never should have reached (the stdin-hang failure mode). */
  killedByWatchdog?: boolean;
}

function runTask(opts: {
  verb: 'create' | 'edit';
  argv?: string[];
  stdin?: Buffer | string | null;
  /** Wrap with `script -q /dev/null` to fake a TTY on stdin. macOS only. */
  withTty?: boolean;
  /** Leave stdin OPEN and non-TTY (never delivers EOF) — arms a watchdog so
   *  a fail-fast regression surfaces as a clean assertion, not a suite hang. */
  keepStdinOpen?: boolean;
}): Promise<RunResult> {
  return new Promise((resolvePromise, reject) => {
    const argv = opts.argv ?? [];
    let cmd: string;
    let cmdArgs: string[];
    if (opts.withTty) {
      cmd = '/usr/bin/script';
      cmdArgs = ['-q', '/dev/null', TSX_BIN, CLI_SRC, 'task', opts.verb, ...argv];
    } else {
      cmd = TSX_BIN;
      cmdArgs = [CLI_SRC, 'task', opts.verb, ...argv];
    }
    const child = spawn(cmd, cmdArgs, {
      stdio: opts.withTty ? ['ignore', 'pipe', 'pipe'] : ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        ...ENV,
        SILVERHAND_SERVER_URL: serverUrl,
        SILVERHAND_DAEMON_SOCKET: '',
      },
    });
    let stdout = '';
    let stderr = '';
    let killedByWatchdog = false;
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    child.stdout!.on('data', (chunk) => (stdout += chunk.toString('utf8')));
    child.stderr!.on('data', (chunk) => (stderr += chunk.toString('utf8')));
    child.on('error', reject);
    child.on('close', (code) => {
      if (watchdog) clearTimeout(watchdog);
      resolvePromise({ code, stdout, stderr, killedByWatchdog });
    });
    if (!opts.withTty) {
      // A bounded read (over-cap body) makes the CLI exit mid-stream, so the
      // remaining write races a closed pipe — swallow the expected EPIPE
      // instead of surfacing it as an unhandled error.
      child.stdin!.on('error', () => {});
      if (opts.keepStdinOpen) {
        watchdog = setTimeout(() => {
          killedByWatchdog = true;
          child.kill('SIGKILL');
        }, 8000);
      } else if (opts.stdin !== null && opts.stdin !== undefined) {
        const buf = Buffer.isBuffer(opts.stdin) ? opts.stdin : Buffer.from(opts.stdin, 'utf8');
        child.stdin!.end(buf);
      } else {
        child.stdin!.end();
      }
    }
  });
}

function parseStderrJson(stderr: string): {
  error: { code: string; subkind?: string; message: string; retriable: boolean };
} {
  for (const rawLine of stderr.split(/\r?\n/)) {
    const i = rawLine.indexOf('{');
    if (i < 0) continue;
    try {
      return JSON.parse(rawLine.slice(i));
    } catch {
      /* try the next line */
    }
  }
  throw new Error(`no JSON line in stderr:\n${stderr}`);
}

function lastRequestJson<T>(): T {
  return JSON.parse(captured.at(-1)!.bodyBytes.toString('utf8')) as T;
}

/** Requests to the actual task endpoints — excludes the `cli-trace` ping the
 *  CLI fires on any error BEFORE a business request (which carries no body
 *  content). A rejected --body must produce zero of these. */
function businessRequests(): CapturedRequest[] {
  return captured.filter((r) => !r.path.includes('/cli-trace'));
}

describe('silverhand task --body (stdin-only, real subprocess)', { timeout: 30_000 }, () => {
  it('task edit: piped stdin becomes the body', async () => {
    captured.length = 0;
    const r = await runTask({
      verb: 'edit',
      argv: ['5', '--body'],
      stdin: '## Acceptance\nMulti-line body',
    });
    expect(r.code, r.stderr).toBe(0);
    const req = lastRequestJson<{ task_number: number; body?: string; title?: string }>();
    expect(req.task_number).toBe(5);
    expect(req.body).toBe('## Acceptance\nMulti-line body');
    expect(req.title).toBeUndefined();
  });

  it('task edit: empty stdin under --body is REFUSED (empty_stdin) and clears NOTHING', async () => {
    // The core data-loss falsifier: a bare `--body` whose stdin closes with 0
    // bytes (a forgotten heredoc) must NOT clear the body. It fails closed with
    // `empty_stdin` and sends no request — the description is left untouched.
    captured.length = 0;
    const r = await runTask({
      verb: 'edit',
      argv: ['5', '--body'],
      stdin: '',
    });
    expect(r.code).toBe(1);
    const body = parseStderrJson(r.stderr);
    expect(body.error.subkind).toBe('empty_stdin');
    expect(businessRequests().length, 'empty --body still sent a task edit').toBe(0);
  });

  it('task edit: --clear-body is the explicit clear (sends body: "")', async () => {
    captured.length = 0;
    const r = await runTask({
      verb: 'edit',
      argv: ['5', '--clear-body'],
      // --clear-body never reads stdin; leaving the pipe open must not hang it.
      keepStdinOpen: true,
    });
    expect(r.killedByWatchdog, '--clear-body blocked on stdin').toBe(false);
    expect(r.code, r.stderr).toBe(0);
    const req = lastRequestJson<{ task_number: number; body?: string }>();
    expect(req.task_number).toBe(5);
    expect(req.body).toBe('');
  });

  it('task edit: --body + --clear-body is rejected as mutually_exclusive, fail-fast', async () => {
    // Both a set and a clear intent: refuse before any read.
    captured.length = 0;
    const r = await runTask({
      verb: 'edit',
      argv: ['5', '--body', '--clear-body'],
      keepStdinOpen: true,
    });
    expect(r.killedByWatchdog, 'blocked on stdin before rejecting the flag combo').toBe(false);
    expect(r.code).toBe(1);
    const body = parseStderrJson(r.stderr);
    expect(body.error.subkind).toBe('mutually_exclusive');
    expect(businessRequests().length).toBe(0);
  });

  it('task edit: omitting --body sends no body field and never reads stdin', async () => {
    captured.length = 0;
    // stdin is left OPEN and never closed; because --body is absent the CLI
    // must not read it, so the request still fires and the process exits.
    const r = await runTask({
      verb: 'edit',
      argv: ['5', '--title', 'renamed'],
      keepStdinOpen: true,
    });
    expect(r.killedByWatchdog, 'edit blocked on stdin despite no --body').toBe(false);
    expect(r.code, r.stderr).toBe(0);
    const req = lastRequestJson<{ task_number: number; title?: string; body?: string }>();
    expect(req.title).toBe('renamed');
    expect(req.body).toBeUndefined();
  });

  it('task edit: rejects an inline --body value as body_requires_stdin, fail-fast', async () => {
    // Inline value + a never-closing stdin pipe: the CLI must reject the
    // inline form BEFORE any blocking read.
    const r = await runTask({
      verb: 'edit',
      argv: ['5', '--body', 'inline text'],
      keepStdinOpen: true,
    });
    expect(r.killedByWatchdog, 'edit blocked on stdin before rejecting inline --body').toBe(false);
    expect(r.code).toBe(1);
    const body = parseStderrJson(r.stderr);
    expect(body.error.code).toBe('validation_error');
    expect(body.error.subkind).toBe('body_requires_stdin');
    expect(body.error.message).toContain('SILVERHAND_EOF');
  });

  it('task edit: --body=<value> is also the rejected inline form', async () => {
    const r = await runTask({
      verb: 'edit',
      argv: ['5', '--body=inline'],
      stdin: '',
    });
    expect(r.code).toBe(1);
    expect(parseStderrJson(r.stderr).error.subkind).toBe('body_requires_stdin');
  });

  it('task edit: missing <task_number> fails fast even with an open stdin pipe', async () => {
    const r = await runTask({
      verb: 'edit',
      argv: ['--body'],
      keepStdinOpen: true,
    });
    expect(r.killedByWatchdog, 'edit blocked on stdin before validating <task_number>').toBe(false);
    expect(r.code).toBe(1);
    expect(parseStderrJson(r.stderr).error.subkind).toBe('missing_task_number');
  });

  it('task edit: the removed --task-number flag is rejected as flag_removed, fail-fast', async () => {
    // Reject-and-teach: an agent still reaching for the old flag must get a
    // named replacement, not `unknown_flag` — and never a blocking stdin read.
    captured.length = 0;
    const r = await runTask({
      verb: 'edit',
      argv: ['--task-number', '5', '--body'],
      keepStdinOpen: true,
    });
    expect(r.killedByWatchdog, 'edit blocked on stdin before rejecting --task-number').toBe(false);
    expect(r.code).toBe(1);
    const body = parseStderrJson(r.stderr);
    expect(body.error.subkind).toBe('flag_removed');
    expect(body.error.message).toContain('positional');
    expect(businessRequests().length).toBe(0);
  });

  it('task edit: neither --title nor --body is rejected (empty stdin)', async () => {
    const r = await runTask({
      verb: 'edit',
      argv: ['5'],
      stdin: '',
    });
    expect(r.code).toBe(1);
    expect(parseStderrJson(r.stderr).error.subkind).toBe('missing_required_flag');
  });

  it('task edit: rejects invalid UTF-8 on stdin as invalid_utf8', async () => {
    const r = await runTask({
      verb: 'edit',
      argv: ['5', '--body'],
      stdin: Buffer.from([0xff, 0xfe, 0xfd]),
    });
    expect(r.code).toBe(1);
    const body = parseStderrJson(r.stderr);
    expect(body.error.subkind).toBe('invalid_utf8');
    expect(body.error.message).toContain('valid UTF-8');
    const details = (body.error as { details?: Record<string, unknown> }).details;
    expect(details).toEqual({ encoding: 'utf8' });
  });

  // TASK_CONTENT_MAX_LEN authority = 10000 UTF-16 code units (mirrored from
  // @silverhand/shared). The byte ceiling 3×MAX = 30000 bounds the read.
  const MAX_LEN = 10_000;

  it('task edit: accepts a body exactly at the length cap (10000 ASCII)', async () => {
    captured.length = 0;
    const at = 'a'.repeat(MAX_LEN);
    const r = await runTask({
      verb: 'edit',
      argv: ['5', '--body'],
      stdin: at,
    });
    expect(r.code, r.stderr).toBe(0);
    expect(lastRequestJson<{ body: string }>().body.length).toBe(MAX_LEN);
  });

  it('task edit: accepts a max-length multibyte body (10000 CJK = 30000 bytes, at the byte ceiling)', async () => {
    captured.length = 0;
    // 好 = U+597D = 3 UTF-8 bytes, 1 UTF-16 code unit. 10000 of them is exactly
    // MAX×3 bytes: the byte ceiling must NOT falsely reject a valid max body.
    const cjk = '好'.repeat(MAX_LEN);
    const r = await runTask({
      verb: 'edit',
      argv: ['5', '--body'],
      stdin: cjk,
    });
    expect(r.code, r.stderr).toBe(0);
    expect(lastRequestJson<{ body: string }>().body.length).toBe(MAX_LEN);
  });

  it('task edit: rejects a body one code unit over the cap (10001 ASCII) with the exact count, no request', async () => {
    // 10001 bytes < the 30000-byte ceiling, so this passes the read guard and
    // is rejected by the EXACT length check after decode — proving the schema
    // check, not just the byte bound.
    captured.length = 0;
    const over = 'a'.repeat(MAX_LEN + 1);
    const r = await runTask({
      verb: 'edit',
      argv: ['5', '--body'],
      stdin: over,
    });
    expect(r.code).toBe(1);
    const body = parseStderrJson(r.stderr);
    expect(body.error.subkind).toBe('content_too_long');
    expect(body.error.message).toContain(String(MAX_LEN + 1));
    expect(body.error.message).toContain(String(MAX_LEN));
    // Never reached the wire — an over-limit body must not be sent.
    expect(businessRequests().length, 'over-limit body still sent a task request').toBe(0);
  });

  it('task edit: rejects a pathologically large pipe via the bounded read, no unbounded accumulation, no request', async () => {
    // 400_000 bytes ≫ the 30000-byte ceiling: the read must abort mid-stream
    // (memory guard) rather than buffer it all, and no request is sent.
    captured.length = 0;
    const huge = 'a'.repeat(400_000);
    const r = await runTask({
      verb: 'edit',
      argv: ['5', '--body'],
      stdin: huge,
    });
    expect(r.code).toBe(1);
    const body = parseStderrJson(r.stderr);
    expect(body.error.subkind).toBe('content_too_long');
    const details = (body.error as { details?: Record<string, unknown> }).details;
    expect(details).toEqual({ max_bytes: MAX_LEN * 3 });
    expect(businessRequests().length, 'huge body still sent a task request').toBe(0);
  });

  it('task create: rejects an over-cap body (10001 ASCII) as content_too_long, no request', async () => {
    captured.length = 0;
    const r = await runTask({
      verb: 'create',
      argv: [...CREATE_TARGET, '--title', 'x', '--body'],
      stdin: 'a'.repeat(MAX_LEN + 1),
    });
    expect(r.code).toBe(1);
    expect(parseStderrJson(r.stderr).error.subkind).toBe('content_too_long');
    expect(businessRequests().length).toBe(0);
  });

  it('task create: piped stdin becomes the new task body', async () => {
    captured.length = 0;
    const r = await runTask({
      verb: 'create',
      argv: [...CREATE_TARGET, '--title', 'Fix login', '--body'],
      stdin: '## Context\nrepro steps',
    });
    expect(r.code, r.stderr).toBe(0);
    const req = lastRequestJson<{ tasks: Array<{ title: string; body?: string }> }>();
    expect(req.tasks[0]!.title).toBe('Fix login');
    expect(req.tasks[0]!.body).toBe('## Context\nrepro steps');
  });

  it('task create: omitting --body sends no body field', async () => {
    captured.length = 0;
    const r = await runTask({
      verb: 'create',
      argv: [...CREATE_TARGET, '--title', 'Fix login'],
      stdin: '',
    });
    expect(r.code, r.stderr).toBe(0);
    const req = lastRequestJson<{ tasks: Array<{ title: string; body?: string }> }>();
    expect(req.tasks[0]!.title).toBe('Fix login');
    expect(req.tasks[0]!.body).toBeUndefined();
  });

  it('task create: rejects an inline --body value as body_requires_stdin', async () => {
    const r = await runTask({
      verb: 'create',
      argv: [...CREATE_TARGET, '--title', 'x', '--body', 'inline'],
      stdin: '',
    });
    expect(r.code).toBe(1);
    expect(parseStderrJson(r.stderr).error.subkind).toBe('body_requires_stdin');
  });

  it('task create: empty stdin under --body is refused (empty_stdin), no request', async () => {
    // Consistent with edit: a forgotten heredoc must not silently create an
    // empty body. Omitting --body is the way to an empty description.
    captured.length = 0;
    const r = await runTask({
      verb: 'create',
      argv: [...CREATE_TARGET, '--title', 'x', '--body'],
      stdin: '',
    });
    expect(r.code).toBe(1);
    expect(parseStderrJson(r.stderr).error.subkind).toBe('empty_stdin');
    expect(businessRequests().length).toBe(0);
  });

  // macOS-only: BSD `script -q /dev/null` provides a pty (same rationale as
  // the message-send TTY test).
  const ttySuite = process.platform === 'darwin' ? it : it.skip;
  ttySuite(
    'task edit: rejects TTY stdin under --body as stdin_is_tty (macOS pty wrapper)',
    async () => {
      const r = await runTask({
        verb: 'edit',
        argv: ['5', '--body'],
        withTty: true,
      });
      expect(r.code).toBe(1);
      const body = parseStderrJson(r.stderr || r.stdout);
      expect(body.error.subkind).toBe('stdin_is_tty');
    },
    20_000,
  );
});
