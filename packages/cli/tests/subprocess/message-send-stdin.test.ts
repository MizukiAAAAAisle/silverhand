/**
 * End-to-end verification for `silverhand message send` after the
 * stdin-only cutover (PR-A2′).
 *
 * Scope:
 *   - the legacy `--content` flag is rejected as `flag_removed`,
 *   - a TTY on stdin is rejected as `stdin_is_tty`,
 *   - an empty stdin pipe is rejected as `empty_stdin` unless an
 *     attachment is present,
 *   - bytes piped on stdin reach the backend byte-equal — no UTF-8
 *     normalization, no BOM strip, no CRLF→LF, no trim,
 *   - `--target` is REQUIRED and carries an absolute address, verbatim,
 *     with the retired `channel` / `thread:<message_id>` spellings and
 *     `--reply-to` all refused before stdin is touched,
 *   - repeated `--attachment-id` still flows through.
 *
 * Why a real subprocess: the failure modes here are quintessentially
 * cross-process (TTY detection, raw byte passthrough through a
 * Node ReadStream). An in-process mock of `process.stdin` would not
 * exercise the actual cutover.
 *
 * Why a tiny HTTP server: the CLI POSTs to the backend's internal
 * `agentSendConversationMessage` route. Spinning up a 30-line
 * capture server is cheaper than booting the full Hono stack and
 * lets us assert the EXACT bytes that crossed the wire.
 *
 * TTY testing strategy: Silverhand v1 targets macOS only (see CLAUDE.md
 * §"Conventions"). We use macOS BSD `script -q /dev/null <cmd>` to
 * give the CLI a real pty without pulling in `node-pty` as a native
 * devDep. The TTY test is skipped on non-Darwin runners with a clear
 * skip reason.
 */
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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
let nextSendResponse:
  | {
      status: number;
      body: unknown;
    }
  | null = null;

beforeAll(async () => {
  server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      captured.push({
        method: req.method ?? '',
        path: req.url ?? '',
        bodyBytes: Buffer.concat(chunks),
      });
      const reply = nextSendResponse;
      nextSendResponse = null;
      res.statusCode = reply?.status ?? 200;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(reply?.body ?? { message_id: 'msg-1', message_seq: 9 }));
    });
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()));
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('no addr');
  serverUrl = `http://127.0.0.1:${addr.port}`;
});

describe('runtime scope vs command-local conversation selector', { timeout: 30_000 }, () => {
  it('keeps ConversationSlot custody while task and search requests select B', async () => {
    captured.length = 0;
    nextSendResponse = { status: 200, body: { tasks: [] } };
    const list = await runMessage({
      noun: 'task',
      verb: 'list',
      argv: ['--conversation-id', 'conv-B'],
    });
    expect(list.code, list.stderr).toBe(0);
    expect(captured[0]!.path).toBe(
      '/internal/agents/agent-1/tasks?conversation_id=conv-B',
    );

    captured.length = 0;
    nextSendResponse = {
      status: 200,
      body: { tasks: [{ id: 'task-id', task_number: 12, title: 'file in B' }] },
    };
    const create = await runMessage({
      noun: 'task',
      verb: 'create',
      argv: ['--title', 'file in B', '--target', '#conv:Conversation0002'],
    });
    expect(create.code, create.stderr).toBe(0);
    expect(captured[0]!.path).toBe(
      '/internal/agents/agent-1/tasks/create',
    );
    expect(JSON.parse(captured[0]!.bodyBytes.toString('utf8'))).toMatchObject({
      target: '#conv:Conversation0002',
    });

    captured.length = 0;
    nextSendResponse = {
      status: 200,
      body: {
        query: 'needle',
        scope: 'conversation',
        workspace_id: null,
        conversation_id: 'conv-B',
        include_system: true,
        limit: 50,
        hits: [],
      },
    };
    const search = await runMessage({
      noun: 'message',
      verb: 'search',
      argv: ['needle', '--conversation-id', 'conv-B'],
    });
    expect(search.code, search.stderr).toBe(0);
    expect(captured[0]!.path).toBe(
      '/internal/agents/agent-1/search-messages',
    );
    expect(JSON.parse(captured[0]!.bodyBytes.toString('utf8'))).toMatchObject({
      conversation_id: 'conv-B',
    });
  });

  it('uses the agent-global route for AgentSlot; list stays unfiltered until a command selector is supplied', async () => {
    captured.length = 0;
    nextSendResponse = { status: 200, body: { tasks: [] } };
    const allBoards = await runMessage({
      noun: 'task',
      verb: 'list',
      env: { SILVERHAND_CONVERSATION_ID: '' },
    });
    expect(allBoards.code, allBoards.stderr).toBe(0);
    expect(captured[0]!.path).toBe(
      '/internal/agents/agent-1/tasks',
    );

    captured.length = 0;
    nextSendResponse = { status: 200, body: { tasks: [] } };
    const narrowed = await runMessage({
      noun: 'task',
      verb: 'list',
      argv: ['--conversation-id', 'conv-B'],
      env: { SILVERHAND_CONVERSATION_ID: '' },
    });
    expect(narrowed.code, narrowed.stderr).toBe(0);
    expect(captured[0]!.path).toBe(
      '/internal/agents/agent-1/tasks?conversation_id=conv-B',
    );
  });
});

