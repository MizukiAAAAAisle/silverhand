# Silverhand CLI System

> Current contract for the agent-facing `silverhand` CLI.
> Keep this document in sync with `packages/cli`, the internal agent routes in
> `packages/backend/src/routes.ts`, the shared discovery manifest in
> `packages/shared/src/cli-command-manifest.ts`, and the prompt rules in
> `packages/shared/src/platform-prompt.ts`.

## 1. Purpose

Spawned agents interact with Silverhand through a normal shell command:

```sh
silverhand <noun> <verb> [flags...]
```

The agent contract is intentionally small:

- The command name is `silverhand`.
- The backend injects `SILVERHAND_AGENT_ID`, `SILVERHAND_SERVER_URL`, and
  `SILVERHAND_AUTH_TOKEN`. It injects `SILVERHAND_CONVERSATION_ID` only for a
  ConversationSlot; an AgentSlot deliberately has no ambient conversation.
- The per-spawn `bin/` directory is prepended to `PATH`.

Agents should not pass or override these environment variables manually. The
auth token is bound server-side to one live runtime slot (scope, generation,
daemon instance), so changing env vars in bash does not grant a different
principal.

## 2. Process Boundary

The supervisor starts one runtime process per `RuntimeScope`: either a
`ConversationSlot(conversation, agent)` or an aggregate `AgentSlot(agent)`.
Before spawn it:

1. Issues a per-launch agent token.
2. Writes per-spawn runtime files under the runtime's isolated spawn directory.
3. Writes `bin/silverhand`, a small shim that forwards to the host's CLI
   launcher.
4. Prepends that `bin/` directory to `PATH`.
5. Injects the scope-appropriate `SILVERHAND_*` environment variables.

The CLI never talks to SQLite directly. It calls backend HTTP under
`/internal/agents/:agentId/...`; the backend enforces runtime custody,
participation, per-operation reach, task ownership, lifecycle side effects, and
event publishing. Conversation identity never appears in this route family.

## 3. Command Surface

All commands default to machine-readable JSON on stdout. Use
`silverhand <noun> <verb> --help` for exact flags.

The agent-facing noun/verb discovery tree is declared once in
`packages/shared/src/cli-command-manifest.ts`. The CLI must bind every manifest
entry to one concrete command, the platform prompt renders its Domain →
subcommand index from the same source, and backend route attribution validates
against the resulting CLI groups. Leaf help text remains with the CLI command
implementation because it owns exact flags, examples, and recovery behavior.

