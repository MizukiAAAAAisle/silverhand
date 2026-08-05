# Orchestration boundary

This doc states the contract for where each responsibility lives in the
remote-backend topology: which side owns authoritative data / control-plane
state, which side owns machine-local execution, and the typed protocol
surface that carries work across the boundary.

**Related docs**:
- `docs/remote-server-target-architecture.md` — target topology
- `docs/auth-and-host-model.md` §5-§6 — host identity / token model
- `docs/daemon-outbound-protocol.md` — per-host outbound routing / wire contract
- `docs/silverhand-daemon.md` — current daemon intent surface

## 1. Guiding principle

> **Server owns authoritative data and control-plane state.** Any work that
> requires direct access to the user's machine — host filesystem reads/writes,
> spawn-file materialization, workspace/blob local path resolution, agent
> process env injection, child-process supervision — belongs to
> **daemon-host**. The server ships data and intent over protocol; the
> server does not pretend its container has filesystem access to the user's
> machine.

This principle binds every code-location decision in this doc.

### 1.1 Host topology corollary

Execution happens on the **registered host selected by placement**
(`RuntimeHostPlacementResolver`, `packages/backend/src/runtime/host-placement.ts`).
A host is `local` or `remote` (`HostKindSchema`,
`packages/shared/src/db/schema.ts`); remote host provisioning and
`connect_token` are live. The server is a separate control / state
plane that mints identity and policy; it is distinct from where runtime
executes, even when "embedded" inside the Electron main process (server
code is conceptually a separate trust domain that happens to share the
selected host's hardware).

Therefore:

- **Agent process runs on the same machine where its
  prompt/memory files live** — the daemon-local filesystem of the
  placement-selected host (local or remote). The agent reads those
  files directly via its own driver tools (Read / Write) and via the
  per-spawn `system-prompt.md` the daemon materializes from local fs.
  The daemon-local filesystem holds only for the host the daemon runs
  on.
- **Server never needs the *byte content* of `system_prompt.md` /
  `MEMORY.md`.** The bytes are not used to compose
  anything server-side; the prompt rendered to the agent is rendered
  on the daemon-host from daemon-local fs reads.
- **Server still owns identity** (which agent / which workspace /
  which conversation) and **metadata** (workspace kind, agent handle,
  role labels, `agent.home_dir`, `workspace.path`). These path strings
  are DB metadata, not server-side fs operations. Daemon-host expands
  the typed metadata into cwd, prompt-file paths, spawn dirs, and
  local reads.

This corollary is what makes "server is in a different trust domain"
work: there is nothing for the server to ship down, because the bytes
were never on the server in the first place.

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
- **Blob byte storage** (`~/.silverhand/blobs/`): server data dir,
  holds attachment / user-avatar / agent-avatar bytes. Server
  receives uploads, serves downloads, runs sweep/GC, mints
  attachment snapshots. Daemon-host never sees blob bytes.
- **Agent / workspace identity & metadata** — DB-row content for agents
  (`agents` row: id, display_name, handle, runtime, model, home_dir,
  …), workspaces (`workspaces` row: id, kind, name, path, …),
  and workspace membership. Server is the only writer. **Server does
  NOT own the byte content of `system_prompt.md` or `MEMORY.md` — those
  are daemon-host local-fs truth (§1.1, §3.2)**. Server must not read,
  cache, ship, or persist that byte content over protocol.
- Intent issuance: when the server decides "agent X in conversation Y
  must wake", that decision is server-side.
- **Delivery text hydration / message formatting**: composing the
  *unencoded* per-delivery text the daemon will hand to its driver
  (today: `formatInboxBatch` / `formatLiveMessage`,
  plus attachment suffix, sender handle prefix,
  delivery instruction). Source data is exclusively server-owned DB
  rows (`messages`, `agent_inbox`, `attachments` metadata, sender
  handles). Combining multiple deliveries into one gated batch is
  **not** server work — that happens daemon-side at flush time (see
  §3.2, `combineGatedBatch`). **Hydration MUST NOT depend on daemon-host
  fs content** — it never composes from `system_prompt.md` / `MEMORY.md`
  bytes; those bytes are not server inputs. Server
  owns hydration; the **driver-specific stdin encoding** is
  daemon-side (`packages/host/src/protocol.ts:300-310` + `:387-417`).
  Same rule for the `runtime_deliver.text` delivery batch.
- Inbox row writes (`ensureDelivery`, `listPending`, `markDelivered`)
  — daemon never opens the inbox repo.
- **Activity log JSONL persistence** (`runtime/activity-log-writer.ts`):
  daemon emits `runtime_output` / control events; server persists the
  JSONL file and republishes event frames to renderers.
  `runtime_close_activity_log` semantics = daemon flushes outbound
  buffers, server then closes its writer.
- Run-state cache projection mirror: daemon is source of truth for
  per-host execution-plane state; server caches a projection for ACL'd
  HTTP snapshot / event-WebSocket consumers.
- Event-bus / event-WebSocket fanout to renderers.

Server **must not**:

- Read/write the user's filesystem (no `node:fs` against user-machine
  paths — workspace path metadata, agent L1 home, agent L2 directories,
  per-spawn shim dirs, or driver-tool working dirs)
