//! `GET /api/runtimes` — which agent runtimes the machine THIS process runs on has.
//!
//! Two answers, and the order they are decided in is the whole route:
//!
//!  1. DEPLOYMENT — is there a machine to ask about? A standalone backend is
//!     control-plane only: it has no co-located daemon host, so the machine it runs on
//!     is not a machine any agent runs on. It refuses with `503` BEFORE anything is
//!     probed, so a control-plane server never shells out to look for binaries it
//!     would have no use for.
//!  2. DETECTION — run one pass and project it. The pass cannot fail: every way it
//!     could go wrong already has an arm, so this route has no `500` path and a broken
//!     probe cannot take down the surface that reports it.
//!
//! ## The detector is a process-lifetime singleton, not a route dependency
//!
//! One pass spawns a process per offered runtime, so the product caches a pass for
//! thirty seconds. That cache is a property of the machine being asked about, not of
//! any request or any route, so it lives in ONE component the composition root builds
//! once ([`silverhand_backend_filesystem::runtime_detection::MachineRuntimeDetector`])
//! and this factory merely receives. A cache built here — per factory, per request, or
//! as a second layer in front of the port — would either duplicate the window or reset
//! it, and either way the thirty seconds would stop meaning what it says.
//!
//! ## This is the LOCAL machine, never a daemon's
//!
//! `host_control::runtime_catalog` answers the same question about a REMOTE machine, by
//! asking its daemon over the control channel, and its rows are bound to a
//! `(host, daemon instance)` coordinate. This face has no coordinate to bind: the
//! answer is about the process's own filesystem. The two must not share an
//! implementation — one machine's catalogue rendered as another's is exactly the
//! confusion the coordinate binding exists to prevent.
//!
//! ## The wire keeps a narrower vocabulary than the detection does
//!
//! `RuntimeCatalogResponseSchema` carries `detected_at`; this route's registrar sends
//! only `{ runtimes }`, because the field would tell a client the age of a cache entry
//! it cannot refresh. The port is likewise `detected_at`-free: a stamp nobody may read
//! is not a fact worth carrying to the boundary.

use axum::{
    Json, Router,
    extract::State,
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::get,
};
use serde::Serialize;
use silverhand_backend_core::agents::runtime_catalog::{
    DetectedRuntime, RuntimeCatalogDetector, RuntimeDetection,
};

use crate::ops::deployment::DeploymentMode;

pub const RUNTIMES_PATH: &str = "/api/runtimes";

/// The standalone refusal, pinned to `hostRuntimeDisabledResponse(c, 'runtime
/// detection', 503)`. The message is templated in the product over the action name;
/// this route is its only caller in this crate, so the rendered sentence is spelled
/// once here rather than behind a helper with one call site.
const RUNTIME_DETECTION_DISABLED: &str = "runtime detection requires a daemon-host \
runtime; standalone server mode is control-plane only until D2";
const HOST_RUNTIME_DISABLED_CODE: &str = "host_runtime_disabled";

#[derive(Clone)]
struct RuntimesState<D> {
    deployment: DeploymentMode,
    detector: D,
}

pub fn router<D>(deployment: DeploymentMode, detector: D) -> Router
where
    D: RuntimeCatalogDetector + Clone + Send + Sync + 'static,
{
    Router::new()
        .route(RUNTIMES_PATH, get(runtimes::<D>))
        .with_state(RuntimesState {
            deployment,
            detector,
        })
}

async fn runtimes<D>(State(state): State<RuntimesState<D>>) -> Response
where
    D: RuntimeCatalogDetector,
{
    if state.deployment.is_standalone() {
        return disabled();
    }
    let catalog = state.detector.detect_runtimes().await;
    Json(RuntimesResponse {
        runtimes: catalog.entries().iter().map(runtime_dto).collect(),
    })
    .into_response()
}

/// Success body: `{ "runtimes": [RuntimeInfo] }` — the offered catalogue in the offered
/// order, which is a property of the value the detector returns rather than of this
/// projection.
#[derive(Serialize)]
struct RuntimesResponse {
    runtimes: Vec<RuntimeInfoDto>,
}

/// The wire projection of one offered runtime, field-for-field `RuntimeInfoSchema`.
#[derive(Serialize)]
struct RuntimeInfoDto {
    kind: &'static str,
    state: &'static str,
    reason: &'static str,
    installed: bool,
    binary: Option<String>,
    version: Option<String>,
}

fn runtime_dto(entry: &DetectedRuntime) -> RuntimeInfoDto {
    let (state, reason) = availability(&entry.detection);
    RuntimeInfoDto {
        kind: entry.kind.as_str(),
        state,
        reason,
        // Read from the detection rather than from the arm matched above: which
        // outcomes count as installed, and which carry a binary or a version, is the
        // fact's own answer. This projection only decides how the outcome is SPELLED.
        installed: entry.detection.installed(),
        binary: entry.detection.binary().map(str::to_string),
        version: entry.detection.version().map(str::to_string),
    }
}