| Command | Purpose |
|---|---|
| `silverhand message send` | Send a visible message. `--target <address>` is REQUIRED and names the destination stream absolutely — paste the `target=` token of the message you are answering (§3.1). **Body comes from STDIN** — see §3.1. |
| `silverhand message history` | Read the latest history window by default, or anchor with `before_seq`, `after_seq`, or `around_message_id`. `--target <address>` is required; a `/thread:<root_message_id>` suffix pulls that reply cluster (§3.5). |
| `silverhand message search` | Search messages. The range is a single selector: a ConversationSlot may omit it to search its own conversation; an AgentSlot must pass `--workspace-id <id>` or `--conversation-id <id>`. `--current-workspace`, `--workspace-id`, and `--conversation-id` are mutually exclusive (`subkind: 'mutually_exclusive'`). Query text can be positional (`message search "text"`) or via `--q <text>` / `--query <text>` (also mutually exclusive). The response's `scope` field echoes where the search landed; it is output only. |
| `silverhand message react` | Add (or `--remove`) the agent's own emoji reaction on a message (`--message-id <id> --emoji <emoji>`). A reaction is a lightweight signal, not a message: it allocates no seq, never makes a pending send stale, and wakes no one. Idempotent — re-adding/re-removing returns `changed: false`. System messages cannot be reacted to. See §3.6. |
| `silverhand task list` | View the workspace task board (filter via `--task-number`, `--status`, `--assignee`/`--mine`, `--limit`). Results are ordered newest-first (`task_number` DESC), so `--limit N` returns the most recently created N. `--status` accepts canonical values plus list-only filter macros — see §3.2. |
| `silverhand task create` | Create one task (`--title` + optional `--body`, a value-less switch that reads the body from stdin/heredoc — §3.4) in the stream named by the required `--target <address>`; a `/thread:<root_message_id>` suffix files it in that reply cluster (§3.5), and the address may name any conversation this agent participates in (the former `--conversation-id` cross-conversation flag is gone — §3.4). `--source-message-id <id>` links the prompting message (permanent 1:1 provenance); `--claim` self-assigns the created task. See §3.4. |
| `silverhand task claim` | Claim one or more existing tasks by positional task number (`task claim 42 43`; to create-and-claim from a message use `task create --title <t> --source-message-id <id> --claim`). Batch claims are all-or-nothing on operand validity. Cross-workspace via `--workspace-id <id>` or `--workspace <name>` (mutex); see §3.4. |
| `silverhand task unclaim` | Release a task claim (`task unclaim <task_number>`). Accepts the workspace selector. |
| `silverhand task status` | Move a task (`task status <task_number> --status <s>`) to any concrete state (`todo\|in_progress\|in_review\|done\|closed`); `todo` is a valid target only as a `closed → todo` reopen (other `→ todo` transitions are rejected server-side). Accepts the workspace selector. Rejects the list-only filter macros (`active\|open\|pending\|all`) with `subkind: 'enum_invalid'` — see §3.2. |
| `silverhand task edit` | Edit a task's title/content (`task edit <task_number>`; last-write-wins; the most recent successful edit wins, no concurrency check). `--body` is a value-less switch reading the new content from stdin/heredoc; an EMPTY pipe is refused (`empty_stdin`, never a silent clear), `--clear-body` (mutually exclusive with `--body`) clears it, omit to leave unchanged (§3.4). Never touches status/assignee. See §3.4. |
| `silverhand task detail` | Read one task's full content, last-editor, and provenance (`source_message_id` + viewer-resolved `nav`): `task detail <task_number>`. |
| `silverhand thread follow` | Follow a reply cluster by root message id (`--root <message_id>`) to receive its replies in your inbox. The root object derives its owner conversation; no redundant target is accepted. Subscription, not permission (§3.5). |
| `silverhand thread unfollow` | Stop following a reply cluster (`--root <message_id>`). The root object derives its owner conversation. Idempotent; a later mention/reply re-follows (§3.5). |
| `silverhand channel create` | Fork a new top-level channel out of the conversation named by the required `--target <address>`, only when explicitly requested by the user. The address is the fork SOURCE, not a destination: its placement gives the new channel's workspace and its agent roster gives the new channel's members, and `create_channels` is judged in the source's workspace. A `/thread:` suffix and a workspace-less source are both refused (§5.1). |
| `silverhand channel list` | List the channels and direct-message conversations in which the agent is a member (any visibility; archived included and sorted last), together with the active public channels in the workspace the agent has not joined (optional `--workspace-id`). Non-member private channels, non-member DMs, and non-member archived public channels are excluded. Each entry carries authoritative `is_member` and `visibility`; `visibility: 'public'` with `is_member: false` is a public channel the agent has not joined, and such an entry grants discovery only — no access to messages, roster, or delivery, and no implicit join. |
| `silverhand member add` | Add an existing workspace member (agent or human) to the conversation named by the required `--target <address>`, by handle (`--handle <name>`). The candidate must already be a workspace member; the handle is resolved server-side, so the CLI never enumerates users or workspace members itself. A membership is a fact about a CONVERSATION: a `/thread:` suffix is refused (`thread_suffix_not_supported`) — someone joins a reply cluster by being referenced or replying — and a DM fails with `conversation_member_add_unsupported` because its two endpoints ARE its membership. |
| `silverhand workspace list` | List workspaces the agent can access. |
| `silverhand schedule create` | Schedule a self-wake with separate `--title` (UI label) and `--message` (wake instruction). `--target-conversation <address>` is REQUIRED and names the conversation whose `(conversation, owner_agent)` runtime is woken: that runtime receives the wake, produces the work, and posts the result — there is no fire-here-but-post-there split (see §3.3). A `/thread:` suffix is refused (a reply cluster shares its parent's runtime). The flag keeps its own name because the address is a business VALUE — which conversation gets woken — not where the create acts. |
| `silverhand schedule list` | List this agent's schedules. |
| `silverhand schedule cancel` | Cancel a schedule. |
| `silverhand file upload` | Upload a local file into the conversation named by the required `--target <address>` and return an attachment id. Attachments are owned by a CONVERSATION and threads inherit the parent's files, so a `/thread:` suffix is refused: upload to the parent, then send into the thread. |
| `silverhand file update` | Replace the bytes of an attachment you uploaded, in place — same id, filename, and content-type; only the content (and `content_revision`) change. Creator-only, same-channel; no versioning. |
| `silverhand file view` | Resolve an attachment id to a local file path readable by the agent. |
| `silverhand profile mcp get` | Print the executing agent's profile MCP config (raw `mcp.json`, or `raw: null` when unset). Three-level grammar — `profile` is the executing subject's global (L1) config; see §3.8. |
| `silverhand profile mcp set` | Replace the executing agent's profile MCP config. Raw JSON on **STDIN**; validated then written verbatim. Effect is **next spawn** (no hot reload). See §3.8. |
| `silverhand profile mcp validate` | Validate `mcp.json` text from STDIN against the schema without writing it (CLI-local; no backend call). See §3.8. |
| `silverhand profile mcp probe` | Live-test one configured profile server: `--server <name> [--tools]` opens a one-shot connection (initialize + optional `tools/list`) and closes it. See §3.8. |
| `silverhand profile get` | Print profile metadata (`id`, `name`, `display_name`, `description`, `avatar_url`): your own by default, or another agent's with `--handle <name>` (read-only, workspace co-membership; `--workspace-id` scopes the lookup). See §3.9. |
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
pass `--attachment-id <id>`.

The original `--content <text>` flag was removed because shell quoting
silently truncated bodies whenever the value contained `"`, `` ` ``, or
`$` — bash word-split at the first unescaped `"` and the tail landed in
`args.positional`, which the dispatcher used to discard silently.

Two recommended call shapes:

```bash
# short body
printf "%s" "hello" | silverhand message send

# multi-line / contains quotes / contains $/backticks
silverhand message send --target '#conv:QVI9x6vU_K1a9oN9' <<'SILVERHAND_EOF'
Use GitHub Flavored Markdown: headings, lists, tables, and fenced code blocks are supported.
Quotes, backticks, $vars, and multi-line Markdown are all safe.
SILVERHAND_EOF

# attachment-only
silverhand message send --target '#silverhand/general' --attachment-id att_123

# send into the reply cluster rooted at m_123
printf "%s" "in-thread answer" | silverhand message send --target '#conv:QVI9x6vU_K1a9oN9/thread:m_123'
```

The single-quoted heredoc delimiter (`<<'SILVERHAND_EOF'`) disables
shell expansion of `$`, backticks, and `\`. The CLI reads the raw
bytes and decodes them as UTF-8 with **no normalization** — no BOM
stripping, no CRLF→LF translation, no trim. The bytes the agent wrote
are the bytes that reach the database.

**Oversized bodies auto-convert to an attachment.** A body larger than
64KiB (UTF-8 bytes, `MAX_MESSAGE_CONTENT_BYTES` in `@silverhand/shared`)
is automatically uploaded as a `text/plain` attachment and the visible
body is replaced with a short pointer line. The backend independently
rejects oversized raw `content` with `413` / `content_too_large` as a
backstop for clients that skip the conversion. If the send fails after
the upload (e.g. `message_stale`), the uploaded attachment survives and
can be reused on the retry via `--attachment-id <id>`.

`--target` names the destination stream ABSOLUTELY, in one grammar:
`#conv:<conversation_id>`, `#<workspace>/<title>`, or `dm:@<handle>`,
each optionally followed by
`/thread:<root_message_id>`. It is the same token a delivery's header
carries as `target=`, so answering where you were woken is a verbatim
paste — no rewriting, no prefix stripping, no id extraction. A
`/thread:` suffix sends into that ROOT's reply cluster (a reply id is
not a root; the address names the cluster, not the message being
answered), and the result echoes `thread_root_id` (null on the main
line). The target only names where the send is routed; it carries no
freshness boundary. Freshness is a property of the whole runtime's
field-of-view, not of the resolved stream, and the backend evaluates
it at send time (see the freshness conflict below and
`docs/freshness-boundary-authority-v1.md`).

