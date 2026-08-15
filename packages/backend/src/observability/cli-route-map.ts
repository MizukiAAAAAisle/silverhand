/**
 * Maps each agent-facing internal route under
 * `/internal/agents/:aid/...` to the corresponding
 * `silverhand <noun> <verb>` CLI surface.
 *
 * Used by the cli-invoke middleware (`cli-invoke-middleware.ts`) to tag
 * every observed CLI call with a `(noun, verb)` pair so `cli-*.log`
 * lines can be filtered/aggregated by command.
 *
 * The agent-facing command tree originates in the shared discovery manifest,
 * which the CLI binds into `COMMAND_GROUPS`. The entries here are then locked
 * to that bound tree by a drift-guard test
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
  method: 'GET' | 'POST' | 'PATCH';
  /** Path suffix after `/internal/agents/:aid/`. */
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
  { method: 'POST', suffix: 'stale-message-resolution', noun: 'message', verb: 'stale-resolve' },
  // react-message is registered as both POST (add) and DELETE (remove); the
  // map models one method per route and the middleware tags the add path.
  { method: 'POST', suffix: 'react-message', noun: 'message', verb: 'react' },
  { method: 'POST', suffix: 'read-history', noun: 'message', verb: 'history' },
  { method: 'POST', suffix: 'search-messages', noun: 'message', verb: 'search' },
  // task
  { method: 'GET', suffix: 'tasks', noun: 'task', verb: 'list' },
  { method: 'POST', suffix: 'tasks/create', noun: 'task', verb: 'create' },
  { method: 'POST', suffix: 'tasks/claim', noun: 'task', verb: 'claim' },
  { method: 'POST', suffix: 'tasks/unclaim', noun: 'task', verb: 'unclaim' },
  { method: 'POST', suffix: 'tasks/update-status', noun: 'task', verb: 'status' },
  { method: 'POST', suffix: 'tasks/edit', noun: 'task', verb: 'edit' },
  { method: 'GET', suffix: 'tasks/detail', noun: 'task', verb: 'detail' },
  // thread
  { method: 'POST', suffix: 'follow-thread', noun: 'thread', verb: 'follow' },
  { method: 'POST', suffix: 'unfollow-thread', noun: 'thread', verb: 'unfollow' },
  // channel
  { method: 'POST', suffix: 'create-channel', noun: 'channel', verb: 'create' },
  { method: 'GET', suffix: 'list-channels', noun: 'channel', verb: 'list' },
  // member
  { method: 'POST', suffix: 'members', noun: 'member', verb: 'add' },
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
  // attachments/:attachmentId — in-place content update (creator-only
  // pointer-swap). PATCH; the id is a trailing wildcard segment, normalized
  // away like the locate/download ids so it never lands in `cli-<utc>.log`.
  { method: 'PATCH', suffix: 'attachments/*', noun: 'file', verb: 'update' },
  // attachments/:id/locate — middleware matches by prefix `attachments/`
  // + suffix `/locate`; we record it as a single entry.
  { method: 'GET', suffix: 'attachments/*/locate', noun: 'file', verb: 'view' },
  // attachments/:id/download — implementation subrequest for `file view`
  // remote fallback. Same CLI surface; id is normalized away.
  { method: 'GET', suffix: 'attachments/*/download', noun: 'file', verb: 'view' },
  // profile (3-level: `silverhand profile mcp <verb>`). GET and POST share
  // one suffix; the middleware tags by method (read vs replace). `validate`
  // is CLI-local (no backend route), so it has no entry here. `probe` is a
  // distinct sub-suffix (live one-shot connection, #task:1137).
  { method: 'GET', suffix: 'profile/mcp', noun: 'profile', verb: 'mcp get' },
  { method: 'POST', suffix: 'profile/mcp', noun: 'profile', verb: 'mcp set' },
  { method: 'POST', suffix: 'profile/mcp/probe', noun: 'profile', verb: 'mcp probe' },
  // profile metadata (flat: `silverhand profile get|update`, #task:1178).
  // GET reads, POST applies the whole edit (text + avatar) in one multipart
  // request. Same `profile` suffix, tagged by method — matched AFTER the
  // longer `profile/mcp*` suffixes so the facet routes win their paths.
  { method: 'GET', suffix: 'profile', noun: 'profile', verb: 'get' },
  { method: 'POST', suffix: 'profile', noun: 'profile', verb: 'update' },
  // peer-profile — the SAME CLI verb (`profile get --handle <name>`) reading a
  // second subject, so it is tagged `profile get` too; the logged
  // `routeSuffix` is what tells the two reads apart (#task:1823).
  { method: 'GET', suffix: 'peer-profile', noun: 'profile', verb: 'get' },
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
