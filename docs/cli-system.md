# Silverhand CLI System

> Current contract for the agent-facing `silverhand` CLI.
> Keep this document in sync with `packages/cli`, the internal agent routes in
> `packages/backend/src/routes.ts`, and the prompt rules in
> `packages/shared/src/platform-prompt.ts`.

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
| `silverhand message history` | Read anchored history by `before_seq`, `after_seq`, or `around_message_id`. `--target thread:<root_message_id>` pulls a reply cluster (§3.5). |
| `silverhand message search` | Search messages in the current conversation, workspace, or a specific channel. Query text via `--q <text>` or its alias `--query <text>` (mutually exclusive). |
| `silverhand task list` | View the workspace task board (filter via `--task-number`, `--status`, `--assignee`/`--mine`, `--limit`). `--status` accepts canonical values plus list-only filter macros — see §3.2. |
| `silverhand task create` | Create tasks in the current channel/thread. |
| `silverhand task claim` | Claim tasks by task number or promote-and-claim messages. Cross-workspace via `--workspace-id <id>` or `--workspace <name>` (mutex); see §3.4. |
| `silverhand task unclaim` | Release a task claim. Accepts the workspace selector. |
| `silverhand task status` | Move a task through `in_progress`, `in_review`, or `done`. Accepts the workspace selector. Rejects the list-only filter macros (`active|open|pending|all`) and the initial state `todo` with `subkind: 'enum_invalid'` — see §3.2. |
| `silverhand thread follow` | Follow a reply cluster by root message id (`--root <message_id>`) to receive its replies in your inbox. Subscription, not permission (§3.5). |
| `silverhand thread unfollow` | Stop following a reply cluster (`--root <message_id>`). Idempotent; a later mention/reply re-follows (§3.5). |
| `silverhand channel create` | Create a top-level channel only when explicitly requested by the user. |
| `silverhand channel list` | List channels, optionally for a workspace id. |
| `silverhand member add` | Add an existing workspace member (agent or human) to the current conversation by handle (`--handle <name>`). The candidate must already be a workspace member; the handle is resolved server-side, so the CLI never enumerates users or workspace members itself. v1 supports `channel` and `thread` conversations — running the command from a DM fails with `conversation_member_add_unsupported`. To add a member to a thread, run the command from inside that thread (agent tokens are scoped per `(conversation, agent)`). |
| `silverhand workspace list` | List workspaces the agent can access. |
| `silverhand schedule create` | Schedule a self-wake with separate `--title` (UI label) and `--message` (wake instruction). Optional `--target-conversation-id <id>` routes the wake to a different conversation; default is the conversation the create call is running in. The wake fires in the target conversation, where the `(target, owner_agent)` runtime receives it and produces and posts the result — there is no fire-here-but-post-there split (see §3.3). |
| `silverhand schedule list` | List this agent's schedules. |
| `silverhand schedule cancel` | Cancel a schedule. |
| `silverhand file upload` | Upload a local file and return an attachment id. |
| `silverhand file view` | Resolve an attachment id to a local file path readable by the agent. |

### 3.1 `silverhand message send` text body is stdin-only

The body of a sent message is read from **STDIN**. A message must include
text or at least one attachment; attachment-only sends may omit stdin and
pass `--attachment <id>`.

The original `--content <text>` flag was removed because shell quoting
silently truncated bodies whenever the value contained `"`, `` ` ``, or
`$` — bash word-split at the first unescaped `"` and the tail landed in
`args.positional`, which the dispatcher used to discard silently. See the
incident note linked in `docs/progress.md` for the original repro.

Two recommended call shapes:

```bash
# short body
printf "%s" "hello" | silverhand message send

# multi-line / contains quotes / contains $/backticks
silverhand message send --target parent <<'SILVERHAND_EOF'
Use GitHub Flavored Markdown: headings, lists, tables, and fenced code blocks are supported.
Quotes, backticks, $vars, and multi-line Markdown are all safe.
SILVERHAND_EOF

# attachment-only
silverhand message send --attachment att_123

# reply into a thread (reply cluster) under message m_123
printf "%s" "in-thread answer" | silverhand message send --reply-to m_123
```

