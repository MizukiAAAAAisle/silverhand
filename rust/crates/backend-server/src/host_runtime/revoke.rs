//! Authenticated `POST /api/hosts/{id}/revoke`: an owner ends the custody of an
//! app-managed computer — the tombstone stamp and the credential sweep, then the
//! best-effort disconnect.
//!
//! Three authorities, in order:
//!
//!  1. ADMIT — [`find_owned_computer`] resolves the named computer for this requester;
//!     an absent row and someone else's collapse to ONE byte-identical `404`, so the
//!     surface is never an existence oracle for computer ids.
//!  2. REFUSE — a user-managed computer has no revoke half-state, so [`RevokeComputer`]
//!     answers it with a `409 provisioning_source_not_supported`. The check lives in the
//!     domain's `admit`, reached before the write, so the route only carries its verdict.
//!  3. END — the tombstone + sweep are one transaction inside the domain; the
//!     post-commit availability announce and daemon disconnect are best-effort and their
//!     failures are logged here, never turned into a non-`200`, exactly as the
//!     TypeScript use case swallows them.
//!
//! The availability announcer and daemon-connection control are REQUIREMENT SEAMS: the
//! domain declares them, this route threads them through, and both are left UNMOUNTED —
//! wiring the real websocket controller is the composition root's job (#task:2197). The
//! human principal's ABSENCE is a composition fault, so it takes a fail-closed `500`
//! having read nothing.

use std::sync::Arc;

