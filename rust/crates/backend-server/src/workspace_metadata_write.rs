//! The regular-workspace METADATA write surface:
//! `PATCH /api/workspaces/{id}` (rename + description) and
//! `PATCH /api/workspaces/{id}/archive`.
//!
//! Both routes are thin transports over the write context in
//! [`silverhand_backend_core::identity_access::workspace_metadata_write`]: the domain owns the
//! atomic write, the in-lock governance re-derivation, the collision decision,
//! the committed-fact seal, and — for a rename — the `metadata_changed` viewer
//! hint the commit owes. This module's only jobs are the request-boundary
//! admission (authenticate, resolve the workspace's existence + the caller's
//! governance floor BEFORE the body is parsed) and the wire projection.
//!
//! ## A committed rename owes TWO effects; both are DRIVEN here, off one gate
//!
//! A committed rename owes two outward effects, and BOTH are driven off the single
//! sealed [`WorkspaceNameChange`] the domain surfaces, so the committed fact is
//! never dropped at this boundary:
//!
//! 1. The `viewer_workspaces_changed { metadata_changed }` cache-invalidation hint
//!    — a pure id-only signal the workspace context OWNS, fired inside the domain
//!    (its fate carried back here as a value).
//! 2. The per-channel workspace-rename SYSTEM MESSAGE — a MESSAGING-context effect.
//!    This route holds it as ONE narrow outbound requirement,
//!    [`WorkspaceRenameFanout`], whose input is the sealed [`WorkspaceNameChange`]
//!    and which on a committed rename this handler MUST call. It is a single
//!    WHOLE-fan-out requirement (author PLUS deliver PLUS publish) so the leaf
//!    cannot call three separate partial ports and can never OMIT the requirement
//!    on a committed rename. It does NOT, however, force the eventual production
//!    impl to truly author AND deliver AND publish — an adapter that merely
//!    INSERTs and returns `Ok(())` still compiles; that completeness is an
//!    integration review/test responsibility (see the [#task:2215] residual),
//!    not something this type guarantees. The route does not author anything
//!    itself; it hands the committed gate to the messaging context's adapter.
//!
//! The messaging fan-out ships NO production implementation in this leaf: the
//! [#task:2215] integration residual is to implement that ONE complete adapter
//! (message author + daemon delivery + channel-hub publication) plus its event
//! catalogue/hub and mount it — NOT to reopen this handler's contract, which
//! already exposes the requirement the mount fills. The two effects are
//! INDEPENDENT and both best-effort: a failing viewer hint does not stop the
//! fan-out, a failing fan-out does not downgrade the committed `200`, and each
//! records its own error chain. A description-only edit, a no-op rename to the same
//! display, and an archive drive neither.
//!
//! ## Refusal ORDERING: the governance floor stays BEFORE body admission
//!
//! The TypeScript route answers, in this exact order:
//! `404` (absent workspace / agent-home) → `403` (governance floor) →
//! body admission → `409` (name collision) → `200`. The `403`-BEFORE-body rung is
//! the one named security invariant this surface keeps under the frozen admission
//! model: it reads the caller's governance facts and applies the floor
//! ([`governance_floor_verdict`]) with a PRE-LOCK [`WorkspaceGovernanceFactsRead`]
//! BEFORE the body is decoded, so a caller without standing cannot probe body
//! shape. Rename requires the `Admin` floor, archive the `Owner` floor — a
//! distinction the collapsed governance ceiling cannot express, so the floor door
//! is used, not the ceiling.
//!
//! To keep that ordering the handler takes an owned `Request` (never an eager body
//! extractor) and decodes it with a DEFERRED `Json::<ObjectOnly<Raw>>::from_request`
//! only after the floor admits, so a `404`/`403` caller never has their body
//! buffered. The shared [`ObjectOnly<T>`](crate::wire_admission::ObjectOnly) map
//! floor rejects a top-level array/scalar/null (a derived struct visitor would
//! otherwise decode a JSON array into fields positionally); the native decode owns
//! the remaining structural rejections (malformed → `400`, wrong
//! type/shape/duplicate-key → `422`, missing content-type → `415`) and introduces
//! axum's application-wide `DefaultBodyLimit` (2 MiB) — the same framework default
//! the served app applies everywhere, not an endpoint-local cap; the product route
//! itself has no bespoke limit. A structurally valid body that satisfies no
//! acceptance arm — including the empty "no fields to update" object — is the
//! minimal semantic `422 { "error": "invalid input" }`.
//!
//! That pre-lock verdict can go stale (a demotion may commit in the seam before
//! the write lock). Guarding that is the WRITE's job: the domain re-derives the
//! caller's authority under its own lock and can still answer `403`/`404`. Those
//! late refusals are unreachable for a single-threaded client but are surfaced
//! faithfully; they never change the answer for any input the pre-lock door
//! already graded.
//!
//! ## Semantic admission is the minimal terminal `422`
//!
//! This surface takes the frozen admission model's terminal semantic refusal:
//! `422 { "error": "invalid input" }`, with NO Zod `issues` array. The prior port
//! reproduced the Zod-3 issue objects (code / field set / values / array order)
//! under a cross-language parity fixture; that projection and its
//! `admission-cases.json` gate are RETIRED — no shared response schema pins
//! `issues` and no client branches on the issue `code`. The ordered
//! [`CanonicalWorkspaceName::parse`] authority still decides acceptance (empty vs
//! over-long vs forbidden-scalar all refuse), but the refusal is no longer
//! distinguished on the wire. The now-dead TS oracle
//! (`workspace-metadata-write-admission-parity.test.ts`) and its fixture were
//! deleted with this migration; nothing pins the issue bytes anymore.
//!
//! ## Faults take the lane's safe `500`, never a JSON envelope
//!
//! The product route emits a JSON `{ error: "workspace update failed" }` `500`
//! for the impossible `updateMutableMetadata` → undefined case. Here that maps to
//! a driver fault or an untrustworthy committed row, which — exactly as the
//! sibling list/detail routes do — takes the lane's bare `text/plain`
//! `Internal Server Error`, so no adapter detail can ever leak and a
//! misconfiguration is never dressed as a product answer. A client cannot branch
//! on a `500` body; this keeps the whole crate's safe-500 seam uniform.

