//! `GET /api/conversations/latest` and the `conversation_latest_changed` payload.

use std::sync::Arc;

use axum::{
    Json, Router,
    extract::{Extension, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::get,
};
use serde_json::{Value, json};
use silverhand_backend_core::{
    conversation_messaging::messaging::collaboration::conversation_latest::{
        ConversationLatest, ConversationLatestReadPort,
    },
    foundation::identity::UserId,
};

use crate::conversation_messaging::messaging::author_wire::author_dto;

pub const CONVERSATION_LATEST_PATH: &str = "/api/conversations/latest";
pub const CONVERSATION_LATEST_CHANGED_EVENT: &str = "conversation_latest_changed";

struct LatestState<P>(Arc<P>);

impl<P> Clone for LatestState<P> {
    fn clone(&self) -> Self {
        Self(Arc::clone(&self.0))
    }
}

pub fn router<P>(port: P) -> Router
where
    P: ConversationLatestReadPort + Send + Sync + 'static,
{
    Router::new()
        .route(CONVERSATION_LATEST_PATH, get(list::<P>))
        .with_state(LatestState(Arc::new(port)))
}

async fn list<P: ConversationLatestReadPort>(
    State(state): State<LatestState<P>>,
    principal: Option<Extension<UserId>>,
) -> Response {
    let Some(Extension(viewer)) = principal else {
        tracing::error!("conversation-latest route reached without its human principal fact");
        return internal();
    };
    match state.0.list_latest(&viewer).await {
        Ok(items) => Json(json!({
            "items": items.iter().map(latest_dto).collect::<Vec<_>>()
        }))
        .into_response(),
        Err(error) => {
            tracing::error!(
                error_chain = crate::foundation::safe_log_field::safe_display(
                    &(crate::foundation::error::describe(&error))
                ),
                "conversation-latest projection failed"
            );
            internal()
        }
    }
}

/// The one wire shape shared by the snapshot items and the live event.
pub(crate) fn latest_dto(latest: &ConversationLatest) -> Value {
    json!({
        "conversation_id": latest.conversation.as_str(),
        "message_id": latest.message.as_str(),
        "seq": latest.seq.get(),
        "created_at": latest.created_at_ms,
        "thread_root_id": latest.thread_root.as_ref().map(|root| root.as_str()),
        "sender": author_dto(&latest.sender),
        "preview": latest.preview.as_ref().map(|preview| preview.as_str()),
        "attachment_count": latest.attachment_count,
    })
}

fn internal() -> Response {
    (
        StatusCode::INTERNAL_SERVER_ERROR,
        Json(json!({"error": "internal error"})),
    )
        .into_response()
}
