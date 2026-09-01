//! Authenticated `POST /api/hosts/{id}/connect-token/rotate`: an owner replaces the
//! connect token THEY hold for a computer they brought.
//!
//! The mirror of `rotate-token`. That door rotates the daemon's own secret and hands the
//! new one to whoever stores the daemon config; this one rotates the token the USER holds,
//! kills the old one at the same instant (no grace window — the point is that a secret the
//! user believes is compromised stops working now), and drops any socket still using it.
//! The fresh token is revealed once in the HTTP body, because the user is the thing that
//! keeps it.
//!
//! One authority, one arm: unlike `rotate-token` there is no deployment-mode split. The
//! disconnect is best-effort by contract — the old token is already dead, so a daemon that
//! is still attached is a socket that can no longer re-authenticate — which is why a
//! control-plane-only server has nothing to refuse and answers no `503`.
//!
//! The order, in TypeScript's:
//!
//!  1. ADMIT — [`find_owned_computer`] resolves the named computer for this requester; an
//!     absent row and a foreign one collapse to ONE byte-identical `404`, so the surface
//!     is never an existence oracle for computer ids.
//!  2. REFUSE + ROTATE — [`RotateConnectToken::execute`] runs the custody/kind refusal in
//!     the same write it commits, so a revoked computer (`409 host_revoked`) and one that
//!     is not user-managed (`409 provisioning_source_not_supported`) are both answered
//!     before any credential is minted, and a revoke that lands under the lock is the
//!     in-lock verdict's `409 host_revoked`.
//!
//! The daemon-connection control is a REQUIREMENT SEAM: the domain declares it, this route
//! threads it through, and it is left UNMOUNTED — wiring the real websocket controller is
//! the composition root's job (#task:2197). The human principal's ABSENCE is a composition
//! fault, so it takes a fail-closed `500` having read nothing.

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
    foundation::identity::{HostId, UserId},
    host_runtime::{
        aftermath::DaemonConnectionControl,
        custody::{CredentialIssueRefusal, CredentialIssueUnitOfWork},
        environment::{Clock, EntropySource},
        read::{ComputerReadModel, find_owned_computer},
        rotation::{ConnectTokenRotationError, ConnectTokenRotationRefusal, RotateConnectToken},
    },
};

use crate::error;

use super::{
    ErrorBody, host_not_found,
    host_wire::{HostDto, host_wire},
    internal_error, resolve_daemon_npm_spec,
};

/// The product route template, in axum's `{id}` capture syntax.
pub const HOST_ROTATE_CONNECT_TOKEN_PATH: &str = "/api/hosts/{id}/connect-token/rotate";

/// The custody refusal, pinned to the TypeScript handler
/// (`{ error: 'host has been revoked', error_code: 'host_revoked' }`).
const HOST_REVOKED: &str = "host has been revoked";
const HOST_REVOKED_CODE: &str = "host_revoked";

/// The kind refusal — only the computer the USER brought holds a connect token to rotate.
const NOT_USER_MANAGED: &str =
    "connect-token rotation is only supported for user-managed computers";
const PROVISIONING_SOURCE_NOT_SUPPORTED_CODE: &str = "provisioning_source_not_supported";

struct ConnectRotateState<M, W, R, C, D> {
    read_model: M,
    rotation: Arc<RotateConnectToken<W, R, C, D>>,
    daemon_npm_spec: String,
}

impl<M, W, R, C, D> Clone for ConnectRotateState<M, W, R, C, D>
where
    M: Clone,
{
    fn clone(&self) -> Self {
        Self {
            read_model: self.read_model.clone(),
            rotation: Arc::clone(&self.rotation),
            daemon_npm_spec: self.daemon_npm_spec.clone(),
        }
    }
}

