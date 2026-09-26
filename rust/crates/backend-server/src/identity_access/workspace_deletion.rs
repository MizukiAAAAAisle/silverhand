//! `DELETE /api/workspaces/{id}` — the human-perimeter workspace delete.
//!
//! The route delegates to one transactional delete authority and post-commit
//! aftermath. The writer decides, captures the teardown plan and cascades under
//! one lock; only `Committed(plan)` authorizes runtime stops, blob cleanup and
//! `viewer_workspaces_changed { removed }` fan-out. Refusal/no-op verdicts
//! reach ZERO aftermath; a single failed effect leg is
//! observable and does not suppress the others or rewrite the committed 204.

use std::sync::Arc;

use axum::{
    Router,
    extract::{Extension, Path, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::delete,
};
use serde::Serialize;
use silverhand_backend_core::{
    foundation::identity::UserId,
    identity_access::workspace_deletion::{
        WorkspaceDeletionOutcome, WorkspaceDeletionWrite, WorkspaceTeardownPlan,
    },
};

pub const WORKSPACE_PATH: &str = "/api/workspaces/{id}";

/// The delete aftermath, SPLIT to bracket the row cascade.
/// Both legs consume the PHASE-2 plan (captured in the same tx as the cascade, so it
/// reflects exactly the rows erased). `terminalize_and_sweep`: terminalizes each
/// ConversationSlot run to `conversation_closed` via the run-state projection,
/// detaches the runtime hard-stops via the managed executor (never a 204 gate),
/// and AWAITS the blob sweep over the plan's captured storage keys (a mid-sweep crash
/// leaves GC-able orphan blobs — the accepted trade-off for the #2 invariant).
/// `announce_removed`: the `viewer_workspaces_changed { removed }` fan-out. Every
/// leg's failure is observable and never aborts the others or rewrites the 204.
pub trait WorkspaceDeletionAftermath: Send + Sync + 'static {
    fn terminalize_and_sweep(
        &self,
        plan: &WorkspaceTeardownPlan,
    ) -> impl std::future::Future<Output = ()> + Send;

    fn announce_removed(
        &self,
        plan: &WorkspaceTeardownPlan,
    ) -> impl std::future::Future<Output = ()> + Send;
}

/// The run-state projection authority the aftermath consults to bulk-terminalize the
/// torn-down conversations to `conversation_closed` BEFORE the daemon hard-stop -
/// the SAME authority the runtime-event owner uses, never a second
/// run-state store. Best-effort: a failure is observable and never blocks the
/// stop/blob/viewer legs or rewrites the 204.
pub trait ConversationRunTerminalization: Send + Sync + 'static {
    /// Terminalize every non-terminal ConversationSlot run in `conversations` to
    /// `conversation_closed`, one `agent_activity` per run (AgentSlot excluded).
    fn terminalize_conversations_closed(
        &self,
        conversations: &std::collections::HashSet<
            silverhand_backend_core::foundation::identity::ConversationId,
        >,
    ) -> Result<(), ConversationRunTerminalizeError>;
}

/// The best-effort terminalization failure surfaced to the aftermath (logged, never
/// propagated).
#[derive(Debug)]
pub struct ConversationRunTerminalizeError;

/// The concrete run-state terminalizer handle IS the run-state projection authority:
/// bridge it to the aftermath's narrow port here (orphan rule — both
/// the trait and the handle are in this crate).
impl ConversationRunTerminalization
    for crate::host_runtime::runtime_event_settlement::ConversationRunTerminalizer
{
    fn terminalize_conversations_closed(
        &self,
        conversations: &std::collections::HashSet<
            silverhand_backend_core::foundation::identity::ConversationId,
        >,
    ) -> Result<(), ConversationRunTerminalizeError> {
        self.terminalize_conversations_closed(conversations)
            .map_err(|_| ConversationRunTerminalizeError)
    }
}

pub struct WorkspaceDeleteState<W, A> {
    pub writes: W,
    pub aftermath: A,
}

