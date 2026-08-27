//! `GET /api/health` — process liveness, and nothing else.
//!
//! The body is `{ ok: true, ... }` unconditionally, and that is the whole design: the
//! answer's VALUE carries no information, its ARRIVAL does. A caller that reads this
//! body has proof the process accepted a connection, routed a request and serialized
//! a response. Anything a dependency could refuse belongs to `/readyz`.
//!
//! That separation is structural, not documentary. This factory's entire dependency
//! surface is a mode and a clock: there is no parameter a database handle or a
//! readiness fact could arrive through, so `/api/health` cannot quietly grow into a
//! second, weaker readiness endpoint — a change that tried would have to widen the
//! signature, which is visible in review.
//!
//! The route is deliberately UNAUTHENTICATED in the product (allowlisted ahead of the
//! bearer middleware) so a process supervisor can probe it without holding a session,
//! which is another reason it must not learn to report dependency state.

use axum::{
    Json, Router, extract::State, response::IntoResponse, response::Response, routing::get,
};
use serde::Serialize;

use crate::{clock::ProcessClock, ops::deployment::ServerMode};

pub const HEALTH_PATH: &str = "/api/health";

#[derive(Clone)]
struct HealthState<C> {
    mode: ServerMode,
    clock: C,
}

pub fn router<C>(mode: ServerMode, clock: C) -> Router
where
    C: ProcessClock,
{
    Router::new()
        .route(HEALTH_PATH, get(health::<C>))
        .with_state(HealthState { mode, clock })
}

async fn health<C>(State(state): State<HealthState<C>>) -> Response
where
    C: ProcessClock,
{
    Json(HealthResponse {
        ok: true,
        mode: state.mode.as_str(),
        ts: state.clock.now_unix_millis(),
    })
    .into_response()
}

/// The wire body, field-for-field the TypeScript registrar
/// (`c.json({ ok: true, mode: ctx.serverConfig.mode, ts: Date.now() })`).
///
/// `ts` is an emit-only stamp read from the injected process clock — it lets a
/// supervisor see the answer is fresh and lets a client calibrate skew. It is not a
/// stored fact and nothing branches on it.
#[derive(Serialize)]
struct HealthResponse {
    ok: bool,
    mode: &'static str,
    ts: i64,
}

#[cfg(test)]
mod tests {
    use axum::{
        body::{Body, to_bytes},
        http::{Request, StatusCode},
    };
    use serde_json::{Value, json};
    use tower::ServiceExt;

    use super::*;

    /// A stamp no wall clock would produce, so a hard-coded `SystemTime::now()` would
    /// show up as a failure rather than as a plausible number.
    const FIXED_NOW: i64 = 1_700_000_000_123;

    #[derive(Clone, Copy)]
    struct FrozenClock;

    impl ProcessClock for FrozenClock {
        fn now_unix_millis(&self) -> i64 {
            FIXED_NOW
        }
    }

    async fn get(mode: ServerMode) -> (StatusCode, Value) {
        let response = router(mode, FrozenClock)
            .oneshot(Request::get(HEALTH_PATH).body(Body::empty()).unwrap())
            .await
            .unwrap();
        let status = response.status();
        let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        (status, serde_json::from_slice(&body).unwrap())
    }

    /// Liveness is the process answering. The body is the three fields the product
    /// sends — no `checks`, no readiness verdict, nothing a dependency could veto.
    #[tokio::test]
    async fn liveness_is_the_process_answering_and_carries_no_dependency_verdict() {
        let (status, body) = get(ServerMode::Embedded).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(
            body,
            json!({ "ok": true, "mode": "embedded", "ts": FIXED_NOW })
        );
    }

    /// The mode reported is this process's own server mode — the axis this face is
    /// given, not the deployment axis `/readyz` also reports.
    #[tokio::test]
    async fn the_reported_mode_is_the_processes_own_server_mode() {
        let (status, body) = get(ServerMode::Remote).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["mode"], "remote");
    }
}
