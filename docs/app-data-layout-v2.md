# Desktop app data layout v2

Status: proposed design for #task:1597.

This document defines the physical layout below the desktop app root, the
single path-resolution boundary, and the one-time migration from the legacy
flat layout. It does not add an embedded/remote mode gate. Files for an inactive
mode may coexist; the existing boot decision remains the only runtime authority.

## 1. Scope and invariants

The application root is `SILVERHAND_DIR` when set, otherwise
`~/.silverhand`. In v2 this override applies consistently to every default
desktop, local-computer, and embedded-server app-data facet; process entry
resolves it once and passes the resulting paths inward. A standalone server or
`silverhand-daemon connect` caller may instead supply an explicit custom data
root, which remains outside this application root.

The resolver compatibility release must preserve each legacy entry point's
existing environment behavior even where it is inconsistent: changing which
root an existing process reads would already be a data migration. The v2
migration-enabled release is the point at which all default app-data entry
points adopt the unified `SILVERHAND_DIR` contract above.

The migration and every runtime consumer must preserve these invariants:

1. Business code never derives a physical path from the app root. It receives a
   resolved, typed path object.
2. The path resolver is pure: no filesystem probes, migration, fallback, or
   mode decision.
3. The migration consumes the resolver's legacy and v2 results. It does not
   duplicate path literals or become a second resolver.
4. Embedded and remote desktop startup call the same preparation function
   before reading host config, spawning the daemon, or opening an embedded DB.
5. Presence is not authority. Legacy or inactive-mode files may remain without
   changing the boot decision.
6. There is no dual write and no silent directory merge.
7. `logs/` remains one support-bundle root, and `attachments-cache/` does not
   move. Existing `file view` paths therefore remain valid.
8. Existing regular workspace paths are external, absolute references. The
   migration never relocates `<app-root>/workspaces/*`, because these
   directories may be real Git repositories or user projects.
9. Standalone server data roots and custom `silverhand-daemon connect`
   data roots are not desktop app roots. They use the same resolver discipline
   but are not moved by desktop startup.
10. Moving a daemon-managed workspace to a new physical cwd must not invalidate
    an existing runtime session. The persisted `cli_session_id` remains the
    resume authority; clearing it is not a migration strategy.

## 2. Target layout

```text
<app-root>/
├── installation_id
├── desktop/
│   ├── electron-user-data/
│   ├── server-profile.bin
│   ├── session.bin
│   ├── computer-binding.json          # which computer this app is bound to
│   └── data-layout.json
├── run/                               # app-scoped transient runtime root
│   ├── daemon.sock
│   ├── daemon-outbound.sock
│   ├── daemon.pid
│   ├── identity.json
│   ├── runtime-pids/
│   ├── control-plane-server-url
│   └── connect-<computer_dir>/        # default connect profile transient
├── computers/
│   └── <computer_id>/                 # ONE shape for desktop AND connect
│       ├── agents/<agent_id>/
│       ├── workspace-data/
│       │   ├── workspace-registry.json
│       │   └── workspaces/<workspace_id>/
│       └── proxy-config.json
├── embedded-server/
│   ├── silverhand.db
│   ├── silverhand.db-wal
│   ├── silverhand.db-shm
│   ├── blobs/
│   ├── config/
│   │   └── server-config.json
│   └── embedded-bootstrap
├── attachments-cache/
└── logs/
```

