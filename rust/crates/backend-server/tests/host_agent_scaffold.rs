//! Scaffold gates for the #2195 host-agent lane and the #2201 host-control seam.
//!
//! They lock invariants, not the current shape: a new pure library in
//! `backend-core` or a new leaf in a lane namespace must stay green, while the
//! forbidden dependency/capability/activation edges must turn red.

use std::{
    collections::{BTreeMap, BTreeSet, VecDeque},
    env, fs,
    path::{Path, PathBuf},
    process::Command,
};

use serde_json::Value;

/// Driver and runtime families. `backend-core`'s linked library stays free of
/// side-effecting infrastructure through its whole transitive normal closure.
/// Pure data-format libraries are deliberately outside this list: the accepted
/// internal-profile MCP capability owns canonical JSON config admission in core.
const DRIVER_WIRE_RUNTIME: &[&str] = &[
    "axum",
    "http",
    "http-body",
    "hyper",
    "libsqlite3-sys",
    "sqlx",
    "sqlx-core",
    "sqlx-sqlite",
    "tokio",
    "tokio-tungstenite",
    "tower",
    "tower-http",
    "tracing",
    "tracing-subscriber",
    "ts-rs",
    "tungstenite",
];

/// Async runtimes, servers and DB drivers. A build script is allowed to read a
/// pinned authority and generate tables, so a wire format alone says nothing
/// about it; reaching one of these families says it does something other than
/// generation. Build closures are held to this list instead of the linked one.
const RUNTIME_AND_DRIVER: &[&str] = &[
    "axum",
    "hyper",
    "libsqlite3-sys",
    "sqlx",
    "sqlx-core",
    "sqlx-sqlite",
    "tokio",
    "tokio-tungstenite",
    "tower",
    "tower-http",
    "tungstenite",
];

/// Every crate root in the workspace. The seam budget is counted in these files,
/// so all of them are checked and not only the ones that own a lane namespace.
const CRATE_ROOTS: &[&str] = &[
    "backend-app",
    "backend-core",
    "backend-filesystem",
    "backend-server",
    "backend-sqlite",
];