use axum::{
    Json, Router,
    extract::{Extension, FromRequest, Path, Request, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::patch,
};
use std::future::Future;

use serde::{Deserialize, Serialize};
use silverhand_backend_core::identity_access::access::WorkspaceGovernanceFloor;
use silverhand_backend_core::identity_access::workspace_name::CanonicalWorkspaceName;
use silverhand_backend_core::{
    foundation::identity::{Principal, UserId, WorkspaceId},
    identity_access::access::{
        WorkspaceGovernanceFactsRead, WorkspaceRole, governance_floor_verdict,
    },
    identity_access::workspace_face::WorkspaceFace,
    identity_access::workspace_metadata_write::{
        WorkspaceArchiveUpdate, WorkspaceMetadataAnnounce, WorkspaceMetadataChangedSink,
        WorkspaceMetadataEdit, WorkspaceMetadataUpdateWithAnnounce,
        WorkspaceMetadataWriteUnitOfWork, WorkspaceNameChange, archive_workspace,
        update_workspace_metadata_and_announce,
    },
};

use crate::error;
use crate::wire_admission;
use crate::wire_admission::ObjectOnly;
use crate::wire_patch::{PatchField, RequiredPatchField};
use crate::workspaces::ViewerWorkspaceDto;

/// The rename/describe route template, in axum's `{id}` capture syntax. An empty
/// segment does not match, so the product's `if (!id) 400` branch is
/// structurally unreachable; a non-empty but unresolvable id is `404`.
pub const WORKSPACE_METADATA_PATH: &str = "/api/workspaces/{id}";

/// The archive-toggle route template.
pub const WORKSPACE_ARCHIVE_PATH: &str = "/api/workspaces/{id}/archive";

/// `c.json({ error: 'workspace not found' }, 404)`.
const WORKSPACE_NOT_FOUND: &str = "workspace not found";
/// `c.json({ error: 'forbidden' }, 403)`.
const FORBIDDEN: &str = "forbidden";
/// `c.json({ error: 'workspace name already exists' }, 409)`.
const NAME_TAKEN: &str = "workspace name already exists";
/// The safe-500 body: a bare `text/plain`, matching the sibling routes.
const INTERNAL_ERROR_BODY: &str = "Internal Server Error";

/// The metadata clock: the write instant the boundary samples, as signed Unix
/// milliseconds (`Date.now()` parity). It is this slice's narrow time capability,
/// mirroring the sibling per-slice clocks (`EnrollmentClock`, `RuntimeClock`, …).
/// Its production owner is not a bespoke app-layer wrapper: this contract is the
/// same signed-`Date.now()`-millis answer the process-clock port already gives, so
/// the existing [`crate::clock::SystemProcessClock`] implements this trait directly
/// and the composition injects that one owner. Injecting the capability lets a test
/// pin the `updated_at`/`archived_at` the write stamps, so the `200` body is
/// deterministic.
pub trait WorkspaceMetadataClock: Clone + Send + Sync + 'static {
    fn now_unix_millis(&self) -> i64;
}