`computers/<computer_id>` (#task:1608) is the durable per-computer slot,
keyed by the server-side computer id (`hosts.id`) for desktop and connect
alike — there is no `local` alias. The slot is materialized only after the
machine registers with a server (`claim_or_create`); a fresh install has no
computer-scoped data to place before that. Revoking an enrollment and
re-registering yields a new computer id and a NEW slot; the old directory is
preserved as an orphan — never reused, moved, or deleted automatically
(adoption/cleanup is an explicit human action). The former cross-binding
memory-preservation contract narrows to "within one enrollment".

Top-level `run/` is the app-scoped transient runtime root: it must exist
before any computer id does (the daemon starts pre-registration) and holds
ONLY rebuildable state — daemon socket/pidfile, instance identity, runtime
pidfiles, control-plane URL. L1/L2, workspace registries, and binding config
must never live there. It may be cleared only while the app/daemon is
stopped; the migration never moves its bytes.

The DEFAULT `silverhand-daemon connect` profile follows the same durability
split: the slot holds only durable state, its transient run files live at
`run/connect-<computer_dir>/`, and its logs at `logs/connect-<computer_dir>/`
under the single support-bundle root. Default versus explicit is an ORIGIN
FACT, never inferred from the path shape: omitting `--data-root` selects the
default profile (keyed by the resolved host id), and the detached child
inherits the parent's origin through an internal flag. `computers/` is a
RESERVED namespace — an explicit `--data-root` inside it is rejected loudly
(its directory names are host-id products, so a custom root there could
collide with a managed profile); this enforced reservation is what lets
stop/discovery treat a root under `computers/` as a default profile. A
transition guard refuses to start while a pre-relocation daemon still holds
the legacy in-slot pid file. An EXPLICIT `--data-root` elsewhere keeps the
historical flat self-contained shape.

`workspace-data/` is FLAT (#task:1608 convergence, shiki/Cindy
2026-07-25): the registry file sits directly on the workspace-data root and
managed workspace dirs are the VALIDATED raw workspace id
(`^[A-Za-z0-9_-]{1,64}$`, case-fold-unique; anything else fails closed —
never hashed). The `computers/<computer_id>` slot is the enrollment
boundary, so the historical per-binding namespace directory
(`<binding-slug>/`) is gone; the binding stays in the registry file header
as the foreign guard, and one workspace-data root hosts exactly one
binding's registry. The migration lifts ONLY the current binding's
namespace; any other namespace (the pre-claim `local` placeholder) stays
under workspace-data/ in its slug shape as an inert orphan — never merged,
never read by the runtime, never deleted (cleanup is an explicit human
action). The cross-binding lazy re-bind (`legacyBindings`) is retired, and
so is the #1529 stale-DB-path alias (#task:1612 — its only caller, the
registry backfiller, is deleted; ECS `migration_complete=true` coverage was
the shared delete gate).

`desktop/computer-binding.json` is the desktop-owned "currently bound
computer" authority (daemon-config schema — the location expresses the
owner). It is the migration's provenance input: legacy computer data may be
claimed only when a binding config proves which computer owns it.

A custom `--data-root` remains authoritative and must not write back into
the desktop app root; explicit roots are never redirected through the env.

Top-level `logs/` is intentional. Ownership belongs in filenames and structured
fields; keeping one root makes support-bundle collection and retention policy
simple.

The target intentionally has no backend-managed `workspaces/` root. New
pathless regular workspaces are materialized by the owning computer daemon
under its `workspace-data/`. Existing DB rows retain their absolute paths.

## 3. One path authority

The implementation should expose one Node-only path-resolution API surface.
The exact module/package name is not part of this contract; its shape is:

```ts
type DesktopLayoutVersion = 'legacy-v1' | 'v2';

type DesktopAppPaths = {
  appRoot: string;
  installationId: string;
  desktop: {
    root: string;
    electronUserData: string;
    serverProfile: string;
    session: string;
    layoutMarker: string;
    computerBinding: string;
  };
  // App-scoped transient runtime root — identical in both versions.
  run: {
    root: string;
    socket: string;
    outboundSocket: string;
    pidFile: string;
    identity: string;
    runtimePids: string;
    controlPlaneServerUrl: string;
  };
  computersRoot: string;
  // Legacy flat coordinates — migration sources only.
  legacyLocalComputer: {
    agents: string;
    workspaceData: string;
    daemonConfig: string;
    proxyConfig: string;
  };
  embeddedServer: {
    root: string;
    database: string;
    databaseWal: string;
    databaseShm: string;
    blobs: string;
    serverConfig: string;
    bootstrap: string;
  };
  logs: string;
  attachmentsCache: string;
};

resolveDesktopAppPaths(appRoot: string, version: DesktopLayoutVersion):
  DesktopAppPaths;
```

Composition is allowed internally (for example a reusable
`resolveComputerDataPaths(root)`), but all callers import one authoritative
Node path API. In particular:

- `SILVERHAND_DIR` and `homedir()` are resolved only at process entry.
- `loadOrCreateServerConfig`, daemon host-config helpers, CLI attachment
  caching, daemon spawn, and embedded startup accept explicit resolved paths.