afterAll(async () => {
  await new Promise<void>(r => server.close(() => r()));
});

const ENV = {
  SILVERHAND_CONVERSATION_ID: 'conv-1',
  SILVERHAND_AGENT_ID: 'agent-1',
  SILVERHAND_AUTH_TOKEN: 'tok-1',
};

interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
  /** True when the watchdog had to SIGKILL a process that never exited
   *  on its own — i.e. the CLI blocked on a read it should never have
   *  reached (the stdin-hang failure mode). */
  killedByWatchdog?: boolean;
}

/**
 * The stream every test that is not ABOUT the address sends to.
 *
 * A real 16-char id, and deliberately not the ConversationSlot ambient
 * conversation (`SILVERHAND_CONVERSATION_ID`): since #task:2021 P4-4 the
 * address decides the destination. Short ids like `conv-1` are not
 * addresses at all and never become one — the grammar is the product's, not the
 * fixtures'.
 */
const MAIN_TARGET = '#conv:Conversation0001';
const THREAD_TARGET = `${MAIN_TARGET}/thread:ClusterRoot00001`;

/** The requests that were actual sends. A refused pre-flight still fires a
 *  best-effort `cli-trace` POST at the same capture server, so "nothing was
 *  sent" is a claim about this route, not about the socket. */
function sendRequests(): CapturedRequest[] {
  return captured.filter(r => r.path.endsWith('/send-message'));
}

function runSend(opts: {
  argv?: string[];
  stdin?: Buffer | string | null;
  env?: Record<string, string>;
  /** Wrap with `script -q /dev/null` to fake a TTY on stdin. macOS only. */
  withTty?: boolean;
  /** Leave stdin OPEN and non-TTY (never delivers EOF) — mimics an
   *  inherited pipe. Arms a watchdog so a hang fails cleanly. */
  keepStdinOpen?: boolean;
  /** Send with NO `--target`, for the tests that are about the flag itself.
   *  Everything else gets {@link MAIN_TARGET} prepended, because `--target` is
   *  required and a test about stdin bytes should not have to restate that. */
  omitTarget?: boolean;
}): Promise<RunResult> {
  const { omitTarget, argv, ...rest } = opts;
  const hasTarget = (argv ?? []).includes('--target');
  return runMessage({
    noun: 'message',
    verb: 'send',
    ...rest,
    argv:
      omitTarget || hasTarget
        ? (argv ?? [])
        : ['--target', MAIN_TARGET, ...(argv ?? [])],
  });
}

function runMessage(opts: {
  noun: string;
  verb: string;
  argv?: string[];
  stdin?: Buffer | string | null;
  env?: Record<string, string>;
  /** Wrap with `script -q /dev/null` to fake a TTY on stdin. macOS only. */
  withTty?: boolean;
  /** Leave stdin OPEN and non-TTY (never delivers EOF) — mimics an
   *  inherited pipe. Arms a watchdog so a hang fails cleanly. */
  keepStdinOpen?: boolean;
}): Promise<RunResult> {
  return new Promise((resolvePromise, reject) => {
    const argv = opts.argv ?? [];
    let cmd: string;
    let cmdArgs: string[];
    if (opts.withTty) {
      // BSD `script` puts the wrapped command's stdin/stdout under a
      // pty. We use `/dev/null` as the typescript output target.
      cmd = '/usr/bin/script';
      cmdArgs = ['-q', '/dev/null', TSX_BIN, CLI_SRC, opts.noun, opts.verb, ...argv];
    } else {
      cmd = TSX_BIN;
      cmdArgs = [CLI_SRC, opts.noun, opts.verb, ...argv];
    }
    const child = spawn(cmd, cmdArgs, {
      // For the `script` (TTY) wrapper we MUST NOT inherit vitest's
      // stdin — vitest workers run with a socket on fd 0, and BSD
      // `script` tries to ioctl(TCGETA) on its own stdin to relay
      // keystrokes to the wrapped child's pty. With a socket that
      // ioctl returns ENOTTY ("Operation not supported on socket")
      // and `script` aborts before the wrapped CLI ever runs.
      // `ignore` keeps `script` from touching its stdin while the
      // child it spawns still receives a real pty on fd 0 (which is
      // the whole point of the test).
      stdio: opts.withTty ? ['ignore', 'pipe', 'pipe'] : ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        ...ENV,
        SILVERHAND_SERVER_URL: serverUrl,
        SILVERHAND_DAEMON_SOCKET: '',
        ...(opts.env ?? {}),
      },
    });
    let stdout = '';
    let stderr = '';
    let killedByWatchdog = false;
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    child.stdout!.on('data', chunk => (stdout += chunk.toString('utf8')));
    child.stderr!.on('data', chunk => (stderr += chunk.toString('utf8')));
    child.on('error', reject);
    child.on('close', code => {
      if (watchdog) clearTimeout(watchdog);
      resolvePromise({ code, stdout, stderr, killedByWatchdog });
    });
    if (!opts.withTty) {
      if (opts.keepStdinOpen) {
        // Intentionally leave stdin OPEN and non-TTY: the child inherits
        // a pipe that never delivers EOF. A fail-fast CLI must reject a
        // bad flag BEFORE blocking on this read. Arm a watchdog so a
        // regression (infinite stdin block) surfaces as a clean assertion
        // instead of leaking to the suite timeout.
        watchdog = setTimeout(() => {
          killedByWatchdog = true;
          child.kill('SIGKILL');
        }, 8000);
      } else if (opts.stdin !== null && opts.stdin !== undefined) {
        const buf = Buffer.isBuffer(opts.stdin)
          ? opts.stdin
          : Buffer.from(opts.stdin, 'utf8');
        child.stdin!.end(buf);
      } else {
        child.stdin!.end();
      }
    }
  });
}

