# Orchestration boundary — V1 (D2.0 design pass)

**Status**: DRAFT. D1 complete; D2.0 design pass while D1 soaks. No code change in this stage — this doc only locks the contract for where each responsibility lives in the V1 remote-backend topology.

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
- Blob metadata + blob policy decisions (which user/conversation owns
  which blob, expiration, mime/size limits).
- Intent issuance: when the server decides "agent X in conversation Y
  must wake", that decision is server-side.

Server **must not**:

- Read/write the user's filesystem (no `node:fs` against user-machine paths)
- Resolve workspace local paths (`workspace.workspace_path` is opaque from
  server's perspective; only the daemon-host knows the real on-disk path)
- Resolve blob local paths (server stores logical blob ids; physical bytes
  live where the daemon-host says)
- Compose agent process env (no `SILVERHAND_*` env synthesis for spawn)
- Spawn child processes or write per-spawn shim files
- Read L1 `system_prompt.md` / L2 `MEMORY.md` / `CONSENSUS.md` from disk

### 3.2 Daemon-host-only (machine-local execution)

Daemon-host owns and is the only writer of:

- Per-host filesystem: `~/.silverhand/` (logs, blob storage, workspace
  roots, embedded-bootstrap file, host token, daemon socket, pid file,
  installation_id)
- Workspace materialization: creating `<workspace>/.silverhand/` directory
  tree, seeding agent L2 (`MEMORY.md` / `notes/` / `CONSENSUS.md`),
  resolving `workspace_path` from logical workspace id to absolute path
- Blob physical bytes: `node:fs` against blob storage paths, upload write,
  download read
- Spawn materialization: writing per-spawn `system-prompt.md`, `bin/silverhand`
  shim, deciding `process.env` composition, invoking driver CLI
- Agent process lifecycle: spawn, supervise, stdin write, stdout parse,
  stop/clear, run-state cache, activity log JSONL
- L1/L2 prompt-context reads: composing the system prompt from
  `system_prompt.md` + `MEMORY.md` + workspace `CONSENSUS.md` + workspace
  memory index (all from local fs)

Daemon-host **must not**:

- Issue ACL decisions (server is the gatekeeper; daemon receives validated
  intents only)
- Mutate authoritative DB rows directly (daemon talks protocol → server →
  DB; no direct DB connection from daemon process)
- Persist control-plane state beyond its own machine-local needs
  (installation_id, host token, run-state cache, activity log JSONL —
  none of these are "the durable record"; the server's DB is)

### 3.3 Boundary crossings (the V1 protocol surface)

Every cross-boundary call is a typed intent. PR-2 already defines the
runtime-intent vocabulary in `docs/silverhand-daemon-pr2-design.md`. D2.0
expands it as follows.

| Direction | Intent | Carries (server → daemon) | Returns / events back |
|-----------|--------|---------------------------|-----------------------|
| Down | `runtime_start` | logical workspace id + workspace bundle (see §4.1) + agent id + agent profile bundle (see §4.2) + driver kind + env policy (see §4.3) + optional startup delivery | `runtime_state` started/failed events |
| Down | `runtime_stop` | agent id + reason | `runtime_state` stopped / `runtime_exit` |
| Down | `runtime_clear_session` | agent id | `runtime_state` cleared |
| Down | `runtime_wake` | agent id + `delivery_ids[]` + composed text payload | `runtime_wake` delivered / failed |
| Down | `runtime_status` | host id | snapshot of run-state cache |
| Down | `runtime_stop_all` | (boot/shutdown) | per-agent exit events |
| Down | `runtime_close_activity_log` | (shutdown) | ack |
| Up | `blob_locate` (NEW for V1) | blob id | local path or "not present, please ship bytes" |
| Up | `blob_upload_chunk` (NEW for V1 sandbox; defer V1 main) | blob id + chunk | upload complete |
| Up | activity log events | `runtime_output` / `runtime_state` / `runtime_exit` / `runtime_startup_delivery_*` / `runtime_ready_for_drain` | server forwards to scope event bus |

**V1 simplification**: embedded mode keeps server + daemon-host on the same
machine. `blob_locate` is a no-op pass-through (server *can* read the local
path because they share fs). The protocol surface stays uniform so future
remote-deploy works without re-architecture.

## 4. Data that crosses the boundary

When the server hands intent to the daemon-host, it must hand over enough
**data** that the daemon can do its job without reading server-side state.
This section names each bundle.

### 4.1 Workspace bundle (per spawn)

The daemon receives, not just `workspace_id`, but the **resolved data** the
daemon needs to materialize spawn files:

- `workspace_id`, `workspace_kind` (`regular` | `dm`), `workspace_name`
- `workspace_path_strategy` — for V1 local daemon, the daemon already knows
  where to put workspaces (`~/.silverhand/workspaces/<id>`); for remote
  daemon, this is the daemon's local convention
- `members[]` — agent ids + display names + handles, for prompt context's
  member list
- `consensus_text` — workspace `CONSENSUS.md` content, server-rendered from
  authoritative source (not "read from disk"; server is the source of truth
  for `CONSENSUS.md` in V1+, see §6.2)
- `memory_index[]` — list of workspaces the agent is a member of, for the
  cross-workspace memory index injection

The server reads these from DB / from the L2 file (in V1 embedded mode the
files are still authoritative; D2.1 will migrate them into DB rows — see §6)
and ships them as data.

### 4.2 Agent profile bundle (per spawn)

- `agent_id`, `display_name`, `handle`, `runtime` (`claude` | `codex` | ...)
- `system_prompt_text` — content of L1 `system_prompt.md`, server-rendered
  (V1 embedded reads from disk; D2.1 migrates to DB)
- `memory_text` — content of active workspace L2 `MEMORY.md`, server-rendered
- `notes_index[]` — names + sizes of `notes/*.md` files in L2 (content NOT
  shipped; the agent reads them with its own Read tool)
- `role_pointer` — informational pointer back to L1 (so the prompt can say
  "edit `~/.silverhand/agents/<id>/system_prompt.md`")

### 4.3 Env policy (per spawn)

The server does NOT compose `process.env`. The server ships an **env policy**:

- `silverhand_vars` — `SILVERHAND_BACKEND_URL`, `SILVERHAND_AGENT_TOKEN`,
  `SILVERHAND_WORKSPACE_ID`, `SILVERHAND_CONVERSATION_ID`,
  `SILVERHAND_AGENT_ID` — values the server computes, daemon applies as-is
- `driver_vars` — driver-specific keys (e.g. `ANTHROPIC_API_KEY` policy:
  whose key, which model) — V1 daemon-local fallback only; remote-deploy
  will need a separate secret-routing decision (D3 scope)
- `path_prefix` — name of the per-spawn shim dir the daemon will create
  (daemon decides absolute path, server only knows the name)

The daemon then merges policy into its own `process.env` + per-spawn shim,
spawns the child, wires stdin/stdout.

### 4.4 Blob bytes (cross-boundary read)

For V1, blobs live on the daemon-host machine (embedded = same machine,
remote/sandbox = daemon's machine). When the server needs to expose a blob
to an HTTP downloader (e.g. avatar fetch, attachment download), V1 routes
the byte stream through the daemon → server protocol channel.

V1 simplification: embedded mode keeps blobs in `~/.silverhand/blobs/`,
server reads directly (same fs). The `blob_locate` intent is added but
implemented as pass-through. Remote-deploy in D3+ will actually exercise
the upstream byte transport.

## 5. Code-relocation map

Modules in `packages/backend/src/` that touch host-local fs / spawn / env.
Each row names the V1 destination + the migration step (D2 / D2.1 / D3).

| Module | Today | V1 destination | Step | Notes |
|--------|-------|----------------|------|-------|
| `spawn-prep.ts` | backend writes per-spawn shim + system-prompt.md | **daemon-host** | D2 | Already isolated; backend wraps in `runtime_start` intent payload; daemon executes |
| `workspace-files.ts` | backend reads/writes workspace `.silverhand/` | **daemon-host** | D2 | Materialization moves to daemon; server ships workspace bundle (§4.1) |
| `agent-profile.ts` | backend resolves agent L1/L2 paths | **split** | D2 | Path resolution → daemon. Logical agent fields → server. |
| `agent-workspace.ts` | backend ensures workspace dir exists per agent | **daemon-host** | D2 | |
| `storage/blob-file-storage.ts` | backend `node:fs` blob R/W | **daemon-host** | D2 | Server keeps blob *metadata*; bytes move via `blob_locate` |
| `runtime/spawn-env.ts` | backend composes spawn env | **split** | D2 | Policy composition → server. `process.env` merge → daemon (it owns its own env). |
| `runtime/prompt-context.ts` | backend reads L1/L2/CONSENSUS files | **split** | D2.1 | V1: stays server-side reading local fs (embedded only). D2.1 migrates L1/L2/CONSENSUS storage into DB so server reads DB, not fs. |
| `runtime/activity-log-writer.ts` | backend writes activity JSONL | **daemon-host** | D2 | Already runs in daemon under PR-2; backend wrapper retires |
| `runtime/run-state-cache.ts` | in-memory cache server-side | **daemon-host primary**, server cache mirror | D2 | Daemon is source of truth (per host); server caches projection per host |
| `runtime/daemon-agent-runtime-host.ts` | backend proxy to daemon | **server** (unchanged) | — | This is the server-side IPC client; correct boundary already |
| `runtime/daemon-runtime-wiring.ts` | backend wires daemon for embedded | **server** (unchanged) | — | Dynamic-import boundary stays; standalone mode skips this entirely |
| `runtime/control-plane-runtime-host.ts` | standalone fail-loud stub | **server** (unchanged) | — | Correct |
| `auth/embedded-bootstrap.ts` | backend writes one-shot bootstrap file | **daemon-host** | D2 | The file is host-machine-local; daemon should own write/read. Server issues the bootstrap token over protocol |
| `provision.ts` | backend creates workspace dirs | **daemon-host** | D2 | Pure fs materialization |
| `logger.ts` | reads `SILVERHAND_LOG_LEVEL` env, writes log files to `<data_dir>/logs/` | **split** | D2 | Server has its own log dir; daemon has its own. Today's backend logger conflates them |
| `db.ts` + migrations | reads/writes SQLite at `<data_dir>/silverhand.db` | **server** (unchanged) | — | Server is the DB owner; daemon never opens the DB file |

### 5.1 What's NOT in this map (deferred)

- Driver-specific env routing (e.g. per-user ANTHROPIC_API_KEY) — D3 scope,
  ties to secret storage. V1 stays daemon-local file convention.
- Sandbox box type as a second daemon-host — addressed by
  `multi-daemon-registry.md` v_next; V1 has exactly one daemon per host.
- OAuth / invite / multi-tenant — out of V1 entirely.

## 6. Storage boundary follow-ups (D2.1 candidates, NOT V1 acceptance)

Three current "L2 file" surfaces are local-fs by design but conceptually
authoritative data:

1. **`system_prompt.md`** — agent identity. Today: file on daemon-host disk.
   Server reads when composing system prompt. **Problem**: if backend runs
   remote, server can't read the file. **D2.1 fix**: migrate to DB row
   `agents.system_prompt_text`, file becomes a generated artifact.
2. **`MEMORY.md`** — workspace-scoped agent memory. Same problem, same fix
   (DB row keyed `(workspace_id, agent_id)`).
3. **`CONSENSUS.md`** — workspace-scoped, member-edited. Same problem,
   same fix (DB row keyed `workspace_id`).

V1 keeps the files. The boundary doc just acknowledges this is a known
asymmetry: server reads from local fs in embedded mode, which works
because embedded = same machine. **The protocol intents in §3.3 do not
ship file content from daemon up to server** — they ship resolved data
the server already has (§4.1, §4.2). When D2.1 migrates these to DB, the
data flow direction is unchanged; only the storage backend changes.

## 7. What this stage produces

D2.0 acceptance = **this doc accepted by shiki**. Concretely:

1. Guiding principle (§1) reaffirmed and linked from `auth-and-host-model.md`
2. Two-sided contract (§3.1, §3.2) accepted as the binding rule for
   D2 / D3 implementation reviews
3. Protocol surface table (§3.3) accepted as the V1 intent vocabulary
   (additions need explicit D2.0 amendment, not silent expansion in D2 PRs)
4. Code-relocation map (§5) accepted as the to-do list for D2
5. Storage boundary follow-ups (§6) accepted as the D2.1 scope marker

**Out of scope for D2.0**: protocol wire format details, message framing,
backpressure rules, retry / durability — all of that is D2 (durability
invariant) and D3 (transport). D2.0 is the *what lives where* contract; D2
is *how it's queued*; D3 is *how it's transported*.

## 8. Open questions for shiki

- **Q1**: For V1 remote-deploy (not in V1 acceptance, but for the boundary
  to be right), do we want the server to ever read blob bytes directly, or
  always proxy via daemon? Current draft says proxy. If we want server-side
  blob (e.g. for an HTTP CDN-fronted asset), the boundary needs a fourth
  storage tier and §4.4 must be revisited.
- **Q2**: D2.1 (file → DB migration for `system_prompt.md` / `MEMORY.md` /
  `CONSENSUS.md`) — gate it behind "remote backend actually shipped"
  or do it pre-emptively during D2? Pre-emptive removes the asymmetry but
  expands D2 surface. Currently drafted as separate stage.
- **Q3**: env policy (§4.3) for driver vars — V1 says "daemon-local
  fallback only", but if shiki wants per-user API-key UX from V1, the
  policy surface needs to ship secrets from server → daemon and the
  protocol needs encryption discussion. Currently drafted as defer-to-D3.

## 9. Revision history

- 2026-05-26 — Draft 0 (Alice). Skeleton + tables + open questions. Awaiting
  Cindy review and shiki direction on §8.
