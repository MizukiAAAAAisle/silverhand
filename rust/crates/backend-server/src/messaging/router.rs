//! The product create-message router: the surface the two doors hang on.
//!
//! This is the module's only public face. Mounting the doors here gives the admission
//! and execute stages real callers, which is why the transient `dead_code` allows die
//! with this file rather than before it — a lint quieted by a fake call site would have
//! hidden exactly this gap.
//!
//! **DEFINED IS NOT MOUNTED** (@Cindy). Exporting a router is not wiring one into the
//! production composition, and nothing here does the latter: no composition root builds
//! this, and there is no authentication middleware to populate the principal extensions
//! it requires. The product paths therefore remain unreachable in a running server, and
//! no parity may be claimed from this file's existence.
//!
//! **NOR IS IT COMPLETE.** A COMMITTED send has no acknowledgement to answer with yet —
//! see [`outcome_not_projected`] for what happens instead and why it is not dressed up as
//! a contract. A send that FAILED is projected properly, by [`super::outcome`].
//!
//! IDENTITY ARRIVES ALREADY AUTHENTICATED. A parent authentication middleware verifies
//! the caller and injects a request-scoped principal fact; a handler here only READS
//! one. That is a different question from this route's own authorization, which is the
//! human door's 404/403 and the agent door's target capability. Conflating them would
//! put a second auth boundary inside the send path.

use axum::{
    Json, Router,
    extract::{Path, Request, State},
    http::StatusCode,
    middleware,
    response::{IntoResponse, Response},
    routing::post,
};
use silverhand_backend_core::messaging::{
    AgentId, ConversationId, DirectLineAuthority, SendMessageUnitOfWork, UserId,
};
use std::sync::Arc;

use super::{
    adapters::{
        AgentRefusal, ChannelAccess, ChannelAccessRefusal, HumanRefusal, SendPorts, TargetAccess,
        TargetRefusal, agent_send, human_send,
    },
    admission::PayloadRefusal,
    envelope::fence_message_send_body,
    outcome::refused_send,
    references::MarkdownReferencePositions,
    send_request::{
        MESSAGE_SEND_MAX_BODY_BYTES, agent_content_too_large, human_content_too_large,
        invalid_input, missing_identifier,
    },
};

/// The authenticated human behind a request, injected upstream. Deliberately carries
/// only the identity: anything else it might carry would be a fact this door should ask
/// its own gates about.
#[derive(Clone, Debug)]
pub struct HumanPrincipal(pub UserId);

/// The authenticated agent behind a request, with the conversation its credential lives
/// in.
///
/// The source is part of the CREDENTIAL, not something to infer. An agent credential
/// without one may not be turned into a send by guessing — not from the address, not
/// from a default — so a composition that cannot supply it must refuse before the door.
#[derive(Clone, Debug)]
pub struct AgentPrincipal {
    pub agent: AgentId,
    pub source: ConversationId,
}

/// Everything the doors need, supplied by whoever composes them.
///
/// THE POSITION RULE IS NOT HERE, and that is the point. Where a body may address from is
/// product semantics — an autolink in prose, never quoted syntax and never someone else's
/// quoted words — so a composition that could swap it could decide that a name inside a
/// code span summons its subject, or that no body addresses anyone. The route uses the one
/// canonical rule and offers no way to replace it. The trait seam still exists in the domain,
/// where it lets the derivation be tested against a stand-in; a deployer is not a caller of
/// that seam (@Cindy, review of `be14df01`).
pub struct SendState<C, T, D, U> {
    pub channel_access: C,
    pub target_access: T,
    pub authority: D,
    pub unit_of_work: U,
}

/// The product routes, on the paths the reference uses.
pub fn send_router<C, T, D, U>(state: SendState<C, T, D, U>) -> Router
where
    C: ChannelAccess + Send + Sync + 'static,
    T: TargetAccess + Send + Sync + 'static,
    D: DirectLineAuthority + Send + Sync + 'static,
    U: SendMessageUnitOfWork + Send + Sync + 'static,
{
    Router::new()
        .route(
            "/api/channels/{id}/messages",
            post(human_route::<C, T, D, U>),
        )
        .route(
            "/internal/agents/{aid}/send-message",
            post(agent_route::<C, T, D, U>),
        )
        .with_state(Arc::new(state))
        .layer(middleware::from_fn(fence_message_send_body))
}

type Shared<C, T, D, U> = State<Arc<SendState<C, T, D, U>>>;

