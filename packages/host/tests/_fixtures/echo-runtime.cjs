#!/usr/bin/env node
/*
 * RealSupervisor 3a test fixture — a tiny "runtime binary" the host
 * supervisor can spawn to validate spawn / output-pump / hard-stop /
 * exit behavior without depending on a real claude / codex / cursor
 * install.
 *
 * Behavior (driven by argv to keep the script trivially configurable):
 *
 *   node echo-runtime.cjs [--echo TEXT] [--echo-stderr TEXT]
 *                         [--sleep MS] [--ignore-sigterm]
 *
 *  --echo TEXT          write TEXT + '\n' to stdout, then keep running.
 *  --echo-stderr TEXT   write TEXT + '\n' to stderr, then keep running.
 *  --sleep MS           keep the process alive at least MS milliseconds
 *                       before voluntarily exiting (0).
 *  --ignore-sigterm     install a SIGTERM handler that logs but does
 *                       not exit, forcing the supervisor's SIGKILL
 *                       escalation path. Default: SIGTERM exits 143.
 *
 * Always reads stdin (so closing the pipe doesn't kill us); never
 * parses or responds. The supervisor is the only thing closing this
 * process.
 */
const args = process.argv.slice(2);
let sleepMs = 60_000; // 60s default — long enough for any test to finish before timeout
let ignoreSigterm = false;
const toEcho = [];

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
  } else if (a === '--ignore-sigterm') {
    ignoreSigterm = true;
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

// Keep stdin readable so the parent doesn't lose its write side; we
// don't actually do anything with the bytes (3b will exercise that).
process.stdin.on('data', () => {});
process.stdin.resume();

// Ready handshake — tests wait for this line on stdout before issuing
// the next action (stop, send, etc.) so they don't race the child's
// startup window.
process.stdout.write('READY\n');

for (const { stream, text } of toEcho) {
  (stream === 'stderr' ? process.stderr : process.stdout).write(text + '\n');
}

// Voluntary exit after `--sleep` so tests that DON'T issue a stop
// still see a clean exit (with `intentional:false`, i.e. crashed).
setTimeout(() => process.exit(0), sleepMs);
