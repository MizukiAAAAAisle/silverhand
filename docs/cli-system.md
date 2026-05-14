# Silverhand CLI System

> Current contract for the agent-facing `silverhand` CLI.
> Keep this document in sync with `packages/cli`, the internal agent routes in
> `packages/backend/src/routes.ts`, and the prompt rules in
> `packages/backend/src/drivers/platform-prompt.ts`.

## 1. Purpose

Spawned agents interact with Silverhand through a normal shell command:

```sh
silverhand <noun> <verb> [flags...]
```

The agent contract is intentionally small:

- The command name is `silverhand`.
- The backend injects `SILVERHAND_CONVERSATION_ID`,
  `SILVERHAND_AGENT_ID`, `SILVERHAND_SERVER_URL`, and
  `SILVERHAND_AUTH_TOKEN`.
- The per-spawn `bin/` directory is prepended to `PATH`.

Agents should not pass or override these environment variables manually. The
auth token is bound server-side to the `(conversationId, agentId)` pair, so
changing env vars in bash does not grant a different principal.

## 2. Process Boundary

`ConversationManager` starts one runtime CLI process for each
`(conversation, agent)` pair. Before spawn it:

1. Issues a per-launch agent token.
2. Writes per-spawn runtime files under
   `<os.tmpdir()>/silverhand/<conversationId>/<agentId>/spawn-*`.
3. Writes `bin/silverhand`, a small shim that forwards to the host's CLI
   launcher.
4. Prepends that `bin/` directory to `PATH`.
5. Injects the four `SILVERHAND_*` environment variables.

The CLI never talks to SQLite directly. It calls backend HTTP under
`/internal/conversations/:conversationId/agents/:agentId/...`; the backend
enforces membership, principal binding, task ownership, lifecycle side effects,
and event publishing.

## 3. Command Surface

All commands default to machine-readable JSON on stdout. Use
`silverhand <noun> <verb> --help` for exact flags.

| Command | Purpose |
|---|---|
| `silverhand message send` | Send a visible message to the current channel/thread, parent, or direct child thread. **Body comes from STDIN** — see §3.1. |
| `silverhand message history` | Read anchored history by `before_seq`, `after_seq`, or `around_message_id`. |
| `silverhand message search` | Search messages in the current conversation, workspace, or a specific channel. Query text via `--q <text>` or its alias `--query <text>` (mutually exclusive). |
| `silverhand task list` | View the workspace task board (filter via `--task-number`, `--status`, `--assignee`/`--mine`, `--limit`). `--status` accepts canonical values plus list-only filter macros — see §3.2. |
| `silverhand task create` | Create tasks in the current channel/thread. |
| `silverhand task claim` | Claim tasks by task number or promote-and-claim messages. |
| `silverhand task unclaim` | Release a task claim. |
| `silverhand task status` | Move a task through `in_progress`, `in_review`, or `done`. Rejects the list-only filter macros (`active|open|pending|all`) and the initial state `todo` with `subkind: 'enum_invalid'` — see §3.2. |
| `silverhand thread create` | Open a Thread for a bounded side discussion or delegation. |
| `silverhand thread close` | Close the current Thread. |
| `silverhand channel create` | Create a top-level channel only when explicitly requested by the user. |
| `silverhand channel list` | List channels, optionally for a workspace id. |
| `silverhand workspace list` | List workspaces the agent can access. |
| `silverhand schedule create` | Schedule a self-wake. |
| `silverhand schedule list` | List this agent's schedules. |
| `silverhand schedule cancel` | Cancel a schedule. |
| `silverhand file upload` | Upload a local file and return an attachment id. |
| `silverhand file view` | Resolve an attachment id to a local path or download location. |

### 3.1 `silverhand message send` is stdin-only

The body of a sent message is read from **STDIN**. The original
`--content <text>` flag was removed because shell quoting silently
truncated bodies whenever the value contained `"`, `` ` ``, or `$` —
bash word-split at the first unescaped `"` and the tail landed in
`args.positional`, which the dispatcher used to discard silently. See
the incident note linked in `docs/progress.md` for the original repro.

Two recommended call shapes:

```bash
# short body
printf "%s" "hello" | silverhand message send

# multi-line / contains quotes / contains $/backticks
silverhand message send --target parent <<'SILVERHAND_EOF'
Any text. Quotes, backticks, $vars, multi-line markdown — all safe.
SILVERHAND_EOF
```

