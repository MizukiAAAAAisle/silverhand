//! The regular-workspace METADATA write surface:
//! `PATCH /api/workspaces/{id}` (rename + description) and
//! `PATCH /api/workspaces/{id}/archive`.
//!
//! Both routes are thin transports over the write context in
//! [`silverhand_backend_core::workspace_metadata_write`]: the domain owns the
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
//! ## Refusal ORDERING is a product contract
//!
//! The TypeScript route answers, in this exact order:
//! `404` (absent workspace / agent-home) → `403` (governance floor) →
//! `400` (body shape) → `409` (name collision) → `200`. The `403`-BEFORE-`400`
//! rung is why this surface reads the caller's governance facts and applies the
//! floor ([`governance_floor_verdict`]) with a PRE-LOCK
//! [`WorkspaceGovernanceFactsRead`] BEFORE it parses the body: a caller without
//! standing must not be able to probe body shape. Rename requires the `Admin`
//! floor, archive the `Owner` floor — a distinction the collapsed governance
//! ceiling cannot express, so the floor door is used, not the ceiling.
//!
//! The body is READ only after the floor passes: the handler takes a `Request`
//! (not the eager `Bytes` extractor) and drains it once the caller is known to
//! govern the workspace, so a `404`/`403` caller never has their body buffered.
//! This surface imposes NO size cap of its own — a body-size perimeter (and any
//! `413`) is an application-wide policy applied by `DefaultBodyLimit` at the mount
//! seam, exactly like the production `viewer_workspaces_changed` sink is; the
//! product route itself has no limit, so the leaf inventing a narrower one would be
//! an unauthorized regression. The order is therefore `404 → 403 → 400 → 409 →
//! 200`, matching the TypeScript route (which also reads the body after the floor).
//!
//! That pre-lock verdict can go stale (a demotion may commit in the seam before
//! the write lock). Guarding that is the WRITE's job: the domain re-derives the
//! caller's authority under its own lock and can still answer `403`/`404`. Those
//! late refusals are unreachable for a single-threaded client but are surfaced
//! faithfully; they never change the answer for any input the pre-lock door
//! already graded.
//!
//! ## The `400` body reproduces the Zod issues byte-for-byte
//!
//! Unlike `GET /name-availability` (which collapses every name refusal to one
//! `invalid`), this surface publishes the refusal PRECEDENCE on the wire: the
//! `400` body is `{ error: "invalid input", issues: [...] }`, and the issue
//! `code` distinguishes an empty name (`too_small`) from an over-long one
//! (`too_big`) from a forbidden scalar (`custom`) from an empty edit
//! (`custom` "no fields to update"). A client can branch on that code, so it is
//! part of the contract, not a library-internal detail — the ordered
//! [`CanonicalWorkspaceName::parse`] exists precisely to make it observable.
//!
//! The [`wire`] submodule therefore reproduces the Zod 3 issue objects — the
//! issue `code`, the per-code field set, the field values, and the issues-ARRAY
//! order (a multi-field body reports `name` before `description`) — that
//! `UpdateWorkspaceInputSchema` / `ArchiveWorkspaceInputSchema` emit. This is a
//! deliberate compatibility projection at the transport boundary, NOT structural
//! transliteration of Zod, and it is pinned by the shared cross-language parity
//! fixture (`packages/backend/tests/fixtures/workspace-metadata-write/`) whose
//! expected bodies are signed by the real Zod oracle first. The gate compares
//! STRUCTURALLY: JSON object member order is semantically insignificant
//! (RFC 8259), so a conformant client cannot observe it, and neither the TS
//! oracle (`toEqual`) nor the Rust replay (`Value` equality) asserts it. The
//! struct field declaration order below follows Zod's real emission only so the
//! served bytes read naturally; it is cosmetic, not the contract. What IS the
//! contract — codes, values, and array order — is what both halves verify.
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
    body::{Bytes, to_bytes},
    extract::{Extension, Path, Request, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::patch,
};
use std::future::Future;

