//! Authenticated name-availability probe: `GET /api/workspaces/name-availability?name=`.
//!
//! A create-form onBlur check. It shares ONE uniqueness predicate with the create
//! path (the regular-workspace namespace behind
//! [`probe_workspace_name`]), so the form can never report `available` for a name
//! create would reject. The three arms map to the wire's `{available, reason}`
//! pair, which is projected from a SINGLE enum so the contradictory combination
//! (`available: true` with `reason: "taken"`) is unrepresentable — matching the
//! product `NameAvailabilityDtoSchema` `refine(available ⇔ reason==='available')`.
//!
//! The verdict is viewer-INDEPENDENT (uniqueness is global across regular
//! workspaces), so nothing about it varies by principal. The authenticated
//! principal is nonetheless demanded — its absence is a composition fault that
//! takes the lane's safe `500` — because a route whose result does not vary by
//! viewer has no natural reminder it sits behind the perimeter, so the requirement
//! is made structural here.
//!
//! Every format refusal — empty, over the 64 cap, a forbidden scalar, and the
//! cross-length cases (65–128 with a forbidden scalar, or over 128) — collapses to
//! one `{available:false, reason:"invalid"}` at HTTP `200`. This endpoint does NOT
//! publish WHICH rule refused, so the TS↔Rust refusal PRECEDENCE that separates
//! `forbidden_code_point` from `too_long` is not observable here; it becomes
//! observable only at the metadata-write admission (`PATCH`), where the Zod issue
//! code reaches the wire. The status is always `200`: an unusable name is a
//! product answer carried in `reason`, never a `4xx`.

use axum::{
    Json, Router,
    extract::{Extension, Query, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::get,
};
use serde::{Deserialize, Serialize};
use silverhand_backend_core::{
    identity::UserId,
    workspace_name_availability::{
        RegularWorkspaceNamespace, WorkspaceNameAvailability, probe_workspace_name,
    },
};

use crate::error;

/// The product route template. A STATIC segment under `/api/workspaces`; when it
/// is merged alongside the `/api/workspaces/{id}` detail route, axum's router
/// resolves this static path in preference to the dynamic one, so the probe is
/// never shadowed regardless of merge order (a precedence the detail module's
/// tests pin).
pub const WORKSPACE_NAME_AVAILABILITY_PATH: &str = "/api/workspaces/name-availability";

/// The unmapped-error body: an unexpected failure falls to the framework default —
/// a `500` with a bare `text/plain` `Internal Server Error`, never a JSON envelope.
const INTERNAL_ERROR_BODY: &str = "Internal Server Error";

/// Mounts the probe generic over the namespace port, so tests drive it with a
/// driver-free fake and the composition root wires the SQLite adapter. Route
/// registration into the served application is a separate integration seam.
pub fn router<N>(namespace: N) -> Router
where
    N: RegularWorkspaceNamespace + Clone + Send + Sync + 'static,
{
    Router::new()
        .route(WORKSPACE_NAME_AVAILABILITY_PATH, get(probe::<N>))
        .with_state(namespace)
}

async fn probe<N>(
    Query(query): Query<NameQuery>,
    viewer: Option<Extension<UserId>>,
    State(namespace): State<N>,
) -> Response
where
    N: RegularWorkspaceNamespace,
{
    if viewer.is_none() {
        tracing::error!("name-availability route reached without its human principal fact");
        return (StatusCode::INTERNAL_SERVER_ERROR, INTERNAL_ERROR_BODY).into_response();
    }
    // Absent `?name=` is the empty string, exactly as the TypeScript
    // `c.req.query('name') ?? ''`; the parse then refuses it as `invalid`.
    let raw = query.name.unwrap_or_default();
    match probe_workspace_name(&namespace, &raw).await {
        Ok(verdict) => Json(NameAvailabilityDto::from(verdict)).into_response(),
        Err(cause) => {
            tracing::error!(
                error_chain = %error::describe(&cause),
                "name-availability probe failed"
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
/// projected from the one [`WorkspaceNameAvailability`] arm in a single match, so
/// the schema's `available ⇔ reason === 'available'` invariant is a property of
/// the mapping rather than something route discipline must maintain.
#[derive(Serialize)]
struct NameAvailabilityDto {
    available: bool,
    reason: &'static str,
}

impl From<WorkspaceNameAvailability> for NameAvailabilityDto {
    fn from(verdict: WorkspaceNameAvailability) -> Self {
        match verdict {
            WorkspaceNameAvailability::Available => Self {
                available: true,
                reason: "available",
            },
            WorkspaceNameAvailability::Taken => Self {
                available: false,
                reason: "taken",
            },
            WorkspaceNameAvailability::Invalid => Self {
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
    use silverhand_backend_core::{
        persistence::PersistenceFailure,
        workspace_name::CanonicalWorkspaceName,
        workspace_name_availability::HeldName,
    };
    use tower::ServiceExt;

    #[derive(Clone)]
    enum FakeNamespace {
        Holding(String),
        Empty,
        Fails,
    }

    impl RegularWorkspaceNamespace for FakeNamespace {
        async fn holder_of_name(
            &self,
            name: &CanonicalWorkspaceName,
        ) -> Result<Option<HeldName>, PersistenceFailure> {
            match self {
                FakeNamespace::Holding(key) => Ok(Some(HeldName {
                    name_key: key.clone(),
                })),
                FakeNamespace::Empty => Ok(None),
                FakeNamespace::Fails => {
                    let _ = name;
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
        let mut request = Request::builder().uri(format!(
            "{WORKSPACE_NAME_AVAILABILITY_PATH}?{query}"
        ));
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
    async fn a_free_name_is_available_at_200() {
        let (status, body) =
            probe_request(FakeNamespace::Empty, "name=Design%20Team", true).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body, json!({ "available": true, "reason": "available" }));
    }

    #[tokio::test]
    async fn a_held_name_is_taken_at_200() {
        let (status, body) = probe_request(
            FakeNamespace::Holding("design team".to_owned()),
            "name=Design%20Team",
            true,
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body, json!({ "available": false, "reason": "taken" }));
    }

    #[tokio::test]
    async fn every_format_refusal_is_invalid_at_200_never_a_4xx() {
        // empty (absent param), forbidden scalar, over 64, AND the two cross-length
        // cases (65–128 + forbidden, and > 128) all collapse to the same invalid
        // answer at 200 — the endpoint publishes no distinction between them.
        let sixty_five_a = "a".repeat(65);
        let forbidden_in_envelope = format!("{}%E2%80%8D", "a".repeat(100)); // 100a + ZWJ (101 cp)
        let beyond_envelope = format!("{}%E2%80%8D", "a".repeat(200)); // 200a + ZWJ (201 cp)
        let cases = [
            String::new(),                              // absent `name`
            "name=".to_owned(),                         // empty value
            "name=a%E2%80%8Db".to_owned(),              // forbidden ZWJ
            format!("name={sixty_five_a}"),             // over the 64 cap
            format!("name={forbidden_in_envelope}"),    // 65–128 + forbidden
            format!("name={beyond_envelope}"),          // over 128
        ];
        for query in cases {
            let (status, body) =
                probe_request(FakeNamespace::Holding("anything".to_owned()), &query, true).await;
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
        let (status, _) = probe_request(FakeNamespace::Empty, "name=Design", false).await;
        assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR);
    }

    #[tokio::test]
    async fn a_namespace_failure_is_a_safe_500_with_no_driver_detail() {
        let response = router(FakeNamespace::Fails)
            .oneshot(
                Request::builder()
                    .uri(format!("{WORKSPACE_NAME_AVAILABILITY_PATH}?name=Design"))
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