/// The messaging fan-out a committed workspace rename owes: the per-channel
/// workspace-rename SYSTEM MESSAGE, as ONE whole effect — authoring it AND
/// delivering it AND publishing it. It is deliberately a single requirement, not
/// three author/deliver/publish ports, so this leaf can never satisfy it by
/// authoring a message that is then never delivered or published (a silent
/// half-effect). Its input is the sealed [`WorkspaceNameChange`] the domain
/// surfaces, so the messaging context receives the committed address pair (old/new
/// display + fold key) and the workspace id, and re-derives nothing.
///
/// This is an OUTBOUND requirement of the workspace-metadata boundary owned by the
/// MESSAGING bounded context, not an effect this context implements — mirroring the
/// per-slice clock, the trait states the dependency here and the production adapter
/// is assembled at the mount seam. There is deliberately NO production or no-op
/// implementation in this crate: the [#task:2215] residual is to implement the one
/// complete adapter (author + daemon delivery + channel-hub publication), give it a
/// wire event catalogue/hub, and mount it. The handler contract already exposes the
/// requirement, so the mount fills it without reopening this leaf.
///
/// Best-effort and INDEPENDENT of the `metadata_changed` viewer hint: a failure
/// never downgrades the committed `200` (the route records the error chain and the
/// channels simply do not get the message), and it is attempted regardless of
/// whether the viewer hint succeeded. It fires iff the commit carried a
/// [`WorkspaceNameChange`] — a description-only edit, a no-op rename to the same
/// display, and an archive fire it zero times.
pub trait WorkspaceRenameFanout: Clone + Send + Sync + 'static {
    fn fan_out_rename(
        &self,
        workspace_id: &WorkspaceId,
        change: &WorkspaceNameChange,
    ) -> impl Future<Output = Result<(), WorkspaceRenameFanoutFailure>> + Send;
}

/// The per-channel rename fan-out could not be completed (a message could not be
/// authored, delivered, or published). Opaque like the domain's announce failure
/// and for the same reason — the transport's concrete error stays available as the
/// `source` for the boundary that records it, while no messaging/transport type
/// leaks into this route. The rename is committed regardless; a failure here means
/// the channels were simply not told.
///
/// `Display`/`Error` are implemented by hand rather than derived, because this
/// module imports the `crate::error` module, which shadows `thiserror`'s `#[error]`
/// derive helper in attribute position.
#[derive(Debug)]
pub struct WorkspaceRenameFanoutFailure {
    source: Box<dyn std::error::Error + Send + Sync + 'static>,
}

impl std::fmt::Display for WorkspaceRenameFanoutFailure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("workspace rename fan-out could not be completed")
    }
}

impl std::error::Error for WorkspaceRenameFanoutFailure {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        Some(&*self.source)
    }
}

impl WorkspaceRenameFanoutFailure {
    pub fn from_source<E>(source: E) -> Self
    where
        E: std::error::Error + Send + Sync + 'static,
    {
        Self {
            source: Box::new(source),
        }
    }
}

/// Everything the two write handlers need, assembled by the composition root: the
/// governance read, the write unit of work, the `metadata_changed` viewer-hint
/// sink, the per-channel rename fan-out requirement, and the clock. The viewer hint
/// is owned by the domain and fired there; the rename fan-out is the messaging
/// context's outbound requirement this route drives off the committed gate.
#[derive(Clone)]
struct WorkspaceWriteState<G, W, S, F, C> {
    governance: G,
    writes: W,
    sink: S,
    fanout: F,
    clock: C,
}

