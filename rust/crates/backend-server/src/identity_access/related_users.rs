//! Authenticated member-rail read. The global invitation/identity directory is separate.
use super::human_auth::UserDto;
use axum::{
    Json, Router,
    extract::{Extension, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::get,
};
use silverhand_backend_core::{
    foundation::identity::UserId, identity_access::user_identity::RelatedUserDirectoryRead,
};

/// Mount only inside the shared human-session perimeter.
pub fn router<R: RelatedUserDirectoryRead>(reads: R) -> Router {
    Router::new()
        .route("/api/users/related", get(list::<R>))
        .with_state(reads)
}

async fn list<R: RelatedUserDirectoryRead>(
    State(reads): State<R>,
    Extension(viewer): Extension<UserId>,
) -> Response {
    match reads.list_related(&viewer).await {
        Ok(users) => {
            let users: Vec<UserDto> = users.iter().map(UserDto::from_record).collect();
            Json(serde_json::json!({"users": users})).into_response()
        }
        Err(cause) => {
            tracing::error!(cause = %crate::foundation::safe_log_field::safe_display(
                &crate::foundation::error::describe(&cause)), "related user directory read failed");
            (StatusCode::INTERNAL_SERVER_ERROR, "Internal Server Error").into_response()
        }
    }
}
