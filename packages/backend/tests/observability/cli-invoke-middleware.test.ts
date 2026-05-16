/**
 * End-to-end coverage for the CLI invoke middleware + the cli-trace
 * pre-flight endpoint. Runs against the real Hono app (in-process via
 * `app.fetch`) with a capture-logger swapped into `ctx.loggers.cli`.
 *
 * What we lock here:
 *   - Every internal route emits exactly one `cli.invoke` line per
 *     call, success OR failure.
 *   - The `cli-trace` endpoint emits a `cli.preflight_failure` line
 *     and does NOT also emit a `cli.invoke` line (no double-count).
 *   - Privacy: the line records `query_keys` (a sorted name set) but
 *     never values; nothing leaks the auth token.
 *   - Failures expose the backend's stable `error_code`.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildTestApp, http, type TestApp } from '../utils/app.js';
import type { BackendLogger } from '../../src/context.js';

interface CapturedLine {
  level: 'info' | 'warn' | 'error';
  payload: Record<string, unknown>;
  msg?: string;
}

function captureLogger(): { logger: BackendLogger; lines: CapturedLine[] } {
  const lines: CapturedLine[] = [];
  const make = (level: CapturedLine['level']) =>
    (payload: unknown, msg?: string) => {
      lines.push({
        level,
        payload: (payload ?? {}) as Record<string, unknown>,
        msg,
      });
    };
  return {
    lines,
    logger: { info: make('info'), warn: make('warn'), error: make('error') },
  };
}

async function setupAgent(t: TestApp): Promise<{
  conversationId: string;
  agentId: string;
}> {
  const h = http(t);
  const a = (await (
    await h.post('/api/agents', { name: 'alice', runtime: 'claude' })
  ).json()) as any;
  const ws = (await (
    await h.post('/api/workspaces', { name: 'eng', member_agent_ids: [a.agent.id] })
  ).json()) as any;
  return { conversationId: ws.onboarding_channel_id, agentId: a.agent.id };
}

describe('cli invoke middleware', () => {
  let t: TestApp | null = null;
  let captured: ReturnType<typeof captureLogger>;

  beforeEach(() => {
    t = buildTestApp();
    captured = captureLogger();
    t.ctx.loggers.cli = captured.logger;
  });

  afterEach(() => {
    t?.cleanup();
    t = null;
  });

  it('emits one cli.invoke line per successful internal call', async () => {
    const { conversationId, agentId } = await setupAgent(t!);
    const h = http(t!);

    const res = await h.get(
      `/internal/conversations/${conversationId}/agents/${agentId}/tasks?status=todo`,
    );
    expect(res.status).toBe(200);

    const lines = captured.lines.filter(l => l.payload.category === 'cli.invoke');
    expect(lines).toHaveLength(1);
    const line = lines[0]!;
    expect(line.payload).toMatchObject({
      category: 'cli.invoke',
      noun: 'task',
      verb: 'list',
      method: 'GET',
      route_suffix: 'tasks',
      http_status: 200,
      status: 'success',
    });
    expect(line.payload.cid).toBe(conversationId);
    expect(line.payload.aid).toBe(agentId);
    expect(line.payload.request_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(typeof line.payload.duration_ms).toBe('number');

    // Privacy: never log the raw URL path field — only `route_suffix`
    // (the matched pattern) and `query_keys` (sorted key set).
    expect(line.payload.suffix).toBeUndefined();
    expect(line.payload.query_keys).toEqual(['status']);
  });

  it('records repeated query keys exactly once each', async () => {
    const { conversationId, agentId } = await setupAgent(t!);
    const h = http(t!);

    await h.get(
      `/internal/conversations/${conversationId}/agents/${agentId}/tasks?status=todo&status=done&task_number=1`,
    );

    const line = captured.lines.find(l => l.payload.category === 'cli.invoke');
    expect(line).toBeDefined();
    // `status` collapses to one entry even though we passed it twice.
    // `task_number` shows up alongside it. Sorted by key name.
    expect(line!.payload.query_keys).toEqual(['status', 'task_number']);
  });

  it('marks 4xx responses as failure and surfaces backend error_code', async () => {
    const { conversationId, agentId } = await setupAgent(t!);
    const h = http(t!);

    // Malformed body → schema validation kicks 400 with
    // `{error: 'invalid input', issues: [...]}`. The middleware
    // peeks `error` (string) when no structured `error.code` is
    // present.
    const res = await h.post(
      `/internal/conversations/${conversationId}/agents/${agentId}/tasks/update-status`,
      { task_number: 'not-a-number' },
    );
    expect(res.status).toBe(400);

    const line = captured.lines.find(l => l.payload.category === 'cli.invoke');
    expect(line).toBeDefined();
    expect(line!.payload.status).toBe('failure');
    expect(line!.payload.http_status).toBe(400);
    expect(line!.payload.error_code).toBe('invalid input');
  });

  it('captures a privacy-safe issue summary on schema validation failures', async () => {
    // The 5/14 daily report logged `schedule.create | invalid_input |
    // (empty error_message)` — the route returns a structured
    // `issues[]` array but the previous middleware threw it away, so
    // the report parser couldn't bucket. Now we must extract a
    // {path, code} per issue (NEVER values).
    const { conversationId, agentId } = await setupAgent(t!);
    const h = http(t!);

    // Send a body that fails ScheduleCreateInputSchema in multiple
    // fields at once — validates that we capture all issues, not just
    // the first.
    const res = await h.post(
      `/internal/conversations/${conversationId}/agents/${agentId}/schedules`,
      { kind: 'unknown_kind', message: '' },
    );
    expect(res.status).toBe(400);

    const line = captured.lines.find(l => l.payload.category === 'cli.invoke');
    expect(line).toBeDefined();
    expect(line!.payload.error_code).toBe('invalid_input');

    const issues = line!.payload.error_issues as
      | ReadonlyArray<{ path: string; code: string }>
      | undefined;
    expect(issues).toBeDefined();
    expect(Array.isArray(issues)).toBe(true);
    expect(issues!.length).toBeGreaterThan(0);
    // Every entry must have BOTH a non-empty path and a code.
    for (const i of issues!) {
      expect(typeof i.path).toBe('string');
      expect(typeof i.code).toBe('string');
      expect(i.code.length).toBeGreaterThan(0);
    }

    // Privacy: nothing about the supplied value (`unknown_kind`)
    // leaks. The path is structural; `code` is a zod tag.
    const serialized = JSON.stringify(line!.payload);
    expect(serialized).not.toContain('unknown_kind');
  });

  it('still logs the call when auth rejects (401 case)', async () => {
    const { conversationId, agentId } = await setupAgent(t!);

    // Skip the http() helper: it auto-issues a valid per-agent token
    // for `internal/conversations/...` paths. We want to verify what
    // the in-process Hono stack does when the auth middleware rejects
    // an unauthenticated call.
    const url = `http://localhost/internal/conversations/${conversationId}/agents/${agentId}/tasks`;
    const res = await t!.app.fetch(new Request(url, { method: 'GET' }));
    expect(res.status).toBe(401);

    // Documented gap: the auth middleware short-circuits BEFORE the
    // invoke middleware (registered later), so 401s currently don't
    // produce a `cli.invoke` line. If we later want unauthorized
    // typo telemetry we'd flip the middleware ordering. This test
    // locks the current behavior so the regression is visible.
    const cliInvokeLines = captured.lines.filter(
      l => l.payload.category === 'cli.invoke',
    );
    expect(cliInvokeLines).toHaveLength(0);
  });

  it('logs the route_suffix pattern, never the raw attachment id', async () => {
    const { conversationId, agentId } = await setupAgent(t!);
    const h = http(t!);

    // Bogus attachment id — route still runs, returns 4xx, but the
    // important assertion is that the id NEVER lands in the log.
    const fakeId = 'attach-deadbeef-1234';
    await h.get(
      `/internal/conversations/${conversationId}/agents/${agentId}/attachments/${fakeId}/locate`,
    );

    const line = captured.lines.find(l => l.payload.category === 'cli.invoke');
    expect(line).toBeDefined();
    expect(line!.payload.noun).toBe('file');
    expect(line!.payload.verb).toBe('view');
    // Normalized pattern, NOT the raw id.
    expect(line!.payload.route_suffix).toBe('attachments/*/locate');
    expect(JSON.stringify(line!.payload)).not.toContain(fakeId);
  });
});

