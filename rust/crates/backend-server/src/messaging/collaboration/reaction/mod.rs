//! Human-session and runtime-credential adapters for message reactions.

mod wire;

pub use wire::{MESSAGE_REACTION_CHANGED_EVENT, ReactionChangedBody, changed_event};

#[cfg(test)]
mod tests;

use std::{
    sync::Arc,
    time::{SystemTime, UNIX_EPOCH},
};

use axum::{
    Router,
    body::Bytes,
    extract::{Extension, Path, State},
    response::Response,
    routing::post,
};
use serde::Deserialize;
use silverhand_backend_core::{
    identity::{AgentId, UserId},
    messaging::MessageId,
    messaging::collaboration::reaction::{
        ReactionAftermath, ReactionChange, ReactionEmoji, ReactionMutation, ReactionMutationPort,
        ReactionReadPort, change_reaction,
    },
    runtime_credential::RuntimePrincipal,
};

use wire::{
    detail_success, internal_error, internal_error_response, invalid_reaction, mutation_refusal,
    mutation_success, not_found, parse_agent_body, parse_human_body,
};

pub const HUMAN_PATH: &str = "/api/messages/{id}/reactions";
pub const AGENT_PATH: &str = "/internal/agents/{aid}/react-message";

struct Inner<M, R, A> {
    mutation: M,
    reads: R,
    aftermath: A,
}

struct ReactionState<M, R, A>(Arc<Inner<M, R, A>>);

impl<M, R, A> Clone for ReactionState<M, R, A> {
    fn clone(&self) -> Self {
        Self(Arc::clone(&self.0))
    }
}

pub fn router<M, R, A>(mutation: M, reads: R, aftermath: A) -> Router
where
    M: ReactionMutationPort + Send + Sync + 'static,
    R: ReactionReadPort + Send + Sync + 'static,
    A: ReactionAftermath + Send + Sync + 'static,
{
    let state = ReactionState(Arc::new(Inner {
        mutation,
        reads,
        aftermath,
    }));
    Router::new()
        .route(
            HUMAN_PATH,
            post(human_add::<M, R, A>)
                .delete(human_remove::<M, R, A>)
                .get(human_detail::<M, R, A>),
        )
        .route(
            AGENT_PATH,
            post(agent_add::<M, R, A>).delete(agent_remove::<M, R, A>),
        )
        .with_state(state)
}

#[derive(Deserialize)]
struct MessagePath {
    id: String,
}

#[derive(Deserialize)]
struct AgentPath {
    aid: String,
}

async fn human_add<M, R, A>(
    state: State<ReactionState<M, R, A>>,
    principal: Option<Extension<UserId>>,
    path: Path<MessagePath>,
    body: Bytes,
) -> Response
where
    M: ReactionMutationPort,
    R: ReactionReadPort,
    A: ReactionAftermath,
{
    human_mutation(state, principal, path, body, ReactionChange::Add).await
}

async fn human_remove<M, R, A>(
    state: State<ReactionState<M, R, A>>,
    principal: Option<Extension<UserId>>,
    path: Path<MessagePath>,
    body: Bytes,
) -> Response
where
    M: ReactionMutationPort,
    R: ReactionReadPort,
    A: ReactionAftermath,
{
    human_mutation(state, principal, path, body, ReactionChange::Remove).await
}

async fn human_mutation<M, R, A>(
    State(state): State<ReactionState<M, R, A>>,
    principal: Option<Extension<UserId>>,
    Path(path): Path<MessagePath>,
    body: Bytes,
    change: ReactionChange,
) -> Response
where
    M: ReactionMutationPort,
    R: ReactionReadPort,
    A: ReactionAftermath,
{
    let Some(Extension(viewer)) = principal else {
        return internal_error("reaction route reached without human principal");
    };
    let Ok(message) = MessageId::parse(path.id) else {
        return not_found();
    };
    let body = match parse_human_body(&body) {
        Ok(body) => body,
        Err(error) => return error.into_response(),
    };
    mutate_human(&state.0, viewer, message, body, change).await
}

async fn agent_add<M, R, A>(
    state: State<ReactionState<M, R, A>>,
    principal: Option<Extension<RuntimePrincipal>>,
    path: Path<AgentPath>,
    body: Bytes,
) -> Response
where
    M: ReactionMutationPort,
    R: ReactionReadPort,
    A: ReactionAftermath,
{
    agent_mutation(state, principal, path, body, ReactionChange::Add).await
}