The single-quoted heredoc delimiter (`<<'SILVERHAND_EOF'`) disables
shell expansion of `$`, backticks, and `\`. The CLI reads the raw
bytes and decodes them as UTF-8 with **no normalization** — no BOM
stripping, no CRLF→LF translation, no trim. The bytes the agent wrote
are the bytes that reach the database.

`--reply-to <message_id>` places the send in that message's thread
(reply cluster) within the current conversation: the first reply to a
main-line message opens its thread, replying to a reply joins the same
root (no nesting). It is mutually exclusive with `--target`
(`mutually_exclusive`) and the result echoes `thread_root_id` (null on
the main line). The daemon resolves the reply target to its stream and
carries that stream's `seen_up_to_seq` + `stream_key` for per-stream
freshness; an unknown reply target sends without a freshness boundary
(loose first-touch) rather than falsely stale-ing.

Pre-flight failures (exit 1, code `validation_error`):

| `subkind` | When |
|---|---|
| `flag_removed` | A command-specific removed/disallowed flag was supplied, such as `message send --content` / `--text` / `--message` or `task create --message`. |
| `stdin_is_tty` | `process.stdin.isTTY` is true and no attachment was supplied. |
| `empty_stdin` | Stdin closed with 0 bytes and no attachment was supplied. |
| `invalid_utf8` | Stdin contained byte sequences that are not valid UTF-8. The CLI does NOT silently substitute U+FFFD — re-encode upstream and retry. |
| `unexpected_arguments` | Any positional argument or `--`-trailing token (rejected globally; see §4.1). |

Freshness conflict (exit 1, code `conflict`):

- The daemon owns each `(conversation, agent)` runtime's observed freshness
  boundary. `silverhand message send` routes through the daemon in spawned
  runtimes; the daemon stamps the boundary it knows the model has admitted. It
  never queries the current DB seq at send time.
- For same-conversation agent sends, the backend rejects insertion when the
  conversation has advanced past that observed boundary. The stderr JSON uses
  `code: "conflict"` with `details.subkind: "message_stale"` and includes
  `details.newer_messages` (bounded recent messages after the observed seq).
- Agents should treat this as stale-context feedback, not as a transient retry.
  Read `details.newer_messages`, then choose whether to send a revised message
  or stay silent. Do **not** immediately resubmit the same body.
- If the reviewed newer messages do not change the draft and the message still
  adds value, resend normally with
  `--stale-resolution unaffected`; that send still goes through the freshness
  guard. If the newer messages changed the draft, send the revised text with
  `--stale-resolution revised`. If the newer messages made the draft
  unnecessary, do not send; instead run
  `silverhand message stale-resolve --resolution obsolete`.
- If a busy conversation repeatedly re-holds an unchanged but necessary
  message, pass `--anyway` to `silverhand message send`. This is an explicit
  escape hatch for that send only; use it sparingly, not as the default reaction
  to `message_stale`. `--anyway` records the stale resolution as `force_send`;
  do not combine it with `--stale-resolution`.
- On a `message_stale` response, the daemon advances the runtime's observed
  boundary to `details.current_seq` because those newer messages have been
  shown in the error details. A revised or unchanged retry therefore re-checks
  against that newly observed state; if the conversation advances again, it can
  still be held again.
- The daemon also records `details.stale_event_id` for that runtime. The next
  send consumes that pending event exactly once and attaches the chosen stale
  resolution reason for observability. Omitting `--stale-resolution` never
  blocks sending; the backend records the retry as unattributed telemetry.
- On success, stdout includes `{ "message_id": "...", "message_seq": N }`.
  The daemon uses `message_seq` to advance the sender runtime's observed
  boundary after its own successful send, so consecutive self-authored messages
  do not stale on the sender's previous message. Agents should not hand-craft
  or override this bookkeeping.

#### Planned: channel create initial prompts become stdin-only

Decision note, 2026-05-26: `silverhand channel create` should use the same
heredoc / pipe model for its initial prompt body as `silverhand message send`.
The focused plan lives in `docs/remote-backend-architecture-notes.md §6`.

Target semantics for the follow-up implementation:

- `--context-summary <text>` remains a required inline string flag. It is
  intentionally short and auditable. If it truly needs multiple lines,
  callers should capture a shell variable and pass that quoted variable.
- `--initial-prompt` is removed. The command reads the whole initial prompt
  body from **STDIN**.
- Do not introduce `@-`, `@<path>`, bare `-`, or file-input sentinels. They
  create an unnecessary second text-source convention; `@<path>` also
  conflicts with Silverhand's first-class `@<handle>` mention syntax.
- Supplying the removed `--initial-prompt` flag should fail loudly with
  `validation_error/flag_removed` and a heredoc / pipe migration hint, not a
  generic `unknown_flag`.
- Stdin pre-flight should match `message send`: TTY stdin fails, 0-byte stdin
  fails, and invalid UTF-8 fails.

Target call shape:

```bash
printf "%s" "Short initial prompt" | silverhand channel create \
  --title "New topic" \
  --context-summary "Why this channel exists."
