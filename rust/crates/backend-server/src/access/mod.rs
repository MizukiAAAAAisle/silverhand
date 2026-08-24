//! Agent workspace-enrollment HTTP surface (product parity).
//!
//! Two authorization doors stay separate and ordered here, exactly as in the
//! TypeScript route. The **request-boundary door**
//! ([`WorkspaceAccessPolicy`](silverhand_backend_core::access::WorkspaceAccessPolicy))
//! resolves the workspace and the caller's role floor and answers *before the
//! body is even validated*, so a non-member cannot probe input shape. Only when
//! it admits does the **application door** run — agent existence, then
//! creator-ownership, then the atomic write — inside
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
    body::Bytes,
    extract::{Path, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::post,
};
use silverhand_backend_core::access::{
    AddAgentMemberError, AddHumanMemberError, AgentEnrollmentReadPort, AgentEnrollmentUnitOfWork,
    EnrollmentClock, HumanEnrollmentReadPort, HumanEnrollmentUnitOfWork, Principal,
    ViewerWorkspacesChangedSink, WorkspaceAccessPolicy, WorkspaceGovernance,
    add_workspace_agent_member, add_workspace_human_member,
};
use silverhand_backend_core::identity::{AgentId, UserId, WorkspaceId};
use silverhand_backend_core::persistence::PersistenceFailure;

use crate::error;
use wire::{
    AGENT_NOT_FOUND, AGENT_NOT_OWNED_CODE, AGENT_NOT_OWNED_MESSAGE, AddMemberRequest,
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
/// The body is taken as raw bytes and parsed only after the boundary door
/// admits, so the member floor still answers a non-member before input is
/// validated. The caller's identity is the single `UserId` the human-session
/// perimeter injected; this handler turns it into the application
/// [`Principal`], which is therefore always `Principal::Human` on this route.
/// Its absence means the route was composed without that perimeter — a
/// composition fault, so it takes the lane's safe `500` rather than an extractor
/// rejection that would masquerade as a product answer.
async fn add_member<P, A, S, C>(
    Path(workspace_id): Path<String>,
    viewer: Option<Extension<UserId>>,
    State(state): State<AccessState<P, A, S, C>>,
    body: Bytes,
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
    // parsed: `Member` and `Admin` both clear it. A policy persistence failure
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

    let Some(request) = AddMemberRequest::from_body(&body) else {
        return Ok(refusal(StatusCode::BAD_REQUEST, INVALID_INPUT, None));
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
        Ok(member) => Ok((
            StatusCode::CREATED,
            Json(AddWorkspaceHumanMemberResponse::build(&user, member)),
        )
            .into_response()),
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
            AccessError::MissingPrincipal => tracing::error!(
                "workspace member route reached without its human principal fact"
            ),
            AccessError::Persistence(cause) => tracing::error!(
                error_chain = %error::describe(&cause),
                "request failed at the persistence boundary"
            ),
        }
        (StatusCode::INTERNAL_SERVER_ERROR, INTERNAL_ERROR_BODY).into_response()
    }
}
