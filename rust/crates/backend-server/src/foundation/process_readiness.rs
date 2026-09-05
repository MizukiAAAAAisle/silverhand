//! `GET /readyz` — whether this process is ready to serve, and why not.
//!
//! Four facts, three of which no route can observe for itself:
//!
//!  - `migrations_applied`, `listen_ready` and (standalone only)
//!    `outbound_event_fanout_installed` are BOOT facts. They become true when
//!    something happens elsewhere in the process, so this face reads them from a live
//!    holder ([`BootProgress`]) that the composition root marks as boot proceeds. The
//!    holder starts with all three false and the only route to green is a `mark_*`
//!    call: there is no constructor that begins ready, and no default that stands in
//!    for a fact nobody established.
//!  - `db_writable` is the one thing a probe can ask NOW, and the only reason this
//!    endpoint cannot be answered from cached state: a process can be fully booted and
//!    still have lost its database. It comes from a real write probe
//!    ([`silverhand_backend_core::foundation::persistence::WriteProbe`]), and both `db_writable`
//!    and the `error` string are derived from that ONE outcome, so they cannot
//!    disagree.
//!
//! ## `listen_ready` is not "the request arrived"
//!
//! It is tempting to reason that a handler cannot run unless the listener is up, and
//! therefore hard-code `listen_ready: true`. That would make the field mean "a request
//! reached a handler", which is already what a `200` from `/api/health` means, and it
//! would erase the window the product actually cares about: the process binds, starts
//! serving, and only later finishes the work that makes serving CORRECT. The field
//! stays a marked fact, and a test pins that an unmarked process answers `503` from
//! inside its own handler.
//!
//! ## The standalone check's PRESENCE is structural
//!
//! `outbound_event_fanout_installed` must be absent from an embedded body, not
//! `true` — an embedded backend has two transports and readiness must not be read as
//! daemon attachment. [`ChecksBody`] is therefore an enum with two arms: the embedded
//! arm has no such field to fill, and the verdict's standalone conjunct is only
//! reachable from the arm that has it. A wiring mistake cannot render the key in
//! embedded mode, and cannot forget to gate on it in standalone mode.
//!
//! Like `/api/health`, this route is outside the authenticated mount in the product,
//! so its body is written for a supervisor: a verdict, the four facts behind it, and
//! the failure's cause when there is one.

use std::sync::{
    Arc,
    atomic::{AtomicU8, Ordering::SeqCst},
};

use axum::{
    Json, Router,
    extract::State,
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::get,
};
use serde::Serialize;
use silverhand_backend_core::foundation::persistence::WriteProbe;

use crate::foundation::{
    clock::ProcessClock,
    deployment_profile::{DeploymentMode, ServerMode},
    error,
};

/// The probe path, outside `/api/*` in the product.
pub const READYZ_PATH: &str = "/readyz";

/// The boot facts, as one value read at one instant.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct BootFacts {
    migrations_applied: bool,
    listen_ready: bool,
    /// Whether the outbound runtime event fanout was constructed and registered as the
    /// host transport's event sink. A BACKEND-SIDE wiring fact: it says nothing about
    /// whether any daemon has connected, and must never be derived from attachment
    /// state.
    outbound_event_fanout_installed: bool,
}

/// The live boot facts, shared between whoever establishes them and whoever reports
/// them.
///
/// Cloning shares one state — that is the point. The composition root marks
/// migrations from the migration runner, the listener from the accept loop and the
/// fanout from the transport wiring, each holding its own clone, while `/readyz` reads
/// the same cells.
///
/// This type is what the route takes, and there is deliberately no trait in front of
/// it. A trait would let anything with the right shape be substituted, and the useful
/// substitution — a holder that answers ready without anything having happened — is
/// exactly what this endpoint must not be able to report. Marking is separated from
/// reading by this type's own surface instead: `mark_*` writes, [`Self::facts`] reads,
/// and the route only ever calls the latter.
#[derive(Clone, Default)]
pub struct BootProgress {
    /// One cell, because the three facts are answered together. Three atomics could
    /// only be read one after another, so "the facts at one instant" would be three
    /// instants and a claim the type could not keep.
    established: Arc<AtomicU8>,
}

/// Which fact each bit of the cell carries.
const MIGRATIONS_APPLIED: u8 = 1 << 0;
const LISTEN_READY: u8 = 1 << 1;
const OUTBOUND_EVENT_FANOUT_INSTALLED: u8 = 1 << 2;