/// The two wire tokens for one detection outcome, exhaustively — so a new arm on the
/// detection matrix is a compile error here rather than a silently unrendered state.
///
/// Pinned to `RuntimeAvailabilityStateSchema` and `RuntimeDetectionReasonSchema`.
/// `unknown` / `probe_failed` is kept distinct from `absent` / `not_found` on purpose:
/// a broken probe must never be reported as a machine without the runtime.
fn availability(detection: &RuntimeDetection) -> (&'static str, &'static str) {
    match detection {
        RuntimeDetection::Resolved { .. } => ("present", "resolved"),
        RuntimeDetection::VersionUnavailable { .. } => {
            ("present_unverified", "version_unavailable")
        }
        RuntimeDetection::Absent => ("absent", "not_found"),
        RuntimeDetection::ProbeFailed => ("unknown", "probe_failed"),
    }
}

/// The refusal body: this face carries `code`, not the `error_code` the host resource
/// faces use.
#[derive(Serialize)]
struct DisabledBody {
    error: &'static str,
    code: &'static str,
}

fn disabled() -> Response {
    (
        StatusCode::SERVICE_UNAVAILABLE,
        Json(DisabledBody {
            error: RUNTIME_DETECTION_DISABLED,
            code: HOST_RUNTIME_DISABLED_CODE,
        }),
    )
        .into_response()
}

#[cfg(test)]
mod tests {
    use std::sync::{
        Arc,
        atomic::{AtomicUsize, Ordering::SeqCst},
    };

    use axum::{
        body::{Body, to_bytes},
        http::Request,
    };
    use serde_json::{Value, json};
    use silverhand_backend_core::agents::runtime_catalog::RuntimeCatalog;
    use tower::ServiceExt;

    use super::*;

    /// A detector that answers with a fixed pass and counts how often it was asked.
    #[derive(Clone)]
    struct FakeDetector {
        catalog: RuntimeCatalog,
        passes: Arc<AtomicUsize>,
    }

    impl RuntimeCatalogDetector for FakeDetector {
        async fn detect_runtimes(&self) -> RuntimeCatalog {
            self.passes.fetch_add(1, SeqCst);
            self.catalog.clone()
        }
    }

    /// One pass covering all four outcomes, in catalogue order.
    fn every_outcome() -> RuntimeCatalog {
        RuntimeCatalog::from_detections([
            RuntimeDetection::Resolved {
                binary: "/usr/local/bin/claude".to_string(),
                version: "2.1.3".to_string(),
            },
            RuntimeDetection::VersionUnavailable {
                binary: "/usr/local/bin/codex".to_string(),
            },
            RuntimeDetection::Absent,
            RuntimeDetection::ProbeFailed,
        ])
    }

    struct Reply {
        status: StatusCode,
        body: Value,
        passes: usize,
    }

    async fn get(deployment: DeploymentMode, catalog: RuntimeCatalog) -> Reply {
        let passes = Arc::new(AtomicUsize::new(0));
        let detector = FakeDetector {
            catalog,
            passes: passes.clone(),
        };
        let response = router(deployment, detector)
            .oneshot(Request::get(RUNTIMES_PATH).body(Body::empty()).unwrap())
            .await
            .unwrap();
        let status = response.status();
        let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        Reply {
            status,
            body: serde_json::from_slice(&body).unwrap(),
            passes: passes.load(SeqCst),
        }
    }

    /// Every outcome's wire spelling, in the offered order, with each one's evidence
    /// and no other runtime present.
    #[tokio::test]
    async fn each_offered_runtime_is_reported_with_the_evidence_its_outcome_carries() {
        let reply = get(DeploymentMode::Embedded, every_outcome()).await;
        assert_eq!(reply.status, StatusCode::OK);
        assert_eq!(
            reply.body,
            json!({
                "runtimes": [
                    {
                        "kind": "claude",
                        "state": "present",
                        "reason": "resolved",
                        "installed": true,
                        "binary": "/usr/local/bin/claude",
                        "version": "2.1.3"
                    },
                    {
                        "kind": "codex",
                        "state": "present_unverified",
                        "reason": "version_unavailable",
                        "installed": true,
                        "binary": "/usr/local/bin/codex",
                        "version": null
                    },
                    {
                        "kind": "qoder",
                        "state": "absent",
                        "reason": "not_found",
                        "installed": false,
                        "binary": null,
                        "version": null
                    },
                    {
                        "kind": "opencode",
                        "state": "unknown",
                        "reason": "probe_failed",
                        "installed": false,
                        "binary": null,
                        "version": null
                    }
                ]
            })
        );
        assert_eq!(reply.passes, 1);
    }

    /// The response carries `{ runtimes }` and nothing else — no `detected_at`, whose
    /// value would describe a cache the client cannot refresh.
    #[tokio::test]
    async fn the_response_carries_only_the_catalogue() {
        let reply = get(DeploymentMode::Embedded, every_outcome()).await;
        let object = reply.body.as_object().expect("a JSON object");
        assert_eq!(object.keys().collect::<Vec<_>>(), vec!["runtimes"]);
    }

    /// The standalone refusal is decided FIRST: the exact bytes the product sends, and
    /// zero detection passes — a control-plane server must not spawn processes looking
    /// for runtimes it cannot run.
    #[tokio::test]
    async fn a_standalone_server_refuses_before_it_probes_anything() {
        let reply = get(DeploymentMode::Standalone, every_outcome()).await;
        assert_eq!(reply.status, StatusCode::SERVICE_UNAVAILABLE);
        assert_eq!(
            reply.body,
            json!({
                "error": "runtime detection requires a daemon-host runtime; \
            standalone server mode is control-plane only until D2",
                "code": "host_runtime_disabled"
            })
        );
        assert_eq!(reply.passes, 0);
    }
}
