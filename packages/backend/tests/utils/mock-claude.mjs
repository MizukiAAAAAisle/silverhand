#!/usr/bin/env node
/* eslint-disable */
// @ts-nocheck
/**
 * mock-claude: a tiny stand-in for the `claude` CLI used by L3 ConversationManager
 * tests. Speaks just enough of the stream-json protocol for ClaudeDriver.
 *
 * Behavior is driven by env vars (so the test can configure each spawn
 * without writing temp files):
 *
 *   MOCK_CLAUDE_INIT_SESSION_ID   — session_id to emit in `system.init`
 *                                   (default: random uuid)
 *   MOCK_CLAUDE_INIT_DELAY_MS     — wait this many ms before emitting init
 *                                   (default: 0)
 *   MOCK_CLAUDE_NO_INIT           — if "1", never emit init (simulates a
 *                                   broken / slow runtime)
 *   MOCK_CLAUDE_EXIT_CODE         — exit code on stdin EOF or interrupt
 *                                   (default: 0)
 *   MOCK_CLAUDE_EXIT_AFTER_INIT_MS — exit this many ms after init (lets
 *                                   tests force a clean/crash exit)
 *   MOCK_CLAUDE_EMIT_TURN_END     — if "1", emit a `result/success` event
 *                                   right after init (simulates an idle
 *                                   turn boundary so flushPending fires)
 *   MOCK_CLAUDE_PROTOCOL_EVENT_DELAY_MS — emit a non-init stream-json frame
 *                                   after this many ms (protocol-ready only)
 *   MOCK_CLAUDE_STDERR_INTERVAL_MS — write stderr bytes on this interval
 *                                   (tests byte-liveness refresh)
 *   MOCK_CLAUDE_FAIL_FIRST_INITS   — if set with MOCK_CLAUDE_SPAWN_COUNT_FILE,
 *                                   suppress init for the first N spawns
 *   MOCK_CLAUDE_SPAWN_COUNT_FILE   — path used to count process spawns
 *   MOCK_CLAUDE_IGNORE_INTERRUPT   — if "1", do NOT exit on control_request
 *                                   (simulates a wedged CLI that ignores the
 *                                   driver-level interrupt; SIGTERM/SIGKILL
 *                                   must then be the actual stopper)
 *   MOCK_CLAUDE_STDIN_LOG         — append every received stdin line to
 *                                   this file path (one JSON line each)
 *   MOCK_CLAUDE_ARGV_LOG          — write process argv to this file path
 *                                   at startup (JSON array)
 *   MOCK_CLAUDE_ENV_LOG           — write selected process env vars to this
 *                                   file path at startup
 *
 * Stdin protocol: any line containing `"control_request"` causes the mock
 * to exit immediately with MOCK_CLAUDE_EXIT_CODE (default 0). Other lines
 * are logged but otherwise ignored.
 */

import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';

const env = process.env;
const exitCode = Number(env.MOCK_CLAUDE_EXIT_CODE ?? 0);
const stdinLog = env.MOCK_CLAUDE_STDIN_LOG ?? null;
const argvLog = env.MOCK_CLAUDE_ARGV_LOG ?? null;
const envLog = env.MOCK_CLAUDE_ENV_LOG ?? null;
let spawnOrdinal = 1;

if (argvLog) {
  try {
    writeFileSync(argvLog, JSON.stringify(process.argv.slice(2), null, 2));
  } catch {}
}

if (envLog) {
  try {
    writeFileSync(
      envLog,
      JSON.stringify(
        {
          PATH: env.PATH ?? null,
          SILVERHAND_CONVERSATION_ID: env.SILVERHAND_CONVERSATION_ID ?? null,
          SILVERHAND_AGENT_ID: env.SILVERHAND_AGENT_ID ?? null,
          SILVERHAND_SERVER_URL: env.SILVERHAND_SERVER_URL ?? null,
          SILVERHAND_AUTH_TOKEN: env.SILVERHAND_AUTH_TOKEN ?? null,
          AGENT_HUB_AUTH_TOKEN: env.AGENT_HUB_AUTH_TOKEN ?? null,
        },
        null,
        2,
      ),
    );
  } catch {}
}

if (env.MOCK_CLAUDE_SPAWN_COUNT_FILE) {
  try {
    const previous = Number(readFileSync(env.MOCK_CLAUDE_SPAWN_COUNT_FILE, 'utf-8') || 0);
    spawnOrdinal = previous + 1;
    writeFileSync(env.MOCK_CLAUDE_SPAWN_COUNT_FILE, String(spawnOrdinal));
  } catch {
    spawnOrdinal = 1;
    try {
      writeFileSync(env.MOCK_CLAUDE_SPAWN_COUNT_FILE, String(spawnOrdinal));
    } catch {}
  }
}

function emit(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

const initDelay = Number(env.MOCK_CLAUDE_INIT_DELAY_MS ?? 0);
const sessionId = env.MOCK_CLAUDE_INIT_SESSION_ID ?? `cli-${randomUUID()}`;
const failFirstInits = Number(env.MOCK_CLAUDE_FAIL_FIRST_INITS ?? 0);
const suppressInit = env.MOCK_CLAUDE_NO_INIT === '1' || spawnOrdinal <= failFirstInits;

if (env.MOCK_CLAUDE_PROTOCOL_EVENT_DELAY_MS !== undefined) {
  setTimeout(() => {
    emit({ type: 'system', subtype: 'status', status: 'warming' });
  }, Number(env.MOCK_CLAUDE_PROTOCOL_EVENT_DELAY_MS));
}

if (env.MOCK_CLAUDE_STDERR_INTERVAL_MS !== undefined) {
  setInterval(() => {
    process.stderr.write('warming\n');
  }, Number(env.MOCK_CLAUDE_STDERR_INTERVAL_MS)).unref();
}

if (!suppressInit) {
  setTimeout(() => {
    emit({ type: 'system', subtype: 'init', session_id: sessionId });
    if (env.MOCK_CLAUDE_EMIT_TURN_END === '1') {
      emit({ type: 'result', subtype: 'success', session_id: sessionId });
    }
    const exitAfter = env.MOCK_CLAUDE_EXIT_AFTER_INIT_MS;
    if (exitAfter !== undefined) {
      setTimeout(() => process.exit(exitCode), Number(exitAfter));
    }
  }, initDelay);
}

const rl = createInterface({ input: process.stdin });
rl.on('line', line => {
  if (stdinLog) {
    try {
      appendFileSync(stdinLog, line + '\n');
    } catch {}
  }
  if (line.includes('"control_request"')) {
    if (env.MOCK_CLAUDE_IGNORE_INTERRUPT === '1') {
      // Simulate a wedged CLI that ignores the driver interrupt.
      // The ConversationManager's SIGTERM/SIGKILL timers must handle shutdown.
      return;
    }
    // ack-then-exit so ConversationManager's hard-stop completes cleanly
    process.exit(exitCode);
  }
});
rl.on('close', () => {
  process.exit(exitCode);
});
