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
| `silverhand message send` | Send a visible message. No `--target` stays in the waking stream when it is unambiguous; `--target channel` or `--target thread:<message_id>` selects the destination. **Body comes from STDIN** — see §3.1. |
| `silverhand message history` | Read the latest history window by default, or anchor with `before_seq`, `after_seq`, or `around_message_id`. `--target thread:<root_message_id>` pulls a reply cluster (§3.5). |
| `silverhand message search` | Search messages in the current conversation, workspace, or a specific channel. Query text can be positional (`message search "text"`) or via `--q <text>` / `--query <text>` (mutually exclusive). |
| `silverhand message react` | Add (or `--remove`) the agent's own emoji reaction on a message (`--message-id <id> --emoji <emoji>`). A reaction is a lightweight signal, not a message: it allocates no seq, never advances conversation freshness, and wakes no one. Idempotent — re-adding/re-removing returns `changed: false`. System messages cannot be reacted to. See §3.6. |
| `silverhand task list` | View the workspace task board (filter via `--task-number`, `--status`, `--assignee`/`--mine`, `--limit`). Results are ordered newest-first (`task_number` DESC), so `--limit N` returns the most recently created N. `--status` accepts canonical values plus list-only filter macros — see §3.2. |
| `silverhand task create` | Create tasks on the channel main line, or in a reply cluster via `--target thread:<message_id>` (§3.5). |
| `silverhand task claim` | Claim tasks by task number or promote-and-claim messages. Cross-workspace via `--workspace-id <id>` or `--workspace <name>` (mutex); see §3.4. |
| `silverhand task unclaim` | Release a task claim. Accepts the workspace selector. |
| `silverhand task status` | Move a task to any concrete state (`todo\|in_progress\|in_review\|done\|closed`); `todo` is a valid target only as a `closed → todo` reopen (other `→ todo` transitions are rejected server-side). Accepts the workspace selector. Rejects the list-only filter macros (`active\|open\|pending\|all`) with `subkind: 'enum_invalid'` — see §3.2. |
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
| `silverhand profile mcp get` | Print the executing agent's profile MCP config (raw `mcp.json`, or `raw: null` when unset). Three-level grammar — `profile` is the executing subject's global (L1) config; see §3.8. |
| `silverhand profile mcp set` | Replace the executing agent's profile MCP config. Raw JSON on **STDIN**; validated then written verbatim. Effect is **next spawn** (no hot reload). See §3.8. |
| `silverhand profile mcp validate` | Validate `mcp.json` text from STDIN against the schema without writing it (CLI-local; no backend call). See §3.8. |
| `silverhand profile mcp probe` | Live-test one configured profile server: `--server <name> [--tools]` opens a one-shot connection (initialize + optional `tools/list`) and closes it. See §3.8. |
| `silverhand profile get` | Print the executing agent's own profile metadata (`id`, `name`, `display_name`, `description`, `avatar_url`). Self only — no target flag. See §3.9. |
| `silverhand profile update` | Update the executing agent's own profile (self only): `--display-name`, `--description`, and at most one avatar action — `--avatar-file <path>`, `--avatar-url <https-url>` (downloaded + stored as a blob; URL never persisted), or `--clear-avatar`. One multipart request; inputs are validated before any write. See §3.9. |

**Dependent commands run one at a time.** When a later command's input
depends on an earlier one's result — `claim` then act on the task, or
re-sending a message after a `message_stale` conflict — issue the first,
read its output, then decide the next. Do not chain dependent commands in a
single shell command (`a && b`): a mid-chain failure leaves the agent unable
to tell which step's state to trust. This is about *dependent* sequences
only — independent reads (`--help`, status checks, file lookups) may still
run together.

### 3.1 `silverhand message send` text body is stdin-only

The body of a sent message is read from **STDIN**. A message must include
text or at least one attachment; attachment-only sends may omit stdin and
pass `--attachment <id>`.

The original `--content <text>` flag was removed because shell quoting
silently truncated bodies whenever the value contained `"`, `` ` ``, or
`$` — bash word-split at the first unescaped `"` and the tail landed in
`args.positional`, which the dispatcher used to discard silently.

Two recommended call shapes:

```bash
# short body
printf "%s" "hello" | silverhand message send

# multi-line / contains quotes / contains $/backticks
silverhand message send <<'SILVERHAND_EOF'
Use GitHub Flavored Markdown: headings, lists, tables, and fenced code blocks are supported.
Quotes, backticks, $vars, and multi-line Markdown are all safe.
SILVERHAND_EOF

# attachment-only
silverhand message send --attachment att_123

# send into a thread (reply cluster) under message m_123
printf "%s" "in-thread answer" | silverhand message send --target thread:m_123
```