pub fn router<M, W, R, C, D>(
    read_model: M,
    rotation: RotateConnectToken<W, R, C, D>,
    daemon_npm_spec: Option<String>,
) -> Router
where
    M: ComputerReadModel,
    W: CredentialIssueUnitOfWork,
    R: EntropySource + 'static,
    C: Clock + 'static,
    D: DaemonConnectionControl,
{
    Router::new()
        .route(
            HOST_ROTATE_CONNECT_TOKEN_PATH,
            post(rotate_connect_token::<M, W, R, C, D>),
        )
        .with_state(ConnectRotateState {
            read_model,
            rotation: Arc::new(rotation),
            daemon_npm_spec: resolve_daemon_npm_spec(daemon_npm_spec),
        })
}

async fn rotate_connect_token<M, W, R, C, D>(
    Path(host_id): Path<String>,
    requester: Option<Extension<UserId>>,
    State(state): State<ConnectRotateState<M, W, R, C, D>>,
) -> Response
where
    M: ComputerReadModel,
    W: CredentialIssueUnitOfWork,
    R: EntropySource + 'static,
    C: Clock + 'static,
    D: DaemonConnectionControl,
{
    let Some(Extension(requester)) = requester else {
        tracing::error!("host connect-token rotate route reached without its human principal fact");
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
                "host connect-token rotate read failed"
            );
            return internal_error();
        }
    };

    let Some(owned) = find_owned_computer(&requester, record) else {
        return host_not_found();
    };

    // Rotation writes credentials, never the computer row, so the admitted record IS the
    // rotated computer — the wire is projected from it rather than re-read.
    let record = owned.record().clone();
    match state.rotation.execute(owned).await {
        Ok(rotated) => {
            // The commit already happened; a socket that would not close is operator
            // signal, not a product answer, so it is logged and the rotation still
            // reports success.
            if let Some(failure) = &rotated.daemon_disconnect_failure {
                tracing::error!(
                    error_chain = %error::describe(failure),
                    "host connect-token rotate daemon disconnect failed"
                );
            }
            Json(ConnectRotateResponse {
                host_id: record.id.as_str().to_owned(),
                host: host_wire(&record),
                status: "rotated",
                connect_token: rotated.token.reveal_once(),
                daemon_npm_spec: state.daemon_npm_spec.clone(),
            })
            .into_response()
        }
        Err(error) => rotation_error_response(error),
    }
}

/// Map a rotation failure to its wire answer. The two custody refusals and an in-lock
/// revoke are the only `409`s; every other cause is a fail-closed `500`, logged with its
/// chain and never its secret.
fn rotation_error_response(error: ConnectTokenRotationError) -> Response {
    match error {
        ConnectTokenRotationError::Refused(ConnectTokenRotationRefusal::CustodyEnded) => {
            conflict(HOST_REVOKED, HOST_REVOKED_CODE)
        }
        ConnectTokenRotationError::Refused(ConnectTokenRotationRefusal::NotUserManaged) => {
            conflict(NOT_USER_MANAGED, PROVISIONING_SOURCE_NOT_SUPPORTED_CODE)
        }
        ConnectTokenRotationError::CredentialRefused(CredentialIssueRefusal::HostRevoked) => {
            conflict(HOST_REVOKED, HOST_REVOKED_CODE)
        }
        other => {
            tracing::error!(
                error_chain = %error::describe(&other),
                "host connect-token rotate failed"
            );
            internal_error()
        }
    }
}

fn conflict(error: &'static str, error_code: &'static str) -> Response {
    (StatusCode::CONFLICT, Json(ErrorBody { error, error_code })).into_response()
}

/// Success body, pinned to the TypeScript handler: the rotated computer, the fresh token
/// the user must store, and the daemon package spec its connect-command card shows.
#[derive(Serialize)]
struct ConnectRotateResponse {
    host_id: String,
    host: HostDto,
    status: &'static str,
    connect_token: String,
    daemon_npm_spec: String,
}

