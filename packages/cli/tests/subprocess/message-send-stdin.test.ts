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
 *   - `--target` and repeated `--attachment-id` still flow through.
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

describe('runtime route target vs command-local conversation selector', { timeout: 30_000 }, () => {
  it('keeps ConversationSlot route A while task and search requests select B', async () => {
    captured.length = 0;
    nextSendResponse = { status: 200, body: { tasks: [] } };
    const list = await runMessage({
      noun: 'task',
      verb: 'list',
      argv: ['--conversation-id', 'conv-B'],
    });
    expect(list.code, list.stderr).toBe(0);
    expect(captured[0]!.path).toBe(
      '/internal/agents/agent-1/conversations/conv-1/tasks?conversation_id=conv-B',
    );

    captured.length = 0;
    nextSendResponse = {
      status: 200,
      body: { tasks: [{ id: 'task-id', task_number: 12, title: 'file in B' }] },
    };
    const create = await runMessage({
      noun: 'task',
      verb: 'create',
      argv: ['--title', 'file in B', '--conversation-id', 'conv-B'],
    });
    expect(create.code, create.stderr).toBe(0);
    expect(captured[0]!.path).toBe(
      '/internal/agents/agent-1/conversations/conv-1/tasks/create',
    );
    expect(JSON.parse(captured[0]!.bodyBytes.toString('utf8'))).toMatchObject({
      conversation_id: 'conv-B',
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
      '/internal/agents/agent-1/conversations/conv-1/search-messages',
    );
    expect(JSON.parse(captured[0]!.bodyBytes.toString('utf8'))).toMatchObject({
      conversation_id: 'conv-B',
    });
  });

  it('uses AgentSlot route target only as transport focus; list stays unfiltered until a command selector is supplied', async () => {
    captured.length = 0;
    nextSendResponse = { status: 200, body: { tasks: [] } };
    const allBoards = await runMessage({
      noun: 'task',
      verb: 'list',
      argv: ['--route-conversation-id', 'agent-inbox'],
      env: { SILVERHAND_CONVERSATION_ID: '' },
    });
    expect(allBoards.code, allBoards.stderr).toBe(0);
    expect(captured[0]!.path).toBe(
      '/internal/agents/agent-1/conversations/agent-inbox/tasks',
    );

    captured.length = 0;
    nextSendResponse = { status: 200, body: { tasks: [] } };
    const narrowed = await runMessage({
      noun: 'task',
      verb: 'list',
      argv: [
        '--route-conversation-id',
        'agent-inbox',
        '--conversation-id',
        'conv-B',
      ],
      env: { SILVERHAND_CONVERSATION_ID: '' },
    });
    expect(narrowed.code, narrowed.stderr).toBe(0);
    expect(captured[0]!.path).toBe(
      '/internal/agents/agent-1/conversations/agent-inbox/tasks?conversation_id=conv-B',
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

function runSend(opts: {
  argv?: string[];
  stdin?: Buffer | string | null;
  env?: Record<string, string>;
  /** Wrap with `script -q /dev/null` to fake a TTY on stdin. macOS only. */
  withTty?: boolean;
  /** Leave stdin OPEN and non-TTY (never delivers EOF) — mimics an
   *  inherited pipe. Arms a watchdog so a hang fails cleanly. */
  keepStdinOpen?: boolean;
}): Promise<RunResult> {
  return runMessage({
    noun: 'message',
    verb: 'send',
    ...opts,
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
  error: { code: string; subkind?: string; message: string; retriable: boolean };
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
      expect(upload.path).toBe('/internal/agents/agent-1/conversations/conv-1/attachments');
      // Multipart body carries the original bytes verbatim.
      expect(upload.bodyBytes.includes(bytes)).toBe(true);
      const send = captured[1]!;
      const reqBody = JSON.parse(send.bodyBytes.toString('utf8')) as {
        content: string;
        attachment_ids?: string[];
      };
      expect(reqBody.attachment_ids).toEqual(['att-big']);
      expect(Buffer.byteLength(reqBody.content, 'utf8')).toBeLessThanOrEqual(64 * 1024);
      expect(reqBody.content).toContain('message-body-x.txt');
    }, 30_000);
  });

  it('forwards --target and repeated --attachment-id in the request body', async () => {
    captured.length = 0;
    const r = await runSend({
      argv: [
        '--target',
        'thread:m-1',
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
    expect(reqBody.target).toEqual({ kind: 'thread', message_id: 'm-1' });
    expect(reqBody.attachment_ids).toEqual(['att-1', 'att-2']);
  });

  it('uses the explicit conversation as the AgentSlot route when no ambient target exists', async () => {
    captured.length = 0;
    const r = await runSend({
      argv: ['--route-conversation-id', 'conv-explicit'],
      stdin: 'cross-target message',
      env: { SILVERHAND_CONVERSATION_ID: '' },
    });
    expect(r.code, r.stderr).toBe(0);
    expect(captured).toHaveLength(1);
    expect(captured[0]!.path).toBe(
      '/internal/agents/agent-1/conversations/conv-explicit/send-message',
    );
    const reqBody = JSON.parse(captured[0]!.bodyBytes.toString('utf8')) as {
      content: string;
    };
    expect(reqBody.content).toBe('cross-target message');
  });

  it('maps --target channel to the current channel main-line target', async () => {
    captured.length = 0;
    const r = await runSend({
      argv: ['--target', 'channel'],
      stdin: 'main-line answer',
    });
    expect(r.code, r.stderr).toBe(0);
    const reqBody = JSON.parse(captured[0]!.bodyBytes.toString('utf8')) as {
      content: string;
      target?: unknown;
      reply_to_message_id?: string;
    };
    expect(reqBody.content).toBe('main-line answer');
    expect(reqBody.target).toEqual({ kind: 'channel' });
    expect(reqBody.reply_to_message_id).toBeUndefined();
  });

  it('maps --target thread:<message_id> to the public thread target and echoes thread_root_id', async () => {
    captured.length = 0;
    nextSendResponse = {
      status: 200,
      body: { message_id: 'm-reply', message_seq: 12, thread_root_id: 'm-root' },
    };
    const r = await runSend({
      argv: ['--target', 'thread:m-root'],
      stdin: 'threaded answer',
    });
    expect(r.code, r.stderr).toBe(0);
    const reqBody = JSON.parse(captured[0]!.bodyBytes.toString('utf8')) as {
      content: string;
      reply_to_message_id?: string;
      target?: unknown;
    };
    expect(reqBody.content).toBe('threaded answer');
    expect(reqBody.target).toEqual({ kind: 'thread', message_id: 'm-root' });
    expect(reqBody.reply_to_message_id).toBeUndefined();
    const out = JSON.parse(r.stdout) as { thread_root_id?: string | null };
    expect(out.thread_root_id).toBe('m-root');
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

  it('keeps --reply-to as a hidden compatibility alias for the public thread target', async () => {
    captured.length = 0;
    const r = await runSend({
      argv: ['--reply-to', 'm-root'],
      stdin: 'threaded answer',
    });
    expect(r.code, r.stderr).toBe(0);
    const reqBody = JSON.parse(captured[0]!.bodyBytes.toString('utf8')) as {
      reply_to_message_id?: string;
      target?: unknown;
    };
    expect(reqBody.target).toEqual({ kind: 'thread', message_id: 'm-root' });
    expect(reqBody.reply_to_message_id).toBeUndefined();
  });

  it('rejects --reply-to together with --target as mutually_exclusive', async () => {
    const r = await runSend({
      argv: ['--reply-to', 'm-root', '--target', 'thread:m-other'],
      stdin: 'oops',
    });
    expect(r.code).toBe(1);
    const body = parseStderrJson(r.stderr);
    expect(body.error.code).toBe('validation_error');
    expect(body.error.subkind).toBe('mutually_exclusive');
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
    // The pending stale event is daemon-held state and there is at most one
    // per agent, so `stale-resolve` carries no id. Without a daemon there is
    // nothing to resolve: the CLI degrades honestly instead of POSTing a
    // resolution for an event it cannot name.
    captured.length = 0;
    nextSendResponse = { status: 200, body: { ok: true } };
    const resolved = await runMessage({
      noun: 'message',
      verb: 'stale-resolve',
      argv: ['--resolution', 'obsolete'],
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

  it('rejects the removed --event-id with flag_removed', async () => {
    const r = await runMessage({
      noun: 'message',
      verb: 'stale-resolve',
      argv: ['--resolution', 'obsolete', '--event-id', 'evt-obsolete'],
    });
    expect(r.code).toBe(1);
    const body = parseStderrJson(r.stderr);
    expect(body.error.subkind).toBe('flag_removed');
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

  // The mutual-exclusion check (parseSendDestination) is another throwing
  // flag path ahead of the stdin read. Lock it against an open pipe too,
  // so a future refactor can't quietly move only one validation back and
  // reintroduce the hang for the other.
  it('fails fast on mutually-exclusive --reply-to/--target even with an open, never-closing stdin pipe', async () => {
    const r = await runSend({
      argv: ['--reply-to', 'm-root', '--target', 'thread:m-other'],
      keepStdinOpen: true,
    });
    expect(
      r.killedByWatchdog,
      'CLI blocked on stdin before validating --reply-to/--target',
    ).toBe(false);
    expect(r.code).toBe(1);
    const body = parseStderrJson(r.stderr);
    expect(body.error.code).toBe('validation_error');
    expect(body.error.subkind).toBe('mutually_exclusive');
  }, 20_000);

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
