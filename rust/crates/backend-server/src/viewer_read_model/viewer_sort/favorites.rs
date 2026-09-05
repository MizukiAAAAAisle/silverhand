//! `GET /api/favorites` — the viewer's global starred-conversation list.
//!
//! Behind the composition's `require_human_session` perimeter, so the acting
//! viewer arrives as an `Extension<UserId>` and the owned-state gate is
//! self-only (there is no other viewer to name), so there is no 404/403 arm —
//! only the read.

use std::sync::Arc;

use axum::{
    Json, Router,
    extract::{Extension, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::get,
};
use serde::Serialize;
use silverhand_backend_core::{
    foundation::identity::UserId,
    viewer_read_model::favorites::{FavoriteRow, FavoritesReadPort},
};

use super::wire::ViewerSortStateDto;

pub const FAVORITES_PATH: &str = "/api/favorites";

pub struct FavoritesState<R> {
    pub reads: R,
}

struct Shared<R>(Arc<FavoritesState<R>>);
impl<R> Clone for Shared<R> {
    fn clone(&self) -> Self {
        Self(Arc::clone(&self.0))
    }
}

pub fn favorites_router<R>(state: FavoritesState<R>) -> Router
where
    R: FavoritesReadPort + Send + Sync + 'static,
{
    Router::new()
        .route(FAVORITES_PATH, get(list::<R>))
        .with_state(Shared(Arc::new(state)))
}

async fn list<R>(State(state): State<Shared<R>>, principal: Option<Extension<UserId>>) -> Response
where
    R: FavoritesReadPort + Send + Sync + 'static,
{
    let Some(Extension(viewer)) = principal else {
        return (
            StatusCode::FORBIDDEN,
            Json(serde_json::json!({
                "error": "viewer has not authenticated yet",
                "code": "registration_required"
            })),
        )
            .into_response();
    };
    match state.0.reads.list_favorites(&viewer).await {
        Ok(favorites) => (
            StatusCode::OK,
            Json(ListFavoritesBody {
                items: favorites
                    .items
                    .into_iter()
                    .map(FavoriteRowDto::from)
                    .collect(),
                viewer_sort: ViewerSortStateDto::from(favorites.viewer_sort),
            }),
        )
            .into_response(),
        Err(cause) => {
            tracing::error!(
                error_chain = crate::foundation::safe_log_field::safe_display(
                    &(crate::foundation::error::describe(&cause))
                ),
                "favorites list read failed"
            );
            (StatusCode::INTERNAL_SERVER_ERROR, "Internal Server Error").into_response()
        }
    }
}

/// `ListFavoritesDto` = `{ items: [FavoriteRowDto], viewer_sort }`.
#[derive(Serialize)]
struct ListFavoritesBody {
    items: Vec<FavoriteRowDto>,
    viewer_sort: ViewerSortStateDto,
}

/// `FavoriteRowDto`.
#[derive(Serialize)]
struct FavoriteRowDto {
    roster_policy: &'static str,
    favorite_key: String,
    entity_id: String,
    workspace_id: String,
    title: String,
    parent_title: String,
    starred_at: i64,
    created_at: i64,
    unread_count: Option<i64>,
    visibility: &'static str,
}

impl From<FavoriteRow> for FavoriteRowDto {
    fn from(row: FavoriteRow) -> Self {
        Self {
            roster_policy: row.roster_policy.as_str(),
            favorite_key: row.favorite_key,
            entity_id: row.entity_id.into_inner(),
            workspace_id: row.workspace_id.into_inner(),
            title: row.title,
            parent_title: row.parent_title,
            starred_at: row.starred_at,
            created_at: row.created_at,
            // Wire retains nullable for back-compat; the projection always has a
            // concrete count (0 when caught up).
            unread_count: Some(row.unread_count),
            visibility: row.visibility.as_str(),
        }
    }
}