/// Mounts both metadata-write routes generic over their ports, so tests drive
/// driver-free fakes and the composition root wires the SQLite adapters. Route
/// registration into the served application is a separate integration seam.
pub fn router<G, W, S, F, C>(governance: G, writes: W, sink: S, fanout: F, clock: C) -> Router
where
    G: WorkspaceGovernanceFactsRead,
    W: WorkspaceMetadataWriteUnitOfWork,
    S: WorkspaceMetadataChangedSink,
    F: WorkspaceRenameFanout,
    C: WorkspaceMetadataClock,
{
    Router::new()
        .route(
            WORKSPACE_METADATA_PATH,
            patch(patch_metadata::<G, W, S, F, C>),
        )
        .route(
            WORKSPACE_ARCHIVE_PATH,
            patch(patch_archive::<G, W, S, F, C>),
        )
        .with_state(WorkspaceWriteState {
            governance,
            writes,
            sink,
            fanout,
            clock,
        })
}

async fn patch_metadata<G, W, S, F, C>(
    Path(id): Path<String>,
    viewer: Option<Extension<UserId>>,
    State(state): State<WorkspaceWriteState<G, W, S, F, C>>,
    request: Request,
) -> Response
where
    G: WorkspaceGovernanceFactsRead,
    W: WorkspaceMetadataWriteUnitOfWork,
    S: WorkspaceMetadataChangedSink,
    F: WorkspaceRenameFanout,
    C: WorkspaceMetadataClock,
{
    let Some(Extension(viewer)) = viewer else {
        tracing::error!("workspace metadata-write route reached without its human principal fact");
        return internal_error();
    };
    let principal = Principal::human(viewer);
    let Ok(workspace_id) = WorkspaceId::parse(id) else {
        return not_found();
    };

    // 404 (existence) → 403 (governance) resolved BEFORE the body is parsed, so a
    // caller without standing cannot probe body shape. Rename requires `Admin`.
    match governance_floor(
        &state.governance,
        &principal,
        &workspace_id,
        WorkspaceRole::Admin,
    )
    .await
    {
        Ok(WorkspaceGovernanceFloor::WorkspaceNotFound) => return not_found(),
        Ok(WorkspaceGovernanceFloor::Denied) => return forbidden(),
        Ok(WorkspaceGovernanceFloor::Governs) => {}
        Err(()) => return internal_error(),
    }

    // Body decode is DEFERRED past the floor: a `404`/`403` caller is answered
    // above without their body ever being buffered. Only once the floor admits is
    // the request consumed by the native `Json` extractor, wrapped in the shared
    // [`ObjectOnly<T>`] object floor so a top-level array/scalar/null is a native
    // structural rejection (a derived struct visitor would otherwise fill fields
    // positionally from a JSON array). The native structural rejections (malformed
    // / wrong-type / missing content-type) are preserved, and axum's
    // application-wide `DefaultBodyLimit` (2 MiB) still applies — the same
    // framework default the served app applies everywhere, not an endpoint-local
    // cap.
    let raw = match Json::<ObjectOnly<WorkspaceUpdateRaw>>::from_request(request, &()).await {
        Ok(Json(ObjectOnly(raw))) => raw,
        Err(rejection) => return rejection.into_response(),
    };
    // A structurally valid body no arm accepts — including the "no fields to
    // update" refine — is the minimal semantic 422.
    let Ok(edit) = WorkspaceMetadataEdit::try_from(raw) else {
        return wire_admission::invalid_input();
    };

    let now_ms = state.clock.now_unix_millis();
    match update_workspace_metadata_and_announce(
        &state.writes,
        &state.sink,
        principal,
        &workspace_id,
        edit,
        now_ms,
    )
    .await
    {
        Ok(WorkspaceMetadataUpdateWithAnnounce::NoSuchWorkspace) => not_found(),
        Ok(WorkspaceMetadataUpdateWithAnnounce::Forbidden) => forbidden(),
        Ok(WorkspaceMetadataUpdateWithAnnounce::NameTaken) => name_taken(),
        Ok(WorkspaceMetadataUpdateWithAnnounce::Committed(announced)) => {
            let (face, name_change, announce) = announced.into_parts();

            // The viewer hint already fired inside the domain (best-effort, its
            // fate carried here as a value). A failed hint is recorded, never a
            // downgrade of the committed 200.
            if let WorkspaceMetadataAnnounce::Failed(failure) = &announce {
                tracing::error!(
                    error_chain = %error::describe(failure),
                    "workspace metadata_changed viewer hint could not be delivered; \
                     affected readers stay stale until they refetch"
                );
            }

            // A committed rename owes the per-channel system message. This route
            // DRIVES that whole fan-out off the sealed gate (it does not author
            // anything itself): the messaging context's adapter receives the
            // committed `WorkspaceNameChange`. It is independent of the viewer hint
            // above — attempted whether or not the hint succeeded — and best-effort:
            // the fan-out is PARTIAL (author is a per-channel precondition, delivery
            // isolates per agent, publication rides each authored channel), so a
            // failure means SOME legs may not have completed while others did. The
            // FIRST failing leg's cause is retained; the committed 200 never
            // downgrades. The address-reassignment audit is logged off the same gate.
            if let Some(change) = &name_change {
                tracing::info!(
                    workspace = %workspace_id.as_str(),
                    action = "rename",
                    old_key = %change.old_key,
                    new_key = %change.new_key,
                    "workspace address reassigned"
                );
                if let Err(failure) = state.fanout.fan_out_rename(&workspace_id, change).await {
                    tracing::error!(
                        error_chain = %error::describe(&failure),
                        workspace = %workspace_id.as_str(),
                        "workspace rename fan-out was incomplete; the first failing leg's \
                         cause is retained — some channels or agents may not have received \
                         the rename system message"
                    );
                }
            }

            ok_workspace(&face)
        }
        Err(cause) => {
            tracing::error!(
                error_chain = %error::describe(&cause),
                "workspace metadata write failed"
            );
            internal_error()
        }
    }
}

