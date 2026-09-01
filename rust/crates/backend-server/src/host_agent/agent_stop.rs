//! Authenticated write face for `POST /api/agents/{id}/stop`: hard-stop EVERY
//! running runtime seat the agent owns, and report how many stopped.
//!
//! The route is a public MANAGEMENT-plane surface (creator-or-system), so it
//! composes the same visibility+authority ladder the sibling `PATCH` does:
//!
//!  1. VISIBILITY ([`can_view_agent`], active-only) — absence, a caller outside the
//!     ACL, and a non-active stage all collapse to ONE `404 {"error":"agent not
//!     found"}`, so the surface is never an existence oracle.
//!  2. AUTHORITY ([`can_edit_agent`]) — only the creator (or system) may stop it;
//!     a viewer who could merely SEE it gets `403 {"error":"forbidden"}`.
//!  3. STOP — [`bulk_stop_agent_runtimes`] takes ONE source-bound SQLite snapshot
//!     (the host captured WITH the seats), stops each running seat through the exact
//!     scope-keyed transport ([`ScopeRuntimeStopPort`], owned by the daemon lane —
//!     never re-derived here), and aggregates per the TS `Promise.allSettled`
//!     contract.
//!
//! The aggregation is reproduced exactly (see `packages/backend/src/routes/agents.ts`):
//!   - no running seats → `200 {"stopped":0}` without touching the transport;
//!   - at least one FULFILLED (even mixed with failures) → `200 {"stopped":N}`, and
//!     every failure is logged in input order (residue accounting, never swallowed);
//!   - ALL failed → the representative is the FIRST failure in that SAME ordered
//!     list: a typed placement refusal maps through the CANONICAL
//!     [`placement_refusal`](crate::messaging::collaboration::runtime_control::placement_refusal)
//!     mapper (this route re-mints no refusal vocabulary), a hard fault takes the
//!     product's `500 {"stopped":0,"error":<message>}`.
//!
//! The four [`ScopeRuntimeStopRefusal`] arms up-map 1:1 into the canonical
//! [`RuntimePlacementRefusal`] taxonomy ([`placement_of`]); the selection-time codes
//! (`host_not_owned`, `local_host_*`, `host_runtime_disabled`) are unreachable when
//! stopping an already-seated runtime whose host is persisted, so no arm is
//! fabricated to fill them.
//!
//! Like the read faces, the human principal is proof the authenticating perimeter
//! ran; its ABSENCE is a composition fault → fail-closed `500` reading nothing.
//! Mounting the real perimeter is the composition root's job — done by the
//! backend-app #2234 CP5 mount.