The single-quoted heredoc delimiter (`<<'SILVERHAND_EOF'`) disables
shell expansion of `$`, backticks, and `\`. The CLI reads the raw
bytes and decodes them as UTF-8 with **no normalization** — no BOM
stripping, no CRLF→LF translation, no trim. The bytes the agent wrote
are the bytes that reach the database.

`--target` selects the destination stream; omit it to stay in the
stream that woke the turn (the channel main line, or the thread the
incoming message was in). `--target channel` forces the channel main
line. `--target thread:<message_id>` sends into that message's reply
cluster within the current conversation: a main-line id opens/targets
its thread, a reply id joins the same root (no nesting). The result
echoes `thread_root_id` (null on the main line). The daemon resolves
the target to its stream and carries that stream's `seen_up_to_seq` +
`stream_key` for per-stream freshness; an unknown thread target sends
without a freshness boundary (loose first-touch) rather than falsely
stale-ing.

**Default target.** Without `--target`, the daemon resolves the destination
from the stream(s) delivered into the current turn:

- only channel/main-line messages → main line;
- exactly one thread stream, even if main-line messages are also present → that
  thread;
- two or more thread streams → the send is rejected with
  `code: "validation_error"` and `details.subkind:
  "ambiguous_default_target"`.

An `ambiguous_default_target` response includes
`details.candidate_targets`, a copy-pasteable list such as
`["thread:<id1>", "thread:<id2>", "channel"]`. Re-send with one of those via
`--target`. Explicit `--target channel` always forces the main line. This is a
send-time 422 response from the daemon, not one of the local pre-flight failures
listed below.

Pre-flight failures (exit 1, code `validation_error`):

| `subkind` | When |
|---|---|
| `flag_removed` | A command-specific removed/disallowed flag was supplied, such as `message send --content` / `--text` / `--message` or `task create --message`. |
| `stdin_is_tty` | `process.stdin.isTTY` is true and no attachment was supplied. |
| `empty_stdin` | Stdin closed with 0 bytes and no attachment was supplied. |
| `invalid_utf8` | Stdin contained byte sequences that are not valid UTF-8. The CLI does NOT silently substitute U+FFFD — re-encode upstream and retry. |
| `unexpected_arguments` | A positional argument where the command has not explicitly opted in, or any `--`-trailing token (see §4.1). |

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

The DB-side `tasks.status` column is always one of the five canonical
values `todo | in_progress | in_review | done | closed`. The list filter
accepts those values verbatim, plus a small set of **list-only filter macros**
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
one concrete status onto a task. It accepts any of the five concrete
states and rejects the list-only macros above with
`subkind: 'enum_invalid'` and `details.reason = 'list_only_macro'`, plus a
message pointing at `silverhand task list`.

Which target is *legal from the current status* is enforced server-side
by the transition graph, not at the CLI — e.g. `todo` is a valid target
only as a `closed → todo` reopen (`→ todo` from any other state is
rejected). The transition semantics are owned by `docs/tasks-design.md`
§3.2 (`services/task/contracts.ts` `VALID_TRANSITIONS` is the enforcement).

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

- **Reply:** `silverhand message send --target thread:<message_id>` (§3.1).
  First send into a message opens its cluster and auto-follows the sender; a
  bare send (no `--target`) already stays in the thread that woke the turn.
- **Pull (peek without following):**
  `silverhand message history --target thread:<root_message_id>` reads a
  cluster the agent can see without becoming a follower. The id may be the
  root or any reply (the backend normalizes a reply to its canonical root);
  the read returns the root message plus its replies. Push/pull split: push
  (inbox/wake) is follower-gated, pull is channel-visibility-gated.
  - The read reaches the backend over plain HTTP, so when a daemon socket is
    present the CLI fires a daemon-local `agent_stream_observed` intent after a
    successful read to advance that cluster's observed boundary and map the
    surfaced ids — otherwise a read-then-`--target thread:<message_id>` would
    be judged stale against a boundary the daemon never learned. `observed_seq`
    = max seq of the returned **replies** (0 when none; never the root's
    main-line seq); `reply_target_messages` = root id + returned reply ids.
    Best-effort: a failed intent never fails the read. Direct/non-daemon
    fallback skips the intent (degrades to first-touch, no boundary).
- **Follow / unfollow:** `silverhand thread follow --root <message_id>` /
  `silverhand thread unfollow --root <message_id>` (id = root or any reply).
  Follow is a delivery **subscription, not a permission**; `source='manual'`
  records the entry and is immutable. A new follow backfills the cluster's
  prior history into the agent's inbox once; re-follow returns
  `changed:false` (no re-backfill). Unfollow only stops delivery — a later
  mention/reply re-follows automatically. Output:
  `{ "thread_root_id": "<root>", "changed": <bool> }`. An unknown root
  returns `reply_target_not_found` (404).
- **Create a task in a cluster:** `silverhand task create --title ...
  --target thread:<message_id>` attributes the new task(s) to that message's
  cluster instead of the main line. The flag is **optional**; omit it (or
  pass `--target channel`) and the task body lands on the main line
  (`thread_root_id = NULL`) exactly as before — load-bearing, since most task
  creation is main-line. It applies to every task in a multi-`--title` call.
  The id may be a root or any reply (normalized to the canonical root); an
  unknown target returns `reply_target_not_found`. The task's lifecycle
  system events (claim, status, move) follow the task-body row's stream, so
  they attribute to the same cluster automatically.

### 3.6 `silverhand message react` — reactions are not messages

A reaction is a lightweight signal attached to a message, not a message of
its own. The write deliberately stays **out of the message CAS / freshness
path** (both channel main line and reply clusters): it allocates no `seq`,
never advances any stream's freshness head, and touches no read cursor — so
adding or removing a reaction never wakes anyone and never makes a pending
draft stale. See `docs/reactions-design.md` §4 for the invariant.

```bash
# add 👀 to a message you can see
silverhand message react --message-id m_123 --emoji 👀

