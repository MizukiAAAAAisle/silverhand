/**
 * Maps each agent-facing internal route under
 * `/internal/conversations/:cid/agents/:aid/...` to the corresponding
 * `silverhand <noun> <verb>` CLI surface.
 *
 * Used by the cli-invoke middleware (`cli-invoke-middleware.ts`) to tag
 * every observed CLI call with a `(noun, verb)` pair so `cli-*.log`
 * lines can be filtered/aggregated by command.
 *
 * The 18 entries here are intentionally locked by a drift-guard test
 * (`packages/backend/tests/observability/cli-route-map.test.ts`):
 *   - every `(noun, verb)` must exist in `COMMAND_GROUPS`, and
 *   - every internal route exposed by `internalPaths` (minus the
 *     observability-only `agentCliTrace`) must have a mapping.
 *
 * Add a new internal route → add it here AND in `internalPaths`. The
 * test will fail loudly otherwise.
 */
export interface CliInvokeRoute {
  /** HTTP method as registered with Hono. */
  method: 'GET' | 'POST';
  /** Path suffix after `/internal/conversations/:cid/agents/:aid/`. */
  suffix: string;
  /** Logical CLI surface this route serves. */
  noun: string;
  verb: string;
}

/**
 * The `:attachmentId` parameter on the locate-attachment route is
 * collapsed to a literal `*` in the suffix because the middleware
 * matches by prefix; the actual attachment id never leaves the URL
 * (and we don't want to log it as flag-style data).
 */
export const CLI_INVOKE_ROUTES: readonly CliInvokeRoute[] = [
  // message
  { method: 'POST', suffix: 'send-message', noun: 'message', verb: 'send' },
  { method: 'POST', suffix: 'read-history', noun: 'message', verb: 'history' },
  { method: 'POST', suffix: 'search-messages', noun: 'message', verb: 'search' },
  // task
  { method: 'GET', suffix: 'tasks', noun: 'task', verb: 'list' },
  { method: 'POST', suffix: 'tasks/create', noun: 'task', verb: 'create' },
  { method: 'POST', suffix: 'tasks/claim', noun: 'task', verb: 'claim' },
  { method: 'POST', suffix: 'tasks/unclaim', noun: 'task', verb: 'unclaim' },
  { method: 'POST', suffix: 'tasks/update-status', noun: 'task', verb: 'status' },
  // thread
  { method: 'POST', suffix: 'create-thread', noun: 'thread', verb: 'create' },
  { method: 'POST', suffix: 'close-thread', noun: 'thread', verb: 'close' },
  // channel
  { method: 'POST', suffix: 'create-channel', noun: 'channel', verb: 'create' },
  { method: 'GET', suffix: 'list-channels', noun: 'channel', verb: 'list' },
  // workspace
  { method: 'GET', suffix: 'list-workspaces', noun: 'workspace', verb: 'list' },
  // schedule
  { method: 'POST', suffix: 'schedules', noun: 'schedule', verb: 'create' },
  // POST (not GET) — `schedules/list` posts a JSON filter body, mirrors
  // `search-messages`/`read-history`. The drift-guard test below parses
  // `routes.ts` to verify this method matches the actual registration.
  { method: 'POST', suffix: 'schedules/list', noun: 'schedule', verb: 'list' },
  { method: 'POST', suffix: 'schedules/cancel', noun: 'schedule', verb: 'cancel' },
  // file
  { method: 'POST', suffix: 'attachments', noun: 'file', verb: 'upload' },
  // attachments/:id/locate — middleware matches by prefix `attachments/`
  // + suffix `/locate`; we record it as a single entry.
  { method: 'GET', suffix: 'attachments/*/locate', noun: 'file', verb: 'view' },
];

/**
 * Look up the CLI surface for an inbound internal request. Returns
 * `null` for paths that aren't part of the agent-CLI family (notably
 * the cli-trace endpoint, which is logged separately as
 * `cli.preflight_failure` and excluded from invoke stats).
 *
 * `routeSuffix` is the *pattern* the actual suffix matched, never the
 * raw URL path. For routes that contain a wildcard segment
 * (`attachments/<wildcard>/locate`) this lets the caller log the
 * normalized pattern instead of the actual id segment so attachment
 * ids never leak into `cli-<utc>.log`.
 */
export function lookupCliRoute(
  method: string,
  suffix: string,
): { noun: string; verb: string; routeSuffix: string } | null {
  for (const r of CLI_INVOKE_ROUTES) {
    if (r.method !== method) continue;
    if (suffixMatches(r.suffix, suffix)) {
      return { noun: r.noun, verb: r.verb, routeSuffix: r.suffix };
    }
  }
  return null;
}

function suffixMatches(pattern: string, actual: string): boolean {
  if (!pattern.includes('*')) return pattern === actual;
  // Single `*` segment match (e.g. `attachments/*/locate`).
  const re = new RegExp(
    '^' + pattern.split('*').map(escapeRegex).join('[^/]+') + '$',
  );
  return re.test(actual);
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
