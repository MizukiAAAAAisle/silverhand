//! `POST`/`DELETE /api/channels/{id}/star` — toggle THIS viewer's star on a
//! conversation.
//!
//! Both methods share one handler parameterized by the target star state, exactly
//! like the reference `channelStar(c, starred)`. The route is thin over the ONE
//! transactional [`ViewerSortMutationWriter`]: it admits the path id and hands a
//! `SetStarred` mutation to the writer, which — UNDER its own write lock —
//! re-resolves the channel's `channels:<ws>` list existence (404) / visibility
//! (403) / live membership (404), toggles the star (and, on unstar, drops the
//! favorites-rank orphan), and returns the committed `channels:<ws>` post-image.
//! No decision fact is a stale pre-lock witness.

use std::sync::Arc;

use axum::{
    Json, Router,
    extract::{Extension, Path, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::post,
};
use serde::Serialize;
use silverhand_backend_core::{
    foundation::identity::UserId,
    viewer_read_model::viewer_sort_state::{
        ChannelHomeReadPort, ChannelHomeVerdict, SortListKey, SortMutation, SortMutationRefusal,
        ViewerSortMutationWriter,
    },
};

use super::wire::ViewerSortStateDto;

/// The shared mounted path for both star methods.
pub const CHANNEL_STAR_PATH: &str = "/api/channels/{id}/star";

/// The two authorities the star routes bind: `homes` reads the channel's parent
/// workspace (the reference `getChannelLike` — a missing/non-channel id is `404
/// channel not found`, distinct from the list-not-found the writer decides);
/// `writer` is the ONE transactional sort mutation authority. In production both are
/// shared-pool handles over the one messaging store.
pub struct ChannelStarState<H, W> {
    pub homes: H,
    pub writer: W,
}

struct Shared<H, W>(Arc<ChannelStarState<H, W>>);
impl<H, W> Clone for Shared<H, W> {
    fn clone(&self) -> Self {
        Self(Arc::clone(&self.0))
    }
}

pub fn star_router<H, W>(state: ChannelStarState<H, W>) -> Router
where
    H: ChannelHomeReadPort + Send + Sync + 'static,
    W: ViewerSortMutationWriter + Send + Sync + 'static,
{
    Router::new()
        .route(CHANNEL_STAR_PATH, post(star::<H, W>).delete(unstar::<H, W>))
        .with_state(Shared(Arc::new(state)))
}

async fn star<H, W>(
    State(state): State<Shared<H, W>>,
    principal: Option<Extension<UserId>>,
    Path(id): Path<String>,
) -> Response
where
    H: ChannelHomeReadPort + Send + Sync + 'static,
    W: ViewerSortMutationWriter + Send + Sync + 'static,
{
    toggle(state, principal, id, true).await
}

async fn unstar<H, W>(
    State(state): State<Shared<H, W>>,
    principal: Option<Extension<UserId>>,
    Path(id): Path<String>,
) -> Response
where
    H: ChannelHomeReadPort + Send + Sync + 'static,
    W: ViewerSortMutationWriter + Send + Sync + 'static,
{
    toggle(state, principal, id, false).await
}

async fn toggle<H, W>(
    state: Shared<H, W>,
    principal: Option<Extension<UserId>>,
    id: String,
    starred: bool,
) -> Response
where
    H: ChannelHomeReadPort + Send + Sync + 'static,
    W: ViewerSortMutationWriter + Send + Sync + 'static,
{
    let Some(Extension(viewer)) = principal else {
        return registration_required();
    };
    if id.is_empty() {
        return error(StatusCode::BAD_REQUEST, "channel id required");
    }
    let state = &state.0;

    // The channel-like existence read (reference `getChannelLike`): a missing or
    // non-channel id is `404 channel not found`, distinct from the list-not-found
    // the writer decides for a resolvable channel in a gone/forbidden workspace.
    // This read is a fast pre-writer refusal-order hint; the writer still re-resolves
    // the list's authority under its own lock before writing.
    let home = match state.homes.channel_home(&id).await {
        Ok(Some(ChannelHomeVerdict::WorkspacePlaced(home))) => home,
        // A missing id is `channel not found`; a workspace-less EXISTING conversation
        // (direct pair) passed existence but resolves no channels list → `not found`
        // (Cindy #39 — the existence fact is not null-collapsed).
        Ok(Some(ChannelHomeVerdict::WorkspaceLessExisting)) => {
            return error(StatusCode::NOT_FOUND, "not found");
        }
        Ok(None) => return error(StatusCode::NOT_FOUND, "channel not found"),
        Err(cause) => return internal(cause, "channel-star home read failed"),
    };

    let list_key = SortListKey::Channels(home.workspace.as_str().to_owned());
    match state
        .writer
        .apply_sort_mutation(
            &viewer,
            &list_key,
            &SortMutation::SetStarred {
                entity_id: id,
                starred,
            },
        )
        .await
    {
        Ok(Ok(projection)) => (
            StatusCode::OK,
            Json(ViewerSortResponse {
                viewer_sort: ViewerSortStateDto::from(projection),
            }),
        )
            .into_response(),
        // The star routes render list-not-found / unknown-entity as `404 not found`
        // (the reference's `not found` after `getChannelLike` passed) and forbidden
        // as `403 forbidden`.
        Ok(Err(SortMutationRefusal::ListNotFound))
        | Ok(Err(SortMutationRefusal::UnknownEntity)) => error(StatusCode::NOT_FOUND, "not found"),
        Ok(Err(SortMutationRefusal::Forbidden)) => error(StatusCode::FORBIDDEN, "forbidden"),
        // No other refusal is reachable for a `SetStarred` on a channels list.
        Ok(Err(_)) => internal_unreachable(),
        Err(cause) => internal(cause, "channel-star write failed"),
    }
}

#[derive(Serialize)]
struct ViewerSortResponse {
    viewer_sort: ViewerSortStateDto,
}

#[derive(Serialize)]
struct ErrorBody {
    error: &'static str,
}

fn error(status: StatusCode, message: &'static str) -> Response {
    (status, Json(ErrorBody { error: message })).into_response()
}

fn registration_required() -> Response {
    (
        StatusCode::FORBIDDEN,
        Json(serde_json::json!({
            "error": "viewer has not authenticated yet",
            "code": "registration_required"
        })),
    )
        .into_response()
}

fn internal<E>(cause: E, log: &'static str) -> Response
where
    E: std::error::Error + Send + Sync + 'static,
{
    tracing::error!(
        error_chain = crate::foundation::safe_log_field::safe_display(
            &(crate::foundation::error::describe(&cause))
        ),
        "{log}"
    );
    (StatusCode::INTERNAL_SERVER_ERROR, "Internal Server Error").into_response()
}

/// A `SetStarred` mutation can only ever yield list-not-found / forbidden /
/// unknown-entity; any other refusal is a construction bug, surfaced as a safe 500
/// rather than a wrong product answer.
fn internal_unreachable() -> Response {
    tracing::error!("channel-star writer returned an unreachable refusal");
    (StatusCode::INTERNAL_SERVER_ERROR, "Internal Server Error").into_response()
}