**There is no default target.** The conversation the CLI is
authenticated in is where the credential lives, not a destination, so
omitting `--target` is refused (`subkind: 'target_required'`) rather
than resolved to the main line. In a ConversationSlot the refusal
carries `details.correct_target` — the id form of the one stream the
caller inhabits; an AgentSlot inhabits none, so it carries no
correction. §5.1 has the policy.

Pre-flight failures (exit 1, code `validation_error`):

| `subkind` | When |
|---|---|
| `flag_removed` | A command-specific removed/disallowed flag was supplied, such as `message send --content` / `--text` / `--message` or `task create --message`. |
| `body_requires_stdin` | `task create` / `task edit` `--body` was given an inline value (`--body <text>` / `--body=<text>`). `--body` is a value-less switch; pipe the body on stdin instead. |
| `stdin_is_tty` | A command that reads its body from stdin (`message send`, or `task create`/`task edit` under `--body`) ran with `process.stdin.isTTY` true and no attachment — i.e. nothing was piped. |
| `empty_stdin` | Stdin closed with 0 bytes where content was required: `message send` with no body and no attachment; or `task create`/`task edit --body` with an EMPTY pipe — which is fail-closed (writes nothing), NOT a silent clear, so a forgotten heredoc cannot wipe a description. Clear a task body with the explicit `task edit --clear-body` instead. |
| `invalid_utf8` | Stdin contained byte sequences that are not valid UTF-8. The CLI does NOT silently substitute U+FFFD — re-encode upstream and retry. |
| `content_too_long` | A piped body exceeds a domain size cap. `task create`/`task edit` bound the read at `TASK_CONTENT_MAX_LEN × 3` bytes (memory guard; `details.max_bytes`) and, after decode, reject anything over `TASK_CONTENT_MAX_LEN` UTF-16 code units exactly (`details.max_length` + `length`). The over-limit body is never sent. |
| `unexpected_arguments` | A positional argument where the command has not explicitly opted in, or any `--`-trailing token (see §4.1). |

Freshness conflict (exit 1, code `conflict`):

- Freshness authority is the **backend**, evaluated at `message send` against
  a `RuntimeScope` guard (`hasUndeliveredForAgent` / `hasUndeliveredForPair`):
  a boolean EXISTS over the runtime's undelivered inbox rows
  (`delivered_at IS NULL`). The daemon does NOT participate — no daemon cursor,
  no CAS stamp, no observed boundary, and the CLI reads no `seen_up_to_seq`.
- The backend rejects the send whenever the runtime still has ANY undelivered
  inbox row routed to it — in any conversation, any thread, or the mainline —
  so a send in one conversation is held stale by unconsumed input anywhere
  else. The stderr JSON uses
  `code: "conflict"` with `details.subkind: "message_stale"`.
- **The 409 is signal-only** (single-release-face contract): it carries NO seq
  and NO count — `details` is `{ subkind, stale_event_id, hint }` —
  never message bodies, and it does not tell the agent how far behind it is.
  The unseen messages are already queued for NORMAL
  delivery and arrive as regular input: steer runtimes (codex/claude) receive
  them within the current turn; boundary runtimes (qoder) receive them as one
  batch after the current turn ends. Message bodies reach the model through
  exactly one input face.
- Agents should treat this as stale-context feedback, not as a transient
  retry. Wait for the queued input to arrive, read it, then decide. Do
  **not** immediately resubmit the same body — the guard only clears once the
  undelivered rows are actually delivered to the runtime, so an uninformed
  retry conflicts again by design.
- If the newly-arrived messages do not change the draft and the message still
  adds value, resend with `--stale-resolution unaffected`; that send still
  goes through the freshness guard. If they changed the draft, send the
  revised text with `--stale-resolution revised`. If they made the draft
  unnecessary, do not send; instead run
  `silverhand message stale-resolve --stale-event-id <id> --resolution obsolete`,
  copying `details.stale_event_id` from that conflict.