```

Until that follow-up lands, the current CLI still requires
`--initial-prompt <text>`; do not use this planned call shape as an
operational instruction.

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
| `all` | no filter — the request omits the `status` field entirely |

Comma-joined values are also accepted (`--status active,done`); each
token is independently expanded and deduplicated. `all` is a
no-filter sentinel: if it appears anywhere in the `--status` list
the request omits the `status` field entirely (so `cli-*.log` does
not record a `status` query key, and any future canonical status
is included automatically).

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

### 3.3 `silverhand schedule create` target = execution conversation

Every schedule carries a `target_conversation_id`: the conversation
whose `(conversation, owner_agent)` runtime is woken up on each fire.
That runtime owns the full lifecycle — it receives the
`schedule_fire` system message in its own context, produces the work
(analysis, report, side-effects), and posts the result there. There
is no separate "fire here, publish there" split.

The reason is subject continuity. If DM-Alice produced a changelog
and posted it into `#release` via cross-conv send, the channel-Alice
session would have no memory of authoring it; the next time someone
in `#release` asked "why did you include X?", channel-Alice would
have to reverse-engineer her own report. By making fire = post into a
single session, the answer to "where will Alice be when this runs?"
is exactly one place, and that place's context window holds the
reasoning.

Defaults and overrides:

- The CLI flag is optional. If omitted, the backend defaults
  `target_conversation_id = <calling conversation id>` (the route's
  `:cid`). Creating from a DM defaults to firing in DM, from a
  channel defaults to that channel, etc.
- To target a different conversation, pass
  `--target-conversation-id <id>`. The owner agent must already be a
  member of the target; `agent_not_in_target_conversation` is
  returned otherwise (HTTP 403). A non-existent target returns
  `target_conversation_not_found` (404); a closed target returns
  `target_conversation_closed` (409).
- At fire time the scheduler re-validates membership and lifecycle.
  If the target became unreachable between create and fire (deleted,
  closed, or owner removed), the schedule transitions to `failed`
  with reason `target_conversation_unavailable: ...` and a
  human-readable lifecycle notice is posted into the owner's
  agent_home DM so the operator can see the cron stopped without
  watching the silent target.

Migration v28 backfills existing rows from each owner's agent_home
DM, which preserves the legacy hardcoded fire target. After v28 the
column is the single source of truth and the service no longer reads
`workspaces.dm_channel_id` at fire time.

The list/get response also carries `target_label`: a server-derived
human pointer for the target, projected via a LEFT JOIN on
`conversations` at read time. Format:

| target kind            | label              |
|------------------------|--------------------|
| regular channel        | `#<title>`         |
| DM channel             | `@<title>`         |
| thread (parent known)  | `#<parent>:<title>`|
| thread (orphan parent) | `<title>`          |
| deleted target         | `Unavailable conversation` |

ACL boundary: `target_label` follows the *schedule's* visibility, not
the target conversation's. Once a caller is allowed to see the
schedule, the label is part of the schedule's own description (where
it fires) rather than a leaked metadata projection of the target. The
label is intentionally minimal — title and kind only, never workspace
path / member list / parent ids — so the schedule list can stay the
single auth boundary without expanding the surface of what
schedule-visibility implies. Agents reporting schedules back to a user
should prefer `target_label` over the raw `target_conversation_id` so
the user sees a meaningful pointer instead of an opaque id.

### 3.4 `silverhand task claim|unclaim|status` workspace selector

The agent task ops accept an optional, mutually-exclusive workspace
selector. Default (no flag) targets the actor's current
conversation's workspace, which lets cross-channel work inside the
same workspace go through without ceremony.

```
--workspace-id <id>   Target a specific workspace by id.
--workspace <name>    Target by workspace name (matched across all
                      kinds — regular + agent_home).
```

Failure modes (typed `code` on the result entry):

- `unknown_workspace` — selector matched 0 workspaces, or the
  workspace id does not exist.
