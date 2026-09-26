//! Authenticated cold face for `GET /api/agents/{id}/presence`: one agent's Away
//! deadline, projected to the wire — if the caller may see it at all.
//!
//! Like availability and detail this route is AUTHENTICATED and names a SPECIFIC
//! agent, so it runs the visibility authority BEFORE it projects anything:
//!
//!  1. VISIBILITY ([`can_view_agent`]) — may this caller see this agent? An absent
//!     row, a caller outside the ACL, and a row whose stage this view hides all
//!     collapse to ONE byte-identical `404 {"error":"agent not found"}`, so the
//!     surface can never become an existence oracle. The view is active-only:
//!     presence carries NO stage-widening flags (the TypeScript handler calls
//!     `canViewAgent` with no options, whose default is `ACTIVE_ONLY`), so a pending
//!     or failed row 404s even for a caller inside its ACL.
//!  2. PROJECTION — emit the deadline ONLY once the caller is admitted. Access
//!     precedes product: a refused caller never learns whether the agent is online.
//!
//! The resolved row is bound to the requested id BEFORE the gate: a bundle whose
//! decoded id is not the one asked for is a resolver defect — the ACL would judge one
//! row and the wire report another — so it takes the lane's safe `500`, never a
//! product `404`.
//!
//! ## Two clocks that never touch
//!
//! `away_at` is CLOCK-FREE: the stored `last_activity_at` run through the shared
//! [`silverhand_backend_core::host_runtime::agent_presence`] policy the runtime-delivery
//! writer also uses, so a write that calls an agent present and this read that reports
//! it away agree by construction. `server_now` is a SEPARATE emit-only stamp the route
//! reads from its injected [`ProcessClock`] so the renderer can calibrate client↔server
//! skew; it is not a stored fact and never enters the deadline arithmetic. The clock is
//! injected (not read from `SystemTime` here) so a test pins a fixed `server_now`.
//!
//! Like availability and detail, the human principal is proof the authenticating
//! perimeter ran; its ABSENCE is a composition fault, not a product request, so it
//! takes a fail-closed `500` reading nothing. Mounting the real bearer perimeter is the
//! composition root's job (#task:2197), not this factory's.

