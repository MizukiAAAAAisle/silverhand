//! Authenticated participant-handle availability probe:
//! `GET /api/agents/name-availability?name=`.
//!
//! A create-form onBlur check for the agent-create dialog. It shares ONE predicate
//! with every create path in the shared @-handle namespace — the agents∪users
//! [`HandleNamespaceRead`] authority behind [`probe_participant_handle`] — so the
//! form can never report `available` for a handle create would reject. The three
//! arms map to the wire's `{available, reason}` pair, projected from a SINGLE enum
//! so the contradictory combination (`available: true` with `reason: "taken"`) is
//! unrepresentable, matching the product `NameAvailabilityDtoSchema` refinement.
//!
//! The verdict is viewer-INDEPENDENT (handle uniqueness is global), so nothing about
//! it varies by principal. The authenticated principal is nonetheless demanded — its
//! absence is a composition fault that takes the lane's safe `500` — because a route
//! whose result does not vary by viewer has no natural reminder it sits behind the
//! perimeter, so the requirement is made structural here, mirroring the TypeScript
//! route's `getUserPrincipal(c)` authed-user gate.
//!
//! Every format refusal — empty (an absent or blank `?name=`), a non-letter lead, a
//! character outside the ASCII grammar, over the 64 cap — collapses to one
//! `{available:false, reason:"invalid"}` at HTTP `200`. This endpoint does NOT
//! publish WHICH rule refused. The status is always `200`: an unusable handle is a
//! product answer carried in `reason`, never a `4xx`.
//!
//! Registered as a STATIC segment under `/api/agents`; when merged alongside the
//! `/api/agents/{id}` detail route, axum resolves this static path in preference to
//! the dynamic one, so the probe is never shadowed regardless of merge order — the
//! same precedence the TypeScript route secures by registering it first.