- Host fallbacks such as `defaultWorkspaceDataRootDir()`,
  `defaultDaemonIdentityPath()`, and the default local-outbound socket must
  delegate to the resolver API or disappear from production wiring. They may
  not remain independent `homedir()`/`join()` authorities.
- `startBackend` no longer receives the overloaded `silverhandDir`. It receives
  explicit DB, blob, bootstrap, and any remaining server-owned paths.
- `BackendContext` does not expose a general root that downstream code can use
  to invent another path.
- Standalone server and `connect` entry points resolve their own explicit data
  root through the same API surface; they do not pretend it is a desktop app
  root.

A source-level guard should reject app-data filename/directory literals and
`join(appRoot, ...)` outside the resolver and the legacy migration inventory.
The guard should cover production sources, not documentation or test fixtures.

## 4. Current coupling assessment

The migration is feasible without a broad architectural rewrite, but it is not
only a rename.

| Surface | Current coupling | Assessment |
| --- | --- | --- |
| `desktop/` profile, session, Electron data | Already rooted below `desktop/` | Low; no migration |
| `logs/`, `attachments-cache/`, `installation_id` | Stable top-level helpers | Low; paths stay put |
| Local daemon state | Centralized mainly in `daemonPaths()` and host-config helpers | Moderate; inject the new resolver result |
| Embedded DB/config | Centralized in desktop config and server startup | Moderate |
| Backend blob/bootstrap/workspace setup | One overloaded `silverhandDir` fans out to several owners | Moderate; split the startup contract |
| Local `run/` | Stale-daemon and orphan-runtime recovery depend on the old pid roots | Lifecycle-sensitive; hand off, never rename live artifacts |
| Existing `workspaces/` | DB and registry contain absolute paths; directories can be real projects | Do not migrate |
| `daemon/` | Historical identity/registry/proxy state plus known test pollution | Do not bulk migrate or delete |
| Runtime session stores | Some third-party runtimes derive a local project namespace from cwd; a preserved `cli_session_id` can therefore become unreachable after a managed-workspace move | Migration-sensitive; hand off the whole runtime namespace before the first spawn at the new cwd |

The key cleanup is deleting the overloaded-root contract, not changing every
call site independently. Once the resolved path object is injected at the
composition roots, the remaining consumers already accept explicit paths or
can do so with narrow signature changes.

One adjacent correction is required: the backend still creates
`<silverhandDir>/workspaces` and `WorkspaceRepo` derives an agent-home guard
from that parent. Workspace creation is now daemon-authoritative, so the
backend-managed root and the derived L1 assumption should be removed or
replaced by an explicit semantic dependency. Passing `embedded-server/` as the
old overloaded root would otherwise silently change the meaning of that guard.

## 5. Startup preparation order

Both desktop modes execute the same sequence:

```text
resolve app root
  → acquire desktop single-instance ownership
  → initialize shared logger
  → quiesce legacy local-computer runtime
  → migrateDesktopAppDataLayout()
  → resolve active v2 paths
  → read server profile / choose embedded or remote
  → spawn local daemon
  → optionally start embedded backend
```

The existing boot decision still chooses embedded versus remote. Migration
does not inspect or alter that choice; it also migrates dormant embedded bytes
when a remote-mode app starts, because layout version is installation-wide.

### 5.0 Generation-scoped computer paths (#task:1608)

The daemon receives only the app-scoped coordinates (`run/`, the computers
root) at spawn. The ACCEPTED binding's `computers/<computer_id>` slot is
resolved by the shared resolver ONCE per binding generation, at the
attach/reload transition, and frozen into a typed computer path context;
detach fences the context BEFORE the binding changes. Hot paths (registry
builds, L1 materialize, seed/purge, runtime spawn resolution) only consume
the frozen context — never a mutable `currentBinding()` lookup — so an
in-flight operation can never straddle two computer directories, and after
revoke/re-registration no old operation can land in the new slot. Before the
machine registers there is no context and data-plane intents fail closed
with their existing typed `registry_unavailable`; the embedded pre-claim
placeholder id never enters the context. Explicit `--data-root` roots
(connect/custom) override the slot and are never redirected.

### 5.1 Process ownership prerequisite

