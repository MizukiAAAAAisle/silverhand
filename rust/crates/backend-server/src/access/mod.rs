//! Agent workspace-enrollment HTTP surface (product parity).
//!
//! Two authorization doors stay separate and ordered here, exactly as in the
//! TypeScript route. The **request-boundary door**
//! ([`WorkspaceAccessPolicy`](silverhand_backend_core::access::WorkspaceAccessPolicy))
//! runs FIRST, before the body is decoded: it resolves the workspace and the
//! caller's role floor and answers a non-member (`403`) or an unknown workspace
//! (`404`) without the body being buffered, so a caller without standing cannot
//! probe the body's shape or which product arm it would select. Only when the
//! floor admits is the body decoded — through the shared
//! [`ObjectOnly<T>`](crate::wire_admission::ObjectOnly) object floor via a
//! DEFERRED `Json` extraction — so a structurally malformed / wrong-shaped
//! (top-level array/scalar/null) / wrong-typed body keeps its native framework
//! rejection, and only then does the **application door** run — agent existence,
//! then creator-ownership, then the atomic write — inside
//! [`add_workspace_agent_member`]. The order is observable through the ports and
//! pinned by the contract test.
//!
//! There is exactly ONE authentication perimeter in front of this route: the
//! human session layer, which injects the sole core-wide [`UserId`]. The agent and
//! human arms below are *product branches* over the request body, not a second
//! credential kind — so this slice reads that one identity and constructs the
//! application [`Principal`] itself rather than trusting a principal from the wire.
//!
//! Persistence failures are not rendered by the routes. A handler surfaces one
//! as [`AccessError`] and renders nothing itself; that error's `IntoResponse` is
//! the lane's single top-level seam — the one place that logs the failure's full
//! source chain exactly once and returns the product's safe `500`. Typed product
//! refusals (`400`/`403`/`404`) are not failures and are returned directly.

pub mod wire;

