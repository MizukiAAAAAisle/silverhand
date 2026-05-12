/**
 * End-to-end verification for `silverhand message send` after the
 * stdin-only cutover (PR-A2′).
 *
 * Scope:
 *   - the legacy `--content` flag is rejected as `flag_removed`,
 *   - a TTY on stdin is rejected as `stdin_is_tty`,
 *   - an empty stdin pipe is rejected as `empty_stdin`,
 *   - bytes piped on stdin reach the backend byte-equal — no UTF-8
 *     normalization, no BOM strip, no CRLF→LF, no trim,
 *   - `--target` and repeated `--attachment` still flow through.
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
import { dirname, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI_SRC = resolve(__dirname, '..', 'src', 'cli.ts');
const TSX_BIN = resolve(__dirname, '..', 'node_modules', '.bin', 'tsx');

interface CapturedRequest {
  method: string;
  path: string;
  bodyBytes: Buffer;
}

let server: Server;
let serverUrl: string;
const captured: CapturedRequest[] = [];

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
      res.statusCode = 200;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ message_id: 'msg-1' }));
    });
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()));
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('no addr');
  serverUrl = `http://127.0.0.1:${addr.port}`;
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
}

function runSend(opts: {
  argv?: string[];
  stdin?: Buffer | string | null;
  /** Wrap with `script -q /dev/null` to fake a TTY on stdin. macOS only. */
  withTty?: boolean;
}): Promise<RunResult> {
  return new Promise((resolvePromise, reject) => {
    const argv = opts.argv ?? [];
    let cmd: string;
    let cmdArgs: string[];
    if (opts.withTty) {
      // BSD `script` puts the wrapped command's stdin/stdout under a
      // pty. We use `/dev/null` as the typescript output target.
      cmd = '/usr/bin/script';
      cmdArgs = ['-q', '/dev/null', TSX_BIN, CLI_SRC, 'message', 'send', ...argv];
    } else {
      cmd = TSX_BIN;
      cmdArgs = [CLI_SRC, 'message', 'send', ...argv];
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
      },
    });
    let stdout = '';
    let stderr = '';
    child.stdout!.on('data', chunk => (stdout += chunk.toString('utf8')));
    child.stderr!.on('data', chunk => (stderr += chunk.toString('utf8')));
    child.on('error', reject);
    child.on('close', code => resolvePromise({ code, stdout, stderr }));
    if (!opts.withTty) {
      if (opts.stdin !== null && opts.stdin !== undefined) {
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

describe('silverhand message send (stdin-only, real subprocess)', () => {
  it('rejects the legacy --content flag with subkind=flag_removed', async () => {
    const r = await runSend({ argv: ['--content', 'hello'], stdin: 'irrelevant' });
    expect(r.code).toBe(1);
    const body = parseStderrJson(r.stderr);
    expect(body.error.code).toBe('validation_error');
    expect(body.error.subkind).toBe('flag_removed');
    expect(body.error.message).toContain('--content was removed');
    expect(body.error.message).toContain("SILVERHAND_EOF");
  });

  it('rejects empty stdin with subkind=empty_stdin', async () => {
    const r = await runSend({ stdin: '' });
    expect(r.code).toBe(1);
    const body = parseStderrJson(r.stderr);
    expect(body.error.code).toBe('validation_error');
    expect(body.error.subkind).toBe('empty_stdin');
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

    it('handles a 256KB body without truncation or chunk-boundary corruption', async () => {
      captured.length = 0;
      // Repeating UTF-8 multibyte chars to maximize the chance that a
      // codepoint straddles a chunk boundary inside Node's stdin.
      const chunk = '中文测试 — emoji 🚀 — '.repeat(20_000);
      const bytes = Buffer.from(chunk, 'utf8');
      expect(bytes.byteLength).toBeGreaterThan(256 * 1024);
      const r = await runSend({ stdin: bytes });
      expect(r.code, r.stderr).toBe(0);
      const reqBody = JSON.parse(captured[0]!.bodyBytes.toString('utf8')) as {
        content: string;
      };
      expect(Buffer.from(reqBody.content, 'utf8').equals(bytes)).toBe(true);
    }, 30_000);
  });

  it('forwards --target and repeated --attachment in the request body', async () => {
    captured.length = 0;
    const r = await runSend({
      argv: [
        '--target',
        'parent',
        '--attachment',
        'att-1',
        '--attachment',
        'att-2',
      ],
      stdin: 'hi',
    });
    expect(r.code, r.stderr).toBe(0);
    const reqBody = JSON.parse(captured[0]!.bodyBytes.toString('utf8')) as {
      content: string;
      target?: string;
      attachment_ids?: string[];
    };
    expect(reqBody.content).toBe('hi');
    expect(reqBody.target).toBe('parent');
    expect(reqBody.attachment_ids).toEqual(['att-1', 'att-2']);
  });
}, { timeout: 30_000 });