use axum::{
    Json, Router,
    extract::{Extension, Path, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::get,
};
use serde::Serialize;
use silverhand_backend_core::{
    foundation::identity::{AgentId, Principal, UserId},
    host_runtime::agent_presence_read::{AgentPresenceFacts, AgentPresenceReadModel},
    identity_access::capability::agent_view::{VisibleStages, can_view_agent},
};

use crate::{foundation::clock::ProcessClock, foundation::error};

/// The product route template, in axum's `{id}` capture syntax.
pub const AGENT_PRESENCE_PATH: &str = "/api/agents/{id}/presence";

/// The anti-enumeration refusal string, pinned to the TypeScript handler
/// (`c.json({ error: 'agent not found' }, 404)`) so a fixture drift shows here.
const AGENT_NOT_FOUND: &str = "agent not found";

/// The unmapped-error body: the product route registers no `onError`, so an
/// unexpected failure falls to the framework default — a `500` with a bare
/// `text/plain` `Internal Server Error`, never a JSON envelope.
const INTERNAL_ERROR_BODY: &str = "Internal Server Error";

#[derive(Clone)]
struct PresenceState<R, C> {
    cold_read: R,
    clock: C,
}

pub fn router<R, C>(cold_read: R, clock: C) -> Router
where
    R: AgentPresenceReadModel + Clone + Send + Sync + 'static,
    C: ProcessClock,
{
    Router::new()
        .route(AGENT_PRESENCE_PATH, get(agent_presence::<R, C>))
        .with_state(PresenceState { cold_read, clock })
}

async fn agent_presence<R, C>(
    Path(agent_id): Path<String>,
    viewer: Option<Extension<UserId>>,
    State(state): State<PresenceState<R, C>>,
) -> Response
where
    R: AgentPresenceReadModel,
    C: ProcessClock,
{
    let Some(Extension(viewer)) = viewer else {
        tracing::error!("agent-presence route reached without its human principal fact");
        return internal_error();
    };
    let principal = Principal::human(viewer);

    // A malformed id names no agent — the same 404 an absent row gets, so the surface
    // never distinguishes "unparseable" from "not there".
    let Ok(agent) = AgentId::parse(agent_id) else {
        return not_found();
    };

    // The agent row's activity stamp and its ACL arms on ONE snapshot, read BEFORE the
    // gate.
    let presence = match state.cold_read.read_agent_presence(&agent).await {
        Ok(presence) => presence,
        Err(cause) => {
            tracing::error!(
                error_chain =
                    crate::foundation::safe_log_field::safe_display(&(error::describe(&cause))),
                "agent-presence read failed"
            );
            return internal_error();
        }
    };

    // Bind the resolved row to the request before consulting the ACL: a bundle whose
    // decoded id is not the one asked for is a resolver defect — the gate would judge
    // one row and the wire report another — so it takes the lane's safe 500. A short
    // read (no row) has nothing to bind; it is the ACL's absence arm.
    if let Some(presence) = presence.as_ref()
        && presence.source() != &agent
    {
        tracing::error!(
            requested = agent.as_str(),
            resolved = presence.source().as_str(),
            "agent-presence resolved for the wrong agent"
        );
        return internal_error();
    }

    // Access precedes product: absence, non-membership, and a hidden stage all collapse
    // to one anti-enumeration 404. Active-only: presence never widens the view.
    let decision = can_view_agent(
        &principal,
        &agent,
        presence.as_ref().map(AgentPresenceFacts::visibility),
        &VisibleStages::active_only(),
    );
    let Some(presence) = presence.filter(|_| decision.is_allowed()) else {
        return not_found();
    };

    Json(AgentPresenceResponse {
        away_at: presence.away_at(),
        server_now: state.clock.now_unix_millis(),
    })
    .into_response()
}

/// The wire body: `{ "away_at": number|null, "server_now": number }`, field-for-field
/// the TypeScript `AgentPresenceDto`. `away_at` serializes as an explicit `null` for a
/// never-active agent (never skipped).
#[derive(Serialize)]
struct AgentPresenceResponse {
    away_at: Option<i64>,
    server_now: i64,
}

/// The flat refusal body, mirroring the product `{ "error": ... }`.
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

fn internal_error() -> Response {
    (StatusCode::INTERNAL_SERVER_ERROR, INTERNAL_ERROR_BODY).into_response()
}

#[cfg(test)]
mod tests {
    use std::{
        io,
        sync::{
            Arc,
            atomic::{AtomicUsize, Ordering::SeqCst},
        },
    };

    use axum::{
        body::{Body, to_bytes},
        http::{Request, StatusCode},
    };
    use serde_json::{Value, json};
    use silverhand_backend_core::{
        foundation::identity::{AgentId, UserId},
        foundation::persistence::PersistenceFailure,
        host_runtime::agent_presence,
        host_runtime::agent_presence_read::{AgentPresenceFacts, AgentPresenceReadModel},
        identity_access::agent_lifecycle::MaterializationStatus,
        identity_access::capability::agent_view::{AgentViewerArms, AgentVisibility},
    };
    use tower::ServiceExt;

    use super::{ProcessClock, router};

    /// The fixed `server_now` a test pins so the emitted value proves the route reads
    /// its injected clock, never a wall clock.
    const FIXED_NOW: i64 = 9_000_000;

    fn user(id: &str) -> UserId {
        UserId::parse(id).expect("user id")
    }

    fn agent(id: &str) -> AgentId {
        AgentId::parse(id).expect("agent id")
    }

    /// A clock frozen at [`FIXED_NOW`], so `server_now` is deterministic and clearly not
    /// a `SystemTime` reading.
    #[derive(Clone, Copy)]
    struct FixedClock;

    impl ProcessClock for FixedClock {
        fn now_unix_millis(&self) -> i64 {
            FIXED_NOW
        }
    }

    /// Which ACL arm should admit `viewer-1`, plus one that admits only OTHER people.
    enum Arm {
        Creator,
        DirectPair,
        Workspace,
        NobodyRelevant,
    }

    /// `(creator, direct_pair_human_endpoints, shared_workspace_members)` for the arm.
    /// The creator is always some human; an arm that tests a non-creator path gives the
    /// creator a DISTINCT id so a test can tell the row's creator apart from the admitted
    /// viewer.
    fn arms(arm: Arm) -> (UserId, Vec<UserId>, Vec<UserId>) {
        match arm {
            Arm::Creator => (user("viewer-1"), vec![], vec![]),
            Arm::DirectPair => (user("creator-user"), vec![user("viewer-1")], vec![]),
            Arm::Workspace => (user("creator-user"), vec![], vec![user("viewer-1")]),
            Arm::NobodyRelevant => (
                user("someone-else"),
                vec![user("pair-peer")],
                vec![user("member")],
            ),
        }
    }

    fn facts_with(
        source: &str,
        arm: Arm,
        status: MaterializationStatus,
        last_activity_at: Option<i64>,
    ) -> AgentPresenceFacts {
        let (creator, direct_pair, workspace) = arms(arm);
        AgentPresenceFacts::from_source(
            agent(source),
            AgentVisibility {
                viewers: AgentViewerArms::new(Some(creator), direct_pair, workspace),
                materialization_status: status,
            },
            last_activity_at.map(|value| {
                agent_presence::ActivityInstant::new(value).expect("fixture stamp is in range")
            }),
        )
    }

    /// The ordinary admitting bundle: agent `a1`, creator arm, active stage, active at
    /// `1000`.
    fn admitting() -> AgentPresenceFacts {
        facts_with(
            "a1",
            Arm::Creator,
            MaterializationStatus::Active,
            Some(1_000),
        )
    }

    #[derive(Clone)]
    enum ViewOutcome {
        Present(Box<AgentPresenceFacts>),
        Absent,
        Fails,
    }

    fn present(facts: AgentPresenceFacts) -> ViewOutcome {
        ViewOutcome::Present(Box::new(facts))
    }

    #[derive(Clone)]
    struct FakePresence {
        view: ViewOutcome,
        calls: Arc<AtomicUsize>,
    }

    impl AgentPresenceReadModel for FakePresence {
        async fn read_agent_presence(
            &self,
            _agent: &AgentId,
        ) -> Result<Option<AgentPresenceFacts>, PersistenceFailure> {
            self.calls.fetch_add(1, SeqCst);
            match &self.view {
                ViewOutcome::Present(facts) => Ok(Some(facts.as_ref().clone())),
                ViewOutcome::Absent => Ok(None),
                ViewOutcome::Fails => Err(PersistenceFailure::from_source(io::Error::other(
                    "presence gone",
                ))),
            }
        }
    }

    struct Reply {
        status: StatusCode,
        content_type: Option<String>,
        body: String,
        calls: usize,
    }

    async fn get(view: ViewOutcome, with_principal: bool) -> Reply {
        get_for(view, "a1", with_principal).await
    }

    /// Drive the route for `/api/agents/{path_id}/presence`; `path_id` lets a test ask
    /// about a different id than the resolver returns (the source-bind case).
    async fn get_for(view: ViewOutcome, path_id: &str, with_principal: bool) -> Reply {
        let calls = Arc::new(AtomicUsize::new(0));
        let reads = FakePresence {
            view,
            calls: calls.clone(),
        };
        let uri = format!("/api/agents/{path_id}/presence");
        let mut request = Request::get(&uri);
        if with_principal {
            request = request.extension(user("viewer-1"));
        }
        let response = router(reads, FixedClock)
            .oneshot(request.body(Body::empty()).unwrap())
            .await
            .unwrap();
        let status = response.status();
        let content_type = response
            .headers()
            .get("content-type")
            .map(|value| value.to_str().unwrap().to_owned());
        let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        Reply {
            status,
            content_type,
            body: String::from_utf8(body.to_vec()).unwrap(),
            calls: calls.load(SeqCst),
        }
    }

    fn parsed(body: &str) -> Value {
        serde_json::from_str::<Value>(body).unwrap()
    }

    #[tokio::test]
    async fn an_admitted_caller_gets_the_away_deadline_and_the_injected_now() {
        let reply = get(present(admitting()), true).await;
        assert_eq!(reply.status, StatusCode::OK);
        assert_eq!(reply.content_type.as_deref(), Some("application/json"));
        assert_eq!(
            parsed(&reply.body),
            json!({
                "away_at": 1_000 + agent_presence::AWAY_TTL_MS,
                "server_now": FIXED_NOW,
            })
        );
        assert_eq!(reply.calls, 1);
    }

    #[tokio::test]
    async fn each_visibility_arm_admits_the_viewer_on_its_own() {
        for arm in [Arm::Creator, Arm::DirectPair, Arm::Workspace] {
            let reply = get(
                present(facts_with(
                    "a1",
                    arm,
                    MaterializationStatus::Active,
                    Some(1_000),
                )),
                true,
            )
            .await;
            assert_eq!(reply.status, StatusCode::OK);
        }
    }

    #[tokio::test]
    async fn a_never_active_agent_projects_a_null_deadline_not_a_fabricated_one() {
        let reply = get(
            present(facts_with(
                "a1",
                Arm::Creator,
                MaterializationStatus::Active,
                None,
            )),
            true,
        )
        .await;
        assert_eq!(reply.status, StatusCode::OK);
        assert_eq!(
            parsed(&reply.body),
            json!({ "away_at": Value::Null, "server_now": FIXED_NOW })
        );
    }

    #[tokio::test]
    async fn a_viewer_in_no_arm_is_the_anti_enumeration_404() {
        let reply = get(
            present(facts_with(
                "a1",
                Arm::NobodyRelevant,
                MaterializationStatus::Active,
                Some(1_000),
            )),
            true,
        )
        .await;
        assert_eq!(reply.status, StatusCode::NOT_FOUND);
        assert_eq!(reply.content_type.as_deref(), Some("application/json"));
        assert_eq!(parsed(&reply.body), json!({ "error": "agent not found" }));
    }

    #[tokio::test]
    async fn an_absent_agent_is_the_same_404() {
        let reply = get(ViewOutcome::Absent, true).await;
        assert_eq!(reply.status, StatusCode::NOT_FOUND);
        assert_eq!(parsed(&reply.body), json!({ "error": "agent not found" }));
        assert_eq!(reply.calls, 1);
    }

    #[tokio::test]
    async fn a_hidden_stage_is_the_same_404_under_the_active_only_view() {
        // Presence carries no stage-widening flags, so a pending or failed row 404s even
        // for its own creator.
        for status in [
            MaterializationStatus::PendingMaterialization,
            MaterializationStatus::Failed,
        ] {
            let reply = get(
                present(facts_with("a1", Arm::Creator, status, Some(1_000))),
                true,
            )
            .await;
            assert_eq!(reply.status, StatusCode::NOT_FOUND);
            assert_eq!(parsed(&reply.body), json!({ "error": "agent not found" }));
        }
    }

    #[tokio::test]
    async fn a_missing_principal_is_a_safe_500_that_never_reads() {
        let reply = get(present(admitting()), false).await;
        assert_eq!(reply.status, StatusCode::INTERNAL_SERVER_ERROR);
        assert_eq!(reply.body, "Internal Server Error");
        assert_eq!(reply.calls, 0);
    }

    #[tokio::test]
    async fn a_presence_read_failure_is_a_safe_500_that_leaks_no_cause() {
        let reply = get(ViewOutcome::Fails, true).await;
        assert_eq!(reply.status, StatusCode::INTERNAL_SERVER_ERROR);
        assert_eq!(reply.body, "Internal Server Error");
    }

    #[tokio::test]
    async fn a_bundle_resolved_for_another_agent_is_a_safe_500() {
        // The URL asks about `a1`, but the resolver returns a bundle whose decoded id is
        // `a2`: the gate would judge one row and the wire report another. The source-bind
        // refuses it as a composition defect, even though the creator arm would admit the
        // caller.
        let spliced = facts_with(
            "a2",
            Arm::Creator,
            MaterializationStatus::Active,
            Some(1_000),
        );
        let reply = get_for(present(spliced), "a1", true).await;
        assert_eq!(reply.status, StatusCode::INTERNAL_SERVER_ERROR);
        assert_eq!(reply.body, "Internal Server Error");
    }
}