use axum::{
    Extension, Json, Router,
    extract::{FromRequest, Path, Request, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::post,
};
use silverhand_backend_core::access::{
    AddAgentMemberError, AddHumanMemberError, AgentEnrollmentReadPort, AgentEnrollmentUnitOfWork,
    EnrollmentClock, HumanEnrollmentReadPort, HumanEnrollmentUnitOfWork, ViewerAnnounce,
    ViewerWorkspacesChangedSink, WorkspaceAccessPolicy, WorkspaceGovernance,
    add_workspace_agent_member, add_workspace_human_member,
};
use silverhand_backend_core::identity::{AgentId, Principal, UserId, WorkspaceId};
use silverhand_backend_core::persistence::PersistenceFailure;

use crate::error;
use crate::wire_admission::ObjectOnly;
use wire::{
    AGENT_NOT_FOUND, AGENT_NOT_OWNED_CODE, AGENT_NOT_OWNED_MESSAGE, AddMemberRaw, AddMemberRequest,
    AddWorkspaceAgentMemberResponse, AddWorkspaceHumanMemberResponse, ErrorBody, FORBIDDEN,
    INTERNAL_ERROR_BODY, INVALID_INPUT, USER_NOT_FOUND, WORKSPACE_MEMBERS_PATH,
    WORKSPACE_NOT_FOUND, WorkspaceMemberDto,
};

#[derive(Clone)]
struct AccessState<P, A, S, C> {
    policy: P,
    access: A,
    sink: S,
    clock: C,
}

/// Mounts the enrollment route. Generic over the boundary policy, the enrollment
/// access adapter (which implements the agent and human read + unit-of-work
/// ports), the viewer-workspaces sink and the clock, so tests drive it with
/// driver-free fakes and the composition root wires the real adapters.
///
/// Route registration into the served application, and the real event-bus sink
/// behind [`ViewerWorkspacesChangedSink`], are separate integration seams; this
/// builder yields the access routes on their own.
pub fn router<P, A, S, C>(policy: P, access: A, sink: S, clock: C) -> Router
where
    P: WorkspaceAccessPolicy,
    A: AgentEnrollmentReadPort
        + AgentEnrollmentUnitOfWork
        + HumanEnrollmentReadPort
        + HumanEnrollmentUnitOfWork,
    S: ViewerWorkspacesChangedSink,
    C: EnrollmentClock,
{
    Router::new()
        .route(WORKSPACE_MEMBERS_PATH, post(add_member::<P, A, S, C>))
        .with_state(AccessState {
            policy,
            access,
            sink,
            clock,
        })
}

/// `POST /api/workspaces/{id}/members` for an agent or human member.
///
/// The governance FLOOR runs BEFORE the body is decoded: the handler takes an
/// owned `Request` and resolves the workspace and the caller's role floor first,
/// so a non-member (`403`) or an unknown workspace (`404`) is answered without the
/// body ever being buffered or decoded — a caller without standing cannot probe
/// the body's shape or which product arm it would select, whether the body is
/// malformed, a top-level array, or a valid object. Only once the floor admits is
/// the body decoded through the shared [`ObjectOnly<T>`] object floor via a
/// DEFERRED `Json::<ObjectOnly<AddMemberRaw>>::from_request`, which keeps the
/// native structural rejections (malformed → `400`, wrong-type / wrong-shape —
/// including a top-level array a derived struct visitor would fill positionally —
/// / duplicate-key → `422`, missing Content-Type → `415`). A structurally valid
/// body that matches no product arm is then the minimal semantic `422`. The
/// caller's identity is the single `UserId` the human-session perimeter injected;
/// this handler turns it into the application [`Principal`], always
/// `Principal::Human` on this route. Its absence means the route was composed
/// without that perimeter — a composition fault, so it takes the lane's safe
/// `500`.
///
/// [`ObjectOnly<T>`]: crate::wire_admission::ObjectOnly
async fn add_member<P, A, S, C>(
    Path(workspace_id): Path<String>,
    viewer: Option<Extension<UserId>>,
    State(state): State<AccessState<P, A, S, C>>,
    request: Request,
) -> Result<Response, AccessError>
where
    P: WorkspaceAccessPolicy,
    A: AgentEnrollmentReadPort
        + AgentEnrollmentUnitOfWork
        + HumanEnrollmentReadPort
        + HumanEnrollmentUnitOfWork,
    S: ViewerWorkspacesChangedSink,
    C: EnrollmentClock,
{
    let Some(Extension(user_id)) = viewer else {
        return Err(AccessError::MissingPrincipal);
    };
    let principal = Principal::Human { user_id };

    // An id the domain refuses cannot name a workspace, so it earns the same
    // `404` the lookup would — decided without a policy round-trip. The product
    // accepts the empty string as *input* (it is a plain string on the wire) and
    // answers "not found"; only a stored id that cannot be parsed is corruption.
    let Ok(workspace_id) = WorkspaceId::parse(workspace_id) else {
        return Ok(refusal(StatusCode::NOT_FOUND, WORKSPACE_NOT_FOUND, None));
    };

    // The member FLOOR, common to both branches, answers before the body is
    // decoded: `Member` and `Admin` both clear it. A policy persistence failure
    // is surfaced to the single error seam, never rendered here.
    let governance = state
        .policy
        .authorize_member_governance(&principal, &workspace_id)
        .await?;
    match governance {
        WorkspaceGovernance::WorkspaceNotFound => {
            return Ok(refusal(StatusCode::NOT_FOUND, WORKSPACE_NOT_FOUND, None));
        }
        WorkspaceGovernance::Denied => {
            return Ok(refusal(StatusCode::FORBIDDEN, FORBIDDEN, None));
        }
        WorkspaceGovernance::Member | WorkspaceGovernance::Admin => {}
    }

    // Body decode is DEFERRED past the floor: a `404`/`403` caller is answered
    // above without their body ever being buffered, so the ratified
    // floor-before-body ordering (a non-member cannot probe the body verdict) is
    // preserved. Only once the floor admits does the shared `ObjectOnly<T>` map
    // floor + native `Json` own the structural rejections (a top-level array is a
    // native `422`, never a positionally-classified enrollment).
    let raw = match Json::<ObjectOnly<AddMemberRaw>>::from_request(request, &()).await {
        Ok(Json(ObjectOnly(raw))) => raw,
        Err(rejection) => return Ok(rejection.into_response()),
    };

    // Only a structurally valid object reaches here. A body no product arm accepts
    // is the minimal semantic refusal `422`.
    let Ok(request) = AddMemberRequest::try_from(raw) else {
        return Ok(refusal(
            StatusCode::UNPROCESSABLE_ENTITY,
            INVALID_INPUT,
            None,
        ));
    };

    match request {
        AddMemberRequest::Agent { agent_id } => {
            add_agent_member(&state, &principal, workspace_id, agent_id).await
        }
        AddMemberRequest::Human { user_id } => {
            // The people roster is `admin` governance — a pure comparison against
            // the ceiling already read, so a plain member is refused here without
            // a second policy round-trip. The in-lock re-derivation in the unit
            // of work is a separate, concurrency door and may still refuse.
            if governance != WorkspaceGovernance::Admin {
                return Ok(refusal(StatusCode::FORBIDDEN, FORBIDDEN, None));
            }
            add_human_member(&state, &principal, workspace_id, user_id).await
        }
    }
}

async fn add_agent_member<P, A, S, C>(
    state: &AccessState<P, A, S, C>,
    principal: &Principal,
    workspace_id: WorkspaceId,
    agent_id: String,
) -> Result<Response, AccessError>
where
    A: AgentEnrollmentReadPort + AgentEnrollmentUnitOfWork,
    C: EnrollmentClock,
{
    // An id the domain refuses cannot name an agent, so it earns the same exact
    // `404` a lookup miss earns — and, because the refusal is decided here, the
    // read port and the unit of work are never entered. The product accepts
    // `{"agent_id": ""}` as a *classified* body, so this is a `404`, not a `400`.
    let Ok(agent_id) = AgentId::parse(agent_id) else {
        return Ok(refusal(StatusCode::NOT_FOUND, AGENT_NOT_FOUND, None));
    };

    match add_workspace_agent_member(
        &state.access,
        &state.access,
        &state.clock,
        principal,
        workspace_id,
        agent_id,
    )
    .await
    {
        Ok(member) => Ok((
            StatusCode::CREATED,
            Json(AddWorkspaceAgentMemberResponse {
                member: WorkspaceMemberDto::from(member),
            }),
        )
            .into_response()),
        Err(AddAgentMemberError::AgentNotFound) => {
            Ok(refusal(StatusCode::NOT_FOUND, AGENT_NOT_FOUND, None))
        }
        Err(AddAgentMemberError::AgentNotOwned) => Ok(refusal(
            StatusCode::FORBIDDEN,
            AGENT_NOT_OWNED_MESSAGE,
            Some(AGENT_NOT_OWNED_CODE),
        )),
        Err(AddAgentMemberError::Persistence(cause)) => Err(AccessError::from(cause)),
    }
}

async fn add_human_member<P, A, S, C>(
    state: &AccessState<P, A, S, C>,
    principal: &Principal,
    workspace_id: WorkspaceId,
    user_id: String,
) -> Result<Response, AccessError>
where
    A: HumanEnrollmentReadPort + HumanEnrollmentUnitOfWork,
    S: ViewerWorkspacesChangedSink,
    C: EnrollmentClock,
{
    let Ok(user_id) = UserId::parse(user_id) else {
        // Same rule as the agent arm: the body classified, so an id the domain
        // refuses is "no such user" — answered before the read port is entered.
        return Ok(refusal(StatusCode::NOT_FOUND, USER_NOT_FOUND, None));
    };

    // User existence is a read: "no such user" is a `404` that must not take a
    // write lock, so it is resolved before the unit of work. A read persistence
    // failure is surfaced to the single error seam.
    let user = match state.access.user(&user_id).await {
        Ok(Some(user)) => user,
        Ok(None) => return Ok(refusal(StatusCode::NOT_FOUND, USER_NOT_FOUND, None)),
        Err(cause) => return Err(AccessError::from(cause)),
    };

    match add_workspace_human_member(
        &state.access,
        &state.sink,
        &state.clock,
        principal,
        workspace_id,
        user_id,
    )
    .await
    {
        Ok(outcome) => {
            // The enrollment is committed and answers `201` no matter what became of
            // the announce — but the loss is not swallowed. `into_parts` is the only
            // door into the outcome, so taking the member here necessarily hands us
            // the announce in the same move. This boundary owns observability, so the
            // announce is matched EXHAUSTIVELY (no `_` arm): a future new
            // `ViewerAnnounce` arm breaks this build instead of being silently
            // ignored.
            let (member, announce) = outcome.into_parts();
            match announce {
                // The only case that leaves a client stale: render the whole cause
                // chain exactly once, here, and nowhere else.
                ViewerAnnounce::Failed(cause) => tracing::error!(
                    error_chain = %error::describe(&cause),
                    "the new workspace membership was committed but its viewer announce was lost"
                ),
                // Both silent. `NotOwed` is silent BY CONSTRUCTION: a re-enrollment
                // created nothing, so there is no lost notification to report and an
                // "announce skipped" line would be noise indistinguishable from a real
                // loss in a log search. `Delivered` needs no line either.
                ViewerAnnounce::Delivered | ViewerAnnounce::NotOwed => {}
            }
            Ok((
                StatusCode::CREATED,
                Json(AddWorkspaceHumanMemberResponse::build(&user, member)),
            )
                .into_response())
        }
        // The route gate refused a non-admin already; a `Forbidden` from here is
        // the in-lock re-derivation catching authority lost in the seam.
        Err(AddHumanMemberError::Forbidden) => Ok(refusal(StatusCode::FORBIDDEN, FORBIDDEN, None)),
        Err(AddHumanMemberError::Persistence(cause)) => Err(AccessError::from(cause)),
    }
}

fn refusal(status: StatusCode, message: &str, code: Option<&str>) -> Response {
    (
        status,
        Json(ErrorBody {
            error: message.to_owned(),
            code: code.map(str::to_owned),
        }),
    )
        .into_response()
}

/// The lane's single top-level error seam. A route surfaces an unexpected
/// failure as this type and renders nothing itself; this is the one place that
/// logs it — once, with its full source chain — and answers with the product's
/// safe `500`.
///
/// The body matches the product default exactly: a bare `text/plain`
/// `Internal Server Error`, never a JSON envelope, and no driver detail reaches
/// it. Only failures travel this path; every expected product outcome (including
/// the typed `400`/`403`/`404` refusals) is a normal [`Response`] returned from
/// the handler, so it is never logged as an error.
#[derive(Debug)]
enum AccessError {
    /// The route ran without the identity the authentication perimeter must
    /// inject. Nothing about the request is wrong — the router is — so it is
    /// logged as the wiring fault it is and answered with the same safe `500`
    /// rather than a product refusal that would hide the misconfiguration.
    MissingPrincipal,
    Persistence(PersistenceFailure),
}

impl From<PersistenceFailure> for AccessError {
    fn from(cause: PersistenceFailure) -> Self {
        Self::Persistence(cause)
    }
}

impl IntoResponse for AccessError {
    fn into_response(self) -> Response {
        match self {
            AccessError::MissingPrincipal => {
                tracing::error!("workspace member route reached without its human principal fact")
            }
            AccessError::Persistence(cause) => tracing::error!(
                error_chain = %error::describe(&cause),
                "request failed at the persistence boundary"
            ),
        }
        (StatusCode::INTERNAL_SERVER_ERROR, INTERNAL_ERROR_BODY).into_response()
    }
}