/// Every module this lane DECLARES at a crate root — the seam ledger. Shaping
/// owes one labeled integration-seam line per entry. G4 holds each entry to one
/// declaration in its own root and forbids any UNREGISTERED second owner.
///
/// A name the lane deliberately distributes across roles lists each owning root as
/// its own entry: a core port and its SQLite adapter (`user_presence_cold_read`), or
/// a SQLite persistence lane and the server route surface that mounts it
/// (`host_agent`). This mirrors the base crates, where `workspace_cold_read`,
/// `direct_pair_read`, `access` and `auth` each name their own module in several
/// roots; only an owner in a root NOT listed here is the accidental fork G4 refuses.
///
/// Flat modules belong here too. One table serving every gate is what let a flat
/// module sit in no inventory at all, guarded by nothing and with no signal, so
/// membership here answers only "did this lane declare it at a root".
///
/// An entry is the CURRENT OWNING ROOT NAMESPACE, not a fixed flat module name
/// (#task:2272). When a lane module relocates under an organization namespace
/// (e.g. `crate::identity_access::participant_handle_availability`), its owning root
/// becomes the container `identity_access`, listed here ONCE — its old flat entry is
/// removed. This ledger never descends into a container to re-inventory the leaves; the
/// organization map/gate (docs/rust-backend-organization-map.json) is the sole authority
/// for a leaf's owner, physical target and residual/landed status inside the namespace.
const SEAM_ROOT_MODULES: &[(&str, &str)] = &[
    // #task:2280 — the first host_runtime relocation wave moved five low-fanout backend-core
    // leaves under the dual-role `host_runtime` context/namespace: `agent_availability_read`
    // and `agent_presence_read` (read models), `agent_materialize` (transport-neutral target
    // contract), `host_resources_read` (read model), and `scope_runtime_stop` (target
    // contract). Their old flat crate-root seam entries are removed; the single owning-root
    // `host_runtime` entry (in the inherited list below) covers them via the CP projection,
    // and the organization map/gate owns each leaf's owner/target inside the namespace.
    // #task:2225 — the single-UoW create/provision-and-activate authority: the core
    // materialization writer plus the exhaustive `provision_and_activate` use case that
    // seals both the agent and conversation arms. Core capability, mounted at the app
    // composition root by the #task:2234 integration (CP6 create route).
    ("backend-core", "agent_materialization"),
    // #task:2225 — the create-agent unit of work (`POST /api/agents`): the saga that
    // owns each decision over the `agent_materialization` primitives, the host
    // materialize command, the placement rule and the shared handle namespace. Core
    // orchestration only — the wire projection, post-commit effects and status mapping
    // belong to the route face. Mounted at the app composition root by the #task:2234
    // integration (CP6 create route).
    ("backend-core", "agent_creation"),
    // #task:2225 — the public agent-lifecycle and avatar route family (Rust Wave 3).
    // All of this family's backend-core core leaves have relocated under the C1
    // `identity_access` namespace: the handle-availability probe (#task:2272), the
    // avatar upload/clear lifecycle `agent_avatar_write` (#task:2274), and this wave's
    // `agent_avatar` (byte fetch), `agent_profile_write` (tuning/profile write) plus the
    // read-model faces (#task:2275). Their owner/target lives in the organization
    // map/gate, not as flat seam entries here; the SQLite adapters and server route
    // surfaces remain the sibling entries below, all mounted at the app composition root
    // by the #task:2234 integration (CP2).
    // #task:2272 — the handle-availability probe's core module was relocated under the
    // C1 `identity_access` namespace (`crate::identity_access::participant_handle_availability`).
    // This ledger guards the current OWNING ROOT NAMESPACE only: the container is declared
    // once at the crate root and owns no accidental second declaration. The organization
    // map/gate (docs/rust-backend-organization-map.json) is the authority for each leaf's
    // owner, physical target and residual/landed status inside the namespace — this seam
    // entry does NOT descend into the container to re-inventory its leaves. As further C1
    // leaves relocate, their old crate-root entries are removed and `identity_access` stays
    // a single entry here.
    ("backend-core", "identity_access"),
    // #task:2226 — internal profile/MCP consumer vocabulary and pure
    // orchestration. The production data-plane adapter is #task:2231 below; mounted at
    // the app composition root by the #task:2234 integration (CP7a peer-profile, CP7b MCP).
    // This family's core leaves relocated under the `identity_access` namespace across
    // #task:2274 (`agent_peer_profile`, `internal_profile_write`, `mcp_config`),
    // #task:2275 (`agent_profile_read`), and #task:2278 (`agent_profile_mcp`); their
    // owner/target lives in the organization map, not as flat seam entries here.
    ("backend-core", "cold_read"),
    ("backend-core", "policy"),
    // #task:2283 — the agent runtime-switch saga relocated under the dual-role `host_runtime`
    // namespace, closing it at 11/11/0. Its flat crate-root seam entry is removed; the single
    // `host_runtime` owning-root entry covers all landed leaves via the CP projection, and the
    // organization map/gate owns each leaf's owner/target inside the namespace.
    ("backend-core", "teardown"),
    // #task:2279 — the C1-adjacent `viewer_read_model` relocation namespace: a directory
    // container declared once at the crate root, owning the relocated presence/sort leaves
    // (`user_presence_cold_read` read model, `user_presence_last_seen` LastSeenSink port,
    // `viewer_workspace_sort` read model). Their old flat crate-root entries are removed; the
    // organization map/gate is the authority for each leaf's owner/target inside the container
    // and this seam entry does NOT descend into it. Kept a single entry as further leaves land.
    ("backend-core", "viewer_read_model"),
    // #task:2284 — the `foundation` relocation namespace: a directory container declared once
    // at the crate root, owning the relocated shared-vocabulary leaves (blob store, CLI
    // invoke/preflight audit, name canonicalization, persistence error/port vocabulary, the
    // scope-event transport port, and the number/text primitives). Their old flat crate-root
    // entries are removed; the organization map/gate owns each leaf's owner/target inside the
    // container and this seam entry does NOT descend into it. Kept a single entry as the
    // remaining `identity` leaf lands in a later wave.
    ("backend-core", "foundation"),
    // #task:2193 — the workspace metadata/read vertical. Core primitives and ports;
    // their SQLite adapters and server routes are the sibling entries below. Mounted at
    // the app composition root by the #task:2223 integration. This vertical's core leaves
    // relocated under the `identity_access` namespace across #task:2274
    // (`workspace_detail_read`, `workspace_name_availability`) and #task:2276
    // (`workspace_metadata_write`, `workspace_name`); their owner/target lives in the
    // organization map, not as flat seam entries here. `name_canonicalization`, `wire_number`,
    // and `wire_text` relocated under the `foundation` namespace per #task:2284.
    // #task:2193 CP2 — the human credentialed-session vertical (signup/login/
    // logout + self profile). Core bounded contexts and their ports; the SQLite
    // adapters and the server route surface are the sibling entries below. Mounted at
    // the app composition root by the #task:2223 integration. This vertical's core leaves
    // relocated under the `identity_access` namespace: `human_auth_flows` and
    // `user_identity` per #task:2276, and the directory-shaped `credential` context per
    // #task:2277; their owner/target lives in the organization map, not as flat seam
    // entries here.
    // #task:2222 — the human-directory and avatar route family (Rust Wave 2). The
    // avatar sub-capability of the `users` authority (ports + orchestration; it
    // reuses the CP2 identity above). Its server route surface is the sibling `users`
    // entry below and its production blob adapter the sibling `avatar_blob` entry —
    // both wired by the #task:2223 integration over #task:2221's local blob store. Its
    // backend-core `avatar` domain leaf relocated under the C1 `identity_access` namespace
    // per #task:2275 (a path-only move: the user and agent avatar lifecycles stay two
    // distinct custodies, never merged); its owner/target lives in the organization map.
    // #task:2248 — residual-wave core capability/read ports a file-disjoint
    // implementation lane needs alongside the server route surface, pre-declared here
    // so four lanes never race the same `lib.rs`/ledger. The embedded-bootstrap UoW and
    // the workspace data-plane port family are genuinely new top-level contexts; the two
    // agent projections carry the `*_read` suffix marking a source-bound read
    // (`agent_audit_read` deliberately distinct from the `capability::agent_audit`
    // decision vocabulary). Each has a same-named SQLite adapter in the backend-sqlite
    // block below. Directory-shaped scaffolds — no port/adapter/route/mount yet, so all
    // are absent from `ACTIVATION_NAMESPACES` (UNMOUNTED). #task:2278 relocated the
    // `agent_audit_read` read-model directory under the C1 `identity_access` namespace, and
    // #task:2282 relocated the `agent_runtime_state_read` read-model directory under the
    // dual-role `host_runtime` namespace (both owners/targets live in the organization map,
    // folded into their container seam entries); `embedded_bootstrap` and
    // `workspace_data_plane` remain flat backend-core roots.
    ("backend-core", "embedded_bootstrap"),
    ("backend-core", "workspace_data_plane"),
    ("backend-filesystem", "runtime_detection"),
    // #task:2223 — the production avatar blob adapter (`SingleKindAvatarBlobs`),
    // bridging the #task:2222 `avatar` capability to #task:2221's local blob store
    // under one ambient storage kind. An adapter like `clock` / `password_hasher`
    // below, so it belongs in this seam ledger but NOT `ACTIVATION_NAMESPACES`.
    ("backend-server", "avatar_blob"),
    // #task:2236 — the shared JSON write-admission extractor (`ValidatedJson<T>`) plus
    // the garde adapters delegating to the `wire_text`/`wire_number` primitives, and the
    // crate-private PATCH presence algebra (`wire_patch`: missing/null/value tri-state,
    // non-nullable, forbidden). Wire FRAMEWORK/transport vocabulary placed by its bounded
    // context; admission seams like the adapters above, NOT activation namespaces.
    ("backend-server", "wire_admission"),
    ("backend-server", "wire_patch"),
    // #task:2242 — the crate-private multipart STREAM transport vocabulary
    // (`declared_content_type` / `accumulate_capped` / `drain`) shared by the four
    // mounted avatar/profile upload faces. Route-neutral transport plumbing only — it
    // holds no route policy, MIME allowlist, or admission seam — placed by its bounded
    // context like the wire framework above, NOT an activation namespace.
    ("backend-server", "multipart_transport"),
    // #task:2231 — the production typed adapter for the accepted internal
    // profile-MCP port, sharing the owning-host registry and exposing no raw
    // dispatcher. Wired into the internal MCP routes by the #task:2234 integration (CP7b).
    ("backend-server", "agent_profile_mcp_data_plane"),
    // #task:2225 — the crate-root route surface for the handle-availability probe
    // (route 1). The tuning-write (route 2) and avatar (route 5) surfaces are
    // `host_agent` submodules, already covered by the `host_agent` entry. Mounted at the
    // app composition root by the #task:2234 integration (CP2).
    ("backend-server", "agent_name_availability"),
    // #task:2225 — the single crate-root full-`AgentDto` authority: the
    // `agentRowToDto` projector plus the shared post-commit `reproject_committed_agent`
    // face every mutating agent face runs. Crate-root, not a `host_agent` submodule, so
    // it is not owned by one route family's namespace (#task:2226's internal faces
    // consume the same face). `pub(crate)`, no route of its own, UNMOUNTED.
    ("backend-server", "agent_wire"),
    // #task:2229 — the crate-root production `RuntimeControlPort` adapter plus the
    // typed daemon codecs for agent materialize / runtime start / clear-session.
    ("backend-server", "agent_materialize"),
    ("backend-server", "clock"),
    ("backend-server", "host_agent"),
    ("backend-server", "host_agent_background"),
    ("backend-server", "host_control"),
    // #task:2226 — internal-agent route family, mounted at the app composition root by
    // the #task:2234 integration (CP7a profile/avatar/peer-profile, CP7b MCP). Its MCP
    // leaf consumes only the typed data-plane port; #task:2231 supplies that production face.
    ("backend-server", "internal_agent"),
    ("backend-server", "host_resources"),
    ("backend-server", "human_auth"),
    // #task:2222 — the human-directory and avatar route surface (GET /api/users,
    // POST/DELETE /api/me/avatar, GET /api/users/{id}/avatar). Sibling of the core
    // `avatar` entry above; mounted by the #task:2223 integration.
    ("backend-server", "users"),
    ("backend-server", "ops"),
    ("backend-server", "password_hasher"),
    // #task:2229 — the runtime start/stop/clear production capability. It owns
    // exact-custody commands, the ephemeral clear waiter, and committed clear
    // settlement; its route verticals are mounted by #task:2234 (CP4 clear/switch, CP5 stop).
    ("backend-server", "runtime_control"),
    ("backend-server", "scope_runtime_stop"),
    ("backend-server", "workspace_detail"),
    ("backend-server", "workspace_metadata_write"),
    ("backend-server", "workspace_name_availability"),
    // #task:2220 — the workspace-rename fan-out production adapter, wiring the core
    // rename orchestrator over the messaging store, daemon delivery, and scope-event
    // hub. Assembled into the workspace-metadata-write mount by the #task:2223
    // integration (best-effort after commit), not a standalone route.
    ("backend-server", "workspace_rename_fanout"),
    // #task:2248 — the residual-wave route-family scaffold. Only two families are
    // genuinely NEW top-level bounded contexts and earn a crate root: the embedded
    // bootstrap (its own auth/token lifecycle) and the workspace data plane (a shared
    // data-plane/codec/adapter family). Both are directory namespaces declared so a
    // file-disjoint implementation lane can land its route surface; neither carries a
    // route, handler, DTO, factory, port, or mount yet, and neither is named by a
    // composition root, so both are absent from `ACTIVATION_NAMESPACES` — UNMOUNTED.
    //
    // The other residual route surfaces are NOT new crate roots: they are submodules of
    // the bounded contexts that already own them, so they add no crate-root seam and ride
    // the existing `host_agent`/`internal_agent` entries — `host_agent::public_profile_mcp`,
    // `host_agent::agent_runtime_state`, `host_agent::agent_audit`,
    // `host_agent::schedule_management` (public-agent management plane), and
    // `internal_agent::diagnostics` (internal runtime-credentialed family).
    ("backend-server", "embedded_bootstrap"),
    ("backend-server", "workspace_data_plane"),
    ("backend-sqlite", "agent_availability_read"),
    ("backend-sqlite", "agent_detail_read"),
    ("backend-sqlite", "agent_list_read"),
    ("backend-sqlite", "agent_presence_read"),
    // #task:2225 — the SQLite adapters for the Wave 3 verticals: the agent avatar
    // serve-ref read (route 5) and the agent tuning/profile row write (route 2). The
    // handle-availability probe (route 1) reuses the existing `handle_namespace`
    // adapter listed below.
    ("backend-sqlite", "agent_avatar_read"),
    ("backend-sqlite", "agent_profile_write"),
    ("backend-sqlite", "agent_profile_read"),
    ("backend-sqlite", "agent_view_acl"),
    ("backend-sqlite", "credential"),
    ("backend-sqlite", "handle_namespace"),
    ("backend-sqlite", "human_registration"),
    ("backend-sqlite", "user_identity"),
    ("backend-sqlite", "host_agent"),
    ("backend-sqlite", "host_resources_read"),
    ("backend-sqlite", "user_presence_cold_read"),
    ("backend-sqlite", "user_presence_last_seen"),
    ("backend-sqlite", "workspace_detail_read"),
    ("backend-sqlite", "workspace_metadata_write"),
    ("backend-sqlite", "workspace_name_availability"),
    // #task:2220 — the SQLite reads the rename fan-out and the workspace-metadata
    // viewer hint consume: the conversation agent audience (folded into the rename
    // messaging store) and the workspace human audience. `computer_agents_read` is
    // the host-runtime agent roster the availability announcer enumerates. Not yet
    // mounted (the app composition root is out of this task's scope).
    ("backend-sqlite", "computer_agents_read"),
    ("backend-sqlite", "workspace_audience_read"),
    // #task:2248 — the same-named SQLite adapters for the residual-wave core ports
    // above. Each is the sibling of its `backend-core` entry; directory-shaped
    // scaffolds with no adapter yet, UNMOUNTED.
    ("backend-sqlite", "agent_audit_read"),
    ("backend-sqlite", "agent_runtime_state_read"),
    ("backend-sqlite", "embedded_bootstrap"),
    ("backend-sqlite", "workspace_data_plane"),
    ("backend-sqlite", "write_probe"),
];

