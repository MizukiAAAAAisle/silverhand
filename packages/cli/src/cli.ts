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
import { BackendClient } from './client.js';
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

void main(process.argv.slice(2)).then(
  code => {
    process.exit(code);
  },
  err => {
    const cliErr = fromUnknown(err);
    writeError(cliErr, { json: true });
    process.exit(exitCodeFor(cliErr.code));
  },
);