async fn human_route<C, T, D, U>(
    Path(id): Path<String>,
    State(state): Shared<C, T, D, U>,
    request: Request,
) -> Response
where
    C: ChannelAccess + Send + Sync + 'static,
    T: TargetAccess + Send + Sync + 'static,
    D: DirectLineAuthority + Send + Sync + 'static,
    U: SendMessageUnitOfWork + Send + Sync + 'static,
{
    // The principal is read, never derived. Absent means the composition is wrong.
    let Some(HumanPrincipal(author)) = request.extensions().get::<HumanPrincipal>().cloned() else {
        return composition_failure("human principal");
    };
    // The channel this send is for is the caller's own coordinate, checked by the gate
    // below rather than trusted here.
    let Ok(channel) = ConversationId::parse(id) else {
        return missing_identifier("channel id required").into_response();
    };
    let body = collected(request).await;

    match human_send(
        &channel,
        &author,
        body,
        &state.channel_access,
        SendPorts {
            positions: &MarkdownReferencePositions,
            authority: &state.authority,
            unit_of_work: &state.unit_of_work,
        },
    )
    .await
    {
        Ok(_) => outcome_not_projected("a committed human send"),
        Err(refusal) => human_wire(refusal),
    }
}

async fn agent_route<C, T, D, U>(
    Path(aid): Path<String>,
    State(state): Shared<C, T, D, U>,
    request: Request,
) -> Response
where
    C: ChannelAccess + Send + Sync + 'static,
    T: TargetAccess + Send + Sync + 'static,
    D: DirectLineAuthority + Send + Sync + 'static,
    U: SendMessageUnitOfWork + Send + Sync + 'static,
{
    // Presence only, and that is the whole of this parameter's role here. The path names
    // the CREDENTIAL, which is whoever authenticates the request's business; where the
    // words go is a required field of the body. Re-deriving either from this string
    // would be a second answer to a question that already has one.
    if aid.is_empty() {
        return missing_identifier("agent id required").into_response();
    }
    let Some(principal) = request.extensions().get::<AgentPrincipal>().cloned() else {
        return composition_failure("agent principal");
    };
    let body = collected(request).await;

    match agent_send(
        &principal.agent,
        &principal.source,
        body,
        &state.target_access,
        SendPorts {
            positions: &MarkdownReferencePositions,
            authority: &state.authority,
            unit_of_work: &state.unit_of_work,
        },
    )
    .await
    {
        Ok(_) => outcome_not_projected("a committed agent send"),
        Err(refusal) => agent_wire(refusal),
    }
}

/// The fence already bounded this body, so reading it here cannot be unbounded. An
/// unparseable body becomes `None`, which admission answers for.
async fn collected(request: Request) -> Option<serde_json::Value> {
    let bytes = axum::body::to_bytes(request.into_body(), MESSAGE_SEND_MAX_BODY_BYTES)
        .await
        .ok()?;
    serde_json::from_slice(&bytes).ok()
}

/// A principal the composition was supposed to supply is missing.
///
/// Reported ONCE and never to the caller, and deliberately NOT degraded into an
/// anonymous or default identity: attributing a send to the wrong principal is worse
/// than refusing it.
fn composition_failure(missing: &str) -> Response {
    tracing::error!(
        missing,
        "message-send route reached without its principal fact"
    );
    internal("Internal Server Error")
}

/// A COMMITTED SEND LANDS HERE, because its acknowledgement does not exist yet: the
/// reference answers with the whole committed-message payload, which needs the shared
/// author projection and the fact's terminal shape. Refusals no longer come through here
/// — [`super::outcome`] projects those — so this is the last piece of R10.
///
/// The answer is 501 rather than an invented one. A fabricated 201 body would be a shape a
/// client could parse and rely on, which would make the gap look filled. "This route
/// cannot yet produce the response the contract defines" is the only true thing to say,
/// and it is the concrete reason the router must not be mounted.
///
/// The send REALLY DID commit before this ran. The status cannot express that, which is
/// the whole point: the projection is missing, not optional.
fn outcome_not_projected(what: &str) -> Response {
    tracing::error!(
        outcome = what,
        "message-send outcome has no wire projection in this slice"
    );
    not_implemented()
}

/// The HUMAN door's gate refusals carry an `error` sentence and nothing else, because the
/// reference's own bodies here have none either — that door's two answers are about a channel
/// the caller named, and a code would be a distinction it does not draw.
fn gate_refusal(status: StatusCode, error: &'static str) -> Response {
    (status, Json(serde_json::json!({ "error": error }))).into_response()
}