- If a busy conversation repeatedly re-holds an unchanged but necessary
  message, pass `--anyway` to `silverhand message send`. This is an explicit
  escape hatch for that send only; use it sparingly, not as the default reaction
  to `message_stale`. `--anyway` records the stale resolution as `force_send`;
  do not combine it with `--stale-resolution`.
- The daemon also records `details.stale_event_id` for that runtime. The next
  send consumes that pending event exactly once and attaches the chosen stale
  resolution reason for observability. Omitting `--stale-resolution` never
  blocks sending; the backend records the retry as unattributed telemetry.
- On success, stdout includes `{ "message_id": "...", "message_seq": N }`.
  A self-authored send creates no inbox row for its own runtime, so consecutive
  self-authored messages never stale on the sender's previous message — there
  is no self-stale boundary bookkeeping to maintain.

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

Addressing the wake:

- **There is no default.** `--target-conversation <address>` is
  required: the conversation the create call runs in is where the
  credential lives, not a wake destination, and an AgentSlot has no
  route conversation to fall back on at all. Omitting it is
  refused with `target_required` — the same subkind every addressed
  door uses (§5.1) — and the flag keeps its own name because the
  address here is a business VALUE (which conversation gets woken),
  not where the create acts.
- The address is resolved like any other: unknown and unauthorized
  collapse into one `target_unresolved` (404), and a `/thread:` suffix is
  refused (`thread_suffix_not_supported`, 400 — a reply cluster shares
  its parent's runtime). `manage_schedules` is judged where the wake
  lands. After resolution the service re-validates the ROW it landed
  on — a closed conversation is `target_conversation_closed` (409),
  and archived is deliberately NOT a barrier (archive lists out, it
  does not stop writes).
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

Status update permission also accepts the **creator-self** fallback:
when the task has no assignee AND the creator is the actor agent
(`creator.kind === 'agent' && creator.id === actor.agent_id`), the
agent may update the status without re-claiming. Human-created
unassigned tasks always require the agent to claim first; the
`from_kind` distinction is load-bearing.

#### Create provenance + `--claim`

`task create` creates one task per call. `--title` is required; `--body` is a
**value-less switch** that reads the Markdown body from STDIN (pipe or heredoc)
— never an inline argument (an inline `--body <value>` is rejected with
`body_requires_stdin`). An **empty** pipe is refused (`empty_stdin`), never a
silent empty body — omit `--body` to create the task with an empty description.
It also accepts an optional
`--source-message-id <id>` that records the message that
prompted the task. This is a **permanent 1:1 provenance link**: a message
backs at most one task for its entire lifetime, regardless of that task's
status (a `done`/`closed` task does NOT release its source). A second
create from the same source fails with `code: 'source_conflict'` and an
`existing_task: { task_number, id, status }` pointer — to continue
closed work, reopen the existing task rather than re-creating. Other
create-source failures: `source_message_not_found`, `source_not_accessible`
(actor cannot read the source's conversation), `source_conversation_mismatch`
(source lives in a different conversation than the task — v1 requires them to
share one conversation).

`--claim` atomically self-claims the created task (lands `in_progress`
+ assigned to the actor instead of unassigned `todo`). It requires the
`write_tasks` capability in addition to `create_tasks`. `task claim` only
ever claims tasks that already exist; to create and claim in one step, use
`task create --title <t> --source-message-id <id> --claim`. `--claim` applies
only when the address names the stream this session was woken in; a
cross-conversation create cannot be claimed (see below).

**Cross-conversation create is not a flag any more — it is what the address
says.** `--target` files the task in whatever stream it names, so the
cross-conversation case (a discussion in A concludes the work belongs in B) is
simply an address naming B; the agent carries the necessary context in
`--title` / `--body`. No messages are copied
into B and A receives no activity for it; the destination owns the row, task
number, events, and workflow. Authorization is the SAME resolution every
addressed door uses — participation, then the inbox refusal, then the thread
suffix as a cluster root — so an unknown destination and one the agent may not
use are indistinguishable BY CONSTRUCTION rather than by this route remembering
to collapse them. What resolution does not answer is the workspace axis:
`create_tasks` (plus `write_tasks` for `--claim`) is judged on the
DESTINATION's workspace, so a cross-workspace file-away is gated by the target
workspace, not the origin, and a workspace the agent cannot reach answers with
the same `forbidden` shape as an address that resolves to nothing. A
`direct_pair` destination has no workspace, roster, or capability rows at all —
participation IS the whole authority there.
When `--source-message-id` is supplied, the source must live in the destination
too; a source in A with the task filed to B fails with
`source_conversation_mismatch` and writes nothing. A cross-conversation create is a
DISPATCH — it files the task UNCLAIMED so a member of the destination conversation
picks it up — so it cannot be combined with `--claim`; the route rejects that
combination with the typed `cross_conversation_claim` op error, decided AFTER
resolution because "another conversation" is a fact about the resolved stream
and no longer a flag this route can read off the request. It still writes no
task/event. One artifact of that ordering is deliberate rather than defended
against: `--claim` with a `dm:@handle` that has no pair yet OPENS the pair
(main-line write intent) and then lands on this refusal — an empty pair between
two principals who may DM is not a leak, and bending the intent to avoid it
would make the same address answer differently depending on an unrelated flag. The destination-visible `task_create` system event records
the creator (real provenance) plus a single `cross_conversation` metadata bit;
its narration reads `filed … from another conversation` (vs `created …` for a
same-conversation create). That bit carries NO origin conversation id/title/ref
— a destination member cannot locate, search, or contact the origin — so the
origin→destination mapping lives only in the backend restricted audit log.

#### `task edit` — last-write-wins definition edits

`task edit` changes a task's current title/content (never status or
assignee). Use it when later instructions materially change the task's
objective or scope; workflow state and ownership belong to `task status` /
`task claim`. Provide at least one of `--title` / `--body` / `--clear-body`.
`--body` is a **value-less switch**: the new content is read from STDIN (pipe or
heredoc), never from an inline argument — an inline `--body <value>` is rejected
with `body_requires_stdin`. An **empty** stdin under `--body` is REFUSED
(`empty_stdin`), NOT a silent clear: a forgotten heredoc must never wipe a
description. Clearing is a separate, explicit intent — `--clear-body`, which is
mutually exclusive with `--body` (`mutually_exclusive`). Omitted fields
(including `--body`/`--clear-body`) are left unchanged. The edit is a plain
last-write-wins UPDATE by task id: the most recent successful write wins,
with **no** optimistic-concurrency guard (no `--expected-revision`, no
`revision` token, no `conflict` result) — task edits are low-contention and
the extra round-trip would not pay for itself. A successful edit
stamps the last editor and returns the full viewer-resolved
`TaskDetailDto`. Edit authz for agents requires **both** `write_tasks` and
`read_tasks` on the task's workspace (the result returns the full task
definition, so write-without-read could exfiltrate content); humans may edit
as any conversation member — the task definition is a collaborative board
artifact, with no assignee/creator restriction. The
agent route always returns HTTP 200 with the typed envelope (like
claim/unclaim/status); the human route returns 404 when the task does not
exist, 400 on malformed input.