use axum::{
    Json, Router,
    extract::{Extension, Path, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::post,
};
use serde::Serialize;
use silverhand_backend_core::{
    conversation_messaging::messaging::collaboration::RuntimePlacementRefusal,
    foundation::identity::{AgentId, Principal, UserId},
    host_runtime::agent_bulk_stop::{
        AgentBulkStopOutcome, AgentBulkStopReadPort, BulkStopSeatFailure, BulkStopSeatFault,
        bulk_stop_agent_runtimes,
    },
    host_runtime::scope_runtime_stop::{ScopeRuntimeStopPort, ScopeRuntimeStopRefusal},
    identity_access::agent_detail_read::{AgentDetailFacts, AgentDetailReadModel},
    identity_access::capability::{
        agent_authority::{AgentAuthority, can_edit_agent},
        agent_view::{VisibleStages, can_view_agent},
    },
};

use crate::error;
use crate::messaging::collaboration::runtime_control::placement_refusal;

/// The product route template, in axum's `{id}` capture syntax.
pub const AGENT_STOP_PATH: &str = "/api/agents/{id}/stop";

/// The anti-enumeration refusal string, pinned to the TypeScript handler.
const AGENT_NOT_FOUND: &str = "agent not found";
/// The authority-refusal string (`c.json({ error: 'forbidden' }, 403)`).
const FORBIDDEN: &str = "forbidden";
/// The composition-fault body: a bare `text/plain` `500`, never a JSON envelope.
const INTERNAL_ERROR_BODY: &str = "Internal Server Error";

#[derive(Clone)]
struct StopState<D, B, S> {
    detail_reads: D,
    stop_reads: B,
    stops: S,
}

/// The gate read (visibility+authority) and the bulk-stop snapshot read are TWO distinct
/// domain ports, carried on TWO separate parameters — never fused onto one type. In
/// production they are two different source-bound SQLite reads (agent-detail cold read vs
/// host-agent seat store); binding them as one generic would force a combining wrapper that
/// is a second, wider read authority. Each stays its own sole authority, exactly as the
/// sibling agent write faces take their detail read plus their domain-specific ports.
pub fn router<D, B, S>(detail_reads: D, stop_reads: B, stops: S) -> Router
where
    D: AgentDetailReadModel + Clone + Send + Sync + 'static,
    B: AgentBulkStopReadPort,
    S: ScopeRuntimeStopPort,
{
    Router::new()
        .route(AGENT_STOP_PATH, post(agent_stop::<D, B, S>))
        .with_state(StopState {
            detail_reads,
            stop_reads,
            stops,
        })
}

async fn agent_stop<D, B, S>(
    Path(agent_id): Path<String>,
    viewer: Option<Extension<UserId>>,
    State(state): State<StopState<D, B, S>>,
) -> Response
where
    D: AgentDetailReadModel,
    B: AgentBulkStopReadPort,
    S: ScopeRuntimeStopPort,
{
    let Some(Extension(viewer)) = viewer else {
        tracing::error!("agent-stop route reached without its human principal fact");
        return internal_error();
    };
    let principal = Principal::human(viewer);

    // A malformed id names no agent — the same 404 an absent row gets.
    let Ok(agent) = AgentId::parse(agent_id) else {
        return not_found();
    };

    // Gate read: the one snapshot that decides visibility and authority.
    let detail = match state.detail_reads.read_agent_detail(&agent).await {
        Ok(detail) => detail,
        Err(cause) => {
            tracing::error!(
                error_chain = %error::describe(&cause),
                "agent-stop gate read failed"
            );
            return internal_error();
        }
    };

    // Bind the resolved row to the request before either gate: a bundle decoded for
    // another agent is a resolver defect, the lane's safe 500.
    if let Some(detail) = detail.as_ref()
        && detail.source() != &agent
    {
        tracing::error!(
            requested = agent.as_str(),
            resolved = detail.source().as_str(),
            "agent-stop resolved for the wrong agent"
        );
        return internal_error();
    }

    // VISIBILITY (active-only): absence, non-membership, and a non-active stage all
    // collapse to one anti-enumeration 404.
    let decision = can_view_agent(
        &principal,
        &agent,
        detail.as_ref().map(AgentDetailFacts::visibility),
        &VisibleStages::active_only(),
    );
    let Some(detail) = detail.filter(|_| decision.is_allowed()) else {
        return not_found();
    };

    // AUTHORITY: only the creator (or system) may stop it; a viewer who is not the
    // creator gets 403.
    let authority = AgentAuthority {
        created_by_user_id: Some(detail.created_by_user_id().clone()),
    };
    if !can_edit_agent(&principal, &agent, Some(&authority)).is_allowed() {
        return forbidden();
    }

    // STOP: one source-bound snapshot, then stop each running seat and aggregate.
    match bulk_stop_agent_runtimes(&state.stop_reads, &state.stops, &agent).await {
        // The row vanished between the gate and the snapshot: the same anti-enum 404.
        Ok(AgentBulkStopOutcome::NoSuchAgent) => not_found(),
        // The snapshot resolved a host from the wrong row — a resolver defect.
        Ok(AgentBulkStopOutcome::SourceUntrustworthy) => {
            tracing::error!(
                requested = agent.as_str(),
                "agent-stop snapshot resolved a host for the wrong agent"
            );
            internal_error()
        }
        Ok(AgentBulkStopOutcome::Ran { stopped, failures }) => {
            stop_response(&agent, stopped, failures)
        }
        Err(cause) => {
            tracing::error!(
                error_chain = %error::describe(&cause),
                "agent-stop seat snapshot read failed"
            );
            internal_error()
        }
    }
}

/// Render the aggregate outcome. Every failure is logged in INPUT order first, so a
/// partial success accounts for its residue; then the count decides the body, and an
/// all-failed run's representative is `failures[0]` — the same ordered list, no second
/// pass.
fn stop_response(agent: &AgentId, stopped: u32, failures: Vec<BulkStopSeatFailure>) -> Response {
    for failure in &failures {
        let conversation = failure
            .scope
            .source()
            .map(silverhand_backend_core::foundation::identity::ConversationId::as_str)
            .unwrap_or("<agent-slot>");
        tracing::error!(
            agent_id = agent.as_str(),
            conversation_id = conversation,
            generation = failure.generation.as_i64(),
            cause = %fault_label(&failure.cause),
            "agent-stop: a runtime seat did not stop"
        );
    }

    // At least one stopped, OR nothing was running: the product's 200 {stopped:N}.
    if stopped > 0 || failures.is_empty() {
        return (StatusCode::OK, Json(StoppedBody { stopped })).into_response();
    }

    // All failed: the representative is the FIRST failure in seat order.
    match &failures[0].cause {
        BulkStopSeatFault::Refused(refusal) => placement_refusal(placement_of(*refusal)),
        BulkStopSeatFault::Faulted(message) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(StoppedErrorBody {
                stopped: 0,
                error: message.clone(),
            }),
        )
            .into_response(),
    }
}

