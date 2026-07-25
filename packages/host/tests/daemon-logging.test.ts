/**
 * §3.4 daemon logging contract — redaction tests.
 *
 * Step 1 review boundary (Cindy `1vRk1SIAFfa1x10t`): protocol-side
 * correctness + logging contract assertions. These tests assert:
 *
 *  1. Each typed helper writes a `kind: '<group>'` field that matches
 *     its bucket — `intent`, `event`, `process`, `daemon`,
 *     `backpressure`. The grep-for-jq operator workflow depends on
 *     this discriminator.
 *  2. No log entry passed through any helper carries any forbidden
 *     field name (`payload`, `chunk`, `body`, `text`, `prompt`,
 *     `env`, `env_*`, `stdout`, `stderr`, `soft_directive`). Compile-time enforcement happens via the typed
 *     interfaces; the runtime guard `findForbiddenFields` is a
 *     belt-and-suspenders check the test exercises.
 *  3. End-to-end: dispatch a real intent through `IntentDispatcher`
 *     with a `payload`-bearing param (e.g. `runtime_deliver`) and assert
 *     the log line emitted by `logIntent` does NOT carry the payload
 *     value or the field name. This is the primary "did we leak
 *     stdin bytes through the log layer" test.
 */
import { describe, expect, it } from 'vitest';
import {
  FORBIDDEN_LOG_FIELDS,
  FORBIDDEN_LOG_FIELD_PREFIXES,
  findForbiddenFields,
  logBackpressure,
  logDaemon,
  logEvent,
  logIntent,
  logProcess,
} from '../src/daemon/daemon-logging.js';
import { createDaemonLogControl, type DaemonLogger } from '../src/daemon/logger.js';
import { IntentDispatcher } from '../src/daemon/dispatcher.js';
import type { SupervisorContract } from '../src/daemon/supervisor-contract.js';
import { testStartOptions } from './_helpers/runtime-start-options.js';

interface CapturedLine {
  level: 'debug' | 'info' | 'warn' | 'error';
  obj: Record<string, unknown>;
  msg: string;
}

function capturingLogger(): { lines: CapturedLine[]; logger: DaemonLogger } {
  const lines: CapturedLine[] = [];
  const logger: DaemonLogger = {
    filePath: '/dev/null',
    logControl: createDaemonLogControl('debug'),
    debug: (obj, msg) =>
      lines.push({ level: 'debug', obj: obj as Record<string, unknown>, msg: msg ?? '' }),
    info: (obj, msg) =>
      lines.push({ level: 'info', obj: obj as Record<string, unknown>, msg: msg ?? '' }),
    warn: (obj, msg) =>
      lines.push({ level: 'warn', obj: obj as Record<string, unknown>, msg: msg ?? '' }),
    error: (obj, msg) =>
      lines.push({ level: 'error', obj: obj as Record<string, unknown>, msg: msg ?? '' }),
    close: async () => {},
  };
  return { lines, logger };
}

