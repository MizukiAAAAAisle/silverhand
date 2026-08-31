//! Authenticated cold face for `GET /api/agents/{id}/availability`: whether one
//! agent can be reached right now.
//!
//! The route is AUTHENTICATED and answers about a SPECIFIC agent, so unlike the
//! caller-independent presence list it composes TWO authorities in a fixed order:
//!
//!  1. VISIBILITY ([`can_view_agent`]) — may this caller see this agent at all?
//!     An absent row, a caller outside the ACL, and a row whose stage this view
//!     hides all collapse to ONE byte-identical `404 {"error":"agent not found"}`,
//!     so the surface can never become an existence oracle: a stranger cannot tell
//!     a private agent from one that was never minted.
//!  2. REACHABILITY ([`read_agent_availability`]) — read ONLY once the caller is
//!     admitted. Access precedes product: the route refuses a caller who may not
//!     see the agent BEFORE it reads anything about the host the agent sits on.
//!
//! Both host-side facts are bound to the AGENT row's own host id, and the core
//! rule seals that binding: facts describing another row are an
//! `AvailabilityFactsMismatch`, which is a composition defect no client can
//! cause, so it takes the lane's safe `500` rather than a plausible `offline`.
//!
//! Like presence, the human principal is proof the authenticating perimeter ran.
//! Its ABSENCE is a composition fault, not a product request, so it takes the same
//! fail-closed `500` reading nothing — mounting the real bearer perimeter that
//! turns that fault into an external `401` is the composition root's job
//! (#task:2197), not this factory's.

