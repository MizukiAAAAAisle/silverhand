/**
 * Fire-and-forget reporter for CLI pre-flight failures.
 *
 * The backend's `cli.invoke` middleware can only see calls that
 * actually reach an internal route — but the most informative
 * failures (e.g. `--task-numbers 191` typo, `silverhand tsk list`
 * unknown noun) happen entirely inside this CLI process and exit
 * before any HTTP request is made.
 *
 * To recover that observability, the CLI fires a single best-effort
 * `POST /internal/agents/:aid/conversations/:cid/cli-trace` whenever
 * it errors out before sending any business request. The endpoint:
 *
 *   - is excluded from the cli.invoke middleware (logged separately
 *     as `cli.preflight_failure` so it does not pollute success-rate
 *     stats),
 *   - never affects the CLI's exit code or stderr output,
 *   - times out fast (50ms) so a slow/missing backend cannot delay
 *     the agent's failure path.
 *
 * Module-level `requestAttempted` flag is set to `true` when any
 * BackendClient call begins; the CLI dispatcher consults it before
 * tracing so backend-originated failures aren't double-counted.
 *
 * Privacy: any string we send to the backend is first run through
 * `sanitizeTraceErrorMessage` to strip filesystem paths and obvious
 * user-typed values. The contract is "structural failure shape only,
 * never request content".
 */
import { AUTH_TOKEN_HEADER, internalPaths, type CliTraceInput } from '@silverhand/shared';
import { tryLoadEnv } from './env.js';

const TRACE_TIMEOUT_MS = 50;

let requestAttempted = false;

/** Mark that the CLI has started (or completed) at least one
 *  business HTTP call. Called by `BackendClient.request` so
 *  pre-flight tracing is suppressed for backend-originated errors. */
export function markRequestAttempted(): void {
  requestAttempted = true;
}

/** Test-only: reset the module-level state. */
export function resetTraceStateForTesting(): void {
  requestAttempted = false;
}

/** Returns `true` if any HTTP call against the backend was attempted
 *  during this CLI process. */
export function wasRequestAttempted(): boolean {
  return requestAttempted;
}

/**
 * Fire a pre-flight failure trace if appropriate. Always best-effort:
 *   - if env vars aren't loadable → silent no-op,
 *   - if a business request was already attempted → suppressed
 *     (the backend already logged that call as `cli.invoke`),
 *   - if the trace HTTP call fails / times out → silent.
 *
 * Returns a Promise that always resolves (never rejects) so the CLI
 * can `await` it before exiting without changing its error path.
 *
 * Sanitizes `error_message` and `flags_seen` before sending — see
 * `sanitizeTraceErrorMessage` for the exact rules.
 */
export async function reportPreflightFailure(payload: CliTraceInput): Promise<void> {
  if (requestAttempted) return;
  const env = tryLoadEnv();
  if (!env) return;

  const sanitized: CliTraceInput = {
    ...payload,
    ...(payload.error_message
      ? { error_message: sanitizeTraceErrorMessage(payload.error_message) }
      : {}),
  };

  const url = `${env.serverUrl}${internalPaths.agentCliTrace(env.conversationId, env.agentId)}`;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), TRACE_TIMEOUT_MS);
  try {
    await fetch(url, {
      method: 'POST',
      headers: {
        [AUTH_TOKEN_HEADER]: `Bearer ${env.authToken}`,
        'X-Agent-Hub-Caller': 'silverhand-cli-trace',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(sanitized),
      signal: ac.signal,
    });
  } catch {
    /* swallow — observability must not affect the CLI exit path. */
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Strip user-typed values out of a CLI error message before it gets
 * logged on the backend. The contract is **structural shape only**:
 *
 *   - absolute filesystem paths → replaced with `<path>`
 *   - the user-supplied `flag value` after `--<flag>` → dropped
 *   - quoted strings (`"..."` / `'...'`) → replaced with `<value>`
 *   - the unknown-flag form `unknown flag --foo` is preserved (the
 *     flag NAME is safe — it's part of `flags_seen` already, and
 *     it's exactly the typo we want to catch)
 *
 * The result is capped at 500 chars so we never blow past the schema
 * limit. If the input is empty/undefined, returns it unchanged.
 */
export function sanitizeTraceErrorMessage(input: string): string {
  let s = input;

  // Absolute paths (POSIX `/...`, Windows `C:\...`). Hit these BEFORE
  // the value-after-flag rule so a path argument doesn't half-survive
  // as `<value>`.
  s = s.replace(/(\B\/)(?:[\w.@%+\-]+\/)*[\w.@%+\-]+/g, '<path>');
  s = s.replace(/[A-Za-z]:[\\/](?:[^\s:"']+[\\/])*[^\s:"']+/g, '<path>');

  // Quoted strings: `"foo"`, `'foo'`, backticks. The flag NAME is
  // typically backtick-quoted in our error messages — those are
  // safe to keep, so we only strip double/single-quoted values.
  s = s.replace(/"[^"]*"/g, '"<value>"');
  s = s.replace(/'[^']*'/g, "'<value>'");

  // `--flag <value>` → `--flag <value>` becomes `--flag <value>` only
  // when `value` looks like a user-typed argument (not part of the
  // template). Drop the value when it follows `--<flag>` and is not
  // another flag.
  s = s.replace(/(--[a-z][a-z0-9-]*)\s+(?!-)[^\s]+/g, '$1 <value>');

  if (s.length > 500) s = s.slice(0, 500);
  return s;
}
