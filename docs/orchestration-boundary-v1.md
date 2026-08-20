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
- `docs/workspace-layout-relocation-v1.md` §3.2/§3.3 — the terminal on-disk
  coordinate model this doc consumes. This doc owns *which side* resolves a
  path; that doc owns *what the coordinate is*. Every path below is derived
  daemon-side from ids per its deterministic resolver; there is no stored
  path column and no registry lookup in the runtime path.

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
  role labels). It owns **no path metadata**: there is no
  `agents.home_dir` column, no `workspaces.workspace_path` column, and
  nothing the server composes carries a host-local path — the only
  path-shaped value it forwards is the calling agent's own *virtual*,
  agent-home-relative path in the agent-file intents, confined and resolved
  daemon-side (class B in §3.3). Daemon-host derives cwd, prompt-file paths,
  spawn dirs, and local reads from the semantic ids
  alone (`workspace-layout-relocation-v1.md` §3.2/§3.3).

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
  `saves`), `conversation_agents`, `conversation_inboxes`, `runtime_status`,
  `schedules`, `tasks`, `app_settings`.
- ACL evaluation, principal resolution, route handlers, WS scope event
  bus, session lifecycle, schedule scheduler.
- **Blob byte storage** (`~/.silverhand/blobs/`): server data dir,
  holds attachment / user-avatar / agent-avatar bytes. Server
  receives uploads, serves downloads, runs sweep/GC, mints
  attachment snapshots. Daemon-host never sees blob bytes.
- **Agent / workspace identity & metadata** — DB-row content for agents
  (`agents` row: id, display_name, handle, runtime, model, …),
  workspaces (`workspaces` row: id, kind, name, …),
  and workspace membership. Server is the only writer. Neither row
  carries a filesystem coordinate — the agent-home and workspace-path
  columns were retired with the binding
  (`workspace-layout-relocation-v1.md` §3.4). **Server does
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
  rows (`messages`, `conversation_inboxes`, `attachments` metadata, sender
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
  paths — agent L1 home, agent L2 bundles,
  per-spawn shim dirs, or driver-tool working dirs)
- Persist, derive, or treat as authoritative a host-local path. The server
  has no path column to send and must not reintroduce one, must not put a
  path **of its own** into any outbound frame or agent-facing DTO, and must
  not `stat`, `open`, `readFile`, `writeFile`, `mkdir`, `rm`, or derive
  cwd/spawn/prompt paths from any string it does hold — an id is an id, not
  a path fragment. Relaying a daemon-stamped path verbatim (§3.3) is the one
  permitted contact: it is in-process, transient, and grants none of the
  above.
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
- Workspace materialization: creating the per-`(agent, workspace)` L2
  bundle — the coordinate `resolveAgentWorkspaceBundleDir`
  (`packages/host/src/daemon/agent-materialize/handler.ts`) computes from
  ids alone, whose shape is owned by
  `workspace-layout-relocation-v1.md` §3.2 — and seeding agent L2
  (`MEMORY.md` / `notes/`) into it. The bundle root **is** that agent's
  spawn cwd and **is** its L2 memory dir; it is created lazily at first
  spawn / seed, not at workspace creation.
- Agent L1/L2 fs mutation: `system_prompt.md` + `MEMORY.md` +
  `notes/*.md` writes under the L1 dir and the L2 bundle respectively,
  L2 bundle scaffolding, agent-deletion `fs.rm` of L1/L2 directories
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
  `system-prompt.md`, deriving the L1 home from `resolveAgentDir(agent_id)`
  and every L2 path (active workspace and each `workspace_memory_index`
  entry) from the same id-derived bundle coordinate, writing the
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