/// Up-map the four exact-seat stop refusals into the canonical placement taxonomy.
/// The mapping to HTTP status/code then lives in the ONE shared
/// [`placement_refusal`] authority.
fn placement_of(refusal: ScopeRuntimeStopRefusal) -> RuntimePlacementRefusal {
    match refusal {
        ScopeRuntimeStopRefusal::HostMissing => RuntimePlacementRefusal::HostMissing,
        ScopeRuntimeStopRefusal::HostPendingAttach => RuntimePlacementRefusal::HostPendingAttach,
        ScopeRuntimeStopRefusal::HostRevoked => RuntimePlacementRefusal::HostRevoked,
        ScopeRuntimeStopRefusal::HostAttachPending => RuntimePlacementRefusal::HostAttachPending,
    }
}

/// A stable log label for a seat fault — the refusal's canonical code, or the hard
/// fault's already-rendered cause.
fn fault_label(cause: &BulkStopSeatFault) -> String {
    match cause {
        BulkStopSeatFault::Refused(refusal) => placement_code(*refusal).to_owned(),
        BulkStopSeatFault::Faulted(message) => message.clone(),
    }
}

/// The canonical placement code string for a refusal, for logging only (the wire
/// mapping is [`placement_refusal`]'s).
fn placement_code(refusal: ScopeRuntimeStopRefusal) -> &'static str {
    match refusal {
        ScopeRuntimeStopRefusal::HostMissing => "host_missing",
        ScopeRuntimeStopRefusal::HostPendingAttach => "host_pending_attach",
        ScopeRuntimeStopRefusal::HostRevoked => "host_revoked",
        ScopeRuntimeStopRefusal::HostAttachPending => "host_attach_pending",
    }
}

// ===========================================================================
// Responses
// ===========================================================================

/// Success body: `{ "stopped": N }`.
#[derive(Serialize)]
struct StoppedBody {
    stopped: u32,
}

/// The all-failed hard-fault body: `{ "stopped": 0, "error": <message> }` at 500.
#[derive(Serialize)]
struct StoppedErrorBody {
    stopped: u32,
    error: String,
}

/// The flat `{ "error": ... }` refusal body for the static refusals.
#[derive(Serialize)]
struct ErrorBody {
    error: &'static str,
}

fn not_found() -> Response {
    (
        StatusCode::NOT_FOUND,
        Json(ErrorBody {
            error: AGENT_NOT_FOUND,
        }),
    )
        .into_response()
}

fn forbidden() -> Response {
    (StatusCode::FORBIDDEN, Json(ErrorBody { error: FORBIDDEN })).into_response()
}

