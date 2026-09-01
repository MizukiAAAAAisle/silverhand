//! Human-session first-send boundary for a direct pair.
//!
//! The route is deliberately ordered as authority -> bounded body admission ->
//! canonical pair allocation/publication -> the existing message-send unit.
//! Every side-effect-free refusal therefore precedes allocation. Once allocation
//! wins, a later send refusal does not compensate the already committed and
//! announced pair; the cold direct-pair list remains the existence authority.

use std::sync::Arc;

use axum::{
    Json, Router,
    extract::{Extension, Path, Request, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::post,
};
use serde_json::json;
use silverhand_backend_core::{
    conversation_messaging::messaging::{
        DirectLineAuthority, SendActor, SendDestination, SendMessageOutcome, SendMessageUnitOfWork,
        collaboration::direct_pair_initiation::{
            DirectPairFirstSendError, DirectPairInitiationPort, DirectPairInitiationRefusal,
            authorize_direct_pair_initiation,
        },
    },
    foundation::identity::{AgentId, UserId},
};

use crate::messaging::{
    ack::send_ack,
    admission::{PayloadRefusal, validate_human_payload},
    aftermath::SendAftermath,
    envelope::{BodyRead, read_message_send_body},
    execute::{ResolvedSendContext, execute},
    outcome::refused_send,
    references::MarkdownReferencePositions,
    send_request::{envelope_too_large, human_content_too_large},
};

pub const DIRECT_PAIR_INITIATION_PATH: &str = "/api/agents/{id}/direct-messages";

struct Inner<I, D, U, F> {
    initiation: I,
    direct_lines: D,
    unit_of_work: U,
    aftermath: F,
}

struct InitiationState<I, D, U, F>(Arc<Inner<I, D, U, F>>);

impl<I, D, U, F> Clone for InitiationState<I, D, U, F> {
    fn clone(&self) -> Self {
        Self(Arc::clone(&self.0))
    }
}

/// The isolated POST leaf. The executable mount supplies authenticated human
/// identity and the real event/send adapters at the integration seam.
pub fn router<I, D, U, F>(initiation: I, direct_lines: D, unit_of_work: U, aftermath: F) -> Router
where
    I: DirectPairInitiationPort + Send + Sync + 'static,
    D: DirectLineAuthority + Send + Sync + 'static,
    U: SendMessageUnitOfWork + Send + Sync + 'static,
    F: SendAftermath + Send + Sync + 'static,
{
    Router::new()
        .route(DIRECT_PAIR_INITIATION_PATH, post(initiate::<I, D, U, F>))
        .with_state(InitiationState(Arc::new(Inner {
            initiation,
            direct_lines,
            unit_of_work,
            aftermath,
        })))
}

async fn initiate<I, D, U, F>(
    State(state): State<InitiationState<I, D, U, F>>,
    principal: Option<Extension<UserId>>,
    Path(raw_target): Path<String>,
    request: Request,
) -> Response
where
    I: DirectPairInitiationPort + Send + Sync,
    D: DirectLineAuthority + Send + Sync,
    U: SendMessageUnitOfWork + Send + Sync,
    F: SendAftermath + Send + Sync,
{
    let Some(Extension(viewer)) = principal else {
        tracing::error!("direct-pair initiation route reached without human principal");
        return internal();
    };
    let Ok(target) = AgentId::parse(raw_target) else {
        return error(StatusCode::BAD_REQUEST, "agent id required");
    };

    let authorized =
        match authorize_direct_pair_initiation(&state.0.initiation, viewer.clone(), target).await {
            Ok(Ok(authorized)) => authorized,
            Ok(Err(DirectPairInitiationRefusal::NotFound)) => {
                return error(StatusCode::NOT_FOUND, "not found");
            }
            Ok(Err(DirectPairInitiationRefusal::Forbidden)) => {
                return error(StatusCode::FORBIDDEN, "forbidden");
            }
            Err(failure) => {
                tracing::error!(
                    error_chain = %crate::error::describe(&failure),
                    "direct-pair initiation authority failed"
                );
                return internal();
            }
        };

    // Unlike the ordinary send doors, this route's authority is intentionally
    // ahead of body polling. The helper still applies their single body bound.
    let raw_body = match read_message_send_body(request).await {
        BodyRead::Within(bytes) => serde_json::from_slice(&bytes).ok(),
        BodyRead::OverCap => return envelope_too_large().into_response(),
        // Production TS catches a non-limit JSON/body failure as `{}` before
        // schema admission. `None` is that same empty-document input here.
        BodyRead::Unreadable(_) => None,
    };
    let admitted = match validate_human_payload(raw_body) {
        Ok(admitted) => admitted,
        Err(refusal) => return refuse_payload(refusal),
    };
    // TS refuses a reply target (400 `reply_to_unsupported`) BEFORE it meets the content
    // cap (413). Admission has only refined so far; the cap is stage two, sealed below,
    // so this door checks the reply target in between and restores the reference order.
    // A direct pair has no cluster to reply into, so any reply target is a client error.
    if admitted.reply_to().is_some() {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({
                "error": "cannot open a direct-message line into a reply cluster",
                "code": "reply_to_unsupported",
            })),
        )
            .into_response();
    }
    // STAGE TWO — the content cap, run only now that the reply target has been refused.
    let payload = match admitted.seal() {
        Ok(payload) => payload,
        Err(refusal) => return refuse_payload(refusal),
    };

    let inner = Arc::clone(&state.0);
    let send_inner = Arc::clone(&inner);
    let result = inner
        .initiation
        .open_and_send(authorized, |opened| async move {
            let conversation = opened.conversation().clone();
            execute(
                ResolvedSendContext::resolved(
                    SendActor::User(viewer),
                    conversation.clone(),
                    conversation,
                    SendDestination::MainLine,
                    false,
                ),
                payload,
                &MarkdownReferencePositions,
                &send_inner.direct_lines,
                &send_inner.unit_of_work,
                &send_inner.aftermath,
            )
            .await
        })
        .await;

    match result {
        Ok(outcome) => created(&outcome),
        Err(DirectPairFirstSendError::Send(failure)) => refused_send(&failure),
        Err(failure) => {
            tracing::error!(
                error_chain = %crate::error::describe(&failure),
                "direct-pair initiation failed before first-message send completed"
            );
            internal()
        }
    }
}

fn created(outcome: &SendMessageOutcome) -> Response {
    (StatusCode::CREATED, Json(send_ack(outcome))).into_response()
}

fn error(status: StatusCode, message: &'static str) -> Response {
    (status, Json(json!({"error": message}))).into_response()
}

/// The two payload stages — refine (shape/says-nothing) and seal (content cap) — refuse
/// with the same [`PayloadRefusal`], and this door renders each to the identical wire
/// wherever it was raised. Splitting the stages moved WHEN the cap runs, never WHAT it
/// answers.
fn refuse_payload(refusal: PayloadRefusal) -> Response {
    match refusal {
        PayloadRefusal::Invalid => crate::wire_admission::invalid_input(),
        PayloadRefusal::ContentTooLarge { actual_bytes } => {
            human_content_too_large(actual_bytes).into_response()
        }
    }
}

fn internal() -> Response {
    (
        StatusCode::INTERNAL_SERVER_ERROR,
        [(
            axum::http::header::CONTENT_TYPE,
            "text/plain; charset=utf-8",
        )],
        "Internal Server Error",
    )
        .into_response()
}

#[cfg(test)]
mod tests;