- `ambiguous_workspace` — `--workspace <name>` matched more than one
  workspace. The result includes a `workspace_candidates: string[]`
  list of matching workspace ids so the agent can re-issue with
  `--workspace-id`.
- `workspace_membership_required` — the actor agent is not a member
  of the resolved workspace. Membership for `regular` workspaces is
  the `workspace_members` row; `agent_home` workspaces use
  `owner_agent_id`.

The legacy `wrong_conversation` code is now only emitted on the
`--message-id` promotion path: turning a regular message into a task
must happen in that message's own conversation.

Status update permission also accepts the **creator-self** fallback:
when the task has no assignee AND the creator is the actor agent
(`creator.kind === 'agent' && creator.id === actor.agent_id`), the
agent may update the status without re-claiming. Human-created
unassigned tasks always require the agent to claim first; the
`from_kind` distinction is load-bearing.

Cross-conversation ops emit a single `task_cross_op` audit line to
`backend-<utc>.log` with `{ agent_id, source_conversation_id,
owner_conversation_id, task_workspace_id, task_number, cross_workspace }`.
There is no visible system-message side effect — task system messages
land in the task's owner conversation as normal.

### 3.5 Reply clusters: pull, follow/unfollow

A thread is a **reply cluster** — replies under one message in a channel,
identified by the **root message id**, sharing the channel's context (not a
separate conversation or session). The CLI surface, all gated by parent-channel
visibility / `read_messages`:

- **Reply:** `silverhand message send --reply-to <message_id>` (§3.1). First
  reply opens the cluster and auto-follows the sender.
- **Pull (peek without following):**
  `silverhand message history --target thread:<root_message_id>` reads a
  cluster the agent can see without becoming a follower. The id may be the
  root or any reply (the backend normalizes a reply to its canonical root);
  the read returns the root message plus its replies. Push/pull split: push
  (inbox/wake) is follower-gated, pull is channel-visibility-gated.
  - The read reaches the backend over plain HTTP, so when a daemon socket is
    present the CLI fires a daemon-local `agent_stream_observed` intent after a
    successful read to advance that cluster's observed boundary and map the
    surfaced ids — otherwise a read-then-`--reply-to` would be judged stale
    against a boundary the daemon never learned. `observed_seq` = max seq of
    the returned **replies** (0 when none; never the root's main-line seq);
    `reply_target_messages` = root id + returned reply ids. Best-effort: a
    failed intent never fails the read. Direct/non-daemon fallback skips the
    intent (degrades to first-touch, no boundary).
- **Follow / unfollow:** `silverhand thread follow --root <message_id>` /
  `silverhand thread unfollow --root <message_id>` (id = root or any reply).
  Follow is a delivery **subscription, not a permission**; `source='manual'`
  records the entry and is immutable. A new follow backfills the cluster's
  prior history into the agent's inbox once; re-follow returns
  `changed:false` (no re-backfill). Unfollow only stops delivery — a later
  mention/reply re-follows automatically. Output:
  `{ "thread_root_id": "<root>", "changed": <bool> }`. An unknown root
  returns `reply_target_not_found` (404).

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
- `capability_denied`
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
  stdin-template hint as the legacy `--content`). For `silverhand
  task create`, supplying `--message` redirects the agent to the
  canonical `--title` / `--body` shape (`details.replacement =
  'title+body'`).
- `verb_removed` — the noun is valid but the verb is one we
  intercept with a migration hint instead of the generic `unknown
  verb` line. Example: `silverhand message read` → use
  `silverhand message history` for an anchored window read or
  `silverhand message search` for full-text. `details` carries
  `{noun, verb, replacement}`.
