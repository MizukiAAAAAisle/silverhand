//! Human-session HTTP adapters for the viewer-private saved-message capability.

mod wire;

pub use wire::{SAVED_CHANGED_EVENT, changed_event};

#[cfg(test)]
mod tests;

use std::sync::Arc;

use axum::{
    Router,
    extract::{Extension, Path, Query, State, rejection::QueryRejection},
    response::Response,
    routing::{get, post},
};
use serde::Deserialize;
use silverhand_backend_core::{
    identity::{AgentId, UserId, WorkspaceId},
    messaging::{
        MessageId,
        collaboration::saved::{
            SavedAftermath, SavedListQuery, SavedMutationPort, SavedReadPort, SavedSender,
            SavedSince, save_message, unsave_message,
        },
    },
};

use super::query_number::{CoercedInteger, NumberIssue, coerce_integer};
use wire::{
    internal_error, internal_error_response, invalid_input, list_refusal, list_success,
    message_not_found, save_success, unsave_success,
};

pub const LIST_PATH: &str = "/api/saved";
pub const MUTATION_PATH: &str = "/api/messages/{id}/save";

struct Inner<R, M, A> {
    reads: R,
    mutations: M,
    aftermath: A,
}

struct SavedState<R, M, A>(Arc<Inner<R, M, A>>);

impl<R, M, A> Clone for SavedState<R, M, A> {
    fn clone(&self) -> Self {
        Self(Arc::clone(&self.0))
    }
}

pub fn router<R, M, A>(reads: R, mutations: M, aftermath: A) -> Router
where
    R: SavedReadPort + Send + Sync + 'static,
    M: SavedMutationPort + Send + Sync + 'static,
    A: SavedAftermath + Send + Sync + 'static,
{
    let state = SavedState(Arc::new(Inner {
        reads,
        mutations,
        aftermath,
    }));
    Router::new()
        .route(LIST_PATH, get(list::<R, M, A>))
        .route(
            MUTATION_PATH,
            post(save::<R, M, A>).delete(unsave::<R, M, A>),
        )
        .with_state(state)
}

#[derive(Deserialize)]
struct MessagePath {
    id: String,
}

#[derive(Default, Deserialize)]
struct ListQueryWire {
    workspace_id: Option<String>,
    since: Option<String>,
    user_id: Option<String>,
    agent_id: Option<String>,
}

async fn list<R, M, A>(
    State(state): State<SavedState<R, M, A>>,
    principal: Option<Extension<UserId>>,
    query: Result<Query<ListQueryWire>, QueryRejection>,
) -> Response
where
    R: SavedReadPort,
    M: SavedMutationPort,
    A: SavedAftermath,
{
    let Some(Extension(viewer)) = principal else {
        return internal_error("saved route reached without human principal");
    };
    let query = match query {
        Ok(Query(query)) => match list_query(query) {
            Ok(query) => query,
            Err(issues) => return invalid_input(issues),
        },
        Err(_) => return invalid_input(Vec::new()),
    };
    match state.0.reads.list(&viewer, query).await {
        Ok(Ok(entries)) => list_success(&entries),
        Ok(Err(refusal)) => list_refusal(refusal),
        Err(error) => {
            tracing::error!(error_chain = %crate::error::describe(&error), "saved list read failed");
            internal_error_response()
        }
    }
}