impl BootProgress {
    /// A process that has established nothing. The only constructor.
    pub fn new() -> Self {
        Self::default()
    }

    pub fn mark_migrations_applied(&self) {
        self.mark(MIGRATIONS_APPLIED);
    }

    pub fn mark_listen_ready(&self) {
        self.mark(LISTEN_READY);
    }

    pub fn mark_outbound_event_fanout_installed(&self) {
        self.mark(OUTBOUND_EVENT_FANOUT_INSTALLED);
    }

    /// Marking is additive and independent: `fetch_or` sets one fact without reading
    /// the others, so two boot steps finishing at once cannot lose each other's.
    fn mark(&self, fact: u8) {
        self.established.fetch_or(fact, SeqCst);
    }

    /// All three facts, from ONE read of the cell.
    fn facts(&self) -> BootFacts {
        let established = self.established.load(SeqCst);
        BootFacts {
            migrations_applied: established & MIGRATIONS_APPLIED != 0,
            listen_ready: established & LISTEN_READY != 0,
            outbound_event_fanout_installed: established & OUTBOUND_EVENT_FANOUT_INSTALLED != 0,
        }
    }
}

#[derive(Clone)]
struct ReadinessState<W, C> {
    mode: ServerMode,
    deployment: DeploymentMode,
    boot: BootProgress,
    write_probe: W,
    clock: C,
}

pub fn router<W, C>(
    mode: ServerMode,
    deployment: DeploymentMode,
    boot: BootProgress,
    write_probe: W,
    clock: C,
) -> Router
where
    W: WriteProbe + Clone + Send + Sync + 'static,
    C: ProcessClock,
{
    Router::new()
        .route(READYZ_PATH, get(readyz::<W, C>))
        .with_state(ReadinessState {
            mode,
            deployment,
            boot,
            write_probe,
            clock,
        })
}

async fn readyz<W, C>(State(state): State<ReadinessState<W, C>>) -> Response
where
    W: WriteProbe,
    C: ProcessClock,
{
    // ONE write outcome. Everything the body says about the database is derived from
    // it below, so the boolean and the cause are the same answer rendered twice.
    let refusal = state.write_probe.probe_write().await.err().map(|cause| {
        let described = error::describe(&cause);
        tracing::warn!(
            error_chain = crate::foundation::safe_log_field::safe_display(&(described)),
            "readiness write probe was refused"
        );
        described
    });

    let (status, body) = assess(
        state.mode,
        state.deployment,
        state.boot.facts(),
        refusal,
        state.clock.now_unix_millis(),
    );
    (status, Json(body)).into_response()
}

/// The verdict, as a pure function of the four facts and the two axes.
fn assess(
    mode: ServerMode,
    deployment: DeploymentMode,
    boot: BootFacts,
    refusal: Option<String>,
    ts: i64,
) -> (StatusCode, ReadyBody) {
    let base = BaseChecks {
        migrations_applied: boot.migrations_applied,
        listen_ready: boot.listen_ready,
        // Derived from the refusal rather than tracked beside it: there is no state in
        // which the flag says writable and the body still carries a cause.
        db_writable: refusal.is_none(),
    };
    let checks = match deployment {
        DeploymentMode::Embedded => ChecksBody::Embedded(base),
        DeploymentMode::Standalone => ChecksBody::Standalone {
            base,
            // A standalone backend without the fanout silently drops every
            // daemon-originated event. That is a config bug, not a transient
            // condition, so readiness fails loud rather than letting an orchestrator
            // roll forward.
            outbound_event_fanout_installed: boot.outbound_event_fanout_installed,
        },
    };
    let ok = checks.is_ready();
    let status = if ok {
        StatusCode::OK
    } else {
        StatusCode::SERVICE_UNAVAILABLE
    };
    (
        status,
        ReadyBody {
            ok,
            mode: mode.as_str(),
            deployment_mode: deployment.as_str(),
            checks,
            error: refusal,
            ts,
        },
    )
}

/// The wire body, field-for-field the TypeScript `readinessResponse`.
#[derive(Serialize)]
struct ReadyBody {
    ok: bool,
    mode: &'static str,
    deployment_mode: &'static str,
    checks: ChecksBody,
    /// Present only when the write probe was refused — a diagnostic string for an
    /// operator, with no consumer that parses it.
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
    ts: i64,
}

