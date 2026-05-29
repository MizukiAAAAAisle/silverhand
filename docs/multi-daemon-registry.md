# Multi-daemon RuntimeHostRegistry — design

> **B.3 V1 status note (2026-05-25, Cindy)**: this document describes the
> future sandbox / multi-daemon target state. Stage B.3 V1 does **not**
> implement the §5 cache-key expansion, §6 `conversation_agents.runtime_host_id`
> column, or §9 single-host backward-compat migration. B.3 V1 keeps
> runtime placement on the existing user-owned trust-domain model:
> `agents.host_id` points at `hosts.id`; membership writes enforce
> `agent.host_id == workspace.workspace_host_id`, and runtime intent entrypoints
> fail closed when that host row is missing or revoked. Activating the
> daemon-routing design in §5/§6/§9 requires a real sandbox or remote daemon
> launch path first; until then, `RuntimeHostRegistry` remains reserved for that
> future daemon-routing layer.

> **Status**: v1 design doc. Not implementation. Landing this doc unblocks targeted PRs (registry skeleton, handshake-id wiring, `conversation_agents.runtime_host_id` migration). Two product decisions in §7 (placement) and §8 (sandbox UX) are flagged OPEN for @shiki — they shape later UI/UX surfaces but do **not** block landing this doc.
>
> **Reviewer**: @Cindy.
>
> **Must-read first**: `architecture-principles.md` §9 (control plane vs execution plane), `silverhand-daemon.md` (daemon scope + PR-1 intent surface).
> For the broader remote-server target topology and migration phase order, read
> `remote-server-target-architecture.md` first. This document owns only the
> RuntimeHostRegistry slice.
>
> **Revision history**: v1 (2026-05-22, Alice) — initial draft. v2 (2026-05-22, Alice) — Cindy round 1 review: identity model rewritten so daemon never reports `hosts.id` and never writes its own identity file from backend; §3 stops repeating handshake schema and flags the registry-identity payload as a cross-thread spec dependency; §6 tightens `runtime_host_id` as opaque placement key (not FK); cross-references fixed. v3 (2026-05-23, Alice) — Cindy round 2 review: `host_descriptor.kind` no longer includes `sandbox` (sandbox is a capability, not a host-kind — see §2.1); §2.5 added to close the identity-file locator loop via launcher-supplied `--daemon-home`; §3.2 names a concrete coordination requirement with #task:521 and a fallback `register_identity` intent if #521 has already merged; §4.1/§4.2 collapse identity resolution into a single `register({ client })` seam (no out-of-seam `hostRepo.getByName/create`); §3.3 `transport.*` capability reframed as post-connect observation, not connect-strategy input. v4 (2026-05-23, Cindy) — #task:521 absorbed `daemon_id`, `instance_id`, and `host_descriptor` into `HelloResult` / ready under `protocol_version=1`; the `register_identity` fallback is retired.
>
> **Sister threads** consumed verbatim, not redesigned here:
> - Handshake shape (`hello` intent, `protocol_version`, daemon identity fields, `capabilities`): protocol-handshake thread — see Alice's spec message (#conv:l6qhZlJZTIlU_B4-).
> - Per-boot `instance_id` (`${boot_started_at_ms}-${pid}`): orphan-reconcile thread (#conv:eYjn-XueWMhwP1bo).

---

## 0. What this doc owns / what it doesn't

**Owns**:
- The identity model that distinguishes "a daemon installation" from "a daemon process" from "a host machine".
- The backend `RuntimeHostRegistry` that replaces today's single `BackendContext.hostClient` field.
- The cache-key expansion that lets `RunStateCache` track multiple daemons safely.
- The DB column and migration story that lets existing installs upgrade with zero data loss.
- The single-host backward-compat path so the day-1 multi-daemon code behaves identically to today's single-daemon code.

**Does NOT own**:
- The wire format of the `hello` handshake — owned by the protocol-handshake thread (#conv:l6qhZlJZTIlU_B4-); this doc consumes the final shape, including the daemon identity fields. The schema itself, including `KNOWN_CAPABILITIES_V1`, lives in the handshake thread's spec.
- Per-call CLI argv / pidfile layout / orphan-cleanup mechanics — owned by the orphan-reconcile thread (#conv:eYjn-XueWMhwP1bo); this doc references the resulting `instance_id` only.
- Auth / capability tokens between backend ↔ remote daemon. Today the daemon socket lives at `~/.silverhand/run/daemon.sock` with `chmod 0o600`, and that's the only gate. Remote-auth deserves its own doc.
- Cross-daemon migration of a *live* (conv, agent). Placement is decided once at first-start. Mid-run handoff is explicitly out of scope.
- Multi-user / multi-tenant. v1 assumes one user, possibly many daemons under that user.

---

## 1. Motivation

Today's invariants (verified by code search 2026-05-22):

- `CreateBackendOptions.hostClient?: HostClient` — exactly one client, injected at boot by Electron main / `dev:headless`, wrapped by `RuntimeBridge`, `RuntimeEventHandler`, and `DaemonAgentRuntimeHost`.
- `RunStateCache` keys on `${conversationId}|${agentId}` and tracks a single `currentDaemonInstanceKey` to detect daemon swap.
- `conversation_agents` PK is `(conversation_id, agent_id)`. There is no column that records which daemon owns the runtime — the implicit answer is "the only daemon there is".

Why this stops working soon:

1. **Local + sandbox**. We want a "sandbox daemon" (restricted fs / no system PATH / different API keys) alongside the regular local daemon. The user picks per-workspace or per-agent which one runs the CLI. Today there's no place to even store that choice.
2. **Multiple execution hosts**. Desktop includes one local daemon host; sandbox is a headless daemon host. The server needs a registry so it can answer "where does this (conv, agent) run" without assuming the only daemon is the desktop-local one.
3. **Future remote daemon-host transport**. Same runtime placement shape, but daemon hosts connect to the server over an authenticated outbound transport instead of a local Unix socket. If we don't generalize now, we'll have to re-shape every PR-2-era struct later.

Per `architecture-principles.md` §9.3:

> host 是真正的安全边界：进程在哪个 host 上跑、能访问哪些 fs / API key，host 是 truth source. `host_id` membership precondition (`agent.host_id == workspace.host_id`) 已经把 host 建模成一等公民，PR-2+ 会把它从 ACL 字段提升为 runtime 协议端点.

The registry is that promotion.

---

## 2. Daemon identity — three layers + backend resolution

The system distinguishes **machine**, **installation**, and **process**. All three already exist implicitly; this doc names them. **Crucially**, the daemon side is DB-agnostic — it never reports a `hosts.id`. The DB row id is resolved backend-side at registration.

### 2.1 What the daemon reports (DB-agnostic)

| layer | format | scope | persists across | who generates |
|---|---|---|---|---|
| `daemon_id` | TEXT, stable per daemon installation | one daemon binary at one daemon-home directory | daemon restarts; durable until the user removes the daemon | written by daemon on first boot into `<daemon_home>/identity.json` (see §2.5 for `<daemon_home>` resolution) |
| `instance_id` | `${boot_started_at_ms}-${pid}` | one daemon process lifetime | NOTHING (regenerated every boot) | computed at daemon boot — same value the orphan-reconcile thread uses for pidfile namespacing |
| `host_descriptor` | `{ name: string, kind: 'local'\|'remote' }` | what machine / network host the daemon represents | identity-file lifetime | written by daemon on first boot into the same `identity.json` |

The daemon ONLY sees these three; it never reads or writes the backend DB. `host_descriptor.name` is a human-meaningful label like `'local'` or `'shiki-mbp-remote'`; `kind` matches the existing `HostKindSchema` enum verbatim (`packages/shared/src/db/schema.ts` — currently `local | remote`, no `sandbox`).

**Sandbox is intentionally NOT a `host_descriptor.kind` value.** Sandbox boundary is a *capability* concern (`fs.sandbox.<name>` and per-daemon mount metadata), not a machine concern. A sandbox daemon running on the same physical machine as the local daemon still reports `host_descriptor = { name: 'local', kind: 'local' }` — it shares the machine. What distinguishes it is (a) its own `daemon_id`, (b) `fs.sandbox.<name>` in `capabilities` instead of (or in addition to) `fs.local`, and (c) future mount-list metadata. This keeps the membership precondition `agent.host_id == workspace.host_id` (which compares DB `hosts.id` values) from accidentally fragmenting just because the user installed a sandbox daemon. The product question "should sandbox be a separate host_kind once we have a sandbox UX" stays in §8 OPEN — it is NOT silently decided here.

### 2.2 What backend resolves (DB-anchored)

`hosts.id` (the existing DB row id, a random base64url string) is **not** something the daemon knows or reports. Backend's registry resolves `host_descriptor` to a real `hosts.id` **inside its `register()` method** (§4.2 is the only seam):

```
// inside RuntimeHostRegistry.register({ client }):
const hello = await client.hello()
let row = hostRepo.getByName(hello.host_descriptor.name)
if (row && row.kind !== hello.host_descriptor.kind)
  throw new HostKindMismatch(row, hello.host_descriptor)      // operator error, fail loud
if (!row)
  row = hostRepo.create(hello.host_descriptor.name, hello.host_descriptor.kind)
const entry: DaemonEntry = {
  ...hello,                                                   // daemon-reported fields
  host_id: row.id,                                            // backend-assigned DB id
  client,
}
```

This preserves the existing `HostRepo.ensureLocal()` semantics: the local daemon reports `host_descriptor = { name: 'local', kind: 'local' }`; backend matches the existing `hosts(name='local')` row via `getByName`, no new row created.

It also matches the boot ordering reality: Electron main spawns the daemon and opens a HostClient *before* `startBackend()` opens the DB (`apps/desktop/src/main/index.ts:247-293` vs `packages/backend/src/index.ts:103-112`). So `client.hello()` cannot return a DB id — the DB isn't even open yet at that point. The registry's `register()` runs *inside* `startBackend()`, after DB + `HostRepo` are live, and is the one place that issues `client.hello()`.

### 2.3 Why three daemon-side layers + one backend layer

- **`daemon_id`** — routing handle. The registry maps `daemon_id → HostClient`. Answers "which daemon installation".
- **`instance_id`** — generation detection. **Never** used for routing. RunStateCache + pidfile-reconcile use it to detect "the daemon I was talking to restarted; drop stale local state". Answers "which lifetime of that daemon".
- **`host_descriptor`** — daemon's self-description of what host it represents. Drives backend's DB resolution. Answers "what machine / boundary".
- **`hosts.id`** (DB) — backend-assigned, exists only on the backend side. Answers "which DB row models that host". This is what membership precondition (`agent.host_id == workspace.host_id`) actually compares against; the daemon never sees it.

Folding any two of these is a trap:
- Folding `host_descriptor` into `daemon_id` makes one daemon binary unable to represent more than one host configuration. Sandboxes that share a daemon image but differ in mount can't be modeled.
- Folding `instance_id` into `daemon_id` makes restart undetectable — RunStateCache cannot tell "stale entry from a dead generation" from "live entry from current daemon" and would keep stale state forever (or flush everything on every reconnect, losing valid state).
- Folding `host_descriptor` into `instance_id` is the current bug: today's single `currentDaemonInstanceKey` does both jobs, which is why scaling to >1 daemon needs this rewrite.
- Folding `hosts.id` into the daemon-side surface (asking the daemon to report a DB id) is the v1-draft mistake Cindy caught — see "Revision history" at top.

### 2.4 Identity invariants

1. `daemon_id` is forever-stable for a given daemon installation. Reinstalling the daemon at the same socket path generates a fresh `daemon_id` (the install writes a new `identity.json`); the registry treats it as a different daemon. Renaming is not an operation.
2. Two live daemon processes claiming the same `daemon_id` is a crash-class bug. The existing `~/.silverhand/run/daemon.pid` + `kill(pid, 0)` guard prevents this at the single-daemon host level; multi-daemon needs the same guard per-`daemon_id` (suggested: pidfile under `~/.silverhand/run/daemons/<daemon_id>.pid`).
3. Same `daemon_id`, different `instance_id` = daemon restarted. Registry rebinds; RunStateCache drops every entry from the old `instance_id`.
4. `host_descriptor` rebinding of an existing `daemon_id` is forbidden. A daemon's host descriptor is fixed at install time. If the user wants to repurpose a daemon to a different host, that's a fresh install — fresh `daemon_id`.
5. Trying to register a `daemon_id` whose `host_descriptor` doesn't match the value the registry already has for it: throw `DaemonIdentityConflict`. Do not silently accept the new descriptor.
6. Resolving `host_descriptor.name` to an existing `hosts` row with a different `kind`: throw `HostKindMismatch`. This is an operator / corruption case, not a recoverable one.
7. **Backend never writes daemon-owned identity files**. `<daemon_home>/identity.json` is daemon-owned. If a connected daemon doesn't have it, that's a `daemon_too_old` failure and the operator must upgrade the daemon — see §9.

### 2.5 Identity-file locator — closing the chicken-and-egg

A daemon needs to know its own `daemon_id` before it can locate `<daemon_id>`-namespaced files. The bootstrap closes this loop via a launcher-supplied argv:

- Launcher (Electron main / `dev:headless` / packaged `.app`) passes `--daemon-home <abs_path>` when spawning the daemon. Convention: `~/.silverhand/daemons/<install_name>/` where `<install_name>` is launcher-decided (`local` for the default daemon, e.g. `sandbox-default` for an additional sandbox daemon).
- Daemon at boot reads `<daemon_home>/identity.json`. If absent: write a new one. Default content for first-boot writes is `{ daemon_id: <install_name>, host_descriptor: { name: 'local', kind: 'local' } }` — i.e., the launcher's install name doubles as the initial `daemon_id`. The launcher MAY override the seed by passing `--seed-daemon-id <id>` (used for fresh installs that want a UUID); the daemon writes that into the new identity file but does NOT re-read it from argv on subsequent boots. The file is the source of truth from second boot onward.
- If `<daemon_home>` doesn't exist, the daemon `mkdir -p`s it (single-user-readable: `chmod 0o700`).
- If `--daemon-home` is missing entirely (legacy launcher), default to `~/.silverhand/daemons/local/` for the single-daemon backward-compat path of §9. Multi-daemon launchers MUST pass it explicitly.

Why launcher-supplied:
- A daemon binary on disk does not know which "installation" it represents — `silverhand-daemon` could be the local daemon, the sandbox-default daemon, or a third user-added daemon, all reusing the same image. The launcher knows the user's intent (it's the one deciding which configuration to spawn); the daemon is configurable per-spawn via argv.
- Sandbox or remote-future daemons might live under a sandboxed fs mount where `~/.silverhand/` is not even visible. Launcher-supplied `--daemon-home` lets each daemon's home live wherever the deployment requires.
- Identity is not in argv directly (only the *path* is) — once written, the daemon never re-derives identity from argv. This avoids "operator passes wrong --seed-daemon-id, daemon silently changes identity" class of bugs. The argv is a locator, not authority.

Anti-pattern explicitly rejected: the daemon scanning `~/.silverhand/daemons/*` and picking one. Identity must be explicit per spawn; auto-pick races and surprise the operator.

---

## 3. Handshake — what the registry reads (cross-thread dependency)

The protocol-handshake thread (#conv:l6qhZlJZTIlU_B4-) owns the `hello` intent and the v1 `HelloResult` wire shape, including `protocol_version`, `daemon_version`, daemon identity fields, and the open `capabilities` enum with its `KNOWN_CAPABILITIES_V1` companion. **This doc does not repeat or re-define the schema.** Read the handshake thread for the authoritative schema.

### 3.1 Fields the registry consumes

From v1 `HelloResult`:
- `protocol_version` — fail-loud version gate (registry refuses to register a daemon whose version doesn't match `HOST_PROTOCOL_VERSION`).
- `daemon_version` — observation only (surfaced to logs / Settings UI).
- `capabilities` — placement input. See §3.3 for which strings the registry actually branches on.
- `daemon_id` — routing key.
- `instance_id` — generation tag.
- `host_descriptor` — resolved to DB `hosts.id` per §2.2.

The registry MUST NOT branch on anything else from `HelloResult` v1.

### 3.2 Registry identity fields — resolved coordination with #task:521

#task:521 absorbed `daemon_id`, `instance_id`, and `host_descriptor` directly into v1 `HelloResult` before `protocol_version=1` merged. The daemon also emits the same fields on the `ready` stdout event, and both emitters are fed by the same boot-time identity source. This keeps connection-time validation and explicit `hello` negotiation aligned.

The rejected fallback path was a separate `register_identity` intent after `hello`. Do not add that intent for v1: identity is part of `HelloResult`, and adding a second identity path would create two sources of truth for daemon registration.

Field shapes: `daemon_id: z.string().min(1)`, `instance_id: z.string().min(1)`, `host_descriptor: z.object({ name: z.string().min(1), kind: HostKindSchema }).strict()`. `HostKindSchema` is the existing `local|remote` enum — see §2.1 for why sandbox is NOT added.

### 3.3 How the registry consumes `capabilities`

`capabilities` drives **placement decisions only**, never runtime behavior:

- `runtime.<kind>` → an agent with `runtime: 'codex'` can only be placed on a daemon whose caps include `runtime.codex`. Mismatch = placement rejected at start, NOT mid-run.
- `fs.local` / future `fs.sandbox.<name>` → a workspace whose `workspace_path` lives outside a sandbox's accessible mount cannot be hosted by that sandbox daemon. See §8 for the sandbox UX OPEN question.
- `transport.unix_socket` → post-connect observation only. The launcher decides which transport to dial *before* the connection exists, so transport-strategy selection comes from launch config (argv / spawn-helper options), NOT from `capabilities`. The capability is used after-the-fact for validation (e.g. "launcher believed this daemon spoke unix_socket; daemon confirms — good") and surface (Settings UI shows it). When `transport.tcp` (future) becomes real, the launcher's spawn config gains a transport option; capability still only validates.
- `proxy.env_inherit` → spawn-env semantics. Already used by current single-daemon code; just declared explicitly now.

Capability changes across daemon restarts are allowed (an upgrade adds a new `runtime.*` capability) but **never demote an active placement**: a (conv, agent) already running on a daemon stays placed there even if a future upgrade removes the matching capability. The registry's enforcement window is "at placement decision time", not "every dispatch".

---

## 4. RuntimeHostRegistry

Lives in `packages/backend` (control plane). Replaces today's `BackendContext.hostClient` single field. The host package (`packages/host`) stays daemon-agnostic — it just speaks the protocol; it has no opinion about how many of itself exist.

### 4.1 Boot sequence

```
backend boot (after startBackend() opens DB and constructs HostRepo):
  registry = new RuntimeHostRegistry({ hostRepo })
  for each (HostClient client) Electron main / dev:headless provides:
    await registry.register({ client })
    // register() does:
    //   1. await client.hello()
    //   2. throw ProtocolVersionMismatch on version gate
    //   3. resolve hello.host_descriptor → hosts.id via hostRepo
    //      (getByName ?? create; throws HostKindMismatch on kind disagree)
    //   4. throw DaemonIdentityConflict if a known daemon_id reappears with a different host_descriptor
    //   5. store DaemonEntry; emit 'register' (or 'reregister' on same-id different-instance)
  // registry is the only object the rest of backend talks to.
```

The change from today: `startBackend({ hostClient })` becomes `startBackend({ hostClients })` (plural array), even if the array currently has length 1. Single-host installs pass `[localClient]`. `HostRepo` is constructed during `startBackend`, BEFORE `registry.register()` runs — resolution needs a live DB.

**`register()` is the single seam for identity resolution.** Callers hand in a raw `HostClient`; resolution, validation, and DB-row creation all live inside register(). Callers never call `hostRepo.getByName/create` themselves for daemon registration. This is enforced by the signature in §4.2 (register accepts `{ client }`, not a pre-resolved `DaemonEntry`).

### 4.2 Surface

```ts
interface RuntimeHostRegistry {
  // ── routing ──────────────────────────────────────────────────────
  // register() resolves host_descriptor → hosts.id internally; callers hand in
  // a raw client. Thrown errors are typed:
  //   - ProtocolVersionMismatch  — hello.protocol_version ≠ HOST_PROTOCOL_VERSION
  //   - HostKindMismatch         — host_descriptor.kind disagrees with the existing hosts row
  //   - DaemonIdentityConflict   — known daemon_id reappears with a different host_descriptor
  //   - DaemonTooOld             — hello missing required identity fields
  register(opts: { client: HostClient }): Promise<DaemonEntry>
  unregister(daemon_id: string): void              // socket close / shutting_down event
  lookup(daemon_id: string): DaemonEntry | null

  // ── placement ────────────────────────────────────────────────────
  candidatesFor(opts: {
    runtime: AgentRuntime,            // 'claude' | 'codex' | …
    workspaceHostId: string,          // membership precondition — compared against entry.host_id (DB id)
  }): DaemonEntry[]

  // ── observation ──────────────────────────────────────────────────
  list(): DaemonEntry[]
  on(event: 'register' | 'unregister' | 'reregister', cb: (e) => void): Unsubscribe
}

interface DaemonEntry {
  daemon_id: string                                       // daemon-reported, routing handle
  host_descriptor: { name: string, kind: HostKind }       // daemon-reported, identity claim
  host_id: string                                         // backend-resolved DB hosts.id (set by register())
  instance_id: string                                     // daemon-reported, generation tag
  daemon_version: string
  capabilities: ReadonlySet<string>
  client: HostClient
}
```

Notes on shape:

- `lookup` returns `null` instead of throwing because callers routinely check "is the daemon for this (conv, agent) still around?" — throwing would force ugly try/catches at every dispatch.
- `candidatesFor` returns an array (possibly empty), not a single entry. The picker (sticky vs per-call) is a separate concern — see §7.
- Events are needed by RunStateCache and by the renderer (it surfaces "daemon X went away" UX). Don't make consumers poll `list()`.

### 4.3 Lifecycle edge cases

**Daemon disconnects (socket close OR `shutting_down` event)**:
- `unregister(daemon_id)`. All in-flight requests on that client fail-loud (HostClient already does this).
- Pending wakes for (conv, agent) placed on that daemon: **not stashed in backend**. The DB inbox row remains undelivered. This preserves the Option-A-v2 invariant from the 2b-iii rework (`packages/host/src/protocol.ts` RuntimeWakeReason docs): the DB inbox is the only durable queue; backend may not invent a second one.
- On daemon re-registration, the existing `runtime_ready_for_drain` path fires once init completes; backend's existing drain code replays from the DB row.
- SSE projection: emit `agent_status reason='daemon_unavailable'` for every (conv, agent) placed on the gone daemon. New SSE reason; UI shows a tombstone state similar to `init_cooldown`.

**Daemon reconnects, same `daemon_id`, new `instance_id`** (= daemon restarted):
- Registry treats this as `reregister(daemon_id, instance_id)`. New `client` replaces old; `capabilities` may differ (upgrade); `daemon_version` may differ.
- RunStateCache drops every entry whose stored `instance_id` ≠ new `instance_id` for this `daemon_id`. See §5.
- The daemon's own pidfile-reconcile (orphan-reconcile thread) handles orphan child cleanup independently — registry does not need to coordinate.

**Daemon reconnects, same `daemon_id`, different `host_descriptor`** = corruption or operator error:
- Throw `DaemonIdentityConflict` at register. Do NOT accept the new descriptor. Surface via backend log + a user-visible toast (the Settings pane is the right home, once it exists).

**Two distinct `daemon_id`s reporting the same `host_descriptor`** (and therefore resolving to the same `host_id`):
- Allowed. This is exactly the local + sandbox-on-same-machine case. See §8.

**Registering more than one `daemon_id='local'`**:
- Reject. `daemon_id='local'` is reserved for the single-daemon bootstrap path (§9). New daemons must declare their own `daemon_id`.

---

## 5. RunStateCache key expansion

### 5.1 Today

```ts
// packages/backend/src/runtime/run-state-cache.ts (paraphrased)
entries: Map<string, CachedRuntimeEntry>          // key = `${conv}|${agent}`
currentDaemonInstanceKey: string                  // single instance, single string
```

### 5.2 Target

```ts
entries: Map<string, CachedRuntimeEntry>          // key = `${daemon_id}|${conv}|${agent}`

interface CachedRuntimeEntry {
  // existing fields …
  daemon_id:   string
  instance_id: string   // generation tag for stale-detection
}
```

### 5.3 Why include `daemon_id` in the key (not just on the entry)

One (conv, agent) is *eventually* placed on at most one daemon (placement invariant — §7 will firm this up). But during a placement transition (re-placement after a daemon goes permanently dark), backend may briefly hold both:
- the stale entry from the old `daemon_id` (so cleanup logic can find it), and
- the fresh entry from the new `daemon_id` (so dispatch keeps working).

Keying on `daemon_id` lets both coexist for the few hundred ms between "old marked stale" and "old swept". The single-key + tombstone alternative is more fragile because it loses the ability to distinguish "no entry yet" from "old entry being swept".

### 5.4 Cleanup triggers

- `registry.unregister(daemon_id)` → drop every entry with that `daemon_id`.
- `registry.reregister(daemon_id, new_instance_id)` → drop entries with same `daemon_id` and `instance_id ≠ new_instance_id`.
- Placement change for (conv, agent) (the re-placement admin action contemplated in §7) → drop the old `daemon_id` entries for that pair.
- Same-instance no-op (registry observes `register` for an already-known `(daemon_id, instance_id)` pair): no flush. This guards against "Electron main spawned twice on a duplicate ping" type races.

### 5.5 What `currentDaemonInstanceKey` becomes

Gone. Per-entry `instance_id` subsumes its job, and the registry's events subsume the swap-detection job. Removing the global field is a side benefit — it was a singleton bottleneck disguised as bookkeeping.

---

## 6. DB migration — `conversation_agents.runtime_host_id`

### 6.1 Column

```sql
ALTER TABLE conversation_agents
  ADD COLUMN runtime_host_id TEXT NOT NULL DEFAULT 'local';
```

The value stored in `runtime_host_id` is a **`daemon_id`** (per §2.1), NOT `hosts.id`. The naming is historical (it pre-dates the identity model in §2) and the column name reads "the runtime host of this (conv, agent)" where "runtime host" === "daemon". A column rename to `runtime_daemon_id` would be cleaner but is out of scope for v1; downstream readers should treat the value as `daemon_id`.

The default `'local'` is a **sentinel** aligned with the bootstrap path of §9: the local daemon's `identity.json` ships with `daemon_id = 'local'` for single-daemon installs (the daemon writes it, not backend). Existing rows therefore reference a real registry entry from the moment backend comes up — no separate data backfill pass is needed.

### 6.2 Why a column on `conversation_agents`, not a join table

Placement is a per-(conv, agent) edge property. The same agent in two different conversations may, in principle, be placed on two different daemons (a sandboxed workspace's conversation routes to the sandbox daemon; a regular workspace's conversation with the same agent routes to local). So the natural home is the (conv, agent) edge — `conversation_agents` is exactly that edge.

A normalized `placements(conv, agent, daemon_id, started_at, ended_at, …)` table is tempting and is the right answer once we want placement history / re-placement audit. v1 doesn't need history: re-placement (§7 OPEN) is "stop on old, start on new" and the previous row is overwritten. One column suffices.

### 6.3 `runtime_host_id` is an opaque placement key — NOT a FK

This is the explicit v1 commitment, in priority order:

1. **Not a FK.** No `FOREIGN KEY (runtime_host_id) REFERENCES …` constraint. The column is free-text TEXT.
2. **Registry is the only writer.** The placement helper (whoever calls `runtime_start` for the first time on a (conv, agent)) writes the value, copying it from a `DaemonEntry` the registry handed back. Nothing else writes the column.
3. **Daemons not currently connected to the registry are NOT enumerable from the DB.** If the user wants "show me every daemon I've ever placed a conversation on, even the ones offline", v1 has no answer. The only authoritative list is `registry.list()`, which contains live entries only. Reading `SELECT DISTINCT runtime_host_id FROM conversation_agents` gives historical placement targets, but those strings are NOT a daemon directory — they are claims about daemons that may or may not still exist.
4. **No referential integrity to recover later.** When/if v2 adds a `daemons` table, the migration must backfill rows for every distinct `runtime_host_id` value in `conversation_agents`, including ones whose daemons are gone (otherwise the new FK constraint fails). The backfill rows will have placeholder metadata (since the daemon never described itself to backend after the placement was made). This is acceptable in v2 but not free — the cost is real and the doc warns implementers explicitly.

In short: `runtime_host_id` in v1 is an **opaque placement key with no integrity guarantees beyond "the registry is the only writer at write time"**. It is not a foreign key, not a "FK-by-convention", and not a candidate for `JOIN`.

If v1 instead required `daemon_id` to be first-class FK (per Alice's pre-review dimension 4), the alternative is to add a minimal `daemons (id PK, host_id FK, name UNIQUE, first_seen, last_seen)` table now and FK `runtime_host_id` to it, with the registry's `register()` doing `INSERT … ON CONFLICT` on every observation. This adds ~30 lines and earns referential integrity. It does NOT solve "enumerable when offline" by itself (need `last_seen` heuristic + UX rules), but it does solve "drop a daemon's identity by accident". v1 explicitly chooses the simpler path; if implementation review shows it's worth the cost, the table can be added with a one-pass backfill from `SELECT DISTINCT runtime_host_id FROM conversation_agents`.

### 6.4 Migration mechanics

Per `architecture-principles.md` §5:
- v16 runner template (outer txn, inner pragma toggles, `foreign_key_check` before commit).
- Sandbox dry-run with `SILVERHAND_DIR=/tmp/silverhand-multi-daemon-dryrun-$(date +%s)` before any real-data run.
- Default value writes are constant-time in SQLite (no row rewrite for `DEFAULT` add); should be safe on prod-sized installs without downtime planning.

### 6.5 Reads and writes

- Placement is set **once** at first spawn for a (conv, agent) — whoever calls `runtime_start` writes `runtime_host_id` before issuing the call. After that the column is **immutable** under the sticky-placement choice (§7 OPEN); writable only by an explicit re-placement admin action.
- Every backend → daemon dispatch (`runtime_wake`, `runtime_stop`, `runtime_clear_session`, …) reads the column to pick the daemon. The registry's `lookup(daemon_id)` is the routing step.

---

## 7. OPEN QUESTION (shiki) — placement policy

Two viable answers. Both are migration-compatible with §6 (column stays; semantics differ).

### Option A — Sticky placement (Alice's lean)

(conv, agent) is bound to a `daemon_id` at first start and stays there for the lifetime of the row. New conversations / agent re-adds get a fresh placement decision.

- **PRO**: simple. RunStateCache key matches DB column exactly. UI can show "agent X runs on daemon Y" persistently. Stateful drivers (codex `threadId`, claude resume jsonl) just work — agent state is filesystem-anchored to the daemon's view of `~/.silverhand/agents/<id>/`, and a different daemon may not see the same files.
- **CON**: if the chosen daemon is permanently gone, the (conv, agent) is stuck. Need an explicit "re-place" admin surface (Settings → Conversation → Move runtime to daemon X) and probably a "stop then re-place" affordance.
- **UX shape**: defaults are deterministic (always picks the same daemon for a given combination of `runtime` + `host_id`). Daemon outages are visible (SSE `daemon_unavailable`) but require user action to recover. Matches today's stateful-driver invariants exactly.

### Option B — Per-call dispatch

Backend re-evaluates placement on every `runtime_start` / `runtime_wake`, picking from `candidatesFor` by a policy (round-robin, load, capability-fit).

- **PRO**: failover is free. Daemon outages don't strand conversations as long as some other daemon can serve.
- **CON**: agent state is daemon-local. The codex driver's `threadId` lives in the in-process driver instance on the daemon that spawned the child; the claude resume jsonl is filesystem-anchored to that daemon's view of `~/.claude/projects/`. Per-call dispatch would silently break stateful drivers — mid-conversation `runtime_wake` to a different daemon spawns a fresh child with no resumed session.
- Making this work requires a true cross-daemon state-migration story, which is **explicitly out of scope** (§0). So Option B in v1 collapses to "per-call dispatch but pinned after first spawn" — which is functionally just Option A with sloppier bookkeeping.

### Why this is flagged for shiki, not decided

The decision shapes:
1. **Mutability semantics of `conversation_agents.runtime_host_id`** — immutable under Option A, write-on-every-dispatch under Option B.
2. **Whether v1 ships a Settings → "Move runtime to daemon X" UI surface** — required under Option A (otherwise stuck conversations have no escape hatch), unnecessary under Option B (failover is automatic).
3. **The default user mental model** — under A, the user thinks "this conversation runs on this daemon, here's a list of daemons to choose from". Under B, the user thinks "any daemon serves this; the system picks". The first is closer to today's Electron-as-a-thing-the-user-installed model; the second is closer to a server farm.

Alice's recommendation is A (sticky) plus a manual re-place affordance. But this is shiki's call — both A and B can be built on top of the registry / migration / handshake shape this doc commits to.

---

## 8. OPEN QUESTION (shiki) — sandbox daemon FS / permission UX

A "sandbox daemon" is the same `silverhand-daemon` binary, but launched with restricted filesystem and process privileges (candidates: macOS `sandbox-exec`, Apple App Sandbox entitlements, lightweight container like `bwrap` on Linux for future, or just a chroot for prototyping). Capability strings would distinguish it: `fs.sandbox.<name>` instead of (or in addition to) `fs.local`.

Four product-shape decisions are needed before sandbox daemons can ship. The registry / handshake protocol of this doc is forward-compatible with any answer (capabilities are an open enum, placement decisions consume capabilities at start time).

### 8.1 Where do workspace paths live when a workspace is placed on a sandbox daemon?

`workspaces.workspace_path` is a host-side absolute path today. A sandbox daemon may not be able to read that path. Candidates:

- **(i)** Workspaces created for sandbox use must live *inside* the sandbox's accessible mount from creation. Picking a daemon at workspace-create time is the simplest answer but limits later flexibility.
- **(ii)** Backend tracks both `workspace_path` (host-side, for human reference and renderer file pickers) and a per-(workspace, daemon) `sandbox_path` (the path as the sandbox daemon sees it, via bind mount).
- **(iii)** Sandboxes are their own `host_id`. Membership precondition (`agent.host_id == workspace.host_id`) already keeps cross-host placements from happening. This is the cleanest model but requires the user to think of "sandbox" as a separate machine, which may not match intuition.

### 8.2 L1 / L2 file visibility

`system_prompt.md` (L1) and `MEMORY.md` / `notes/` (L2) and `CONSENSUS.md` are filesystem-anchored under `~/.silverhand/agents/<id>/` and `<workspace>/.silverhand/`. A sandbox daemon must see these to inject them into the spawn-time prompt context (see `architecture-principles.md` §3 and `docs/agent-system-prompt-memory.md`).

Either:
- L1/L2 lives inside the sandbox mount from the start; the renderer reads from there too (consistent view).
- L1/L2 is materialized into the sandbox at start (sync vs bind-mount); reconciliation on edits gets complex fast.
- Sandbox-placed agents have their own L1/L2 store under the sandbox mount; the user explicitly sees that as "this agent's sandbox memory is separate from its local memory". Honest at the cost of more state.

### 8.3 Capability surface to the renderer

Settings UI needs to show "this workspace is sandboxed; agents placed here can only access `<mount>`". Concrete questions:
- What's the human label for `fs.sandbox.<name>` (e.g. `Sandboxed (~/sandbox/projects)`)?
- How does the user inspect a daemon's accessible mounts? New `runtime_status` field? Separate intent?
- What's the picker UX in the new-workspace flow when more than one daemon could host it?

### 8.4 Default placement when both local and sandbox daemons exist

For a new agent created in a regular (non-sandbox) workspace where both daemons are registered:
- Local is the safe default; sandbox is opt-in per agent / per workspace.
- Should the sandbox option be hidden until enabled in Settings, or visible-but-default-off in the picker?

### Why this is flagged for shiki

All four are product/UX decisions, not architecture decisions. The doc commits to the routing primitives (capabilities, placement) that any answer can build on; the answers themselves shape the renderer and onboarding flows.

---

## 9. Backward compat — single-daemon today

Concrete migration path with zero behavior change for current installs. Order matters and **identity files are daemon-owned at every step — backend never writes them**.

1. **Daemon side, shipped first**: the daemon binary adds identity reporting. Launcher passes `--daemon-home <abs_path>` (default `~/.silverhand/daemons/local/` for back-compat — see §2.5). On first boot the daemon writes `<daemon_home>/identity.json` with `daemon_id = <install_name>` (the trailing dir of `<daemon_home>`, so `'local'` for the back-compat path), `host_descriptor = { name: 'local', kind: 'local' }`. On subsequent boots it reads the file. The daemon emits `daemon_id`, `instance_id`, and `host_descriptor` in `hello` and on the `ready` stdout event. This is a daemon-package change; ship it before any backend change that depends on the fields.
2. **Protocol side**: the handshake thread (#conv:l6qhZlJZTIlU_B4-) includes the three identity fields as required v1 `HelloResult` fields per §3.2. This is a cross-thread spec dependency, not a backend change.
3. **Backend boot**: change `CreateBackendOptions.hostClient: HostClient` → `hostClients: HostClient[]`. Electron main / `dev:headless` pass `[localClient]`. The old `BackendContext.hostClient` accessor becomes a thin shim returning `registry.list()[0].client` for any code path not yet migrated — kept only for the cleanup-soak window, removed once all callers go through the registry.
4. **Migration**: `ALTER TABLE conversation_agents ADD COLUMN runtime_host_id TEXT NOT NULL DEFAULT 'local'`. The `'local'` default value matches the daemon-shipped `daemon_id='local'` for single-daemon installs, so existing rows reference a live registry entry from boot — no backfill needed. The column is opaque TEXT, not a FK (§6.3).
5. **Cache key**: `${conv}|${agent}` → `local|${conv}|${agent}`. Identical behavior when there is exactly one daemon.
6. **Rollback recipe**: env `SILVERHAND_MULTI_DAEMON=0` makes the registry refuse to register more than one daemon (any second daemon's `hello` is rejected with a typed error), and backend reverts to the single-shim behavior of step 3. The shim still requires the daemon to report identity — there is no "synthesize identity for old daemons" code path. A daemon binary too old to report identity is a `daemon_too_old` failure even with the kill-switch on. Same env-var-rollback shape used for the recent legacy/daemon switch.

The default state at landing is `SILVERHAND_MULTI_DAEMON=1` (multi-daemon enabled but with a one-element registry); the env var exists only as a kill-switch for the cleanup-soak window. It is removed after the soak window the same way `SILVERHAND_RUNTIME_HOST` was removed in Commit C of PR-2 step 2.

**Anti-pattern explicitly rejected**: backend writing `~/.silverhand/daemons/<id>/identity.json` for a connected daemon. This crosses the control-plane / execution-plane boundary (architecture-principles §9). Identity is the daemon's contract about itself; backend reads and validates, never authors.

---

## 10. Follow-ups (not v1, named so we don't forget)

- **Persistent `daemons` table** — for "show daemons even when none is connected" UX (Settings pane). Migration story already drafted in §6.3.
- **Daemon registration token / bearer auth** — required before any non-localhost daemon transport. Today's `chmod 0o600` socket permission is sufficient for unix-socket local-only.
- **Cross-daemon mid-run migration of a live (conv, agent)** — explicitly NOT v1. Needs a driver-state transfer protocol (codex `threadId` re-issue, claude resume jsonl shipping); design only once we have a real use case.
- **Re-place UX surface** — required under §7 Option A, unnecessary under Option B. Depends on the §7 decision.
- **Daemon health surface in the renderer** — sidebar indicator, Settings → Daemons pane. Depends on §8 capability-label decisions.

---

## 11. Cross-references

- Handshake wire shape (`hello`, `protocol_version`, daemon identity fields, `capabilities`, `KNOWN_CAPABILITIES_V1`): protocol-handshake thread — see Alice's spec at #conv:l6qhZlJZTIlU_B4-.
- `instance_id` format (`${boot_started_at_ms}-${pid}`) and pidfile namespacing: orphan-reconcile thread #conv:eYjn-XueWMhwP1bo.
- AgentHost runtime boundary, `host_id` first-class invariant: `docs/architecture-principles.md` §9 (esp. §9.3).
- Daemon scope, PR-1 intent surface, packaging story: `docs/silverhand-daemon.md`.
- Inbox / Option-A-v2 "DB is the only durable queue" invariant: `packages/host/src/protocol.ts` RuntimeWakeReason docs (lines around 413–438).
- Migration runner template + `foreign_key_check` requirement: `docs/architecture-principles.md` §5.
- Workspace / agent identity files (L1 vs L2): `docs/agent-system-prompt-memory.md`.