fn internal_error() -> Response {
    (StatusCode::INTERNAL_SERVER_ERROR, INTERNAL_ERROR_BODY).into_response()
}

#[cfg(test)]
mod tests {
    use std::{
        collections::VecDeque,
        error::Error,
        fmt, io,
        sync::{
            Arc, Mutex,
            atomic::{AtomicUsize, Ordering::SeqCst},
        },
    };

    use axum::{
        body::{Body, to_bytes},
        http::{Request, StatusCode},
    };
    use serde_json::{Value, json};
    use silverhand_backend_core::{
        foundation::identity::{ConversationId, HostId},
        foundation::persistence::PersistenceFailure,
        host_runtime::agent_bulk_stop::AgentBulkStopSnapshot,
        host_runtime::runtime_credential::{RuntimeGeneration, RuntimeScope},
        host_runtime::runtime_event::RuntimeObservedStatus,
        host_runtime::scope_runtime_stop::{ScopeRuntimeStopOutcome, ScopeRuntimeStopTarget},
        identity_access::agent_detail_read::{AgentDetailFacts, AgentDetailProjection},
        identity_access::agent_lifecycle::MaterializationStatus,
        identity_access::agents::runtime::RuntimeKind,
    };
    use tower::ServiceExt;

    use super::*;

    fn user(id: &str) -> UserId {
        UserId::parse(id).expect("user id")
    }

    fn agent(id: &str) -> AgentId {
        AgentId::parse(id).expect("agent id")
    }

    fn host(id: &str) -> HostId {
        HostId::parse(id).expect("host id")
    }

    fn generation(value: i64) -> RuntimeGeneration {
        RuntimeGeneration::new(value).expect("generation")
    }

    fn conversation_seat(
        id: &str,
        source: &str,
        status: RuntimeObservedStatus,
        gen_value: i64,
    ) -> silverhand_backend_core::application_orchestration::teardown::facts::AgentRuntimeSessionFacts
    {
        silverhand_backend_core::application_orchestration::teardown::facts::AgentRuntimeSessionFacts {
            scope: RuntimeScope::ConversationSlot {
                agent: agent(id),
                source: ConversationId::parse(source).expect("conversation id"),
            },
            status,
            generation: generation(gen_value),
        }
    }

    // ---- read fake (gate detail + bulk-stop snapshot on one model) ----

    #[derive(Clone)]
    struct FakeReads {
        detail: DetailOutcome,
        snapshot: SnapshotOutcome,
        detail_calls: Arc<AtomicUsize>,
        snapshot_calls: Arc<AtomicUsize>,
    }

    #[derive(Clone)]
    enum DetailOutcome {
        Present(Box<AgentDetailFacts>),
        Absent,
        Fails,
    }

    #[derive(Clone)]
    enum SnapshotOutcome {
        Present(AgentBulkStopSnapshot),
        Absent,
        Fails,
    }

    impl FakeReads {
        fn new(detail: DetailOutcome, snapshot: SnapshotOutcome) -> Self {
            Self {
                detail,
                snapshot,
                detail_calls: Arc::new(AtomicUsize::new(0)),
                snapshot_calls: Arc::new(AtomicUsize::new(0)),
            }
        }
    }

    impl AgentDetailReadModel for FakeReads {
        async fn read_agent_detail(
            &self,
            _agent: &AgentId,
        ) -> Result<Option<AgentDetailFacts>, PersistenceFailure> {
            self.detail_calls.fetch_add(1, SeqCst);
            match &self.detail {
                DetailOutcome::Present(facts) => Ok(Some(facts.as_ref().clone())),
                DetailOutcome::Absent => Ok(None),
                DetailOutcome::Fails => {
                    Err(PersistenceFailure::from_source(io::Error::other("boom")))
                }
            }
        }
    }