The single-quoted heredoc delimiter (`<<'SILVERHAND_EOF'`) disables
shell expansion of `$`, backticks, and `\`. The CLI reads the raw
bytes and decodes them as UTF-8 with **no normalization** — no BOM
stripping, no CRLF→LF translation, no trim. The bytes the agent wrote
are the bytes that reach the database.

Pre-flight failures (exit 1, code `validation_error`):

| `subkind` | When |
|---|---|
| `flag_removed` | The legacy `--content`, `--text`, or `--message` flag was supplied. |
| `stdin_is_tty` | `process.stdin.isTTY` is true (no body was piped in). |
| `empty_stdin` | Stdin closed with 0 bytes. |
| `invalid_utf8` | Stdin contained byte sequences that are not valid UTF-8. The CLI does NOT silently substitute U+FFFD — re-encode upstream and retry. |
| `unexpected_arguments` | Any positional argument or `--`-trailing token (rejected globally; see §4.1). |

### 3.2 `silverhand task list --status` filter macros

The DB-side `tasks.status` column is always one of the four canonical
values `todo | in_progress | in_review | done`. The list filter accepts
those values verbatim, plus a small set of **list-only filter macros**
that expand to one or more canonical statuses on the agent's side
before the request is sent:

| Macro | Expands to |
|---|---|
| `active` / `open` | `todo + in_progress + in_review` |
| `pending` | `todo` |
| `all` | no filter (all four statuses) |

Comma-joined values are also accepted (`--status active,done`); each
token is independently expanded and deduplicated.

`silverhand task status --status` is the **mutation** verb — it writes
one concrete status onto a task. It explicitly rejects:

- the macros above with `subkind: 'enum_invalid'` and `details.reason
  = 'list_only_macro'`, and a message pointing at `silverhand task
  list`;
- the initial state `todo` with the same `enum_invalid` subkind
  (mirroring the server-side workflow that forbids transitioning *to*
  todo).

This boundary is what keeps the macros aliasing-only — the DB never
stores an aggregate word like `active`.

## 4. Error Contract

stderr is the primary failure context for agents. It must be concise,
friendly, actionable, and not a stack trace. In JSON mode stderr emits one
line:

```json
{"error":{"code":"not_found","message":"task #42 not found in current channel","retriable":false}}
```

Stable codes:

- `not_found`
- `forbidden`
- `unauthorized`
- `validation_error`
- `conflict`
- `rate_limited`
- `upstream_unavailable`
- `internal`

Stable codes are intentionally a closed enum — they drive
`exitCodeFor` and the retriable contract. For descriptive
sub-classification, JSON-mode stderr may carry an optional
`subkind` and a free-form `details` object alongside the canonical
fields:

```json
{"error":{"code":"validation_error","subkind":"flag_removed","message":"--content was removed; pipe content via stdin","retriable":false,"details":{"flag":"content","replacement":"stdin"}}}
```

Current `subkind` values (CLI-side enum is the source of truth):

- `flag_removed` — a flag the command used to accept (or, for
  `silverhand message send`, a flag agents commonly reach for —
  `--text` / `--message` — that is intercepted with the same
  stdin-template hint as the legacy `--content`).
- `unknown_flag` — flag name not declared by the command. `details`
  carries `{flag, suggestion?, other_unknown?}` for did-you-mean
  surfacing in trace aggregations.
- `enum_invalid` — a flag value is outside the command's allowed
  enum. `details` carries `{flag, value, allowed[], reason?}`. For
  `silverhand task status --status`, passing a list-only filter macro
  (`active|open|pending|all`) sets `reason: 'list_only_macro'` so
  trace aggregations can distinguish "agent confused list filter with
  a writable state" from "agent typed a typo".
- `mutually_exclusive` — two aliased flags supplied together (e.g.
  `--q` and `--query` on `silverhand message search`). `details`
  carries `{flags[]}`.
- `unexpected_arguments` — any positional / `--`-trailing token.
- `stdin_is_tty` — `silverhand message send` invoked without a piped body.
- `empty_stdin` — `silverhand message send` invoked with 0-byte stdin.
- `invalid_utf8` — `silverhand message send` stdin contained non-UTF-8 bytes.

`subkind` and `details` are stderr-only. The fire-and-forget
`cli-trace` reporter never carries `details` (or any raw value-bearing
field) — see §7.

### 4.1 Dispatcher hard guard

Every command in this catalogue accepts flags only — no positional
arguments, no `--`-trailing rest tokens. The dispatcher rejects both
with `subkind: 'unexpected_arguments'` after `assertKnownFlags` runs,
so an agent who shell-word-splits a flag value and accidentally feeds
the dispatcher stray positional tokens sees an explicit failure
instead of a silent drop.

Exit code policy:

- `0`: success
- `1`: user/input error; do not retry
- `2`: temporary error; retry only with backoff
- `3`: auth failure; stop and report

The CLI may include an HTTP status suffix only when the backend did not return
a structured error body. Normal route errors should return structured
`{ error: { code, message } }` bodies so the CLI can preserve the stable code
and user-facing message.

### Strict flag validation

Every command declares the flags it accepts (`flags` for value-bearing,
`booleanFlags` for switches in `packages/cli/src/commands/`). The dispatcher
rejects any flag the command did NOT declare with `validation_error`
(`subkind: 'unknown_flag'`, `details: {flag, suggestion?, other_unknown?}`),
including a did-you-mean suggestion when the typo is within Levenshtein
distance 2 of a known flag. The intent is to fail loudly on agent-typed
typos like `--task-numbers 191` (typo for `--task-number`) rather than
silently dropping them and returning the unfiltered result.

When you add a flag to a command, declare it in the command's `flags`
or `booleanFlags` list — otherwise the dispatcher will reject it.

## 5. Security

The CLI reads bearer auth from `SILVERHAND_AUTH_TOKEN`. The backend verifies
the token against the URL's `(conversationId, agentId)` tuple on every
internal request. A token is revoked when the runtime process exits.

This moves the previous process-bound context into an explicit principal
check:

```text
authentication -> principal binding -> ACL -> handler
```

Handlers should not trust agent-supplied body fields for scope-bearing values
when the route path or authenticated principal already provides that scope.

## 6. Packaging

Dev and release both run the same esbuild bundle, `packages/cli/dist/cli.js`,
built by:

```sh
pnpm --filter @silverhand/cli build
```

The desktop app ships that bundle under
`<app>/Contents/Resources/silverhand-cli/cli.mjs` (renamed from `cli.js`
during packaging so Node recognizes it as ESM without a sibling
`package.json` type=module; dev loads the repo file directly where the
workspace `package.json` already declares `type: module`). In both dev and
release the Electron binary acts as the Node host for the CLI —
`resolveSilverhandCliLauncher` returns `process.execPath` +
`ELECTRON_RUN_AS_NODE=1` pointing at the bundle. `spawn-prep` writes the
per-spawn `bin/silverhand` shim that forwards to that launcher, so agents
always call the same command name. No separate Node or Bun runtime is
shipped.

## 7. Observability

The backend writes three categorized JSONL logs under
`~/.silverhand/logs/`, one file per backend boot:

| File | Sink | Contents |
|---|---|---|
| `backend-<utc>.log` | `loggers.system` | HTTP server lifecycle, scheduler, ws, auth, DB. |
| `agent-<utc>.log` | `loggers.agent` | ConversationManager spawn / drain / exit / compaction. |
| `cli-<utc>.log` | `loggers.cli` | Every `silverhand` CLI invocation + CLI-side pre-flight failures. |

`cli-<utc>.log` carries two distinct categories:

- `cli.invoke` — one line per call against any
  `/internal/conversations/:cid/agents/:aid/...` route. Emitted by the
  Hono middleware in
  `packages/backend/src/observability/cli-invoke-middleware.ts`. Fields:
  `{ts, level, category, request_id, cid, aid, noun, verb, method, route_suffix, query_keys, http_status, duration_ms, status, error_code?}`.
  `route_suffix` is the *matched route pattern* — never the raw URL
  path — so wildcard segments like `attachments/<id>/locate` collapse
  to `attachments/*/locate` and ids never leak. The `query_keys` array
  is the *sorted set of query-string keys* — values are never recorded.
- `cli.preflight_failure` — one line per CLI invocation that errors
  out before reaching any business route (`unknown noun`, strict-flag
  rejection, removed-flag use, dispatcher hard-guard rejection,
  message-send stdin pre-flight). Reported by the CLI itself via
  `POST /internal/conversations/:cid/agents/:aid/cli-trace` and logged
  by the trace handler. Best-effort: 50ms timeout, no retry, never
  affects the CLI's exit code or stderr. Excluded from
  `cli.invoke` aggregations. Carries `error_code`, optional
  `error_subkind`, sanitized `error_message`, `flags_seen`, and
  timing — but **never** `details` / positional / rest / raw values.

Privacy contract:

- No request bodies are logged (message content, attachment bytes,
  task titles, etc.).
- No flag values are logged — only flag names (`flags_seen`) and
  query-string keys (`query_keys`).
- The CLI's `details` payload (e.g. `{positional, rest}` for
  `unexpected_arguments`) stays in local stderr and is **never**
  forwarded to the backend `cli-trace` reporter.
- The bearer token is never logged.

Adding a new internal route requires two parallel updates:

1. Add the route to `internalPaths` in `packages/shared/src/api/paths.ts`.
2. Add the matching `(method, suffix, noun, verb)` entry to
   `CLI_INVOKE_ROUTES` in
   `packages/backend/src/observability/cli-route-map.ts`.

The drift-guard test in
`packages/backend/tests/observability/cli-route-map.test.ts` will
fail loudly if either side is forgotten.

## 8. Maintenance Checklist

When changing agent-facing behavior, update these together:

1. `packages/cli` command parsing, help text, client calls, and error mapping.
2. `packages/shared/src/api/dto.ts` schemas and
   `packages/shared/src/api/paths.ts` route helpers.
3. `packages/backend/src/routes.ts` internal handlers and auth/ACL checks.
4. `packages/backend/src/drivers/platform-prompt.ts` command guidance.
5. This document.