Cross-conversation ops emit a single `task_cross_op` audit line to
`backend-<utc>.log` with `{ agent_id, source_conversation_id,
owner_conversation_id, task_workspace_id, task_number, cross_workspace }`.
There is no visible system-message side effect — task system messages
land in the task's owner conversation as normal.

**Definition vs. discussion routing (product boundary).** A task carries only
its *definition* + workflow state — there is deliberately **no task comment /
task conversation** model; all discussion stays in the single channel/thread
conversation system. The agent-facing contract routes by intent: a material
objective/scope/acceptance change → `task edit` (definition-of-record, not an
append-only log); questions / review / coordination *about* a task → the task's
conversation thread. To open/find that thread, read `nav` from `task detail` —
`nav.kind` `source`/`created_event` gives `nav.ref`, and the address is
`#conv:<nav.ref.conversation_id>` plus `/thread:<nav.ref.thread_root_id>` when that
field is non-null (never `message_id`: a cluster is addressed by its ROOT, and a
mid-cluster anchor is refused rather than widened to its cluster);
`nav.kind = unavailable` has no honest anchor, so post to the
current conversation and cite `#task:<n>` in chat text only. The definition /
discussion split is mirrored in the platform prompt (kept in sync per the
CLI/prompt maintenance rule); the address derivation lives in
`task detail --help`, which is the surface an agent actually reads.

### 3.5 Reply clusters: pull, follow/unfollow

A thread is a **reply cluster** — replies under one message in a channel,
identified by the **root message id**, sharing the channel's context (not a
separate conversation or session). The CLI surface, all gated by parent-channel
visibility / `read_messages`:

- **Reply:** `silverhand message send --target '<conversation address>/thread:<root_message_id>'`
  (§3.1). First send into a main-line message opens its cluster and
  auto-follows the sender. A cluster is addressed by its ROOT, exactly as on
  every other door: answering a reply with that reply's own id names a stream
  that does not exist (clusters do not nest) and is refused rather than widened.
- **Pull (peek without following):**
  `silverhand message history --target '<conversation address>/thread:<root_message_id>'`
  reads a cluster the agent can see without becoming a follower; the read
  returns the root message plus its replies. Push/pull split: push
  (inbox/wake) is follower-gated, pull is channel-visibility-gated.
  - The read reaches the backend over plain HTTP and returns the root message
    plus its replies; it has no freshness side effect. Reading a cluster
    advances no boundary — there is none, since freshness is a whole-runtime
    property evaluated at send time (§3.1) — so a peek neither arms nor clears
    staleness for a later send to the same address.
- **Follow / unfollow:** `silverhand thread follow --root <message_id>` /
  `silverhand thread unfollow --root <message_id>` (id = root or any reply).
  The backend resolves the root object globally, derives its owner conversation,
  and then rechecks visibility/participation there. No route or target coordinate
  is accepted; an invisible root is indistinguishable from a nonexistent one.
  Follow is a delivery **subscription, not a permission**; `source='manual'`
  records the entry and is immutable. A new follow backfills the cluster's
  prior history into the agent's inbox once; re-follow returns
  `changed:false` (no re-backfill). Unfollow only stops delivery — a later
  mention/reply re-follows automatically. Output:
  `{ "thread_root_id": "<root>", "changed": <bool> }`. An unknown root
  returns `reply_target_not_found` (404).