async fn agent_remove<M, R, A>(
    state: State<ReactionState<M, R, A>>,
    principal: Option<Extension<RuntimePrincipal>>,
    path: Path<AgentPath>,
    body: Bytes,
) -> Response
where
    M: ReactionMutationPort,
    R: ReactionReadPort,
    A: ReactionAftermath,
{
    agent_mutation(state, principal, path, body, ReactionChange::Remove).await
}

async fn agent_mutation<M, R, A>(
    State(state): State<ReactionState<M, R, A>>,
    principal: Option<Extension<RuntimePrincipal>>,
    Path(path): Path<AgentPath>,
    body: Bytes,
    change: ReactionChange,
) -> Response
where
    M: ReactionMutationPort,
    R: ReactionReadPort,
    A: ReactionAftermath,
{
    let Some(Extension(principal)) = principal else {
        return internal_error("reaction route reached without runtime principal");
    };
    let Ok(path_agent) = AgentId::parse(path.aid) else {
        return not_found();
    };
    if principal.agent() != &path_agent {
        return not_found();
    }
    let (message, emoji) = match parse_agent_body(&body) {
        Ok(body) => body,
        Err(error) => return error.into_response(),
    };
    let message = MessageId::parse(message).expect("agent body parser rejects an empty message id");
    mutate_agent(
        &state.0,
        principal.agent().clone(),
        principal.source().cloned(),
        message,
        emoji,
        change,
    )
    .await
}

async fn mutate_human<M, R, A>(
    state: &Inner<M, R, A>,
    actor: UserId,
    message: MessageId,
    raw_emoji: String,
    change: ReactionChange,
) -> Response
where
    M: ReactionMutationPort,
    R: ReactionReadPort,
    A: ReactionAftermath,
{
    let emoji = match ReactionEmoji::parse(&raw_emoji) {
        Ok(emoji) => emoji,
        Err(error) => return invalid_reaction(error),
    };
    let occurred_at_ms = match now_ms() {
        Some(value) => value,
        None => return internal_error("system time is outside reaction storage range"),
    };
    execute_mutation(
        state,
        ReactionMutation::human(actor, message, emoji, change, occurred_at_ms),
    )
    .await
}

async fn mutate_agent<M, R, A>(
    state: &Inner<M, R, A>,
    actor: AgentId,
    source: Option<silverhand_backend_core::identity::ConversationId>,
    message: MessageId,
    raw_emoji: String,
    change: ReactionChange,
) -> Response
where
    M: ReactionMutationPort,
    R: ReactionReadPort,
    A: ReactionAftermath,
{
    let occurred_at_ms = match now_ms() {
        Some(value) => value,
        None => return internal_error("system time is outside reaction storage range"),
    };
    execute_mutation(
        state,
        ReactionMutation::agent(actor, source, message, raw_emoji, change, occurred_at_ms),
    )
    .await
}

async fn execute_mutation<M, R, A>(state: &Inner<M, R, A>, command: ReactionMutation) -> Response
where
    M: ReactionMutationPort,
    R: ReactionReadPort,
    A: ReactionAftermath,
{
    match change_reaction(&state.mutation, &state.aftermath, command).await {
        Ok(Ok(execution)) => {
            if let Some(failure) = execution.publication_failure() {
                tracing::error!(
                    error_chain = %crate::error::describe(failure),
                    "reaction publication failed"
                );
            }
            mutation_success(execution.outcome())
        }
        Ok(Err(refusal)) => mutation_refusal(refusal),
        Err(error) => {
            tracing::error!(error_chain = %crate::error::describe(&error), "reaction mutation failed");
            internal_error_response()
        }
    }
}

fn now_ms() -> Option<i64> {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .ok()
        .and_then(|duration| i64::try_from(duration.as_millis()).ok())
}

async fn human_detail<M, R, A>(
    State(state): State<ReactionState<M, R, A>>,
    principal: Option<Extension<UserId>>,
    Path(path): Path<MessagePath>,
) -> Response
where
    M: ReactionMutationPort,
    R: ReactionReadPort,
    A: ReactionAftermath,
{
    let Some(Extension(viewer)) = principal else {
        return internal_error("reaction route reached without human principal");
    };
    let Ok(message) = MessageId::parse(path.id) else {
        return not_found();
    };
    match state.0.reads.detail(&viewer, &message).await {
        Ok(Ok(detail)) => detail_success(&detail),
        Ok(Err(_)) => not_found(),
        Err(error) => {
            tracing::error!(error_chain = %crate::error::describe(&error), "reaction detail read failed");
            internal_error_response()
        }
    }
}
