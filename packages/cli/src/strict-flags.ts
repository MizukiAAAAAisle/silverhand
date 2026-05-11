/**
 * Strict flag validation for the CLI dispatcher.
 *
 * Each `Command` declares the flags it accepts (`flags` for value-bearing,
 * `booleanFlags` for switches). After argv parsing, the dispatcher calls
 * `assertKnownFlags` to reject any flag the command did NOT declare —
 * with a `did-you-mean` suggestion when the typo is within edit distance
 * 2 of a known flag.
 *
 * This is the answer to the original footgun where an agent typed
 * `--task-numbers 191` (typo for `--task-number`), the parser silently
 * accepted it, the route ignored it, and the agent received the full
 * 100KB task board back. Strict mode turns that into an immediate
 * `validation_error` exit code 1.
 */
import { CliError } from './errors.js';

export interface StrictFlagOptions {
  noun: string;
  verb: string;
  flags?: readonly string[];
  booleanFlags?: readonly string[];
}

/**
 * Global flags handled by the dispatcher rather than any individual
 * command. They are accepted on every subcommand as transparent no-ops
 * so agents (and the platform prompt) can rely on `--json` without each
 * command having to redeclare it.
 */
export const GLOBAL_NOOP_FLAGS: ReadonlySet<string> = new Set(['json']);

/** Throw `CliError` with code `validation_error` if any observed flag
 *  isn't in the union of `flags ∪ booleanFlags ∪ GLOBAL_NOOP_FLAGS`.
 *  Otherwise return. */
export function assertKnownFlags(
  observed: Record<string, unknown>,
  opts: StrictFlagOptions,
): void {
  const known = new Set<string>([
    ...(opts.flags ?? []),
    ...(opts.booleanFlags ?? []),
    ...GLOBAL_NOOP_FLAGS,
  ]);
  const unknown = Object.keys(observed).filter(k => !known.has(k));
  if (unknown.length === 0) return;
  const flag = unknown[0]!;
  const suggestion = closestFlag(flag, known);
  const hint = suggestion
    ? `did you mean --${suggestion}?`
    : `run \`silverhand ${opts.noun} ${opts.verb} --help\` for accepted flags`;
  const tail =
    unknown.length > 1
      ? ` (also unrecognized: ${unknown.slice(1).map(f => `--${f}`).join(', ')})`
      : '';
  throw new CliError({
    code: 'validation_error',
    message: `unknown flag --${flag}; ${hint}${tail}`,
    retriable: false,
  });
}

/** Return the closest known flag name within edit distance ≤ 2, or null. */
export function closestFlag(input: string, known: ReadonlySet<string>): string | null {
  let best: { name: string; distance: number } | null = null;
  for (const candidate of known) {
    const d = levenshtein(input, candidate);
    if (d <= 2 && (!best || d < best.distance)) {
      best = { name: candidate, distance: d };
    }
  }
  return best?.name ?? null;
}

/** Iterative Levenshtein distance. Two-row variant — O(min(a.length, b.length))
 *  memory. Plenty fast for flag-name comparison. */
export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  let prev = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j += 1) prev[j] = j;
  for (let i = 1; i <= a.length; i += 1) {
    const cur = new Array<number>(b.length + 1);
    cur[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
      cur[j] = Math.min(cur[j - 1]! + 1, prev[j]! + 1, prev[j - 1]! + cost);
    }
    prev = cur;
  }
  return prev[b.length]!;
}