- Treat DB path metadata as an execution handle. The server may store
  and send `agent.home_dir` / `workspace.path` as typed metadata, but
  must not `stat`, `open`, `readFile`, `writeFile`, `mkdir`, `rm`, or
  derive cwd/spawn/prompt paths from those strings.
- Compose agent `process.env` (no `SILVERHAND_*` env synthesis bound
  to a daemon process; server ships an env *policy*, daemon applies)
- Spawn child processes or write per-spawn shim files
- **Read the bytes of `system_prompt.md` / `MEMORY.md`,
  or any agent-managed `notes/*.md`, from disk —
  full stop.** No "embedded shortcut", no transitional shim, no
  fallback path. Those bytes are daemon-host truth (§1.1 / §3.2);
  server reads identity rows + logical metadata only.
- **Persist or transport that byte content** (no `agents.system_prompt_text`
  column write, no `MEMORY.md` content uploaded over protocol).
- **Compose the agent's prompt block** (no server-side
  `buildPromptContext`, `buildSystemPromptFor`, `prepareSpawnFiles`,
  or any helper that materializes the per-spawn `system-prompt.md`
  from prompt/memory bytes). Prompt assembly is daemon-host
  work; server ships identity + metadata bundles (§4) and a
  `runtime_start` intent.

### 3.2 Daemon-host-only (machine-local execution)

Daemon-host owns and is the only writer of:

- Per-host filesystem: `~/.silverhand/` (daemon logs, workspace
  roots, embedded-bootstrap file, host token, daemon socket, pid file,
  installation_id, per-spawn shim dirs). **Excludes** `~/.silverhand/blobs/`
  (server data dir — see §3.1).
- Workspace materialization: creating `<workspace>/.silverhand/`
  directory tree, seeding agent L2 (`MEMORY.md` / `notes/`), and
  deriving local runtime paths from the
  typed `workspace.path` metadata it receives.
- Agent L1/L2 fs mutation: `<agents root>/<id>/system_prompt.md`
  + `MEMORY.md` + `notes/*.md` writes, `<workspace>/.silverhand/agents/<id>/`
  scaffolding, agent-deletion `fs.rm` of L1/L2 directories
- Spawn materialization: writing per-spawn `system-prompt.md`,
  `bin/silverhand` shim, deciding `process.env` composition, invoking
  driver CLI
- Agent process lifecycle: spawn, supervise, stdin write, stdout
  parse, stop/clear, run-state cache (source of truth, per host).
  Daemon emits `runtime_output` + control events; **server**
  persists the activity-log JSONL (see §3.1).
- **Driver-specific stdin encoding** via the in-process driver
  instance whose state is authoritative: `driver.encodeStdinMessage(text, cliSessionId)`,
  readiness gating / `driver_not_ready` short-circuit, codex thread
  state, soft-directive encoding
  (`packages/host/src/protocol.ts:300-310` + `:387-417`). Backend
  ships unencoded text (§3.1 delivery hydration); daemon encodes per
  driver.
- Daemon-local logs: `~/.silverhand/run/daemon-<utc>.log`, pid file,
  installation log, supervisor's own structured logs. **Excludes**
  the activity-log JSONL — that is server-persisted (see §3.1).
- **Prompt / memory byte content** (`system_prompt.md` at
  L1, `MEMORY.md` and `notes/*.md` at L2):
  daemon-host owns the bytes end-to-end — read, write, cap, render.
  Daemon assembles the per-spawn `system-prompt.md` from these local
  reads at spawn time (see §4.6). Server is **not a writer, not a
  reader, not a transport** for these bytes. The agent process running
  on the same daemon-host edits them via its own driver tools.
- L1/L2 **prompt-file materialization & path rendering**:
  rendering daemon-local absolute paths into the per-spawn
  `system-prompt.md`, deriving memory paths from `agent.home_dir`,
  `workspace.path`, and `workspace_memory_index[].path`, writing the
  per-spawn shim. This is the same fs the bytes live on — so
  materialization is purely local.
- **Gated-batch combining**: combining multiple deferred deliveries
  into one gated batch at flush time via `combineGatedBatch`
  (`packages/host/src/daemon/supervisor/gated-combine.ts`), called by
  the host's `combineDeferredBatch`. The server ships per-delivery
  unencoded text (§3.1); the daemon combines and encodes.
