/**
 * stdout writer. Always emits one-line JSON in v1 (the prompt
 * contract says "default JSON"). Kept tiny on purpose — the CLI is
 * expected to round-trip through bash and into the agent, and a
 * single line of JSON is the easiest shape to parse with jq / awk.
 */

export interface StdOut {
  write(s: string): unknown;
}

export function writeJson(value: unknown, out: StdOut = process.stdout): void {
  out.write(JSON.stringify(value) + '\n');
}