/// The declarations this lane did NOT add, across EVERY root in `CRATE_ROOTS`.
///
/// It exists so the seam ledger can be CLOSED over the tree rather than trusted:
/// recognising a declaration no inventory knows about requires knowing what was
/// already there. Without it, forgetting an entry above is silent — twice now the
/// same defect.
///
/// It spans the roots that own no seam as well, because a closure whose SCAN RANGE
/// is derived from the seam table can only find omissions in roots that table
/// already names. A module added to a root with no seam entry would be read by no
/// gate at all, and every table-driven gate would pass — the next lane module lands
/// in `backend-sqlite`, a root in exactly that state.
///
/// Membership answers "was it already there", which no parser can decide. The tree
/// gate holds every declaration to EXACTLY ONE classification; the classification
/// itself was reconciled once against the root declarations at base `08d5e4de` — 1
/// in backend-app, 15 in backend-core, 15 in backend-server, 11 in backend-sqlite,
/// with no seam entry among them. #task:2209 then removed the foundation proof
/// vertical (`backend-core::foundation_message`, `backend-server::{http,wire}`),
/// leaving 1 in backend-app, 14 in backend-core, 13 in backend-server, 11 in
/// backend-sqlite. #task:2223 then added `backend-app::request_perimeter` (the
/// composition-root request-body perimeter, a non-seam production module the
/// host-agent seam lane did not add), bringing backend-app to 2.
///
/// #task:2276 then relocated two inherited backend-core modules
/// (`workspace_cold_read`, `workspace_face`) under the C1 `identity_access` namespace,
/// removing their flat entries here; they are now covered by the single `identity_access`
/// container seam entry via the owning-root CP projection, and the organization map/gate is
/// the authority for their owner/target inside the container. This is a physical relocation
/// of pre-existing modules, not a lane addition. #task:2277 then likewise relocated two more
/// inherited backend-core directory modules (`access`, `auth`) under `identity_access`, on
/// the same terms — directory-preserving moves of pre-existing modules, folded into the same
/// container seam entry. #task:2279 relocated the inherited `viewer_workspace_sort` read model
/// under the new `viewer_read_model` container on identical terms (its flat entry removed here,
/// covered by that container's seam entry via the CP projection). #task:2281 relocated the
/// inherited `runtime_credential` and `runtime_event` vocabulary under the dual-role
/// `host_runtime` context/namespace on the same terms (flat entries removed here, covered by
/// the single `host_runtime` owning-root entry).
///
/// CP1-temporary, with G3's accounting: it guards "every lane module is registered
/// where it is guarded", it is deleted when the seam is extracted into the
/// integration commit that owns those lines, and its owner is the review gate. A
/// merge that brings new modules into these roots must extend one list or the
/// other, and having to choose is the point.
const ROOT_MODULES_WE_DID_NOT_ADD: &[(&str, &str)] = &[
    ("backend-app", "current_schema"),
    // #task:2223 composition-root request-body perimeter: a non-seam production module
    // the host-agent seam lane did not add. It owes no labeled seam line and is not
    // fenced against composition (it is deliberately MOUNTED as the outermost layer),
    // so it belongs in the non-seam baseline this list closes the tree over, not in
    // `SEAM_ROOT_MODULES`.
    ("backend-app", "request_perimeter"),
    // #task:2234 CP6 composition-root create-aftermath boundary: the owned tracker the
    // create route hands its two post-commit remote legs to, built in `prepare()` and
    // closed at shutdown. Like `request_perimeter` it is a non-seam production module the
    // host-agent seam lane did not add — it is deliberately MOUNTED (not fenced against
    // composition) and owes no labeled seam line, so it closes into this non-seam baseline
    // rather than `SEAM_ROOT_MODULES`.
    ("backend-app", "create_aftermath"),
    // #task:2284 — blob_store, cli_preflight_audit, cli_invoke_audit, persistence, and
    // scope_event relocated under the `foundation` namespace; their flat entries are removed
    // here and covered by the single `foundation` owning-root seam entry via the CP projection.
    // #task:2285 relocated the final `identity` kernel vocabulary under `foundation` on the
    // same terms, closing the namespace (9/9/0).
    ("backend-core", "direct_pair_read"),
    ("backend-core", "host_runtime"),
    ("backend-core", "messaging"),
    ("backend-core", "runtime_delivery"),
    // #task:2256 categorized-file audit sink: the OS adapter that owns the CLI
    // preflight-failure log file and its writer lifecycle, home of the reusable
    // `CategorizedJsonlWriter` primitive. A non-seam production module the host-agent seam
    // lane did not add, in the same non-seam baseline as its sibling `blob_store`.
    ("backend-filesystem", "audit_sink"),
    ("backend-filesystem", "blob_store"),
    ("backend-server", "access"),
    ("backend-server", "auth"),
    ("backend-server", "bearer"),
    ("backend-server", "current_schema"),
    ("backend-server", "daemon_delivery"),
    ("backend-server", "daemon_events"),
    ("backend-server", "direct_pairs"),
    ("backend-server", "error"),
    ("backend-server", "host_runtime"),
    ("backend-server", "messaging"),
    ("backend-server", "runtime_credential"),
    ("backend-server", "workspaces"),
    ("backend-sqlite", "access"),
    ("backend-sqlite", "auth"),
    ("backend-sqlite", "current_schema"),
    ("backend-sqlite", "direct_pair_read"),
    ("backend-sqlite", "host_runtime"),
    ("backend-sqlite", "messaging"),
    ("backend-sqlite", "runtime_credential"),
    ("backend-sqlite", "runtime_delivery"),
    ("backend-sqlite", "scope_event"),
    ("backend-sqlite", "unread_read"),
    ("backend-sqlite", "workspace_cold_read"),
];

