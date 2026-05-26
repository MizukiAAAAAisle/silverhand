# Orchestration boundary — V1 (D2.0 design pass)

**Status**: DRAFT Rev 1. D1 complete; D2.0 design pass while D1 soaks. No code change in this stage — this doc only locks the contract for where each responsibility lives in the V1 remote-backend topology. Revision 1 (2026-05-26) folds @Cindy's three blockers + one major + relocation map nits + closes Q1/Q2/Q3 in §8 per shiki/Cindy alignment; see §9.

**Predecessor docs to read first**:
- `docs/remote-server-target-architecture.md` — target topology
- `docs/auth-and-host-model.md` §7-§10 — host identity / token model
- `docs/remote-backend-roadmap.md` — V1 prep stage map (esp. D2.0 / D2 / D3)
- `docs/multi-daemon-registry.md` v5 status note — V1 vs future placement model
- `docs/silverhand-daemon-pr2-design.md` — current daemon intent surface

## 1. Guiding principle (LOCK)

> **Server owns authoritative data and control-plane state.** Any work that
> requires direct access to the user's machine — host filesystem reads/writes,
> spawn-file materialization, workspace/blob local path resolution, agent
> process env injection, child-process supervision — belongs to
> **daemon-host**. The server ships data and intent over protocol; the
> server does not pretend its container has filesystem access to the user's
> machine.

Accepted by shiki 2026-05-26 11:02. Wording by Cindy. This principle is
non-negotiable for V1 and binds every code-location decision in this doc.

## 2. Why D2.0 exists

D1 made backend a deployable Node server with embedded vs standalone modes,
but **kept all host-fs code in the backend package**. That works today because
embedded mode runs backend in-process inside Electron main, where Electron
*is* on the user's machine. The moment we deploy backend as a standalone
server (a remote container, a sandbox box, anywhere off the user's machine),
every host-fs call becomes a lie.

D2.0 names every such call site, decides which side of the boundary it
belongs on, and freezes the protocol intent that carries the work across.
D2 (durable intent queue) and D3 (daemon outbound transport) implement
against this contract. **Without D2.0 locked, D2/D3 become moving targets.**

## 3. Two-sided contract

### 3.1 Server-only (control plane)

Server owns and is the only writer of:

- Authoritative DB rows: `users`, `hosts`, `host_credentials`,
  `auth_sessions`, `password_credentials`, `agents`, `workspaces`,
  `workspace_users`, `conversations` (channel/dm/thread),
  `messages` (including `attachments` metadata + `notifications` +
  `saves`), `conversation_agents`, `agent_inbox`, `runtime_status`,
  `schedules`, `tasks`, `app_settings`.
- ACL evaluation, principal resolution, route handlers, WS scope event
  bus, session lifecycle, schedule scheduler.
- **Blob byte storage** (`~/.silverhand/blobs/`): server data dir per
  D1 layout, holds attachment / user-avatar / agent-avatar bytes. Server
  receives uploads, serves downloads, runs sweep/GC, mints
  attachment snapshots. Daemon-host never sees blob bytes in V1 main.
  (Future sandbox / daemon-local blob cache is a separate storage tier;
  see §5.1.)
- **Authoritative prompt-composition data** — the server is the
  conceptual owner of agent identity (`system_prompt.md` content),
  workspace memory (`MEMORY.md` content), and workspace consensus
  (`CONSENSUS.md` content). In V1 the bytes still live on daemon-host
  disk (embedded mode = same fs as server), but the contract is
  server-owned; D2.1 migrates the storage backend to DB without
  changing this contract (see §6).
- Intent issuance: when the server decides "agent X in conversation Y
  must wake", that decision is server-side.
- **Delivery payload composition**: `stream-json` user-message
  hydration from inbox rows (today: `formatInboxAsUserMessages` →
  `runtime_wake.payload`) — driver-protocol-aware data assembly is
  server-side; daemon only writes the assembled bytes to stdin. Same
  rule for `startup_delivery` on `runtime_start`.
- Run-state cache projection mirror: daemon is source of truth for
  per-host execution-plane state; server caches a projection for ACL'd
  HTTP / SSE consumers. (See §5.)
- SSE / event-bus fanout to renderers.
- Inbox row writes (`ensureDelivery`, `listPending`, `markDelivered`)
  — daemon never opens the inbox repo.

Server **must not**:

- Read/write the user's filesystem (no `node:fs` against user-machine
  paths — `workspace_path` / agent L1 (`~/.silverhand/agents/<id>`) /
  agent L2 (`<workspace>/.silverhand/agents/<id>`) / per-spawn shim dirs
  / driver-tool working dirs)