/// The checks object, whose SHAPE is the deployment axis.
#[derive(Serialize)]
#[serde(untagged)]
enum ChecksBody {
    Embedded(BaseChecks),
    Standalone {
        #[serde(flatten)]
        base: BaseChecks,
        outbound_event_fanout_installed: bool,
    },
}

impl ChecksBody {
    fn is_ready(&self) -> bool {
        match self {
            Self::Embedded(base) => base.all_green(),
            Self::Standalone {
                base,
                outbound_event_fanout_installed,
            } => base.all_green() && *outbound_event_fanout_installed,
        }
    }
}

#[derive(Serialize)]
struct BaseChecks {
    migrations_applied: bool,
    listen_ready: bool,
    db_writable: bool,
}

impl BaseChecks {
    fn all_green(&self) -> bool {
        self.migrations_applied && self.listen_ready && self.db_writable
    }
}

#[cfg(test)]
mod tests {
    use std::io;

    use axum::{
        body::{Body, to_bytes},
        http::Request,
    };
    use serde_json::{Value, json};
    use silverhand_backend_core::foundation::persistence::PersistenceFailure;
    use tower::ServiceExt;

    use super::*;

    const FIXED_NOW: i64 = 1_700_000_000_123;

    #[derive(Clone, Copy)]
    struct FrozenClock;

    impl ProcessClock for FrozenClock {
        fn now_unix_millis(&self) -> i64 {
            FIXED_NOW
        }
    }

    #[derive(Clone, Copy)]
    struct StubProbe {
        writable: bool,
    }

    impl WriteProbe for StubProbe {
        async fn probe_write(&self) -> Result<(), PersistenceFailure> {
            if self.writable {
                Ok(())
            } else {
                Err(PersistenceFailure::from_source(io::Error::other(
                    "database is locked",
                )))
            }
        }
    }

    /// A holder with every boot fact established — the state a finished boot leaves.
    fn booted() -> BootProgress {
        let boot = BootProgress::new();
        boot.mark_migrations_applied();
        boot.mark_listen_ready();
        boot.mark_outbound_event_fanout_installed();
        boot
    }

    /// Each fact is its own bit of the one cell: establishing one adds it and disturbs
    /// nothing, and establishing it again is not a toggle. Two facts sharing a bit
    /// would make an unmarked one report ready, which no wire test could see.
    #[test]
    fn each_fact_is_established_independently_and_stays_established() {
        let facts = |migrations, listen, fanout| BootFacts {
            migrations_applied: migrations,
            listen_ready: listen,
            outbound_event_fanout_installed: fanout,
        };
        let boot = BootProgress::new();
        assert_eq!(boot.facts(), facts(false, false, false));

        boot.mark_listen_ready();
        assert_eq!(boot.facts(), facts(false, true, false));
        boot.mark_migrations_applied();
        assert_eq!(boot.facts(), facts(true, true, false));
        boot.mark_outbound_event_fanout_installed();
        assert_eq!(boot.facts(), facts(true, true, true));

        boot.mark_listen_ready();
        assert_eq!(boot.facts(), facts(true, true, true));
    }

    async fn get(
        mode: ServerMode,
        deployment: DeploymentMode,
        boot: BootProgress,
        writable: bool,
    ) -> (StatusCode, Value) {
        let response = router(mode, deployment, boot, StubProbe { writable }, FrozenClock)
            .oneshot(Request::get(READYZ_PATH).body(Body::empty()).unwrap())
            .await
            .unwrap();
        let status = response.status();
        let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        (status, serde_json::from_slice(&body).unwrap())
    }

    /// The ordinary embedded probe: ready on the three base facts, and the standalone
    /// wiring key is ABSENT — tested by key, so a future `= true` cannot paper over the
    /// mode boundary.
    #[tokio::test]
    async fn embedded_readiness_is_the_three_base_facts_and_names_no_fanout_key() {
        let (status, body) = get(
            ServerMode::Embedded,
            DeploymentMode::Embedded,
            booted(),
            true,
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(
            body,
            json!({
                "ok": true,
                "mode": "embedded",
                "deployment_mode": "embedded",
                "checks": {
                    "migrations_applied": true,
                    "listen_ready": true,
                    "db_writable": true
                },
                "ts": FIXED_NOW
            })
        );
        assert!(
            body["checks"]
                .get("outbound_event_fanout_installed")
                .is_none()
        );
    }

    /// An embedded backend that never installed the fanout is still ready: the check
    /// is not part of the embedded gate at all, so an unmarked fanout can neither flip
    /// the verdict nor appear in the body.
    #[tokio::test]
    async fn embedded_readiness_ignores_the_fanout_fact_entirely() {
        let boot = BootProgress::new();
        boot.mark_migrations_applied();
        boot.mark_listen_ready();
        let (status, body) = get(ServerMode::Embedded, DeploymentMode::Embedded, boot, true).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["ok"], true);
        assert!(
            body["checks"]
                .get("outbound_event_fanout_installed")
                .is_none()
        );
    }