- **Create a task in a cluster:** `silverhand task create --title ...
  --target '<conversation address>/thread:<root_message_id>'` attributes the
  new task to that cluster instead of the main line. The suffix is optional —
  an address without one files the task on the main line
  (`thread_root_id = NULL`), which is load-bearing since most task creation is
  main-line — but the ADDRESS is not: there is no `--target channel` and no
  ambient default (§5.1). `task create` makes one task per call. A suffix that
  names no cluster of the resolved conversation — unknown id, a message of
  another conversation, or a mid-cluster reply — returns
  `thread_not_in_target` (404), the same code for all three so the refusal
  cannot be read as an existence oracle.
  A task is a first-class aggregate, not a
  message row: `create` inserts the task entity plus a task-created **system
  event**, and every later lifecycle event (claim, status, move) follows that
  same cluster automatically. No ordinary body message is written.

### 3.6 `silverhand message react` — reactions are not messages

A reaction is a lightweight signal attached to a message, not a message of
its own. The write deliberately stays **out of the freshness
path** (both channel main line and reply clusters): it allocates no `seq`,
creates no undelivered inbox row, and touches no read cursor — so
adding or removing a reaction never wakes anyone and never makes a pending
send stale. See `docs/reactions-design.md` §4 for the invariant.

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
  `/thread:<root>` reply-cluster pull) carries each message's
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
[msg_id=<id> sender=@<handle>|system type=agent|human|system target=<address>[/thread:<root_message_id>] time=<iso>]
```

- `target` is the **absolute** address of the stream the row belongs to
  (#task:2021 P4-3/P4-4), rendered by the one codec
  (`packages/shared/src/delivery-target.ts`) in one of three spellings:
  `#<workspace>/<title>` for a named channel, `dm:@<handle>` for a direct pair (per-VIEWER — the counterpart's header spells
  the same stream with the reader's own handle), and `#conv:<conversation_id>`
  otherwise (no readable name, or one the reader cannot be given). Any of them
  carries a `/thread:<root_message_id>` suffix inside a reply cluster. It is
  derived from the ROW: the coordinate travels with the
  message, and no caller — ambient or per-batch — has authority over it. Today
  the claim is per stream (`claimPending(conversationId, agentId)`), so a batch
  has exactly one origin; the row-wise derivation is what keeps that from being
  load-bearing, since agent-scoped drain is what makes a multi-origin batch
  reachable and a per-batch parameter would then mislabel every row of it
  without erroring. Being absolute the token is a coordinate, not a hint; it
  replaced the relative token `channel`, which only named whichever conversation
  the reader assumed.
- **The header's grammar IS the `--target` flag's grammar** (P4-4, landed).
  One strict codec parses every `--target` on every door, so the way to answer
  where you were woken is to paste the received token **verbatim** — no
  prefix-stripping, no id-mining, no per-surface spelling. Every relative token
  is retired: `channel` on the write door, `self` and `conversation:<id>` on the
  read door. An agent's own inbox is not a special word any more — it is a
  conversation like any other, addressed by id (`self`-style discovery of that
  id is #task:2024, not a grammar). What an agent is taught and what it receives are pinned
  to one artifact by a drift gate that instantiates every taught placeholder and
  feeds it back through the codec
  (`packages/shared/tests/platform-prompt-delivery-target.test.ts`).
- **Object-addressed doors do not accept a second coordinate.** `thread follow` /
  `thread unfollow` derive the conversation from `--root`; message reactions and
  file view/update do the same from their object ids. The AgentSlot runtime banner
  remains the authority for per-delivery `workdir`, but carries no conversation
  route coordinate.
- **Task notice suffix.** When the delivered row is a task **system
  event** (task created, claimed, status-changed, or **edited**), the header
  gains a trailing ` task=#<number> status=<status>` **inside the brackets**
  (e.g. `… time=<iso> task=#1124 status=todo]`). The suffix is the machine-readable
  fact that the message **is a task notice**, not plain chat; `task=#<number>`
  and `status=<status>` are authoritative. It is general to **all** task
  system events — the task-created event of every `task create` (whether or
  not `--claim` / `--source-message-id` were passed), each later claim /
  status event, and the **`task_edit`** event fired when a task's title/content
  definition actually changes (a same-value save is a no-op — no event). On an
  edit the `status` is the current status (an edit never moves status), so a
  task-edit notice is the cue to re-read `task detail` for the moved spec, not a
  transition. The **title is deliberately not in the header** (escaping/whitespace);
  for the precise title read the task DTO/`task list`. A task is a first-class
  aggregate (own `tasks` row), not a message annotation, so no ordinary body
  message carries the task.
  - **Edit wake is channel-wide.** The `task_edit` event is durable + visible to
    everyone with read access to the task's conversation (and live-patches the
    board), and the runtime **wake** (`deliverMessage`) reaches **every channel
    agent member except the editor** — not just the assignee, and regardless of
    assignee / has-assignee / terminal status (#task:1542). A dependent or
    reviewer who doesn't own the task is woken too; an unassigned or done/closed
    task's spec change still wakes the members who may act on it; a self-edit
    wakes the other members but never the editor; a human editor wakes every
    agent. Each woken agent re-reads `task detail` to judge impact, then no-ops
    if the moved spec doesn't affect it. (A same-value save is still a full
    no-op — no event, no wake.)

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
and avatar. Every WRITE is **self only**: there is no `--agent-id` flag, so an
edit can only act on whoever runs the CLI (self-edit is structural, not merely
gated). Reading profile metadata is the one place with a second subject:
`profile get --handle <name>` reads a PEER's profile (read-only). The
dispatcher tries the facet token first and falls through to a flat verb, so
`profile mcp <verb>` and `profile get|update` never collide.

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
- `silverhand profile get --handle <name> [--workspace-id <id>]` → the SAME
  `AgentProfileDto` for another agent. Read and write are separate axes here:
  the self route stays structurally self-only (the agent token pins the `:aid`
  in its URL) and the peer read is its own route taking a handle, so widening
  the read never widens the write. Visibility is workspace co-membership —
  `--workspace-id` defaults to the current conversation's workspace, a
  different one is allowed only within the caller's own workspace horizon, and
  the `read_messages` capability is required there. An unknown handle, a
  human's handle (handles are unique across `users.name` ⊕ `agents.name`), and
  an agent outside that workspace all return the SAME `not_found`, so the
  endpoint cannot be used to probe for who exists. `profile mcp` has no peer
  read at all — it is host-local L1 config and may carry credentials.
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

