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
    extract::{Extension, Path, State},
    response::{IntoResponse, Response},
    routing::post,
};
use serde::Deserialize;
use silverhand_backend_core::{
    host_runtime::runtime_credential::RuntimePrincipal,
    identity::{AgentId, UserId},
    messaging::MessageId,
    messaging::collaboration::reaction::{
        ReactionAftermath, ReactionChange, ReactionEmoji, ReactionMutation, ReactionMutationPort,
        ReactionReadPort, change_reaction,
    },
};

use crate::wire_admission::{ValidatedJson, ValidatedJsonRejection, invalid_input};
use wire::{
    AgentReactRaw, HumanReactRaw, detail_success, internal_error, internal_error_response,
    invalid_reaction, mutation_refusal, mutation_success, not_found,
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
    human_routes(state.clone()).merge(agent_routes(state))
}

/// The human-session half of the reaction capability. Kept as its own factory so the
/// composition root cannot accidentally place the internal-agent face behind the human
/// perimeter merely because both methods share one application state shape.
pub fn human_router<M, R, A>(mutation: M, reads: R, aftermath: A) -> Router
where
    M: ReactionMutationPort + Send + Sync + 'static,
    R: ReactionReadPort + Send + Sync + 'static,
    A: ReactionAftermath + Send + Sync + 'static,
{
    human_routes(ReactionState(Arc::new(Inner {
        mutation,
        reads,
        aftermath,
    })))
}

/// The runtime-credential half of the reaction capability. Its separate factory is the
/// perimeter boundary; production still passes clones of the same mutation/read/event
/// authorities used by [`human_router`].
pub fn agent_router<M, R, A>(mutation: M, reads: R, aftermath: A) -> Router
where
    M: ReactionMutationPort + Send + Sync + 'static,
    R: ReactionReadPort + Send + Sync + 'static,
    A: ReactionAftermath + Send + Sync + 'static,
{
    agent_routes(ReactionState(Arc::new(Inner {
        mutation,
        reads,
        aftermath,
    })))
}

fn human_routes<M, R, A>(state: ReactionState<M, R, A>) -> Router
where
    M: ReactionMutationPort + Send + Sync + 'static,
    R: ReactionReadPort + Send + Sync + 'static,
    A: ReactionAftermath + Send + Sync + 'static,
{
    Router::new()
        .route(
            HUMAN_PATH,
            post(human_add::<M, R, A>)
                .delete(human_remove::<M, R, A>)
                .get(human_detail::<M, R, A>),
        )
        .with_state(state)
}

fn agent_routes<M, R, A>(state: ReactionState<M, R, A>) -> Router
where
    M: ReactionMutationPort + Send + Sync + 'static,
    R: ReactionReadPort + Send + Sync + 'static,
    A: ReactionAftermath + Send + Sync + 'static,
{
    Router::new()
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
    body: Result<ValidatedJson<HumanReactRaw>, ValidatedJsonRejection>,
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
    body: Result<ValidatedJson<HumanReactRaw>, ValidatedJsonRejection>,
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
    body: Result<ValidatedJson<HumanReactRaw>, ValidatedJsonRejection>,
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
    // The message coordinate is decided before the body, preserving the base anti-enumeration
    // ladder (an unresolvable path id is an indistinguishable 404 that never depends on body
    // validity). `MessageId::parse` only rejects an empty segment, which the router makes
    // unreachable here — but the ordering is kept rather than inverted by this migration.
    let Ok(message) = MessageId::parse(path.id) else {
        return not_found();
    };
    // A structural body fault keeps its native rejection (400/415/422); there is no
    // garde rule on the DTO, so the semantic arm never fires here.
    let body = match body {
        Ok(ValidatedJson(body)) => body,
        Err(rejection) => return rejection.into_response(),
    };
    mutate_human(&state.0, viewer, message, body.emoji, change).await
}

async fn agent_add<M, R, A>(
    state: State<ReactionState<M, R, A>>,
    principal: Option<Extension<RuntimePrincipal>>,
    path: Path<AgentPath>,
    body: Result<ValidatedJson<AgentReactRaw>, ValidatedJsonRejection>,
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
    body: Result<ValidatedJson<AgentReactRaw>, ValidatedJsonRejection>,
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
    body: Result<ValidatedJson<AgentReactRaw>, ValidatedJsonRejection>,
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
    // Identity is self-pinned: a path agent that is not the authenticated principal is an
    // indistinguishable 404 before the body is consulted — the path coordinate never
    // overrides the credential.
    if principal.agent() != &path_agent {
        return not_found();
    }
    // A structural body fault keeps its native rejection; no garde rule fires here.
    let body = match body {
        Ok(ValidatedJson(body)) => body,
        Err(rejection) => return rejection.into_response(),
    };
    // `message_id` grammar is a domain verdict, not an admission rule: an empty/malformed id
    // collapses to the minimal semantic 422, never a panic. The emoji stays deferred so an
    // invalid emoji paired with a hidden/unauthorized target still refuses 404/403.
    let Ok(message) = MessageId::parse(body.message_id) else {
        return invalid_input();
    };
    mutate_agent(
        &state.0,
        principal.agent().clone(),
        principal.source().cloned(),
        message,
        body.emoji,
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
    let emoji = ReactionEmoji::parse(&raw_emoji);
    drop(raw_emoji);
    execute_mutation(
        state,
        ReactionMutation::agent(actor, source, message, emoji, change, occurred_at_ms),
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