struct Shared<W, A>(Arc<WorkspaceDeleteState<W, A>>);
impl<W, A> Clone for Shared<W, A> {
    fn clone(&self) -> Self {
        Self(Arc::clone(&self.0))
    }
}

pub fn workspace_delete_router<W, A>(state: WorkspaceDeleteState<W, A>) -> Router
where
    W: WorkspaceDeletionWrite + Send + Sync + 'static,
    A: WorkspaceDeletionAftermath,
{
    Router::new()
        .route(WORKSPACE_PATH, delete(delete_workspace::<W, A>))
        .with_state(Shared(Arc::new(state)))
}

async fn delete_workspace<W, A>(
    State(state): State<Shared<W, A>>,
    principal: Option<Extension<UserId>>,
    Path(id): Path<String>,
) -> Response
where
    W: WorkspaceDeletionWrite + Send + Sync + 'static,
    A: WorkspaceDeletionAftermath,
{
    let Some(Extension(viewer)) = principal else {
        return registration_required();
    };
    if id.is_empty() {
        return error(StatusCode::BAD_REQUEST, "workspace id required");
    }
    let workspace_id = match silverhand_backend_core::foundation::identity::WorkspaceId::parse(&id)
    {
        Ok(workspace_id) => workspace_id,
        // A structurally-empty id is caught above; parse never fails on a
        // non-empty string, but keep the branch total.
        Err(_) => return error(StatusCode::BAD_REQUEST, "workspace id required"),
    };
    // ONE writer call is the authority; it returns a single closed
    // outcome, and the route maps each DISTINCT product result to its DISTINCT status.
    // ONLY `Committed(plan)` runs the destructive aftermath + `removed` fan-out (over
    // the plan the cascade actually erased), so no destructive effect precedes the
    // authorization; a concurrent winner / owner change / kind change are 204 / 403 /
    // 409 respectively, never folded together.
    match state
        .0
        .writes
        .delete_workspace(&viewer, &workspace_id)
        .await
    {
        Ok(WorkspaceDeletionOutcome::Committed(plan)) => {
            state.0.aftermath.terminalize_and_sweep(&plan).await;
            state.0.aftermath.announce_removed(&plan).await;
            StatusCode::NO_CONTENT.into_response()
        }
        // No workspace answered to the id (never existed, or a concurrent winner already
        // removed it): idempotent 204, zero effect.
        Ok(WorkspaceDeletionOutcome::IdempotentNoop) => StatusCode::NO_CONTENT.into_response(),
        // A kind change (agent-home): 409, distinct from the idempotent no-op.
        Ok(WorkspaceDeletionOutcome::NotDeletableKind) => error_with_code(
            StatusCode::CONFLICT,
            "workspace kind cannot be deleted via workspace endpoint",
            "workspace_not_deletable",
        ),
        // A regular workspace the requester does not own (incl. an owner change): 403.
        Ok(WorkspaceDeletionOutcome::Forbidden) => error(StatusCode::FORBIDDEN, "forbidden"),
        Err(cause) => {
            tracing::error!(
                error_chain = crate::foundation::safe_log_field::safe_display(
                    &(crate::foundation::error::describe(&cause))
                ),
                "workspace delete write failed"
            );
            (StatusCode::INTERNAL_SERVER_ERROR, "Internal Server Error").into_response()
        }
    }
}

#[derive(Serialize)]
struct ErrorBody {
    error: &'static str,
}

fn error(status: StatusCode, message: &'static str) -> Response {
    (status, axum::Json(ErrorBody { error: message })).into_response()
}

fn error_with_code(status: StatusCode, message: &'static str, code: &'static str) -> Response {
    (
        status,
        axum::Json(serde_json::json!({ "error": message, "code": code })),
    )
        .into_response()
}