#[cfg(test)]
mod tests {
    use std::{
        convert::Infallible,
        io,
        sync::{
            Arc, Mutex,
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
            custody::{CredentialSweep, NewLongLivedCredential},
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

    /// A user-managed computer owned by `owner` — the kind connect-token rotate acts on.
    fn user_managed(id: &str, owner: &str) -> ComputerRecord {
        ComputerRecord {
            id: host(id),
            name: format!("{id}-name"),
            kind: HostKind::Remote,
            created_at: 1,
            owner: Some(user(owner)),
            installation_id: None,
            last_seen_at: Some(9),
            activated_at: Some(2),
            finalized_at: Some(3),
            revoked_at: None,
            provisioning_source: ProvisioningSource::UserInvite,
            display_label: None,
        }
    }

    /// An app-managed local computer — the kind this door refuses.
    fn app_managed(id: &str, owner: &str) -> ComputerRecord {
        ComputerRecord {
            kind: HostKind::Local,
            provisioning_source: ProvisioningSource::AppInstall,
            installation_id: Some("i1".to_owned()),
            ..user_managed(id, owner)
        }
    }

    fn revoked(id: &str, owner: &str) -> ComputerRecord {
        ComputerRecord {
            revoked_at: Some(5),
            ..user_managed(id, owner)
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
            unreachable!("the connect-token rotate route never lists")
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
        Ok,
        Refused(CredentialIssueRefusal),
        Fails,
    }

    #[derive(Clone)]
    struct FakeCredentials {
        outcome: WriteOutcome,
        writes: Arc<AtomicUsize>,
    }

    impl CredentialIssueUnitOfWork for FakeCredentials {
        async fn issue_credential(
            &self,
            _credential: NewLongLivedCredential,
            _sweep: Option<CredentialSweep>,
        ) -> Result<Result<(), CredentialIssueRefusal>, PersistenceFailure> {
            self.writes.fetch_add(1, SeqCst);
            match &self.outcome {
                WriteOutcome::Ok => Ok(Ok(())),
                WriteOutcome::Refused(refusal) => Ok(Err(*refusal)),
                WriteOutcome::Fails => Err(PersistenceFailure::from_source(io::Error::other(
                    "write gone",
                ))),
            }
        }
    }

    #[derive(Clone, Default)]
    struct CountingEntropy {
        next: Arc<Mutex<u8>>,
    }

    impl EntropySource for CountingEntropy {
        type Error = Infallible;
        fn fill(&self, destination: &mut [u8]) -> Result<(), Self::Error> {
            let mut next = self.next.lock().expect("counter is not poisoned");
            for slot in destination.iter_mut() {
                *slot = *next;
                *next = next.wrapping_add(1);
            }
            Ok(())
        }
    }

    #[derive(Clone, Copy)]
    struct FixedClock;

    impl Clock for FixedClock {
        type Error = Infallible;
        fn unix_time_ms(&self) -> Result<i64, Self::Error> {
            Ok(1_700_000_000_123)
        }
    }

    /// Plays the connection control, recording each disconnect and optionally failing it.
    #[derive(Clone)]
    struct FakeDaemon {
        fails: bool,
        disconnects: Arc<AtomicUsize>,
    }

    impl DaemonConnectionControl for FakeDaemon {
        async fn disconnect(&self, _computer: HostId) -> Result<(), CustodyEffectFailure> {
            self.disconnects.fetch_add(1, SeqCst);
            if self.fails {
                Err(CustodyEffectFailure::from_source(io::Error::other(
                    "socket stuck",
                )))
            } else {
                Ok(())
            }
        }
    }

    struct Reply {
        status: StatusCode,
        body: String,
    }

    fn parsed(body: &str) -> Value {
        serde_json::from_str::<Value>(body).unwrap()
    }

    struct Harness {
        reads: Arc<AtomicUsize>,
        writes: Arc<AtomicUsize>,
        disconnects: Arc<AtomicUsize>,
    }

    async fn rotate(
        read: ReadOutcome,
        write: WriteOutcome,
        disconnect_fails: bool,
        daemon_npm_spec: Option<String>,
        path_id: &str,
        with_principal: bool,
    ) -> (Reply, Harness) {
        let reads = Arc::new(AtomicUsize::new(0));
        let writes = Arc::new(AtomicUsize::new(0));
        let disconnects = Arc::new(AtomicUsize::new(0));
        let read_model = FakeComputers {
            outcome: read,
            reads: reads.clone(),
        };
        let rotation = RotateConnectToken::new(
            FakeCredentials {
                outcome: write,
                writes: writes.clone(),
            },
            CountingEntropy::default(),
            FixedClock,
            FakeDaemon {
                fails: disconnect_fails,
                disconnects: disconnects.clone(),
            },
        );
        let mut request = Request::post(format!("/api/hosts/{path_id}/connect-token/rotate"));
        if with_principal {
            request = request.extension(user(REQUESTER));
        }
        let response = router(read_model, rotation, daemon_npm_spec)
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
                disconnects,
            },
        )
    }

    /// The common case: an owned user-managed computer, clean write, clean disconnect.
    async fn rotate_owned(read: ReadOutcome, write: WriteOutcome) -> (Reply, Harness) {
        rotate(read, write, false, None, "h1", true).await
    }

    #[tokio::test]
    async fn a_user_managed_computer_rotates_and_reveals_the_fresh_token() {
        let (reply, harness) = rotate_owned(
            ReadOutcome::Present(user_managed("h1", REQUESTER)),
            WriteOutcome::Ok,
        )
        .await;
        assert_eq!(reply.status, StatusCode::OK);
        let body = parsed(&reply.body);
        assert_eq!(body["host_id"], "h1");
        assert_eq!(body["host"]["id"], "h1");
        assert_eq!(body["host"]["kind"], "remote");
        assert_eq!(body["status"], "rotated");
        assert!(
            body["connect_token"]
                .as_str()
                .is_some_and(|t| !t.is_empty())
        );
        assert_eq!(body["daemon_npm_spec"], "@silverhand-ai/daemon@latest");
        assert_eq!(harness.writes.load(SeqCst), 1);
        assert_eq!(harness.disconnects.load(SeqCst), 1);
    }

    /// The daemon spec the connect-command card shows is the configured value, trimmed —
    /// the same resolution the create-invite response uses.
    #[tokio::test]
    async fn a_configured_daemon_spec_is_trimmed_into_the_body() {
        let (reply, _harness) = rotate(
            ReadOutcome::Present(user_managed("h1", REQUESTER)),
            WriteOutcome::Ok,
            false,
            Some("  file:/repo/packages/silverhand-daemon  ".into()),
            "h1",
            true,
        )
        .await;
        assert_eq!(reply.status, StatusCode::OK);
        assert_eq!(
            parsed(&reply.body)["daemon_npm_spec"],
            "file:/repo/packages/silverhand-daemon"
        );
    }

    /// An absent row and a foreign one render the SAME `404` and never reach the write.
    #[tokio::test]
    async fn an_absent_or_foreign_computer_is_one_byte_identical_404() {
        let refused = json!({ "error": "host not found", "error_code": "host_not_found" });
        for read in [
            ReadOutcome::Absent,
            ReadOutcome::Present(user_managed("h1", "u-someone-else")),
        ] {
            let (reply, harness) = rotate_owned(read, WriteOutcome::Ok).await;
            assert_eq!(reply.status, StatusCode::NOT_FOUND);
            assert_eq!(parsed(&reply.body), refused);
            assert_eq!(harness.writes.load(SeqCst), 0);
            assert_eq!(harness.disconnects.load(SeqCst), 0);
        }
    }

    /// A revoked computer is `409 host_revoked` before any credential is minted.
    #[tokio::test]
    async fn a_revoked_computer_is_a_409_before_any_write() {
        let (reply, harness) = rotate_owned(
            ReadOutcome::Present(revoked("h1", REQUESTER)),
            WriteOutcome::Ok,
        )
        .await;
        assert_eq!(reply.status, StatusCode::CONFLICT);
        assert_eq!(
            parsed(&reply.body),
            json!({ "error": "host has been revoked", "error_code": "host_revoked" })
        );
        assert_eq!(harness.writes.load(SeqCst), 0);
        assert_eq!(harness.disconnects.load(SeqCst), 0);
    }

    /// An app-managed computer has no connect token to rotate: `409` with the
    /// provisioning-source tag, and the write is never reached.
    #[tokio::test]
    async fn an_app_managed_computer_is_a_409_provisioning_source_not_supported() {
        let (reply, harness) = rotate_owned(
            ReadOutcome::Present(app_managed("h1", REQUESTER)),
            WriteOutcome::Ok,
        )
        .await;
        assert_eq!(reply.status, StatusCode::CONFLICT);
        assert_eq!(
            parsed(&reply.body),
            json!({
                "error": "connect-token rotation is only supported for user-managed computers",
                "error_code": "provisioning_source_not_supported"
            })
        );
        assert_eq!(harness.writes.load(SeqCst), 0);
        assert_eq!(harness.disconnects.load(SeqCst), 0);
    }

    /// A revoke landing under the write is the in-lock verdict's `409 host_revoked`.
    #[tokio::test]
    async fn a_revoke_under_the_write_is_the_in_lock_409() {
        let (reply, harness) = rotate_owned(
            ReadOutcome::Present(user_managed("h1", REQUESTER)),
            WriteOutcome::Refused(CredentialIssueRefusal::HostRevoked),
        )
        .await;
        assert_eq!(reply.status, StatusCode::CONFLICT);
        assert_eq!(parsed(&reply.body)["error_code"], "host_revoked");
        assert_eq!(harness.writes.load(SeqCst), 1);
        // The write refused, so nothing was committed to disconnect after.
        assert_eq!(harness.disconnects.load(SeqCst), 0);
    }

    /// A socket that will not close is logged and swallowed: the rotation already
    /// committed, so the answer is still `200` with the fresh token.
    #[tokio::test]
    async fn a_socket_that_will_not_close_still_reports_success() {
        let (reply, harness) = rotate(
            ReadOutcome::Present(user_managed("h1", REQUESTER)),
            WriteOutcome::Ok,
            true,
            None,
            "h1",
            true,
        )
        .await;
        assert_eq!(reply.status, StatusCode::OK);
        assert_eq!(parsed(&reply.body)["status"], "rotated");
        assert_eq!(harness.writes.load(SeqCst), 1);
        assert_eq!(harness.disconnects.load(SeqCst), 1);
    }

    /// A persistence failure in the write is the framework's plain `500`.
    #[tokio::test]
    async fn a_write_failure_is_a_fail_closed_500() {
        let (reply, harness) = rotate_owned(
            ReadOutcome::Present(user_managed("h1", REQUESTER)),
            WriteOutcome::Fails,
        )
        .await;
        assert_eq!(reply.status, StatusCode::INTERNAL_SERVER_ERROR);
        assert_eq!(reply.body, "Internal Server Error");
        assert_eq!(harness.disconnects.load(SeqCst), 0);
    }

    /// A failed read fails closed before the write.
    #[tokio::test]
    async fn a_failed_read_fails_closed_before_the_write() {
        let (reply, harness) = rotate_owned(ReadOutcome::Fails, WriteOutcome::Ok).await;
        assert_eq!(reply.status, StatusCode::INTERNAL_SERVER_ERROR);
        assert_eq!(reply.body, "Internal Server Error");
        assert_eq!(harness.writes.load(SeqCst), 0);
    }

    /// The principal is the perimeter's contribution; without it the route reads NOTHING
    /// and fails closed.
    #[tokio::test]
    async fn a_missing_principal_reads_nothing_and_fails_closed() {
        let (reply, harness) = rotate(
            ReadOutcome::Present(user_managed("h1", REQUESTER)),
            WriteOutcome::Ok,
            false,
            None,
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
