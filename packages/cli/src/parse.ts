/**
 * Tiny argv parser. We deliberately avoid commander/yargs because:
 *  - the surface is small and predictable (CLI is generated from a
 *    fixed catalogue of subcommands);
 *  - smaller bundle = faster cold start, which matters because the CLI
 *    is invoked once per agent action;
 *  - we want first-class JSON error output, not yargs's "Did you
 *    mean...?" interactive feel.
 *
 * Supports:
 *   --flag value         → flags["flag"] = "value"
 *   --flag=value         → flags["flag"] = "value"
 *   --flag               → flags["flag"] = true (boolean flag)
 *   --no-flag            → flags["flag"] = false
 *   --multi a --multi b  → flags["multi"] = ["a", "b"]
 *   positional args before/after flags collected in `positional`
 *   `--`                 → everything after goes verbatim into `rest`
 */

export interface ParsedArgs {
  positional: string[];
  flags: Record<string, string | boolean | string[]>;
  rest: string[];
}

export interface ParseOptions {
  /** Names that should always be parsed as boolean (no value consumed
   *  even if the next token doesn't start with `--`). Useful for flags
   *  like `--posted-to-parent` that shouldn't accidentally swallow the
   *  next positional argument. */
  booleanFlags?: readonly string[];
}

export function parseArgs(argv: string[], opts: ParseOptions = {}): ParsedArgs {
  const positional: string[] = [];
  const flags: Record<string, string | boolean | string[]> = {};
  const rest: string[] = [];
  const booleans = new Set(opts.booleanFlags ?? []);

  let i = 0;
  while (i < argv.length) {
    const arg = argv[i]!;
    if (arg === '--') {
      rest.push(...argv.slice(i + 1));
      break;
    }
    if (arg.startsWith('--')) {
      let key = arg.slice(2);
      let value: string | undefined;
      const eq = key.indexOf('=');
      if (eq >= 0) {
        value = key.slice(eq + 1);
        key = key.slice(0, eq);
      }
      if (key.startsWith('no-') && value === undefined) {
        flags[key.slice(3)] = false;
        i += 1;
        continue;
      }
      if (value === undefined) {
        const next = argv[i + 1];
        const looksLikeValue =
          !booleans.has(key) && next !== undefined && !next.startsWith('--');
        if (looksLikeValue) {
          value = next;
          i += 2;
        } else {
          flags[key] = true;
          i += 1;
          continue;
        }
      } else {
        i += 1;
      }
      const existing = flags[key];
      if (Array.isArray(existing)) {
        existing.push(value);
      } else if (typeof existing === 'string') {
        flags[key] = [existing, value];
      } else {
        flags[key] = value;
      }
      continue;
    }
    positional.push(arg);
    i += 1;
  }
  return { positional, flags, rest };
}

/** Read a flag as a string. Returns undefined when missing.
 *  Throws when the flag was set as a boolean (caller passed `--flag`
 *  expecting a value). */
export function flagString(args: ParsedArgs, name: string): string | undefined {
  const v = args.flags[name];
  if (v === undefined) return undefined;
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) return v[v.length - 1]; // last-wins for repeats
  throw new Error(`flag --${name} expects a value`);
}

/** Read a flag as a boolean. Bare `--flag` is true; `--no-flag` is false.
 *  Returns undefined when missing so the caller can pick a default. */
export function flagBool(args: ParsedArgs, name: string): boolean | undefined {
  const v = args.flags[name];
  if (v === undefined) return undefined;
  if (typeof v === 'boolean') return v;
  if (v === 'true') return true;
  if (v === 'false') return false;
  throw new Error(`flag --${name} expects no value (use --${name} or --no-${name})`);
}

/** Read a flag as a number. Throws on non-numeric input. */
export function flagNumber(args: ParsedArgs, name: string): number | undefined {
  const s = flagString(args, name);
  if (s === undefined) return undefined;
  const n = Number(s);
  if (!Number.isFinite(n)) {
    throw new Error(`flag --${name} expects a number, got ${JSON.stringify(s)}`);
  }
  return n;
}

/** Read a flag as a string array (each occurrence appends). */
export function flagStringArray(args: ParsedArgs, name: string): string[] | undefined {
  const v = args.flags[name];
  if (v === undefined) return undefined;
  if (Array.isArray(v)) return v.slice();
  if (typeof v === 'string') return [v];
  throw new Error(`flag --${name} expects a value`);
}

/** Read a flag as a number array. */
export function flagNumberArray(args: ParsedArgs, name: string): number[] | undefined {
  const arr = flagStringArray(args, name);
  if (arr === undefined) return undefined;
  return arr.map(s => {
    const n = Number(s);
    if (!Number.isFinite(n)) {
      throw new Error(`flag --${name} expects numbers, got ${JSON.stringify(s)}`);
    }
    return n;
  });
}