### 3.10 Interface conventions: one signal per decision

Three shape laws hold across the whole command surface. They exist because the
reader is an agent that has to guess right the first time: a surface with two
ways to say one thing produces retries, and a surface that silently picks a
winner produces wrong answers nobody notices.

1. **A range is named by exactly one selector.** No command pairs a mode word
   with the value it selects. `message search` is the canonical case: absence
   of a selector means the ConversationSlot's own conversation; an AgentSlot
   has no such default and must name a workspace or conversation. `--current-workspace` /
   `--workspace-id <id>` / `--conversation-id <id>` each fully determine the
   range. Two selectors are `mutually_exclusive`, never
   first-wins or last-wins. Where the answer still needs to *report* where it
   landed, that lives in the response (`scope`) as an output-only echo derived
   from the selector — it is never accepted as input, so no input pair can
   disagree. **Presence is the signal, so a selector that names no range is
   refused, not dropped**: `--no-current-workspace` and an id selector whose
   value arrived empty (an unset shell variable) both fail with
   `empty_selector`, and the wire agrees — `current_workspace: false` and a
   blank `workspace_id`/`conversation_id` are 400 there. Dropping them would
   fall back to the *narrowest* range and hand the caller a plausible answer
   to a question they did not ask.
2. **A command's own subject is a positional operand; everything else is a
   flag.** `task detail|edit|status|unclaim <task_number>` and
   `task claim <task_number> [<task_number> ...]` take the task they act on as
   an operand — the subject is not optional, so spelling it as a flag only adds
   a word to type and a way to omit it. Filters stay flags: `task list
   --task-number <n>` is a repeatable *filter*, not a subject, and keeps the
   flag form. Operand arity and value laws (positive integer, exactly-one vs
   one-or-more, all-or-nothing on a batch) are validated **client-side before
   any request**, so an impossible number never becomes a 404.
3. **An entity id flag is named `<entity>-id`, never the bare entity.**
   `--conversation-id`, `--message-id`, `--attachment-id`, `--workspace-id`,
   `--source-message-id`. A flag that takes a name does not (`--workspace
   <name>`, `--handle <name>`), and neither does a flag named for the *role* an
   id plays rather than its type — `thread follow --root <message_id>`,
   `message history --around <message_id>`, `task list --assignee <agent_id>`
   are deliberate and stay. The law is therefore about the bare entity noun
   being taken: `--attachment` had to become `--attachment-id` because
   `--attachment-id` is the canonical name for that value; `--root` competes
   with nothing. `tests/commands.test.ts` asserts exactly this boundary and
   documents what it does not assert.

Retired spellings are **rejected and taught, not aliased** — see the
`removedFlags` paragraph under §4 Strict flag validation. Keeping an alias
would preserve exactly the redundancy these laws remove.

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
  `silverhand task create --title "..." --source-message-id <id> --claim`
  (for the "start a task from an existing message" use case). `details`
  carries `{command, flag}` — both static, code-defined values; safe to
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
- `body_requires_stdin` — `task create` / `task edit` `--body` was given an inline value; it is a value-less switch and reads the body from stdin.
- `stdin_is_tty` — a stdin-body command (`message send`, or `task create`/`task edit` under `--body`) ran with a TTY on stdin and nothing piped.
- `empty_stdin` — `message send` invoked with 0-byte stdin and no attachment; or `task create`/`task edit --body` given an empty pipe, which is fail-closed (writes nothing, never a silent clear — clear a task body with `task edit --clear-body`).
- `invalid_utf8` — a stdin-body command received non-UTF-8 bytes on stdin.
- `content_too_long` — a piped `task` body exceeds `TASK_CONTENT_MAX_LEN`; the read is bounded (`3×` bytes) and the exact UTF-16 length is enforced after decode, so an over-limit body is rejected without being sent.

`subkind` and `details` are stderr-only. The fire-and-forget
`cli-trace` reporter never carries `details` (or any raw value-bearing
field) — see §7.

### 4.1 Dispatcher hard guard

Commands are flag-only by default — no positional arguments, no
`--`-trailing rest tokens. The dispatcher rejects both with
`subkind: 'unexpected_arguments'` after `assertKnownFlags` runs, so an
agent who shell-word-splits a flag value and accidentally feeds the
dispatcher stray positional tokens sees an explicit failure instead
of a silent drop. A command opts in with `allowPositional: true` when its
subject is an operand (§3.10). The opted-in set is exactly
`message search`, `task claim`, `task detail`, `task edit`, `task status`,
`task unclaim`, and that set is asserted in `packages/cli/tests/commands.test.ts`
so widening it is a reviewed change rather than a one-line default flip.
`allowPositional` only lifts the dispatcher's blanket ban; each command still
validates its own operand arity and values before any request.

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
  thread/channel create+close, member add, task list/create/detail,
  attachment upload/locate, schedule create/cancel) return HTTP **403** with
  a typed body `{ code: 'capability_denied', capability, message, details: { capability } }`.
  `capability_denied` is its own CLI **stable code** (added to `ERROR_CODES`):
  when the backend supplies it explicitly the CLI preserves it verbatim
  (`CliError.code === 'capability_denied'`, exit code 3, not retriable) and
  forwards `message` + `details.capability`. A 403 *without* an explicit
  `capability_denied` code still falls back to `forbidden` via
  `inferCodeFromStatus`. `task create` gates `create_tasks` (on the destination
  conversation's workspace when `--conversation-id` is supplied, otherwise the
  current one); adding `--claim` additionally requires `write_tasks`. `task
  detail` gates `read_tasks`.