    impl AgentBulkStopReadPort for FakeReads {
        async fn read_bulk_stop_snapshot(
            &self,
            _agent_id: &AgentId,
        ) -> Result<Option<AgentBulkStopSnapshot>, PersistenceFailure> {
            self.snapshot_calls.fetch_add(1, SeqCst);
            match &self.snapshot {
                SnapshotOutcome::Present(snapshot) => Ok(Some(snapshot.clone())),
                SnapshotOutcome::Absent => Ok(None),
                SnapshotOutcome::Fails => Err(PersistenceFailure::from_source(io::Error::other(
                    "read boom",
                ))),
            }
        }
    }

    // ---- stop fake ----

    #[derive(Clone)]
    enum StopScript {
        Ok,
        Refused(ScopeRuntimeStopRefusal),
        Faulted(&'static str),
    }

    #[derive(Debug)]
    struct StopFault(&'static str);
    impl fmt::Display for StopFault {
        fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
            formatter.write_str(self.0)
        }
    }
    impl Error for StopFault {}

    #[derive(Clone)]
    struct FakeStops {
        script: Arc<Mutex<VecDeque<StopScript>>>,
        calls: Arc<AtomicUsize>,
    }

    impl FakeStops {
        fn scripted(script: Vec<StopScript>) -> Self {
            Self {
                script: Arc::new(Mutex::new(script.into())),
                calls: Arc::new(AtomicUsize::new(0)),
            }
        }
    }

    impl ScopeRuntimeStopPort for FakeStops {
        type Error = StopFault;

        async fn hard_stop(
            &self,
            _target: &ScopeRuntimeStopTarget,
        ) -> Result<Result<ScopeRuntimeStopOutcome, ScopeRuntimeStopRefusal>, Self::Error> {
            self.calls.fetch_add(1, SeqCst);
            match self
                .script
                .lock()
                .unwrap()
                .pop_front()
                .expect("scripted stop")
            {
                StopScript::Ok => Ok(Ok(ScopeRuntimeStopOutcome)),
                StopScript::Refused(refusal) => Ok(Err(refusal)),
                StopScript::Faulted(message) => Err(StopFault(message)),
            }
        }
    }

    // ---- fixtures ----

    fn projection() -> AgentDetailProjection {
        AgentDetailProjection {
            name: "agent-one".to_owned(),
            display_name: "Base Name".to_owned(),
            runtime: RuntimeKind::Codex,
            model: Some("gpt-5.6-sol".to_owned()),
            reasoning_effort: Some("ultra".to_owned()),
            fast_mode: Some(true),
            host_id: "h1".to_owned(),
            host_display_label: Some("Host One".to_owned()),
            host_name: Some("host-one".to_owned()),
            description: Some("base desc".to_owned()),
            session_scope: "agent".to_owned(),
            avatar_storage_key: None,
            materialization_failed_code: None,
            materialization_failed_at: None,
            deletion_started_at: None,
            created_at: 1000,
            updated_at: 2000,
        }
    }

    /// The creator arm admits `viewer-1`, active stage.
    fn creator_facts() -> AgentDetailFacts {
        AgentDetailFacts::from_source(
            agent("a1"),
            user("viewer-1"),
            [],
            [],
            MaterializationStatus::Active,
            projection(),
        )
    }

    fn present_detail(facts: AgentDetailFacts) -> DetailOutcome {
        DetailOutcome::Present(Box::new(facts))
    }

    /// A snapshot on `a1`, host `h1`, with the given seats — source-bound to a1.
    fn snapshot(
        seats: Vec<silverhand_backend_core::application_orchestration::teardown::facts::AgentRuntimeSessionFacts>,
    ) -> SnapshotOutcome {
        SnapshotOutcome::Present(AgentBulkStopSnapshot {
            source: agent("a1"),
            host: host("h1"),
            sessions: seats,
        })
    }

    struct Reply {
        status: StatusCode,
        body: String,
        detail_reads: usize,
        snapshot_reads: usize,
        stops: usize,
    }