fn list_query(raw: ListQueryWire) -> Result<SavedListQuery, Vec<serde_json::Value>> {
    // The workspace member uses a blank-only preprocessor but deliberately does
    // not trim a nonblank value. Sender ids use SearchOptionalStringSchema and
    // therefore return the ECMAScript-trimmed value. These are two distinct TS
    // production contracts despite looking similar at the wire edge.
    let workspace = blank_to_none(raw.workspace_id)
        .map(WorkspaceId::parse)
        .transpose()
        .map_err(|_| Vec::new())?;
    let since = match raw.since.filter(|value| !value.is_empty()) {
        None => None,
        Some(raw) => {
            let parsed = coerce_integer(&raw).map_err(|issue| {
                vec![match issue {
                    NumberIssue::Nan => json_issue(
                        "invalid_type",
                        "Expected number, received nan",
                        "nan",
                        "since",
                    ),
                    NumberIssue::Float | NumberIssue::NonFinite => json_issue(
                        "invalid_type",
                        "Expected integer, received float",
                        "float",
                        "since",
                    ),
                }]
            })?;
            Some(match parsed {
                CoercedInteger::Persisted(value) => SavedSince::new(value).ok_or_else(|| {
                    vec![json_issue(
                        "too_small",
                        "Number must be greater than or equal to 0",
                        "number",
                        "since",
                    )]
                })?,
                CoercedInteger::BeyondPersistedRange => SavedSince::beyond_persisted_range(),
            })
        }
    };
    let human = search_optional(raw.user_id)
        .map(UserId::parse)
        .transpose()
        .map_err(|_| Vec::new())?;
    let agent = search_optional(raw.agent_id)
        .map(AgentId::parse)
        .transpose()
        .map_err(|_| Vec::new())?;
    let sender = match (human, agent) {
        (Some(_), Some(_)) => {
            return Err(vec![serde_json::json!({
                "code":"custom","message":"user_id and agent_id cannot both be set","path":["user_id"]
            })]);
        }
        (Some(human), None) => Some(SavedSender::Human(human)),
        (None, Some(agent)) => Some(SavedSender::Agent(agent)),
        (None, None) => None,
    };
    Ok(SavedListQuery {
        workspace,
        since,
        sender,
    })
}

fn json_issue(
    code: &'static str,
    message: &'static str,
    received: &'static str,
    member: &'static str,
) -> serde_json::Value {
    if code == "too_small" {
        return serde_json::json!({
            "code":"too_small","minimum":0,"type":"number","inclusive":true,
            "exact":false,"message":message,"path":[member]
        });
    }
    serde_json::json!({"code":code,"expected":if received == "float" { "integer" } else { "number" },"received":received,"path":[member],"message":message})
}

fn blank_to_none(raw: Option<String>) -> Option<String> {
    raw.filter(|value| !crate::messaging::admission::ecmascript_trim(value).is_empty())
}

fn search_optional(raw: Option<String>) -> Option<String> {
    raw.and_then(|value| {
        let trimmed = crate::messaging::admission::ecmascript_trim(&value);
        (!trimmed.is_empty()).then(|| trimmed.to_owned())
    })
}

async fn save<R, M, A>(
    State(state): State<SavedState<R, M, A>>,
    principal: Option<Extension<UserId>>,
    Path(path): Path<MessagePath>,
) -> Response
where
    R: SavedReadPort,
    M: SavedMutationPort,
    A: SavedAftermath,
{
    let Some(Extension(viewer)) = principal else {
        return internal_error("saved route reached without human principal");
    };
    let Ok(message) = MessageId::parse(path.id) else {
        return message_not_found();
    };
    match save_message(&state.0.mutations, &state.0.aftermath, viewer, message).await {
        Ok(Ok(execution)) => save_success(execution),
        Ok(Err(_)) => message_not_found(),
        Err(error) => {
            tracing::error!(error_chain = %crate::error::describe(&error), "save message failed");
            internal_error_response()
        }
    }
}

async fn unsave<R, M, A>(
    State(state): State<SavedState<R, M, A>>,
    principal: Option<Extension<UserId>>,
    Path(path): Path<MessagePath>,
) -> Response
where
    R: SavedReadPort,
    M: SavedMutationPort,
    A: SavedAftermath,
{
    let Some(Extension(viewer)) = principal else {
        return internal_error("saved route reached without human principal");
    };
    let Ok(message) = MessageId::parse(path.id) else {
        return message_not_found();
    };
    match unsave_message(&state.0.mutations, &state.0.aftermath, viewer, message).await {
        Ok(Ok(execution)) => unsave_success(execution),
        Ok(Err(_)) => message_not_found(),
        Err(error) => {
            tracing::error!(error_chain = %crate::error::describe(&error), "unsave message failed");
            internal_error_response()
        }
    }
}
