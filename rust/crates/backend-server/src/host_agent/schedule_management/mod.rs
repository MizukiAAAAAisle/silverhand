//! Schedule-management routes — a submodule of the public-agent management
//! plane (`host_agent`). Two faces over an agent's own schedules:
//!
//!  - `GET  /api/agents/{id}/schedules` — the owner's schedule list;
//!  - `POST /api/agents/{id}/schedules/{scheduleId}/cancel` — owner cancel.
//!
//! Both compose the SAME visibility+authority ladder the sibling write faces do
//! ([`gate_agent_edit`]): a missing principal is a fail-closed 500 that reads
//! nothing; a malformed/absent/invisible/non-active agent collapses to ONE
//! anti-enumeration `404 {"error":"agent not found"}`; a viewer who can see but
//! not edit gets `403 {"error":"forbidden"}`. Only past the gate does each face
//! do its own work — the list DEFERS its query parse until after the floor (an
//! invalid query never precedes it), and cancel re-binds the schedule's own
//! owner inside its atomic unit of work.
//!
//! UNMOUNTED: the routers here are constructed but not yet mounted by the
//! composition root — that is a separate integration step. The domain lives in
//! `backend-core::messaging::schedule`; this is only the agent-scoped surface.

mod cancel;
mod list;
mod wire;

pub use cancel::{SCHEDULE_CANCEL_PATH, router as schedule_cancel_router};
pub use list::{SCHEDULES_PATH, router as schedule_list_router};

use axum::{
    Json,
    extract::Extension,
    http::StatusCode,
    response::{IntoResponse, Response},
};
use serde::Serialize;
use silverhand_backend_core::{
    agent_detail_read::{AgentDetailFacts, AgentDetailReadModel},
    capability::{
        agent_authority::{AgentAuthority, can_edit_agent},
        agent_view::{VisibleStages, can_view_agent},
    },
    identity::{AgentId, Principal, UserId},
};

use crate::error;

/// The anti-enumeration refusal string, pinned to the TypeScript handler.
const AGENT_NOT_FOUND: &str = "agent not found";
/// The authority-refusal string (`c.json({ error: 'forbidden' }, 403)`).
const FORBIDDEN: &str = "forbidden";
/// The composition-fault body: a bare `text/plain` 500, never a JSON envelope.
const INTERNAL_ERROR_BODY: &str = "Internal Server Error";

/// The shared static `{ "error": ... }` refusal body.
#[derive(Serialize)]
struct ErrorBody {
    error: &'static str,
}

/// Why the shared ladder refused. A cheap descriptor rather than an eagerly-built
/// [`Response`], so the `Result` the gate returns stays small
/// (`clippy::result_large_err`); the call site turns it into the wire response.
/// The fail-closed log line is already emitted inside the gate, so the arms carry
/// no context.
enum GateRefusal {
    /// A composition/resolver fault: the bare `text/plain` 500.
    Internal,
    /// Malformed/absent/invisible/non-active — the one anti-enumeration 404.
    NotFound,
    /// Visible but not the creator — `403 {"error":"forbidden"}`.
    Forbidden,
}

impl GateRefusal {
    fn into_response(self) -> Response {
        match self {
            Self::Internal => internal_error(),
            Self::NotFound => not_found(),
            Self::Forbidden => forbidden(),
        }
    }
}

/// Run the creator-or-system visibility+authority ladder shared by both faces.
/// On success it returns the request-bound [`AgentId`] AND the viewer [`UserId`]
/// (proof the authenticating perimeter ran — the cancel face writes it into the
/// success audit line; the list face ignores it). Every refusal is a
/// [`GateRefusal`] the call site renders.
///
/// The route name is only for the fail-closed log line; the ladder itself is
/// identical to the sibling write faces (`agent_stop`), so a drift here is a
/// drift there.
async fn gate_agent_edit<D: AgentDetailReadModel>(
    detail_reads: &D,
    viewer: Option<Extension<UserId>>,
    agent_id: String,
    route: &'static str,
) -> Result<(AgentId, UserId), GateRefusal> {
    let Some(Extension(viewer)) = viewer else {
        tracing::error!("{route} route reached without its human principal fact");
        return Err(GateRefusal::Internal);
    };
    let principal = Principal::human(viewer.clone());

    // A malformed id names no agent — the same 404 an absent row gets.
    let Ok(agent) = AgentId::parse(agent_id) else {
        return Err(GateRefusal::NotFound);
    };

    // Gate read: the one snapshot that decides visibility and authority.
    let detail = match detail_reads.read_agent_detail(&agent).await {
        Ok(detail) => detail,
        Err(cause) => {
            tracing::error!(
                error_chain = %error::describe(&cause),
                "{route} gate read failed"
            );
            return Err(GateRefusal::Internal);
        }
    };

    // Bind the resolved row to the request before either gate: a bundle decoded
    // for another agent is a resolver defect, the lane's safe 500.
    if let Some(detail) = detail.as_ref()
        && detail.source() != &agent
    {
        tracing::error!(
            requested = agent.as_str(),
            resolved = detail.source().as_str(),
            "{route} resolved for the wrong agent"
        );
        return Err(GateRefusal::Internal);
    }

    // VISIBILITY (active-only): absence, non-membership, and a non-active stage
    // all collapse to one anti-enumeration 404.
    let decision = can_view_agent(
        &principal,
        &agent,
        detail.as_ref().map(AgentDetailFacts::visibility),
        &VisibleStages::active_only(),
    );
    let Some(detail) = detail.filter(|_| decision.is_allowed()) else {
        return Err(GateRefusal::NotFound);
    };

    // AUTHORITY: only the creator (or system) may manage it; a viewer who is not
    // the creator gets 403.
    let authority = AgentAuthority {
        created_by_user_id: Some(detail.created_by_user_id().clone()),
    };
    if !can_edit_agent(&principal, &agent, Some(&authority)).is_allowed() {
        return Err(GateRefusal::Forbidden);
    }

    Ok((agent, viewer))
}

fn not_found() -> Response {
    (
        StatusCode::NOT_FOUND,
        Json(ErrorBody {
            error: AGENT_NOT_FOUND,
        }),
    )
        .into_response()
}

fn forbidden() -> Response {
    (StatusCode::FORBIDDEN, Json(ErrorBody { error: FORBIDDEN })).into_response()
}

fn internal_error() -> Response {
    (StatusCode::INTERNAL_SERVER_ERROR, INTERNAL_ERROR_BODY).into_response()
}