/// The AGENT door's, which DO carry a code: an agent acts on which refusal it got, and the
/// CLI turns each into a different instruction — rewrite the address, stop and report, or ask
/// a human for a grant.
fn target_refusal(refusal: TargetRefusal) -> Response {
    let (status, error, code) = match refusal {
        TargetRefusal::Malformed => (
            StatusCode::BAD_REQUEST,
            "target is not an address",
            "target_malformed",
        ),
        TargetRefusal::SelfPair => (
            StatusCode::BAD_REQUEST,
            "a direct message needs another participant",
            "self_pair_not_addressable",
        ),
        TargetRefusal::Unresolved => (
            StatusCode::NOT_FOUND,
            "target names no stream you can use",
            "target_unresolved",
        ),
        TargetRefusal::ThreadNotInTarget => (
            StatusCode::NOT_FOUND,
            "target names no reply cluster of that conversation",
            "thread_not_in_target",
        ),
        TargetRefusal::OutOfSessionScope => (
            StatusCode::FORBIDDEN,
            "this operation acts only in the conversation your session is anchored to",
            "slot_out_of_scope",
        ),
        // ITS OWN BODY SHAPE, and not by accident: this one carries no `error` member and
        // names the missing bucket twice, top level and in `details`. The CLI preserves the
        // code verbatim only when it is present — a codeless 403 degrades to `forbidden` —
        // and it reads the bucket to tell the agent what a human has to grant.
        TargetRefusal::CapabilityDenied => return capability_denied(),
    };
    (
        status,
        Json(serde_json::json!({ "error": error, "code": code })),
    )
        .into_response()
}

/// The capability this door asks for. Named here rather than carried through the port: which
/// grant a send needs is this door's own fact, and a port that reported it could report a
/// different one.
const SEND_CAPABILITY: &str = "send_messages";

fn capability_denied() -> Response {
    (
        StatusCode::FORBIDDEN,
        Json(serde_json::json!({
            "code": "capability_denied",
            "capability": SEND_CAPABILITY,
            "message": format!("missing '{SEND_CAPABILITY}' capability in this workspace"),
            "details": { "capability": SEND_CAPABILITY },
        })),
    )
        .into_response()
}

fn not_implemented() -> Response {
    (
        StatusCode::NOT_IMPLEMENTED,
        [(
            axum::http::header::CONTENT_TYPE,
            "text/plain; charset=utf-8",
        )],
        "Not Implemented",
    )
        .into_response()
}

fn internal(body: &'static str) -> Response {
    (
        StatusCode::INTERNAL_SERVER_ERROR,
        [(
            axum::http::header::CONTENT_TYPE,
            "text/plain; charset=utf-8",
        )],
        body,
    )
        .into_response()
}

/// Each door maps ITS OWN reasons to its own words, and that mapping is the only thing
/// allowed to differ — which is why it lives at the route, not in the door. Neither
/// function has an arm for a reason its door cannot produce, because neither refusal
/// type can carry one.
fn human_wire(refusal: HumanRefusal) -> Response {
    match refusal {
        HumanRefusal::Access(ChannelAccessRefusal::NotFound) => {
            gate_refusal(StatusCode::NOT_FOUND, "channel not found")
        }
        HumanRefusal::Access(ChannelAccessRefusal::Forbidden) => {
            gate_refusal(StatusCode::FORBIDDEN, "forbidden")
        }
        HumanRefusal::Payload(PayloadRefusal::Shape(issues)) => {
            invalid_input(issues).into_response()
        }
        HumanRefusal::Payload(PayloadRefusal::ContentTooLarge { actual_bytes }) => {
            human_content_too_large(actual_bytes).into_response()
        }
        HumanRefusal::Send(cause) => refused_send(&cause),
    }
}

fn agent_wire(refusal: AgentRefusal) -> Response {
    match refusal {
        AgentRefusal::Payload(PayloadRefusal::Shape(issues)) => {
            invalid_input(issues).into_response()
        }
        AgentRefusal::Payload(PayloadRefusal::ContentTooLarge { actual_bytes }) => {
            agent_content_too_large(actual_bytes).into_response()
        }
        AgentRefusal::Target(refusal) => target_refusal(refusal),
        AgentRefusal::Send(cause) => refused_send(&cause),
    }
}
