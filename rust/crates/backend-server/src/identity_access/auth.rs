use axum::{
    Json, Router,
    extract::{Request, State},
    http::{HeaderMap, StatusCode},
    middleware::{self, Next},
    response::{IntoResponse, Response},
};
use silverhand_backend_core::identity_access::auth::{AuthenticateHumanSession, SessionBearer};

use crate::{foundation::bearer::strict_bearer_credential, foundation::error};
use silverhand_backend_observability::Observe;

pub trait HumanSessionRejection: Clone + Send + Sync + 'static {
    fn unauthorized_response(&self) -> Response;
}

/// The public API's existing unauthenticated response.
#[derive(Clone, Copy, Debug, Default)]
pub struct PublicJsonUnauthorized;

impl HumanSessionRejection for PublicJsonUnauthorized {
    fn unauthorized_response(&self) -> Response {
        (
            StatusCode::UNAUTHORIZED,
            Json(serde_json::json!({ "error": "unauthorized" })),
        )
            .into_response()
    }
}

#[derive(Clone)]
struct HumanSessionState<A, R> {
    authority: A,
    rejection: R,
}

/// Adds human-session authentication to an already constructed product router.
/// Successful requests carry the sole core-wide
/// [`UserId`](silverhand_backend_core::foundation::identity::UserId) in their extensions;
/// handlers never receive a bearer or a storage row.
pub fn require_human_session<A, R>(router: Router, authority: A, rejection: R) -> Router
where
    A: AuthenticateHumanSession,
    R: HumanSessionRejection,
{
    router.layer(middleware::from_fn_with_state(
        HumanSessionState {
            authority,
            rejection,
        },
        authenticate::<A, R>,
    ))
}

async fn authenticate<A, R>(
    State(state): State<HumanSessionState<A, R>>,
    mut request: Request,
    next: Next,
) -> Response
where
    A: AuthenticateHumanSession,
    R: HumanSessionRejection,
{
    let Some(bearer) = bearer_from_headers(request.headers()) else {
        return state.rejection.unauthorized_response();
    };
    match state
        .authority
        .authenticate_session(bearer)
        .observe(silverhand_backend_observability::operation_span!(
            "auth.human_session"
        ))
        .await
    {
        Ok(Some(user_id)) => {
            request.extensions_mut().insert(user_id);
            next.run(request).await
        }
        Ok(None) => state.rejection.unauthorized_response(),
        Err(cause) => {
            tracing::error!(
                error_chain =
                    crate::foundation::safe_log_field::safe_display(&(error::describe(&cause))),
                "human session authentication failed"
            );
            (StatusCode::INTERNAL_SERVER_ERROR, "Internal Server Error").into_response()
        }
    }
}

fn bearer_from_headers(headers: &HeaderMap) -> Option<SessionBearer> {
    SessionBearer::parse(strict_bearer_credential(headers)?.to_owned())
}

#[cfg(test)]
mod tests {
    use axum::http::header::AUTHORIZATION;
    use serde::Deserialize;

    use super::*;

    #[derive(Deserialize)]
    struct BearerCase {
        name: String,
        header: Option<String>,
        rust_extracted_token: Option<String>,
    }

    #[test]
    fn bearer_grammar_matches_the_deliberate_fixture() {
        let cases: Vec<BearerCase> =
            serde_json::from_str(include_str!("auth/fixtures/public_bearer_grammar.json")).unwrap();
        for case in cases {
            let actual = case
                .header
                .as_deref()
                .and_then(|header| {
                    let mut headers = HeaderMap::new();
                    headers.insert(AUTHORIZATION, header.parse().ok()?);
                    bearer_from_headers(&headers)
                })
                .map(|token| format!("{token:?}"));
            let expected = case
                .rust_extracted_token
                .as_ref()
                .map(|_| "SessionBearer([REDACTED])".to_owned());
            assert_eq!(actual, expected, "{}", case.name);
        }
    }
}
