#!/usr/bin/env node
/*
 * Runtime fixture that proves the spawned child — not the test parent — can
 * execute the generated `silverhand` shim with its injected runtime bearer.
 * The driver decodes the single-line result marker and only then emits its
 * session_init projection.
 */
const { spawn } = require('node:child_process');

const args = process.argv.slice(2);
const sessionIndex = args.indexOf('--session-id');
const sessionId = sessionIndex >= 0 ? args[sessionIndex + 1] : '';
const marker = '__G2_CHILD_CLI_PROBE__:';

process.stdin.resume();

const cli = spawn(
  'silverhand',
  ['message', 'history', '--limit', '2', '--include-content'],
  {
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  },
);

let stdout = '';
let stderr = '';
let resultEmitted = false;
const emitResult = result => {
  if (resultEmitted) return;
  resultEmitted = true;
  process.stdout.write(marker + Buffer.from(JSON.stringify(result)).toString('base64') + '\n');
};
cli.stdout.on('data', chunk => {
  stdout += chunk.toString('utf8');
});
cli.stderr.on('data', chunk => {
  stderr += chunk.toString('utf8');
});
cli.on('error', error => {
  emitResult({
    sessionId,
    code: null,
    stdout,
    stderr,
    error: error instanceof Error ? error.message : String(error),
  });
});
cli.on('close', code => {
  emitResult({ sessionId, code, stdout, stderr, error: null });
});

setTimeout(() => process.exit(0), 60_000);