describe('§3.4 — typed helpers stamp the right `kind` discriminator', () => {
  it('logIntent → kind: "intent"', () => {
    const { lines, logger } = capturingLogger();
    logIntent(logger, {
      intent: 'ping',
      request_id: 'r1',
      status: 'ok',
      duration_ms: 1,
    });
    expect(lines[0]!.obj.kind).toBe('intent');
    expect(lines[0]!.obj.intent).toBe('ping');
    expect(lines[0]!.obj.status).toBe('ok');
  });

  it('logEvent → kind: "event"', () => {
    const { lines, logger } = capturingLogger();
    logEvent(logger, { event: 'runtime_state', conversationId: 'c1', agent_id: 'a1' });
    expect(lines[0]!.obj.kind).toBe('event');
    expect(lines[0]!.obj.event).toBe('runtime_state');
  });

  it('logProcess → kind: "process"', () => {
    const { lines, logger } = capturingLogger();
    logProcess(logger, { action: 'spawn', pid: 1234 });
    expect(lines[0]!.obj.kind).toBe('process');
  });

  it('logDaemon → kind: "daemon"', () => {
    const { lines, logger } = capturingLogger();
    logDaemon(logger, {
      action: 'boot',
      pid: 1234,
      socket_path: '/tmp/s',
      pid_file_path: '/tmp/p',
    });
    expect(lines[0]!.obj.kind).toBe('daemon');
  });

  it('logBackpressure → kind: "backpressure"', () => {
    const { lines, logger } = capturingLogger();
    logBackpressure(logger, {
      conversationId: 'c1',
      agent_id: 'a1',
      action: 'dropped',
      buffer_bytes: 100,
      dropped_count: 1,
      bytes_dropped: 50,
    });
    expect(lines[0]!.obj.kind).toBe('backpressure');
  });

  it('logProcess sigkill is warn-level (operator attention)', () => {
    const { lines, logger } = capturingLogger();
    logProcess(logger, { action: 'sigkill', pid: 1234 });
    expect(lines[0]!.level).toBe('warn');
  });

  it('logDaemon cli_launcher_unavailable is warn-level', () => {
    const { lines, logger } = capturingLogger();
    logDaemon(logger, { action: 'cli_launcher_unavailable', pid: 1234 });
    expect(lines[0]!.level).toBe('warn');
    expect(lines[0]!.obj).toMatchObject({
      kind: 'daemon',
      action: 'cli_launcher_unavailable',
    });
  });

  it('logIntent host_status success logs are debug-level poll diagnostics', () => {
    const { lines, logger } = capturingLogger();
    logIntent(logger, {
      intent: 'host_status',
      request_id: 'r1',
      status: 'received',
    });
    logIntent(logger, {
      intent: 'host_status',
      request_id: 'r1',
      status: 'ok',
      duration_ms: 1,
    });
    logIntent(logger, {
      intent: 'host_status',
      request_id: 'r1',
      status: 'error',
      error_code: 'internal_error',
    });

    expect(lines.map(line => line.level)).toEqual(['debug', 'debug', 'warn']);
  });
});

describe('§3.4 — forbidden field names never reach the log line', () => {
  it('findForbiddenFields detects every listed name', () => {
    for (const name of FORBIDDEN_LOG_FIELDS) {
      expect(findForbiddenFields({ [name]: 'anything' })).toContain(name);
    }
    for (const prefix of FORBIDDEN_LOG_FIELD_PREFIXES) {
      const k = `${prefix}MY_VAR`;
      expect(findForbiddenFields({ [k]: 'value' })).toContain(k);
    }
  });

  it('findForbiddenFields ignores allowed structural fields', () => {
    expect(
      findForbiddenFields({
        kind: 'intent',
        intent: 'ping',
        request_id: 'r1',
        status: 'ok',
        conversationId: 'c1',
        agent_id: 'a1',
        delivery_ids: [1, 2, 3],
        dropped_count: 0,
        bytes_dropped: 0,
        pid: 1234,
        socket_path: '/tmp/s',
      }),
    ).toEqual([]);
  });

  it('every typed helper emits a line whose top-level keys are forbidden-free', () => {
    const { lines, logger } = capturingLogger();
    logIntent(logger, {
      intent: 'runtime_deliver',
      request_id: 'r1',
      status: 'received',
      conversationId: 'c1',
      agent_id: 'a1',
    });
    logEvent(logger, {
      event: 'runtime_output_dropped',
      conversationId: 'c1',
      agent_id: 'a1',
      dropped_count: 5,
      bytes_dropped: 1024,
    });
    logProcess(logger, {
      action: 'reclaim',
      pid: 1234,
      conversationId: 'c1',
      agent_id: 'a1',
      cmdline_match: true,
    });
    logDaemon(logger, {
      action: 'pid_claim',
      pid: 1234,
      pid_file_path: '/tmp/daemon.pid',
    });
    logBackpressure(logger, {
      conversationId: 'c1',
      agent_id: 'a1',
      action: 'dropped',
      buffer_bytes: 4_000_000,
      dropped_count: 12,
      bytes_dropped: 8192,
    });
    expect(lines).toHaveLength(5);
    for (const line of lines) {
      expect(findForbiddenFields(line.obj)).toEqual([]);
    }
  });
});

