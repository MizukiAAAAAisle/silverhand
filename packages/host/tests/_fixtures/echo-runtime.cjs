#!/usr/bin/env node
/*
 * Supervisor 3a/3b test fixture — a tiny "runtime binary" the
 * host supervisor can spawn to validate spawn / output-pump /
 * hard-stop / exit / stdin-write behavior without depending on a
 * real claude / codex / cursor install.
 *
 * Behavior (driven by argv to keep the script trivially configurable):
 *
 *   node echo-runtime.cjs [--echo TEXT] [--echo-stderr TEXT]
 *                         [--sleep MS] [--ignore-sigterm]
 *                         [--echo-stdin] [--emit-line LINE]
 *
 *  --echo TEXT          write TEXT + '\n' to stdout, then keep running.
 *  --echo-stderr TEXT   write TEXT + '\n' to stderr, then keep running.
 *  --sleep MS           keep the process alive at least MS milliseconds
 *                       before voluntarily exiting (0).
 *  --exit-code N        voluntary-exit with code N instead of 0. Used by
 *                       D4 e2e tests to simulate an unintentional crash
 *                       (non-zero + supervisor-didn't-stop → 'crashed').
 *  --ignore-sigterm     install a SIGTERM handler that logs but does
 *                       not exit, forcing the supervisor's SIGKILL
 *                       escalation path. Default: SIGTERM exits 143.
 *  --echo-stdin         for each line received on stdin, write
 *                       "STDIN:<line>\n" to stdout. Lets supervisor
 *                       3b tests verify wake() / soft-stop /
 *                       startup_delivery actually reached the child.
 *  --emit-line LINE     write LINE + '\n' to stdout. May be repeated.
 *                       Used by 3b tests to drive parsed-event fanout
 *                       with a custom driver parseLine.
 *
 * Always reads stdin (so closing the pipe doesn't kill us); responds
 * only when `--echo-stdin` is set. The supervisor is the only thing
 * closing this process.
 */
const args = process.argv.slice(2);
let sleepMs = 60_000; // 60s default — long enough for any test to finish before timeout
let exitCode = 0;
let ignoreSigterm = false;
let echoStdin = false;
const toEcho = [];
const emitLines = [];

for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--echo') {
    const v = args[++i] ?? '';
    toEcho.push({ stream: 'stdout', text: v });
  } else if (a === '--echo-stderr') {
    const v = args[++i] ?? '';
    toEcho.push({ stream: 'stderr', text: v });
  } else if (a === '--sleep') {
    sleepMs = Number(args[++i] ?? '60000');
  } else if (a === '--exit-code') {
    exitCode = Number(args[++i] ?? '0');
  } else if (a === '--ignore-sigterm') {
    ignoreSigterm = true;
  } else if (a === '--echo-stdin') {
    echoStdin = true;
  } else if (a === '--emit-line') {
    emitLines.push(args[++i] ?? '');
  }
}

// Install the SIGTERM trap BEFORE writing the READY line so the test
// is guaranteed (once it sees READY) that signals will be handled
// correctly. Without this, a SIGTERM that arrives during node's
// startup window would kill the process before the handler exists.
if (ignoreSigterm) {
  process.on('SIGTERM', () => {
    // Deliberately do nothing — exercises supervisor's SIGKILL escalation.
  });
}

// Keep stdin readable so the parent doesn't lose its write side. When
// --echo-stdin is set, line-buffer stdin and echo each line prefixed
// with STDIN:. The newline boundary matches the supervisor's
// stdin-write contract (one stream-json line per write).
let stdinBuffer = '';
process.stdin.on('data', (chunk) => {
  if (!echoStdin) return;
  stdinBuffer += chunk.toString('utf-8');
  let nl = stdinBuffer.indexOf('\n');
  while (nl !== -1) {
    const line = stdinBuffer.slice(0, nl);
    stdinBuffer = stdinBuffer.slice(nl + 1);
    process.stdout.write(`STDIN:${line}\n`);
    nl = stdinBuffer.indexOf('\n');
  }
});
process.stdin.resume();

// Ready handshake — tests wait for this line on stdout before issuing
// the next action (stop, send, etc.) so they don't race the child's
// startup window.
process.stdout.write('READY\n');

for (const { stream, text } of toEcho) {
  (stream === 'stderr' ? process.stderr : process.stdout).write(text + '\n');
}
for (const line of emitLines) {
  process.stdout.write(line + '\n');
}

// Voluntary exit after `--sleep` so tests that DON'T issue a stop
// still see a clean exit (with `intentional:false`, i.e. crashed).
// `--exit-code N` lets the test choose 0 (idle on the projector's
// `code === 0` arm) or non-zero (crashed on the projector's
// "otherwise" arm).
setTimeout(() => process.exit(exitCode), sleepMs);
