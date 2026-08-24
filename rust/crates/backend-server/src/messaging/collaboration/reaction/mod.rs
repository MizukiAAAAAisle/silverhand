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
        ReactionActor, ReactionAftermath, ReactionChange, ReactionEmoji, ReactionMutation,
        ReactionMutationPort, ReactionReadPort, change_reaction,
    },
    runtime_credential::RuntimePrincipal,
};

use wire::{
    detail_success, internal_error, internal_error_response, invalid_input, invalid_reaction,
    mutation_refusal, mutation_success, not_found,
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

#[derive(Deserialize)]
struct HumanBody {
    emoji: String,
}

#[derive(Deserialize)]
struct AgentBody {
    message_id: String,
    emoji: String,
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
    let Ok(body) = serde_json::from_slice::<HumanBody>(&body) else {
        return invalid_input();
    };
    mutate(
        &state.0,
        ReactionActor::Human(viewer),
        message,
        body.emoji,
        change,
    )
    .await
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
    let Ok(body) = serde_json::from_slice::<AgentBody>(&body) else {
        return invalid_input();
    };
    let Ok(message) = MessageId::parse(body.message_id) else {
        return not_found();
    };
    let actor = ReactionActor::Agent {
        id: principal.agent().clone(),
        source: principal.source().cloned(),
    };
    mutate(&state.0, actor, message, body.emoji, change).await
}

async fn mutate<M, R, A>(
    state: &Inner<M, R, A>,
    actor: ReactionActor,
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
    let occurred_at_ms = match SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .ok()
        .and_then(|duration| i64::try_from(duration.as_millis()).ok())
    {
        Some(value) => value,
        None => return internal_error("system time is outside reaction storage range"),
    };
    let command = ReactionMutation::new(actor, message, emoji, change, occurred_at_ms);
    match change_reaction(&state.mutation, &state.aftermath, command).await {
        Ok(Ok(outcome)) => mutation_success(&outcome),
        Ok(Err(refusal)) => mutation_refusal(refusal),
        Err(error) => {
            tracing::error!(error_chain = %crate::error::describe(&error), "reaction mutation failed");
            internal_error_response()
        }
    }
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