/// TRANSITIONAL — the root modules the vocabulary-ownership lanes declare.
///
/// It exists for one reason: G0 below closes every root declaration over an
/// inventory, so a new root module has to be classified somewhere or the gate goes
/// red with no way to record that the module is legitimate. This is that record and
/// nothing more.
///
/// It carries NO seam and NO activation semantics. An entry here owes no labeled
/// integration-seam line, is not fenced against composition, and is not held to
/// G4's single-owner accounting; those obligations belong to `SEAM_ROOT_MODULES`
/// and are not claimed for these modules.
///
/// This whole file is CP1 history that #task:2209 deletes, so this table has no
/// future: do not extend it into a durable inventory, do not build a union
/// abstraction over the three lists, and do not carry it through convergence.
///
/// #task:2265 NOTE (organization anchor): these three CP root inventories keep their
/// ORIGINAL G4/G5 seam semantics (single-owner accounting, seam-ledger membership) — they
/// are NOT reclassified as an organization residual/landed ledger and no entry is moved
/// between them for organization purposes. The organization residual/landed truth lives
/// entirely in `docs/rust-backend-organization-map.json` + the real module tree: a root is
/// `landed` iff its current full path equals its `physical_target` (a full
/// `crate::namespace::leaf` Rust path), and `residual = scanned roots − mechanically-landed`.
/// The organization gate uses these CP tables ONLY as a root-COVERAGE compatibility check
/// (they still cover the current root tree exactly once), never as a landed/residual
/// authority. Organization accounting stays separate from route/product ledgers.
const ORGANIZATION_ROOT_MODULES: &[(&str, &str)] = &[
    ("backend-app", "application_orchestration"),
    ("backend-server", "application_orchestration"),
    ("backend-server", "conversation_messaging"),
    ("backend-server", "foundation"),
    ("backend-server", "identity_access"),
    ("backend-server", "viewer_read_model"),
];

/// The seam modules that are DIRECTORY modules, owning a `<name>/mod.rs`. G5 reads
/// that file, so a flat module must not appear here — the gate would then fail on a
/// missing path instead of on a violation. G0 holds this list to exactly the
/// directory-shaped entries above, so neither shape can drift out of its gate.
const DIRECTORY_NAMESPACES: &[(&str, &str)] = &[
    ("backend-core", "cold_read"),
    ("backend-core", "policy"),
    ("backend-core", "teardown"),
    ("backend-filesystem", "runtime_detection"),
    ("backend-server", "host_agent"),
    ("backend-server", "host_agent_background"),
    ("backend-server", "host_control"),
    ("backend-server", "internal_agent"),
    ("backend-server", "ops"),
    // #task:2248 — the two residual-wave families that earn a new crate root
    // (embedded bootstrap, workspace data plane); directory-shaped so an
    // implementation lane can add route submodules within its own subtree without
    // touching a shared declaration. The other residual surfaces are submodules of
    // `host_agent`/`internal_agent` and are not crate-root seams.
    ("backend-server", "embedded_bootstrap"),
    ("backend-server", "workspace_data_plane"),
    // #task:2248 — the residual-wave core ports and their SQLite adapters are all
    // directory-shaped scaffolds too, so they join this inventory (G0 holds it to the
    // exact directory-shaped subset of the seam ledger). #task:2278 relocated the
    // backend-core `agent_audit_read` directory under `identity_access`, and #task:2282
    // relocated the backend-core `agent_runtime_state_read` directory under `host_runtime`,
    // so their flat directory entries are removed here; the backend-sqlite adapters stay flat.
    ("backend-core", "embedded_bootstrap"),
    ("backend-core", "workspace_data_plane"),
    ("backend-sqlite", "agent_audit_read"),
    ("backend-sqlite", "agent_runtime_state_read"),
    ("backend-sqlite", "embedded_bootstrap"),
    ("backend-sqlite", "workspace_data_plane"),
    ("backend-sqlite", "host_agent"),
    // #task:2272 — the C1 `identity_access` relocation namespace is directory-shaped
    // (declared once at the crate root with a `mod.rs`), so it joins this directory-shaped
    // subset of the seam ledger. It is a namespace CONTAINER: its leaves' owners live in the
    // organization map/gate, not here.
    ("backend-core", "identity_access"),
    // #task:2279 — the `viewer_read_model` relocation namespace, likewise a directory-shaped
    // container (`viewer_read_model/mod.rs`) owning the relocated presence/sort leaves. Same
    // terms as `identity_access`: one declaration at the crate root, leaf owners live in the
    // organization map/gate.
    ("backend-core", "viewer_read_model"),
    // #task:2284 — the `foundation` relocation namespace, likewise a directory-shaped
    // container (`foundation/mod.rs`) owning the relocated shared-vocabulary leaves. Same
    // terms: one declaration at the crate root, leaf owners live in the organization map/gate.
    ("backend-core", "foundation"),
];

/// The modules a composition must name to ACTIVATE this lane: rules that decide, a
/// read that answers a route, the HTTP surface that mounts that read, the write that
/// commits, the timers that fire.
///
/// Membership is that question and not "is it ours". `agent_lifecycle` is a
/// materialization vocabulary the base crates already share; converting a stored
/// token into that enum starts no rule, opens no port and fires no timer, so it is
/// deliberately absent, while every deciding, reading, mounting, writing and timing
/// module is present. The /api/presence vertical adds two: the read port
/// `user_presence_cold_read`, and the route surface `host_agent` whose appearance in
/// the composition root is the mount this fence refuses in CP1. The
/// /api/agents/:id/availability vertical adds one: the read port
/// `agent_availability_read`; its route surface is a submodule of `host_agent`,
/// already listed. The /api/agents/:id/presence vertical adds one the
/// same way again: the read port `agent_presence_read`, whose route surface is a
/// submodule of `host_agent`. The /api/hosts/:id/resources vertical (#task:2198)
/// adds two, because its route surface is a crate-root SIBLING rather than a
/// `host_agent` leaf: the read port `host_resources_read` and the surface
/// `host_resources`. The root
/// operational read cluster (#task:2195) adds exactly one, and it is the surface
/// `ops`: none of its four faces reads a domain fact, so it declares no crate-root
/// read port at all — the runtime catalogue's detector port is a leaf of the `agents`
/// vocabulary namespace, and the readiness write probe is a store capability added to
/// the INHERITED core namespace `persistence`, which this ledger never claimed —
/// while its two adapters are excluded on the same grounds every other adapter here
/// is. G0 keeps it a subset of the seam ledger.
///
/// SCOPE (#task:2275, narrowed honestly): this table only does the
/// `ACTIVATION_NAMESPACES ⊆ SEAM_ROOT_MODULES` self-check — it never proved a route is
/// actually mounted. It therefore covers only the legacy root namespaces still
/// expressible at the owning-root layer. Once a lane module relocates under an
/// organization container (the agent-detail and agent-list read ports moved to
/// `crate::identity_access::{agent_detail_read,agent_list_read}` in #task:2275, the
/// `capability` decision namespace moved to `crate::identity_access::capability` in
/// #task:2277, the `user_presence_cold_read` read port moved to
/// `crate::viewer_read_model::user_presence_cold_read` in #task:2279, and the
/// `agent_availability_read`, `agent_presence_read`, and `host_resources_read` read ports
/// moved under the dual-role `crate::host_runtime` context/namespace in #task:2280), it
/// drops out of BOTH this table and the seam ledger: a container such as
/// `identity_access` holds both activated and unmounted leaves, so it is NOT added here as
/// a whole. A nested leaf's real existence/relocation is the organization gate's authority,
/// and its actual mount is the composition/route behavior tests' — this table is not the
/// activation authority for nested leaves, and is deliberately not upgraded into a
/// second full-path scanner for them.
const ACTIVATION_NAMESPACES: &[(&str, &str)] = &[
    ("backend-core", "cold_read"),
    ("backend-core", "policy"),
    ("backend-core", "teardown"),
    ("backend-server", "host_agent"),
    ("backend-server", "host_agent_background"),
    ("backend-server", "host_control"),
    ("backend-server", "host_resources"),
    ("backend-server", "ops"),
];