    async fn stop_with(
        reads: FakeReads,
        stops: FakeStops,
        path_id: &str,
        with_principal: bool,
    ) -> Reply {
        let detail_calls = reads.detail_calls.clone();
        let snapshot_calls = reads.snapshot_calls.clone();
        let stop_calls = stops.calls.clone();
        let uri = format!("/api/agents/{path_id}/stop");
        let mut request = Request::post(&uri);
        if with_principal {
            request = request.extension(user("viewer-1"));
        }
        let response = router(reads.clone(), reads, stops)
            .oneshot(request.body(Body::empty()).unwrap())
            .await
            .unwrap();
        let status = response.status();
        let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        Reply {
            status,
            body: String::from_utf8(bytes.to_vec()).unwrap(),
            detail_reads: detail_calls.load(SeqCst),
            snapshot_reads: snapshot_calls.load(SeqCst),
            stops: stop_calls.load(SeqCst),
        }
    }

    fn parsed(body: &str) -> Value {
        serde_json::from_str::<Value>(body).unwrap()
    }

    // ---- the ladder ----

    #[tokio::test]
    async fn a_missing_principal_is_a_safe_500_that_never_reads() {
        let reply = stop_with(
            FakeReads::new(present_detail(creator_facts()), snapshot(vec![])),
            FakeStops::scripted(vec![]),
            "a1",
            false,
        )
        .await;
        assert_eq!(reply.status, StatusCode::INTERNAL_SERVER_ERROR);
        assert_eq!(reply.body, "Internal Server Error");
        assert_eq!(reply.detail_reads, 0);
        assert_eq!(reply.snapshot_reads, 0);
    }

    #[tokio::test]
    async fn an_absent_row_is_the_anti_enumeration_404_and_never_stops() {
        let reply = stop_with(
            FakeReads::new(DetailOutcome::Absent, snapshot(vec![])),
            FakeStops::scripted(vec![]),
            "a1",
            true,
        )
        .await;
        assert_eq!(reply.status, StatusCode::NOT_FOUND);
        assert_eq!(parsed(&reply.body), json!({ "error": "agent not found" }));
        assert_eq!(reply.snapshot_reads, 0);
        assert_eq!(reply.stops, 0);
    }

    #[tokio::test]
    async fn a_viewer_who_cannot_see_it_is_the_same_404() {
        let facts = AgentDetailFacts::from_source(
            agent("a1"),
            user("someone-else"),
            [],
            [],
            MaterializationStatus::Active,
            projection(),
        );
        let reply = stop_with(
            FakeReads::new(present_detail(facts), snapshot(vec![])),
            FakeStops::scripted(vec![]),
            "a1",
            true,
        )
        .await;
        assert_eq!(reply.status, StatusCode::NOT_FOUND);
        assert_eq!(reply.stops, 0);
    }

    #[tokio::test]
    async fn a_non_active_stage_is_the_same_404() {
        let facts = AgentDetailFacts::from_source(
            agent("a1"),
            user("viewer-1"),
            [],
            [],
            MaterializationStatus::Failed,
            projection(),
        );
        let reply = stop_with(
            FakeReads::new(present_detail(facts), snapshot(vec![])),
            FakeStops::scripted(vec![]),
            "a1",
            true,
        )
        .await;
        assert_eq!(reply.status, StatusCode::NOT_FOUND);
        assert_eq!(reply.stops, 0);
    }

    #[tokio::test]
    async fn a_viewer_who_is_not_the_creator_is_forbidden_and_never_stops() {
        // viewer-1 can SEE it (workspace member) but did not create it.
        let facts = AgentDetailFacts::from_source(
            agent("a1"),
            user("creator-user"),
            [],
            [user("viewer-1")],
            MaterializationStatus::Active,
            projection(),
        );
        let reply = stop_with(
            FakeReads::new(present_detail(facts), snapshot(vec![])),
            FakeStops::scripted(vec![]),
            "a1",
            true,
        )
        .await;
        assert_eq!(reply.status, StatusCode::FORBIDDEN);
        assert_eq!(parsed(&reply.body), json!({ "error": "forbidden" }));
        assert_eq!(reply.stops, 0);
    }

