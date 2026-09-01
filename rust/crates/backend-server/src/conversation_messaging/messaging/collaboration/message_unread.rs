//! Authenticated HTTP adapters for the three roll-up message-unread reads.

use std::sync::Arc;

use axum::{
    Json, Router,
    extract::{Extension, Path, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::get,
};
use serde_json::{Map, Value, json};
use silverhand_backend_core::{
    conversation_messaging::messaging::collaboration::message_unread::{
        BoundConversationMessageUnread, BoundViewerMessageUnreadSummary,
        BoundWorkspaceMessageUnread, ConversationMessageUnreadReadPort,
        ConversationMessageUnreadRefusal, LatestUnreadPointer, ViewerMessageUnreadSummaryReadPort,
        WorkspaceMessageUnreadReadPort, WorkspaceMessageUnreadRefusal,
    },
    foundation::identity::{ConversationId, UserId, WorkspaceId},
};

pub const WORKSPACE_MESSAGE_UNREAD_PATH: &str = "/api/workspaces/{id}/message-unread";
pub const MESSAGE_UNREAD_SUMMARY_PATH: &str = "/api/message-unread-summary";
pub const CONVERSATION_MESSAGE_UNREAD_PATH: &str = "/api/channels/{id}/message-unread";

struct MessageUnreadState<P>(Arc<P>);

impl<P> Clone for MessageUnreadState<P> {
    fn clone(&self) -> Self {
        Self(Arc::clone(&self.0))
    }
}

pub fn router<P>(port: P) -> Router
where
    P: WorkspaceMessageUnreadReadPort
        + ViewerMessageUnreadSummaryReadPort
        + ConversationMessageUnreadReadPort
        + Send
        + Sync
        + 'static,
{
    Router::new()
        .route(WORKSPACE_MESSAGE_UNREAD_PATH, get(workspace::<P>))
        .route(MESSAGE_UNREAD_SUMMARY_PATH, get(summary::<P>))
        .route(CONVERSATION_MESSAGE_UNREAD_PATH, get(conversation::<P>))
        .with_state(MessageUnreadState(Arc::new(port)))
}

async fn workspace<P>(
    State(state): State<MessageUnreadState<P>>,
    principal: Option<Extension<UserId>>,
    Path(raw_id): Path<String>,
) -> Response
where
    P: WorkspaceMessageUnreadReadPort + Send + Sync,
{
    let Some(Extension(viewer)) = principal else {
        tracing::error!("workspace-message-unread route reached without human principal");
        return internal();
    };
    let requested = match WorkspaceId::parse(raw_id) {
        Ok(value) => value,
        Err(_) => return error(StatusCode::BAD_REQUEST, "workspace id required"),
    };
    match state.0.read_workspace(&viewer, &requested).await {
        Ok(Ok(value)) => match value.bind(&requested) {
            Ok(value) => workspace_success(&value),
            Err(error) => {
                tracing::error!(error_chain=%crate::foundation::error::describe(&error),"workspace-message-unread identity seal failed");
                internal()
            }
        },
        Ok(Err(WorkspaceMessageUnreadRefusal::NotFound)) => {
            error(StatusCode::NOT_FOUND, "workspace not found")
        }
        Ok(Err(WorkspaceMessageUnreadRefusal::Forbidden)) => {
            error(StatusCode::FORBIDDEN, "forbidden")
        }
        Err(error) => {
            tracing::error!(error_chain=%crate::foundation::error::describe(&error),"workspace-message-unread projection failed");
            internal()
        }
    }
}

async fn summary<P>(
    State(state): State<MessageUnreadState<P>>,
    principal: Option<Extension<UserId>>,
) -> Response
where
    P: ViewerMessageUnreadSummaryReadPort + Send + Sync,
{
    let Some(Extension(viewer)) = principal else {
        tracing::error!("message-unread-summary route reached without human principal");
        return internal();
    };
    match state.0.read_summary(&viewer).await {
        Ok(value) => match value.bind(&viewer) {
            Ok(value) => summary_success(&value),
            Err(error) => {
                tracing::error!(error_chain=%crate::foundation::error::describe(&error),"message-unread-summary identity seal failed");
                internal()
            }
        },
        Err(error) => {
            tracing::error!(error_chain=%crate::foundation::error::describe(&error),"message-unread-summary projection failed");
            internal()
        }
    }
}

async fn conversation<P>(
    State(state): State<MessageUnreadState<P>>,
    principal: Option<Extension<UserId>>,
    Path(raw_id): Path<String>,
) -> Response
where
    P: ConversationMessageUnreadReadPort + Send + Sync,
{
    let Some(Extension(viewer)) = principal else {
        tracing::error!("conversation-message-unread route reached without human principal");
        return internal();
    };
    let requested = match ConversationId::parse(raw_id) {
        Ok(value) => value,
        Err(_) => return error(StatusCode::BAD_REQUEST, "channel id required"),
    };
    match state.0.read_conversation(&viewer, &requested).await {
        Ok(Ok(value)) => match value.bind(&requested) {
            Ok(value) => conversation_success(&value),
            Err(error) => {
                tracing::error!(error_chain=%crate::foundation::error::describe(&error),"conversation-message-unread identity seal failed");
                internal()
            }
        },
        Ok(Err(ConversationMessageUnreadRefusal::NotFound)) => {
            error(StatusCode::NOT_FOUND, "channel not found")
        }
        Ok(Err(ConversationMessageUnreadRefusal::Forbidden)) => {
            error(StatusCode::FORBIDDEN, "forbidden")
        }
        Err(error) => {
            tracing::error!(error_chain=%crate::foundation::error::describe(&error),"conversation-message-unread projection failed");
            internal()
        }
    }
}

fn workspace_success(value: &BoundWorkspaceMessageUnread) -> Response {
    let mut counts = Map::new();
    let mut latest = Map::new();
    for row in value.rows() {
        counts.insert(row.conversation().as_str().to_owned(), json!(row.count()));
        latest.insert(
            row.conversation().as_str().to_owned(),
            pointer_wire(row.latest()),
        );
    }
    let total = match value.total() {
        Ok(value) => value,
        Err(error) => {
            tracing::error!(error_chain=%crate::foundation::error::describe(&error),"workspace-message-unread total overflowed");
            return internal();
        }
    };
    Json(json!({
        "by_conversation": counts,
        "latest_by_conversation": latest,
        "total": total,
    }))
    .into_response()
}

fn summary_success(value: &BoundViewerMessageUnreadSummary) -> Response {
    let by_workspace = value
        .rows()
        .iter()
        .map(|row| (row.workspace().as_str().to_owned(), json!(row.count())))
        .collect::<Map<String, Value>>();
    Json(json!({"by_workspace": by_workspace})).into_response()
}

fn conversation_success(value: &BoundConversationMessageUnread) -> Response {
    let mut counts = Map::new();
    counts.insert(
        value.conversation().as_str().to_owned(),
        json!(value.unread().count()),
    );
    let mut latest = Map::new();
    if let Some(pointer) = value.unread().latest() {
        latest.insert(
            value.conversation().as_str().to_owned(),
            pointer_wire(pointer),
        );
    }
    Json(json!({
        "by_conversation": counts,
        "latest_by_conversation": latest,
        "total": value.unread().count(),
    }))
    .into_response()
}

fn pointer_wire(value: &LatestUnreadPointer) -> Value {
    json!({
        "conversation_id": value.conversation().as_str(),
        "message_id": value.message().as_str(),
        "seq": value.seq().get(),
        "thread_root_id": value.thread_root().map(|root| root.as_str()),
    })
}

fn error(status: StatusCode, message: &'static str) -> Response {
    (status, Json(json!({"error": message}))).into_response()
}

fn internal() -> Response {
    error(StatusCode::INTERNAL_SERVER_ERROR, "internal error")
}