fn rust_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .canonicalize()
        .expect("rust workspace root")
}

fn read(path: &Path) -> String {
    fs::read_to_string(path).unwrap_or_else(|error| panic!("read {}: {error}", path.display()))
}

/// Cargo's own resolution of the workspace, read once per gate.
///
/// A hand-written manifest or lock parser cannot see target-specific edges,
/// `package = ` renames, feature-gated optional edges, or two versions of one
/// name, so every dependency assertion below reads the resolved graph instead of
/// re-deriving one. `--locked --offline` keeps the lock file untouched.
struct ResolvedGraph {
    /// Package id to package name; ids are the only stable identity, because two
    /// versions of one crate share a name.
    names: BTreeMap<String, String>,
    /// Package id to dependency-kind (`normal`, `build`, `dev`) to package ids,
    /// merged across every target so a `cfg(...)` edge cannot hide.
    edges: BTreeMap<String, BTreeMap<String, BTreeSet<String>>>,
    /// Workspace member name to package id.
    members: BTreeMap<String, String>,
}

fn resolved_graph() -> ResolvedGraph {
    let cargo = env::var("CARGO").unwrap_or_else(|_| "cargo".to_owned());
    let output = Command::new(cargo)
        .args(["metadata", "--locked", "--offline", "--format-version", "1"])
        .current_dir(rust_root())
        .output()
        .expect("run cargo metadata");
    assert!(
        output.status.success(),
        "cargo metadata failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let metadata: Value = serde_json::from_slice(&output.stdout).expect("cargo metadata json");

    let mut names = BTreeMap::new();
    for package in metadata["packages"].as_array().expect("packages") {
        names.insert(
            package["id"].as_str().expect("package id").to_owned(),
            package["name"].as_str().expect("package name").to_owned(),
        );
    }

    let mut members = BTreeMap::new();
    for id in metadata["workspace_members"]
        .as_array()
        .expect("workspace members")
    {
        let id = id.as_str().expect("member id").to_owned();
        members.insert(names[&id].clone(), id);
    }

    let mut edges: BTreeMap<String, BTreeMap<String, BTreeSet<String>>> = BTreeMap::new();
    for node in metadata["resolve"]["nodes"]
        .as_array()
        .expect("resolve nodes")
    {
        let id = node["id"].as_str().expect("node id").to_owned();
        let per_kind = edges.entry(id).or_default();
        for dependency in node["deps"].as_array().expect("node deps") {
            let target = dependency["pkg"].as_str().expect("dep pkg").to_owned();
            for dependency_kind in dependency["dep_kinds"].as_array().expect("dep kinds") {
                // A normal dependency carries no `kind` at all.
                let kind = dependency_kind["kind"].as_str().unwrap_or("normal");
                per_kind
                    .entry(kind.to_owned())
                    .or_default()
                    .insert(target.clone());
            }
        }
    }

    ResolvedGraph {
        names,
        edges,
        members,
    }
}

impl ResolvedGraph {
    fn member(&self, package: &str) -> &str {
        self.members
            .get(package)
            .unwrap_or_else(|| panic!("{package} is not a workspace member"))
    }

    fn kind(&self, id: &str, kind: &str) -> BTreeSet<String> {
        self.edges
            .get(id)
            .and_then(|per_kind| per_kind.get(kind))
            .cloned()
            .unwrap_or_default()
    }

    /// Everything cargo links into `package`'s own library: its normal edges,
    /// then the normal edges of everything those reach. A dev edge is never
    /// transitive, and a dependency's build script feeds a separate binary that
    /// is never linked into its consumer, so neither kind enters this closure.
    fn linked_closure(&self, package: &str) -> BTreeSet<String> {
        self.closure(self.kind(self.member(package), "normal"), &["normal"])
    }

    /// Everything cargo compiles to produce `package`'s build script: its build
    /// edges, then the normal and build edges of everything those reach. None of
    /// it is linked into the library, so this answers a different question than
    /// [`Self::linked_closure`] and is held to a different family list.
    fn build_closure(&self, package: &str) -> BTreeSet<String> {
        self.closure(
            self.kind(self.member(package), "build"),
            &["normal", "build"],
        )
    }

    fn closure(&self, roots: BTreeSet<String>, follow: &[&str]) -> BTreeSet<String> {
        let mut seen = BTreeSet::new();
        let mut queue: VecDeque<String> = roots.into_iter().collect();
        while let Some(id) = queue.pop_front() {
            if !seen.insert(id.clone()) {
                continue;
            }
            for kind in follow {
                queue.extend(self.kind(&id, kind));
            }
        }
        seen.iter().map(|id| self.names[id].clone()).collect()
    }

    /// Test-only edges of a workspace member, by package name.
    fn dev_dependencies(&self, package: &str) -> BTreeSet<String> {
        self.kind(self.member(package), "dev")
            .iter()
            .map(|id| self.names[id].clone())
            .collect()
    }
}

fn strip_comments(source: &str) -> String {
    let mut out = String::with_capacity(source.len());
    let mut chars = source.chars().peekable();
    let mut in_block = false;
    while let Some(character) = chars.next() {
        if in_block {
            if character == '*' && chars.peek() == Some(&'/') {
                chars.next();
                in_block = false;
            }
            continue;
        }
        if character == '/' {
            match chars.peek() {
                Some('/') => {
                    for skipped in chars.by_ref() {
                        if skipped == '\n' {
                            out.push('\n');
                            break;
                        }
                    }
                    continue;
                }
                Some('*') => {
                    chars.next();
                    in_block = true;
                    continue;
                }
                _ => {}
            }
        }
        out.push(character);
    }
    out
}

fn rust_sources(directory: &Path) -> Vec<PathBuf> {
    let mut files = Vec::new();
    let Ok(entries) = fs::read_dir(directory) else {
        return files;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            files.extend(rust_sources(&path));
        } else if path.extension().is_some_and(|extension| extension == "rs") {
            files.push(path);
        }
    }
    files.sort();
    files
}

fn lane_source_paths(crate_dir: &str, namespace: &str) -> Vec<PathBuf> {
    rust_sources(
        &rust_root()
            .join("crates")
            .join(crate_dir)
            .join("src")
            .join(namespace),
    )
}

/// Whether the source names `identifier` as a WHOLE identifier.
///
/// A bare substring cannot be used for a namespace name that is a suffix of an
/// unrelated one — `workspace_cold_read` is a different module, not a second
/// declaration of `cold_read` — and matching a `::`-delimited path segment cannot
/// either, because a declaration or re-export of a namespace need not carry a `::`.
fn names_identifier(source: &str, identifier: &str) -> bool {
    let is_ident = |byte: u8| byte.is_ascii_alphanumeric() || byte == b'_';
    source.match_indices(identifier).any(|(start, matched)| {
        let before_is_ident = start > 0 && is_ident(source.as_bytes()[start - 1]);
        let after = start + matched.len();
        let after_is_ident = after < source.len() && is_ident(source.as_bytes()[after]);
        !before_is_ident && !after_is_ident
    })
}

/// Whether every character is legal in an identifier, and there is at least one.
fn is_identifier(candidate: &str) -> bool {
    !candidate.is_empty()
        && candidate
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_')
}