    #[tokio::test]
    async fn a_bundle_resolved_for_another_agent_is_a_safe_500() {
        let spliced = AgentDetailFacts::from_source(
            agent("a2"),
            user("viewer-1"),
            [],
            [],
            MaterializationStatus::Active,
            projection(),
        );
        let reply = stop_with(
            FakeReads::new(present_detail(spliced), snapshot(vec![])),
            FakeStops::scripted(vec![]),
            "a1",
            true,
        )
        .await;
        assert_eq!(reply.status, StatusCode::INTERNAL_SERVER_ERROR);
        assert_eq!(reply.stops, 0);
    }

    #[tokio::test]
    async fn a_gate_read_failure_is_a_safe_500() {
        let reply = stop_with(
            FakeReads::new(DetailOutcome::Fails, snapshot(vec![])),
            FakeStops::scripted(vec![]),
            "a1",
            true,
        )
        .await;
        assert_eq!(reply.status, StatusCode::INTERNAL_SERVER_ERROR);
        assert_eq!(reply.stops, 0);
    }

    // ---- the aggregation ----

    #[tokio::test]
    async fn no_running_seats_is_a_200_stopped_zero_without_touching_the_transport() {
        let reply = stop_with(
            FakeReads::new(
                present_detail(creator_facts()),
                snapshot(vec![
                    conversation_seat("a1", "c1", RuntimeObservedStatus::Idle, 1),
                    conversation_seat("a1", "c2", RuntimeObservedStatus::Crashed, 2),
                ]),
            ),
            FakeStops::scripted(vec![]),
            "a1",
            true,
        )
        .await;
        assert_eq!(reply.status, StatusCode::OK);
        assert_eq!(parsed(&reply.body), json!({ "stopped": 0 }));
        assert_eq!(reply.stops, 0);
    }

    #[tokio::test]
    async fn every_running_seat_stopping_is_a_200_with_the_full_count() {
        let reply = stop_with(
            FakeReads::new(
                present_detail(creator_facts()),
                snapshot(vec![
                    conversation_seat("a1", "c1", RuntimeObservedStatus::Active, 1),
                    conversation_seat("a1", "c2", RuntimeObservedStatus::Starting, 2),
                ]),
            ),
            FakeStops::scripted(vec![StopScript::Ok, StopScript::Ok]),
            "a1",
            true,
        )
        .await;
        assert_eq!(reply.status, StatusCode::OK);
        assert_eq!(parsed(&reply.body), json!({ "stopped": 2 }));
        assert_eq!(reply.stops, 2);
    }

    #[tokio::test]
    async fn a_partial_success_stays_a_200_with_the_fulfilled_count() {
        // ok + refused: at least one fulfilled ⇒ 200 {stopped:1}.
        let reply = stop_with(
            FakeReads::new(
                present_detail(creator_facts()),
                snapshot(vec![
                    conversation_seat("a1", "c1", RuntimeObservedStatus::Active, 1),
                    conversation_seat("a1", "c2", RuntimeObservedStatus::Active, 2),
                ]),
            ),
            FakeStops::scripted(vec![
                StopScript::Ok,
                StopScript::Refused(ScopeRuntimeStopRefusal::HostRevoked),
            ]),
            "a1",
            true,
        )
        .await;
        assert_eq!(reply.status, StatusCode::OK);
        assert_eq!(parsed(&reply.body), json!({ "stopped": 1 }));
    }

    #[tokio::test]
    async fn all_failed_with_a_refusal_first_maps_through_the_canonical_placement_mapper() {
        // Every seat failed; the first is a HostRevoked refusal ⇒ 409 host_revoked.
        let reply = stop_with(
            FakeReads::new(
                present_detail(creator_facts()),
                snapshot(vec![
                    conversation_seat("a1", "c1", RuntimeObservedStatus::Active, 1),
                    conversation_seat("a1", "c2", RuntimeObservedStatus::Active, 2),
                ]),
            ),
            FakeStops::scripted(vec![
                StopScript::Refused(ScopeRuntimeStopRefusal::HostRevoked),
                StopScript::Faulted("later"),
            ]),
            "a1",
            true,
        )
        .await;
        assert_eq!(reply.status, StatusCode::CONFLICT);
        assert_eq!(
            parsed(&reply.body),
            json!({ "error": "daemon host has been revoked", "code": "host_revoked" })
        );
    }

