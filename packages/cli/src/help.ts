/**
 * Help text generators. All output goes to stdout (since `--help` is
 * not a failure) so agents can capture it via normal stdout redirection.
 */
import { COMMAND_GROUPS, findCommand, findGroup } from './commands/index.js';

const VERSION = '0.0.0';

export function topLevelHelp(): string {
  const lines: string[] = [];
  lines.push(`silverhand ${VERSION}`);
  lines.push('');
  lines.push('Usage: silverhand <noun> <verb> [flags...]');
  lines.push('');
  lines.push('All chat, task, schedule, history, thread, channel, workspace,');
  lines.push('and file actions for spawned Silverhand agents. The CLI is already');
  lines.push('configured for the current session; do not pass connection details');
  lines.push('as flags.');
  lines.push('');
  lines.push('Output: machine-readable JSON on stdout. (--json is the default and');
  lines.push('is accepted as a no-op on every subcommand.)');
  lines.push('Errors: one-line JSON on stderr ({ "error": { code, message,');
  lines.push('        retriable } }) plus a non-zero exit code:');
  lines.push('  1 = user/input error  (do not retry)');
  lines.push('  2 = transient         (may retry with backoff)');
  lines.push('  3 = fatal             (stop and report)');
  lines.push('');
  lines.push('Nouns:');
  for (const g of COMMAND_GROUPS) {
    lines.push(`  ${g.noun.padEnd(10)} ${g.summary}`);
  }
  lines.push('');
  lines.push('Run `silverhand <noun> --help` to list verbs.');
  lines.push('Run `silverhand <noun> <verb> --help` for flag-level usage.');
  return lines.join('\n');
}

export function nounHelp(noun: string): string | null {
  const group = findGroup(noun);
  if (!group) return null;
  const lines: string[] = [];
  lines.push(`silverhand ${noun} — ${group.summary}`);
  lines.push('');
  lines.push('Verbs:');
  for (const c of group.commands) {
    lines.push(`  ${c.verb.padEnd(10)} ${c.summary}`);
  }
  lines.push('');
  lines.push(`Run \`silverhand ${noun} <verb> --help\` for flag-level usage.`);
  return lines.join('\n');
}

export function verbHelp(noun: string, verb: string): string | null {
  const cmd = findCommand(noun, verb);
  if (!cmd) return null;
  return cmd.help;
}