/// Drops leading attributes, so `#[cfg(test)] mod x;` parses as the declaration it
/// is, and a crate root's own `#![forbid(..)]` does not hide the first one.
///
/// Terminates each attribute at the first `]`, which is sufficient for attributes
/// carrying paths, strings and nested parens; an attribute containing a `]` inside a
/// string would end the scan early and can only make this predicate MISS, never
/// invent, a declaration.
fn strip_attributes(item: &str) -> &str {
    let mut rest = item.trim_start();
    loop {
        let opened = rest.strip_prefix("#![").or_else(|| rest.strip_prefix("#["));
        let Some(attribute) = opened else {
            return rest;
        };
        let Some(end) = attribute.find(']') else {
            return rest;
        };
        rest = attribute[end + 1..].trim_start();
    }
}

/// Splits a leading visibility off an item, reporting whether the item is EXPORTED
/// beyond its own file.
///
/// `pub`, `pub(crate)`, `pub(super)` and `pub(in path)` are four spellings of one
/// property, and matching text per spelling is how `pub(crate) use` slipped past a
/// gate whose prose claimed to catch re-exports.
fn split_visibility(item: &str) -> (bool, &str) {
    let Some(rest) = item.strip_prefix("pub") else {
        return (false, item);
    };
    if let Some(restriction) = rest.strip_prefix('(') {
        return match restriction.find(')') {
            Some(end) => (true, restriction[end + 1..].trim_start()),
            None => (false, item),
        };
    }
    // `pub` must be a whole token: `published` is not a visibility.
    if rest.starts_with(char::is_whitespace) {
        return (true, rest.trim_start());
    }
    (false, item)
}

/// Whether `text` ends with `keyword` as a whole token rather than as the tail of a
/// longer identifier.
fn ends_with_token(text: &str, keyword: &str) -> bool {
    match text.strip_suffix(keyword) {
        Some(before) => !before
            .ends_with(|character: char| character.is_ascii_alphanumeric() || character == '_'),
        None => false,
    }
}

/// The LAST whole-token occurrence of `keyword`, split into what precedes it and
/// what follows.
fn split_last_token<'a>(chunk: &'a str, keyword: &str) -> Option<(&'a str, &'a str)> {
    let mut searched = chunk.len();
    while let Some(found) = chunk[..searched].rfind(keyword) {
        let before = &chunk[..found];
        if !before
            .ends_with(|character: char| character.is_ascii_alphanumeric() || character == '_')
        {
            return Some((before, &chunk[found + keyword.len()..]));
        }
        searched = found;
    }
    None
}

/// Whether an item's leading text ends in a visibility, which is how an exported
/// `use` is told from a private one when the item is read from its end.
fn ends_with_visibility(before: &str) -> bool {
    let trimmed = before.trim_end();
    let head = match trimmed.strip_suffix(')') {
        Some(restricted) => match restricted.rfind('(') {
            Some(open) => restricted[..open].trim_end(),
            None => return false,
        },
        None => trimmed,
    };
    ends_with_token(head, "pub")
}

/// The `mod NAME` a chunk ENDS with, at any visibility and behind any attributes.
///
/// Read from the END because a `;`-delimited chunk also carries the tail of whatever
/// preceded it: a crate root that holds code as well as declarations — the
/// composition root does — puts closing braces and expressions in front of its `mod`
/// lines, and a start-anchored match finds none of them. Inline modules stay excluded
/// for free: `mod tests {` leaves a brace where the name would be.
fn trailing_declaration(chunk: &str) -> Option<&str> {
    let (_, name) = split_last_token(chunk.trim_end(), "mod ")?;
    let name = name.trim();
    is_identifier(name).then_some(name)
}

/// The use tree of an EXPORTED `use` a chunk ends with. A private `use` names the
/// path for one file and adds no path anyone else can reach.
fn trailing_export(chunk: &str) -> Option<&str> {
    let (before, tree) = split_last_token(chunk, "use ")?;
    ends_with_visibility(before).then_some(tree)
}

/// Whether this source takes OWNERSHIP of `namespace` — declares it, or re-exports
/// it under a second path.
///
/// Deliberately not "mentions it": a crate root legitimately consumes another
/// crate's namespace, and prose and a struct field can carry the same word. Only a
/// declaration or an exported `use` creates a second owner.
///
/// Item-based rather than line-based, because a visibility qualifier, a leading
/// attribute and a braced group spanning several lines are all legal ways to own a
/// name, and a line-anchored equality test recognises none of them.
fn declares_or_reexports(source: &str, namespace: &str) -> bool {
    strip_comments(source).split(';').any(|chunk| {
        // Any visibility: a second `mod` of this name is a second module, and a
        // private one still owns the directory.
        trailing_declaration(chunk) == Some(namespace)
            || trailing_export(chunk).is_some_and(|tree| names_identifier(tree, namespace))
    })
}

/// Every module a crate root declares from a file, by name.
fn module_declarations(source: &str) -> BTreeSet<String> {
    strip_comments(source)
        .split(';')
        .filter_map(|chunk| trailing_declaration(chunk).map(str::to_owned))
        .collect()
}

fn root_module_declarations(crate_dir: &str) -> BTreeSet<String> {
    let root = rust_root()
        .join("crates")
        .join(crate_dir)
        .join("src/lib.rs");
    module_declarations(&read(&root))
}

/// Every module either inventory classifies for this root. A root absent from both
/// yields the empty set, which is what makes an unregistered declaration there a
/// failure rather than an unvisited file.
fn registered_modules(crate_dir: &str) -> BTreeSet<String> {
    SEAM_ROOT_MODULES
        .iter()
        .chain(ROOT_MODULES_WE_DID_NOT_ADD)
        .chain(ORGANIZATION_ROOT_MODULES)
        .filter(|(owner, _)| *owner == crate_dir)
        .map(|(_, module)| (*module).to_owned())
        .collect()
}

/// What a root declares that nothing classifies, and what an inventory claims that
/// the root no longer declares.
///
/// Pure over the two sets so the seamless-root case can be driven through this same
/// comparison, without waiting for another lane to add a module to prove it.
fn classification_gaps(
    declared: &BTreeSet<String>,
    registered: &BTreeSet<String>,
) -> (Vec<String>, Vec<String>) {
    (
        declared.difference(registered).cloned().collect(),
        registered.difference(declared).cloned().collect(),
    )
}