Moving L1, registry, or SQLite state while an old process has it open is unsafe.
The migration-enabled release therefore needs an earlier compatibility release
that acquires the same Electron single-instance ownership before startup. That
prerequisite comes from the compatibility floor; post-cutover rollback still
requires a migration-aware build as defined in §7.

Before filesystem migration, the preparation step must use the existing
daemon ownership/reclaim primitives against the legacy `run/daemon.pid` and
socket, then reap legacy `run/runtime-pids`. It must prove that no old daemon or
runtime child still owns the legacy roots. Silverhand pid/socket/run-state
files themselves are not migrated.

### 5.2 Runtime session preparation

Third-party runtimes key their local session store by the process cwd, so the
layout cutover would strand existing sessions. The layout engine migrates them
EAGERLY, inside `migrateDesktopAppDataLayout()` and before the completion
marker is written: the marker is therefore the migration's provable removal
point — deletion never depends on whether a dormant agent is ever started
again.

The engine classifies each facet's single authoritative source for the run
(§6.4) and derives every affected cwd pair from that one classification: the
session pass and the tree move never judge authority independently. IDs and
slugs come from directory listings of the classified source; old and new cwds
are always computed from resolver coordinates, never parsed back off disk. No
server DB and no cross-computer coordination is involved — a computer migrates
only the namespaces derivable from its own registry/agents tree.

This is a migration-release inventory, not a permanent driver capability or
negotiation protocol:

- migrate Claude and Qoder's proven cwd-derived project namespaces (the store
  roots honor `CLAUDE_CONFIG_DIR` / `QODER_CONFIG_DIR` with each CLI's
  measured semantics; a non-absolute override, or a cwd outside the verified
  slug charset, makes the location unverifiable and FAILS CLOSED — a skipped
  bucket would have no provable completion point, so the user corrects the
  environment and the idempotent pass retries on the next start);
- keep Codex as an explicit no-op, because its resume identity is not tied to
  cwd;
- audit every other pre-cutover runtime and give it an explicit migrate or
  proven no-op branch before release;
- do not extend this inventory for runtimes introduced after the cutover.
  Those runtimes start under the new contract and must keep session identity
  independent of a mutable physical workspace path.

The whole session pass lives in the desktop `layout-migration/` directory —
the ONE deletable migration unit — and is removed together with the engine
when the marker floor allows (§7). No daemon, wire, or backend surface
participates.

## 6. Filesystem migration algorithm

Use the filesystem as the progress record. Do not add a per-file migration
state machine.

The resolver supplies:

- legacy sources;
- deterministic staging roots;
- final v2 roots.

There are two independently atomic durable facets:

```text
<app-root>/computers/.local-layout-v2.staging
<app-root>/.embedded-server-layout-v2.staging
```

### 6.1 Local-computer facet

Move into the computer staging root:

| Legacy source | Staging/final destination |
| --- | --- |
| `agents/` | `computers/<computer_id>/agents/` |
| `run/<binding-slug>/` (provable registry namespaces) | `computers/<computer_id>/workspace-data/<binding-slug>/` |
| `daemon-config.json` | `desktop/computer-binding.json` (separate atomic step, not a facet entry) |

The target computer id is read BEFORE any move, from the first binding
config that parses with a usable `host_id` — the v2
`desktop/computer-binding.json` first (crash resume), then the legacy
`daemon-config.json`. Legacy computer data with no provable id fails
closed. The binding file relocates as its own single atomic rename AFTER
the facet activation and BEFORE the marker (idempotent; coexistence of
both locations is a typed conflict).