fn registration_required() -> Response {
    (
        StatusCode::FORBIDDEN,
        axum::Json(serde_json::json!({
            "error": "viewer has not authenticated yet",
            "code": "registration_required"
        })),
    )
        .into_response()
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::Body;
    use axum::http::Request;
    use silverhand_backend_core::foundation::identity::WorkspaceId;
    use std::sync::Arc;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use tower::ServiceExt;

    fn plan() -> WorkspaceTeardownPlan {
        WorkspaceTeardownPlan {
            runtime_seats: vec![],
            blobs: vec![],
            conversation_ids: vec![],
            viewer_members: vec![UserId::parse("user-1").unwrap()],
            workspace: WorkspaceId::parse("ws-1").unwrap(),
        }
    }

    /// A writer that returns a configurable single closed outcome (to drive the route's
    /// per-outcome status + effect mapping).
    #[derive(Clone)]
    struct StubWrites {
        outcome: WorkspaceDeletionOutcome,
    }
    impl WorkspaceDeletionWrite for StubWrites {
        async fn delete_workspace(
            &self,
            _requester: &UserId,
            _workspace_id: &WorkspaceId,
        ) -> Result<
            WorkspaceDeletionOutcome,
            silverhand_backend_core::foundation::persistence::PersistenceFailure,
        > {
            Ok(self.outcome.clone())
        }
    }

    /// An aftermath that counts its destructive/announce legs so a non-committed
    /// outcome can be proven to reach ZERO of them.
    #[derive(Clone, Default)]
    struct CountingAftermath {
        terminalize: Arc<AtomicUsize>,
        announce: Arc<AtomicUsize>,
    }
    impl WorkspaceDeletionAftermath for CountingAftermath {
        async fn terminalize_and_sweep(&self, _plan: &WorkspaceTeardownPlan) {
            self.terminalize.fetch_add(1, Ordering::SeqCst);
        }
        async fn announce_removed(&self, _plan: &WorkspaceTeardownPlan) {
            self.announce.fetch_add(1, Ordering::SeqCst);
        }
    }

    async fn run(outcome: WorkspaceDeletionOutcome, aftermath: CountingAftermath) -> StatusCode {
        let router = workspace_delete_router(WorkspaceDeleteState {
            writes: StubWrites { outcome },
            aftermath,
        });
        let response = router
            .oneshot(
                Request::builder()
                    .method("DELETE")
                    .uri("/api/workspaces/ws-1")
                    .extension(UserId::parse("user-1").unwrap())
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        response.status()
    }

    #[tokio::test]
    async fn a_committed_outcome_runs_the_destructive_aftermath_and_announces() {
        let aftermath = CountingAftermath::default();
        let status = run(
            WorkspaceDeletionOutcome::Committed(plan()),
            aftermath.clone(),
        )
        .await;
        assert_eq!(status, StatusCode::NO_CONTENT);
        assert_eq!(aftermath.terminalize.load(Ordering::SeqCst), 1);
        assert_eq!(aftermath.announce.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn each_non_committed_outcome_maps_to_its_distinct_status_with_zero_effect() {
        // The delete taxonomy is NOT all folded to 204. IdempotentNoop →
        // 204 (concurrent winner / never existed), Forbidden → 403 (owner change),
        // NotDeletableKind → 409 (kind change) — and NONE runs the destructive aftermath
        // or the removal broadcast.
        for (outcome, expected) in [
            (
                WorkspaceDeletionOutcome::IdempotentNoop,
                StatusCode::NO_CONTENT,
            ),
            (WorkspaceDeletionOutcome::Forbidden, StatusCode::FORBIDDEN),
            (
                WorkspaceDeletionOutcome::NotDeletableKind,
                StatusCode::CONFLICT,
            ),
        ] {
            let aftermath = CountingAftermath::default();
            let status = run(outcome.clone(), aftermath.clone()).await;
            assert_eq!(status, expected, "outcome {outcome:?} maps to {expected}");
            assert_eq!(
                aftermath.terminalize.load(Ordering::SeqCst),
                0,
                "{outcome:?} does zero destructive effect"
            );
            assert_eq!(
                aftermath.announce.load(Ordering::SeqCst),
                0,
                "{outcome:?} broadcasts no removal"
            );
        }
    }
}