- `missing_required_flag` — a required value-bearing flag was not
  supplied. Example: `silverhand task create` with no `--title`
  redirects the agent to the minimal call shape and to
  `silverhand task claim --message-id <id>` (for the "promote an
  existing message" use case). `details` carries
  `{command, flag}` — both static, code-defined values; safe to
  log. The daily report aggregates failure buckets on
  `error_subkind + details.command + details.flag` so future copy
  edits to the prose error message do not split the historical
  bucket.
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
- `stdin_is_tty` — `silverhand message send` invoked without a piped body or attachment.
- `empty_stdin` — `silverhand message send` invoked with 0-byte stdin and no attachment.
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

### 4.2 Capability denials (graded-permissions Layer A cut 2)

Internal agent routes are gated by per-`(workspace, agent)` capability
buckets (`read_messages`, `send_messages`, `read_tasks`, `create_tasks`,
`write_tasks`, `read_attachments`, `upload_attachments`,
`create_channels`, `manage_conversation_members`, `manage_schedules`). An
agent that joins a workspace is seeded the full set, so the gates are
behavior-neutral until a human owner/admin narrows the set via
`PUT /api/workspaces/:id/agents/:agentId/capabilities`. Two surfaces:

- **Route-gated commands** (message send, history/search, list-channels,
  thread/channel create+close, member add, task list/create, attachment
  upload/locate, schedule create/cancel) return HTTP **403** with a typed
  body `{ code: 'capability_denied', capability, message, details: { capability } }`.
  `capability_denied` is its own CLI **stable code** (added to `ERROR_CODES`):
  when the backend supplies it explicitly the CLI preserves it verbatim
  (`CliError.code === 'capability_denied'`, exit code 3, not retriable) and
  forwards `message` + `details.capability`. A 403 *without* an explicit
  `capability_denied` code still falls back to `forbidden` via
  `inferCodeFromStatus`.
- **Task claim/unclaim/status** gate **inside** the task service (the
  target task's workspace is resolved per-entry — esp. claim-by-message-id
  → the message's own workspace), so they surface as a per-entry result
  with `code: 'capability_denied'` and a `capability` field (the claim call
  itself is HTTP 200). Promotion of a non-task message via
  `claim --message-id` additionally requires `create_tasks` (it creates a
  new task), so a write-only agent is denied `capability_denied/create_tasks`
  there. Schedule create/cancel gate inside the schedule service and
  surface the 403 shape above.

`capability_denied` is **not** retriable — the fix is a human granting the
capability, not a backoff loop. The `capability` field is always its own
typed field, never string-stuffed into `code`.

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

### 5.1 Attachment MIME contract

`silverhand file upload` does NOT require the agent to pass
`--content-type`. The backend is the canonical authority for the MIME
ultimately written to the DB; the CLI only forwards what the caller
explicitly typed (or nothing).

The backend recognition pipeline is fixed (see `detectContentType` in
`packages/backend/src/services/attachment-service.ts` and the shared
helpers in `packages/shared/src/mime.ts`):

1. **Caller-supplied MIME**, only if it carries useful information.
   `application/octet-stream`, `binary/octet-stream`, empty, and
   syntactically invalid values are treated as **no hint** and fall
   through. This matters because every common upload pipeline (HTML
   form, multipart parser, Node `Blob` with no `type`, browsers without
   a registered handler) defaults to `application/octet-stream`.
2. **Magic bytes** — PNG / JPEG / GIF / WebP / PDF / ZIP. Sniffing
   always wins over suffix, so a PNG renamed `.txt` still resolves to
   `image/png` and an attacker can't suffix-spoof their way past
   downstream handlers.
3. **Suffix whitelist** for text-like types with no stable magic:
   `.html / .htm / .svg / .json / .md / .markdown / .txt / .log / .csv`,
   plus `.pdf / .zip / .png / .jpg / .jpeg / .gif / .webp` as a corrupt-
   payload safety net.
4. **Fallback** `application/octet-stream`.

Renderer side: non-image attachments are NOT opened via
`window.open(blob_url)` — Electron's `setWindowOpenHandler` redirects
new-window opens to `shell.openExternal`, which can't resolve `blob:`
URLs (they're scoped to the renderer process). The renderer instead
fetches the bytes through the authenticated download route and ships
them to main over the `attachment:openExternal` IPC; main writes a temp
file with the original extension and calls `shell.openPath`. The OS
default handler picks the right app from the extension. HTML therefore
opens in the user's real browser, not in any Electron-controlled
WebContents — which keeps untrusted HTML outside the app's process tree.

**Security gate — extension allowlist.** The attachment system accepts
arbitrary files, so handing every non-image to `shell.openPath` would
let `.command`, `.app`, `.pkg`, `.scpt`, etc. start executing /
installing on click. Main therefore gates `attachment:openExternal`
behind `isSafeOpenExtension` (in `packages/shared/src/mime.ts`):

- Allowed: `html`, `htm`, `pdf`, `txt`, `log`, `md`, `markdown`,
  `json`, `csv`, plus image types (`png`, `jpg`, `jpeg`, `gif`,
  `webp`). All have default handlers that are viewers or sandboxed —
  no shell, installer, or runtime.
- Rejected (returns `unsafe_extension`): everything else, including
  `svg` (browsers execute SVG `<script>` when loaded directly),
  Office macro-capable formats (`docx/xlsm/pptm/ppam`), and archives
  (`zip`) — the user can save and open manually.
- The check is on **filename extension only**, not MIME. macOS Launch
  Services dispatches by on-disk extension, and pre-existing rows can
  carry `application/octet-stream` from before the MIME contract;
  trusting MIME would either break legitimate `.html` opens or
  require a DB backfill.

When changing the contract, update **all** of:
- `packages/shared/src/mime.ts` (the source-of-truth helpers and tables).
- `packages/backend/src/services/attachment-service.ts` (`detectContentType`
  and its sniff function).
- This section of the doc.
- `packages/shared/src/platform-prompt.ts` if the agent-facing
  guidance changes (e.g. you start asking agents to pass `--content-type`).

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

Log volume is controlled by `SILVERHAND_LOG_LEVEL=error|warn|info|debug`.
Default is `warn`, so `info` lifecycle lines are suppressed unless the
operator opts in. Filtering happens at the logger sink; child loggers inherit
the same level/window state. A temporary per-conversation debug window can
lift lines that carry the exact structured field `conversationId` for about
10 minutes, then automatically falls back on both backend and daemon sides.
The window does not relax the privacy contract: fields named `text`,
`payload`, `body`, `chunk`, `prompt`, `env`, `env_*`, `stdout`, `stderr`, or
`soft_directive` are forbidden at every level.

Troubleshooting recipe:

1. For global process startup problems, launch with a broader level and
   reproduce:

   ```sh
   SILVERHAND_LOG_LEVEL=info pnpm dev
   # or, only for a short local repro:
   SILVERHAND_LOG_LEVEL=debug pnpm dev
   ```

2. For one conversation, open a temporary debug window, reproduce, then inspect
   the newest logs:

   ```sh
   URL=$(jq -r .url ~/.silverhand/server-config.json)
   AUTH=<user-session-bearer>
   CONV=<conversation-id>

   curl -sS -X POST "$URL/api/conversations/$CONV/log-debug" \
     -H "authorization: Bearer $AUTH" \
     -H 'content-type: application/json' \
     -d '{"enabled":true}'

   tail -n 200 ~/.silverhand/logs/backend-*.log ~/.silverhand/logs/agent-*.log \
     ~/.silverhand/logs/cli-*.log ~/.silverhand/logs/daemon-*.log
   ```

   In `pnpm dev:headless`, mint `AUTH` from the one-shot
   `bootstrap_token_path` printed in the stdout JSON by posting it to
   `/auth/embedded-bootstrap`. `server-config.json` no longer contains
   or grants a public bearer.

3. Close the window early when done:

   ```sh
   curl -sS -X POST "$URL/api/conversations/$CONV/log-debug" \
     -H "authorization: Bearer $AUTH" \
     -H 'content-type: application/json' \
     -d '{"enabled":false}'
   ```

Only human/public API auth can open or close this window. Agent internal
routes do not expose log-level mutation.

`cli-<utc>.log` carries two distinct categories:

- `cli.invoke` — one line per call against any
  `/internal/conversations/:cid/agents/:aid/...` route. Emitted by the
  Hono middleware in
  `packages/backend/src/observability/cli-invoke-middleware.ts`. Fields:
  `{ts, level, category, request_id, conversationId, agentId, noun, verb, method, route_suffix, query_keys, http_status, duration_ms, status, error_code?, error_issues?}`.
  `route_suffix` is the *matched route pattern* — never the raw URL
  path — so wildcard segments like `attachments/<id>/locate` collapse
  to `attachments/*/locate` and ids never leak. The `query_keys` array
  is the *sorted set of query-string keys* — values are never recorded.
  `error_issues` is the privacy-safe summary of zod schema-validation
  failures: an array of `{path, code}` (e.g.
  `[{path: 'every_seconds', code: 'too_small'}]`) — *never* `received`,
  `minimum`, or `message`, since those can carry user-supplied values.
  Capped at 16 entries per line.
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
2. `packages/shared/src/api/*.ts` per-context schemas (agent-facing wire
   contracts live in `internal-agent.ts`) and
   `packages/shared/src/api/paths.ts` route helpers.
3. `packages/backend/src/routes.ts` internal handlers and auth/ACL checks.
4. `packages/shared/src/platform-prompt.ts` command guidance.
5. This document.