The RELEASED pre-v2 registry namespaces live directly under the run root. A
directory is claimed ONLY on exact structural provenance: its
`workspace-registry.json` parses and the file's binding slug equals the
directory name. A dir WITHOUT a registry file is transient run/ state (pids,
sockets, runtime-pids) and is ignored; a PRESENT registry that is unreadable,
unparsable, or binding-mismatched FAILS CLOSED — durable registry bytes must
never be left under the old authority while completion is stamped. The same
binding proof is re-checked on the staged tree before activation, so a crash
between claim and activation cannot launder an unproven registry. The engine
is the single physical-move owner for this source; the daemon performs no
legacy physical moves at all (the historical standalone `daemon/` location
was never producible by a released artifact and has no reader; the
never-shipped #1596-era top-level `workspace-data/` intermediate likewise).

Registry namespaces cannot be treated as opaque bytes. Each
`workspace-registry.json` contains absolute managed-workspace paths.
While the tree is in staging, rewrite only entries that prove the exact
daemon-managed shape:

```text
<legacy-run-root>/<binding-slug>/workspaces/<workspace-slug>
  →
<v2-workspace-data>/<binding-slug>/workspaces/<workspace-slug>
```

The binding slug must match the registry file's namespace, and the workspace
slug must be the deterministic slug for that registry key. User-requested
external paths stay byte-for-byte unchanged. An entry inside the legacy root
that does not have this exact provenance is a typed conflict, not a candidate
for broad prefix replacement.

Released pre-v2 builds had one narrower, legitimate cross-binding shape: after
claiming a remote Computer, its registry copied an exact managed entry from the
pre-claim `local-embedded/local` predecessor registry while both entries kept
pointing at the predecessor's one physical directory. Layout v2 adopts that
directory into the current binding before flattening, but ONLY when both strict
registries prove the same workspace id and the same deterministic predecessor
coordinate. The predecessor registry remains as inert historical provenance; it
is not a second runtime authority. Missing proof, multiple predecessor claims,
symlinks/special files, or source-and-target coexistence fail closed. Runtime
session namespaces move directly from the predecessor cwd to the final flat
cwd, including crash-resume from a namespace already staged.

Registry rewrites use atomic temp-file replacement with owner-only mode.
Recovery accepts either the exact legacy managed path or the exact v2 managed
path and deterministically converges to v2. This makes a crash between moving
the tree and rewriting the last registry file retryable without creating a
second authority. The engine's rewrite is the SINGLE rewrite contract — the
daemon performs no registry rewrites of its own.

Do not move top-level `run/`, logs, or `daemon/` — `run/` keeps the SAME
top-level coordinates in v2 (app-scoped transient; the daemon recreates its
contents).

Once all present sources are in staging and validated, rename the staging
directory to `computers/<computer_id>` in one same-filesystem operation.

### 6.2 Runtime session namespace migration (eager)

For every Silverhand-owned workspace cwd the cutover changes, the engine
derives the exact old→new pair from resolver coordinates:

Daemon-managed regular workspaces:

```text
legacy run/<binding>/workspaces/<workspace>
  → v2 computers/<computer_id>/workspace-data/<binding>/workspaces/<workspace>
```

Agent-home workspaces:

```text
legacy agents/<agent_id> → v2 computers/<computer_id>/agents/<agent_id>
```

The pair LIST comes from the facet's classified authoritative source (legacy
tree plus any staged remainder mid-crash, or the v2 tree after activation);
the cwd VALUES are always resolver/slug products. The pass never scans
arbitrary project directories or infers ownership from a basename/prefix
match. User-requested external workspace paths do not move and have no pair.

The pass moves the whole per-runtime, per-cwd namespace, not individual
session files, preserving all sessions sharing the workspace without parsing
third-party transcript formats. It runs for every pair regardless of any
`cli_session_id` — dormant agents migrate in the same single pass.

After the legacy runtime process is quiescent, classify each
(runtime × pair):

1. Old namespace is a directory and the new one is absent: atomically rename.
2. Old absent: nothing stored for this pair; no-op.
3. Old and new coexist: typed conflict. The marker is not written and startup
   fails closed with every byte in place. Never merge or choose by mtime.
4. Either side is a symlink/special file, or a probe fails: typed conflict,
   no traversal.
5. Rename fails (permissions, `EXDEV`): fail closed; never copy recursively.
6. A cwd outside the verified slug charset, or a non-absolute config-dir
   override: fail closed — the namespace location is unverifiable and nothing
   is moved or guessed, and completion is never stamped over an unlocatable
   bucket. The user corrects the environment and the next start retries.

The filesystem is the progress record: the pass is idempotent (a renamed pair
classifies as case 2 on re-run) and single-process by construction — it runs
under the desktop single-instance lock before any daemon or runtime exists,
so no in-flight mutex, wire error code, or Activity projection is needed.

### 6.3 Embedded-server facet

Move into the embedded staging root:

| Legacy source | Staging/final destination |
| --- | --- |
| `silverhand.db` | `embedded-server/silverhand.db` |
| `silverhand.db-wal` | `embedded-server/silverhand.db-wal` |
| `silverhand.db-shm` | `embedded-server/silverhand.db-shm` |
| `blobs/` | `embedded-server/blobs/` |
| `server-config.json` | `embedded-server/config/server-config.json` |

Treat the DB trio and blob tree as one facet and activate them with the final
staging-directory rename. The embedded bootstrap token is boot-scoped and must
not be adopted as durable identity; a later embedded boot creates a fresh token
at the v2 path. A remote boot creates none.

Do not move `workspaces/`, `daemon/`, empty `db.sqlite`, logs, or attachment
cache.

### 6.4 State classification

For each facet:

1. Final absent, staging absent, legacy sources present: create staging, move
   entries one by one, validate, atomically rename staging to final.
2. Final absent, staging present: resume the deterministic staging operation,
   including any legacy sources not moved before the crash.
3. Final present, staging absent, no legacy sources: facet is complete.
4. Final and legacy both present before a completed v2 marker: return a typed
   conflict. Never merge directories and never choose by mtime.
5. A completed v2 marker makes v2 authoritative. Later legacy leftovers are
   inert and are reported, not re-adopted or deleted.
6. No embedded legacy source means no `embedded-server/` directory is created.

Only regular files and real directories are accepted as migration sources.
Reject symlinks and special files without following them: relocating a relative
symlink can silently retarget it, and traversing one can escape the app root.

All renames are within one app root. `EXDEV` is therefore a typed failure, not
an excuse to fall back to recursive copy. File permissions are preserved;
new staging/config directories and metadata use owner-only permissions.
Durability rides the atomic renames themselves: there is no directory-fsync
protocol (proportionality ruling — a crash around a rename re-runs the
idempotent classification on the next start).