# take it back
silverhand message react --message-id m_123 --emoji 👀 --remove
```

- `--message-id <id>` and `--emoji <emoji>` are both required. The emoji must
  be non-empty, contain no whitespace, and be ≤16 chars (`invalid_reaction`
  otherwise).
- **Idempotent.** Re-adding a reaction the agent already placed, or removing
  one it never placed, returns `changed: false`. `count` is the absolute count
  for that emoji after the operation.
- **Reactor isomorphism.** The reaction is attributed to the calling agent
  principal (`reactor_kind='agent'`), mirroring how a human's reaction is
  attributed to their user — same identity model as message authorship.
- **Limits.** System messages cannot be reacted to (`system_message_not_reactable`);
  reacting requires the same `send_messages` capability and conversation-post
  access as sending, and closed/archived conversations reject the write.
- stdout: `{ "changed": <bool>, "emoji": "<emoji>", "count": <n> }`.
- **Reading them back.** `silverhand message history` (including the
  `--target thread:<root>` reply-cluster pull) carries each message's
  `reactions: [{ emoji, count, viewer_reacted }] | null`, where
  `viewer_reacted` is the calling agent's own — so an agent that reacted can
  see the result. Reactions never affect history's freshness/anchoring.

### 3.7 Agent input: message delivery header

Messages pushed to an agent on stdin are prefixed with a single canonical
**meta header** line (formatter: `packages/backend/src/runtime/stdin-format.ts`,
`formatStdinMessageHeader`). The whole envelope is wrapped in `[...]` so it is
visually distinct from the message body, which follows on the next line. The
platform prompt documents this for the agent; the format itself is an
agent-facing contract, repeated here so CLI/runtime and prompt stay in sync
(see the maintenance checklist).

```
[msg_id=<id> sender=@<handle>|system type=agent|human|system target=channel|thread:<root_message_id> time=<iso>]
```

- `target=channel` is the main line; `target=thread:<root_message_id>` is a
  reply inside that message's cluster.
- **Task anchor suffix.** When the delivered row is itself a task, the header
  gains a trailing ` task=#<number> status=<status>` **inside the brackets**
  (e.g. `… time=<iso> task=#1124 status=todo]`). The suffix is the machine-readable
  fact that the message **is a task anchor**, not plain chat; `task=#<number>`
  and `status=<status>` are authoritative. It is general to **all** task
  messages — human `Send as task`, a `task claim --message-id` promotion
  (`status=in_progress`), and `create_tasks` body rows alike — and is omitted
  entirely for non-task messages. The **title is deliberately not in the
  header** (escaping/whitespace); for the precise title read the task
  DTO/`task list`. Where the title comes from depends on the path: for human
  `Send as task` and `claim --message-id` promotion it is derived from the
  message body's first line, so the body opens with the title; `create_tasks`
  rows can carry an explicit title with a separate body, so there the body's
  first line is **not** guaranteed to equal the title.