use axum::{
    Json, Router,
    extract::{Extension, Path, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::get,
};
use serde::Serialize;
use silverhand_backend_core::{
    agent_availability_read::{AgentAvailabilityReadModel, AgentViewFacts},
    capability::agent_view::{VisibleStages, can_view_agent},
    cold_read::availability::{AgentAvailability, AvailabilityReadError, read_agent_availability},
    identity::{AgentId, Principal, UserId},
};

use crate::{error, host_agent::host_attachment::HostAttachment};

/// The product route template, in axum's `{id}` capture syntax.
pub const AVAILABILITY_PATH: &str = "/api/agents/{id}/availability";

/// The anti-enumeration refusal string, pinned to the TypeScript handler
/// (`c.json({ error: 'agent not found' }, 404)`) so a fixture drift shows here.
const AGENT_NOT_FOUND: &str = "agent not found";

/// The unmapped-error body: the product route registers no `onError`, so an
/// unexpected failure falls to the framework default — a `500` with a bare
/// `text/plain` `Internal Server Error`, never a JSON envelope.
const INTERNAL_ERROR_BODY: &str = "Internal Server Error";

/// The two authorities bundled into one cloneable router state: the stored-facts
/// read model and the live transport attachment port.
#[derive(Clone)]
struct AvailabilityState<R, A> {
    cold_read: R,
    attachment: A,
}

pub fn router<R, A>(cold_read: R, attachment: A) -> Router
where
    R: AgentAvailabilityReadModel + Clone + Send + Sync + 'static,
    A: HostAttachment + Clone + Send + Sync + 'static,
{
    Router::new()
        .route(AVAILABILITY_PATH, get(availability::<R, A>))
        .with_state(AvailabilityState {
            cold_read,
            attachment,
        })
}

async fn availability<R, A>(
    Path(agent_id): Path<String>,
    viewer: Option<Extension<UserId>>,
    State(state): State<AvailabilityState<R, A>>,
) -> Response
where
    R: AgentAvailabilityReadModel,
    A: HostAttachment,
{
    let Some(Extension(viewer)) = viewer else {
        tracing::error!("availability route reached without its human principal fact");
        return internal_error();
    };
    let principal = Principal::human(viewer);

    // A malformed id names no agent — the same 404 an absent row gets, so the
    // surface never distinguishes "unparseable" from "not there".
    let Ok(agent) = AgentId::parse(agent_id) else {
        return not_found();
    };

    // The agent row and its three ACL arms on ONE snapshot, read BEFORE the gate.
    let view = match state.cold_read.read_agent_view(&agent).await {
        Ok(view) => view,
        Err(cause) => {
            tracing::error!(
                error_chain = %error::describe(&cause),
                "availability agent-view read failed"
            );
            return internal_error();
        }
    };

    // Access precedes product: the capability decides absence, non-membership, and
    // a hidden stage alike, and all three collapse to one anti-enumeration 404. But
    // first bind the resolved row to the request: a view whose decoded id is not the
    // one asked for is a resolver defect — the ACL would be judged against one row
    // and reachability computed from another — so it takes the lane's safe 500, not
    // a product 404. A short read (no row) has nothing to bind; it is the ACL's
    // absence arm.
    if let Some(view) = view.as_ref()
        && view.source() != &agent
    {
        tracing::error!(
            requested = agent.as_str(),
            resolved = view.source().as_str(),
            "availability agent-view resolved for the wrong agent"
        );
        return internal_error();
    }

    let decision = can_view_agent(
        &principal,
        &agent,
        view.as_ref().map(AgentViewFacts::visibility),
        &VisibleStages::active_only(),
    );
    let Some(view) = view.filter(|_| decision.is_allowed()) else {
        return not_found();
    };

    // Product, now that the caller is admitted. The core rule drives the host-side
    // reads itself, lazily, so a rule that short-circuits — a deleting agent, a gone
    // or revoked host — never touches a read it does not need. That matches the wire
    // reference, whose 200-offline never depends on a later fetch, so a source that
    // is down cannot turn an offline into a 500. Both host-side facts are bound to
    // the AGENT row's own host id inside that rule; a spliced fact is a composition
    // defect that takes the safe 500, as does a fact the rule DID reach but could
    // not read. The lazy reads take the host id by value, so each borrows only the
    // long-lived port, never a reference into this frame.
    let cold_read = &state.cold_read;
    let attachment = &state.attachment;
    let verdict = read_agent_availability(
        &agent,
        view.availability(),
        move |host_id| async move { cold_read.read_host_reachability(&host_id).await },
        move |host_id| std::future::ready(attachment.host_attachment(&host_id)),
    )
    .await;
    match verdict {
        Ok(reachability) => {
            Json(AvailabilityResponse::from(reachability.availability())).into_response()
        }
        Err(AvailabilityReadError::Fetch(cause)) => {
            tracing::error!(
                error_chain = %error::describe(&cause),
                "availability fact read failed"
            );
            internal_error()
        }
        Err(AvailabilityReadError::Mismatch(mismatch)) => {
            tracing::error!(
                error_chain = %error::describe(&mismatch),
                "availability facts described the wrong row"
            );
            internal_error()
        }
    }
}

/// Success body: `{ "availability": "online" | "offline" }`, the two-valued wire
/// projection and the only thing a verdict yields.
#[derive(Serialize)]
struct AvailabilityResponse {
    availability: &'static str,
}

impl From<AgentAvailability> for AvailabilityResponse {
    fn from(availability: AgentAvailability) -> Self {
        Self {
            availability: match availability {
                AgentAvailability::Online => "online",
                AgentAvailability::Offline => "offline",
            },
        }
    }
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
        agent_availability_read::{AgentAvailabilityReadModel, AgentViewFacts},
        agent_lifecycle::MaterializationStatus,
        capability::agent_view::{AgentViewerArms, AgentVisibility},
        cold_read::availability::{HostAttachmentFacts, HostReachabilityFacts},
        identity::{AgentId, HostId, UserId},
        persistence::PersistenceFailure,
    };
    use tower::ServiceExt;

    use super::{HostAttachment, router};

    const PATH: &str = "/api/agents/a1/availability";

    fn user(id: &str) -> UserId {
        UserId::parse(id).expect("user id")
    }

    fn agent(id: &str) -> AgentId {
        AgentId::parse(id).expect("agent id")
    }

    fn host(id: &str) -> HostId {
        HostId::parse(id).expect("host id")
    }

    /// The three ACL arms, each of which admits a viewer on its own.
    enum Arm {
        Creator,
        DirectPair,
        Workspace,
        /// Admits some OTHER people, never `viewer-1`.
        NobodyRelevant,
    }

    /// An agent-view fact bundle for agent `a1` on host `h1`, whose ACL admits
    /// `viewer-1` through exactly the given arm (or nobody), at the given stage.
    fn view(
        arm: Arm,
        status: MaterializationStatus,
        deletion_started_at: Option<i64>,
    ) -> AgentViewFacts {
        let viewers = match arm {
            Arm::Creator => AgentViewerArms::new(Some(user("viewer-1")), [], []),
            Arm::DirectPair => AgentViewerArms::new(None, [user("viewer-1")], []),
            Arm::Workspace => AgentViewerArms::new(None, [], [user("viewer-1")]),
            Arm::NobodyRelevant => AgentViewerArms::new(
                Some(user("someone-else")),
                [user("pair-peer")],
                [user("member")],
            ),
        };
        AgentViewFacts::from_source(
            agent("a1"),
            AgentVisibility {
                viewers,
                materialization_status: status,
            },
            host("h1"),
            deletion_started_at,
        )
    }

    /// The ordinary admitting view: creator arm, active stage, not being deleted.
    fn admitting_view() -> AgentViewFacts {
        view(Arm::Creator, MaterializationStatus::Active, None)
    }

    #[derive(Clone)]
    enum ViewOutcome {
        Present(AgentViewFacts),
        Absent,
        Fails,
    }

    #[derive(Clone)]
    enum HostOutcome {
        Present(HostReachabilityFacts),
        Absent,
        Fails,
    }

    #[derive(Clone)]
    enum AttachmentOutcome {
        Facts(HostAttachmentFacts),
        Fails,
    }

    /// A live-host reachability fact for `h1` (unrevoked unless told otherwise).
    fn host_present(revoked_at: Option<i64>) -> HostOutcome {
        HostOutcome::Present(HostReachabilityFacts {
            id: host("h1"),
            revoked_at,
        })
    }

    /// An attachment observed for `h1`.
    fn attached_h1(attached: bool) -> AttachmentOutcome {
        AttachmentOutcome::Facts(HostAttachmentFacts {
            host_id: host("h1"),
            attached,
        })
    }

    /// Serves fixed outcomes and counts every read, so a path that answered WITHOUT
    /// reading the host (a refused caller) is distinguishable from one that read and
    /// then computed a value.
    #[derive(Clone)]
    struct FakeReads {
        view: ViewOutcome,
        host: HostOutcome,
        view_calls: Arc<AtomicUsize>,
        host_calls: Arc<AtomicUsize>,
    }

    impl AgentAvailabilityReadModel for FakeReads {
        async fn read_agent_view(
            &self,
            _agent: &AgentId,
        ) -> Result<Option<AgentViewFacts>, PersistenceFailure> {
            self.view_calls.fetch_add(1, SeqCst);
            match &self.view {
                ViewOutcome::Present(facts) => Ok(Some(facts.clone())),
                ViewOutcome::Absent => Ok(None),
                ViewOutcome::Fails => Err(PersistenceFailure::from_source(io::Error::other(
                    "agent view gone",
                ))),
            }
        }

        async fn read_host_reachability(
            &self,
            _host: &HostId,
        ) -> Result<Option<HostReachabilityFacts>, PersistenceFailure> {
            self.host_calls.fetch_add(1, SeqCst);
            match &self.host {
                HostOutcome::Present(facts) => Ok(Some(facts.clone())),
                HostOutcome::Absent => Ok(None),
                HostOutcome::Fails => Err(PersistenceFailure::from_source(io::Error::other(
                    "host store gone",
                ))),
            }
        }
    }

    #[derive(Clone)]
    struct FakeAttachment {
        outcome: AttachmentOutcome,
        calls: Arc<AtomicUsize>,
    }

    impl HostAttachment for FakeAttachment {
        fn host_attachment(
            &self,
            _host: &HostId,
        ) -> Result<HostAttachmentFacts, PersistenceFailure> {
            self.calls.fetch_add(1, SeqCst);
            match &self.outcome {
                AttachmentOutcome::Facts(facts) => Ok(facts.clone()),
                AttachmentOutcome::Fails => Err(PersistenceFailure::from_source(io::Error::other(
                    "attachment registry poisoned",
                ))),
            }
        }
    }

    struct Reply {
        status: StatusCode,
        body: String,
        view_calls: usize,
        host_calls: usize,
        attachment_calls: usize,
    }

    async fn get(
        view: ViewOutcome,
        host: HostOutcome,
        attachment: AttachmentOutcome,
        with_principal: bool,
    ) -> Reply {
        let view_calls = Arc::new(AtomicUsize::new(0));
        let host_calls = Arc::new(AtomicUsize::new(0));
        let attachment_calls = Arc::new(AtomicUsize::new(0));
        let reads = FakeReads {
            view,
            host,
            view_calls: view_calls.clone(),
            host_calls: host_calls.clone(),
        };
        let attach = FakeAttachment {
            outcome: attachment,
            calls: attachment_calls.clone(),
        };
        let mut request = Request::get(PATH);
        if with_principal {
            request = request.extension(user("viewer-1"));
        }
        let response = router(reads, attach)
            .oneshot(request.body(Body::empty()).unwrap())
            .await
            .unwrap();
        let status = response.status();
        let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        Reply {
            status,
            body: String::from_utf8(body.to_vec()).unwrap(),
            view_calls: view_calls.load(SeqCst),
            host_calls: host_calls.load(SeqCst),
            attachment_calls: attachment_calls.load(SeqCst),
        }
    }

    #[tokio::test]
    async fn an_attached_unrevoked_live_agent_is_online() {
        let reply = get(
            ViewOutcome::Present(admitting_view()),
            host_present(None),
            attached_h1(true),
            true,
        )
        .await;
        assert_eq!(reply.status, StatusCode::OK);
        assert_eq!(
            serde_json::from_str::<Value>(&reply.body).unwrap(),
            json!({ "availability": "online" })
        );
        // Access ran, then product read exactly once on each channel.
        assert_eq!(reply.view_calls, 1);
        assert_eq!(reply.host_calls, 1);
        assert_eq!(reply.attachment_calls, 1);
    }

    #[tokio::test]
    async fn each_visibility_arm_admits_the_viewer_on_its_own() {
        for arm in [Arm::Creator, Arm::DirectPair, Arm::Workspace] {
            let reply = get(
                ViewOutcome::Present(view(arm, MaterializationStatus::Active, None)),
                host_present(None),
                attached_h1(true),
                true,
            )
            .await;
            assert_eq!(reply.status, StatusCode::OK);
            assert_eq!(
                serde_json::from_str::<Value>(&reply.body).unwrap(),
                json!({ "availability": "online" })
            );
        }
    }

    #[tokio::test]
    async fn a_viewer_in_no_arm_is_a_404_that_never_reads_the_host() {
        // Dropping the arm that admitted a viewer flips them to the same 404 an
        // absent agent gets, and the host is never touched — access precedes
        // product.
        let reply = get(
            ViewOutcome::Present(view(
                Arm::NobodyRelevant,
                MaterializationStatus::Active,
                None,
            )),
            host_present(None),
            attached_h1(true),
            true,
        )
        .await;
        assert_eq!(reply.status, StatusCode::NOT_FOUND);
        assert_eq!(
            serde_json::from_str::<Value>(&reply.body).unwrap(),
            json!({ "error": "agent not found" })
        );
        assert_eq!(reply.view_calls, 1);
        assert_eq!(reply.host_calls, 0);
        assert_eq!(reply.attachment_calls, 0);
    }

    #[tokio::test]
    async fn an_absent_agent_is_the_same_404_and_never_reads_the_host() {
        let reply = get(
            ViewOutcome::Absent,
            host_present(None),
            attached_h1(true),
            true,
        )
        .await;
        assert_eq!(reply.status, StatusCode::NOT_FOUND);
        assert_eq!(
            serde_json::from_str::<Value>(&reply.body).unwrap(),
            json!({ "error": "agent not found" })
        );
        assert_eq!(reply.view_calls, 1);
        assert_eq!(reply.host_calls, 0);
        assert_eq!(reply.attachment_calls, 0);
    }

    #[tokio::test]
    async fn a_row_whose_stage_the_view_hides_is_the_same_404() {
        // The viewer IS in the ACL (creator), but the default view is active-only,
        // so a pending row is a 404 for them — indistinguishable from absence.
        for status in [
            MaterializationStatus::PendingMaterialization,
            MaterializationStatus::Failed,
        ] {
            let reply = get(
                ViewOutcome::Present(view(Arm::Creator, status, None)),
                host_present(None),
                attached_h1(true),
                true,
            )
            .await;
            assert_eq!(reply.status, StatusCode::NOT_FOUND);
            assert_eq!(
                serde_json::from_str::<Value>(&reply.body).unwrap(),
                json!({ "error": "agent not found" })
            );
            assert_eq!(reply.host_calls, 0);
            assert_eq!(reply.attachment_calls, 0);
        }
    }

    #[tokio::test]
    async fn a_being_deleted_agent_is_offline_and_reads_no_host_side_fact() {
        // Deletion is the earliest reachability rule: it answers offline without a
        // host or attachment read, so a source that is down on BOTH channels cannot
        // turn this 200-offline into a 500.
        let reply = get(
            ViewOutcome::Present(view(Arm::Creator, MaterializationStatus::Active, Some(10))),
            HostOutcome::Fails,
            AttachmentOutcome::Fails,
            true,
        )
        .await;
        assert_eq!(reply.status, StatusCode::OK);
        assert_eq!(
            serde_json::from_str::<Value>(&reply.body).unwrap(),
            json!({ "availability": "offline" })
        );
        assert_eq!(reply.host_calls, 0);
        assert_eq!(reply.attachment_calls, 0);
    }

    #[tokio::test]
    async fn a_missing_host_row_is_offline_and_reads_no_attachment() {
        // A gone host short-circuits before the attachment channel, so a faulting
        // attachment source cannot spoil this 200-offline.
        let reply = get(
            ViewOutcome::Present(admitting_view()),
            HostOutcome::Absent,
            AttachmentOutcome::Fails,
            true,
        )
        .await;
        assert_eq!(reply.status, StatusCode::OK);
        assert_eq!(
            serde_json::from_str::<Value>(&reply.body).unwrap(),
            json!({ "availability": "offline" })
        );
        assert_eq!(reply.host_calls, 1);
        assert_eq!(reply.attachment_calls, 0);
    }

    #[tokio::test]
    async fn a_revoked_host_is_offline_and_reads_no_attachment() {
        // Revocation wins over a socket the transport may still hold — and it wins
        // WITHOUT reading the attachment at all, so a faulting attachment source is
        // never consulted.
        let reply = get(
            ViewOutcome::Present(admitting_view()),
            host_present(Some(20)),
            AttachmentOutcome::Fails,
            true,
        )
        .await;
        assert_eq!(reply.status, StatusCode::OK);
        assert_eq!(
            serde_json::from_str::<Value>(&reply.body).unwrap(),
            json!({ "availability": "offline" })
        );
        assert_eq!(reply.host_calls, 1);
        assert_eq!(reply.attachment_calls, 0);
    }

    #[tokio::test]
    async fn a_detached_live_host_is_offline() {
        let reply = get(
            ViewOutcome::Present(admitting_view()),
            host_present(None),
            attached_h1(false),
            true,
        )
        .await;
        assert_eq!(reply.status, StatusCode::OK);
        assert_eq!(
            serde_json::from_str::<Value>(&reply.body).unwrap(),
            json!({ "availability": "offline" })
        );
    }

    #[tokio::test]
    async fn a_missing_principal_is_a_safe_500_that_never_reads() {
        // No perimeter ran, so no principal reached the handler: refuse fail-closed
        // BEFORE touching any store.
        let reply = get(
            ViewOutcome::Present(admitting_view()),
            host_present(None),
            attached_h1(true),
            false,
        )
        .await;
        assert_eq!(reply.status, StatusCode::INTERNAL_SERVER_ERROR);
        assert_eq!(reply.body, "Internal Server Error");
        assert_eq!(reply.view_calls, 0);
        assert_eq!(reply.host_calls, 0);
        assert_eq!(reply.attachment_calls, 0);
    }

    #[tokio::test]
    async fn an_agent_view_read_failure_is_a_safe_500() {
        let reply = get(
            ViewOutcome::Fails,
            host_present(None),
            attached_h1(true),
            true,
        )
        .await;
        assert_eq!(reply.status, StatusCode::INTERNAL_SERVER_ERROR);
        assert_eq!(reply.body, "Internal Server Error");
        assert!(!reply.body.contains("agent view gone"));
        assert_eq!(reply.host_calls, 0);
    }

    #[tokio::test]
    async fn a_host_read_failure_after_the_gate_is_a_safe_500() {
        let reply = get(
            ViewOutcome::Present(admitting_view()),
            HostOutcome::Fails,
            attached_h1(true),
            true,
        )
        .await;
        assert_eq!(reply.status, StatusCode::INTERNAL_SERVER_ERROR);
        assert_eq!(reply.body, "Internal Server Error");
        assert!(!reply.body.contains("host store gone"));
    }

    #[tokio::test]
    async fn an_attachment_read_failure_after_the_gate_is_a_safe_500() {
        let reply = get(
            ViewOutcome::Present(admitting_view()),
            host_present(None),
            AttachmentOutcome::Fails,
            true,
        )
        .await;
        assert_eq!(reply.status, StatusCode::INTERNAL_SERVER_ERROR);
        assert_eq!(reply.body, "Internal Server Error");
        assert!(!reply.body.contains("registry poisoned"));
    }

    #[tokio::test]
    async fn host_facts_for_the_wrong_host_are_a_safe_500() {
        // The agent sits on `h1`, but the host row read describes `h2`: a splice the
        // core seal refuses rather than projecting a plausible `offline`.
        let reply = get(
            ViewOutcome::Present(admitting_view()),
            HostOutcome::Present(HostReachabilityFacts {
                id: host("h2"),
                revoked_at: None,
            }),
            attached_h1(true),
            true,
        )
        .await;
        assert_eq!(reply.status, StatusCode::INTERNAL_SERVER_ERROR);
        assert_eq!(reply.body, "Internal Server Error");
    }

    #[tokio::test]
    async fn an_attachment_for_the_wrong_host_is_a_safe_500() {
        let reply = get(
            ViewOutcome::Present(admitting_view()),
            host_present(None),
            AttachmentOutcome::Facts(HostAttachmentFacts {
                host_id: host("h2"),
                attached: true,
            }),
            true,
        )
        .await;
        assert_eq!(reply.status, StatusCode::INTERNAL_SERVER_ERROR);
        assert_eq!(reply.body, "Internal Server Error");
    }

    #[tokio::test]
    async fn a_view_resolved_for_another_agent_is_a_safe_500_that_reads_no_host_side_fact() {
        // The URL asks about `a1`, but the resolver returns a row whose decoded id is
        // `a2`: the ACL would be judged against one agent and reachability computed
        // from another. The source-bind refuses it as a composition defect BEFORE the
        // gate, so nothing host-side is read — even though these arms would admit the
        // caller on their own.
        let spliced = AgentViewFacts::from_source(
            agent("a2"),
            AgentVisibility {
                viewers: AgentViewerArms::new(Some(user("viewer-1")), [], []),
                materialization_status: MaterializationStatus::Active,
            },
            host("h1"),
            None,
        );
        let reply = get(
            ViewOutcome::Present(spliced),
            host_present(None),
            attached_h1(true),
            true,
        )
        .await;
        assert_eq!(reply.status, StatusCode::INTERNAL_SERVER_ERROR);
        assert_eq!(reply.body, "Internal Server Error");
        assert_eq!(reply.host_calls, 0);
        assert_eq!(reply.attachment_calls, 0);
    }
}