async fn patch_archive<G, W, S, F, C>(
    Path(id): Path<String>,
    viewer: Option<Extension<UserId>>,
    State(state): State<WorkspaceWriteState<G, W, S, F, C>>,
    request: Request,
) -> Response
where
    G: WorkspaceGovernanceFactsRead,
    W: WorkspaceMetadataWriteUnitOfWork,
    S: WorkspaceMetadataChangedSink,
    F: WorkspaceRenameFanout,
    C: WorkspaceMetadataClock,
{
    let Some(Extension(viewer)) = viewer else {
        tracing::error!("workspace archive route reached without its human principal fact");
        return internal_error();
    };
    let principal = Principal::human(viewer);
    let Ok(workspace_id) = WorkspaceId::parse(id) else {
        return not_found();
    };

    // Archive requires the stricter `Owner` floor. Same 404→403 pre-lock order.
    match governance_floor(
        &state.governance,
        &principal,
        &workspace_id,
        WorkspaceRole::Owner,
    )
    .await
    {
        Ok(WorkspaceGovernanceFloor::WorkspaceNotFound) => return not_found(),
        Ok(WorkspaceGovernanceFloor::Denied) => return forbidden(),
        Ok(WorkspaceGovernanceFloor::Governs) => {}
        Err(()) => return internal_error(),
    }

    // Body decode is DEFERRED past the floor, exactly as the rename route above,
    // and through the same shared [`ObjectOnly<T>`] object floor.
    let raw = match Json::<ObjectOnly<WorkspaceArchiveRaw>>::from_request(request, &()).await {
        Ok(Json(ObjectOnly(raw))) => raw,
        Err(rejection) => return rejection.into_response(),
    };
    let archived = raw.archived;

    let now_ms = state.clock.now_unix_millis();
    match archive_workspace(&state.writes, principal, &workspace_id, archived, now_ms).await {
        Ok(WorkspaceArchiveUpdate::NoSuchWorkspace) => not_found(),
        Ok(WorkspaceArchiveUpdate::Forbidden) => forbidden(),
        Ok(WorkspaceArchiveUpdate::Committed(committed)) => ok_workspace(committed.face()),
        Err(cause) => {
            tracing::error!(
                error_chain = %error::describe(&cause),
                "workspace archive write failed"
            );
            internal_error()
        }
    }
}

/// Read the caller's governance facts and apply `min_role`. A persistence fault
/// collapses to `Err(())` — the caller renders the lane's safe `500` and logs the
/// source chain — so no driver detail escapes into the verdict.
async fn governance_floor<G>(
    governance: &G,
    principal: &Principal,
    workspace_id: &WorkspaceId,
    min_role: WorkspaceRole,
) -> Result<WorkspaceGovernanceFloor, ()>
where
    G: WorkspaceGovernanceFactsRead,
{
    match governance
        .read_governance_facts(principal, workspace_id)
        .await
    {
        Ok(facts) => Ok(governance_floor_verdict(principal, facts, min_role)),
        Err(cause) => {
            tracing::error!(
                error_chain = %error::describe(&cause),
                "workspace governance facts read failed"
            );
            Err(())
        }
    }
}