describe('§3.4 — IntentDispatcher payload redaction', () => {
  /** Stub supervisor that resolves deliver successfully so the dispatch
   *  exercises the full received → ok path. */
  const stubSupervisor: SupervisorContract = {
    agentMessageSend: async () => ({
      ok: false,
      status: 500,
      body_text: '{"error":"not used"}',
    }),
    agentStaleResolve: async () => ({
      ok: true,
      resolved: false,
      reason: 'no_pending_stale_event',
    }),
    agentStreamObserved: async () => ({ ok: true }),
    agentStaleReceive: async () => ({
      ok: true,
      outcome: 'no_pending_stale' as const,
    }),
    start: async () => ({ started: true, pid: 1, started_at: 0 }),
    stop: async () => ({ mode: 'hard', stopped: true, exit_code: 0 }),
    deliver: async () => ({ disposition: 'admitted', pid: 1, started_at: 0 }),
    status: async () => ({ runtimes: [] }),
    clearSession: async () => ({ cleared: true }),
    stopAll: async () => ({ stopped_count: 0 }),
    closeActivityLog: async () => ({ flushed: true }),
    pauseOutput: async () => ({ paused: true }),
    resumeOutput: async () => ({ resumed: true }),
    cleanupDeferredForOwner: () => {},
  };

  it('runtime_deliver dispatch logs received + ok lines that omit `text` (Option A v2)', async () => {
    const { lines, logger } = capturingLogger();
    const d = new IntentDispatcher({ logger, supervisor: stubSupervisor });
    const SECRET_TEXT = 'VERY-CONFIDENTIAL-USER-INPUT-XYZ';
    await d.dispatch('req-1', 'runtime_deliver', {
      conversation_id: 'c1',
      agent_id: 'a1',
      delivery_ids: [42],
      kind: 'message',
      text: SECRET_TEXT,
      spawn_options: testStartOptions(),
    }, { owner: 'test-owner' });
    // §3.4: NO log line may carry the text value or the field name.
    // Option A v2 (Cindy `UMGu36zoTDVuKWXi`): `text` replaces the old
    // pre-encoded `payload`; `FORBIDDEN_LOG_FIELDS` covers both.
    for (const line of lines) {
      const flat = JSON.stringify(line.obj);
      expect(flat).not.toContain('VERY-CONFIDENTIAL-USER-INPUT-XYZ');
      expect(flat).not.toContain('"text"');
      expect(flat).not.toContain('"payload"');
    }
    // Sanity: at least one received + one ok log line landed.
    const received = lines.filter(l => (l.obj as { status?: string }).status === 'received');
    const ok = lines.filter(l => (l.obj as { status?: string }).status === 'ok');
    expect(received).toHaveLength(1);
    expect(ok).toHaveLength(1);
    expect(ok[0]!.obj).toMatchObject({
      kind: 'intent',
      intent: 'runtime_deliver',
      request_id: 'req-1',
      status: 'ok',
      conversationId: 'c1',
      agent_id: 'a1',
    });
    expect(typeof ok[0]!.obj.duration_ms).toBe('number');
  });

  it('invalid_params dispatch still emits an `error` log line without text leakage', async () => {
    const { lines, logger } = capturingLogger();
    const d = new IntentDispatcher({ logger, supervisor: stubSupervisor });
    // Pass a malformed deliver — missing delivery_ids → invalid_params.
    await d.dispatch('req-2', 'runtime_deliver', {
      conversation_id: 'c1',
      agent_id: 'a1',
      kind: 'message',
      text: 'LEAK-ATTEMPT',
      spawn_options: testStartOptions(),
    }, { owner: 'test-owner' });
    for (const line of lines) {
      const flat = JSON.stringify(line.obj);
      expect(flat).not.toContain('LEAK-ATTEMPT');
      expect(flat).not.toContain('"text"');
      expect(flat).not.toContain('"payload"');
    }
    const errLine = lines.find(l => (l.obj as { status?: string }).status === 'error');
    expect(errLine?.obj).toMatchObject({
      kind: 'intent',
      intent: 'runtime_deliver',
      status: 'error',
      error_code: 'invalid_params',
    });
  });

  it('shutting-down dispatch logs error + reason without exposing params', async () => {
    const { lines, logger } = capturingLogger();
    const d = new IntentDispatcher({ logger, supervisor: stubSupervisor });
    d.markShuttingDown();
    await d.dispatch('req-3', 'runtime_deliver', {
      conversation_id: 'c1',
      agent_id: 'a1',
      delivery_ids: [1],
      kind: 'message',
      text: 'POST-SHUTDOWN-LEAK',
      spawn_options: testStartOptions(),
    }, { owner: 'test-owner' });
    for (const line of lines) {
      const flat = JSON.stringify(line.obj);
      expect(flat).not.toContain('POST-SHUTDOWN-LEAK');
      expect(flat).not.toContain('"text"');
      expect(flat).not.toContain('"payload"');
    }
    const errLine = lines.find(l => (l.obj as { status?: string }).status === 'error');
    expect(errLine?.obj.error_code).toBe('shutting_down');
  });
});
