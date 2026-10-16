//! Avatar-maker designs on the HTTP surface: the optional multipart `design` part
//! the three avatar uploads accept, and the two reads behind
//! `GET /api/me/avatar/design` and `GET /api/agents/{id}/avatar/design`.
//!
//! The read answers `{ "design": { parts_version, config } | null }`; `null` means
//! the current avatar was not produced by the editor. Display never reads this.

use axum::{
    Json, Router,
    extract::{Extension, Path, State, multipart::Field, multipart::MultipartError},
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::get,
};
use serde::Serialize;
use serde_json::Value;
use silverhand_backend_core::{
    foundation::identity::{AgentId, Principal, UserId},
    identity_access::agent_detail_read::AgentDetailReadModel,
    identity_access::avatar_design::{
        AVATAR_DESIGN_FIELD_MAX_BYTES, AgentAvatarDesignRead, AvatarDesign, AvatarDesignRejection,
        UserAvatarDesignRead,
    },
};

use super::agent_avatar_write::gate_avatar_edit;
use crate::foundation::error;
use crate::foundation::multipart_transport::{accumulate_capped, drain};

/// The multipart part name carrying the design JSON.
pub const DESIGN_FIELD: &str = "design";
pub const ME_AVATAR_DESIGN_PATH: &str = "/api/me/avatar/design";
pub const AGENT_AVATAR_DESIGN_PATH: &str = "/api/agents/{id}/avatar/design";

const INTERNAL_ERROR_BODY: &str = "Internal Server Error";

/// Capture of the first `design` part; later ones are drained. Parsing is
/// deferred so the route keeps its existing refusal order for the `file` part.
#[derive(Default)]
pub(crate) struct DesignSlot(Option<Vec<u8>>);

impl DesignSlot {
    /// Consume `field` if it is the first `design` part; returns `false` when the
    /// caller should handle the field itself.
    pub(crate) async fn offer(&mut self, field: &mut Field<'_>) -> Result<bool, MultipartError> {
        if field.name() != Some(DESIGN_FIELD) {
            return Ok(false);
        }
        if self.0.is_none() {
            let bytes = accumulate_capped(field, AVATAR_DESIGN_FIELD_MAX_BYTES + 1).await?;
            self.0 = Some(bytes);
        }
        drain(field).await?;
        Ok(true)
    }

    /// `Ok(None)` = no design part (a manual upload).
    pub(crate) fn admit(self) -> Result<Option<AvatarDesign>, AvatarDesignRejection> {
        self.0.map(|raw| AvatarDesign::parse_wire(&raw)).transpose()
    }
}

/// `400 {"error","code":"avatar_design_invalid"}`.
pub(crate) fn design_rejected(rejection: AvatarDesignRejection) -> Response {
    #[derive(Serialize)]
    struct Body {
        error: &'static str,
        code: &'static str,
    }
    (
        StatusCode::BAD_REQUEST,
        Json(Body {
            error: rejection.message(),
            code: rejection.code(),
        }),
    )
        .into_response()
}

#[derive(Serialize)]
struct DesignDto {
    parts_version: u32,
    config: Value,
}

#[derive(Serialize)]
struct DesignResponse {
    design: Option<DesignDto>,
}

fn design_response(design: Option<AvatarDesign>) -> Response {
    Json(DesignResponse {
        design: design.map(|design| DesignDto {
            parts_version: design.parts_version(),
            config: design.config_value(),
        }),
    })
    .into_response()
}

fn internal_error() -> Response {
    (StatusCode::INTERNAL_SERVER_ERROR, INTERNAL_ERROR_BODY).into_response()
}

/// `GET /api/me/avatar/design`, mounted behind the human-session perimeter.
pub fn me_router<D>(designs: D) -> Router
where
    D: UserAvatarDesignRead,
{
    Router::new()
        .route(ME_AVATAR_DESIGN_PATH, get(me_design::<D>))
        .with_state(designs)
}

async fn me_design<D>(viewer: Option<Extension<UserId>>, State(designs): State<D>) -> Response
where
    D: UserAvatarDesignRead,
{
    let Some(Extension(user_id)) = viewer else {
        tracing::error!("GET /api/me/avatar/design reached without its human principal fact");
        return internal_error();
    };
    match designs.user_avatar_design(&user_id).await {
        Ok(design) => design_response(design),
        Err(cause) => {
            tracing::error!(
                error_chain =
                    crate::foundation::safe_log_field::safe_display(&(error::describe(&cause))),
                "user avatar design read failed"
            );
            internal_error()
        }
    }
}

#[derive(Clone)]
struct AgentDesignState<R, D> {
    reads: R,
    designs: D,
}

/// `GET /api/agents/{id}/avatar/design`, behind the same visibility + edit
/// authority as the agent avatar write.
pub fn agent_router<R, D>(reads: R, designs: D) -> Router
where
    R: AgentDetailReadModel + Clone + Send + Sync + 'static,
    D: AgentAvatarDesignRead,
{
    Router::new()
        .route(AGENT_AVATAR_DESIGN_PATH, get(agent_design::<R, D>))
        .with_state(AgentDesignState { reads, designs })
}

async fn agent_design<R, D>(
    Path(agent_id): Path<String>,
    viewer: Option<Extension<UserId>>,
    State(state): State<AgentDesignState<R, D>>,
) -> Response
where
    R: AgentDetailReadModel,
    D: AgentAvatarDesignRead,
{
    let Some(Extension(viewer)) = viewer else {
        tracing::error!("agent avatar design route reached without its human principal");
        return internal_error();
    };
    let principal = Principal::human(viewer);
    let Ok(agent) = AgentId::parse(agent_id) else {
        return super::agent_avatar_write::agent_not_found();
    };
    if let Some(refusal) = gate_avatar_edit(&state.reads, &principal, &agent).await {
        return refusal;
    }
    match state.designs.agent_avatar_design(&agent).await {
        Ok(design) => design_response(design),
        Err(cause) => {
            tracing::error!(
                error_chain =
                    crate::foundation::safe_log_field::safe_display(&(error::describe(&cause))),
                "agent avatar design read failed"
            );
            internal_error()
        }
    }
}