**Path / byte invariant**: **the server neither stores nor derives a
host-local path, and every server → daemon runtime ref is purely
semantic.** The earlier carve-out that let `agent.home_dir`,
`workspace.path`, and `workspace_memory_index[].path` ride as "server DB
metadata" is **revoked** — those columns no longer exist and the refs are
semantic (`id` / `name` / `kind`). What crosses is ids, non-path metadata,
server-minted credentials, and unencoded delivery text. What may **not**
cross toward the daemon is a server-held or server-composed host-local
path. What may not cross toward the server is prompt/memory bytes,
daemon-derived spawn artifacts, or precomposed child-process env maps —
**except** the two bounded absolute-path replies in class A below, which
are the only daemon-derived coordinates the server may receive, and only
as opaque data.

This is **not** a symmetric "zero paths" rule, and must not be written as
one. Path strings do ride the wire, in exactly two classes with different
provenance, different trust, and different rules:

**A. Daemon-stamped absolute path — opaque relay only.** Two replies stamp
a real host-local coordinate the daemon computed itself:

1. `agent_materialize`'s reply — `agent_dir` + `agent_home_workspace_path`
   (`packages/host/src/protocol.ts`, `AgentMaterializeResultSchema`). The
   backend's only use is the §6.5 equality cross-check plus the diagnostic
   payload of a mismatch (`create-agent.ts`); it stores neither string and
   resolves nothing from them.
2. `agent_workspace_index`'s reply — `entries[].agent_dir`, the daemon's
   own bundle coordinate for each authorized workspace. The backend passes
   it through verbatim into the agent-facing `list_workspaces` DTO
   (`AgentListedWorkspace.agent_dir`, `null` when the daemon reports the
   workspace `unresolved`) so an agent can name its own working dir; the
   backend never derives, completes, or substitutes one (I1).

The rule for class A: **it may cross as opaque data and be relayed
verbatim; the server must not touch the filesystem with it, must not
persist it, and must not reconstruct a coordinate from it.**