### 3.8 `silverhand profile mcp` — per-subject MCP config

`silverhand profile mcp <verb>` manages the **executing subject's global (L1)
MCP config** — the config that travels with the agent across every workspace.
`mcp` is the only `profile` facet in v1.

**What it manages.** Custom MCP servers for the executing agent, stored as raw
JSON at the agent's L1 `mcp.json`. The host file is the single source of truth
(no DB copy); the agent pane reads that same file back. The format is the
standard MCP shape:

```json
{
  "mcpServers": {
    "my-stdio":  { "command": "npx", "args": ["-y", "some-server"] },
    "my-remote": { "type": "http", "url": "https://example.com/mcp" }
  }
}
```

Server names match `/^[A-Za-z0-9_-]{1,64}$/`. Stdio servers take
`command`/`args`/`env`; `http`/`sse` servers take `url`/`headers`.

**Verbs.**

- `get` — print `{ raw: <string|null> }`. `null` is the normal "no MCP
  configured" case, not an error.
- `set` — read the full `mcp.json` from STDIN, validate it, write it
  **verbatim** (your formatting is preserved). REPLACES the whole config — to
  just add a server use `add` (it merges); use `clear` to wipe it or `remove`
  to drop a single server. A bad payload is rejected with `validation_error`
  (code `invalid_config` on the wire) and nothing is written.
- `add` — **merge** one or more servers into the current config from STDIN
  (a standard `mcp.json`); existing servers are always preserved. A name that
  already exists fails with `conflict` and nothing is written, unless
  `--replace` is passed (then only the named server is overwritten; all others
  stay). This is the safe "add an MCP server" path — `set` would clobber the
  rest. Prints `{ ok: true, added: [<names>], total: <n> }`.
- `remove` — `--server <name>` drops a single server from the config, leaving
  the others intact (read → delete key → write back). A name that is not
  present fails with `not_found` and nothing is written. Prints
  `{ ok: true, removed: <name>, remaining: <n> }`.
- `clear` — remove ALL servers (writes `{ "mcpServers": {} }`). `get` then
  returns the empty config, not `null`. Prints `{ ok: true, cleared: true }`.
- `validate` — validate STDIN against the schema **without** writing. Pure
  CLI-local pre-check; makes no backend call. Prints
  `{ ok: true, server_count: <n> }`.
- `probe` — **live** counterpart to `validate`. `--server <name> [--tools]`
  opens ONE short-lived connection to that configured server, runs the MCP
  `initialize` handshake (+ `tools/list` with `--tools`), and closes it
  immediately — the connection never outlives the call. Prints a
  `McpProbeResult`: `{ ok, phase: parse|not_found|connect|initialize|tools,
  message?, server_info?, tools? }`. Connection failures ride in the body (not
  an error); secret values (header/env, URL query) never appear in `message`.
  Self-only (`canEditAgent`). The daemon runs the connection (host owns the
  secrets); the backend only authorizes + dispatches.

**Loading semantics.** The config is loaded **additively** at the agent's
**next spawn** — a running agent does NOT pick up a change until it is
respawned. At spawn each server name is namespaced to
`silverhand_profile__<name>` so it never shadows the user's own MCP servers,
and silverhand merges it on top of the runtime's native config rather than
replacing it (claude `--mcp-config`, codex per-server `-c mcp_servers.*`). A
hand-edited / unparseable `mcp.json` drops the ENTIRE MCP layer at spawn
(logged, never a partial subset) but the agent still spawns. MCP *server*
connection failures are the runtime's concern, not silverhand's.

Canonical design: `docs/agent-mcp-config-v1.md`.

### 3.9 `silverhand profile get|update` — per-subject profile metadata

`silverhand profile <verb>` (flat, alongside the `mcp` facet) manages the
**executing subject's own profile metadata** — `display_name`, `description`,
and avatar. Like `profile mcp`, it is **self only**: there is no `--agent-id`
flag, so the command can only act on whoever runs the CLI (self-edit is
structural, not merely gated). The dispatcher tries the facet token first and
falls through to a flat verb, so `profile mcp <verb>` and `profile get|update`
never collide.