- Resolve workspace local paths (`workspace.workspace_path` is opaque
  from server's perspective; only the daemon-host knows the real
  on-disk path)
- Compose agent `process.env` (no `SILVERHAND_*` env synthesis bound
  to a daemon process; server ships an env *policy*, daemon applies)
- Spawn child processes or write per-spawn shim files
- In V1, server reads daemon-host disk for `system_prompt.md` /
  `MEMORY.md` / `CONSENSUS.md` only as a **D2.1-pre transitional
  shim** — see §6. The contract is: server is the conceptual owner;
  daemon never ships file content up to server.

### 3.2 Daemon-host-only (machine-local execution)

Daemon-host owns and is the only writer of:

- Per-host filesystem: `~/.silverhand/` (daemon logs, workspace
  roots, embedded-bootstrap file, host token, daemon socket, pid file,
  installation_id, per-spawn shim dirs). **Excludes** `~/.silverhand/blobs/`
  in V1 main (server data dir — see §3.1).
- Workspace materialization: creating `<workspace>/.silverhand/`
  directory tree, seeding agent L2 (`MEMORY.md` / `notes/` /
  `CONSENSUS.md` skeleton), resolving `workspace_path` from logical
  workspace id to absolute path on this host
- Agent L1/L2 fs mutation: `~/.silverhand/agents/<id>/system_prompt.md`
  + `MEMORY.md` + `notes/*.md` writes, `<workspace>/.silverhand/agents/<id>/`
  scaffolding, agent-deletion `fs.rm` of L1/L2 directories
- Spawn materialization: writing per-spawn `system-prompt.md`,
  `bin/silverhand` shim, deciding `process.env` composition, invoking
  driver CLI
- Agent process lifecycle: spawn, supervise, stdin write, stdout
  parse, stop/clear, run-state cache (source of truth, per host),
  activity log JSONL writer (PR-2 §4.2; activity-log file lifetime is
  daemon-bound)
- L1/L2/CONSENSUS **prompt-file materialization**: rendering daemon-local
  absolute paths into the per-spawn `system-prompt.md` and into prompt
  text that points the agent at workspace paths. **Data hydration**
  (reading the bytes) is server-owned per §3.1 — V1 has a transitional
  shim where the server reads daemon-local disk because they share fs.
- `notes/*.md` content lifecycle: notes are daemon-host local working
  storage for agent runtime (agent uses Read/Write tools at runtime).
  See §6 for the explicit decision and three guardrails.

Daemon-host **must not**:

- Issue ACL decisions (server is the gatekeeper; daemon receives validated
  intents only)
- Mutate authoritative DB rows directly (daemon talks protocol → server →
  DB; no direct DB connection from daemon process)