/// G0 — every module in every crate root sits in the inventory that guards it.
///
/// The gates below are driven by tables, and a module missing from a table is not
/// guarded by anything, with no signal at all. That failure has now happened twice,
/// so the tables are checked against the tree instead of trusted: a declaration no
/// inventory knows about fails here, and a shape mismatch (a flat module listed
/// where a `mod.rs` is read) fails here rather than as a confusing missing path.
///
/// The scan range is `CRATE_ROOTS`, never a range derived from a table being
/// verified. A closure that enumerates only the roots the seam ledger already names
/// cannot see the omission that matters — a module added to a root with no seam
/// entry, where no gate reads the file and every table-driven gate passes.
#[test]
fn g0_every_lane_module_sits_in_the_inventory_that_guards_it() {
    // Controls, both directions: a declaration is recognised at any visibility and
    // behind attributes, and nothing else is mistaken for one.
    assert!(is_identifier("cold_read") && !is_identifier("cold_read {") && !is_identifier(""));
    assert_eq!(split_visibility("pub(crate) use x"), (true, "use x"));
    assert_eq!(
        split_visibility("pub(in crate::wire) mod x"),
        (true, "mod x")
    );
    assert_eq!(split_visibility("pub mod x"), (true, "mod x"));
    assert_eq!(split_visibility("mod x"), (false, "mod x"));
    assert_eq!(
        split_visibility("published_at: 1"),
        (false, "published_at: 1")
    );
    assert_eq!(
        strip_attributes("#[cfg(test)]\n#[path = \"../x.rs\"]\nmod current_schema"),
        "mod current_schema"
    );
    // A crate root opens with an inner attribute, and it sits in the same item as
    // the first declaration: missing it hides that declaration from the closure.
    assert_eq!(
        strip_attributes("#![forbid(unsafe_code)]\n\npub mod access"),
        "pub mod access"
    );
    // A root that also carries CODE puts the tail of a function in front of its
    // declarations, which is how the composition root declares its only module.
    assert_eq!(
        trailing_declaration(
            "\n    rendered\n}\n\n#[cfg(test)]\n#[path = \"../x.rs\"]\nmod current_schema"
        ),
        Some("current_schema")
    );
    assert_eq!(
        trailing_declaration("pub(crate) mod policy"),
        Some("policy")
    );
    assert_eq!(trailing_declaration("mod tests {\n    use super::*"), None);
    assert_eq!(trailing_declaration("let rendered = demod x"), None);
    assert_eq!(trailing_declaration("fn cold_read() {}"), None);
    assert_eq!(
        trailing_export("}\n\npub(crate) use crate::cold_read"),
        Some("crate::cold_read")
    );
    assert_eq!(trailing_export("}\n\nuse crate::cold_read"), None);

    // Each classification is a claim about one module, and a set union of the
    // tables would silently absorb a repeated or doubled one.
    let inventories: [(&str, &[(&str, &str)]); 3] = [
        ("the seam ledger", SEAM_ROOT_MODULES),
        ("the inherited list", ROOT_MODULES_WE_DID_NOT_ADD),
        (
            "the transitional organization list",
            ORGANIZATION_ROOT_MODULES,
        ),
    ];
    let classified: Vec<(&str, BTreeSet<(&str, &str)>)> = inventories
        .iter()
        .map(|(label, table)| {
            let entries: BTreeSet<(&str, &str)> = table.iter().copied().collect();
            assert_eq!(entries.len(), table.len(), "{label} repeats an entry");
            (*label, entries)
        })
        .collect();
    for (position, (label, entries)) in classified.iter().enumerate() {
        for (other_label, other) in &classified[position + 1..] {
            let both: Vec<&(&str, &str)> = entries.intersection(other).collect();
            assert!(
                both.is_empty(),
                "{both:?} is claimed by {label} and by {other_label}"
            );
        }
    }

    for crate_dir in CRATE_ROOTS {
        let (unclassified, absent) = classification_gaps(
            &root_module_declarations(crate_dir),
            &registered_modules(crate_dir),
        );
        assert!(
            unclassified.is_empty(),
            "{crate_dir}/src/lib.rs declares {unclassified:?}, which no inventory \
             classifies: an unregistered module is guarded by nothing"
        );
        assert!(
            absent.is_empty(),
            "an inventory claims {absent:?} in {crate_dir}/src/lib.rs, which no longer \
             declares them"
        );
    }

    // The case the previous range could not reach: a root owning no seam entry.
    // Driven through the same parser and the same comparison as the roots above,
    // from a fixture, so it holds without another lane adding a module to prove it.
    let seamless_root = "#![forbid(unsafe_code)]\n\npub mod access;\npub mod host_agent;\n";
    assert_eq!(
        classification_gaps(
            &module_declarations(seamless_root),
            &["access".to_owned()].into_iter().collect(),
        )
        .0,
        vec!["host_agent".to_owned()],
        "a declaration in a root with no seam entry must still be reported"
    );

    // The fifth workspace crate `backend-filesystem` is now in `CRATE_ROOTS`, so the
    // loop above scans all of its declarations. Prove those classifications are
    // load-bearing rather than trusting a reader: driven against the REAL filesystem
    // root with the registry emptied, EVERY name is reported — the inherited
    // `blob_store`, this lane's seam entry `runtime_detection`, and #task:2256's
    // `audit_sink` — so deleting any classification turns G0 red. Without filesystem in
    // the scan range, those entries would be dead and their deletion silent, which is the
    // second-layer false-green this closes.
    assert_eq!(
        classification_gaps(
            &root_module_declarations("backend-filesystem"),
            &BTreeSet::new(),
        )
        .0,
        vec![
            "audit_sink".to_owned(),
            "blob_store".to_owned(),
            "runtime_detection".to_owned()
        ],
        "deleting backend-filesystem's root classification must turn G0 red"
    );

    let mut directory_shaped: BTreeSet<(&str, &str)> = BTreeSet::new();
    for (crate_dir, module) in SEAM_ROOT_MODULES {
        let module_dir = rust_root()
            .join("crates")
            .join(crate_dir)
            .join("src")
            .join(module);
        let is_directory = module_dir.join("mod.rs").is_file();
        assert!(
            is_directory != module_dir.with_extension("rs").is_file(),
            "{}: a module is either a directory with mod.rs or a flat file",
            module_dir.display()
        );
        if is_directory {
            directory_shaped.insert((crate_dir, module));
        }
    }
    // Exact, both ways: a flat module listed here would send G5 at a missing path,
    // and an entry outside the ledger would fence a namespace this lane never added.
    assert_eq!(
        DIRECTORY_NAMESPACES
            .iter()
            .copied()
            .collect::<BTreeSet<_>>(),
        directory_shaped,
        "the directory inventory and the tree disagree about which seam modules own a mod.rs"
    );

    for entry in ACTIVATION_NAMESPACES {
        assert!(
            SEAM_ROOT_MODULES.contains(entry),
            "{entry:?} is fenced against activation but is not in the seam ledger"
        );
    }
}

#[test]
fn g1_core_carries_no_driver_wire_or_runtime_dependency() {
    let graph = resolved_graph();

    let linked = graph.linked_closure("silverhand-backend-core");
    let in_library: Vec<&str> = DRIVER_WIRE_RUNTIME
        .iter()
        .copied()
        .filter(|package| linked.contains(*package))
        .collect();
    assert!(
        in_library.is_empty(),
        "backend-core linked closure reached {in_library:?}"
    );
    assert!(linked.contains("base64") && linked.contains("sha2"));

    let build = graph.build_closure("silverhand-backend-core");
    let in_build: Vec<&str> = RUNTIME_AND_DRIVER
        .iter()
        .copied()
        .filter(|package| build.contains(*package))
        .collect();
    assert!(
        in_build.is_empty(),
        "backend-core build closure reached {in_build:?}"
    );
}

#[test]
fn g1_the_persistence_and_wire_crates_keep_their_direction() {
    let graph = resolved_graph();
    assert!(
        !graph
            .linked_closure("silverhand-backend-sqlite")
            .contains("silverhand-backend-server"),
        "backend-sqlite must not depend on the wire crate"
    );
    assert!(
        !graph
            .linked_closure("silverhand-backend-server")
            .contains("silverhand-backend-sqlite"),
        "backend-server production code must not be able to name the SQLite adapter"
    );
    assert!(
        graph
            .dev_dependencies("silverhand-backend-server")
            .contains("silverhand-backend-sqlite"),
        "the SQLite adapter is a backend-server test-only dependency"
    );

    // The filesystem adapter is a leaf: its linked closure reaches only backend-core
    // (+ tokio), so it can name neither the wire crate nor the SQLite adapter. This
    // pins the new adapter's acyclicity.
    //
    // Honest scope: the reverse edge — backend-server naming backend-filesystem — DOES
    // exist as #task:2200's approved typed local-alias capability, and is deliberately
    // NOT fenced here. So this gate pins adapter acyclicity, not the full
    // "persistence/wire direction" its title claims; that one approved server→filesystem
    // edge is a bounded exception, not a hole.
    let filesystem = graph.linked_closure("silverhand-backend-filesystem");
    assert!(
        !filesystem.contains("silverhand-backend-server"),
        "backend-filesystem must not depend on the wire crate"
    );
    assert!(
        !filesystem.contains("silverhand-backend-sqlite"),
        "backend-filesystem must not depend on the SQLite adapter"
    );
}