After the session pass, both facets, the binding relocation, and the
workspace-data flatten finish, atomically write `desktop/data-layout.json`
with `{"version":2,...,"sessions":{...},"computer_slot":{...},
"workspace_layout":{...}}`. The `version` field stays 2 (the physical
layout); `sessions`, `computer_slot`, and `workspace_layout` are completion
facts. Unverifiable inputs fail the pass closed before any marker write.
A marker WITHOUT the `computer_slot` fact can only come from the
pre-revision dogfood build (durable data at the retired `computers/local`
alias): the engine then runs a one-time catch-up — session buckets re-rename
to the slot cwds, registries rewrite on exact provenance, the alias children
move to `computers/<computer_id>`, the binding relocates — and rewrites the
marker. A marker WITHOUT the `workspace_layout` fact triggers the
workspace-data flatten catch-up (#task:1608 convergence): the current
binding's registry lifts to `workspace-data/workspace-registry.json`, its
managed dirs rename to raw workspace ids, the affected session buckets
re-rename, and the fact is stamped only after all three succeed; orphan
namespaces never participate in completion. The flatten writes the FLAT
registry first (one resume authority), so a crash at any point re-converges.
Every `computers/local` reader lives only inside the deletable migration
unit. The flatten core, the session-namespace handoff, and the composed
in-place pass (`runWorkspaceDataConvergencePass`) live in the HOST
package's migration inventory: desktop's marker catch-up and the connect
daemon's startup entry are two composition entries over that ONE unit. The
connect entry runs after the computer binding is resolved and before any
registry/data-plane surface exists; it touches only the current computer's
workspace-data (or the explicit self-contained root) and fails closed —
the daemon does not start on a migration conflict. The unit deletes with
the required-upgrade floor once no pre-flatten population exists.

## 7. Compatibility, rollback, and cleanup

Use a two-release delivery path:

1. **Compatibility floor:** land the resolver, explicit path injection,
   source guards, and legacy-v1 behavior. Continue to create legacy-v1 by
   default.
2. **Required migration release:** enable the common startup preparation,
   the eager session pass, and v2 selection as one cutover.

After cutover, rollback is supported only to another migration-aware build
that contains v2 path selection and understands the completed marker
(including its `sessions` fact). The compatibility-floor binary by itself is
not a rollback target; binaries older than the floor are also unsupported.
This required-upgrade boundary avoids capability negotiation, symlinks, dual
writes, and a permanent fallback model.

Until the migration release is installed, preserving a clean source-only
fixture for the historical `run/.../workspaces/...` cwd incident means not
using **Reset Session** on that pair: reset intentionally abandons the old
resume target and permits a new-cwd namespace. Failed resume attempts that
leave the destination absent are safe fixtures. This is dogfood guidance for
proving migration continuity, not a product prohibition.

The whole `layout-migration/` directory — quiesce, marker, engine, session
pass — is ONE deletion unit with ONE predicate: delete it when the marker
floor holds (rollout evidence shows every supported installation carries a
completed v2 marker, sessions fact included). The eager model makes the
marker sufficient: no session migration waits on a dormant agent's future
start. The two daemon-side compatibility seams (the #1529 hydrate backfill and
the stale run-era-path alias it exercised) RETIRED with #task:1612 once the
observation gate closed (ECS `migration_complete=true` coverage per
supported host). Do not automatically
delete residual `workspaces/`, `daemon/`, top-level `run/` leftovers, old
bootstrap files, or `db.sqlite`; each has a different provenance and deletion
proof.

### Observation log for the deletion gate (#task:1613)

The rollout evidence above is collected through the existing attach
handshake, with no new protocol or migration state:

- Each migration composition entry stamps its outcome on the daemon boot it
  precedes — the desktop startup engine via `--layout-migration-outcome`
  on the spawned daemon, the `connect` convergence pass in-process — and the
  daemon's `ready` handshake advertises it as a `layout_migration.v2.migrated`
  / `layout_migration.v2.already_current` token on the OPEN
  `capabilities: string[]` (both transports: outbound WS and the embedded
  local frame server). Outcome semantics are each entry's stable fact, not
  a byte accounting: desktop reports `migrated` when THIS boot ran the
  migration/catch-up and stamped the complete marker (fresh-install
  initialization included) and `already_current` when the complete marker
  predates the boot; `connect` reports `migrated` when its convergence
  pass flattened and `already_current` otherwise.
- The backend writes a structured line per attaching daemon boot:
  `action=layout_migration_status` with `hostId`, `outcome`,
  `layoutVersion: 2`, `daemonVersion`, `daemonInstance`. Dedupe is
  best-effort and in-process only (keyed by the boot's instance key, so
  socket reconnects of the same boot do not re-log; a backend restart or
  host-state eviction may repeat a line). Consumers of the gate count
  after deduping by `(hostId, daemonInstance, outcome)` — duplicate lines
  never affect the gate. Exactly ONE outcome token is trusted evidence:
  a ready advertising both tokens is malformed and is warned
  (`layout_migration_status_contradictory`), never counted as a status.
- A **failed** migration never starts the daemon, so it cannot appear in the
  backend log by construction. Failure evidence is daemon-local and
  structured on both entries: the desktop writes
  `action=layout_v2_migration_failed` with `stage` (`quiesce`/`engine`),
  the typed code, `layoutVersion`, and `appVersion` before blocking
  startup (`layout-migration/prepare.ts`); `connect` writes the same
  action with `stage=workspace_data_convergence`, the typed
  `FlattenLayoutError`/`SessionMigrationError` code, `daemonVersion`, and
  `hostId` into its daemon log dir, plus the operator-facing stderr line,
  then exits 1.
- **Gate predicate:** the migration unit is deletable when, over an agreed
  observation window (default: since the first build shipping the token, and
  at least one attach per supported computer), every supported `hostId` has
  logged `layout_migration_status` with outcome `migrated` or
  `already_current` on a supported `daemonVersion`. Token ABSENCE (an older
  daemon build) counts as unobserved and keeps the gate closed — it is never
  read as migrated.
- The log is observation evidence only. The completed-marker file remains the
  persistent migration authority; the log is never re-read to decide whether
  to migrate.

## 8. Acceptance matrix

### Resolver

- Default root and a custom `SILVERHAND_DIR` produce deterministic legacy and
  v2 paths.
- The compatibility release preserves the historical environment-resolution
  matrix per entry point; enabling v2 makes every default desktop,
  local-computer, and embedded-server facet honor `SILVERHAND_DIR`.
- An explicitly supplied standalone-server or connect data root remains
  authoritative and is never redirected through `SILVERHAND_DIR`.
- No desktop, backend, host, server, or CLI production consumer constructs an
  app-data path outside the resolver API.
- Embedded startup receives explicit DB/blob/bootstrap/config paths.
- Desktop daemon startup receives explicit L1/workspace-data/config/run paths.
- Standalone server and custom connect roots never write into the default app
  root.

### Migration correctness

- Empty remote installation remains free of newly created embedded-server
  data.
- A legacy embedded installation starts in embedded mode with the same DB rows
  and every referenced blob readable.
- The same legacy installation starts in remote mode, completes the identical
  layout migration, and does not start a local backend.
- L1 files and every workspace registry/L2 file survive byte-for-byte.
- Every daemon-managed registry entry is rewritten from the exact legacy
  binding/workspace coordinate to the resolver's v2 coordinate; external
  requested paths are unchanged.
- A same-workspace exact managed entry copied from a proven predecessor
  binding is adopted by the current binding with its bytes and cwd-scoped
  runtime sessions intact; an unproven cross-binding path remains blocked.
- A forged, wrong-binding, wrong-workspace-slug, or merely prefix-matching
  registry path blocks migration instead of being rewritten.
- Crash before, during, and after registry-file replacement resumes
  idempotently; no daemon starts while an entry points at an inactive staging
  or legacy location.
- Existing `attachments-cache` paths remain valid; `logs/` remains a single
  packable root.
- Existing `<app-root>/workspaces/*` absolute paths and Git repositories are
  unchanged.
- Re-running migration is a no-op.
- Injected crash after every move resumes to the same final tree.
- Pre-marker final/legacy coexistence returns a typed conflict with all bytes
  preserved; it never merges.
- Post-marker legacy leftovers are ignored without changing the selected
  layout.
- Symlink, FIFO, permission failure, and `EXDEV` cases fail without traversal,
  copy fallback, or partial app startup.

### Runtime session continuity

- Reproduce the real `run/.../workspaces/...` cwd transition with an existing
  Claude and Qoder `cli_session_id`; after the eager migration both resume the
  same session at the v2 cwd and append to the migrated transcript namespace.
- Existing Claude and Qoder sessions in an agent-home workspace survive the
  `agents/<agent_id>` to `computers/<computer_id>/agents/<agent_id>` cwd
  move; the pre-revision dogfood alias catch-up re-renames them once more.
- Codex resumes the same `cli_session_id` after the cwd transition without
  moving or creating a cwd-derived session namespace.
- Every other runtime supported before cutover has an explicit, evidence-backed
  migrate or no-op classification. No driver capability or server negotiation
  is introduced.
- Dormant pairs (agents never started after the cutover) are migrated in the
  same single pass; nothing waits for a future spawn.
- A pre-completion dogfood marker (v2 without the sessions fact) triggers the
  session-only catch-up pass; the marker is rewritten with the fact and a
  re-run is a no-op.
- Old/new namespace coexistence, symlinks, unreadable probes, and rename
  failures block the marker with every byte preserved.
- An unverifiable store-root override or cwd charset skips with a structured
  warn and moves nothing; **Reset Session** remains the per-agent escape.
- Crash immediately before and after an atomic namespace rename converges on
  re-run without clearing any `cli_session_id`.
- User-requested external workspace paths and runtime namespaces are unchanged.

### Process and rollout safety

- A live legacy daemon is stopped/reclaimed before any durable move.
- A dead daemon with live orphan runtime children is reaped from the legacy
  runtime-pid root before cutover.
- Concurrent desktop startup cannot enter migration twice.
- Crash during staging and crash after final facet rename are both recoverable.
- A migration-aware rollback build can boot a partially migrated v2
  installation and resume the idempotent engine (including the session pass);
  the compatibility-floor binary alone and every older binary are explicitly
  outside the post-cutover rollback contract.
- Full test suites leave the real `~/.silverhand` byte-for-byte unchanged,
  including `daemon/`, `workspace-data/`, and both staging roots.

## 9. Non-goals

- Cleaning the historical `daemon/` test pollution.
- Relocating or deleting user/project workspaces.
- Moving `attachments-cache/` or splitting logs by owner.
- Inventing a new local profile ID.
- Synchronizing computer files across machines.
- Adding embedded/remote presence or mutual-exclusion gates.
- Changing standalone server storage solely to resemble the desktop bundle.
- Keeping a permanent runtime migration capability, negotiation protocol, or
  compatibility branch after the one-time v2 cutover.