    #[tokio::test]
    async fn all_failed_host_missing_refusal_is_a_404_through_the_mapper() {
        let reply = stop_with(
            FakeReads::new(
                present_detail(creator_facts()),
                snapshot(vec![conversation_seat(
                    "a1",
                    "c1",
                    RuntimeObservedStatus::Active,
                    1,
                )]),
            ),
            FakeStops::scripted(vec![StopScript::Refused(
                ScopeRuntimeStopRefusal::HostMissing,
            )]),
            "a1",
            true,
        )
        .await;
        assert_eq!(reply.status, StatusCode::NOT_FOUND);
        assert_eq!(
            parsed(&reply.body),
            json!({ "error": "daemon host was not found", "code": "host_missing" })
        );
    }

    #[tokio::test]
    async fn all_failed_attach_pending_is_a_503_through_the_mapper() {
        let reply = stop_with(
            FakeReads::new(
                present_detail(creator_facts()),
                snapshot(vec![conversation_seat(
                    "a1",
                    "c1",
                    RuntimeObservedStatus::Active,
                    1,
                )]),
            ),
            FakeStops::scripted(vec![StopScript::Refused(
                ScopeRuntimeStopRefusal::HostAttachPending,
            )]),
            "a1",
            true,
        )
        .await;
        assert_eq!(reply.status, StatusCode::SERVICE_UNAVAILABLE);
        assert_eq!(parsed(&reply.body)["code"], "host_attach_pending");
    }

    #[tokio::test]
    async fn all_failed_with_a_hard_fault_first_is_the_500_stopped_zero_body() {
        let reply = stop_with(
            FakeReads::new(
                present_detail(creator_facts()),
                snapshot(vec![
                    conversation_seat("a1", "c1", RuntimeObservedStatus::Active, 1),
                    conversation_seat("a1", "c2", RuntimeObservedStatus::Active, 2),
                ]),
            ),
            FakeStops::scripted(vec![
                StopScript::Faulted("transport exploded"),
                StopScript::Refused(ScopeRuntimeStopRefusal::HostRevoked),
            ]),
            "a1",
            true,
        )
        .await;
        assert_eq!(reply.status, StatusCode::INTERNAL_SERVER_ERROR);
        assert_eq!(
            parsed(&reply.body),
            json!({ "stopped": 0, "error": "transport exploded" })
        );
    }

    #[tokio::test]
    async fn a_snapshot_absent_after_the_gate_is_a_404() {
        let reply = stop_with(
            FakeReads::new(present_detail(creator_facts()), SnapshotOutcome::Absent),
            FakeStops::scripted(vec![]),
            "a1",
            true,
        )
        .await;
        assert_eq!(reply.status, StatusCode::NOT_FOUND);
        assert_eq!(parsed(&reply.body), json!({ "error": "agent not found" }));
        assert_eq!(reply.stops, 0);
    }

    #[tokio::test]
    async fn a_snapshot_read_failure_is_a_safe_500() {
        let reply = stop_with(
            FakeReads::new(present_detail(creator_facts()), SnapshotOutcome::Fails),
            FakeStops::scripted(vec![]),
            "a1",
            true,
        )
        .await;
        assert_eq!(reply.status, StatusCode::INTERNAL_SERVER_ERROR);
        assert_eq!(reply.body, "Internal Server Error");
        assert_eq!(reply.stops, 0);
    }

    #[tokio::test]
    async fn a_snapshot_bound_to_another_agent_is_a_safe_500() {
        let reply = stop_with(
            FakeReads::new(
                present_detail(creator_facts()),
                SnapshotOutcome::Present(AgentBulkStopSnapshot {
                    source: agent("a2"),
                    host: host("h1"),
                    sessions: vec![conversation_seat(
                        "a2",
                        "c1",
                        RuntimeObservedStatus::Active,
                        1,
                    )],
                }),
            ),
            FakeStops::scripted(vec![]),
            "a1",
            true,
        )
        .await;
        assert_eq!(reply.status, StatusCode::INTERNAL_SERVER_ERROR);
        assert_eq!(reply.stops, 0);
    }
}