#[test]
fn g2_background_policy_names_no_timer_or_driver() {
    // Residual guard only: aliases, macros and re-exports can bypass a source
    // scan. The compile-enforced carrier is G1 plus core's manifest.
    //
    // A crate or module path is a reach wherever it appears, so it is matched as
    // a substring. A bare type or function name only catches an aliased reach,
    // and a domain type may legitimately end in one — `ActivityInstant` is a
    // validated stamp, not a clock — so those are matched as whole identifiers.
    const FORBIDDEN_PATHS: &[&str] = &["tokio", "std::time", "axum", "sqlx"];
    const FORBIDDEN_NAMES: &[&str] = &["Instant", "SystemTime", "sleep", "spawn"];
    for path in lane_source_paths("backend-core", "policy") {
        let source = strip_comments(&read(&path));
        for forbidden in FORBIDDEN_PATHS {
            assert!(
                !source.contains(forbidden),
                "{} names {forbidden}: policy decisions stay timer-free",
                path.display()
            );
        }
        for forbidden in FORBIDDEN_NAMES {
            assert!(
                !names_identifier(&source, forbidden),
                "{} names {forbidden}: policy decisions stay timer-free",
                path.display()
            );
        }
    }
}

#[test]
fn g2_background_timers_carry_no_http_surface() {
    for path in lane_source_paths("backend-server", "host_agent_background") {
        let source = strip_comments(&read(&path));
        for forbidden in ["axum", "Router", "StatusCode"] {
            assert!(
                !source.contains(forbidden),
                "{} names {forbidden}: timers are not an HTTP surface",
                path.display()
            );
        }
    }
}

#[test]
fn g4_the_seam_touches_only_crate_roots_and_only_as_declarations() {
    // A near-miss name is not a second declaration, and a field is not a re-export.
    assert!(!declares_or_reexports(
        "pub mod workspace_cold_read;",
        "cold_read"
    ));
    assert!(!declares_or_reexports(
        "    capability: messaging_store.clone(),",
        "capability"
    ));
    // A private import names the namespace for one file and creates no second path.
    assert!(!declares_or_reexports(
        "use silverhand_backend_core::cold_read::availability::read_agent_availability;",
        "cold_read"
    ));
    // Stripping a visibility must not turn every item into a declaration.
    assert!(!declares_or_reexports(
        "pub(crate) fn cold_read() {}",
        "cold_read"
    ));

    // Every spelling that DOES create a second owner, including the ones a
    // line-anchored `pub use ` test used to miss.
    assert!(declares_or_reexports("pub mod cold_read;", "cold_read"));
    assert!(declares_or_reexports("mod cold_read;", "cold_read"));
    assert!(declares_or_reexports(
        "pub use silverhand_backend_core::cold_read;",
        "cold_read"
    ));
    // The standing counterexample for the module that was in no inventory at all:
    // both bypass spellings, in the two roots that could host them.
    assert!(declares_or_reexports(
        "pub(crate) use silverhand_backend_core::agent_lifecycle;",
        "agent_lifecycle"
    ));
    assert!(declares_or_reexports(
        "pub(in crate::wire) use silverhand_backend_core::agent_lifecycle;",
        "agent_lifecycle"
    ));
    assert!(declares_or_reexports(
        "pub(crate) mod agent_lifecycle;",
        "agent_lifecycle"
    ));
    assert!(declares_or_reexports(
        "pub use silverhand_backend_core::{\n    agent_lifecycle,\n    identity,\n};",
        "agent_lifecycle"
    ));

    for (crate_dir, namespace) in SEAM_ROOT_MODULES {
        // A seam root entry is the CURRENT OWNING ROOT NAMESPACE and is a `mod`
        // declaration at exactly one root — whether it is a leaf module or an organization
        // namespace CONTAINER (e.g. `identity_access`) that owns relocated leaves beneath it
        // (#task:2272). Either way the invariant is the same: declared once at its crate
        // root, no unregistered second owner elsewhere; the gate never descends into a
        // container. Its visibility is orthogonal to that invariant: most are `pub mod`, but
        // a crate-private shared authority (e.g. `agent_wire`) is `pub(crate) mod` and is
        // still declared exactly once. Accept either spelling; the fork guard below stays
        // visibility-agnostic via `declares_or_reexports`.
        let pub_declaration = format!("pub mod {namespace};");
        let crate_declaration = format!("pub(crate) mod {namespace};");
        let root = rust_root()
            .join("crates")
            .join(crate_dir)
            .join("src/lib.rs");
        let source = read(&root);
        assert_eq!(
            source
                .lines()
                .filter(|line| {
                    let line = line.trim();
                    line == pub_declaration || line == crate_declaration
                })
                .count(),
            1,
            "{} must declare {namespace} exactly once",
            root.display()
        );
        for other_dir in CRATE_ROOTS {
            if other_dir == crate_dir {
                continue;
            }
            // A co-owner the lane registered is not a fork: a name distributed across
            // roles (a core port and its SQLite adapter, a SQLite lane and its route
            // surface) lists each owning root as its own entry. Only an owner in a
            // root NOT registered in ANY CP inventory is the accidental second declaration
            // this refuses. A relocation namespace container legitimately appears in more
            // than one crate — registered in SEAM in one crate (#task:2272, backend-core's
            // identity_access owns a route-seam leaf) and in ORGANIZATION_ROOT_MODULES in
            // another (#task:2270, backend-server's organization containers) — so the
            // exemption consults registered_modules (the same per-root union g0 uses), never
            // SEAM alone. This is not a new durable inventory; it reuses g0's registration
            // truth so a registered co-owner is not misread as a fork (#task:2273).
            if registered_modules(other_dir).contains(*namespace) {
                continue;
            }
            let other = rust_root()
                .join("crates")
                .join(other_dir)
                .join("src/lib.rs");
            assert!(
                !declares_or_reexports(&read(&other), namespace),
                "{} declares or re-exports {namespace} without a seam entry: an unregistered second owner",
                other.display()
            );
        }
    }
}

#[test]
fn g5_namespaces_declare_and_never_carry_business() {
    for (crate_dir, namespace) in DIRECTORY_NAMESPACES {
        let path = rust_root()
            .join("crates")
            .join(crate_dir)
            .join("src")
            .join(namespace)
            .join("mod.rs");
        // Item-based for the same reason as G4: a braced re-export group and a
        // visibility qualifier are legal, and a function body is not.
        for item in strip_comments(&read(&path)).split(';') {
            let item = item.trim();
            if item.is_empty() {
                continue;
            }
            let (_, rest) = split_visibility(strip_attributes(item));
            assert!(
                rest.starts_with("mod ") || rest.starts_with("use "),
                "{} carries `{item}`: a namespace declares and re-exports only",
                path.display()
            );
        }
    }
}

/// G6 — the capability namespace decides, and never acquires.
///
/// A pure decision over already-read facts is what lets one rule serve a face
/// that reads before an independent write and a face that must read under the
/// write lock it commits in. The two properties that make it pure are carried
/// differently, and only one of them needs a fence:
///
///  - "holds no driver" is already compile-enforced — `backend-core`'s production
///    closure reaches no driver, wire or runtime crate (G1);
///  - "acquires nothing" is a SIGNATURE property: these functions take facts and
///    return a verdict, so a rule that wanted to read would have to change its
///    signature and every call site. This gate is the tripwire against the first
///    step towards that — declaring a port or going async inside the namespace.
///
/// A LEXICAL fence, with the same accounting as G3: it guards the named boundary
/// "capability acquires no facts", it is removed when a compile-level carrier
/// exists (a sealed fact-provider trait owned outside this namespace would be
/// one), and it is owned by this lane.
#[test]
fn g6_capability_decides_over_facts_and_declares_no_port() {
    // The `capability` decision namespace relocated under the C1 `identity_access` container
    // (#task:2277); this behavioral fence follows it to its new path. The invariant is
    // unchanged — a capability decides over facts it was handed and declares no port.
    let paths = lane_source_paths("backend-core", "identity_access/capability");
    assert!(
        paths.len() >= 4,
        "expected the capability namespace to carry its leaves, found {paths:?}"
    );
    for path in paths {
        let source = strip_comments(&read(&path));
        for forbidden in ["async fn", "impl Future", "-> impl Future", "trait "] {
            assert!(
                !source.contains(forbidden),
                "{} carries `{forbidden}`: a capability decides over facts it was handed",
                path.display()
            );
        }
    }
}