function parseStderrJson(stderr: string): {
  error: {
    code: string;
    subkind?: string;
    message: string;
    retriable: boolean;
    details?: Record<string, unknown>;
  };
} {
  // The CLI prints exactly one JSON line on stderr. When the wrapper
  // is BSD `script`, the same byte stream is interleaved with control
  // characters like `^D` (EOT) and may be prepended to the JSON line
  // without an intervening newline. We find the first `{` anywhere
  // and JSON.parse from there to the line end — robust against pty
  // banner / EOT-marker noise.
  for (const rawLine of stderr.split(/\r?\n/)) {
    const i = rawLine.indexOf('{');
    if (i < 0) continue;
    const candidate = rawLine.slice(i);
    try {
      return JSON.parse(candidate);
    } catch {
      /* try the next line */
    }
  }
  throw new Error(`no JSON line in stderr:\n${stderr}`);
}

describe('silverhand message send (stdin-only, real subprocess)', { timeout: 30_000 }, () => {
  it('rejects the legacy --content flag with subkind=flag_removed', async () => {
    const r = await runSend({ argv: ['--content', 'hello'], stdin: 'irrelevant' });
    expect(r.code).toBe(1);
    const body = parseStderrJson(r.stderr);
    expect(body.error.code).toBe('validation_error');
    expect(body.error.subkind).toBe('flag_removed');
    expect(body.error.message).toContain('--content was removed');
    expect(body.error.message).toContain("SILVERHAND_EOF");
  });

  // The agent never had `--text` or `--message` available — but the CLI
  // intercepts them with the same `flag_removed` machinery so the
  // failure is a stdin-template guidance line instead of a generic
  // typo-suggestion fallback. This is the difference between an agent
  // self-correcting on the next call and an agent re-trying with
  // `--message` after `--text` failed.
  it.each(['text', 'message'] as const)(
    'rejects --%s with flag_removed pointing at stdin/heredoc',
    async flag => {
      const r = await runSend({
        argv: [`--${flag}`, 'hello'],
        stdin: 'irrelevant',
      });
      expect(r.code).toBe(1);
      const body = parseStderrJson(r.stderr);
      expect(body.error.code).toBe('validation_error');
      expect(body.error.subkind).toBe('flag_removed');
      // Message must show the heredoc pattern so the agent can
      // copy-paste the next attempt without hunting through --help.
      expect(body.error.message).toContain('SILVERHAND_EOF');
      expect(body.error.message).toContain('stdin');
    },
  );

  it('rejects empty stdin with subkind=empty_stdin', async () => {
    const r = await runSend({ stdin: '' });
    expect(r.code).toBe(1);
    const body = parseStderrJson(r.stderr);
    expect(body.error.code).toBe('validation_error');
    expect(body.error.subkind).toBe('empty_stdin');
  });

  it('allows empty stdin when at least one attachment is present', async () => {
    captured.length = 0;
    const r = await runSend({
      argv: ['--attachment-id', 'att-1'],
      stdin: '',
    });
    expect(r.code, r.stderr).toBe(0);
    expect(captured.length).toBe(1);
    const reqBody = JSON.parse(captured[0]!.bodyBytes.toString('utf8')) as {
      content: string;
      attachment_ids?: string[];
    };
    expect(reqBody.content).toBe('');
    expect(reqBody.attachment_ids).toEqual(['att-1']);
  });

  it('rejects invalid UTF-8 bytes with subkind=invalid_utf8 (no silent U+FFFD substitution)', async () => {
    // 0xff / 0xfe / 0xfd are not valid stand-alone bytes in any UTF-8
    // sequence. `Buffer.toString('utf8')` would silently replace them
    // with U+FFFD, breaking the "stdin bytes == DB bytes" contract.
    // The CLI must reject explicitly so the agent re-encodes upstream.
    const r = await runSend({ stdin: Buffer.from([0xff, 0xfe, 0xfd]) });
    expect(r.code).toBe(1);
    const body = parseStderrJson(r.stderr);
    expect(body.error.code).toBe('validation_error');
    expect(body.error.subkind).toBe('invalid_utf8');
    expect(body.error.message).toContain('valid UTF-8');
    // details must NOT carry raw bytes (Cindy review): a bytes-free
    // `{encoding: 'utf8'}` is the entire payload.
    const details = (body.error as { details?: Record<string, unknown> }).details;
    expect(details).toEqual({ encoding: 'utf8' });
  });

  // macOS-only: BSD `script -q /dev/null` provides a pty. Linux's
  // util-linux `script` has different semantics; v1 is mac-only.
  const ttySuite = process.platform === 'darwin' ? it : it.skip;
  ttySuite(
    'rejects TTY stdin with subkind=stdin_is_tty (macOS pty wrapper)',
    async () => {
      const r = await runSend({ withTty: true });
      expect(r.code).toBe(1);
      // BSD `script` merges the wrapped child's stdout AND stderr into
      // its own stdout (the typescript transcript) — the JSON error
      // line therefore arrives on `r.stdout`, not `r.stderr`. Search
      // both, so this test is robust to the precise pty plumbing
      // `script` chooses on different macOS releases.
      const body = parseStderrJson(r.stderr || r.stdout);
      expect(body.error.code).toBe('validation_error');
      expect(body.error.subkind).toBe('stdin_is_tty');
    },
    20_000,
  );

  describe('raw byte passthrough — zero normalization', () => {
    const corpus: ReadonlyArray<{ name: string; bytes: Buffer }> = [
      { name: 'plain ASCII', bytes: Buffer.from('hello world', 'utf8') },
      {
        name: 'unmatched ASCII double quote',
        bytes: Buffer.from('he said "hi and never closed', 'utf8'),
      },
      { name: 'CJK with curly quotes', bytes: Buffer.from('他说"你好"', 'utf8') },
      { name: 'backtick + $VAR + backslash', bytes: Buffer.from('echo `ls` $HOME \\n', 'utf8') },
      { name: 'CRLF newline preserved', bytes: Buffer.from('line1\r\nline2', 'utf8') },
      { name: 'LF only newline preserved', bytes: Buffer.from('line1\nline2', 'utf8') },
      { name: 'UTF-8 BOM preserved', bytes: Buffer.from([0xef, 0xbb, 0xbf, 0x68, 0x69]) },
      {
        name: 'leading + trailing whitespace preserved',
        bytes: Buffer.from('  spaced  \n', 'utf8'),
      },
    ];

    for (const c of corpus) {
      it(`preserves bytes verbatim: ${c.name}`, async () => {
        captured.length = 0;
        const r = await runSend({ stdin: c.bytes });
        expect(r.code, r.stderr).toBe(0);
        expect(captured.length).toBe(1);
        const reqBody = JSON.parse(captured[0]!.bodyBytes.toString('utf8')) as {
          content: string;
        };
        // Round-trip through JSON as the on-wire shape, then back to
        // bytes — must equal the input bytes exactly.
        expect(Buffer.from(reqBody.content, 'utf8').equals(c.bytes)).toBe(true);
      });
    }

    it('handles a near-cap body without truncation or chunk-boundary corruption', async () => {
      captured.length = 0;
      // Repeating UTF-8 multibyte chars to maximize the chance that a
      // codepoint straddles a chunk boundary inside Node's stdin.
      // Stays just under the 64KiB content cap so it does NOT trigger
      // the auto-attachment conversion.
      const chunk = '中文测试 — emoji 🚀 — '.repeat(1_900);
      const bytes = Buffer.from(chunk, 'utf8');
      expect(bytes.byteLength).toBeGreaterThan(56 * 1024);
      expect(bytes.byteLength).toBeLessThanOrEqual(64 * 1024);
      const r = await runSend({ stdin: bytes });
      expect(r.code, r.stderr).toBe(0);
      const reqBody = JSON.parse(captured[0]!.bodyBytes.toString('utf8')) as {
        content: string;
      };
      expect(Buffer.from(reqBody.content, 'utf8').equals(bytes)).toBe(true);
    }, 30_000);

    it('auto-converts a body over 64KiB into a text attachment', async () => {
      captured.length = 0;
      const chunk = '中文测试 — emoji 🚀 — '.repeat(20_000);
      const bytes = Buffer.from(chunk, 'utf8');
      expect(bytes.byteLength).toBeGreaterThan(64 * 1024);
      // First request is the multipart upload; queue an AttachmentDto
      // for it. The follow-up send gets the default message reply.
      nextSendResponse = {
        status: 200,
        body: {
          id: 'att-big',
          filename: 'message-body-x.txt',
          size: bytes.byteLength,
          content_type: 'text/plain; charset=utf-8',
        },
      };
      const r = await runSend({ stdin: bytes });
      expect(r.code, r.stderr).toBe(0);
      expect(captured.length).toBe(2);
      const upload = captured[0]!;
      expect(upload.path).toBe('/internal/agents/agent-1/attachments');
      // Multipart body carries the original bytes verbatim.
      expect(upload.bodyBytes.includes(bytes)).toBe(true);
      // ...and the DESTINATION, as a form field beside them: the spooled body is
      // an attachment, and an attachment is owned by ONE conversation, so the
      // upload is addressed rather than left to the credential's conversation
      // (#task:2021 P4-4).
      expect(upload.bodyBytes.toString('utf8')).toContain(
        `name="target"\r\n\r\n${MAIN_TARGET}`,
      );
      const send = captured[1]!;
      const reqBody = JSON.parse(send.bodyBytes.toString('utf8')) as {
        content: string;
        attachment_ids?: string[];
      };
      expect(reqBody.attachment_ids).toEqual(['att-big']);
      expect(Buffer.byteLength(reqBody.content, 'utf8')).toBeLessThanOrEqual(64 * 1024);
      expect(reqBody.content).toContain('message-body-x.txt');
    }, 30_000);

    it('spools into the CONVERSATION when the message is going to a thread', async () => {
      // The message lands in the reply cluster; the attachment is owned by the
      // conversation the cluster is in — threads inherit their parent's files, and
      // the upload door refuses a `/thread:` suffix rather than dropping one. So
      // the two requests carry DIFFERENT addresses on purpose, both derived from
      // the one the actor spelled (#task:2021 P4-4).
      captured.length = 0;
      const bytes = Buffer.from('x'.repeat(70 * 1024), 'utf8');
      nextSendResponse = {
        status: 200,
        body: {
          id: 'att-thread',
          filename: 'message-body-t.txt',
          size: bytes.byteLength,
          content_type: 'text/plain; charset=utf-8',
        },
      };
      const r = await runSend({ argv: ['--target', THREAD_TARGET], stdin: bytes });
      expect(r.code, r.stderr).toBe(0);
      expect(captured.length).toBe(2);
      const form = captured[0]!.bodyBytes.toString('utf8');
      expect(form).toContain(`name="target"\r\n\r\n${MAIN_TARGET}\r\n`);
      expect(form).not.toContain(THREAD_TARGET);
      // The send itself is untouched: the head is derived for the upload only.
      expect(
        (JSON.parse(captured[1]!.bodyBytes.toString('utf8')) as { target?: unknown }).target,
      ).toBe(THREAD_TARGET);
    }, 30_000);
  });

  it('forwards --target verbatim and repeated --attachment-id in the request body', async () => {
    captured.length = 0;
    const r = await runSend({
      argv: [
        '--target',
        THREAD_TARGET,
        '--attachment-id',
        'att-1',
        '--attachment-id',
        'att-2',
      ],
      stdin: 'hi',
    });
    expect(r.code, r.stderr).toBe(0);
    const reqBody = JSON.parse(captured[0]!.bodyBytes.toString('utf8')) as {
      content: string;
      target?: unknown;
      attachment_ids?: string[];
    };
    expect(reqBody.content).toBe('hi');
    // The exact token the actor spelled: a STRING, not a parsed shape. The CLI
    // re-spells nothing, so the resolver sees what was typed (#task:2021 P4-4).
    expect(reqBody.target).toBe(THREAD_TARGET);
    expect(reqBody.attachment_ids).toEqual(['att-1', 'att-2']);
  });

  it('uses the agent-global route while the address alone decides the destination', async () => {
    captured.length = 0;
    const r = await runSend({
      stdin: 'cross-target message',
      env: { SILVERHAND_CONVERSATION_ID: '' },
    });
    expect(r.code, r.stderr).toBe(0);
    expect(captured).toHaveLength(1);
    expect(captured[0]!.path).toBe(
      '/internal/agents/agent-1/send-message',
    );
    const reqBody = JSON.parse(captured[0]!.bodyBytes.toString('utf8')) as {
      content: string;
      target?: unknown;
    };
    expect(reqBody.content).toBe('cross-target message');
    expect(reqBody.target).toBe(MAIN_TARGET);
  });

  it('refuses a send with no --target as target_required, and names the caller own stream as the correction', async () => {
    captured.length = 0;
    const r = await runSend({ omitTarget: true, stdin: 'where does this go?' });
    expect(r.code).toBe(1);
    const body = parseStderrJson(r.stderr);
    expect(body.error.code).toBe('validation_error');
    expect(body.error.subkind).toBe('target_required');
    expect(body.error.details).toMatchObject({ correct_target: '#conv:conv-1' });
    // Nothing was SENT: there was no stream to send to. (A pre-flight failure
    // still posts one best-effort `cli-trace` record, which is why this asserts
    // on the send route rather than on total silence.)
    expect(sendRequests()).toHaveLength(0);
  });

  it('still requires --target in an AgentSlot, but offers no correction there', async () => {
    captured.length = 0;
    const r = await runSend({
      omitTarget: true,
      env: { SILVERHAND_CONVERSATION_ID: '' },
      stdin: 'where does this go?',
    });
    expect(r.code).toBe(1);
    const body = parseStderrJson(r.stderr);
    expect(body.error.subkind).toBe('target_required');
    // An AgentSlot has no singleton stream, so it gets the flag and no
    // suggestion (#task:2021 P4-4: one correction, and only the singleton has it).
    expect(body.error.details?.correct_target).toBeUndefined();
    expect(body.error.details).toMatchObject({ flag: 'target' });
    expect(sendRequests()).toHaveLength(0);
  });

  it('refuses the retired `channel` and `thread:<id>` spellings as target_malformed', async () => {
    for (const retired of ['channel', 'thread:m-root', 'self']) {
      captured.length = 0;
      const r = await runSend({
        argv: ['--target', retired],
        stdin: 'main-line answer',
      });
      expect(r.code, `--target ${retired} should not be accepted`).toBe(1);
      const body = parseStderrJson(r.stderr);
      expect(body.error.code).toBe('validation_error');
      expect(body.error.subkind).toBe('target_malformed');
      expect(sendRequests()).toHaveLength(0);
    }
  });

  it('accepts the readable and direct-pair address forms without touching them', async () => {
    for (const address of [
      '#silverhand/UI%2FUX%20优化',
      'dm:@shiki',
      `dm:@shiki/thread:ClusterRoot00001`,
    ]) {
      captured.length = 0;
      const r = await runSend({ argv: ['--target', address], stdin: 'hi' });
      expect(r.code, r.stderr).toBe(0);
      const reqBody = JSON.parse(captured[0]!.bodyBytes.toString('utf8')) as {
        target?: unknown;
      };
      expect(reqBody.target).toBe(address);
    }
  });

  it('sends into a reply cluster addressed by its ROOT and echoes thread_root_id', async () => {
    captured.length = 0;
    nextSendResponse = {
      status: 200,
      body: {
        message_id: 'm-reply',
        message_seq: 12,
        thread_root_id: 'ClusterRoot00001',
      },
    };
    const r = await runSend({
      argv: ['--target', THREAD_TARGET],
      stdin: 'threaded answer',
    });
    expect(r.code, r.stderr).toBe(0);
    const reqBody = JSON.parse(captured[0]!.bodyBytes.toString('utf8')) as {
      content: string;
      reply_to_message_id?: string;
      target?: unknown;
    };
    expect(reqBody.content).toBe('threaded answer');
    expect(reqBody.target).toBe(THREAD_TARGET);
    // The retired coordinate is gone from the body entirely, not merely unset
    // by this call: a reply is addressed by the stream it lands in.
    expect(reqBody.reply_to_message_id).toBeUndefined();
    const out = JSON.parse(r.stdout) as { thread_root_id?: string | null };
    expect(out.thread_root_id).toBe('ClusterRoot00001');
  });

  it('prints the sender-only unresolved references on stdout, and only when the backend reported some (#task:2021 P4-5-b)', async () => {
    captured.length = 0;
    nextSendResponse = {
      status: 200,
      body: {
        message_id: 'm-missed',
        message_seq: 13,
        thread_root_id: null,
        unresolved_references: [{ kind: 'agent', handle: 'nosuchagent' }],
      },
    };
    const missed = await runSend({
      argv: [],
      stdin: '<silverhand://agent/nosuchagent> please look',
    });
    // Exit 0: the message was sent. An unresolved reference is FEEDBACK, and an
    // agent that treated it as a failed send would resend a message everyone
    // already received.
    expect(missed.code, missed.stderr).toBe(0);
    const missedOut = JSON.parse(missed.stdout) as {
      message_id: string;
      unresolved_references?: unknown;
    };
    expect(missedOut.message_id).toBe('m-missed');
    // Verbatim, and with no reason: the author reads back its own token.
    expect(missedOut.unresolved_references).toEqual([
      { kind: 'agent', handle: 'nosuchagent' },
    ]);

    nextSendResponse = {
      status: 200,
      body: { message_id: 'm-fine', message_seq: 14, thread_root_id: null },
    };
    const landed = await runSend({ argv: [], stdin: 'nothing addressed' });
    expect(landed.code, landed.stderr).toBe(0);
    // ABSENT on an ordinary send — the CLI adds no empty array of its own.
    expect(Object.keys(JSON.parse(landed.stdout) as object)).not.toContain(
      'unresolved_references',
    );
  });

  it('reports --reply-to as flag_removed and points at the cluster ROOT address', async () => {
    captured.length = 0;
    const r = await runSend({
      argv: ['--reply-to', 'ClusterRoot00001'],
      stdin: 'threaded answer',
    });
    expect(r.code).toBe(1);
    const body = parseStderrJson(r.stderr);
    expect(body.error.subkind).toBe('flag_removed');
    // The migration line has to name the replacement, not just the removal:
    // the whole change is that a reply is addressed by its stream.
    expect(body.error.message).toContain('/thread:');
    expect(sendRequests()).toHaveLength(0);
  });

  it('reports --reply-to as removed even when --target is also present', async () => {
    // No mutual-exclusion arm any more: there is one destination coordinate, so
    // the retired flag is removed unconditionally rather than negotiated
    // against the surviving one.
    const r = await runSend({
      argv: ['--reply-to', 'ClusterRoot00001', '--target', THREAD_TARGET],
      stdin: 'oops',
    });
    expect(r.code).toBe(1);
    const body = parseStderrJson(r.stderr);
    expect(body.error.code).toBe('validation_error');
    expect(body.error.subkind).toBe('flag_removed');
  });

  it('does not derive freshness from the legacy delivered-seq sidecar in direct fallback', async () => {
    captured.length = 0;
    const dir = await mkdtemp(join(tmpdir(), 'silverhand-cli-seq-'));
    const seqFile = join(dir, 'last-delivered-seq');
    try {
      await writeFile(seqFile, '5\n', 'utf8');
      const r = await runSend({
        stdin: 'hi',
        env: { SILVERHAND_LAST_DELIVERED_SEQ_FILE: seqFile },
      });
      expect(r.code, r.stderr).toBe(0);
      const reqBody = JSON.parse(captured[0]!.bodyBytes.toString('utf8')) as {
        content: string;
        seen_up_to_seq?: number;
      };
      expect(reqBody.seen_up_to_seq).toBeUndefined();
      expect((await readFile(seqFile, 'utf8')).trim()).toBe('5');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('forwards --anyway as an explicit freshness bypass in direct fallback', async () => {
    captured.length = 0;
    const dir = await mkdtemp(join(tmpdir(), 'silverhand-cli-anyway-'));
    const seqFile = join(dir, 'last-delivered-seq');
    try {
      await writeFile(seqFile, '5\n', 'utf8');
      const r = await runSend({
        argv: ['--anyway'],
        stdin: 'force it',
        env: { SILVERHAND_LAST_DELIVERED_SEQ_FILE: seqFile },
      });
      expect(r.code, r.stderr).toBe(0);
      const reqBody = JSON.parse(captured[0]!.bodyBytes.toString('utf8')) as {
        content: string;
        seen_up_to_seq?: number;
        freshness_bypass?: boolean;
      };
      expect(reqBody.content).toBe('force it');
      expect(reqBody.seen_up_to_seq).toBeUndefined();
      expect(reqBody.freshness_bypass).toBe(true);
      expect((await readFile(seqFile, 'utf8')).trim()).toBe('5');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('does not mutate the legacy sidecar on direct-fallback message_stale', async () => {
    captured.length = 0;
    const dir = await mkdtemp(join(tmpdir(), 'silverhand-cli-stale-'));
    const seqFile = join(dir, 'last-delivered-seq');
    try {
      await writeFile(seqFile, '5\n', 'utf8');
      nextSendResponse = {
        status: 409,
        body: {
          error: {
            code: 'conflict',
            message: 'message stale',
            details: {
              subkind: 'message_stale',
              conversation_id: 'conv-1',
              stale_event_id: 'evt-1',
              seen_up_to_seq: 5,
              current_seq: 8,
              newer_messages: [{ id: 'msg-8', seq: 8 }],
            },
          },
        },
      };
      const stale = await runSend({
        stdin: 'draft',
        env: { SILVERHAND_LAST_DELIVERED_SEQ_FILE: seqFile },
      });
      expect(stale.code).toBe(1);
      const err = parseStderrJson(stale.stderr);
      expect(err.error.code).toBe('conflict');
      expect((await readFile(seqFile, 'utf8')).trim()).toBe('5');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('reports no_pending_stale_event in the direct (no-daemon) fallback', async () => {
    // The pending stale event is daemon-held state. Without a daemon there is
    // nothing to resolve: even an exact object id degrades honestly instead of
    // POSTing a resolution that bypasses daemon custody.
    captured.length = 0;
    nextSendResponse = { status: 200, body: { ok: true } };
    const resolved = await runMessage({
      noun: 'message',
      verb: 'stale-resolve',
      argv: ['--stale-event-id', 'evt-obsolete', '--resolution', 'obsolete'],
    });
    expect(resolved.code, resolved.stderr).toBe(0);
    expect(JSON.parse(resolved.stdout)).toEqual({
      resolved: false,
      reason: 'no_pending_stale_event',
    });
    expect(
      captured.some(r => r.path.includes('/stale-message-resolution')),
      'no-daemon stale-resolve still posted a resolution',
    ).toBe(false);
  });

  it('rejects the retired --event-id spelling with its exact replacement', async () => {
    const r = await runMessage({
      noun: 'message',
      verb: 'stale-resolve',
      argv: ['--resolution', 'obsolete', '--event-id', 'evt-obsolete'],
    });
    expect(r.code).toBe(1);
    const body = parseStderrJson(r.stderr);
    expect(body.error.subkind).toBe('flag_removed');
    expect(body.error.details).toMatchObject({ replacement: 'stale-event-id' });
  });

  // Flag validation must precede the blocking stdin read. A bad
  // --stale-resolution value (e.g. the `obsolete` that belongs to
  // `message stale-resolve`, not `message send`) fed with an inherited
  // never-closing stdin pipe must fail fast with a typed error — NOT
  // hang forever on a read whose EOF never comes.
  it('fails fast on an invalid --stale-resolution value even with an open, never-closing stdin pipe', async () => {
    const r = await runSend({
      argv: ['--stale-resolution', 'obsolete'],
      keepStdinOpen: true,
    });
    expect(
      r.killedByWatchdog,
      'CLI blocked on stdin before validating --stale-resolution',
    ).toBe(false);
    expect(r.code).toBe(1);
    const body = parseStderrJson(r.stderr);
    expect(body.error.code).toBe('validation_error');
    expect(body.error.message).toContain('unaffected or revised');
  }, 20_000);

  // The target gate (`requireSendTarget`) is another throwing flag path ahead
  // of the stdin read, and the one an agent will hit most often during the
  // cutover. Lock BOTH refusals against an open pipe: a validation moved
  // behind the read would turn the most common mistake into a hang, and a
  // body over the size cap would be uploaded as an attachment for a send that
  // could never land.
  it('fails fast on a missing or malformed --target even with an open, never-closing stdin pipe', async () => {
    const missing = await runSend({ omitTarget: true, keepStdinOpen: true });
    expect(
      missing.killedByWatchdog,
      'CLI blocked on stdin before validating a missing --target',
    ).toBe(false);
    expect(missing.code).toBe(1);
    expect(parseStderrJson(missing.stderr).error.subkind).toBe('target_required');

    const malformed = await runSend({
      argv: ['--target', 'thread:m-root'],
      keepStdinOpen: true,
    });
    expect(
      malformed.killedByWatchdog,
      'CLI blocked on stdin before validating a malformed --target',
    ).toBe(false);
    expect(malformed.code).toBe(1);
    expect(parseStderrJson(malformed.stderr).error.subkind).toBe(
      'target_malformed',
    );
  }, 30_000);

  // The third throwing path is the manual --anyway × --stale-resolution
  // conflict guard that runs after both flags parse. Both values are
  // individually valid, so only this combined check rejects — lock it
  // against an open pipe so it can't be the one left after the stdin read.
  it('fails fast on the --anyway + --stale-resolution conflict even with an open, never-closing stdin pipe', async () => {
    const r = await runSend({
      argv: ['--anyway', '--stale-resolution', 'unaffected'],
      keepStdinOpen: true,
    });
    expect(
      r.killedByWatchdog,
      'CLI blocked on stdin before validating --anyway/--stale-resolution',
    ).toBe(false);
    expect(r.code).toBe(1);
    const body = parseStderrJson(r.stderr);
    expect(body.error.code).toBe('validation_error');
    expect(body.error.message).toContain('force_send');
  }, 20_000);
});
