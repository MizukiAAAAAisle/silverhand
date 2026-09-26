//! `GET /internal/agents/{aid}/profile` — an agent reading its OWN profile.
//!
//! ## The `{aid}` binding is structural, and it is the credential layer's
//!
//! This route sits behind [`require_runtime_credential`](crate::host_runtime::runtime_credential::require_runtime_credential):
//! that layer authenticates the runtime bearer, extracts the `{aid}` path
//! segment, and admits the request ONLY when the token's own agent equals that
//! `{aid}` (a mismatch is an indistinguishable `401`, never a `403` that would
//! confirm the other agent exists). So by the time this handler runs the
//! principal is already pinned to `{aid}`; the handler reads the profile of
//! `credential.agent()` and takes no path param of its own — there is no wire
//! value it could read the wrong agent from. A caller who is not the pinned self
//! never reaches the reader at all.
//!
//! The row is the reader's own: [`read_self_profile`] binds the returned row's id
//! back to the requested agent, so a dishonest reader is a safe `500`, never a
//! different agent's profile. An absent row is the product `404`; a persistence
//! or source fault is the lane's safe `500`.

use axum::{
    Json, Router,
    extract::{Extension, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::get,
};
use serde::Serialize;
use silverhand_backend_core::{
    host_runtime::runtime_credential::RuntimePrincipal,
    identity_access::agent_profile_read::{
        AgentProfileReadModel, ProfileReadFault, read_self_profile,
    },
};

use super::agent_profile_wire::{AgentProfileDto, agent_profile_dto};
use crate::foundation::error;

/// The product route template. `{aid}` is consumed by the credential layer, which
/// self-pins it; this handler trusts the resulting principal.
pub const SELF_PROFILE_PATH: &str = "/internal/agents/{aid}/profile";

/// The unmapped-error body: a bare `text/plain` `500`, never a JSON envelope.
const INTERNAL_ERROR_BODY: &str = "Internal Server Error";

/// Mount the self-profile read generic over the read port, so tests drive it with
/// a driver-free fake and the composition root wires the SQLite adapter AND the
/// runtime-credential layer that self-pins `{aid}`. This builder yields the bare route;
/// the composition root (backend-app, #2234 CP7a) registers it and composes that layer
/// in front.
pub fn self_profile_router<R>(reader: R) -> Router
where
    R: AgentProfileReadModel + Clone + Send + Sync + 'static,
{
    Router::new()
        .route(SELF_PROFILE_PATH, get(self_profile::<R>))
        .with_state(reader)
}

/// `{ profile: <AgentProfileDto> }` — the exact envelope the CLI reads.
#[derive(Serialize)]
struct SelfProfileResponse {
    profile: AgentProfileDto,
}

async fn self_profile<R>(
    credential: Option<Extension<RuntimePrincipal>>,
    State(reader): State<R>,
) -> Response
where
    R: AgentProfileReadModel,
{
    // The principal is read, never derived. Absent means the credential layer was
    // not composed in front of this route — a composition fault, the safe `500`,
    // never a `401` (that verdict is the layer's alone).
    let Some(Extension(credential)) = credential else {
        tracing::error!("self-profile route reached without its runtime credential");
        return (StatusCode::INTERNAL_SERVER_ERROR, INTERNAL_ERROR_BODY).into_response();
    };
    // The subject is the pinned self, never a wire value.
    let subject = credential.agent();

    match read_self_profile(&reader, subject).await {
        Ok(Some(fact)) => Json(SelfProfileResponse {
            profile: agent_profile_dto(&fact),
        })
        .into_response(),
        // The authenticated agent has no committed row — the product `404`.
        Ok(None) => (
            StatusCode::NOT_FOUND,
            Json(serde_json::json!({ "error": "agent not found" })),
        )
            .into_response(),
        // A persistence fault OR a source-binding violation (the reader handed
        // back a row that is not this agent) is the lane's safe `500`, its cause
        // logged once and never leaked. `ProfileReadFault` is not itself an
        // `Error`, so we describe whichever inner cause it carries.
        Err(fault) => {
            let cause: &dyn std::error::Error = match &fault {
                ProfileReadFault::Persistence(failure) => failure,
                ProfileReadFault::Source(violation) => violation,
            };
            tracing::error!(
                error_chain =
                    crate::foundation::safe_log_field::safe_display(&(error::describe(cause))),
                "self-profile read failed"
            );
            (StatusCode::INTERNAL_SERVER_ERROR, INTERNAL_ERROR_BODY).into_response()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{
        body::{Body, to_bytes},
        http::{Request, header::AUTHORIZATION},
    };
    use serde_json::{Value, json};
    use silverhand_backend_core::{
        conversation_messaging::messaging::AvatarRevision,
        foundation::identity::{AgentId, DaemonInstanceId},
        foundation::persistence::PersistenceFailure,
        host_runtime::runtime_credential::{
            RuntimeCustody, RuntimeGeneration, RuntimePrincipal, RuntimeScope,
        },
        identity_access::agent_profile_read::AgentProfileFact,
    };
    use std::{
        collections::HashMap,
        sync::{
            Arc, Mutex,
            atomic::{AtomicBool, Ordering},
        },
    };
    use tower::ServiceExt;

    use crate::host_runtime::runtime_credential::{
        AuthenticateRuntimeCredential, RuntimeBearer, require_runtime_credential,
    };

    /// A read port that records whether — and for which agent — it was consulted,
    /// so a test can prove a non-self caller never reaches it. Cloneable via a
    /// shared `Arc`, so the copy `with_state` holds observes the same flag.
    #[derive(Clone)]
    struct RecordingReader {
        inner: Arc<ReaderInner>,
    }

    struct ReaderInner {
        rows: HashMap<String, AgentProfileFact>,
        consulted: AtomicBool,
        asked_for: Mutex<Vec<String>>,
    }

    impl RecordingReader {
        fn with(rows: impl IntoIterator<Item = AgentProfileFact>) -> Self {
            Self {
                inner: Arc::new(ReaderInner {
                    rows: rows
                        .into_iter()
                        .map(|fact| (fact.id.as_str().to_string(), fact))
                        .collect(),
                    consulted: AtomicBool::new(false),
                    asked_for: Mutex::new(Vec::new()),
                }),
            }
        }

        fn consulted(&self) -> bool {
            self.inner.consulted.load(Ordering::SeqCst)
        }

        fn asked_for(&self) -> Vec<String> {
            self.inner.asked_for.lock().unwrap().clone()
        }
    }

    impl AgentProfileReadModel for RecordingReader {
        async fn read_agent_profile(
            &self,
            agent: &AgentId,
        ) -> Result<Option<AgentProfileFact>, PersistenceFailure> {
            self.inner.consulted.store(true, Ordering::SeqCst);
            self.inner
                .asked_for
                .lock()
                .unwrap()
                .push(agent.as_str().to_string());
            Ok(self.inner.rows.get(agent.as_str()).cloned())
        }

        async fn read_agent_profile_by_handle(
            &self,
            _handle: &str,
        ) -> Result<Option<AgentProfileFact>, PersistenceFailure> {
            unreachable!("the self-profile route never reads by handle")
        }
    }

    fn agent(id: &str) -> AgentId {
        AgentId::parse(id).expect("agent id")
    }

    fn fact(id: &str, name: &str, avatar: Option<i64>) -> AgentProfileFact {
        AgentProfileFact {
            id: agent(id),
            name: name.to_string(),
            display_name: name.to_string(),
            description: Some("a bio".to_string()),
            avatar: avatar.map(AvatarRevision::at),
        }
    }

    fn principal(id: &str) -> RuntimePrincipal {
        RuntimePrincipal::for_scope(
            RuntimeScope::AgentSlot { agent: agent(id) },
            RuntimeCustody::new(
                RuntimeGeneration::new(1).unwrap(),
                DaemonInstanceId::parse("daemon-1").unwrap(),
            ),
        )
    }

    /// Drives the bare handler with the principal already injected (as the layer
    /// would), so these cases isolate the handler from the credential layer.
    async fn injected(reader: RecordingReader, credential: Option<RuntimePrincipal>) -> Response {
        let mut request = Request::builder().uri("/internal/agents/a1/profile");
        if let Some(credential) = credential {
            request = request.extension(credential);
        }
        self_profile_router(reader)
            .oneshot(request.body(Body::empty()).unwrap())
            .await
            .unwrap()
    }

    async fn body_json(response: Response) -> Value {
        let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        serde_json::from_slice(&bytes).unwrap_or(Value::Null)
    }

    #[tokio::test]
    async fn no_avatar_is_null_not_omitted() {
        let reader = RecordingReader::with([fact("a1", "agent-one", None)]);
        let response = injected(reader, Some(principal("a1"))).await;
        assert_eq!(response.status(), StatusCode::OK);
        let profile = body_json(response).await;
        assert_eq!(profile["profile"].get("avatar_url"), Some(&Value::Null));
    }

    #[tokio::test]
    async fn a_missing_self_row_is_a_404() {
        let reader = RecordingReader::with([]);
        let response = injected(reader, Some(principal("a1"))).await;
        assert_eq!(response.status(), StatusCode::NOT_FOUND);
    }

    /// Composition short-circuit: absent credential is the safe `500`, and the
    /// reader is NEVER consulted — a route reached without its layer must not read.
    #[tokio::test]
    async fn an_absent_credential_is_a_safe_500_and_never_reads() {
        let reader = RecordingReader::with([fact("a1", "agent-one", Some(1))]);
        let response = injected(reader.clone(), None).await;
        assert_eq!(response.status(), StatusCode::INTERNAL_SERVER_ERROR);
        assert!(!reader.consulted(), "no credential means no read");
    }

    /// A faithful stand-in for the runtime-credential authority: it self-pins,
    /// admitting a request ONLY when the route's `{aid}` equals its one enrolled
    /// agent (exactly the production rule, `principal.agent() != route_agent →
    /// None`). It stands in for the authority's internals — those are pinned in
    /// `runtime_credential.rs` — so this test proves the WIRING: the layer is in
    /// front of the route and runs before the handler.
    #[derive(Clone)]
    struct PinnedAuthority {
        enrolled: AgentId,
    }

    impl AuthenticateRuntimeCredential for PinnedAuthority {
        async fn authenticate_runtime(
            &self,
            _bearer: RuntimeBearer,
            route_agent: AgentId,
        ) -> Result<Option<RuntimePrincipal>, PersistenceFailure> {
            if route_agent == self.enrolled {
                Ok(Some(principal(self.enrolled.as_str())))
            } else {
                Ok(None)
            }
        }
    }

    async fn behind_layer(reader: RecordingReader, path_aid: &str) -> Response {
        let authority = PinnedAuthority {
            enrolled: agent("a1"),
        };
        let router = require_runtime_credential(self_profile_router(reader), authority);
        let request = Request::builder()
            .uri(format!("/internal/agents/{path_aid}/profile"))
            .header(AUTHORIZATION, "Bearer test-secret")
            .body(Body::empty())
            .unwrap();
        router.oneshot(request).await.unwrap()
    }

    #[tokio::test]
    async fn the_pinned_self_reaches_the_reader_at_200() {
        let reader = RecordingReader::with([fact("a1", "agent-one", Some(2500))]);
        let response = behind_layer(reader.clone(), "a1").await;
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(
            body_json(response).await,
            json!({
                "profile": {
                    "id": "a1",
                    "name": "agent-one",
                    "display_name": "agent-one",
                    "description": "a bio",
                    "avatar_url": "/api/agents/a1/avatar?v=2500"
                }
            })
        );
        assert!(reader.consulted(), "the pinned self is read");
        assert_eq!(reader.asked_for(), vec!["a1".to_string()]);
    }

    /// Self-pin short-circuit: a caller whose token is for `a1` but whose `{aid}`
    /// is another agent is refused by the layer with `401` BEFORE the handler
    /// runs, so the reader is never consulted for the other agent.
    #[tokio::test]
    async fn a_non_self_aid_is_401_before_the_reader() {
        let reader = RecordingReader::with([fact("a1", "agent-one", Some(2500))]);
        let response = behind_layer(reader.clone(), "someone-else").await;
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
        assert!(
            !reader.consulted(),
            "a non-self caller must never reach the reader"
        );
    }
}