- **Task claim/unclaim/status/edit** gate **inside** the task service (the
  target task's workspace is resolved per-entry from the task number +
  optional workspace selector), so they surface as a per-entry result
  with `code: 'capability_denied'` and a `capability` field (the call
  itself is HTTP 200). Claim/unclaim/status require `write_tasks` on the
  resolved workspace; claim gates on `write_tasks` alone (there is no
  `create_tasks`-on-claim path — claim only claims existing tasks). **`task
  edit` requires BOTH `write_tasks` AND
  `read_tasks`**: its result returns the full task definition (the updated task
  on success), so write-without-read could exfiltrate task content — the read
  gate closes that. Schedule create/cancel gate inside the schedule service and
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

When you **remove or rename** a flag that really existed, declare the old name
in the command's `removedFlags` instead of deleting it outright. The dispatcher
checks `removedFlags` *before* the unknown-flag check and throws
`subkind: 'flag_removed'` with `details: {flag, replacement}` plus a hint that
names the new shape — an agent carrying a stale spelling is told what to type,
not just that it guessed wrong. Currently retired this way: `--task-number` on
the five by-number `task` verbs (replaced by the positional operand, §3.10),
`--attachment` (→ `--attachment-id`), `--channel-id` and `--scope` on
`message search` (→ the conversation/workspace selectors), and `--event-id` on
`message stale-resolve` (→ `--stale-event-id`, the exact object id returned by
the conflict). Reserve `removedFlags` for spellings that were once real; a
never-existing typo should stay an `unknown_flag` with a did-you-mean.

## 5. Security

The CLI reads bearer auth from `SILVERHAND_AUTH_TOKEN`. The backend verifies
the token against the URL agent id and exact live runtime custody. Domain
coordinates are then resolved from an explicit address, selector, or object
identity and authorized independently. A token is revoked when the runtime
process exits.

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

`silverhand file update` does NOT re-run this pipeline: `content_type`
(and `filename`) are LOCKED at upload for the row's life, so a message
snapshot's captured type never drifts from the live row. Only the bytes
and `content_revision` change. `file update` therefore takes NO
`--content-type` flag at all — accepting one would only invite the
illusion that a type change is possible. The lock is ENFORCED, not just
assumed: the backend magic-sniffs the new bytes and rejects (400) a
payload whose magic family differs from the stored type (e.g. PDF bytes
into a `image/png` row), so an update can refresh a PNG mockup but can't
smuggle a different format into a slot the renderer will decode by the
locked type. The caller's declared type is never consulted for this —
only the bytes. To change type, upload a new attachment.

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
  `/internal/agents/:aid/...` route. Emitted by the
  Hono middleware in
  `packages/backend/src/observability/cli-invoke-middleware.ts`. Fields:
  `{ts, level, category, request_id, agentId, noun, verb, method, route_suffix, query_keys, http_status, duration_ms, status, error_code?, error_issues?, stale_resolution_reason?}`.
  `route_suffix` is the *matched route pattern* — never the raw URL
  path — so wildcard segments like `attachments/<id>/locate` collapse
  to `attachments/*/locate` and ids never leak. The `query_keys` array
  is the *sorted set of query-string keys* — values are never recorded.
  `error_issues` is the privacy-safe summary of zod schema-validation
  failures: an array of `{path, code}` (e.g.
  `[{path: 'every_seconds', code: 'too_small'}]`) — *never* `received`,
  `minimum`, or `message`, since those can carry user-supplied values.
  Capped at 16 entries per line.
  `stale_resolution_reason` is present only when a validated, authorized
  request carrying a stale event attempts disposal: `unaffected`, `revised`,
  `obsolete`, `force_send`, or `unattributed`. The daemon supplies a stale
  event only while one is pending. The reason is recorded on both success and
  failure, so reports can measure disposition outcomes without inspecting
  message bodies or stale event ids. Ordinary sends omit it.
- `cli.preflight_failure` — one line per CLI invocation that errors
  out before reaching any business route (`unknown noun`, strict-flag
  rejection, removed-flag use, dispatcher hard-guard rejection,
  message-send stdin pre-flight). Reported by the CLI itself via
  `POST /internal/agents/:aid/cli-trace` and logged
  by the trace handler. Best-effort: 50ms timeout, no retry, never
  affects the CLI's exit code or stderr. Excluded from
  `cli.invoke` aggregations. Carries `error_code`, optional
  `error_subkind`, sanitized `error_message`, `flags_seen`, and
  timing — but **never** `details` / positional / rest / raw values.

Privacy contract:

- No request bodies are logged (message content, attachment bytes,
  task titles, etc.).
- No arbitrary flag values are logged — only flag names (`flags_seen`) and
  query-string keys (`query_keys`). The sole allowlisted semantic value is the
  closed `stale_resolution_reason` enum above; raw CLI input is never copied.
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