use axum::{
    Json, Router,
    extract::{Extension, Query, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::get,
};
use serde::{Deserialize, Serialize};
use silverhand_backend_core::{
    human_auth_flows::HandleNamespaceRead,
    identity::UserId,
    participant_handle_availability::{ParticipantHandleAvailability, probe_participant_handle},
};

use crate::error;

/// The product route template. A STATIC segment under `/api/agents`.
pub const AGENT_NAME_AVAILABILITY_PATH: &str = "/api/agents/name-availability";

/// The unmapped-error body: an unexpected failure falls to the framework default —
/// a `500` with a bare `text/plain` `Internal Server Error`, never a JSON envelope.
const INTERNAL_ERROR_BODY: &str = "Internal Server Error";

/// Mounts the probe generic over the handle-namespace port, so tests drive it with a
/// driver-free fake and the composition root wires the SQLite `SqliteHandleNamespace`
/// adapter. Route registration into the served application is a separate integration
/// seam.
pub fn router<N>(namespace: N) -> Router
where
    N: HandleNamespaceRead,
{
    Router::new()
        .route(AGENT_NAME_AVAILABILITY_PATH, get(probe::<N>))
        .with_state(namespace)
}

async fn probe<N>(
    Query(query): Query<NameQuery>,
    viewer: Option<Extension<UserId>>,
    State(namespace): State<N>,
) -> Response
where
    N: HandleNamespaceRead,
{
    if viewer.is_none() {
        tracing::error!("agent name-availability route reached without its human principal fact");
        return (StatusCode::INTERNAL_SERVER_ERROR, INTERNAL_ERROR_BODY).into_response();
    }
    // Absent `?name=` is the empty string, exactly as the TypeScript
    // `c.req.query('name') ?? ''`; the parse then refuses it as `invalid`.
    let raw = query.name.unwrap_or_default();
    match probe_participant_handle(&namespace, &raw).await {
        Ok(verdict) => Json(NameAvailabilityDto::from(verdict)).into_response(),
        Err(cause) => {
            tracing::error!(
                error_chain = %error::describe(&cause),
                "agent name-availability probe failed"
            );
            (StatusCode::INTERNAL_SERVER_ERROR, INTERNAL_ERROR_BODY).into_response()
        }
    }
}

/// The single query parameter, read the framework-native way. A repeated `name`
/// key is a `400` (a frontend bug), never a silent last-wins.
#[derive(Deserialize)]
struct NameQuery {
    name: Option<String>,
}

/// `{ available, reason }`, mirroring `NameAvailabilityDtoSchema`. Both fields are
/// projected from the one [`ParticipantHandleAvailability`] arm in a single match,
/// so the schema's `available ⇔ reason === 'available'` invariant is a property of
/// the mapping rather than something route discipline must maintain.
#[derive(Serialize)]
struct NameAvailabilityDto {
    available: bool,
    reason: &'static str,
}

impl From<ParticipantHandleAvailability> for NameAvailabilityDto {
    fn from(verdict: ParticipantHandleAvailability) -> Self {
        match verdict {
            ParticipantHandleAvailability::Available => Self {
                available: true,
                reason: "available",
            },
            ParticipantHandleAvailability::Taken => Self {
                available: false,
                reason: "taken",
            },
            ParticipantHandleAvailability::Invalid => Self {
                available: false,
                reason: "invalid",
            },
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{
        body::{Body, to_bytes},
        http::Request,
    };
    use serde_json::{Value, json};
    use silverhand_backend_core::{persistence::PersistenceFailure, user_identity::ParticipantHandle};
    use tower::ServiceExt;

    #[derive(Clone)]
    enum FakeNamespace {
        Taken,
        Free,
        Fails,
    }

    impl HandleNamespaceRead for FakeNamespace {
        async fn is_handle_taken(
            &self,
            handle: &ParticipantHandle,
        ) -> Result<bool, PersistenceFailure> {
            let _ = handle;
            match self {
                FakeNamespace::Taken => Ok(true),
                FakeNamespace::Free => Ok(false),
                FakeNamespace::Fails => {
                    #[derive(Debug, thiserror::Error)]
                    #[error("namespace unavailable")]
                    struct Down;
                    Err(PersistenceFailure::from_source(Down))
                }
            }
        }
    }

    async fn probe_request(
        namespace: FakeNamespace,
        query: &str,
        with_principal: bool,
    ) -> (StatusCode, Value) {
        let mut request = Request::builder().uri(format!("{AGENT_NAME_AVAILABILITY_PATH}?{query}"));
        if with_principal {
            request = request.extension(UserId::parse("user-1").unwrap());
        }
        let response = router(namespace)
            .oneshot(request.body(Body::empty()).unwrap())
            .await
            .unwrap();
        let status = response.status();
        let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        let value = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
        (status, value)
    }

    #[tokio::test]
    async fn a_free_handle_is_available_at_200() {
        let (status, body) = probe_request(FakeNamespace::Free, "name=Alice_9-x", true).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body, json!({ "available": true, "reason": "available" }));
    }

    #[tokio::test]
    async fn a_held_handle_is_taken_at_200() {
        let (status, body) = probe_request(FakeNamespace::Taken, "name=alice", true).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body, json!({ "available": false, "reason": "taken" }));
    }

    #[tokio::test]
    async fn every_format_refusal_is_invalid_at_200_never_a_4xx() {
        // absent param, empty value, non-letter lead, illegal character, and over the
        // 64 cap all collapse to the same invalid answer at 200 — the endpoint
        // publishes no distinction between them, and never touches the namespace.
        let sixty_five_a = "a".repeat(65);
        let cases = [
            String::new(),                  // absent `name`
            "name=".to_owned(),             // empty value
            "name=1abc".to_owned(),         // non-letter lead
            "name=a%20b".to_owned(),        // space (outside the grammar)
            "name=%40alice".to_owned(),     // leading `@` (display alias, not stored)
            format!("name={sixty_five_a}"), // over the 64 cap
        ];
        for query in cases {
            // `Taken` would answer `taken` for any handle that reached it; proving the
            // verdict is `invalid` proves the malformed input short-circuited before
            // the lookup.
            let (status, body) = probe_request(FakeNamespace::Taken, &query, true).await;
            assert_eq!(status, StatusCode::OK, "{query:?}");
            assert_eq!(
                body,
                json!({ "available": false, "reason": "invalid" }),
                "{query:?}"
            );
        }
    }

    #[tokio::test]
    async fn a_missing_principal_is_a_safe_500_not_a_product_answer() {
        let (status, _) = probe_request(FakeNamespace::Free, "name=alice", false).await;
        assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR);
    }

    #[tokio::test]
    async fn a_namespace_failure_is_a_safe_500_with_no_driver_detail() {
        let response = router(FakeNamespace::Fails)
            .oneshot(
                Request::builder()
                    .uri(format!("{AGENT_NAME_AVAILABILITY_PATH}?name=alice"))
                    .extension(UserId::parse("user-1").unwrap())
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::INTERNAL_SERVER_ERROR);
        let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        assert_eq!(&bytes[..], b"Internal Server Error");
    }
}
