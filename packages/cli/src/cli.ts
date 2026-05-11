#!/usr/bin/env node
/**
 * `silverhand` CLI entry. Dispatch is fixed two-level:
 *   silverhand <noun> <verb> [flags...]
 *
 * Phase 1 boundary: this CLI only talks to the backend's
 * `/internal/conversations/:cid/agents/:aid/...` route family. It does
 * not touch SQLite (no native deps, no ABI swap), does not serve as a
 * long-lived process, and does not coordinate with runtime drivers.
 */
import { performance } from 'node:perf_hooks';
import { BackendClient } from './client.js';
import { reportPreflightFailure, wasRequestAttempted } from './cli-trace.js';
import { findCommand, findGroup } from './commands/index.js';
import { loadEnv } from './env.js';
import {
  CliError,
  exitCodeFor,
  fromUnknown,
  writeError,
} from './errors.js';
import { nounHelp, topLevelHelp, verbHelp } from './help.js';
import { writeJson } from './output.js';
import { parseArgs } from './parse.js';
import { assertKnownFlags } from './strict-flags.js';

/**
 * Per-process trace context populated as the dispatcher resolves
 * noun → verb → flags. The error handler reads this so the
 * `cli.preflight_failure` payload is as informative as possible
 * (typo telemetry should always show what the agent actually typed).
 */
interface TraceContext {
  noun?: string;
  verb?: string;
  flagsSeen?: string[];
}
const traceCtx: TraceContext = {};

async function main(argv: string[]): Promise<number> {
  // Top-level help / version handling. These never need env, so they
  // run before `loadEnv` to keep `silverhand --help` usable in any
  // shell, regardless of whether the SILVERHAND_* vars are set.
  if (argv.length === 0 || argv[0] === '--help' || argv[0] === '-h') {
    process.stdout.write(topLevelHelp() + '\n');
    return 0;
  }
  if (argv[0] === '--version' || argv[0] === '-V') {
    process.stdout.write('silverhand 0.0.0\n');
    return 0;
  }

  const noun = argv[0]!;
  traceCtx.noun = noun;
  const group = findGroup(noun);
  if (!group) {
    throw new CliError({
      code: 'validation_error',
      message: `unknown noun "${noun}"; run \`silverhand --help\` for available nouns`,
      retriable: false,
    });
  }

  // `silverhand <noun>` or `silverhand <noun> --help` → list verbs.
  if (argv.length === 1 || argv[1] === '--help' || argv[1] === '-h') {
    const help = nounHelp(noun);
    if (!help) {
      throw new CliError({
        code: 'validation_error',
        message: `no help for noun "${noun}"`,
        retriable: false,
      });
    }
    process.stdout.write(help + '\n');
    return 0;
  }

  const verb = argv[1]!;
  traceCtx.verb = verb;
  const cmd = findCommand(noun, verb);
  if (!cmd) {
    throw new CliError({
      code: 'validation_error',
      message: `unknown verb "${verb}" under noun "${noun}"; run \`silverhand ${noun} --help\``,
      retriable: false,
    });
  }

  // `silverhand <noun> <verb> --help` → command help.
  const tail = argv.slice(2);
  if (tail.includes('--help') || tail.includes('-h')) {
    const help = verbHelp(noun, verb);
    if (help) process.stdout.write(help + '\n');
    return 0;
  }

  const args = parseArgs(tail, { booleanFlags: cmd.booleanFlags });
  traceCtx.flagsSeen = Object.keys(args.flags).sort();

  // Strict flag validation: reject any flag the command did not declare.
  // We do this AFTER parseArgs so the parser still records every observed
  // flag — that way the dispatcher can produce a meaningful "unknown flag"
  // error including a did-you-mean suggestion. Without this step, an
  // unknown flag like `--task-numbers 191` (typo for `--task-number`) is
  // silently dropped and the agent thinks it filtered when it didn't.
  // Global flags (e.g. `--json`) are accepted transparently inside
  // `assertKnownFlags` itself.
  assertKnownFlags(args.flags, {
    noun,
    verb,
    flags: cmd.flags,
    booleanFlags: cmd.booleanFlags,
  });

  // Lazy: only load env when we're actually about to make a request.
  // Help/version never reach this line.
  const env = loadEnv();
  const client = new BackendClient(env);
  const result = await cmd.run({ env, client, args });
  if (result !== undefined && result !== null) {
    writeJson(result);
  }
  return 0;
}

const startedAt = performance.now();
void main(process.argv.slice(2)).then(
  code => {
    process.exit(code);
  },
  async err => {
    const cliErr = fromUnknown(err);
    writeError(cliErr, { json: true });
    // Best-effort: tell the backend about a CLI-side failure that
    // never reached an internal route, so `cli-*.log` shows the
    // typo / missing-flag pattern. Suppressed when a business
    // request was already attempted (the backend has its own
    // `cli.invoke` line for that case).
    if (!wasRequestAttempted()) {
      await reportPreflightFailure({
        noun: traceCtx.noun,
        verb: traceCtx.verb,
        flags_seen: traceCtx.flagsSeen,
        error_code: cliErr.code,
        error_message: cliErr.message.split('\n', 1)[0]?.slice(0, 500),
        duration_ms: Math.round((performance.now() - startedAt) * 1000) / 1000,
      });
    }
    process.exit(exitCodeFor(cliErr.code));
  },
);