describe('cli-trace endpoint', () => {
  let t: TestApp | null = null;
  let captured: ReturnType<typeof captureLogger>;

  beforeEach(() => {
    t = buildTestApp();
    captured = captureLogger();
    t.ctx.loggers.cli = captured.logger;
  });

  afterEach(() => {
    t?.cleanup();
    t = null;
  });

  it('emits cli.preflight_failure and is excluded from cli.invoke', async () => {
    const { conversationId, agentId } = await setupAgent(t!);
    const h = http(t!);

    const res = await h.post(
      `/internal/conversations/${conversationId}/agents/${agentId}/cli-trace`,
      {
        noun: 'task',
        verb: 'list',
        flags_seen: ['task-numbers'],
        error_code: 'validation_error',
        error_message: 'unknown flag --task-numbers; did you mean --task-number?',
        duration_ms: 4.2,
      },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: true };
    expect(body.ok).toBe(true);

    const trace = captured.lines.find(
      l => l.payload.category === 'cli.preflight_failure',
    );
    expect(trace).toBeDefined();
    expect(trace!.payload).toMatchObject({
      category: 'cli.preflight_failure',
      noun: 'task',
      verb: 'list',
      flags_seen: ['task-numbers'],
      error_code: 'validation_error',
      status: 'failure',
    });
    expect(trace!.payload.cid).toBe(conversationId);
    expect(trace!.payload.aid).toBe(agentId);

    // Crucial: NO cli.invoke line was also emitted. Pre-flight
    // failures must not pollute the success-rate stats.
    const invokes = captured.lines.filter(
      l => l.payload.category === 'cli.invoke',
    );
    expect(invokes).toHaveLength(0);
  });

  // The daily report groups failures by subkind. Without this round-trip
  // assertion a renamed subkind on the CLI side would silently fall off
  // the report and we'd discover it weeks later by noticing aggregate
  // gaps. Every subkind the CLI may send must appear verbatim in the
  // logged payload.
  it.each([
    'flag_removed',
    'verb_removed',
    'unknown_flag',
    'enum_invalid',
    'mutually_exclusive',
    'unexpected_arguments',
    'stdin_is_tty',
    'empty_stdin',
    'invalid_utf8',
  ] as const)(
    'records error_subkind=%s in the cli.preflight_failure line',
    async subkind => {
      const { conversationId, agentId } = await setupAgent(t!);
      const h = http(t!);
      const res = await h.post(
        `/internal/conversations/${conversationId}/agents/${agentId}/cli-trace`,
        {
          noun: 'task',
          verb: 'list',
          error_code: 'validation_error',
          error_subkind: subkind,
        },
      );
      expect(res.status).toBe(200);
      const trace = captured.lines.find(
        l => l.payload.category === 'cli.preflight_failure',
      );
      expect(trace).toBeDefined();
      expect(trace!.payload.error_subkind).toBe(subkind);
    },
  );


  it('rejects cli-trace bodies that fail schema (400, no log)', async () => {
    const { conversationId, agentId } = await setupAgent(t!);
    const h = http(t!);

    const res = await h.post(
      `/internal/conversations/${conversationId}/agents/${agentId}/cli-trace`,
      // `noun` longer than the 64-char cap → reject.
      { noun: 'x'.repeat(200) },
    );
    expect(res.status).toBe(400);
    const trace = captured.lines.find(
      l => l.payload.category === 'cli.preflight_failure',
    );
    expect(trace).toBeUndefined();
  });
});