- Persist control-plane state beyond its own machine-local needs
  (installation_id, host token, run-state cache, activity log JSONL —
  none of these are "the durable record"; the server's DB is)
- Compose `stream-json` payloads for inbox drain or `runtime_wake`
  (server-owned per §3.1; daemon only writes the bytes it receives)
- Read or write blob bytes (V1 main; future sandbox tier may add a
  daemon-local blob cache, see §5.1)

### 3.3 Boundary crossings (the V1 protocol surface)

Every cross-boundary call is a typed intent. PR-2 already defines the
runtime-intent vocabulary in `docs/silverhand-daemon-pr2-design.md`;
this section reproduces the canonical shapes (preserving PR-2's
`(conversation_id, agent_id)` tuple identity) and locks them as the
V1 vocabulary. **Additions need an explicit D2.0 amendment, not silent
expansion in D2/D3 PRs.**

**Direction key**: "Req" = request from server, daemon replies with a
matching **response** (sync, single arm). "Event" = unsolicited from
daemon, no reply — server fans out via the activity log / SSE bus.

**Server → daemon requests (sync response):**

| Intent | Request params | Response arms |
|--------|----------------|---------------|
| `runtime_start` | `{ conversation_id, agent_id, options, startup_delivery? }` where `options` carries `model`, `reasoning_effort`, `fast_mode`, `cli_session_id?` + workspace bundle (§4.1) + session bundle (§4.0) + agent profile bundle (§4.2) + env policy (§4.3), and `startup_delivery?` carries the delivery bundle (§4.5) | `started` / `failed{reason}` |
| `runtime_stop` | `{ conversation_id, agent_id, reason }` | `stopped` / `not_running` |
| `runtime_clear_session` | `{ conversation_id, agent_id }` | `cleared` / `not_running` |
| `runtime_wake` | `{ conversation_id, agent_id, delivery_ids[], kind, payload }` where `payload` is the server-composed `stream-json` user-message bytes (see §4.5) | `delivered{delivery_ids[]}` / `failed{reason}` (all-or-nothing per PR-2 §4.3) |
| `runtime_status` | `{ conversation_id?, agent_id? }` (PR-2 filter shape; both optional — narrow by tuple, by agent, or none = host-wide) | snapshot of run-state cache projection scoped to this host |
| `runtime_stop_all` | `{}` (boot/shutdown sweep) | `{stopped_count}` + per-agent `runtime_exit` events |
| `runtime_close_activity_log` | `{}` (shutdown) | `ack` |
| `runtime_output_pause` / `_resume` | `{ conversation_id, agent_id }` (PR-2 §2.2; backend stays in always-flowing mode in v0) | ack |

**Daemon → server unsolicited events (no reply; activity log / SSE fanout):**

| Event | Payload | Notes |
|-------|---------|-------|
| `runtime_state` | `{ conversation_id, agent_id, state, ... }` | parsed run-state transitions |
| `runtime_output` | `{ conversation_id, agent_id, chunk }` | **droppable** (PR-2 §2.1); raw stdout/stderr |
| `runtime_exit` | `{ conversation_id, agent_id, code, signal, ... }` | child exit |
| `runtime_ready_for_drain` | `{ conversation_id, agent_id }` | driver-confirmed; server drives one batched `runtime_wake` against pending inbox |
| `runtime_startup_delivery_consumed` | `{ conversation_id, agent_id, delivery_ids[] }` | non-droppable; server then markDelivered |
| `runtime_startup_delivery_failed` | `{ conversation_id, agent_id, delivery_ids[], reason }` | non-droppable; server keeps rows pending |
| `runtime_output_dropped` / `_paused` / `_resumed` | flow-control bookkeeping | — |
| `shutting_down` | `{}` | daemon-initiated shutdown notice |

**V1 simplification**: embedded mode keeps server + daemon-host on the
same machine. The protocol surface is identical in standalone /
remote-deploy; the wire transport changes (D3), and any cross-machine
data dependency is named explicitly (the prompt-context fs reads in
§3.1 collapse via D2.1).

**What is NOT in the V1 surface** (deferred):

- `blob_locate` / `blob_upload_chunk` — Q1 decided server-side blob
  bytes for V1 main, so these intents have no consumer. They are
  candidate vocabulary for the future sandbox / daemon-local blob
  cache tier (§5.1), not V1.
- `runtime_inject_env` — explicitly out of PR-2 (§0); secret-routing
  needs its own design (Q3 → D3).

## 4. Data that crosses the boundary

When the server hands intent to the daemon-host, it must hand over
enough **data** that the daemon can do its job without reading
server-side state. This section names each bundle. Bundles are
versioned together with the protocol vocabulary in §3.3.

### 4.0 Session bundle (per spawn / wake)

The session bundle answers "which conversation, with whom, with what
parentage" — the data `buildPromptContext` consumes today to render
the platform prompt's session-context block. It rides on
`runtime_start.options` (and is implicit context for any subsequent
`runtime_wake` against the same conversation).

- `conversation_id`, `conversation_kind` (`channel` | `dm_channel` |
  `thread`), `conversation_title`
- `thread_parent_id?`, `thread_parent_title?` — populated when
  `conversation_kind == 'thread'`
- `spawned_by_agent_id?` — non-null when this thread was opened by
  another agent (drives the "agent-spawned child session" framing)
- `conversation_members[]` — ids + display names + handles + kind
  (agent / human) from `conversation_agents` × `membership` (NOT
  workspace_users; the prompt's "Members" list is conversation-scoped)
- `workspace_memory_index[]` — for this agent, every workspace it is
  a member of, with a label and a *logical* memory path token. The
  daemon renders the token to an absolute path locally (it owns the
  path map); the server only ships the workspace id + workspace kind
  + label so the daemon can compute "`<workspace>/.silverhand/agents/<id>/MEMORY.md`"
  vs "`~/.silverhand/agents/<id>/MEMORY.md`" for `agent_home`.

### 4.1 Workspace bundle (per spawn)

The workspace bundle is the per-spawn workspace context — distinct
from the session bundle because workspace data is stable across
conversations within a workspace.

- `workspace_id`, `workspace_kind` (`regular` | `dm` | `agent_home`),
  `workspace_name`
- `workspace_path_strategy` — a logical instruction for "where this
  daemon puts workspaces of this kind" (V1 local daemon already has a
  convention: `~/.silverhand/workspaces/<id>`); future remote daemon
  defines its own convention. Server never ships an absolute path.
- `consensus_text` — workspace `CONSENSUS.md` content, server-owned
  (V1 transitional shim reads from daemon-local disk because
  embedded mode shares fs; D2.1 moves to DB without changing the
  contract). Omitted for `agent_home` workspaces (single-member,
  no consensus to project).

Note: workspace bundle does **not** carry conversation members —
that lives in §4.0 (conversation-scoped), not workspace (workspace
membership is a different list and is not what the prompt's "Members"
block renders).

### 4.2 Agent profile bundle (per spawn)

- `agent_id`, `display_name`, `handle`, `runtime` (`claude` | `codex` | ...)
- `system_prompt_text` — content of L1 `system_prompt.md`,
  server-owned (V1 transitional shim; D2.1 → DB row
  `agents.system_prompt_text`)
- `memory_text` — content of active workspace L2 `MEMORY.md`,
  server-owned, capped at `MEMORY_INJECT_CAP_BYTES` (16KB) per
  current `readFileWithCap` contract (V1 transitional shim; D2.1 →
  DB row keyed `(workspace_id, agent_id)`)
- `role_pointer` — informational pointer back to the L1 file location
  on this daemon-host (so the prompt can say "edit
  `~/.silverhand/agents/<id>/system_prompt.md`"). The daemon renders
  the pointer locally; the server only ships the logical agent id.

**Runtime options** (carried on `runtime_start.options` alongside
this bundle): `model`, `reasoning_effort`, `fast_mode`,
`cli_session_id?`. These are listed here for completeness; they are
not "profile data" but per-spawn driver options.

**Explicitly NOT in this bundle**: `notes_index[]`. notes/ is
daemon-host local working storage; server does not enumerate or ship
the index (see §6 guardrail 1). If a future prompt block wants to
hint about notes, the **daemon** enumerates and renders locally.

### 4.3 Env policy (per spawn)

The server does NOT compose `process.env`. The server ships an **env policy**:

- `silverhand_vars` — `SILVERHAND_BACKEND_URL`, `SILVERHAND_AGENT_TOKEN`,
  `SILVERHAND_WORKSPACE_ID`, `SILVERHAND_CONVERSATION_ID`,
  `SILVERHAND_AGENT_ID` — values the server computes, daemon applies as-is
- `driver_vars` — driver-specific keys (e.g. `ANTHROPIC_API_KEY` policy:
  whose key, which model). V1 daemon-local fallback only (Q3); the
  server does **not** ship provider secrets to the daemon in V1. Any
  per-user secret routing is deferred to D3 alongside secret store /
  encryption / rotation / audit design.
- `path_prefix` — name of the per-spawn shim dir the daemon will create
  (daemon decides absolute path, server only knows the name)

The daemon merges policy into its own `process.env` + per-spawn shim
+ `driver.applyEnv()` (driver-specific env transform; daemon-side only,
never invoked on the server), spawns the child, wires stdin/stdout.

### 4.4 Blob bytes (server-owned in V1 main)

**Decision (Q1)**: blob bytes live server-side for V1 main.
`~/.silverhand/blobs/` is server data dir per D1 layout, not user
workspace fs. The boundary contract:

- Server receives uploads via existing routes (`AttachmentService.upload`,
  user avatar, agent avatar), calls `BlobFileStorage.put()`, stores the
  bytes under the server's data dir, mints an `AttachmentSnapshot`
  (id + filename + size + content_type — already the immutable
  embedded subset in `messages.metadata.attachments`).
- Server serves downloads via existing routes (`serveForViewer` /
  avatar fetch), reading the bytes back from its own data dir.
- Daemon never sees blob bytes. When a delivery payload references
  attachments, the server's hydrated payload carries the
  `AttachmentSnapshot[]` (metadata only); if the agent's driver tools
  later need to read the attachment file (e.g. `silverhand file view`),
  the resolution goes back through server HTTP, not through a
  daemon-local path.

Implication for `silverhand file view` in remote-deploy: returns a
server download URL (signed / ACL'd via existing routes), not a
daemon-local fs path. Embedded mode may keep the current
local-path-resolution shortcut as an optimization, but the contract
the agent sees is "URL or URL-like handle, fetch via http".

Daemon-local blob cache / sandbox blob tier is a future storage
optimization, not V1; see §5.1.

### 4.5 Delivery payload bundle (per wake / per startup_delivery)

`runtime_wake` and `runtime_start.startup_delivery` carry a delivery
bundle. Server-composed; daemon-opaque (daemon only writes bytes to
stdin).

- `delivery_ids[]` — inbox row ids covered by this batch. PR-2 §4.3
  all-or-nothing markDelivered rule applies.
- `kind` — one of `startup_delivery` / `channel_message` / `wake` /
  `system` / `schedule_fire` / `task_event` / `agent_message` / etc.
  Drives any per-kind framing the server's stream-json formatter
  applies.
- `hydrated_text` (a.k.a. `payload` on the wire) — the assembled
  `stream-json` user-message bytes. Server runs the existing
  `formatInboxAsUserMessages` (and per-driver framing) before sending.
- `attachment_snapshots[]` — `AttachmentSnapshot` records for any
  attachments referenced by the messages in this batch (id +
  filename + size + content_type, per `AttachmentSnapshotSchema`).
  Daemon does not resolve them; they ride along so the agent's
  rendered prompt block matches what the renderer shows.
- `driver_capabilities` — minimal hint set so the formatter knows
  which attachment kinds make sense to render (e.g. images for
  claude vision-capable models). Computed server-side from the
  agent's runtime + model.

V1 ships this bundle whether the embedded daemon needs it or not;
having the contract locked means D3 / remote-deploy doesn't need to
re-derive payload composition rules.

## 5. Code-relocation map

Modules in `packages/backend/src/` that touch host-local fs / spawn / env.
Each row names the V1 destination + the migration step (D2 / D2.1 / D3).

| Module | Today | V1 destination | Step | Notes |
|--------|-------|----------------|------|-------|
| `spawn-prep.ts` | backend writes per-spawn shim + system-prompt.md | **daemon-host** | D2 | Already isolated; backend wraps as `runtime_start.startup_delivery` payload + session/workspace/profile bundles (§4.0/§4.1/§4.2); daemon executes |
| `workspace-files.ts` | backend reads/writes workspace `.silverhand/` | **daemon-host** | D2 | Materialization moves to daemon; server ships workspace bundle (§4.1) |
| `agent-profile.ts` | path construction for L1/L2 dirs | **split** | D2 | Logical agent profile data + DTOs → server. **Daemon-local absolute/relative L1/L2 path rendering** (`activeAgentProfileDir`, `agentL1ProfileDir`, `agentMemoryDirFor`) → daemon. Server **never** renders a server-side path into anything the agent can use. |
| `agent-workspace.ts` | backend ensures workspace dir exists per agent | **daemon-host** | D2 | Pure materialization |
| `storage/blob-file-storage.ts` | backend `node:fs` blob R/W | **server (unchanged)** | — | **Q1 decision**: blob bytes are server data (§3.1 / §4.4). No relocation; the existing put/serve/locate/delete + sweep stays server-side. |
| `runtime/spawn-env.ts` | backend composes spawn env | **split** | D2 | Policy composition (§4.3, including `silverhand_vars` value computation) → server. `process.env` merge + per-spawn shim path + `driver.applyEnv(process.env)` invocation → daemon. **Server never invokes `driver.applyEnv`** — that's a daemon-side step against the daemon's own process env. |
| `runtime/prompt-context.ts` | backend reads L1/L2/CONSENSUS files + composes `DriverPromptContext` | **split** | D2 / D2.1 | **Data hydration & capping** (`readFileWithCap`, `MEMORY_INJECT_CAP_BYTES`, `CONSENSUS_INJECT_CAP_BYTES`, `buildWorkspaceMemoryIndex`) → server (in D2.1 reads from DB; V1 transitional reads from daemon-local fs). **Host-local prompt-file materialization & absolute path rendering** (writing the per-spawn `system-prompt.md`, rendering MEMORY.md path tokens to absolute fs paths) → daemon. Shared formatter helpers move to `packages/shared` so both sides use the same byte-identical assembly. |
| `runtime/activity-log-writer.ts` | backend writes activity JSONL | **daemon-host** | D2 | Already daemon-side under PR-2 (`runtime_output` events; daemon owns JSONL file lifetime); backend wrapper retires |
| `runtime/run-state-cache.ts` | in-memory cache server-side | **daemon-host primary**, server projection mirror | D2 | Daemon is source of truth (per host); server caches a per-host projection for ACL'd HTTP / SSE consumers. Server projection is rebuilt from `runtime_state` events; not persisted. |
| `runtime/daemon-agent-runtime-host.ts` | backend proxy to daemon | **server (unchanged)** | — | Server-side IPC client — correct boundary already |
| `runtime/daemon-runtime-wiring.ts` | backend wires daemon for embedded | **server (unchanged)** | — | Dynamic-import boundary stays; standalone mode skips this entirely |
| `runtime/control-plane-runtime-host.ts` | standalone fail-loud stub | **server (unchanged)** | — | Correct |
| `runtime/delivery-coordinator.ts` | backend orchestrates deliveries | **server (unchanged)** | — | Server-owned per §3.1. PR-2 §4.3 locks this. |
| `runtime/stdin-format.ts` (`formatInboxAsUserMessages`) | backend hydrates inbox rows into `stream-json` payload | **server (unchanged)** | — | Server-owned per §3.1 / §4.5. Driver-protocol-aware data assembly; daemon receives bytes and writes to stdin. |
| `runtime/status-projector.ts` | backend projects daemon snapshots into HTTP / SSE | **server (unchanged)** | — | Projection consumer of run-state cache (see above) |
| `auth/embedded-bootstrap.ts` | backend writes one-shot bootstrap file | **daemon-host** | D2 | File is host-machine-local; daemon owns write/read. Server issues the bootstrap token over protocol |
| `provision.ts` | backend creates workspace dirs / onboarding messages | **split** | D2 | Workspace **fs** materialization → daemon (via materialization intent). Onboarding **DB** row writes (inbox, conversation_agents, messages) → server. |
| `routes.ts` direct host-fs callers | `initWorkspaceDir`, `ensureAgentL1Dir`, `seedAgentL2` on workspace/agent create; `fs.rm` of L1/L2 on agent delete | **daemon-host** for fs ops | D2 | Route handler stays server (DB writes + ACL); fs side-effects become typed materialization intents to daemon (`workspace_materialize`, `agent_l1_seed`, `agent_l2_seed`, `agent_l1_rm`, `agent_l2_rm`) |
| `index.ts` boot direct host-fs callers | `mkdirSync(workspacesRoot)`, blob storage dir create, embedded CLI `existsSync/execFileSync` probe | **split** | D2 | Server data dir create (DB + blobs) stays server. Workspace root dir + embedded CLI probe → daemon-host (the runtime that will spawn the CLI). |
| `logger.ts` | reads `SILVERHAND_LOG_LEVEL` env, writes log files to `<data_dir>/logs/` | **split** | D2 | Server has its own log dir; daemon has its own. Today's backend logger conflates them |
| `db.ts` + migrations | reads/writes SQLite at `<data_dir>/silverhand.db` | **server (unchanged)** | — | Server is the DB owner; daemon never opens the DB file |

### 5.1 What's NOT in this map (deferred)

- Driver-specific env routing (e.g. per-user ANTHROPIC_API_KEY) — Q3
  → D3 scope, ties to secret storage + encryption + rotation +
  audit. V1 stays daemon-local file convention.
- **Future sandbox / daemon-local blob cache tier**. Q1 chose
  server-side blob bytes for V1 main; a future sandbox topology may
  want daemon-local blob cache (for prompt-context attachments
  consumed by the agent's filesystem tools without HTTP round-trip).
  At that point `blob_locate` / `blob_upload_chunk` re-enter the
  vocabulary together with upload commit/abort, serve stream,
  delete/sweep/GC, and avatar flow. This is **not** V1 surface;
  do not silently expand into it during D2/D3.
- Sandbox box type as a second daemon-host — addressed by
  `multi-daemon-registry.md` v_next; V1 has exactly one daemon per host.
- OAuth / invite / multi-tenant — out of V1 entirely.
- `notes/` portability across hosts — see §6 guardrail 3.

## 6. Storage boundary follow-ups

### 6.1 D2.1: file → DB migration for prompt-composition surfaces

Three current "L2 file" surfaces are local-fs by design but are
conceptually authoritative server-owned data (§3.1):

1. **`system_prompt.md`** — agent identity. Today: file on
   daemon-host disk (L1, `~/.silverhand/agents/<id>/`). Server reads
   when composing system prompt. **D2.1 fix**: migrate to DB row
   `agents.system_prompt_text`; file becomes a generated artifact
   (daemon re-renders for editor convenience, but DB is the truth).
2. **`MEMORY.md`** — workspace-scoped agent memory. Same model
   (DB row keyed `(workspace_id, agent_id)`).
3. **`CONSENSUS.md`** — workspace-scoped, member-edited. Same
   model (DB row keyed `workspace_id`).

**D2.1 is NOT optional follow-up.** It is a hard prerequisite for any
actually-remote deployment (V1 standalone backend talking to a
desktop-local daemon). Reason: §3.1 says server owns this data, but
in V1 embedded mode the server reads daemon-local fs because both
sides share the disk. That shortcut is the only thing keeping the
contract holding without DB migration. The moment the server is in a
different trust domain from the daemon, the shortcut breaks; the
server cannot pretend it has fs access to the daemon's machine.

**Ordering rule (LOCK)**: D2.1 must land before any D2 transport
frame is consumed in real remote deployment, and before D3 actually
runs server + daemon on different machines. It does **not** need to
land inside D2; it can be its own PR sequence. But it cannot be
deferred to "after V1 remote ships" — at that point the shortcut is
already broken in production.

V1 acceptance allows the embedded shortcut. D2.0 just locks the
contract: **server is the owner; daemon ships no file content up;
the protocol intents in §3.3 carry resolved data shipped down.**
When D2.1 swaps the storage backend, the §3.3 / §4 contracts do not
change — only the read source inside the server changes (fs → DB).

### 6.2 `notes/` decision — daemon-host local working storage

`notes/` (the per-agent free-form `<L2>/notes/*.md` knowledge files)
is **not** on the D2.1 migration list. Decision (Cindy + Alice
2026-05-26):

**`notes/` is daemon-host local working storage / agent-readable
filesystem content.** Agents Read/Write notes at runtime via their
own tools (Read/Write/Bash/Grep). notes/ content is **not**
authoritative control-plane data; the server makes no promise that
notes/ content is server-known, ACL-evaluable, prompt-hydrated,
cross-host available, or remote-restorable.

This does **not** break the server-authoritative invariant in §3.1,
because notes/ content was never claimed to be server data in the
first place — it is the agent's working scratchpad on the
daemon-host. Three guardrails make this concrete and must hold for
every D2/D2.1/D3 implementation review:

1. **No `notes_index[]` shipped from server.** §4.2 explicitly
   excludes notes_index from the agent profile bundle. The server
   does not enumerate or expose notes file lists. If a prompt block
   wants to surface "notes you have", the **daemon** enumerates
   locally during prompt-file materialization. Any future server-side
   listing API (UI surfacing) must go through a `daemon_query`
   intent, not direct server fs read; and must be marked local-host-only
   in any remote topology.
2. **Prompt copy may continue to hint** "use Read/Write to access
   your notes". That hint refers to the **current runtime host's
   local fs capability**, not a server-synced memory store. The
   prompt-context section must not promise portability.
3. **Future sandbox / multi-host / host migration must re-evaluate
   notes/ portability.** Options at that point: migrate to DB or
   object store, do per-host fork with no migration, or declare
   unsupported. The decision is a separate storage-placement design,
   not in D2.1 scope and not in D2.0 scope. V1 (single user, single
   desktop, single daemon-per-host) does not face this problem.

## 7. What this stage produces

D2.0 acceptance = **this doc accepted by shiki**. Concretely:

1. Guiding principle (§1) reaffirmed and linked from `auth-and-host-model.md`
2. Two-sided contract (§3.1, §3.2) accepted as the binding rule for
   D2 / D3 implementation reviews
3. Protocol surface tables (§3.3) accepted as the V1 intent vocabulary
   (server→daemon requests + daemon→server unsolicited events;
   additions need explicit D2.0 amendment, not silent expansion in
   D2 PRs)
4. Data bundles (§4.0–§4.5) accepted as the cross-boundary data contract
5. Code-relocation map (§5) accepted as the to-do list for D2; §5.1
   deferred-list locked
6. D2.1 scope + ordering (§6.1) accepted as remote-deploy prerequisite
7. `notes/` decision (§6.2) accepted; three guardrails binding on every
   D2/D2.1/D3 implementation review
8. Decisions on Q1/Q2/Q3 (§8) accepted

**Out of scope for D2.0**: protocol wire format details, message framing,
backpressure rules, retry / durability — all of that is D2 (durability
invariant) and D3 (transport). D2.0 is the *what lives where* contract; D2
is *how it's queued*; D3 is *how it's transported*.

## 8. Decisions taken (was: open questions)

Revision 1 closed all three open questions per shiki/Cindy alignment
(see §9):

- **Q1 (blob bytes physical ownership)** → **Server-side blob bytes
  for V1 main.** `~/.silverhand/blobs/` is server data dir per D1
  layout; current code already has server-owned `BlobFileStorage.put/serve/locate/delete`;
  daemon does not need to be involved. `silverhand file view` in
  remote-deploy returns a server download URL. Daemon-local blob
  cache / sandbox blob tier is a future storage optimization, not
  V1 (see §5.1). `blob_locate` / `blob_upload_chunk` are NOT in the
  V1 protocol surface.
- **Q2 (D2.1 timing)** → **D2.1 is pre-emptive, not deferred to
  "after remote shipped".** D2.1 is a separate stage marker but a
  hard prerequisite for any actually-remote deployment; must land
  before D2 transport frames are consumed in real remote use, and
  before D3 actually runs server + daemon across machines. Can be
  its own PR sequence (does not need to be inside D2). See §6.1
  ordering rule.
- **Q3 (env policy for driver vars)** → **V1 daemon-local fallback
  only.** Server does not ship provider secrets to the daemon in V1.
  Per-user secret routing (e.g. per-user `ANTHROPIC_API_KEY` UX)
  is deferred to D3 alongside secret store / encryption / rotation
  / audit design. See §4.3 / §5.1.

If new open questions surface during D2/D2.1/D3 implementation
reviews, they go back into this section as Q4+, not silently
expanded in PR descriptions.

## 9. Revision history

- 2026-05-26 — **Draft 0 (Alice)**. Skeleton + tables + open questions.
- 2026-05-26 — **Revision 1 (Alice, post Cindy review
  `hVRVC8SPcc0RZajL` + `67gdFlRuTvPgQGLt`)**. Folds:
  - Blocker 1: locked L1/L2/CONSENSUS source-of-truth in §3.1 / §3.2
    (server owns data; daemon owns disk where it transiently lives);
    reframed D2.1 in §6.1 as remote-deploy hard prerequisite (not
    optional follow-up); added §6.2 explicit `notes/` decision with
    three guardrails; removed `notes_index[]` from §4.2 agent
    profile bundle.
  - Blocker 2: Q1 closed = server-side blob bytes for V1 main.
    §3.1 adds blob byte storage to server list; §3.2 removes from
    daemon; §3.3 drops `blob_locate` / `blob_upload_chunk` from V1
    surface; §4.4 rewritten as server-owned; §5 map keeps
    `storage/blob-file-storage.ts` on server; §5.1 notes future
    sandbox blob tier as the place those intents may re-enter.
  - Blocker 3: §3.3 rewritten to restore PR-2's `(conversation_id,
    agent_id)` tuple identity on every runtime intent; explicit
    response (sync reply) vs unsolicited event (no reply) split;
    `runtime_status` preserves PR-2's optional `(conv, agent)`
    filter (host id is not a replacement key).
  - Major: §4 restructured. New §4.0 conversation/session bundle
    (conversation kind/title/thread parent/spawned_by/conversation
    members from conversation_agents NOT workspace_users/workspace
    memory index). §4.1 workspace bundle narrowed (members moved
    out; memory_index moved to §4.0). §4.2 expanded with explicit
    runtime options (model, reasoning_effort, fast_mode,
    cli_session_id). New §4.5 delivery payload bundle (delivery_ids,
    kind, hydrated_text, attachment_snapshots, driver_capabilities).
  - Relocation map nits: §5 entries for `agent-profile.ts` /
    `spawn-env.ts` / `prompt-context.ts` rewritten with explicit
    split lines; added rows for `delivery-coordinator.ts`,
    `stdin-format.ts`, `status-projector.ts` (all server-owned —
    listed explicitly to prevent silent drift); added rows for
    `routes.ts` host-fs callers (workspace/agent create + agent
    delete) and `index.ts` boot direct host-fs callers; clarified
    `provision.ts` split (fs → daemon, DB → server).
  - §8 closed Q1 / Q2 / Q3 with decisions; original open questions
    moved here.