- `notes/*.md` content lifecycle: notes are daemon-host local working
  storage for agent runtime (agent uses Read/Write tools at runtime).
  See §6 for the explicit rule and three guardrails.

Daemon-host **must not**:

- Issue ACL decisions (server is the gatekeeper; daemon receives validated
  intents only)
- Mutate authoritative DB rows directly (daemon talks protocol → server →
  DB; no direct DB connection from daemon process)
- Persist control-plane state beyond its own machine-local needs
  (installation_id, host token, run-state cache — none of these are
  "the durable record"; the server's DB is)
- Persist the activity-log JSONL — that is server-side. Daemon emits
  events; server's `activity-log-writer.ts` consumes and persists.
- Hydrate delivery text from DB rows (server-owned per §3.1; daemon
  only encodes the unencoded text it receives)
- Pre-encode stream-json on the server (that would freeze driver state
  outside the in-process driver instance)
- Read or write blob bytes
- **Ship `system_prompt.md` / `MEMORY.md` /
  `notes/*.md` content upward to the server** in any intent
  parameter, response field, or event payload. The bytes are
  daemon-host truth and stay there.

### 3.3 Boundary crossings (the protocol surface)

Every cross-boundary call is a typed intent. This section is the
canonical set of shapes (preserving the `(conversation_id, agent_id)`
tuple identity) and locks them as the intent vocabulary. **Additions
need an explicit amendment to this doc, not silent expansion in
implementation PRs.**

**Path / byte invariant**: path strings that are
server DB metadata may cross the boundary as typed records. That
means `agent.home_dir`, `workspace.path`, and
`workspace_memory_index[].path`. What may **not** cross are
daemon-derived execution artifacts, prompt/memory bytes, or
precomposed child-process env maps. Concretely,
`runtime_start.options` MUST be `.strict()` typed metadata and MUST
NOT contain:

- `cwd`
- legacy flat `workspace_path`
- `system_prompt_path`
- `spawn_dir`
- `system_prompt` / `system_prompt_text`
- `memory_text`
- precomposed `env` maps

The removed consensus payload (`consensus_text`) remains forbidden on
`runtime_start`.

Allowed path metadata is data; forbidden fields are behavior or bytes.
The daemon-host uses the allowed base metadata to derive cwd, L1/L2
paths, per-spawn `system-prompt.md`, shim dirs, and final
child env locally. Schema reviews for the protocol package must reject
unknown keys and the blacklist above on sight; "passthrough options" is
not an escape hatch.

**Direction key**: "Req" = request from server, daemon replies with a
matching **response** (sync, single arm). "Event" = unsolicited from
daemon, no reply — server fans out via the activity log / renderer event bus.

**Server → daemon requests (sync response):**

| Intent | Request params | Response arms |
|--------|----------------|---------------|
| `runtime_start` | `{ conversation_id, agent_id, options }` where `options` carries typed server metadata: `agent: { id, name, home_dir }`, `workspace: { id, name, kind, path }`, `workspace_memory_index[]`, `session: { conversation_id, kind, title, parent_conversation_id?, parent_title?, spawned_by_agent_id?, members[] }`, `driver: { kind, cli_session_id?, model?, reasoning_effort?, fast_mode? }`, and `env_policy` (§4.3). `runtime_start` is a message-less lifecycle command only — it carries no inbox rows and no delivery semantics; message delivery (including spawn-with-batch) goes through `runtime_deliver`. See `daemon-authoritative-delivery-v1.md` §10.2.1. | discriminated by `started`: `{ started: true, pid, started_at }` / `{ started: false, reason: 'init_cooldown', cooldown_until }`. Success means only "the daemon has/created the handle" — not ready, deliverable, or safe-boundary. |
| `runtime_stop` | `{ conversation_id, agent_id, mode: 'hard' }` (`mode` is a wire literal; the former `mode:'soft'` stdin-directive arm was deleted in #task:1558 — no product entry point) | `{ mode: 'hard', stopped, exit_code: number \| null }` (`exit_code` required-nullable — real value may ride on `runtime_exit` event when SIGTERM cascade still pending) |
| `runtime_clear_session` | `{ conversation_id, agent_id }` | `{ cleared: boolean }` |
| `runtime_deliver` | `{ conversation_id, agent_id, delivery_ids[], delivered_up_to_seq?, deliveries?, kind: 'message' \| 'schedule_fire', text, spawn_options }` where `text` is the server-hydrated *unencoded* delivery text (the daemon's driver instance encodes via `encodeStdinMessage(text, cliSessionId)` before writing stdin) and `spawn_options` is consulted **only** if the daemon must spawn. The sole message-delivery command; the daemon inspects the real handle and picks spawn / write / enqueue / refuse. | a synchronous **custody disposition**, NOT a delivery ack: `{ disposition: 'spawning', pid, started_at }` / `{ disposition: 'admitted', pid, started_at }` / `{ disposition: 'deferred', pid, started_at }` / `{ disposition: 'refused', reason: 'startup_pending' \| 'draining' \| 'cooldown' (+ cooldown_until on cooldown) }`. "Sent to daemon" ≠ ack: rows stay in-flight (owner=connection) on `spawning`/`admitted`/`deferred`; `refused` rolls the batch back to pending (retriable). `delivered_at` moves **only** on the async `runtime_delivery_consumed` event. Full mechanism owned by `daemon-authoritative-delivery-v1.md` §10–§11. |
| `runtime_status` | `{ conversation_id?, agent_id? }` (both optional) | `{ runtimes: RuntimeStateDto[] }` — cache snapshot constrained by filter; empty filter = full snapshot known to this daemon. Filter is a narrowing operator, not a topology key; host placement is decided server-side before the call. |
| `runtime_stop_all` | `{}` (boot/shutdown sweep) | `{ stopped_count }` + per-agent `runtime_exit` events |
| `runtime_close_activity_log` | `{}` (shutdown) | `{ flushed: boolean }`. Semantics: daemon flushes outbound buffers; **server then closes its activity-log writer** (per §3.1). |
| `runtime_output_pause` | `{ conversation_id, agent_id }` (backend stays in always-flowing mode in v0) | `{ paused: boolean }` |
| `runtime_output_resume` | `{ conversation_id, agent_id }` | `{ resumed: boolean }` |

**Daemon → server unsolicited events (no reply; activity log / event-WebSocket fanout):**

| Event | Payload | Notes |
|-------|---------|-------|
| `runtime_state` | `{ conversation_id, agent_id, state, ... }` | parsed run-state transitions |
| `runtime_output` | `{ conversation_id, agent_id, chunk }` | **droppable**; raw stdout/stderr |
| `runtime_exit` | `{ conversation_id, agent_id, code, signal, ... }` | child exit |
| `runtime_ready_for_drain` | `{ conversation_id, agent_id }` | driver-confirmed replay nudge; server resubmits pending inbox rows as `runtime_deliver` |
| `runtime_delivery_consumed` | `{ conversation_id, agent_id, delivery_ids[], ts }` | non-droppable; the **only** event that moves `delivered_at` (server `markDelivered`). Covers delivery via spawn, ready-write, or queued flush alike |
| `runtime_delivery_failed` | `{ conversation_id, agent_id, delivery_ids[], reason, ts }` | non-droppable; server rolls rows back to pending (retriable) or marks failed (fatal, e.g. `driver_refused`). `reason in ['child_exit' \| 'init_watchdog' \| 'write_failed' \| 'driver_refused']` |
| `runtime_output_dropped` / `_paused` / `_resumed` | flow-control bookkeeping | — |
| `shutting_down` | `{}` | daemon-initiated shutdown notice |

Embedded mode keeps server + daemon-host on the same machine, but the
protocol contract above is the single contract for both embedded and
standalone / remote-deploy — same intents, same shapes, same path /
byte invariant. **Any cross-machine data dependency that does not
already exist in this contract requires an explicit amendment to this
doc before it can ride on a new field, sub-bundle, or "passthrough"
option.** No prompt-context fs reads on server: those reads are
daemon-local (§4.6) and never were server's job.

**What is NOT in the protocol surface:**

- `blob_locate` / `blob_upload_chunk` — blob bytes are server-side, so
  these intents have no consumer.
- `runtime_inject_env` — secret-routing is not part of the current
  surface.

## 4. Data that crosses the boundary

When the server hands intent to the daemon-host, it must hand over
enough **data** that the daemon can do its job without reading
server-side state. This section names each bundle. Bundles are
versioned together with the protocol vocabulary in §3.3.

### 4.0 Session bundle (per spawn / delivery)

The session bundle answers "which conversation, with whom, with what
parentage" — the data daemon-host prompt hydration consumes to render
the platform prompt's session-context block. It rides on
`runtime_start.options` (and is implicit context for any subsequent
`runtime_deliver` against the same conversation).

- `conversation_id`, `kind` (`channel` | `dm_channel` |
  `thread`), `title`
- `parent_conversation_id?`, `parent_title?` — populated when
  `kind == 'thread'`
- `spawned_by_agent_id?` — non-null when this thread was opened by
  another agent (drives the "agent-spawned child session" framing)
- `members[]` — ids + display names + handles + kind
  (agent / human) from `conversation_agents` × `membership` (NOT
  workspace_users; the prompt's "Members" list is conversation-scoped)
- `workspace_memory_index[]` — for this agent, every workspace it is
  a member of, as typed metadata `{ id, name, kind, path }`. `path` is
  the workspace base path stored in the server DB. The daemon renders
  `<path>/.silverhand/agents/<agent_id>/MEMORY.md` locally; it does
  not receive memory bytes.

### 4.1 Workspace bundle (per spawn)

The workspace bundle is the per-spawn workspace context — distinct
from the session bundle because workspace data is stable across
conversations within a workspace.

- `id`, `kind` (`regular` | `dm` | `agent_home`), `name`, `path`
- `path` is the workspace base path stored in the server DB. It may be
  the default convention (`~/.silverhand/workspaces/<id-or-name>`) or
  an arbitrary user-selected project directory such as
  `/Users/shiki/workspace/silverhand`. The server may ship this string
  as metadata; the daemon-host is the side that uses it as a local fs
  base.

Note: workspace bundle does **not** carry conversation members —
that lives in §4.0 (conversation-scoped), not workspace (workspace
membership is a different list and is not what the prompt's "Members"
block renders).

### 4.2 Agent bundle (per spawn)

- `id`, `name`, `home_dir`
- `home_dir` is the agent L1 base path stored in the server DB (or the
  server's compatibility fallback for legacy rows). The daemon-host
  renders `<home_dir>/system_prompt.md` locally and reads the bytes
  there; the server never reads or ships those bytes.

**Runtime options** (carried in `runtime_start.options.driver`):
`kind`, `model`, `reasoning_effort`, `fast_mode`, `cli_session_id?`.
These are listed here for completeness; they are not "profile data"
but per-spawn driver options.

**Explicitly NOT in this bundle**: `system_prompt_text`, `memory_text`,
`notes_index[]`. The byte content of `system_prompt.md` and `MEMORY.md`
lives on daemon-host disk and is read locally at spawn time (§4.6).
notes/ is daemon-host local working storage; server does not enumerate
or ship the index (see §6 guardrail 1). The **daemon** enumerates current-L2
note frontmatter locally and hands a metadata-only catalog to the shared prompt
renderer; no note body or catalog crosses the server protocol.

### 4.3 Env policy (per spawn)

The server does NOT compose `process.env`. The server ships an **env
policy** with explicit fields:

- `silverhand: { auth_token }` — the **server-minted** per-(conversation,
  agent) credential the daemon applies as `SILVERHAND_AUTH_TOKEN`, plus
  the protocol ids it already has (`conversation_id`, `agent_id`).
  Identity/authz is server-owned, so this legitimately rides the wire
  server→daemon→agent.
- `silverhand_cli` — launcher metadata for the local `silverhand` shim.
  **Optional / host-overridable**: standalone server does
  not ship it; the daemon resolves the host-local CLI launcher itself
  (release `Resources/silverhand-cli/cli.mjs`, dev
  `packages/cli/dist/cli.js`). If a legacy server still ships a fallback
  `{ command: 'silverhand', args: [] }`, the daemon overrides it with the
  host-local launcher — otherwise the per-spawn shim's own dir, prepended
  to PATH, resolves `silverhand` back to the shim and the shim recurses
  into itself.
- `proxy: { url, allowlist }` — the user-configured proxy policy. Proxy
  is daemon-host local truth (`proxy-config.json`), NOT server state; the
  daemon reads it locally and applies it only when the runtime is allowed.
  Kept here only to document that it is NOT on the `runtime_start` wire.

The daemon merges policy into its own `process.env` + per-spawn shim +
`driver.applyEnv()` (driver-specific env transform; daemon-side only,
never invoked on the server), spawns the child, wires stdin/stdout.

#### 4.3.1 `SILVERHAND_SERVER_URL` is host-local truth

**`server_url` is NOT in the env policy and NOT on the `runtime_start`
wire.** The agent's control-plane origin is host topology — what URL
*this host* uses to reach the control plane — which the server cannot
know about itself. So the daemon injects `SILVERHAND_SERVER_URL` from a
**host-local** source, never echoed down from the server:

- **standalone / remote**: the daemon's live outbound binding
  `server_origin` (`outboundSupervisor.currentBinding().server_origin`),
  i.e. the origin the daemon actually WS-attaches to, sourced from
  Desktop-written `daemon-config.json:server_url`.
- **embedded**: Desktop writes the finalized loopback URL to a host-local
  file `<SILVERHAND_DIR>/run/control-plane-server-url` after the embedded
  backend's listen callback finalizes the bound port; the daemon reads it
  at spawn (`--control-plane-server-url-path`). `currentBinding()` is null
  in embedded (no WSS outbound), so the read-file path is reached cleanly;
  the `local-embedded` sentinel lives only in `resolveRegistryBinding()`
  (workspace-registry namespacing) and does NOT shadow URL injection.
- **fail-loud**: if neither source yields a URL, `buildDaemonSpawnEnv`
  throws rather than injecting a bogus value. Embedded is a main path and
  must not ride the fallback.

Server ships server-minted identity (`auth_token`); host owns its own
topology (`server_url`, `silverhand_cli`, `proxy`).

### 4.4 Blob bytes (server-owned)

Blob bytes live server-side. `~/.silverhand/blobs/` is server data dir,
not user workspace fs. The boundary contract:

- Server receives uploads via existing routes (`AttachmentService.upload`,
  user avatar, agent avatar), calls `BlobFileStorage.put()`, stores the
  bytes under the server's data dir, mints an `AttachmentSnapshot`
  (id + filename + size + content_type — already the immutable
  embedded subset in `messages.metadata.attachments`).
- Server serves downloads via existing routes (`serveForViewer` /
  avatar fetch), reading the bytes back from its own data dir.
- Daemon never sees blob bytes. When a delivery text bundle (§4.5)
  references attachments, the server's hydrated `text` already inlines
  the attachment-suffix block; `attachment_snapshots[]` rides along as
  metadata only. If the agent's driver tools later need to read the
  attachment file (e.g. `silverhand file view`), the resolution goes
  back through server HTTP, not through a daemon-local path.

Implication for `silverhand file view` in remote-deploy: fetches the
bytes back through server HTTP, caches them on the agent host, and
returns that cache path. Embedded mode may keep the current
local-path-resolution shortcut as an optimization, but the contract
the agent sees is "a local path readable by its normal file tools".

### 4.5 Delivery bundle (per `runtime_deliver`)

`runtime_deliver` carries an unencoded delivery text bundle. **Boundary lock**:
server hydrates the text from DB rows; the daemon's
in-process driver instance — which holds authoritative driver state
(cli_session_id, codex thread state, readiness) — does the
driver-specific stdin encoding via `encodeStdinMessage(text, cliSessionId)`
and writes to stdin. Backend MUST NOT pre-encode (see
`packages/host/src/protocol.ts:300-310` and `:387-417`).

Server-side hydration produces (and ships in `text`):

- `delivery_ids[]` — inbox row ids covered by this batch. The
  all-or-nothing markDelivered rule applies to `runtime_deliver`.
- `text` — the unencoded per-delivery text. Server-side helpers today:
  `formatInboxBatch` (multi-row batched drain),
  `formatLiveMessage` (single live delivery), plus
  attachment suffix rendering, sender handle prefix, delivery
  instruction. Output is **plain text**; it is NOT a
  pre-serialized `stream-json` user message. Combining multiple
  deliveries into one gated batch (`combineGatedBatch`) is daemon-side
  (§3.2), not part of server hydration.
- `attachment_snapshots[]` — `AttachmentSnapshot` records for any
  attachments referenced (id + filename + size + content_type, per
  `AttachmentSnapshotSchema`). These are passed through to the
  formatter for inline rendering inside `text`; daemon does not
  re-resolve them.

Daemon-side, per delivery (per `text` field):

- `driver.encodeStdinMessage(text, cliSessionId)` — driver-specific
  framing into stream-json or whatever the runtime expects on stdin.
  This is the **only** place stream-json encoding happens.
- Readiness gating: `driver_not_ready` short-circuit before write
  attempt; codex thread state held in driver; soft-directive encoding.
- The async `runtime_delivery_consumed` / `_failed` events
  carry the daemon's per-delivery outcome (§3.3; `daemon-authoritative-delivery-v1.md` §10.4).

`driver_capabilities` (e.g. claude vision support) is **computed
server-side from the agent's runtime + model** and consumed at
hydration time (whether to inline an image attachment, etc.). It is
not shipped as a separate field — the resulting `text` already
reflects the decision.

### 4.6 Daemon-host self-hydration (per spawn)

The daemon-host is the only side that reads prompt / memory
byte content. At spawn time (handling a `runtime_start`
intent), the daemon reads the following from its **own local fs**,
keyed entirely by typed metadata received in §4.0–§4.3:

| Source | Path (daemon resolves locally) | Cap | Use |
|--------|--------------------------------|-----|-----|
| Agent identity (L1) | `<agent.home_dir>/system_prompt.md` | none (file is small) | "Initial role" block in per-spawn `system-prompt.md` |
| Workspace memory (L2) | `<workspace.path>/.silverhand/agents/<agent.id>/MEMORY.md` | `MEMORY_INJECT_CAP_BYTES` (16KB) | "Active Workspace Memory" block |
| Workspace note catalog (L2) | `<workspace.path>/.silverhand/agents/<agent.id>/notes/**/*.md` | 16KB frontmatter read cap per note + 20 injected entries + 4KB UTF-8 complete rendered block; bodies excluded | "Memory Notes Catalog" block |
| Memory index | use each `workspace_memory_index[].path` to render `<path>/.silverhand/agents/<agent.id>/MEMORY.md` | path-only, no read | "Workspace Memory Index" block (paths only, current workspace's MEMORY.md is the one read above) |

The shared formatter helper that renders the final prompt text
(`buildSystemPromptFor`) lives in `packages/shared` and is invoked
**by the daemon process only**. Daemon-only helpers own local
read-with-cap and `DriverPromptContext` construction. The
byte-identical-assembly rule holds through the shared formatter
contract, but only daemon calls it. Server has no caller, no fs
read, no prompt context builder invocation.

If a file is missing or unreadable, the daemon emits the section
header with an empty body or omits the section per current
`readFileWithCap` semantics; this is a **daemon-side** decision,
not a server-issued instruction.

## 5. Ownership by layer

The layer that owns each host-local fs / spawn / env responsibility:

- **Per-spawn `system-prompt.md` + `bin/silverhand` shim** — daemon-host.
  Daemon writes them from typed `runtime_start.options`; backend sends
  session + workspace + agent + env-policy metadata (§4.0–§4.3) only.
  Delivery text rides `runtime_deliver.text` (§4.5), not `runtime_start`.
- **Workspace `.silverhand/` materialization** — daemon-host. Server
  ships the workspace bundle (§4.1).
- **Agent L1/L2 path rendering** — daemon-host. Agent/workspace path
  metadata rows stay server-owned and cross as typed `agent.home_dir` /
  `workspace.path`; daemon renders `<home_dir>/system_prompt.md`,
  `<workspace.path>/.silverhand/agents/<id>/MEMORY.md` locally.
- **Blob byte R/W** — server. Blob bytes are server data (§3.1 / §4.4);
  put/serve/locate/delete + sweep stays server-side.
- **Spawn env composition** — daemon-host. Env policy (§4.3, including
  server URL/token, launcher metadata, proxy policy) is built server-side;
  `process.env` merge + per-spawn shim path + `driver.applyEnv(process.env)`
  invocation happens on daemon-host. **Server never sends a generic env
  map and never invokes `driver.applyEnv`**.
- **L1/L2 file reads + `DriverPromptContext` composition** —
  daemon-host. Server has no business reading these bytes
  (§1.1 / §3.1). Daemon-local helpers perform read-with-cap, memory-index
  path rendering, `DriverPromptContext` construction, shared
  `buildSystemPromptFor` invocation, and per-spawn `system-prompt.md`
  materialization. **Server backend MUST NOT import or call any helper
  that reads these files or returns composed prompt text** — a
  calling-boundary rule, not just a module-location rule (§5.2).
- **Activity JSONL write** — server. Daemon emits `runtime_output` +
  control events; server persists JSONL and republishes renderer event
  frames. `runtime_close_activity_log` semantics = daemon flushes
  outbound buffers → server closes its writer.
- **Run-state cache** — daemon-host is source of truth (per host); server
  caches a per-host projection for ACL'd HTTP snapshot / event-WebSocket
  consumers, rebuilt from `runtime_state` events, not persisted.
- **Server-side IPC client to daemon** — server. It may format
  server-owned delivery text and build typed `runtime_start.options`, but
  MUST NOT hydrate prompt bytes, prepare spawn files, derive cwd/spawn
  paths, or compose child env.
- **Delivery orchestration + per-delivery text formatter helpers**
  (`formatInboxBatch` / `formatLiveMessage`) — server. Backend ships
  unencoded per-delivery text; the daemon combines multiple deliveries
  into one gated batch (`combineGatedBatch`,
  `packages/host/src/daemon/supervisor/gated-combine.ts`, called by
  `combineDeferredBatch`) and its driver encodes via
  `encodeStdinMessage(text, cliSessionId)`. **Backend MUST NOT pre-encode**
  (`packages/host/src/protocol.ts:300-310` + `:387-417`).
- **Embedded-bootstrap file** — daemon-host owns write/read (host-local);
  server issues the bootstrap token over protocol.
- **Workspace-dir / onboarding provisioning** — split. Workspace **fs**
  materialization → daemon; onboarding **DB** row writes (inbox,
  conversation_agents, messages) → server.
- **Route-handler host-fs side-effects** (`initWorkspaceDir`,
  `ensureAgentL1Dir`, `seedAgentL2` on create; `fs.rm` of L1/L2 on
  delete) — route handler stays server (DB writes + ACL); fs side-effects
  become typed materialization intents to daemon.
- **DB file** (`<data_dir>/silverhand.db`) — server. Daemon never opens
  the DB file.

### 5.1 Host-local path authority (semantic ids in, paths resolved daemon-side)

The control-plane / execution-plane split has a path-resolution half: the
backend speaks semantic ids, and the placement-selected daemon is the sole
authority for every host-local absolute path.

- **Backend emits zero host-local paths.** `packages/backend/src` performs no
  agent-host path resolution and puts no host-local path into any outbound frame
  or agent-facing DTO. `buildRuntimeStartOptions`
  (`packages/backend/src/runtime/runtime-start-options.ts`) emits only semantic
  refs — `agent {id,name}`, `workspace {id,name,kind}`, a
  `workspace_memory_index`, plus session/driver/env-policy fields — never
  `workspace_path` / `home_dir` / `agentHomeDir`. Enforced structurally by
  `packages/backend/tests/dependency-guard-no-agent-host-fs.test.ts` (no
  `node:fs` / `node:path` in the builder; no host-path token anywhere in
  `backend/src`).
- **The daemon maps refs → paths, failing closed.** `resolveRuntimeStartPaths`
  (`packages/host/src/daemon/runtime-start-resolve.ts`) turns each semantic
  workspace ref into an absolute path via the daemon-local registry; an
  `agent_home` ref that is not this agent's own home, an unknown/unbound id, or a
  foreign registry binding throws a typed error (`workspace_not_provisioned` /
  `not_provisioned` / `registry_foreign`) rather than guessing a path.
- **Daemon-owned workspace registry.** The non-derivable `workspace_id →
  absolute path` map lives in a daemon-local JSON file
  (`packages/host/src/daemon/workspace-registry/registry.ts`), written
  atomically at mode `0600`, scoped to exactly one `(server_origin, host_id)`
  binding recorded in its header. A registry whose recorded binding differs from
  the daemon's current binding is foreign and every op fails closed.
- **Ids become path components only after strict validation.** A regular
  workspace's managed dir is the VALIDATED raw workspace id
  (`^[A-Za-z0-9_-]{1,64}$`, case-fold-unique — #task:1608); anything else
  fails closed, so a server-supplied id like `../escape` can never become a
  path. A caller-*requested* path is re-validated daemon-side and rejected
  inside the managed root, the home dir, `/`, or the state root. Agent-home
  derives deterministically as ONE join of the composition root's agents root
  + agent_id (`resolveAgentDir`; the root is a REQUIRED explicit coordinate —
  #task:1813 removed the `homedir()`-derived fallback) and is not stored in the
  registry.
- **No lazy backfill.** The legacy `WorkspaceRegistryBackfiller` (DB-path →
  `requested_path` rebind) is retired (#task:1612, delete gate: fleet
  `migration_complete=true`). The registry is the sole authority: provision
  exists only at workspace creation (home computer) and at guest membership
  establishment (pathless, on the guest's computer); read/spawn/purge fail
  closed on a missing binding via their existing typed results.

### 5.2 Calling-boundary rule

Ownership by layer names the *destination package* for each module.
That's necessary but not sufficient — server backend can silently
re-acquire prompt-composition responsibilities by importing a helper
that reads daemon-host files, even if the helper "lives" in
`packages/host` or `packages/shared`. The calling-boundary rule:

- **Server backend (`packages/backend`) MUST NOT call any function
  whose effect is to read `system_prompt.md` / `MEMORY.md` /
  `notes/*.md` bytes from disk, derive daemon
  execution paths (`cwd`, `system_prompt_path`, `spawn_dir`), compose
  child `process.env`, or materialize per-spawn `system-prompt.md`,
  regardless of which package the function is declared in.** This
  includes daemon prompt-context builders, daemon spawn-prep helpers,
  read-with-cap against any of those files, and any future helper that
  takes an agent_id / workspace_id and returns prompt/memory
  bytes or composed prompt text.
- The daemon-host (today `packages/host`, plus the in-process daemon
  inside `apps/desktop` Electron main) is the only legitimate caller.
- Implementation reviews must run a static check (manual grep is
  fine; an import-rule lint is the long-term answer) before
  merge. A backend caller that reaches a banned helper is an
  amendment-required signal, not a "fix it later" item.

The protocol schema (§3.3) blocks the *wire format* side; this rule
blocks the *call-graph* side.

## 6. Storage boundary

### 6.2 `notes/` — daemon-host local working storage

`notes/` (the per-agent free-form `<L2>/notes/*.md` knowledge files)
shares ownership with `system_prompt.md` / `MEMORY.md`:
daemon-host local-fs truth, not server data.

**`notes/` is daemon-host local working storage / agent-readable
filesystem content.** Agents Read/Write notes at runtime via their
own tools (Read/Write/Bash/Grep). notes/ content is **not**
authoritative control-plane data; the server makes no promise that
notes/ content is server-known, ACL-evaluable, prompt-hydrated,
cross-host available, or remote-restorable.

Three guardrails (concrete implementation rules; the broader rule
lives in §3.1 / §3.2 / §5.2):

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
3. **`notes/` is per-host local and not migratable.** Notes content
   is bound to the daemon-host filesystem where it was written; it is
   not guaranteed visible across hosts, not replicated, and not
   remote-restorable. A host that runs the agent sees only the notes
   on its own local fs.