use axum::{
    Json, Router,
    extract::{Extension, Path, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::post,
};
use serde::Serialize;
use silverhand_backend_core::{
    host_runtime::{
        aftermath::{AgentAvailabilityAnnouncer, DaemonConnectionControl},
        environment::Clock,
        read::{ComputerReadModel, find_owned_computer},
        revoke::{RevokeComputer, RevokeComputerError, RevokeComputerUnitOfWork},
    },
    identity::{HostId, UserId},
};

use crate::error;

use super::{
    ErrorBody, host_not_found,
    host_wire::{HostDto, host_wire},
    internal_error,
};

/// The product route template, in axum's `{id}` capture syntax.
pub const HOST_REVOKE_PATH: &str = "/api/hosts/{id}/revoke";

/// The user-managed refusal, pinned to the TypeScript handler
/// (`{ error: 'revoke is not supported for user-managed computers',
/// error_code: 'provisioning_source_not_supported' }`).
const REVOKE_UNSUPPORTED: &str = "revoke is not supported for user-managed computers";
const PROVISIONING_SOURCE_NOT_SUPPORTED_CODE: &str = "provisioning_source_not_supported";

struct RevokeState<R, U, A, D, C> {
    read_model: R,
    revoke: Arc<RevokeComputer<U, A, D, C>>,
}

impl<R, U, A, D, C> Clone for RevokeState<R, U, A, D, C>
where
    R: Clone,
{
    fn clone(&self) -> Self {
        Self {
            read_model: self.read_model.clone(),
            revoke: Arc::clone(&self.revoke),
        }
    }
}

pub fn router<R, U, A, D, C>(read_model: R, revoke: RevokeComputer<U, A, D, C>) -> Router
where
    R: ComputerReadModel,
    U: RevokeComputerUnitOfWork,
    A: AgentAvailabilityAnnouncer,
    D: DaemonConnectionControl,
    C: Clock + 'static,
{
    Router::new()
        .route(HOST_REVOKE_PATH, post(host_revoke::<R, U, A, D, C>))
        .with_state(RevokeState {
            read_model,
            revoke: Arc::new(revoke),
        })
}

async fn host_revoke<R, U, A, D, C>(
    Path(host_id): Path<String>,
    requester: Option<Extension<UserId>>,
    State(state): State<RevokeState<R, U, A, D, C>>,
) -> Response
where
    R: ComputerReadModel,
    U: RevokeComputerUnitOfWork,
    A: AgentAvailabilityAnnouncer,
    D: DaemonConnectionControl,
    C: Clock + 'static,
{
    let Some(Extension(requester)) = requester else {
        tracing::error!("host-revoke route reached without its human principal fact");
        return internal_error();
    };

    // A malformed id names no computer — the same 404 an absent row gets, so the surface
    // never distinguishes "unparseable" from "not there".
    let Ok(computer) = HostId::parse(host_id) else {
        return host_not_found();
    };

    let record = match state.read_model.read_computer(computer).await {
        Ok(record) => record,
        Err(cause) => {
            tracing::error!(
                error_chain = %error::describe(&cause),
                "host-revoke read failed"
            );
            return internal_error();
        }
    };

    let Some(owned) = find_owned_computer(&requester, record) else {
        return host_not_found();
    };

    match state.revoke.execute(owned).await {
        Ok(ended) => {
            // The transaction is durable; the announce and disconnect are optimistic UX.
            // A failure in either is operator signal, not a product answer, so it is
            // logged and the revoke still reports success.
            if let Some(failure) = &ended.availability_announcement_failure {
                tracing::error!(
                    error_chain = %error::describe(failure),
                    "host-revoke availability announce failed"
                );
            }
            if let Some(failure) = &ended.daemon_disconnect_failure {
                tracing::error!(
                    error_chain = %error::describe(failure),
                    "host-revoke daemon disconnect failed"
                );
            }
            Json(RevokeResponse {
                host: host_wire(&ended.computer),
            })
            .into_response()
        }
        Err(RevokeComputerError::Refused(_)) => (
            StatusCode::CONFLICT,
            Json(ErrorBody {
                error: REVOKE_UNSUPPORTED,
                error_code: PROVISIONING_SOURCE_NOT_SUPPORTED_CODE,
            }),
        )
            .into_response(),
        Err(cause) => {
            tracing::error!(
                error_chain = %error::describe(&cause),
                "host-revoke failed"
            );
            internal_error()
        }
    }
}

/// Success body: `{ "host": HostDto }` — the computer as it stands after the tombstone,
/// projected through the one wire.
#[derive(Serialize)]
struct RevokeResponse {
    host: HostDto,
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
        http::Request,
    };
    use serde_json::{Value, json};
    use silverhand_backend_core::{
        foundation::persistence::PersistenceFailure,
        host_runtime::{
            aftermath::CustodyEffectFailure,
            computer::{ComputerRecord, HostKind, ProvisioningSource},
            revoke::{RevokeComputerAttempt, RevokedComputer},
        },
    };
    use tower::ServiceExt;

    use super::*;

    const REQUESTER: &str = "u-requester";

    fn user(id: &str) -> UserId {
        UserId::parse(id).expect("user id")
    }

    fn host(id: &str) -> HostId {
        HostId::parse(id).expect("host id")
    }

    /// An app-managed local computer owned by `owner` — the kind revoke acts on.
    fn app_managed(id: &str, owner: &str) -> ComputerRecord {
        ComputerRecord {
            id: host(id),
            name: format!("{id}-name"),
            kind: HostKind::Local,
            created_at: 1,
            owner: Some(user(owner)),
            installation_id: Some("i1".to_owned()),
            last_seen_at: Some(9),
            activated_at: Some(2),
            finalized_at: Some(3),
            revoked_at: None,
            provisioning_source: ProvisioningSource::AppInstall,
            display_label: None,
        }
    }

    /// A user-managed computer owned by `owner` — the kind revoke refuses.
    fn user_managed(id: &str, owner: &str) -> ComputerRecord {
        ComputerRecord {
            kind: HostKind::Remote,
            provisioning_source: ProvisioningSource::UserInvite,
            ..app_managed(id, owner)
        }
    }

    #[derive(Clone)]
    enum ReadOutcome {
        Present(ComputerRecord),
        Absent,
        Fails,
    }

    #[derive(Clone)]
    struct FakeComputers {
        outcome: ReadOutcome,
        reads: Arc<AtomicUsize>,
    }

    impl ComputerReadModel for FakeComputers {
        async fn list_for_owner(
            &self,
            _owner: UserId,
        ) -> Result<Vec<ComputerRecord>, PersistenceFailure> {
            unreachable!("the revoke route never lists")
        }

        async fn read_computer(
            &self,
            _computer: HostId,
        ) -> Result<Option<ComputerRecord>, PersistenceFailure> {
            self.reads.fetch_add(1, SeqCst);
            match &self.outcome {
                ReadOutcome::Present(record) => Ok(Some(record.clone())),
                ReadOutcome::Absent => Ok(None),
                ReadOutcome::Fails => Err(PersistenceFailure::from_source(io::Error::other(
                    "host gone",
                ))),
            }
        }
    }

    #[derive(Clone)]
    enum WriteOutcome {
        /// The tombstone landed; the record it reads back, and whether custody ended now.
        Revoked(Box<ComputerRecord>, bool),
        /// No row under the lock — a fault for this door, never a 404.
        Vanished,
        Fails,
    }

    #[derive(Clone)]
    struct FakeRevokeStore {
        outcome: WriteOutcome,
        calls: Arc<AtomicUsize>,
    }

    impl RevokeComputerUnitOfWork for FakeRevokeStore {
        async fn revoke_computer(
            &self,
            _attempt: RevokeComputerAttempt,
        ) -> Result<Option<RevokedComputer>, PersistenceFailure> {
            self.calls.fetch_add(1, SeqCst);
            match &self.outcome {
                WriteOutcome::Revoked(computer, custody_ended_now) => Ok(Some(RevokedComputer {
                    computer: (**computer).clone(),
                    custody_ended_now: *custody_ended_now,
                })),
                WriteOutcome::Vanished => Ok(None),
                WriteOutcome::Fails => Err(PersistenceFailure::from_source(io::Error::other(
                    "revoke gone",
                ))),
            }
        }
    }

    #[derive(Clone)]
    struct FakeEffect {
        fails: bool,
        calls: Arc<AtomicUsize>,
    }

    impl FakeEffect {
        fn ok() -> Self {
            Self {
                fails: false,
                calls: Arc::new(AtomicUsize::new(0)),
            }
        }

        fn failing() -> Self {
            Self {
                fails: true,
                calls: Arc::new(AtomicUsize::new(0)),
            }
        }

        fn result(&self) -> Result<(), CustodyEffectFailure> {
            self.calls.fetch_add(1, SeqCst);
            if self.fails {
                Err(CustodyEffectFailure::from_source(io::Error::other(
                    "effect failed",
                )))
            } else {
                Ok(())
            }
        }
    }

    impl AgentAvailabilityAnnouncer for FakeEffect {
        async fn agents_availability_changed(
            &self,
            _computer: HostId,
        ) -> Result<(), CustodyEffectFailure> {
            self.result()
        }
    }

    impl DaemonConnectionControl for FakeEffect {
        async fn disconnect(&self, _computer: HostId) -> Result<(), CustodyEffectFailure> {
            self.result()
        }
    }

    #[derive(Clone)]
    struct FixedClock;

    impl Clock for FixedClock {
        type Error = std::convert::Infallible;
        fn unix_time_ms(&self) -> Result<i64, Self::Error> {
            Ok(1_700_000_000_123)
        }
    }

    struct Harness {
        reads: Arc<AtomicUsize>,
        writes: Arc<AtomicUsize>,
        availability: FakeEffect,
        daemons: FakeEffect,
    }

    struct Reply {
        status: StatusCode,
        body: String,
    }

    async fn revoke(
        read: ReadOutcome,
        write: WriteOutcome,
        availability: FakeEffect,
        daemons: FakeEffect,
        path_id: &str,
        with_principal: bool,
    ) -> (Reply, Harness) {
        let reads = Arc::new(AtomicUsize::new(0));
        let writes = Arc::new(AtomicUsize::new(0));
        let read_model = FakeComputers {
            outcome: read,
            reads: reads.clone(),
        };
        let store = FakeRevokeStore {
            outcome: write,
            calls: writes.clone(),
        };
        let orchestrator =
            RevokeComputer::new(store, availability.clone(), daemons.clone(), FixedClock);
        let mut request = Request::post(format!("/api/hosts/{path_id}/revoke"));
        if with_principal {
            request = request.extension(user(REQUESTER));
        }
        let response = router(read_model, orchestrator)
            .oneshot(request.body(Body::empty()).unwrap())
            .await
            .unwrap();
        let status = response.status();
        let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        (
            Reply {
                status,
                body: String::from_utf8(body.to_vec()).unwrap(),
            },
            Harness {
                reads,
                writes,
                availability,
                daemons,
            },
        )
    }

    /// The common case: an owned app-managed computer, custody ending now, effects clean.
    async fn revoke_owned(read: ReadOutcome, write: WriteOutcome) -> (Reply, Harness) {
        revoke(read, write, FakeEffect::ok(), FakeEffect::ok(), "h1", true).await
    }

    fn parsed(body: &str) -> Value {
        serde_json::from_str::<Value>(body).unwrap()
    }

    /// A tombstoned computer projects through the one wire as revoked, and the two
    /// post-commit effects fire — availability because custody ended now, disconnect
    /// always.
    #[tokio::test]
    async fn an_owned_app_managed_computer_is_revoked_and_the_effects_fire() {
        let revoked = ComputerRecord {
            revoked_at: Some(1_700_000_000_123),
            ..app_managed("h1", REQUESTER)
        };
        let (reply, harness) = revoke_owned(
            ReadOutcome::Present(app_managed("h1", REQUESTER)),
            WriteOutcome::Revoked(Box::new(revoked), true),
        )
        .await;
        assert_eq!(reply.status, StatusCode::OK);
        let body = parsed(&reply.body);
        assert_eq!(body["host"]["id"], "h1");
        assert_eq!(body["host"]["status"], "revoked");
        assert_eq!(body["host"]["revoked_at"], 1_700_000_000_123_i64);
        assert!(!body["host"]["placeable"].as_bool().unwrap());
        assert_eq!(harness.reads.load(SeqCst), 1);
        assert_eq!(harness.writes.load(SeqCst), 1);
        assert_eq!(harness.availability.calls.load(SeqCst), 1);
        assert_eq!(harness.daemons.calls.load(SeqCst), 1);
    }

    /// A repeat revoke that did NOT end custody now still succeeds and still disconnects,
    /// but does not re-announce availability.
    #[tokio::test]
    async fn a_repeat_revoke_disconnects_without_re_announcing() {
        let already = ComputerRecord {
            revoked_at: Some(5),
            ..app_managed("h1", REQUESTER)
        };
        let (reply, harness) = revoke_owned(
            ReadOutcome::Present(app_managed("h1", REQUESTER)),
            WriteOutcome::Revoked(Box::new(already), false),
        )
        .await;
        assert_eq!(reply.status, StatusCode::OK);
        assert_eq!(harness.availability.calls.load(SeqCst), 0);
        assert_eq!(harness.daemons.calls.load(SeqCst), 1);
    }

    /// A best-effort effect that fails is logged and swallowed: the revoke is still a
    /// `200`, because the transaction that ended custody already committed.
    #[tokio::test]
    async fn a_failing_post_commit_effect_does_not_change_the_success() {
        let revoked = ComputerRecord {
            revoked_at: Some(1_700_000_000_123),
            ..app_managed("h1", REQUESTER)
        };
        let (reply, harness) = revoke(
            ReadOutcome::Present(app_managed("h1", REQUESTER)),
            WriteOutcome::Revoked(Box::new(revoked), true),
            FakeEffect::failing(),
            FakeEffect::failing(),
            "h1",
            true,
        )
        .await;
        assert_eq!(reply.status, StatusCode::OK);
        assert_eq!(parsed(&reply.body)["host"]["status"], "revoked");
        assert_eq!(harness.availability.calls.load(SeqCst), 1);
        assert_eq!(harness.daemons.calls.load(SeqCst), 1);
    }

    /// A user-managed computer has no revoke half-state: `409`, and the write is never
    /// reached because the domain's `admit` refuses before the transaction.
    #[tokio::test]
    async fn a_user_managed_computer_is_a_409_before_the_write() {
        let (reply, harness) = revoke_owned(
            ReadOutcome::Present(user_managed("h1", REQUESTER)),
            WriteOutcome::Revoked(Box::new(user_managed("h1", REQUESTER)), true),
        )
        .await;
        assert_eq!(reply.status, StatusCode::CONFLICT);
        assert_eq!(
            parsed(&reply.body),
            json!({
                "error": "revoke is not supported for user-managed computers",
                "error_code": "provisioning_source_not_supported"
            })
        );
        assert_eq!(harness.writes.load(SeqCst), 0);
        assert_eq!(harness.daemons.calls.load(SeqCst), 0);
    }

    /// An absent row and a foreign one render the SAME `404` and never reach the write.
    #[tokio::test]
    async fn a_missing_or_foreign_computer_is_one_byte_identical_404() {
        let refused = json!({ "error": "host not found", "error_code": "host_not_found" });
        for read in [
            ReadOutcome::Absent,
            ReadOutcome::Present(app_managed("h1", "u-someone-else")),
        ] {
            let (reply, harness) = revoke_owned(
                read,
                WriteOutcome::Revoked(Box::new(app_managed("h1", REQUESTER)), true),
            )
            .await;
            assert_eq!(reply.status, StatusCode::NOT_FOUND);
            assert_eq!(parsed(&reply.body), refused);
            assert_eq!(harness.writes.load(SeqCst), 0);
        }
    }

    /// A row that disappears from under an admitted revoke is a composition fault, not a
    /// `404` — this door only reaches the write with a computer it just authorized.
    #[tokio::test]
    async fn a_vanished_row_under_the_write_is_a_fail_closed_500() {
        let (reply, _harness) = revoke_owned(
            ReadOutcome::Present(app_managed("h1", REQUESTER)),
            WriteOutcome::Vanished,
        )
        .await;
        assert_eq!(reply.status, StatusCode::INTERNAL_SERVER_ERROR);
        assert_eq!(reply.body, "Internal Server Error");
    }

    /// A persistence failure in the write is the framework's plain `500`.
    #[tokio::test]
    async fn a_write_failure_is_the_frameworks_plain_500() {
        let (reply, _harness) = revoke_owned(
            ReadOutcome::Present(app_managed("h1", REQUESTER)),
            WriteOutcome::Fails,
        )
        .await;
        assert_eq!(reply.status, StatusCode::INTERNAL_SERVER_ERROR);
        assert_eq!(reply.body, "Internal Server Error");
    }

    /// A failed read fails closed before the write.
    #[tokio::test]
    async fn a_failed_read_is_the_frameworks_plain_500() {
        let (reply, harness) = revoke_owned(
            ReadOutcome::Fails,
            WriteOutcome::Revoked(Box::new(app_managed("h1", REQUESTER)), true),
        )
        .await;
        assert_eq!(reply.status, StatusCode::INTERNAL_SERVER_ERROR);
        assert_eq!(reply.body, "Internal Server Error");
        assert_eq!(harness.writes.load(SeqCst), 0);
    }

    /// The principal is the perimeter's contribution; without it the route reads NOTHING
    /// and fails closed.
    #[tokio::test]
    async fn a_missing_principal_reads_nothing_and_fails_closed() {
        let (reply, harness) = revoke(
            ReadOutcome::Present(app_managed("h1", REQUESTER)),
            WriteOutcome::Revoked(Box::new(app_managed("h1", REQUESTER)), true),
            FakeEffect::ok(),
            FakeEffect::ok(),
            "h1",
            false,
        )
        .await;
        assert_eq!(reply.status, StatusCode::INTERNAL_SERVER_ERROR);
        assert_eq!(reply.body, "Internal Server Error");
        assert_eq!(harness.reads.load(SeqCst), 0);
        assert_eq!(harness.writes.load(SeqCst), 0);
    }
}