/// The `PATCH /api/workspaces/{id}` body, decoded by the native `Json` extractor
/// once the governance floor admits. `name` is a [`RequiredPatchField`] (absent
/// key → the "no name" arm; present `null`/non-string → a native decode fault,
/// as Zod's optional `WorkspaceNameSchema` refuses a present non-string), while
/// `description` is a full tri-state [`PatchField`] because `z.string().nullable()`
/// makes a present `null` a MEANINGFUL "clear", distinct from an absent key.
#[derive(Debug, Deserialize)]
struct WorkspaceUpdateRaw {
    #[serde(default)]
    name: RequiredPatchField<String>,
    #[serde(default)]
    description: PatchField<String>,
}

impl TryFrom<WorkspaceUpdateRaw> for WorkspaceMetadataEdit {
    type Error = ();

    /// Reproduce `UpdateWorkspaceInputSchema` acceptance: normalize a present
    /// `name` through the sole [`CanonicalWorkspaceName::parse`] authority, treat a
    /// present `description` key (value OR `null`) as a field, and require at least
    /// one field — the Zod `.refine`, which `Err(())` (the minimal semantic 422)
    /// otherwise. A present-`null` description is a "clear", not a fail, exactly as
    /// the nullable schema counts it a field.
    fn try_from(raw: WorkspaceUpdateRaw) -> Result<Self, ()> {
        let name = match raw.name {
            RequiredPatchField::Missing => None,
            RequiredPatchField::Value(text) => {
                Some(CanonicalWorkspaceName::parse(&text).map_err(|_| ())?)
            }
        };
        let description_present = !matches!(raw.description, PatchField::Missing);
        let description = match raw.description {
            PatchField::Missing | PatchField::Null => None,
            PatchField::Value(text) => Some(text),
        };

        match (name, description_present) {
            (Some(name), true) => {
                Ok(WorkspaceMetadataEdit::NameAndDescription { name, description })
            }
            (Some(name), false) => Ok(WorkspaceMetadataEdit::Name(name)),
            (None, true) => Ok(WorkspaceMetadataEdit::Description(description)),
            // No field survived: the schema's "no fields to update" refine.
            (None, false) => Err(()),
        }
    }
}

/// The `PATCH /api/workspaces/{id}/archive` body: a required `archived: boolean`,
/// exactly as `ArchiveWorkspaceInputSchema`. A missing key or a non-boolean is a
/// native decode fault (no semantic arm), so this route has no `422 invalid input`
/// path of its own.
#[derive(Debug, Deserialize)]
struct WorkspaceArchiveRaw {
    archived: bool,
}

/// Success body: `{ "workspace": {ViewerWorkspaceDto} }`, mirroring
/// `c.json({ workspace: toViewerWorkspace(updated) })`. The workspace shape is the
/// crate's one canonical [`ViewerWorkspaceDto`](crate::workspaces::ViewerWorkspaceDto).
#[derive(Serialize)]
struct WorkspaceMutationResponse {
    workspace: ViewerWorkspaceDto,
}

/// The flat refusal body, `{ "error": ... }`.
#[derive(Serialize)]
struct ErrorBody {
    error: &'static str,
}

fn ok_workspace(face: &WorkspaceFace) -> Response {
    Json(WorkspaceMutationResponse {
        workspace: ViewerWorkspaceDto::from(face),
    })
    .into_response()
}

fn not_found() -> Response {
    (
        StatusCode::NOT_FOUND,
        Json(ErrorBody {
            error: WORKSPACE_NOT_FOUND,
        }),
    )
        .into_response()
}

fn forbidden() -> Response {
    (StatusCode::FORBIDDEN, Json(ErrorBody { error: FORBIDDEN })).into_response()
}

fn name_taken() -> Response {
    (StatusCode::CONFLICT, Json(ErrorBody { error: NAME_TAKEN })).into_response()
}

fn internal_error() -> Response {
    (StatusCode::INTERNAL_SERVER_ERROR, INTERNAL_ERROR_BODY).into_response()
}