**B. Untrusted virtual relative path — the daemon confines it, then
resolves it.** `agent_workspace_file_read`'s request carries a `path` such
as `notes/work-log.md`. This is **not** daemon-stamped: it originates from
the calling agent, so the daemon treats it as untrusted input —
`parseAndResolveVirtualPath` applies per-segment shape rules, per-segment
`lstat` symlink refusal, and a final `path.relative` containment check
against the realpath of the agent-home base, failing closed as
`forbidden_path`. The replies carry virtual relative paths too
(`AgentWorkspaceTreeNodeSchema.path` per visible entry, and the read
result's echoed `path`), daemon-produced and safe to feed back verbatim.

The rule for class B: **it is virtual, not a coordinate.** No value in this
class is a host-local path in either direction; the server cannot form an
absolute path from one and must never try. Only the daemon joins it onto a
base, and only after confinement.

A future path-bearing field must land in one of these two classes by an
explicit amendment to this section — it is not an implementation detail.
(The desktop main process → its own local daemon control edge — e.g.
`host_outbound_attach.config_path` — is host-local on both ends and is not
this boundary at all.)

Concretely, `runtime_start.options` MUST be `.strict()` typed metadata and
MUST NOT contain, **at any nesting depth**:

- `cwd`
- `workspace_path`
- `home_dir`
- `system_prompt_path`
- `spawn_dir`
- `system_prompt` / `system_prompt_text`
- `memory_text`
- `consensus_text` (the removed consensus payload)
- precomposed `env` maps

That list is enforced in code, not by review alone:
`FORBIDDEN_RUNTIME_START_OPTION_KEYS` +
`rejectForbiddenRuntimeStartOptionKeys` walk the whole options object
(`packages/host/src/protocol.ts`), and each ref schema is `.strict()`, so a
new path field is rejected at schema validation rather than at spawn.

Ids are data; server-side path derivation, behavior, and bytes are not.
The daemon-host derives
cwd, L1/L2 paths, per-spawn `system-prompt.md`, shim dirs, and final
child env locally from those ids (§4.6, §5.1). Schema reviews for the
protocol package must reject unknown keys and the blacklist above on
sight; "passthrough options" is not an escape hatch.

**Direction key**: "Req" = request from server, daemon replies with a
matching **response** (sync, single arm). "Event" = unsolicited from
daemon, no reply — server fans out via the activity log / renderer event bus.

**Server → daemon requests (sync response):**

The tables below are the `runtime_*` control vocabulary. The agent-file
family named in the invariant above (`agent_materialize`, `agent_l2_seed`,
`agent_files_purge`, `agent_workspace_index`, `agent_workspace_tree`,
`agent_workspace_file_read`) rides the same boundary under the same rules;
its canonical shapes live in `packages/host/src/protocol.ts` with the
coordinate semantics owned by `workspace-layout-relocation-v1.md` §3.2/§3.4.

| Intent | Request params | Response arms |
|--------|----------------|---------------|
| `runtime_start` | `{ conversation_id, agent_id, options }` where `options` carries typed server metadata: `agent: { id, name }`, `workspace: { id, name, kind }`, `workspace_memory_index[]` (the same semantic ref shape), `session: { conversation_id, kind, title, parent_conversation_id?, parent_title?, spawned_by_agent_id?, members[] }`, `driver: { kind, cli_session_id?, model?, reasoning_effort?, fast_mode? }`, and `env_policy` (§4.3). Every ref is path-free — the daemon resolves the L1 home and each L2 bundle itself (§5.1). `runtime_start` is a message-less lifecycle command only — it carries no inbox rows and no delivery semantics; message delivery (including spawn-with-batch) goes through `runtime_deliver`. See `daemon-authoritative-delivery-v1.md` §10.2.1. | discriminated by `started`: `{ started: true, pid, started_at }` / `{ started: false, reason: 'init_cooldown', cooldown_until }`. Success means only "the daemon has/created the handle" — not ready, deliverable, or safe-boundary. |
| `runtime_stop` | `{ conversation_id, agent_id, mode: 'hard' }` (`mode` is a wire literal; the former `mode:'soft'` stdin-directive arm was deleted in #task:1558 — no product entry point) | `{ mode: 'hard', stopped, exit_code: number \| null }` (`exit_code` required-nullable — real value may ride on `runtime_exit` event when SIGTERM cascade still pending) |
| `runtime_clear_session` | `{ conversation_id, agent_id }` | `{ cleared: boolean }` |
| `runtime_deliver` | `{ conversation_id, agent_id, delivery_ids[], deliveries[], kind: 'message' \| 'schedule_fire', text, spawn_options }` where `deliveries[]` is **required and non-empty** (#task:2106 removed the optional container and the scalar `delivered_up_to_seq`; the daemon derives the disk sidecar high-water from `max(deliveries[].seq)`), `text` is the server-hydrated *unencoded* delivery text (the daemon's driver instance encodes via `encodeStdinMessage(text, cliSessionId)` before writing stdin) and `spawn_options` is consulted **only** if the daemon must spawn. The sole message-delivery command; the daemon inspects the real handle and picks spawn / write / enqueue / refuse. | a synchronous **custody disposition**, NOT a delivery ack: `{ disposition: 'spawning', pid, started_at }` / `{ disposition: 'admitted', pid, started_at }` / `{ disposition: 'deferred', pid, started_at }` / `{ disposition: 'refused', reason: 'startup_pending' \| 'draining' \| 'cooldown' (+ cooldown_until on cooldown) }`. "Sent to daemon" ≠ ack: rows stay in-flight (owner=connection) on `spawning`/`admitted`/`deferred`; `refused` rolls the batch back to pending (retriable). `delivered_at` moves **only** on the async `runtime_delivery_consumed` event. Full mechanism owned by `daemon-authoritative-delivery-v1.md` §10–§11. |
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
  a member of, as the same path-free semantic ref `{ id, name, kind }`.
  The daemon derives each workspace's L2 bundle dir from
  `(agent_id, workspace_id)` and renders the MEMORY.md coordinate
  itself; it does not receive memory bytes and does not receive a path
  to render them from. An entry whose L2 file is not present on this
  computer is rendered with no path at all (§4.6).

### 4.1 Workspace bundle (per spawn)

The workspace bundle is the per-spawn workspace context — distinct
from the session bundle because workspace data is stable across
conversations within a workspace.

- `id`, `kind` (`regular` | `dm` | `agent_home`), `name` — that is the
  whole ref. There is no `path` field: a workspace is a pure
  control-plane record, and the server has no path column to ship
  (`workspace-layout-relocation-v1.md` §3.1/§3.4).
- The per-`(agent, workspace)` on-disk bundle is derived daemon-side
  from those ids alone (§5.1). Which directory that is, is owned by
  `workspace-layout-relocation-v1.md` §3.2 — not by this doc and not by
  the server.

Note: workspace bundle does **not** carry conversation members —
that lives in §4.0 (conversation-scoped), not workspace (workspace
membership is a different list and is not what the prompt's "Members"
block renders).

### 4.2 Agent bundle (per spawn)

- `id`, `name` — that is the whole ref. There is no `home_dir` field
  and no compatibility fallback for one: the column was retired with
  the binding (`workspace-layout-relocation-v1.md` §3.4).
- The agent's L1 dir is resolved daemon-side by `resolveAgentDir`
  (`packages/host/src/daemon/agent-materialize/handler.ts`) as a single
  join of `agent_id` onto the daemon's explicitly configured agents
  root — that root is a required dependency with no implicit
  home-directory default (#task:1813). The daemon-host reads
  `<L1 dir>/system_prompt.md` locally; the server never reads or ships
  those bytes.

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
  the `local-embedded` sentinel lives only in
  `resolveControlPlaneUrlBinding()` (`packages/host/src/daemon/run.ts`),
  whose sole consumer is `resolveControlPlaneServerUrl` — it carries no
  path authority (the workspace-registry namespacing it once served was
  retired with the registry demotion, §5.1) and does NOT shadow URL
  injection.
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
keyed entirely by the semantic ids received in §4.0–§4.3. Every path in
the table is derived locally, never received:

| Source | Path (daemon resolves locally from ids) | Cap | Use |
|--------|-----------------------------------------|-----|-----|
| Agent identity (L1) | `resolveAgentDir(agent.id)` + `/system_prompt.md` | none (file is small) | "Initial role" block in per-spawn `system-prompt.md` |
| Workspace memory (L2) | `<bundle>/MEMORY.md`, where `<bundle>` = `resolveAgentWorkspaceBundleDir(agent.id, workspace.id)` for a regular workspace and the agent L1 home for `agent_home` | `MEMORY_INJECT_CAP_BYTES` (16KB) | "Active Workspace Memory" block |
| Workspace note catalog (L2) | `<bundle>/notes/**/*.md` | 16KB frontmatter read cap per note + 20 injected entries + 4KB UTF-8 complete rendered block; bodies excluded | "Memory Notes Catalog" block |
| Memory index | the same `<bundle>/MEMORY.md` derivation per `workspace_memory_index[]` entry, or **nothing** for an entry with no local L2 file | path-only, no read | "Workspace Memory Index" block; an entry with no local file is rendered "unavailable on this computer" rather than with a fabricated path |

The current workspace's own L2 needs no absolute path to be *usable* in
the prompt: the bundle root **is** the spawn cwd, so the coordinate the
Active Workspace Memory and Notes Catalog blocks speak is `.`
(`./MEMORY.md`, `./notes/`). That is a statement about those two blocks
only — **not** "no absolute path for the current workspace appears in the
prompt". The Workspace Memory Index is a second carrier of the same fact
and it lists a daemon-derived absolute `MEMORY.md` path for **every** entry
that has a local L2, the current one included:
`buildWorkspaceMemoryIndexFromRuntimeStartOptions`
(`packages/host/src/daemon/prompt-context.ts`) branches on `isCurrent`
for the label only, never for `memoryPath`. The absolute paths there are
daemon-resolved at render time, which is why this is a rendering choice to
revisit rather than a boundary violation.

**Two distinct local availability facts — do not conflate them:**

- **cwd admission** is a hard gate. Before spawning, the supervisor
  ensures the bundle dir (`mkdir -p`) and then requires it to be an
  existing directory the daemon can enter (`X_OK`); failing that it
  fails closed with the typed `workspace_bundle_missing` resolve error
  and the absolute path is logged host-side only, never put on the wire.
- **L1/L2 content availability** is best-effort and gates nothing. A
  missing or unreadable `system_prompt.md` yields an empty "Initial
  role" body; `MEMORY.md` is read through `readFileWithCap`, whose
  `missing` / `unreadable` / `present` outcome the renderer reflects; a
  workspace whose L2 file is not a readable regular file is simply
  offered without a path in the memory index. None of these three
  outcomes prevents a spawn.

The shared formatter helper that renders the final prompt text
(`buildSystemPromptFor`) lives in `packages/shared` and is invoked
**by the daemon process only**. Daemon-only helpers own local
read-with-cap and `DriverPromptContext` construction. The
byte-identical-assembly rule holds through the shared formatter
contract, but only daemon calls it. Server has no caller, no fs
read, no prompt context builder invocation.

## 5. Ownership by layer

The layer that owns each host-local fs / spawn / env responsibility:

- **Per-spawn `system-prompt.md` + `bin/silverhand` shim** — daemon-host.
  Daemon writes them from typed `runtime_start.options`; backend sends
  session + workspace + agent + env-policy metadata (§4.0–§4.3) only.
  Delivery text rides `runtime_deliver.text` (§4.5), not `runtime_start`.
- **Per-`(agent, workspace)` L2 bundle materialization** — daemon-host.
  Server ships the workspace bundle (§4.1) as ids only; the daemon
  derives the coordinate and creates it lazily at first spawn / seed.
- **Agent L1/L2 path resolution** — daemon-host, end to end. No path
  metadata is server-owned any more: the daemon resolves
  `<L1 dir>/system_prompt.md` from `agent.id` and `<bundle>/MEMORY.md`
  from `(agent.id, workspace.id)` (§4.6, §5.1).
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
- **Workspace creation / onboarding** — creation is **DB-only**: a
  workspace row plus membership, and the onboarding row writes (inbox,
  `conversation_agents`, messages) → server. There is no fs step at
  creation time on either side (`workspace-layout-relocation-v1.md`
  §3.4).
- **Host-fs side-effects of route handlers** — route handlers stay
  server (DB writes + ACL) and hold **zero** agent-host fs code; the
  side-effects are typed intents to the owning daemon
  (`agent_materialize` → L1, `agent_l2_seed` → L2,
  `agent_files_purge` → deletion). The former backend
  `workspace-files.ts` was removed with D4.e-5, and
  `packages/backend/src` is kept fs-free structurally (§5.1).
- **DB file** (`<data_dir>/silverhand.db`) — server. Daemon never opens
  the DB file.

### 5.1 Host-local path authority (semantic ids in, paths resolved daemon-side)

The control-plane / execution-plane split has a path-resolution half: the
backend speaks semantic ids, and the placement-selected daemon is the sole
authority for every host-local absolute path.

- **Backend derives zero host-local paths.** `packages/backend/src` performs no
  agent-host path resolution and puts no path **of its own** into any outbound
  frame or agent-facing DTO; the daemon-stamped strings it relays verbatim
  (§3.3) are the only paths that leave it. `buildRuntimeStartOptions`
  (`packages/backend/src/runtime/runtime-start-options.ts`) emits only semantic
  refs — `agent {id,name}`, `workspace {id,name,kind}`, a
  `workspace_memory_index`, plus session/driver/env-policy fields — never
  `workspace_path` / `home_dir` / `agentHomeDir`. Enforced structurally by
  `packages/backend/tests/dependency-guard-no-agent-host-fs.test.ts`, whose
  four assertions are scoped, not blanket: no `node:fs` under `backend/src`
  outside a justified backend-local-infra allow-list; no `node:fs` / `node:path`
  in the `runtime_start` builder; none of the tokens `workspace_path` /
  `home_dir` / `silverhandDir` / `agentHomeDir` in that builder; and no
  `home_dir` key anywhere in `backend/src`.
- **The daemon maps refs → paths deterministically, failing closed.**
  `resolveRuntimeStartPaths`
  (`packages/host/src/daemon/runtime-start-resolve.ts`) computes every path from
  ids alone: the agent L1 dir via `resolveAgentDir`, and each workspace bundle
  via `resolveAgentWorkspaceBundleDir(agent_id, workspace_id)`. There is no
  lookup step and nothing to be "bound" first. The typed refusals are
  ownership / safety ones, not L2 gates: an `agent_home` ref whose id is not
  this agent's own home workspace id → `workspace_not_provisioned` (never
  silently normalized onto the current agent's L1); a bundle dir that cannot be
  created or entered → `workspace_bundle_missing`, raised by the supervisor's
  `ensureRuntimeStartWorkspaceCwd` (§4.6); and `registry_unavailable` for the
  three refusals below. That code's name is legacy — since the registry
  demotion nothing behind it consults a registry — so read it by producer, not
  by name:
  - **No agents root can be resolved at all.** `agentsRootFor`
    (`packages/host/src/daemon/run.ts`) backs the required
    `agentHomeRootDir` and throws when `root === undefined`. Two distinct
    causes land here: the pre-registration window in slot mode (desktop
    passed a computers root but no slot is resolved yet), **and** a bare
    daemon that holds an accepted binding but has neither a slot root nor an
    explicit one. Binding state is therefore not the predicate — a bound
    daemon can still hit this — and there is deliberately no home-relative
    default to fall through to (#task:1813).
  - **An id that cannot be a safe path segment**, raised by
    `assertSafeWorkspaceIdSegment` via `resolveAgentWorkspaceBundleDir`.
  - **No authenticated control-plane binding** where the *computer identity*
    itself is needed — `resolveAuthenticatedComputerId(null)`, which stamps
    the prompt's provenance line rather than resolving a path; a runtime must
    not spawn believing it sits on a placeholder computer.
- **The workspace registry is not in the runtime path.** The daemon-local
  registry JSON (`packages/host/src/daemon/workspace-registry/registry.ts`) was
  demoted to a **read-only migration inventory reader** with exactly one
  consumer, the one-time layout relocation (`layout-relocation.ts`); it fails
  closed as `registry_foreign` / `registry_corrupt` and is never consulted to
  resolve a spawn. Its slug helpers are marked HISTORICAL COORDINATE ONLY.
  Rationale and retirement scope: `workspace-layout-relocation-v1.md` §3.4.
- **Ids become path components only after strict validation.** A workspace id
  becomes a path segment only through `assertSafeWorkspaceIdSegment`
  (`packages/host/src/daemon/workspace-path-authority.ts`,
  `^[A-Za-z0-9_-]{1,64}$` — no separators, no dots, so `../escape` is
  impossible by construction); an unsafe id fails closed and is never
  "repaired" by hashing. The agent L1 dir is ONE join of the composition root's
  agents root + `agent_id` (`resolveAgentDir`), and that root is a REQUIRED
  explicit coordinate — #task:1813 removed the `homedir()`-derived fallback, so
  a missing root is a refusal at the caller, not a silent legacy path.
- **Nothing is provisioned ahead of time and nothing is backfilled.**
  Workspace creation is a control-plane row plus membership — no fs
  provisioning, no path to record (`workspace-layout-relocation-v1.md` §3.4).
  The `(agent, workspace)` bundle is created lazily at first spawn / seed
  ("seeding is provisioning"), and the retired `WorkspaceRegistryBackfiller`
  (DB-path → `requested_path` rebind, #task:1612) has no successor: there is no
  per-item migration state to backfill once the coordinate is derivable.

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
