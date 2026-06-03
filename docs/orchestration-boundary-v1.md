# Orchestration boundary — V1 (D2.0 design pass)

**Status**: DRAFT Rev 5. D1 complete; D2.0 design pass while D1 soaks. No code change in this stage — this doc only locks the contract for where each responsibility lives in the V1 remote-backend topology. Revision 1 (2026-05-26) folded @Cindy round-1 review; Revision 2 (2026-05-26) folded @Cindy round-2 review; Revision 3 (2026-05-26) folded @Cindy round-3 mechanical-shape-drift findings in §3.3. **Revision 4 (2026-05-27, contract anchor `81996a6`)** corrects the prompt/memory/consensus byte-ownership claim: under the V1 topology lock (daemon + agent always run on the user's desktop; server is control/state plane only), `system_prompt.md` / `MEMORY.md` / `CONSENSUS.md` byte content is **daemon-host local-fs truth**, not server-owned data. **Revision 5 (2026-05-27, D2.g corrective slice)** clarifies the path boundary: server DB path metadata (`agent.home_dir`, `workspace.path`, `workspace_memory_index[].path`) may cross as typed records; daemon-host derives cwd, prompt paths, spawn dirs, and env locally. D2.1 (file -> DB migration) is downgraded from "remote-deploy hard prerequisite" to **future / triggered by sandbox host or multi-device memory sync**. See §9.

**Predecessor docs to read first**:
- `docs/remote-server-target-architecture.md` — target topology
- `docs/auth-and-host-model.md` §7-§10 — host identity / token model
- `docs/remote-backend-roadmap.md` — V1 prep stage map (esp. D2.0 / D2 / D3)
- `docs/multi-daemon-registry.md` v5 status note — V1 vs future placement model
- `docs/silverhand-daemon.md` + `docs/remote-backend-architecture-notes.md` §5 — current daemon intent surface

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

### 1.1 V1 topology corollary (Rev 4 LOCK)

V1 topology is **fixed**: daemon and agent processes always run on the
user's desktop; the user's desktop is the only host that exists. Server
is a control / state plane only — even when "embedded" inside the
Electron main process, server code is conceptually a separate trust
domain that happens to share the desktop hardware. Sandbox hosts and
multi-device memory replication are **future** and explicitly out of V1.

Therefore, in V1:

- **Agent process always runs on the same machine where its
  prompt/memory/consensus files live.** The agent reads those files
  directly via its own driver tools (Read / Write) and via the
  per-spawn `system-prompt.md` the daemon materializes from local fs.
- **Server never needs the *byte content* of `system_prompt.md` /
  `MEMORY.md` / `CONSENSUS.md`.** The bytes are not used to compose
  anything server-side; the prompt rendered to the agent is rendered
  on the daemon-host from daemon-local fs reads.
- **Server still owns identity** (which agent / which workspace /
  which conversation) and **metadata** (workspace kind, agent handle,
  role labels, `agent.home_dir`, `workspace.path`). These path strings
  are DB metadata, not server-side fs operations. Daemon-host expands
  the typed metadata into cwd, prompt-file paths, spawn dirs, and
  local reads.

This corollary is what makes "server is in a different trust domain"
work without D2.1: there is nothing for the server to ship down,
because the bytes were never on the server in the first place.

## 2. Why D2.0 exists

D1 made backend a deployable Node server with embedded vs standalone modes,
but **kept all host-fs code in the backend package**. That works today because
embedded mode runs backend in-process inside Electron main, where Electron
*is* on the user's machine. The moment we deploy backend as a standalone
server (a remote container, a sandbox box, anywhere off the user's machine),
every host-fs call becomes a lie.

D2.0 names every such call site, decides which side of the boundary it
belongs on, and freezes the protocol intent that carries the work across.
**D2** (daemon outbound transport, desktop-local host only) and
**D3** (desktop local-daemon lifecycle wired to outbound) implement
against this contract. **D2.1** (file → DB migration for prompt-composition
surfaces, §6.1) is **future** — Rev 4 downgraded it from "remote-deploy
hard prerequisite" to "triggered by sandbox host or multi-device memory
sync requirement". V1 single-desktop topology never needs it because the
agent process and the prompt/memory/consensus files always coexist on
the same daemon-host (§1.1). **Without D2.0 locked, D2/D3 become moving
targets.** Stage names match `docs/remote-backend-roadmap.md`.

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
- **Agent / workspace identity & metadata** — DB-row content for agents
  (`agents` row: id, display_name, handle, runtime, model, home_dir,
  …), workspaces (`workspaces` row: id, kind, name, path, …),
  workspace consensus *metadata* (e.g. revision pointer, member list).
  Server is the only writer. **Server does NOT own the byte content
  of `system_prompt.md`, `MEMORY.md`, or `CONSENSUS.md` — those are
  daemon-host local-fs truth (§1.1, §3.2)**. Server must not read,
  cache, ship, or persist that byte content over protocol.
- Intent issuance: when the server decides "agent X in conversation Y
  must wake", that decision is server-side.
- **Delivery text hydration / message formatting**: composing the
  *unencoded* delivery text the daemon will hand to its driver
  (today: `formatInboxBatch` / `formatLiveMessage` /
  `combineGatedBatch`, plus attachment suffix, sender handle prefix,
  delivery instruction). Source data is exclusively server-owned DB
  rows (`messages`, `agent_inbox`, `attachments` metadata, sender
  handles). **Hydration MUST NOT depend on daemon-host fs content** —
  it never composes from `system_prompt.md` / `MEMORY.md` /
  `CONSENSUS.md` bytes; those bytes are not server inputs. Server
  owns hydration; the **driver-specific stdin encoding** is
  daemon-side (Option A v2 lock,
  `packages/host/src/protocol.ts:300-310` + `:387-417`). Same rule
  for `startup_delivery.text` on `runtime_start` and `soft_directive`
  on `runtime_stop`.
- Inbox row writes (`ensureDelivery`, `listPending`, `markDelivered`)
  — daemon never opens the inbox repo.
- **Activity log JSONL persistence** (`runtime/activity-log-writer.ts`):
  daemon emits `runtime_output` / control events; server persists the
  JSONL file and republishes to renderers via SSE. PR-2 §4.2 + §4.3
  lock this — `runtime_close_activity_log` semantics = daemon flushes
  outbound buffers, server then closes its writer.
- Run-state cache projection mirror: daemon is source of truth for
  per-host execution-plane state; server caches a projection for ACL'd
  HTTP / SSE consumers. (See §5.)
- SSE / event-bus fanout to renderers.

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
- **Read the bytes of `system_prompt.md` / `MEMORY.md` /
  `CONSENSUS.md`, or any agent-managed `notes/*.md`, from disk —
  full stop.** No "embedded shortcut", no transitional shim, no
  fallback path. Those bytes are daemon-host truth (§1.1 / §3.2);
  server reads identity rows + logical metadata only.
- **Persist or transport that byte content** (no `agents.system_prompt_text`
  column write, no `MEMORY.md` content uploaded over protocol, no
  CONSENSUS bytes attached to any intent or response).
- **Compose the agent's prompt block** (no server-side
  `buildPromptContext`, `buildSystemPromptFor`, `prepareSpawnFiles`,
  or any helper that materializes the per-spawn `system-prompt.md`
  from prompt/memory/consensus bytes). Prompt assembly is daemon-host
  work; server ships identity + metadata bundles (§4) and a
  `runtime_start` intent.

### 3.2 Daemon-host-only (machine-local execution)

Daemon-host owns and is the only writer of:

- Per-host filesystem: `~/.silverhand/` (daemon logs, workspace
  roots, embedded-bootstrap file, host token, daemon socket, pid file,
  installation_id, per-spawn shim dirs). **Excludes** `~/.silverhand/blobs/`
  in V1 main (server data dir — see §3.1).
- Workspace materialization: creating `<workspace>/.silverhand/`
  directory tree, seeding agent L2 (`MEMORY.md` / `notes/` /
  `CONSENSUS.md` skeleton), and deriving local runtime paths from the
  typed `workspace.path` metadata it receives.
- Agent L1/L2 fs mutation: `~/.silverhand/agents/<id>/system_prompt.md`
  + `MEMORY.md` + `notes/*.md` writes, `<workspace>/.silverhand/agents/<id>/`
  scaffolding, agent-deletion `fs.rm` of L1/L2 directories
- Spawn materialization: writing per-spawn `system-prompt.md`,
  `bin/silverhand` shim, deciding `process.env` composition, invoking
  driver CLI
- Agent process lifecycle: spawn, supervise, stdin write, stdout
  parse, stop/clear, run-state cache (source of truth, per host).
  Daemon emits `runtime_output` + control events; **server**
  persists the activity-log JSONL (see §3.1; PR-2 §4.2).
- **Driver-specific stdin encoding** via the in-process driver
  instance whose state is authoritative: `driver.encodeStdinMessage(text, cliSessionId)`,
  readiness gating / `driver_not_ready` short-circuit, codex thread
  state, soft-directive encoding (Option A v2 lock,
  `packages/host/src/protocol.ts:300-310` + `:387-417`). Backend
  ships unencoded text (§3.1 delivery hydration); daemon encodes per
  driver.
- Daemon-local logs: `~/.silverhand/run/daemon-<utc>.log`, pid file,
  installation log, supervisor's own structured logs. **Excludes**
  the activity-log JSONL — that is server-persisted (see §3.1).
- **Prompt / memory / consensus byte content** (`system_prompt.md` at
  L1, `MEMORY.md` and `notes/*.md` at L2, workspace `CONSENSUS.md`):
  daemon-host owns the bytes end-to-end — read, write, cap, render.
  Daemon assembles the per-spawn `system-prompt.md` from these local
  reads at spawn time (see §4.6). Server is **not a writer, not a
  reader, not a transport** for these bytes. The agent process running
  on the same daemon-host edits them via its own driver tools.
- L1/L2/CONSENSUS **prompt-file materialization & path rendering**:
  rendering daemon-local absolute paths into the per-spawn
  `system-prompt.md`, deriving memory paths from `agent.home_dir`,
  `workspace.path`, and `workspace_memory_index[].path`, writing the
  per-spawn shim. This is the same fs the bytes live on — so
  materialization is purely local.
- `notes/*.md` content lifecycle: notes are daemon-host local working
  storage for agent runtime (agent uses Read/Write tools at runtime).
  See §6 for the explicit decision and three guardrails.

Daemon-host **must not**:

- Issue ACL decisions (server is the gatekeeper; daemon receives validated
  intents only)
- Mutate authoritative DB rows directly (daemon talks protocol → server →
  DB; no direct DB connection from daemon process)
- Persist control-plane state beyond its own machine-local needs
  (installation_id, host token, run-state cache — none of these are
  "the durable record"; the server's DB is)
- Persist the activity-log JSONL — that is server-side per PR-2
  §4.2. Daemon emits events; server's `activity-log-writer.ts`
  consumes and persists.
- Hydrate delivery text from DB rows (server-owned per §3.1; daemon
  only encodes the unencoded text it receives)
- Pre-encode stream-json on the server (Option A v2 lock — that
  would freeze driver state outside the in-process driver instance)
- Read or write blob bytes (V1 main; future sandbox tier may add a
  daemon-local blob cache, see §5.1)
- **Ship `system_prompt.md` / `MEMORY.md` / `CONSENSUS.md` /
  `notes/*.md` content upward to the server** in any intent
  parameter, response field, or event payload. The bytes are
  daemon-host truth and stay there. If a future feature genuinely
  requires the bytes on the server (e.g. cross-host memory sync), it
  is a D2.1+ scope question (see §6.1) and needs an explicit D2.0
  amendment first.

### 3.3 Boundary crossings (the V1 protocol surface)

Every cross-boundary call is a typed intent. The runtime-intent
vocabulary is consolidated in `docs/remote-backend-architecture-notes.md`
§5 (daemon execution-plane split);
this section reproduces the canonical shapes (preserving the
`(conversation_id, agent_id)` tuple identity) and locks them as the
V1 vocabulary. **Additions need an explicit D2.0 amendment, not silent
expansion in D2/D3 PRs.**

**Path / byte invariant (Rev 5 LOCK, D2.g)**: path strings that are
server DB metadata may cross the boundary as typed records. In V1 that
means `agent.home_dir`, `workspace.path`, and
`workspace_memory_index[].path`. What may **not** cross are
daemon-derived execution artifacts, prompt/memory/consensus bytes, or
precomposed child-process env maps. Concretely,
`runtime_start.options` MUST be `.strict()` typed metadata and MUST
NOT contain:

- `cwd`
- legacy flat `workspace_path`
- `system_prompt_path`
- `spawn_dir`
- `system_prompt` / `system_prompt_text`
- `memory_text`
- `consensus_text`
- precomposed `env` maps

Allowed path metadata is data; forbidden fields are behavior or bytes.
The daemon-host uses the allowed base metadata to derive cwd, L1/L2 /
CONSENSUS paths, per-spawn `system-prompt.md`, shim dirs, and final
child env locally. Schema reviews for the protocol package must reject
unknown keys and the blacklist above on sight; "passthrough options" is
not an escape hatch.

**Direction key**: "Req" = request from server, daemon replies with a
matching **response** (sync, single arm). "Event" = unsolicited from
daemon, no reply — server fans out via the activity log / SSE bus.

**Server → daemon requests (sync response):**

| Intent | Request params | Response arms |
|--------|----------------|---------------|
| `runtime_start` | `{ conversation_id, agent_id, options, startup_delivery? }` where `options` carries typed server metadata: `agent: { id, name, home_dir }`, `workspace: { id, name, kind, path }`, `workspace_memory_index[]`, `session: { conversation_id, kind, title, parent_conversation_id?, parent_title?, spawned_by_agent_id?, members[] }`, `driver: { kind, cli_session_id?, model?, reasoning_effort?, fast_mode? }`, and `env_policy` (§4.3). `startup_delivery?` = `{ delivery_ids[], text }` per Option A v2 (unencoded text — daemon encodes or passes as oneShot initial input). | discriminated by `started`: `{ started: true, pid, started_at, startup_delivery_accepted? }` / `{ started: false, reason: 'init_cooldown', cooldown_until }`. Note `startup_delivery_accepted` is "attempt accepted", NOT "consumed" — the async `runtime_startup_delivery_consumed` event is the consumed signal. |
| `runtime_stop` | `{ conversation_id, agent_id, mode: 'soft' \| 'hard', soft_directive? }` per PR-2 Option A v2: `soft_directive` is **required** when `mode === 'soft'` (unencoded text, daemon encodes), **forbidden** when `mode === 'hard'` | discriminated by `mode`: `hard: { mode: 'hard', stopped, exit_code: number \| null }` (`exit_code` required-nullable — real value may ride on `runtime_exit` event when SIGTERM cascade still pending) / `soft: { mode: 'soft', directive_delivered, reason? in ['not_running' \| 'write_failed' \| 'driver_refused'] }` where `reason` is **required iff `directive_delivered === false`** and **forbidden iff `=== true`** (PR-2 `eMcEhycw8fQwucis` discriminator). **`directive_delivered === false` does NOT mean stopped** — soft never terminates the runtime. |
| `runtime_clear_session` | `{ conversation_id, agent_id }` | `{ cleared: boolean }` |
| `runtime_wake` | `{ conversation_id, agent_id, delivery_ids[], kind: 'message' \| 'schedule_fire', text }` where `text` is the server-hydrated *unencoded* delivery text (Option A v2 — daemon's driver instance encodes via `encodeStdinMessage(text, cliSessionId)` before writing stdin). `kind` is the PR-2 enum; expanding it requires a D2.0 amendment. | `{ delivered: true, delivery_ids[] }` / `{ delivered: false, delivery_ids[], reason in ['not_running' \| 'not_initialized' \| 'startup_pending' \| 'draining' \| 'driver_not_ready' \| 'driver_refused'] }` (failure carries the same `delivery_ids` so the caller keeps every row pending — no partial mark, per PR-2 §4.3 all-or-nothing) |
| `runtime_status` | `{ conversation_id?, agent_id? }` (PR-2 filter shape; both optional) | `{ runtimes: RuntimeStateDto[] }` — cache snapshot constrained by filter; empty filter = full snapshot known to this daemon. Filter is a narrowing operator, not a topology key; host placement is decided server-side before the call. |
| `runtime_stop_all` | `{}` (boot/shutdown sweep) | `{ stopped_count }` + per-agent `runtime_exit` events |
| `runtime_close_activity_log` | `{}` (shutdown) | `{ flushed: boolean }`. Semantics: daemon flushes outbound buffers; **server then closes its activity-log writer** (per §3.1 + PR-2 §4.3). |
| `runtime_output_pause` | `{ conversation_id, agent_id }` (PR-2 §2.2; backend stays in always-flowing mode in v0) | `{ paused: boolean }` |
| `runtime_output_resume` | `{ conversation_id, agent_id }` | `{ resumed: boolean }` |

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
same machine, but the protocol contract above is the single contract
for both embedded and standalone / remote-deploy — same intents, same
shapes, same path / byte invariant. D2 changes the wire transport
(daemon outbound); D3 wires the desktop local-daemon lifecycle into
that transport. **Any cross-machine data dependency that does not
already exist in this contract requires an explicit D2.0 amendment
before it can ride on a new field, sub-bundle, or "passthrough"
option.** No prompt-context fs reads on server, no D2.1 collapse —
under Rev 4 those reads are daemon-local (§4.6) and never were
server's job.

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
parentage" — the data daemon-host prompt hydration consumes to render
the platform prompt's session-context block. It rides on
`runtime_start.options` (and is implicit context for any subsequent
`runtime_wake` against the same conversation).

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

**Explicitly NOT in this bundle**: `consensus_text`. Consensus
*byte content* lives on daemon-host disk (`<workspace>/.silverhand/CONSENSUS.md`),
and the daemon reads it directly at spawn time (§4.6). For
single-member workspaces (`agent_home` / `dm`) the daemon may skip
the consensus block entirely; that is a daemon-side decision keyed
on `workspace_kind`, not a server-side omission of byte content.

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
or ship the index (see §6 guardrail 1). If a future prompt block wants
to hint about notes, the **daemon** enumerates and renders locally.

### 4.3 Env policy (per spawn)

The server does NOT compose `process.env`. The server ships an **env
policy** with explicit fields:

- `silverhand: { auth_token }` — the **server-minted** per-(conversation,
  agent) credential the daemon applies as `SILVERHAND_AUTH_TOKEN`, plus
  the protocol ids it already has (`conversation_id`, `agent_id`).
  Identity/authz is server-owned, so this legitimately rides the wire
  server→daemon→agent.
- `silverhand_cli` — launcher metadata for the local `silverhand` shim.
  **Optional / host-overridable** (Rev 6 LOCK): standalone server does
  not ship it; the daemon resolves the host-local CLI launcher itself
  (release `Resources/silverhand-cli/cli.mjs`, dev
  `packages/cli/dist/cli.js`). If a legacy server still ships a fallback
  `{ command: 'silverhand', args: [] }`, the daemon overrides it with the
  host-local launcher — otherwise the per-spawn shim's own dir, prepended
  to PATH, resolves `silverhand` back to the shim and the shim recurses
  into itself (the outingguy 2-minute hang, 2026-06-03).
- `proxy: { url, allowlist }` — the user-configured proxy policy. **Rev 4
  correction**: proxy is daemon-host local truth (`proxy-config.json`),
  NOT server state; the daemon reads it locally and applies it only when
  the runtime is allowed. Kept here only to document that it is NOT on
  the `runtime_start` wire.

The daemon merges policy into its own `process.env` + per-spawn shim +
`driver.applyEnv()` (driver-specific env transform; daemon-side only,
never invoked on the server), spawns the child, wires stdin/stdout.

#### 4.3.1 `SILVERHAND_SERVER_URL` is host-local truth (Rev 6 LOCK, anchor `df5a007`)

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

Why this is a LOCK and not a value-fix: before `df5a007` the server
shipped its own bound URL as `server_url`. Embedded only *appeared*
correct because bind == loopback == reachable (coincidental
correctness); standalone bind `0.0.0.0:8080` ≠ reachable (sandbox public
origin) exposed the model error as a fatal `upstream_unavailable`. The
field is removed from the wire entirely so the boundary cannot regress to
"server echoes its own bind address as the host's reach address". This is
§5.2 calling-boundary applied to `runtime_start`: server ships
server-minted identity (`auth_token`), host owns its own topology
(`server_url`, `silverhand_cli`, `proxy`).

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
- Daemon never sees blob bytes. When a delivery text bundle (§4.5)
  references attachments, the server's hydrated `text` already inlines
  the attachment-suffix block; `attachment_snapshots[]` rides along as
  metadata only. If the agent's driver tools later need to read the
  attachment file (e.g. `silverhand file view`), the resolution goes
  back through server HTTP, not through a daemon-local path.

Implication for `silverhand file view` in remote-deploy: returns a
server download URL (signed / ACL'd via existing routes), not a
daemon-local fs path. Embedded mode may keep the current
local-path-resolution shortcut as an optimization, but the contract
the agent sees is "URL or URL-like handle, fetch via http".

Daemon-local blob cache / sandbox blob tier is a future storage
optimization, not V1; see §5.1.

### 4.5 Delivery bundle (per wake / per startup_delivery / per soft_directive)

`runtime_wake` / `runtime_start.startup_delivery` / `runtime_stop.soft_directive`
all carry an unencoded delivery text bundle. **Boundary lock (Option
A v2)**: server hydrates the text from DB rows; the daemon's
in-process driver instance — which holds authoritative driver state
(cli_session_id, codex thread state, readiness) — does the
driver-specific stdin encoding via `encodeStdinMessage(text, cliSessionId)`
and writes to stdin. Backend MUST NOT pre-encode (locked by Cindy
`UMGu36zoTDVuKWXi` in PR-2 review; see `packages/host/src/protocol.ts:300-310`
and `:387-417`).

Server-side hydration produces (and ships in `text`):

- `delivery_ids[]` — inbox row ids covered by this batch. PR-2 §4.3
  all-or-nothing markDelivered rule applies (wake / startup_delivery
  only; `soft_directive` is a single non-inbox directive).
- `text` — the unencoded delivery text. Server-side helpers today:
  `formatInboxBatch` (multi-row batched drain),
  `formatLiveMessage` (single live delivery),
  `combineGatedBatch` (compose under driver gating rules), plus
  attachment suffix rendering, sender handle prefix, delivery
  instruction. Output is **plain text**; it is NOT a
  pre-serialized `stream-json` user message.
- `attachment_snapshots[]` — `AttachmentSnapshot` records for any
  attachments referenced (id + filename + size + content_type, per
  `AttachmentSnapshotSchema`). These are passed through to the
  formatter for inline rendering inside `text`; daemon does not
  re-resolve them.

Daemon-side, per delivery (per `text` field):

- `driver.encodeStdinMessage(text, cliSessionId)` — driver-specific
  framing into stream-json or whatever the runtime expects on stdin.
  This is the **only** place stream-json encoding happens for V1.
- Readiness gating: `driver_not_ready` short-circuit before write
  attempt; codex thread state held in driver; soft-directive encoding.
- The async `runtime_startup_delivery_consumed` / `_failed` events
  carry the daemon's per-delivery outcome (PR-2 §3.2).

`driver_capabilities` (e.g. claude vision support) is **computed
server-side from the agent's runtime + model** and consumed at
hydration time (whether to inline an image attachment, etc.). It is
not shipped as a separate field — the resulting `text` already
reflects the decision.

V1 ships the bundle whether the embedded daemon needs the
contract-strictness or not; locking it now means D2 implementation
does not re-derive the encoding boundary mid-PR.

### 4.6 Daemon-host self-hydration (per spawn) — Rev 4 LOCK

The daemon-host is the only side that reads prompt / memory /
consensus byte content. At spawn time (handling a `runtime_start`
intent), the daemon reads the following from its **own local fs**,
keyed entirely by typed metadata received in §4.0–§4.3:

| Source | Path (daemon resolves locally) | Cap | Use |
|--------|--------------------------------|-----|-----|
| Agent identity (L1) | `<agent.home_dir>/system_prompt.md` | none (file is small) | "Initial role" block in per-spawn `system-prompt.md` |
| Workspace memory (L2) | `<workspace.path>/.silverhand/agents/<agent.id>/MEMORY.md` | `MEMORY_INJECT_CAP_BYTES` (16KB) | "Active Workspace Memory" block |
| Workspace consensus | `<workspace.path>/.silverhand/CONSENSUS.md` | `CONSENSUS_INJECT_CAP_BYTES` (4KB) | "Workspace Consensus" block; skipped when `workspace.kind ∈ {dm, agent_home}` |
| Memory index | use each `workspace_memory_index[].path` to render `<path>/.silverhand/agents/<agent.id>/MEMORY.md` | path-only, no read | "Workspace Memory Index" block (paths only, current workspace's MEMORY.md is the one read above) |

The shared formatter helper that renders the final prompt text
(`buildSystemPromptFor`) lives in `packages/shared` and is invoked
**by the daemon process only**. Daemon-only helpers own local
read-with-cap and `DriverPromptContext` construction. The
byte-identical-assembly rule still holds through the shared formatter
contract, but in V1 only daemon calls it. Server has no caller, no fs
read, no prompt context builder invocation.

If a file is missing or unreadable, the daemon emits the section
header with an empty body or omits the section per current
`readFileWithCap` semantics; this is a **daemon-side** decision,
not a server-issued instruction.

## 5. Code-relocation map

Modules in `packages/backend/src/` that touch host-local fs / spawn / env.
Each row names the V1 destination + the migration step (D2 / D2.1 / D3).

| Module | Today | V1 destination | Step | Notes |
|--------|-------|----------------|------|-------|
| `spawn-prep.ts` | backend wrote per-spawn shim + system-prompt.md | **daemon-host** | D2.g implemented | Backend helper deleted. Daemon writes per-spawn `system-prompt.md` + `bin/silverhand` shim from typed `runtime_start.options`; backend sends session + workspace + agent + env-policy metadata (§4.0–§4.3) + optional `startup_delivery.text` (§4.5 Option A v2) only |
| `workspace-files.ts` | backend reads/writes workspace `.silverhand/` | **daemon-host** | D2 | Materialization moves to daemon; server ships workspace bundle (§4.1) |
| `agent-profile.ts` | path construction for L1/L2 dirs | **split** | D2.g implemented for runtime_start | Agent/workspace path metadata rows stay server-owned and cross as typed `agent.home_dir` / `workspace.path`. **Daemon-local L1/L2 path rendering** (`<home_dir>/system_prompt.md`, `<workspace.path>/.silverhand/agents/<id>/MEMORY.md`) happens on daemon-host. |
| `agent-workspace.ts` | backend ensures workspace dir exists per agent | **daemon-host** | D2 | Pure materialization |
| `storage/blob-file-storage.ts` | backend `node:fs` blob R/W | **server (unchanged)** | — | **Q1 decision**: blob bytes are server data (§3.1 / §4.4). No relocation; the existing put/serve/locate/delete + sweep stays server-side. |
| `runtime/spawn-env.ts` | backend composed spawn env | **daemon-host** | D2.g implemented for runtime_start | Backend helper deleted from the runtime_start path. Env policy (§4.3, including server URL/token, launcher metadata, proxy policy) is built in `runtime-start-options.ts`; `process.env` merge + per-spawn shim path + `driver.applyEnv(process.env)` invocation happens in daemon-host `spawn-env.ts`. **Server never sends a generic env map and never invokes `driver.applyEnv`**. |
| `runtime/prompt-context.ts` | backend reads L1/L2/CONSENSUS files + composes `DriverPromptContext` | **daemon-host** | D2.g implemented | Rev 5 LOCK: in V1 topology server has no business reading these bytes (§1.1 / §3.1). Daemon-local helpers perform read-with-cap, memory-index path rendering, `DriverPromptContext` construction, shared `buildSystemPromptFor` invocation, and per-spawn `system-prompt.md` materialization. **Server backend MUST NOT import or call any helper that reads these files or returns composed prompt text** — this is a calling-boundary rule, not just a module-location rule (§5.2). |
| `runtime/activity-log-writer.ts` | backend writes activity JSONL from daemon events | **server (unchanged)** | — | PR-2 §4.2 + §4.3 lock: daemon emits `runtime_output` + control events; server persists JSONL and republishes via SSE. `runtime_close_activity_log` semantics = daemon flushes outbound buffers → server closes its writer. |
| `runtime/run-state-cache.ts` | in-memory cache server-side | **daemon-host primary**, server projection mirror | D2 | Daemon is source of truth (per host); server caches a per-host projection for ACL'd HTTP / SSE consumers. Server projection is rebuilt from `runtime_state` events; not persisted. |
| `runtime/daemon-agent-runtime-host.ts` | backend proxy to daemon | **server (unchanged)** | D2.g corrected | Server-side IPC client. It may format server-owned delivery text and build typed `runtime_start.options`, but MUST NOT hydrate prompt bytes, prepare spawn files, derive cwd/spawn paths, or compose child env. |
| `runtime/daemon-runtime-wiring.ts` | backend wires daemon for embedded | **server (unchanged)** | — | Dynamic-import boundary stays; standalone mode skips this entirely |
| `runtime/control-plane-runtime-host.ts` | standalone fail-loud stub | **server (unchanged)** | — | Correct |
| `runtime/delivery-coordinator.ts` | backend orchestrates deliveries | **server (unchanged)** | — | Server-owned per §3.1. PR-2 §4.3 locks this. |
| delivery-text formatter helpers (`formatInboxBatch` / `formatLiveMessage` / `combineGatedBatch`) | backend hydrates inbox/live rows into **unencoded** delivery text + attachment suffix + sender prefix | **server (unchanged)** | — | Server-owned per §3.1 / §4.5. Option A v2: backend ships unencoded text; daemon's driver encodes via `encodeStdinMessage(text, cliSessionId)`. **Backend MUST NOT pre-encode** (`packages/host/src/protocol.ts:300-310` + `:387-417`). |
| `runtime/status-projector.ts` | backend projects daemon snapshots into HTTP / SSE | **server (unchanged)** | — | Projection consumer of run-state cache (see above) |
| `auth/embedded-bootstrap.ts` | backend writes one-shot bootstrap file | **daemon-host** | D2 | File is host-machine-local; daemon owns write/read. Server issues the bootstrap token over protocol |
| `provision.ts` | backend creates workspace dirs / onboarding messages | **split** | D2 | Workspace **fs** materialization → daemon (via materialization intent). Onboarding **DB** row writes (inbox, conversation_agents, messages) → server. |
| `routes.ts` direct host-fs callers | `initWorkspaceDir`, `ensureAgentL1Dir`, `seedAgentL2` on workspace/agent create; `fs.rm` of L1/L2 on agent delete | **daemon-host** for fs ops | D2 | Route handler stays server (DB writes + ACL); fs side-effects become typed materialization intents to daemon. **Intent names below are illustrative — concrete vocab lives in the D2 implementation PR, not frozen in §3.3 V1 surface**: `workspace_materialize` / `agent_l1_seed` / `agent_l2_seed` / `agent_l1_rm` / `agent_l2_rm`. |
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

### 5.2 Calling-boundary rule (Rev 5 LOCK, anchor `81996a6`)

Code-relocation map rows above name the *destination package* for each
module. That's necessary but not sufficient — server backend can
silently re-acquire prompt-composition responsibilities by importing a
helper that reads daemon-host files, even if the helper "lives" in
`packages/host` or `packages/shared`. The calling-boundary rule:

- **Server backend (`packages/backend`) MUST NOT call any function
  whose effect is to read `system_prompt.md` / `MEMORY.md` /
  `CONSENSUS.md` / `notes/*.md` bytes from disk, derive daemon
  execution paths (`cwd`, `system_prompt_path`, `spawn_dir`), compose
  child `process.env`, or materialize per-spawn `system-prompt.md`,
  regardless of which package the function is declared in.** This
  includes daemon prompt-context builders, daemon spawn-prep helpers,
  read-with-cap against any of those files, and any future helper that
  takes an agent_id / workspace_id and returns prompt/memory/consensus
  bytes or composed prompt text.
- The daemon-host (today `packages/host`, plus the in-process daemon
  inside `apps/desktop` Electron main) is the only legitimate caller.
- D2 implementation reviews must run a static check (manual grep is
  fine in V1; an import-rule lint is the long-term answer) before
  merge. A backend caller that reaches a banned helper is an
  amendment-required signal, not a "fix it later" item.

This rule prevents the failure mode Cindy flagged in the kickoff:
`RuntimeStart.options` passthrough silently carrying derived fs values,
prompt bytes, or composed env. The protocol schema (§3.3) blocks the
*wire format* side; this rule blocks the *call-graph* side.

## 6. Storage boundary follow-ups

### 6.1 D2.1 (FUTURE): file → DB migration for prompt/memory/consensus

**Status (Rev 4 LOCK)**: future; not a V1 prerequisite. Triggered by:
- A second host kind appears in the topology (sandbox host, remote
  daemon-host, dedicated build server with agent-spawn capability),
  AND a single agent identity needs to be portable across those hosts.
- Multi-device memory replication enters scope (e.g. user wants a
  single agent's `MEMORY.md` to live on multiple desktops with
  authoritative sync). Today's product surface explicitly does not.

V1 single-desktop topology (§1.1) does not face either condition.
Daemon-host owns the bytes end-to-end; agent process and files share
the same fs; server has nothing to migrate because it never owned
the bytes (§3.1).

The three currently-file surfaces that *would* migrate when the
trigger fires:

1. **`system_prompt.md`** — agent identity. Today: file on
   daemon-host disk (L1, `~/.silverhand/agents/<id>/`). Future fix
   under D2.1 trigger: migrate to authoritative DB row
   `agents.system_prompt_text` (or object store with audited delivery
   to all hosts that materialize the agent); local file on each host
   becomes a generated artifact.
2. **`MEMORY.md`** — workspace-scoped agent memory. Same model
   (DB row keyed `(workspace_id, agent_id)`).
3. **`CONSENSUS.md`** — workspace-scoped, member-edited. Same
   model (DB row keyed `workspace_id`).

**Why this isn't a V1 prerequisite (Rev 4 reasoning, supersedes Rev 3
"hard prerequisite" framing)**: under §1.1 the agent process always
runs on the daemon-host that owns the files. There is no "server in
a different trust domain that needs the bytes" scenario, because the
server doesn't need the bytes at all — it only needs identity rows
and metadata. The Rev 3 framing was correct for "server composes the
prompt, ships down" but wrong for V1: V1 daemon composes the prompt
locally (§4.6), so there's no shortcut to fix.

**When the trigger fires**: D2.1 design becomes its own roadmap
stage. It will need to redefine §3.1 / §3.2 / §4 to add an authorized
sync channel between server (or object store) and daemon-host;
re-pick which side renders the prompt; add invalidation / conflict
rules. None of that work belongs in V1 — pre-emptively migrating
now would freeze a contract for a topology we don't have, and risk
constraining the eventual sandbox / multi-host design.

V1 acceptance: daemon-host owns prompt/memory/consensus bytes;
server reads identity + metadata only; D2.1 is parked.

### 6.2 `notes/` decision — daemon-host local working storage

`notes/` (the per-agent free-form `<L2>/notes/*.md` knowledge files)
shares ownership with `system_prompt.md` / `MEMORY.md` /
`CONSENSUS.md` under Rev 4: daemon-host local-fs truth, not server
data. Decision (Cindy + Alice 2026-05-26):

**`notes/` is daemon-host local working storage / agent-readable
filesystem content.** Agents Read/Write notes at runtime via their
own tools (Read/Write/Bash/Grep). notes/ content is **not**
authoritative control-plane data; the server makes no promise that
notes/ content is server-known, ACL-evaluable, prompt-hydrated,
cross-host available, or remote-restorable.

Under Rev 4 this is now consistent with the broader prompt/memory/
consensus rule — none of those bytes are server data; daemon-host
owns them all. The three guardrails below remain binding (they are
the concrete implementation rules; the broader rule lives in
§3.1 / §3.2 / §5.2):

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

1. Guiding principle (§1, §1.1) reaffirmed and linked from
   `auth-and-host-model.md` — V1 topology corollary binding
2. Two-sided contract (§3.1, §3.2) accepted as the binding rule for
   D2 / D3 implementation reviews — including Rev 4 byte-content
   ownership: server does not read / persist / ship
   `system_prompt.md` / `MEMORY.md` / `CONSENSUS.md` / `notes/*.md`
   bytes
3. Protocol surface tables (§3.3) accepted as the V1 intent vocabulary
   (server→daemon requests + daemon→server unsolicited events;
   additions need explicit D2.0 amendment, not silent expansion in
   D2 PRs); the path / byte invariant in §3.3 lead-in is binding —
   `RuntimeStart.options` is strict typed metadata, allowing
   `agent.home_dir` / `workspace.path` path records but forbidding
   cwd / prompt paths / spawn dirs / prompt bytes / env maps
4. Data bundles (§4.0–§4.6) accepted as the cross-boundary data
   contract; §4.6 daemon-host self-hydration is the only place
   prompt/memory/consensus bytes are read in V1
5. Code-relocation map (§5) accepted as the to-do list for D2; §5.1
   deferred-list locked; **§5.2 calling-boundary rule** binding on
   every D2/D3 implementation review (no backend caller may reach a
   prompt/memory/consensus reader, regardless of host package)
6. D2.1 scope (§6.1) downgraded to **future** with explicit triggers;
   not a V1 prerequisite
7. `notes/` decision (§6.2) accepted; three guardrails binding on every
   D2/D3 implementation review
8. Decisions on Q1/Q2/Q3/Q4 (§8) accepted

**Out of scope for D2.0**: protocol wire format details, message
framing, backpressure rules, retry / durability — those are D2
(daemon outbound transport) and D3 (desktop local-daemon lifecycle
wired to outbound). D2.0 is the *what lives where* contract; D2 is
*how the daemon talks outbound*; D3 is *how desktop wires the daemon
lifecycle into that transport*. Stage names match
`docs/remote-backend-roadmap.md`.

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
- **Q2 (D2.1 timing)** → **Originally Rev 1 closed this as
  "pre-emptive, hard prerequisite for actually-remote deployment".
  Rev 4 supersedes**: under V1 single-desktop topology (§1.1), D2.1
  is **future**, not a V1 prerequisite — server does not own
  prompt/memory/consensus bytes, so there is no shortcut to fix
  before remote shipping. Triggers for re-opening D2.1: sandbox host
  appears, or multi-device memory sync enters scope (§6.1).
- **Q3 (env policy for driver vars)** → **V1 daemon-local fallback
  only.** Server does not ship provider secrets to the daemon in V1.
  Per-user secret routing (e.g. per-user `ANTHROPIC_API_KEY` UX)
  is deferred to D3 alongside secret store / encryption / rotation
  / audit design. See §4.3 / §5.1.
- **Q4 (prompt/memory/consensus byte ownership in V1 topology;
  closed Rev 4 2026-05-27)** → **Daemon-host owns the bytes
  end-to-end; server has zero responsibility for these bytes.**
  Server owns identity rows + logical metadata; daemon-host reads
  from local fs at spawn time (§4.6) and composes the per-spawn
  prompt locally. The protocol surface (§3.3) carries only typed base
  path metadata (`agent.home_dir`, `workspace.path`), never
  derived cwd / prompt paths / spawn dirs / bytes / composed env.
  The calling-boundary rule (§5.2) enforces this on the call-graph
  side. This closes the contradiction Rev 1–3 carried (server
  "conceptually owns" + V1 "transitional fs shim"): V1 had no
  ownership to begin with, so there is no shim.

If new open questions surface during D2/D2.1/D3 implementation
reviews, they go back into this section as Q4+, not silently
expanded in PR descriptions.

## 9. Revision history

- 2026-06-03 — **Revision 6 (Alice, codifying shiki-ratified boundary;
  anchors `b59d345` + `df5a007`, Cindy implementation)**. Remote-only
  dogfood surfaced a 3-bug chain (recursive `bin/silverhand` shim →
  fallback launcher → `server_url` shipped from server bind). §4.3
  rewritten: `silverhand` env policy now carries only the server-minted
  `auth_token`; `silverhand_cli` is optional/host-overridable; `proxy`
  noted as host-local (Rev 4). New §4.3.1 LOCK: `SILVERHAND_SERVER_URL`
  is host-local truth, injected by the daemon (standalone = outbound
  binding origin; embedded = Desktop-written
  `run/control-plane-server-url` file), removed from the `runtime_start`
  wire entirely, fail-loud on absence. Records the embedded
  coincidental-correctness lesson (bind==loopback==reachable masked the
  model error until standalone `0.0.0.0:8080` exposed it). §5.2
  calling-boundary applied to `runtime_start`: server ships identity,
  host owns topology.
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
- 2026-05-26 — **Revision 2 (Alice, post Cindy round-2 review
  `nRawYpLX7wklaoJH` against `b8641e3`)**. Folds two real blockers
  + nits without re-opening the round-1 closures:
  - Blocker 1 (delivery payload encoding boundary, Option A v2):
    Revision 1 erroneously wrote "server pre-encodes `stream-json`
    user-message bytes; daemon writes bytes to stdin", contradicting
    PR-2 protocol (`packages/host/src/protocol.ts:300-310`,
    `:387-417`) which holds Option A v2: server hydrates *unencoded*
    text; daemon's in-process driver encodes via
    `encodeStdinMessage(text, cliSessionId)`. Fixed §3.1 ("Delivery
    text hydration / message formatting"), §3.2 (added
    "Driver-specific stdin encoding" to daemon-only; added must-not
    "Hydrate delivery text from DB rows" / "Pre-encode stream-json
    on the server"), §3.3 `runtime_wake` wire field renamed
    `payload` → `text` with Option A v2 note, §4.4 attachment-suffix
    is server-inlined into `text`, §4.5 rewritten end-to-end as
    delivery text bundle (text vs encoding split, real helper names
    `formatInboxBatch` / `formatLiveMessage` / `combineGatedBatch`),
    §5 map row corrected (no `stdin-format.ts` / no
    `formatInboxAsUserMessages` — those names did not exist).
  - Blocker 2 (`activity-log-writer.ts` mis-placement): Revision 1
    erroneously relocated to daemon-host; PR-2 §4.2 + §4.3 keep it
    server-side (daemon emits `runtime_output` + control events,
    server persists JSONL + republishes SSE,
    `runtime_close_activity_log` = daemon flushes outbound buffers
    → server closes its writer). Fixed §3.1 (added "Activity log
    JSONL persistence"), §3.2 (removed from daemon-owned list;
    added "Daemon-local logs" with explicit exclusion of activity
    JSONL; added must-not "Persist the activity-log JSONL"), §3.3
    `runtime_close_activity_log` semantics row, §5 map row reverted
    to server-unchanged.
  - Nits folded: §3.3 `runtime_start` response = discriminated union
    on `started` with `init_cooldown` arm (`{started:false, reason,
    cooldown_until}`) and `startup_delivery_accepted` field
    explained; `runtime_stop` shape corrected to PR-2 Option A v2
    (`mode: 'soft'|'hard'`, `soft_directive?` required-iff-soft,
    discriminated response with `hard:{stopped,exit_code?}` /
    `soft:{directive_delivered,reason?}`); `runtime_wake` response
    `{delivered:true, delivery_ids[]}` / `{delivered:false, reason}`;
    `runtime_status` filter wording clarified as narrowing operator
    (not a topology key); §4.3 env-var names corrected to
    `SILVERHAND_SERVER_URL` / `SILVERHAND_AUTH_TOKEN` (per
    `packages/shared/src/config.ts:56-57`) — Revision 1's
    `SILVERHAND_BACKEND_URL` / `SILVERHAND_AGENT_TOKEN` were
    fabricated; §2 and §7 stage references corrected to roadmap
    truth (D2 = daemon outbound transport, D3 = desktop
    local-daemon lifecycle wired to outbound — Revision 1's "D2
    durability / D3 transport" was wrong); §4.2 `role_pointer`
    clarified as logical pointer/label (not server-generated
    absolute path); §5 `routes.ts` materialization-intent names
    explicitly marked illustrative (not D2.0 frozen vocab).
- 2026-05-26 — **Revision 3 (Alice, post Cindy round-3 review
  `Ck4KOLu_2rxPIphZ` against `88c7272`)**. No design change; §3.3
  table mechanically aligned to `packages/host/src/protocol.ts`
  canonical schemas after Cindy's `git diff --check b8641e3..88c7272`
  clean confirmation. Six drifts fixed:
  - `runtime_wake` request: restored `kind: 'message' | 'schedule_fire'`
    field (Rev 2 dropped it; PR-2 `protocol.ts:491-506` keeps it as
    a frozen 2-arm enum — expansion needs explicit D2.0 amendment).
  - `runtime_wake` failure response: added `delivery_ids[]` (Rev 2
    omitted; all-or-nothing markDelivered needs the round-trip
    context); reason enum tightened to PR-2's
    `not_running | not_initialized | startup_pending | draining | driver_not_ready | driver_refused`
    (`protocol.ts:509-534`).
  - `runtime_clear_session` response: `{ cleared: boolean }` not
    `cleared / not_running` flat strings (`protocol.ts:582-584`).
  - `runtime_close_activity_log` response: `{ flushed: boolean }`
    not bare `ack` (`protocol.ts:604-606`); flush-then-close
    semantics retained.
  - `runtime_output_pause` / `_resume` responses: `{ paused: boolean }`
    / `{ resumed: boolean }` (`protocol.ts:623-635`); pause and
    resume split into two rows since their result shapes diverge.
  - `runtime_stop` `hard` arm: `exit_code: number | null` required-
    nullable (Rev 2 wrote optional `exit_code?`, which would let the
    daemon omit the field entirely — discriminator weaker than
    `protocol.ts:420-432`). `soft` arm `reason` invariant made
    explicit (required-iff-`directive_delivered===false`,
    forbidden-iff-`===true`) per PR-2 `eMcEhycw8fQwucis` superRefine.
- 2026-05-27 — **Revision 4 (Alice, D2.0 amendment thread
  `#conv:zfHga0s5SR484gGS` off `#conv:xfqsa2NFiGn73AmA`; per shiki's
  V1-topology lock + Cindy's audit of `RuntimeStart.options`
  passthrough leaking server-resolved fs values)**. Corrects the
  prompt/memory/consensus byte-ownership claim. Rev 1–3 said server
  "conceptually owns" `system_prompt.md` / `MEMORY.md` /
  `CONSENSUS.md` content with a V1 transitional fs shim and D2.1 as
  remote-deploy hard prerequisite. That framing is wrong for V1: the
  topology lock (daemon + agent always on user's desktop; server is
  control/state plane only) means server has nothing to own and no
  shortcut to fix. Rev 4 lock: **daemon-host owns these bytes
  end-to-end; server reads identity + metadata only.** Folds:
  - **§1.1 (new)**: V1 topology corollary — agent process and
    prompt/memory/consensus files always coexist on the same
    daemon-host; server never needs the bytes.
  - **§2**: D2.1 framing changed from "remote-deploy hard
    prerequisite" to "future / triggered by sandbox host or
    multi-device memory sync".
  - **§3.1**: removed "Authoritative prompt-composition data" bullet;
    explicitly added "Server does NOT own the byte content of
    system_prompt.md / MEMORY.md / CONSENSUS.md"; tightened delivery
    text hydration note to clarify hydration sources are
    server-owned DB rows only, never daemon-host fs content;
    expanded "Server must not" with explicit no-read / no-persist /
    no-transport / no-prompt-compose rules.
  - **§3.2**: added "Prompt / memory / consensus byte content"
    bullet to daemon-host owned; added must-not "Ship
    prompt/memory/consensus/notes content upward".
  - **§3.3**: added Path / byte invariant lead-in — every server →
    daemon intent parameter forbidden from carrying server-resolved
    fs paths, byte content of L1/L2/CONSENSUS, or composed
    `process.env`. Closes the `RuntimeStart.options` passthrough
    leak that Cindy flagged in the kickoff. **V1 simplification
    paragraph at end of §3.3 rewritten** (Cindy round-1 review fold,
    blocker 1 against `1db02b1`): old wording leaked Rev 3 stage
    names ("wire transport changes (D3)") and Rev 3 framing ("the
    prompt-context fs reads in §3.1 collapse via D2.1"), both of
    which contradict Rev 4. New wording: same contract embedded vs
    remote-deploy; D2 = wire transport, D3 = desktop lifecycle; new
    cross-machine data dependency requires D2.0 amendment; no
    prompt-context fs reads on server, no D2.1 collapse.
  - **§4.1**: dropped `consensus_text`; pointed daemon-host self-read
    in §4.6.
  - **§4.2**: dropped `system_prompt_text`, `memory_text`; pointed
    daemon-host self-read in §4.6. Bundle is now identity + handles
    + runtime + role_pointer only.
  - **§4.6 (new)**: Daemon-host self-hydration table — names the
    four sources (L1 system prompt, L2 MEMORY, workspace CONSENSUS,
    memory index) with their daemon-local paths, caps, and
    prompt-block uses. The shared formatter helpers
    (`buildPromptContext` / `buildSystemPromptFor` / `readFileWithCap`)
    move to `packages/shared` but are invoked by the daemon process
    only.
  - **§5**: `runtime/prompt-context.ts` row changed from "split"
    (V1 transitional shim) to fully daemon-host. The "data
    hydration & capping → server" half is gone.
  - **§5.2 (new)**: Calling-boundary rule — server backend MUST NOT
    call any helper whose effect is to read prompt/memory/consensus
    bytes or materialize per-spawn `system-prompt.md`, regardless
    of which package the helper is declared in. Prevents silent
    re-acquisition of prompt-composition responsibilities via
    helper imports.
  - **§6.1**: D2.1 downgraded from "hard prerequisite" to "future,
    triggered by sandbox host or multi-device memory sync"; added
    explicit triggers + reasoning (V1 has no shortcut to fix
    because server never owned the bytes).
  - **§6.2**: tightened wording — `notes/` ownership is now part
    of the broader prompt/memory/consensus rule (Rev 4 made these
    consistent; previously notes/ was "the exception").
  - **§7**: acceptance bullets updated to reference §1.1, §4.6,
    §5.2, downgraded §6.1.
  - **§8**: Q2 superseded with Rev 4 framing; added Q4
    (prompt/memory/consensus byte ownership in V1 topology) closed
    here.
  - Code-side D2.g corrective slice (lifting
    `DaemonAgentRuntimeHost.start()` prompt composition into
    daemon-host) is owned by Cindy in a separate thread, anchored
    to this revision's commit hash.
- 2026-05-27 — **Revision 5 (Cindy, D2.g corrective implementation;
  contract anchor `81996a6`)**. Clarifies the path side of the Rev 4
  byte-ownership rule after shiki/Alice/Cindy alignment:
  - Path strings that are server DB metadata may cross the boundary as
    typed records: `agent.home_dir`, `workspace.path`, and
    `workspace_memory_index[].path`.
  - Derived execution artifacts remain forbidden on
    `runtime_start.options`: `cwd`, legacy flat `workspace_path`,
    `system_prompt_path`, `spawn_dir`, prompt/memory/consensus bytes,
    composed prompt text, and generic `env` maps.
  - §3.3 `runtime_start` canonical shape now matches D2.g wire code:
    `agent`, `workspace`, `workspace_memory_index`, `session`,
    `driver`, `env_policy`, and optional `startup_delivery.text`.
  - §4.0–§4.3 now spell the typed records the server sends; §4.6
    spells the daemon-local derivation from those base paths.
  - §5 map and §5.2 now reflect the implemented calling boundary:
    backend may build typed metadata and delivery text, but daemon
    owns prompt hydration, spawn-prep, cwd derivation, and final env.