    #[tokio::test]
    async fn standalone_reports_the_fanout_fact_and_is_ready_once_it_is_installed() {
        let (status, body) = get(
            ServerMode::Remote,
            DeploymentMode::Standalone,
            booted(),
            true,
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(
            body,
            json!({
                "ok": true,
                "mode": "remote",
                "deployment_mode": "standalone",
                "checks": {
                    "migrations_applied": true,
                    "listen_ready": true,
                    "db_writable": true,
                    "outbound_event_fanout_installed": true
                },
                "ts": FIXED_NOW
            })
        );
    }

    /// The fail-loud gate: everything else green, the fanout missing, and the verdict
    /// is `503` — so an orchestrator never promotes a half-installed standalone
    /// deployment.
    #[tokio::test]
    async fn standalone_fails_loud_while_the_fanout_is_missing() {
        let boot = BootProgress::new();
        boot.mark_migrations_applied();
        boot.mark_listen_ready();
        let (status, body) = get(ServerMode::Remote, DeploymentMode::Standalone, boot, true).await;
        assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
        assert_eq!(body["ok"], false);
        assert_eq!(
            body["checks"],
            json!({
                "migrations_applied": true,
                "listen_ready": true,
                "db_writable": true,
                "outbound_event_fanout_installed": false
            })
        );
    }

    /// The request demonstrably reached the handler — and `listen_ready` is still
    /// false, because arriving at a handler is not the fact. A process that has
    /// established nothing is not ready, with no default standing in for any of the
    /// three.
    #[tokio::test]
    async fn a_process_that_has_established_nothing_is_not_ready_even_from_inside_its_handler() {
        let (status, body) = get(
            ServerMode::Embedded,
            DeploymentMode::Embedded,
            BootProgress::new(),
            true,
        )
        .await;
        assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
        assert_eq!(body["ok"], false);
        assert_eq!(
            body["checks"],
            json!({
                "migrations_applied": false,
                "listen_ready": false,
                "db_writable": true
            })
        );
    }

    /// The facts are LIVE: a clone marked after the router was built is the same state
    /// the route reads. This is what lets the composition root establish each fact
    /// where it actually happens instead of guessing at wiring time.
    #[tokio::test]
    async fn the_route_reads_the_same_live_state_the_composition_root_marks() {
        let boot = BootProgress::new();
        let router = router(
            ServerMode::Embedded,
            DeploymentMode::Embedded,
            boot.clone(),
            StubProbe { writable: true },
            FrozenClock,
        );

        let before = router
            .clone()
            .oneshot(Request::get(READYZ_PATH).body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(before.status(), StatusCode::SERVICE_UNAVAILABLE);

        boot.mark_migrations_applied();
        boot.mark_listen_ready();

        let after = router
            .oneshot(Request::get(READYZ_PATH).body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(after.status(), StatusCode::OK);
    }

    /// A refused write is reported as unwritable AND carries its cause. The pair comes
    /// from one probe outcome, so the body can never claim writable while explaining a
    /// failure.
    #[tokio::test]
    async fn a_refused_write_is_reported_as_unwritable_with_its_cause() {
        let (status, body) = get(
            ServerMode::Embedded,
            DeploymentMode::Embedded,
            booted(),
            false,
        )
        .await;
        assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
        assert_eq!(body["ok"], false);
        assert_eq!(body["checks"]["db_writable"], false);
        let cause = body["error"].as_str().expect("a refusal carries its cause");
        assert!(
            cause.contains("database is locked"),
            "the driver's own words must survive to the operator: {cause}"
        );
    }

    /// The mirror image: a writable database carries no `error` key at all, rather
    /// than an empty or null one.
    #[tokio::test]
    async fn a_writable_database_carries_no_error_key() {
        let (_, body) = get(
            ServerMode::Embedded,
            DeploymentMode::Embedded,
            booted(),
            true,
        )
        .await;
        assert!(body.get("error").is_none());
    }
}