use serde::Serialize;
use serde_json::Value;
use silverhand_backend_core::access::WorkspaceGovernanceFloor;
use silverhand_backend_core::{
    access::{WorkspaceGovernanceFactsRead, WorkspaceRole, governance_floor_verdict},
    identity::{Principal, UserId, WorkspaceId},
    workspace_face::WorkspaceFace,
    workspace_metadata_write::{
        WorkspaceArchiveUpdate, WorkspaceMetadataAnnounce, WorkspaceMetadataChangedSink,
        WorkspaceMetadataUpdateWithAnnounce, WorkspaceMetadataWriteUnitOfWork, WorkspaceNameChange,
        archive_workspace, update_workspace_metadata_and_announce,
    },
};

use crate::error;
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

    // Body read is DEFERRED past the floor (no endpoint-imposed size cap; any
    // application-wide body-size perimeter is a mount-seam policy).
    let body = read_body(request).await;
    let edit = match wire::parse_update_body(&parse_json_or_empty(&body)) {
        Ok(edit) => edit,
        Err(issues) => return invalid_input(issues),
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

    // Body read is DEFERRED past the floor (no endpoint-imposed size cap).
    let body = read_body(request).await;
    let archived = match wire::parse_archive_body(&parse_json_or_empty(&body)) {
        Ok(archived) => archived,
        Err(issues) => return invalid_input(issues),
    };

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

/// Drain the request body into memory, DEFERRED past the governance floor so an
/// unauthorized (`404`/`403`) caller never has their body buffered. No
/// endpoint-specific size cap is imposed here — an application-wide body-size
/// perimeter is a mount-seam concern (a `DefaultBodyLimit` layer over the served
/// app), never a limit this component-complete leaf invents. A body-stream read
/// failure folds to an empty body, mirroring the product's
/// `await c.req.json().catch(() => ({}))` (which swallows any read failure into an
/// empty object), so the schema then reports "no fields to update" rather than the
/// leaf surfacing a transport error as a bespoke status.
async fn read_body(request: Request) -> Bytes {
    to_bytes(request.into_body(), usize::MAX)
        .await
        .unwrap_or_default()
}

/// Read the request body as JSON, mirroring the product's
/// `await c.req.json().catch(() => ({}))`: an empty or unparseable body becomes an
/// empty object (which the update schema refuses as "no fields to update" and the
/// archive schema refuses as a missing `archived`). A well-formed but non-object
/// JSON value is returned verbatim so the schema reports the root type mismatch.
fn parse_json_or_empty(body: &Bytes) -> Value {
    if body.is_empty() {
        return Value::Object(serde_json::Map::new());
    }
    serde_json::from_slice(body).unwrap_or_else(|_| Value::Object(serde_json::Map::new()))
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

fn invalid_input(issues: Vec<wire::ZodIssue>) -> Response {
    (
        StatusCode::BAD_REQUEST,
        Json(wire::InvalidInputBody {
            error: "invalid input",
            issues,
        }),
    )
        .into_response()
}

fn internal_error() -> Response {
    (StatusCode::INTERNAL_SERVER_ERROR, INTERNAL_ERROR_BODY).into_response()
}

/// The Zod-3 issue compatibility projection for the `400` body.
///
/// This reproduces the issue objects `UpdateWorkspaceInputSchema` and
/// `ArchiveWorkspaceInputSchema` emit — the `code`, the per-code field set, the
/// values, and the issues-array order. The struct field declaration order also
/// follows Zod's real emission (`custom`/`too_small`/`too_big` put `message`
/// before `path`; `invalid_type` puts it after) so the served bytes read
/// naturally, but that ordering is cosmetic: JSON object member order is
/// insignificant (RFC 8259) and the shared parity fixture pins these bodies
/// structurally, against the real Zod oracle.
mod wire {
    use serde::Serialize;
    use serde_json::Value;
    use silverhand_backend_core::workspace_metadata_write::WorkspaceMetadataEdit;
    use silverhand_backend_core::workspace_name::{
        CanonicalWorkspaceName, MAX_CODE_POINTS, WorkspaceNameIssue,
    };

    /// `{ error: "invalid input", issues: [...] }`.
    #[derive(Serialize)]
    pub(super) struct InvalidInputBody {
        pub(super) error: &'static str,
        pub(super) issues: Vec<ZodIssue>,
    }

    /// One Zod issue. Untagged so each arm serializes as its own object with its
    /// own field order; the `code` string lives inside each arm's struct.
    #[derive(Serialize)]
    #[serde(untagged)]
    pub(super) enum ZodIssue {
        Custom(CustomIssue),
        TooSmall(TooSmallIssue),
        TooBig(TooBigIssue),
        InvalidType(InvalidTypeIssue),
    }

    #[derive(Serialize)]
    pub(super) struct CustomIssue {
        code: &'static str,
        message: String,
        path: Vec<&'static str>,
    }

    #[derive(Serialize)]
    pub(super) struct TooSmallIssue {
        code: &'static str,
        minimum: i64,
        #[serde(rename = "type")]
        kind: &'static str,
        inclusive: bool,
        message: String,
        path: Vec<&'static str>,
    }

    #[derive(Serialize)]
    pub(super) struct TooBigIssue {
        code: &'static str,
        maximum: i64,
        #[serde(rename = "type")]
        kind: &'static str,
        inclusive: bool,
        message: String,
        path: Vec<&'static str>,
    }

    #[derive(Serialize)]
    pub(super) struct InvalidTypeIssue {
        code: &'static str,
        expected: &'static str,
        received: &'static str,
        path: Vec<&'static str>,
        message: String,
    }

    fn custom(message: impl Into<String>, path: Vec<&'static str>) -> ZodIssue {
        ZodIssue::Custom(CustomIssue {
            code: "custom",
            message: message.into(),
            path,
        })
    }

    fn too_small(message: impl Into<String>, path: Vec<&'static str>) -> ZodIssue {
        ZodIssue::TooSmall(TooSmallIssue {
            code: "too_small",
            minimum: 1,
            kind: "string",
            inclusive: true,
            message: message.into(),
            path,
        })
    }

    fn too_big(message: impl Into<String>, path: Vec<&'static str>) -> ZodIssue {
        ZodIssue::TooBig(TooBigIssue {
            code: "too_big",
            maximum: MAX_CODE_POINTS as i64,
            kind: "string",
            inclusive: true,
            message: message.into(),
            path,
        })
    }

    /// Zod's `getParsedType` for the value actually present: the `received` label
    /// on an `invalid_type` issue. A missing key is `"undefined"` and is handled
    /// by the caller, since it has no `Value` to inspect.
    fn parsed_type(value: &Value) -> &'static str {
        match value {
            Value::Null => "null",
            Value::Bool(_) => "boolean",
            Value::Number(_) => "number",
            Value::String(_) => "string",
            Value::Array(_) => "array",
            Value::Object(_) => "object",
        }
    }

    fn invalid_type(
        expected: &'static str,
        received: &'static str,
        message: impl Into<String>,
        path: Vec<&'static str>,
    ) -> ZodIssue {
        ZodIssue::InvalidType(InvalidTypeIssue {
            code: "invalid_type",
            expected,
            received,
            path,
            message: message.into(),
        })
    }

    /// The name-refusal issue for a value at `path`, mirroring
    /// `WorkspaceNameSchema`'s three `ctx.addIssue` arms.
    fn name_issue(issue: WorkspaceNameIssue) -> ZodIssue {
        match issue {
            WorkspaceNameIssue::Empty => {
                too_small("workspace name must not be empty", vec!["name"])
            }
            WorkspaceNameIssue::TooLong { .. } => too_big(
                format!("workspace name must be at most {MAX_CODE_POINTS} characters"),
                vec!["name"],
            ),
            WorkspaceNameIssue::ForbiddenCodePoint { .. } => custom(
                "workspace name contains a character that is not addressable",
                vec!["name"],
            ),
        }
    }

    /// Validate the body of `PATCH /api/workspaces/{id}` exactly as
    /// `UpdateWorkspaceInputSchema` does: `name?` is a `WorkspaceNameSchema`,
    /// `description?` is `string | null`, and at least one field must be present.
    /// A field-shape issue aborts the object (Zod skips the `refine` on invalid
    /// data), so a wrong-typed field never also reports "no fields to update".
    pub(super) fn parse_update_body(body: &Value) -> Result<WorkspaceMetadataEdit, Vec<ZodIssue>> {
        let Value::Object(object) = body else {
            // A well-formed non-object JSON value: the root type mismatch, exactly
            // as `z.object` reports it before any field is read.
            return Err(vec![invalid_type(
                "object",
                parsed_type(body),
                format!("Expected object, received {}", parsed_type(body)),
                vec![],
            )]);
        };

        let mut issues = Vec::new();

        // Field order mirrors the schema declaration: `name`, then `description`.
        let mut name: Option<CanonicalWorkspaceName> = None;
        let name_present = object.contains_key("name");
        if let Some(raw) = object.get("name") {
            match raw {
                Value::String(text) => match CanonicalWorkspaceName::parse(text) {
                    Ok(parsed) => name = Some(parsed),
                    Err(issue) => issues.push(name_issue(issue)),
                },
                other => issues.push(invalid_type(
                    "string",
                    parsed_type(other),
                    format!("Expected string, received {}", parsed_type(other)),
                    vec!["name"],
                )),
            }
        }

        let description_present = object.contains_key("description");
        let mut description: Option<String> = None;
        if let Some(raw) = object.get("description") {
            match raw {
                // `z.string().nullable()`: a string sets it, `null` clears it.
                Value::String(text) => description = Some(text.clone()),
                Value::Null => description = None,
                other => issues.push(invalid_type(
                    "string",
                    parsed_type(other),
                    format!("Expected string, received {}", parsed_type(other)),
                    vec!["description"],
                )),
            }
        }

        if !issues.is_empty() {
            return Err(issues);
        }

        // The object parsed; now the `refine`. `description: null` counts as a
        // present field, so it clears rather than fails the "no fields" gate.
        match (name, name_present, description_present) {
            (Some(name), _, true) => {
                Ok(WorkspaceMetadataEdit::NameAndDescription { name, description })
            }
            (Some(name), _, false) => Ok(WorkspaceMetadataEdit::Name(name)),
            (None, false, true) => Ok(WorkspaceMetadataEdit::Description(description)),
            // No field survived: the `refine` message, at the root path.
            (None, _, false) => Err(vec![custom("no fields to update", vec![])]),
            // `name` present but unparsed is impossible here: a name issue would
            // have returned above. Kept exhaustive without a fabricated arm.
            (None, true, true) => Ok(WorkspaceMetadataEdit::Description(description)),
        }
    }

    /// Validate the body of `PATCH /api/workspaces/{id}/archive` exactly as
    /// `ArchiveWorkspaceInputSchema` does: a required `archived: boolean`.
    pub(super) fn parse_archive_body(body: &Value) -> Result<bool, Vec<ZodIssue>> {
        let Value::Object(object) = body else {
            return Err(vec![invalid_type(
                "object",
                parsed_type(body),
                format!("Expected object, received {}", parsed_type(body)),
                vec![],
            )]);
        };

        match object.get("archived") {
            Some(Value::Bool(archived)) => Ok(*archived),
            // A missing required key is Zod's `received: "undefined"`, message
            // "Required".
            None => Err(vec![invalid_type(
                "boolean",
                "undefined",
                "Required",
                vec!["archived"],
            )]),
            Some(other) => Err(vec![invalid_type(
                "boolean",
                parsed_type(other),
                format!("Expected boolean, received {}", parsed_type(other)),
                vec!["archived"],
            )]),
        }
    }
}

/// Rust half of the cross-language admission (400) parity gate: the SAME
/// `admission-cases.json` the TS oracle
/// (`packages/backend/tests/workspace-metadata-write-admission-parity.test.ts`)
/// signs against the real Zod schemas is replayed here through the production
/// `wire` projection. Each `input` body is parsed, expected to refuse, and the
/// built `400` envelope is asserted equal to the shared `expected`. The
/// comparison is structural (`serde_json::Value` equality), which preserves the
/// contractual issues-ARRAY order while ignoring insignificant object member
/// order — exactly the equality the TS `toEqual` oracle applies.
#[cfg(test)]
mod admission_parity {
    use super::wire::{self, InvalidInputBody, ZodIssue};
    use serde_json::{Value, json};

    const ADMISSION_CASES: &str = include_str!(
        "../../../../packages/backend/tests/fixtures/workspace-metadata-write/admission-cases.json"
    );

    /// Project a refusal into the exact `400` body the route serves.
    fn envelope(issues: Vec<ZodIssue>) -> Value {
        serde_json::to_value(InvalidInputBody {
            error: "invalid input",
            issues,
        })
        .expect("the invalid-input body serializes")
    }

    #[test]
    fn the_wire_projection_matches_the_shared_update_envelopes() {
        let fixture: Value = serde_json::from_str(ADMISSION_CASES).unwrap();
        let cases = fixture["update"].as_array().expect("update cases");
        assert!(!cases.is_empty(), "the fixture must carry update cases");
        for case in cases {
            let name = case["name"].as_str().unwrap();
            let issues = wire::parse_update_body(&case["input"])
                .err()
                .unwrap_or_else(|| panic!("{name}: every admission case must refuse"));
            assert_eq!(envelope(issues), case["expected"], "{name}");
        }
    }

    #[test]
    fn the_wire_projection_matches_the_shared_archive_envelopes() {
        let fixture: Value = serde_json::from_str(ADMISSION_CASES).unwrap();
        let cases = fixture["archive"].as_array().expect("archive cases");
        assert!(!cases.is_empty(), "the fixture must carry archive cases");
        for case in cases {
            let name = case["name"].as_str().unwrap();
            let issues = wire::parse_archive_body(&case["input"])
                .err()
                .unwrap_or_else(|| panic!("{name}: every admission case must refuse"));
            assert_eq!(envelope(issues), case["expected"], "{name}");
        }
    }

    /// Project an ACCEPTED update edit onto the impl-neutral shape the TS oracle
    /// signs: `name` is null or the transform's `{name, key}` display+fold pair,
    /// `description` is the tri-state `"untouched"` / `"clear"` / `{ "set": .. }`.
    fn project_update(
        edit: &silverhand_backend_core::workspace_metadata_write::WorkspaceMetadataEdit,
    ) -> Value {
        let name = match edit.requested_name() {
            Some(n) => json!({ "name": n.name(), "key": n.key() }),
            None => Value::Null,
        };
        let description = match edit.requested_description() {
            None => json!("untouched"),
            Some(None) => json!("clear"),
            Some(Some(text)) => json!({ "set": text }),
        };
        json!({ "name": name, "description": description })
    }

    #[test]
    fn the_wire_projection_matches_the_shared_admitted_update_edits() {
        let fixture: Value = serde_json::from_str(ADMISSION_CASES).unwrap();
        let cases = fixture["admitted_update"]
            .as_array()
            .expect("admitted update cases");
        assert!(
            !cases.is_empty(),
            "the fixture must carry admitted update cases"
        );
        for case in cases {
            let name = case["name"].as_str().unwrap();
            let edit = wire::parse_update_body(&case["input"])
                .unwrap_or_else(|_| panic!("{name}: every admitted case must parse"));
            assert_eq!(project_update(&edit), case["expected"], "{name}");
        }
    }

    #[test]
    fn the_wire_projection_matches_the_shared_admitted_archive_flags() {
        let fixture: Value = serde_json::from_str(ADMISSION_CASES).unwrap();
        let cases = fixture["admitted_archive"]
            .as_array()
            .expect("admitted archive cases");
        assert!(
            !cases.is_empty(),
            "the fixture must carry admitted archive cases"
        );
        for case in cases {
            let name = case["name"].as_str().unwrap();
            let archived = wire::parse_archive_body(&case["input"])
                .unwrap_or_else(|_| panic!("{name}: every admitted case must parse"));
            assert_eq!(Value::Bool(archived), case["expected"], "{name}");
        }
    }
}