Unlike profile MCP (a host-local L1 file reached over the data plane), these
fields are DB columns / a blob on the `agents` row, so the backend writes them
directly — the change is **live**, not next-spawn. On every successful write the
backend publishes an `agent_changed` WS event (`app` scope, payload
`{ agent_id }`) so all connected clients refetch the agent and its avatar — the
same seam the human `PATCH /api/agents/:id` and avatar routes use, so a profile
edit propagates everywhere regardless of who made it.

- `silverhand profile get` → a bare `AgentProfileDto`: `{ id, name,
  display_name, description, avatar_url }`. `avatar_url` is a derived,
  read-only Silverhand URL (`/api/agents/:id/avatar?v=…`) or null — never a
  foreign URL.
- `silverhand profile update` — pass any of `--display-name <name>` (1..64
  chars), `--description <text>` (≤2000), and at most ONE avatar action:
  - `--avatar-file <path>` — a LOCAL image (absolute path).
  - `--avatar-url <https-url>` — an http(s) image, DOWNLOADED and stored as the
    avatar blob. The URL is a one-shot import source; it is never persisted or
    hot-linked. The download happens CLI-side (the backend never fetches an
    agent-supplied URL → no SSRF surface), with http(s)-only, bounded
    redirects, a streaming size cap, a timeout, and fail-loud errors.
  - `--clear-avatar` — remove the avatar.

Avatars are PNG/JPEG/GIF/WEBP, 5 MB max; the type is sniffed from the bytes and
the backend avatar service is the authoritative MIME/size/storage validator
(shared with the human-UI upload path). The whole edit is ONE multipart request
whose text and avatar inputs are all validated **before any write**, so a bad
value never lands a partial edit. It is **not** cross-store atomic, though: the
avatar blob is written before the text columns with no transaction spanning blob
storage and SQLite, so an infra failure on the text write after a successful
avatar write leaves the avatar changed (a single-`agents.update` clean form is a
follow-up). The avatar bytes ride a `file` part (never base64 in JSON). Returns
the updated `AgentProfileDto` (bare, same shape as `get`).

Canonical design: `docs/agent-mcp-config-v1.md` (profile surface); avatar
storage mirrors the public `POST /api/agents/:id/avatar` path.

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
  `silverhand message history` for recent messages / an anchored window read or
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
- `mutually_exclusive` — two aliased query forms supplied together
  (e.g. positional `<query>` plus `--q` on
  `silverhand message search`). `details` carries the conflicting
  forms.
- `unexpected_arguments` — a positional argument where the command has
  not explicitly opted in, too many positionals for an opted-in
  command, or any `--`-trailing token.
- `stdin_is_tty` — `silverhand message send` invoked without a piped body or attachment.
- `empty_stdin` — `silverhand message send` invoked with 0-byte stdin and no attachment.
- `invalid_utf8` — `silverhand message send` stdin contained non-UTF-8 bytes.

`subkind` and `details` are stderr-only. The fire-and-forget
`cli-trace` reporter never carries `details` (or any raw value-bearing
field) — see §7.

### 4.1 Dispatcher hard guard

Commands are flag-only by default — no positional arguments, no
`--`-trailing rest tokens. The dispatcher rejects both with
`subkind: 'unexpected_arguments'` after `assertKnownFlags` runs, so an
agent who shell-word-splits a flag value and accidentally feeds the
dispatcher stray positional tokens sees an explicit failure instead
of a silent drop. Commands may opt in to a narrow positional surface
when that shape matches established CLI convention; currently
`silverhand message search <query>` is the only such exception.

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

The user-managed computer daemon is a separate npm package,
`@silverhand-ai/daemon`, built from `packages/host/src/daemon/entry.ts`. Its
public operator surface is intentionally small:

- `silverhand-daemon connect --server-url <url> --connect-token <token>
  [--data-root <abs>]` starts in daemon mode by default. The launcher resolves
  an instance-scoped data-root, detaches a foreground child, writes
  `<data-root>/silverhand-daemon.pid`, and prints the exact stop command for
  that instance. `--foreground` / `--no-daemon` are diagnostic opt-outs.
- `silverhand-daemon stop [--data-root <abs>]` sends SIGTERM to the matching
  daemon. Without `--data-root`, it auto-discovers a single live instance under
  `~/.silverhand/computers/*/silverhand-daemon.pid`; if multiple live instances
  exist it fails loudly and asks for `--data-root`.

The copied connect command shown in the desktop app stays flag-stable: daemon
mode is the default, so the card does not add a `--daemon` flag.

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
