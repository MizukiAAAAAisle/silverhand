/**
 * End-to-end verification that `silverhand task create` never prints a
 * business failure to stdout as success.
 *
 * The create route returns HTTP 200 with a typed envelope for business
 * failures (mirroring claim/status/edit) so the CLI can read the structured
 * `error` + `existing_task` from the body. `source_conflict` (the permanent
 * 1:1 provenance lock — the concurrency-winner path) therefore arrives as a
 * 200 body, and the CLI MUST turn it into a non-zero exit, a stable
 * `code=conflict` on stderr carrying `details.existing_task`, and NO success
 * JSON on stdout. An in-process unit test could assert the mapping but not
 * that the process actually exits non-zero with an empty stdout — hence a real
 * subprocess.
 *
 * Why a tiny HTTP server: the create route is POSTed by the CLI client; a
 * ~30-line capture server lets us shape the 200 typed envelope and confirm
 * the CLI's exit/stderr/stdout contract against it.
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
const CLI_SRC = resolve(__dirname, '..', '..', 'src', 'cli.ts');
const TSX_BIN = resolve(__dirname, '..', '..', 'node_modules', '.bin', 'tsx');

let server: Server;
let serverUrl: string;
let nextResponse: { status: number; body: unknown } | null = null;

beforeAll(async () => {
  server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      const reply = nextResponse;
      nextResponse = null;
      res.statusCode = reply?.status ?? 200;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(reply?.body ?? { tasks: [] }));
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

interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

function runCreate(argv: readonly string[]): Promise<RunResult> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(TSX_BIN, [CLI_SRC, 'task', 'create', ...argv], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        SILVERHAND_CONVERSATION_ID: 'conv-1',
        SILVERHAND_AGENT_ID: 'agent-1',
        SILVERHAND_AUTH_TOKEN: 'tok-1',
        SILVERHAND_SERVER_URL: serverUrl,
        SILVERHAND_DAEMON_SOCKET: '',
      },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', c => (stdout += c.toString('utf8')));
    child.stderr.on('data', c => (stderr += c.toString('utf8')));
    child.on('error', reject);
    child.on('close', code => resolvePromise({ code, stdout, stderr }));
    child.stdin.end();
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
  const line = stderr.split(/\r?\n/).find(l => l.trim().startsWith('{'));
  if (!line) throw new Error(`no JSON line in stderr:\n${stderr}`);
  return JSON.parse(line);
}

describe('silverhand task create — business-failure never prints as success (real subprocess)', () => {
  it('maps a 200 source_conflict envelope to exit≠0 + code=conflict + details.existing_task, no success stdout', async () => {
    nextResponse = {
      status: 200,
      body: {
        error: 'source_conflict',
        existing_task: { task_number: 7, status: 'closed', title: 'the winner' },
      },
    };
    const r = await runCreate([
      '--title',
      'derived',
      '--source-message-id',
      'm-src',
    ]);
    // Exit code: a business failure, NOT success.
    expect(r.code).toBe(1);
    // Nothing on stdout — a `{tasks:...}`-shaped success object here would be
    // the exact regression finding-1 guards against.
    expect(r.stdout.trim()).toBe('');
    const body = parseStderrJson(r.stderr);
    expect(body.error.code).toBe('conflict');
    expect(body.error.subkind).toBe('source_conflict');
    expect(body.error.retriable).toBe(false);
    expect(body.error.details).toMatchObject({
      existing_task: { task_number: 7, status: 'closed', title: 'the winner' },
    });
  });
}, { timeout: 30_000 });
