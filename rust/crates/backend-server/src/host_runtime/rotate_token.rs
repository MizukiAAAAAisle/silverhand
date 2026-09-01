//! Authenticated `POST /api/hosts/{id}/rotate-token`: an owner replaces the long-lived
//! token their local computer's daemon authenticates with.
//!
//! The route has two arms, chosen by deployment mode, because the difference is WHO
//! learns the new secret:
//!
//!  - EMBEDDED — the daemon shares this process, so the mint runs to completion and the
//!    plaintext is handed back in the HTTP body for the desktop shell to write into the
//!    daemon's config.
//!  - STANDALONE — the daemon is remote, so the secret is delivered over its own
//!    connection and the HTTP body carries none of it. A standalone server with no
//!    runtime attached answers `503 host_runtime_disabled`.
//!
//! Both arms share the same prelude, in TypeScript's order: resolve the named computer
//! for this requester (an absent row and a foreign one collapse to ONE `404`), then run
//! the custody/kind refusal BEFORE the arm split — so a revoked or non-local computer is
//! `409` even on a standalone server with no runtime, exactly as the TypeScript route
//! decides revoked/kind before it looks for a transport.
//!
//! [`admit_host_token_rotation`] is that shared refusal, and it runs only BEFORE the
//! write — here as the route's fast pre-branch, and again inside `RotateHostToken::prepare`
//! before the mint. Neither call is the in-lock authority. The one gate the write
//! re-decides under the lock is the CUSTODY half, re-read there through
//! `judge_credential_eligibility` — a different function with its own refusal type. The
//! KIND half is not rechecked in-lock; it stands on this pre-lock read because a
//! computer's `kind` never changes after it is created. The human principal's ABSENCE is
//! a composition fault, so it takes a fail-closed `500` having read nothing.
//!
//! Both routers are REQUIREMENT SEAMS: the mint authority and the daemon channel are
//! threaded through and left UNMOUNTED — the composition root binds the SQLite credential
//! store and the live websocket transport, and picks the arm from the deployment mode
//! (#task:2197).

use std::{error::Error as StdError, fmt, sync::Arc, time::Duration};

use axum::{
    Json, Router,
    extract::{Extension, Path, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::post,
};
use serde::Serialize;
use serde_json::{Value, json};
use silverhand_backend_core::{
    host_runtime::{
        custody::{CredentialIssueRefusal, CredentialIssueUnitOfWork},
        environment::{Clock, EntropySource},
        read::{ComputerReadModel, OwnedComputer, find_owned_computer},
        rotation::{
            DaemonRotationAck, DaemonRotationError, DaemonTokenRotationChannel,
            HostTokenRotationError, HostTokenRotationRefusal, RotateHostToken,
            RotateHostTokenThroughDaemon, RotatedTokenDelivery, admit_host_token_rotation,
        },
    },
    identity::{HostId, UserId},
};

use crate::{
    daemon_delivery::{
        DaemonDeliveryController, HostDataPlaneRequest, OwningHostDataPlane, command,
    },
    error,
};

use super::{
    ErrorBody, host_not_found,
    host_wire::{HostDto, host_wire},
    internal_error,
};

/// The product route template, in axum's `{id}` capture syntax.
pub const HOST_ROTATE_TOKEN_PATH: &str = "/api/hosts/{id}/rotate-token";

/// The custody refusal, pinned to the TypeScript handler
/// (`{ error: 'host has been revoked', error_code: 'host_revoked' }`).
const HOST_REVOKED: &str = "host has been revoked";
const HOST_REVOKED_CODE: &str = "host_revoked";

/// The kind refusal — the V1 surface rotates only the user's local host.
const KIND_NOT_SUPPORTED: &str = "rotate is only supported for local hosts";
const KIND_NOT_SUPPORTED_CODE: &str = "kind_not_supported";

/// The transport-failure body: shared by the 503 (nobody connected) and 502 (a daemon
/// was there, the round trip did not complete) readings, which the `error_code` tells
/// apart.
const TRANSPORT_FAILED: &str = "host token rotation transport failed";

/// The daemon-refused body: the daemon answered, and said no. Its own prose reason is
/// carried when it gave one.
const DAEMON_REJECTED: &str = "host token rotation rejected by daemon";
const HOST_TOKEN_ROTATION_FAILED_CODE: &str = "host_token_rotation_failed";

/// The standalone-without-runtime body, pinned to `hostRuntimeDisabledResponse` with
/// `action = 'host token rotation'`. Note the field is `code`, not `error_code`.
const RUNTIME_DISABLED: &str = "host token rotation requires a daemon-host runtime; standalone server mode is control-plane only until D2";
const HOST_RUNTIME_DISABLED_CODE: &str = "host_runtime_disabled";

/// The one transport code that is a real TypeScript token AND the 503/502 split key.
const TRANSPORT_NO_CONNECTION_CODE: &str = "transport_no_connection";

/// The 502 transport code. The daemon-delivery adapter collapses TypeScript's five
/// non-connection transport codes into one `Unreachable` (it cannot tell a timeout from
/// a broken socket from an unusable answer), so the route cannot reproduce the five and
/// renders the collapse honestly. No caller acts on which 502 code arrived — only the
/// 503/502 split does — so a single token is faithful. Falsifier: a caller that branches
/// on the specific 502 code forces the adapter to stop collapsing.
const TRANSPORT_UNREACHABLE_CODE: &str = "transport_unreachable";
const HOST_TOKEN_ROTATION_TIMEOUT: Duration = Duration::from_secs(10);

#[derive(Clone)]
pub struct DaemonTokenRotation {
    data_plane: OwningHostDataPlane,
}

impl DaemonTokenRotation {
    pub(crate) fn new(data_plane: OwningHostDataPlane) -> Self {
        Self { data_plane }
    }
}

impl DaemonTokenRotationChannel for DaemonTokenRotation {
    type Failure = DaemonRotationDeliveryError;

    async fn deliver_rotated_token(
        &self,
        delivery: RotatedTokenDelivery,
    ) -> Result<DaemonRotationAck, Self::Failure> {
        let custody = self
            .data_plane
            .resolve(delivery.computer())
            .map_err(|_| DaemonRotationDeliveryError::Unreachable)?
            .ok_or(DaemonRotationDeliveryError::NoConnection)?;
        let host_id = delivery.computer().as_str().to_owned();
        let issued_at = delivery.issued_at();
        let grace_until = delivery.grace_until();
        let params = rotation_params(&host_id, delivery.reveal_token(), issued_at, grace_until);
        let answer = self
            .data_plane
            .dispatch(HostDataPlaneRequest {
                custody: custody.clone(),
                command: command::rotate_token(params),
                timeout: HOST_TOKEN_ROTATION_TIMEOUT,
            })
            .await
            .map_err(|_| DaemonRotationDeliveryError::Unreachable)?;
        let result = answer
            .into_result_for(&custody)
            .map_err(|_| DaemonRotationDeliveryError::Unreachable)?;
        parse_rotation_ack(&result).ok_or(DaemonRotationDeliveryError::Unreachable)
    }
}

#[derive(Debug)]
pub enum DaemonRotationDeliveryError {
    NoConnection,
    Unreachable,
}

impl fmt::Display for DaemonRotationDeliveryError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::NoConnection => "no daemon is connected for this computer",
            Self::Unreachable => "the daemon could not be reached for a token rotation",
        })
    }
}

impl StdError for DaemonRotationDeliveryError {}

impl DaemonDeliveryController {
    pub fn host_token_rotation(&self) -> DaemonTokenRotation {
        DaemonTokenRotation::new(self.owning_host_data_plane())
    }
}

pub(crate) fn rotation_params(
    host_id: &str,
    host_token: String,
    issued_at: i64,
    grace_until: i64,
) -> Value {
    json!({
        "host_id": host_id,
        "host_token": host_token,
        "issued_at": issued_at,
        "grace_until": grace_until,
    })
}

pub(crate) fn parse_rotation_ack(result: &Value) -> Option<DaemonRotationAck> {
    let object = result.as_object()?;
    match object.get("rotated").and_then(Value::as_bool) {
        Some(true) => {
            let acknowledged = object.get("host_id").and_then(Value::as_str)?;
            let computer = HostId::parse(acknowledged).ok()?;
            let config_refreshed_at = object.get("config_refreshed_at").and_then(Value::as_i64)?;
            Some(DaemonRotationAck::Stored {
                computer,
                config_refreshed_at,
            })
        }
        _ => Some(DaemonRotationAck::Refused {
            reason: object
                .get("reason")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_owned(),
        }),
    }
}

/// The route's window into a rotation transport's failure: the two facts an HTTP answer
/// needs from it. The transport keeps its own closed failure set; this asks it only which
/// HTTP shape that failure takes, so the status split lives with the component that knows
/// a connection from a broken round trip.
pub trait DeliveryFault: StdError + Send + Sync + 'static {
    /// The machine code echoed on the transport-failure body.
    fn transport_code(&self) -> &'static str;

    /// Whether the failure is "nobody is connected" — the reading that answers `503`, not
    /// `502`.
    fn no_connection(&self) -> bool;
}

impl DeliveryFault for DaemonRotationDeliveryError {
    fn transport_code(&self) -> &'static str {
        match self {
            Self::NoConnection => TRANSPORT_NO_CONNECTION_CODE,
            Self::Unreachable => TRANSPORT_UNREACHABLE_CODE,
        }
    }

    fn no_connection(&self) -> bool {
        matches!(self, Self::NoConnection)
    }
}

/// Success from the embedded arm: the rotated computer and the fresh token bytes, for
/// the local shell to store.
#[derive(Serialize)]
struct EmbeddedRotateResponse {
    host_id: String,
    host: HostDto,
    host_token: String,
}

/// Success from the standalone arm: the rotated computer and nothing else. The secret
/// went to the daemon over its own connection, so there is no token here to leak.
#[derive(Serialize)]
struct StandaloneRotateResponse {
    host_id: String,
    host: HostDto,
    status: &'static str,
}

/// The daemon-refused body. `reason` is the daemon's own words when it gave any, and is
/// omitted for a host mismatch — an answer from the wrong daemon carries no reason a user
/// can act on.
#[derive(Serialize)]
struct DaemonRejectedBody {
    error: &'static str,
    error_code: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    reason: Option<String>,
}

/// The standalone-without-runtime body: the one host route whose refusal spells its
/// machine tag `code`, not `error_code`.
#[derive(Serialize)]
struct HostRuntimeDisabledBody {
    error: &'static str,
    code: &'static str,
}

/// The pre-work rejection from resolving and admitting the named computer: the boundary
/// renders each as the same `404`/`409`/`500` it produced inline before.
enum ResolveRejection {
    NotFound,
    Internal,
    Refused(HostTokenRotationRefusal),
}

/// Resolve the named computer for this requester and answer the custody/kind refusal,
/// all before either arm does its work — TypeScript's order.
///
/// Returns the owned computer, or the `404`/`409` the caller renders as-is. A malformed
/// id names no computer (the same `404` an absent row gets); a read failure fails closed.
async fn resolve_and_admit<M: ComputerReadModel>(
    read_model: &M,
    requester: &UserId,
    host_id: String,
) -> Result<OwnedComputer, ResolveRejection> {
    let Ok(computer) = HostId::parse(host_id) else {
        return Err(ResolveRejection::NotFound);
    };

    let record = match read_model.read_computer(computer).await {
        Ok(record) => record,
        Err(cause) => {
            tracing::error!(
                error_chain = %error::describe(&cause),
                "host rotate-token read failed"
            );
            return Err(ResolveRejection::Internal);
        }
    };

    let Some(owned) = find_owned_computer(requester, record) else {
        return Err(ResolveRejection::NotFound);
    };

    if let Err(refusal) = admit_host_token_rotation(owned.record()) {
        return Err(ResolveRejection::Refused(refusal));
    }

    Ok(owned)
}

/// Render the resolve/admit rejection as the wire answer the caller returns as-is.
fn resolve_rejection_response(rejection: ResolveRejection) -> Response {
    match rejection {
        ResolveRejection::NotFound => host_not_found(),
        ResolveRejection::Internal => internal_error(),
        ResolveRejection::Refused(refusal) => refusal_response(refusal),
    }
}

/// The custody/kind refusal as its `409`. Shared by the pre-branch check and the in-lock
/// verdict, so the two answer a revoked or non-local computer with the same body.
fn refusal_response(refusal: HostTokenRotationRefusal) -> Response {
    let (error, error_code) = match refusal {
        HostTokenRotationRefusal::CustodyEnded => (HOST_REVOKED, HOST_REVOKED_CODE),
        HostTokenRotationRefusal::NotALocalComputer => {
            (KIND_NOT_SUPPORTED, KIND_NOT_SUPPORTED_CODE)
        }
    };
    (StatusCode::CONFLICT, Json(ErrorBody { error, error_code })).into_response()
}

/// The custody-half error, shared by both arms. A revoke that lands under the write is
/// the in-lock verdict's `409`; everything else is a fail-closed `500`, logged with its
/// cause chain and never its secret.
fn custody_error_response(error: HostTokenRotationError) -> Response {
    match error {
        HostTokenRotationError::Refused(refusal) => refusal_response(refusal),
        HostTokenRotationError::CredentialRefused(CredentialIssueRefusal::HostRevoked) => {
            refusal_response(HostTokenRotationRefusal::CustodyEnded)
        }
        other => {
            tracing::error!(
                error_chain = %error::describe(&other),
                "host rotate-token failed"
            );
            internal_error()
        }
    }
}

/// The daemon-half error. A refusal or a mismatch is the daemon's `502`; a transport
/// failure is a `503`/`502` on the connection split; the custody half defers to the
/// shared mapper.
fn daemon_error_response<F: DeliveryFault>(error: DaemonRotationError<F>) -> Response {
    match error {
        DaemonRotationError::Custody(custody) => custody_error_response(custody),
        DaemonRotationError::Transport(fault) => {
            let status = if fault.no_connection() {
                StatusCode::SERVICE_UNAVAILABLE
            } else {
                StatusCode::BAD_GATEWAY
            };
            (
                status,
                Json(ErrorBody {
                    error: TRANSPORT_FAILED,
                    error_code: fault.transport_code(),
                }),
            )
                .into_response()
        }
        DaemonRotationError::DaemonRefused { reason } => daemon_rejected(Some(reason)),
        DaemonRotationError::DaemonHostMismatch { .. } => daemon_rejected(None),
    }
}

fn daemon_rejected(reason: Option<String>) -> Response {
    (
        StatusCode::BAD_GATEWAY,
        Json(DaemonRejectedBody {
            error: DAEMON_REJECTED,
            error_code: HOST_TOKEN_ROTATION_FAILED_CODE,
            reason,
        }),
    )
        .into_response()
}

struct EmbeddedState<M, W, R, C> {
    read_model: M,
    rotation: Arc<RotateHostToken<W, R, C>>,
}

impl<M, W, R, C> Clone for EmbeddedState<M, W, R, C>
where
    M: Clone,
{
    fn clone(&self) -> Self {
        Self {
            read_model: self.read_model.clone(),
            rotation: Arc::clone(&self.rotation),
        }
    }
}

/// The embedded router: the daemon is in-process, so the token is minted to completion
/// and revealed in the response.
pub fn embedded_router<M, W, R, C>(read_model: M, rotation: RotateHostToken<W, R, C>) -> Router
where
    M: ComputerReadModel,
    W: CredentialIssueUnitOfWork,
    R: EntropySource + 'static,
    C: Clock + 'static,
{
    Router::new()
        .route(HOST_ROTATE_TOKEN_PATH, post(embedded_rotate::<M, W, R, C>))
        .with_state(EmbeddedState {
            read_model,
            rotation: Arc::new(rotation),
        })
}

async fn embedded_rotate<M, W, R, C>(
    Path(host_id): Path<String>,
    requester: Option<Extension<UserId>>,
    State(state): State<EmbeddedState<M, W, R, C>>,
) -> Response
where
    M: ComputerReadModel,
    W: CredentialIssueUnitOfWork,
    R: EntropySource + 'static,
    C: Clock + 'static,
{
    let Some(Extension(requester)) = requester else {
        tracing::error!("host rotate-token route reached without its human principal fact");
        return internal_error();
    };

    let owned = match resolve_and_admit(&state.read_model, &requester, host_id).await {
        Ok(owned) => owned,
        Err(rejection) => return resolve_rejection_response(rejection),
    };

    // Rotation writes credentials, never the computer row, so the admitted record IS the
    // rotated computer — the wire is projected from it rather than re-read.
    let record = owned.record().clone();
    match state.rotation.in_process(owned).await {
        Ok(rotated) => Json(EmbeddedRotateResponse {
            host_id: record.id.as_str().to_owned(),
            host: host_wire(&record),
            host_token: rotated.token.reveal_once(),
        })
        .into_response(),
        Err(error) => custody_error_response(error),
    }
}

struct StandaloneState<M, W, R, C, D> {
    read_model: M,
    coordinator: Option<Arc<RotateHostTokenThroughDaemon<W, R, C, D>>>,
}

impl<M, W, R, C, D> Clone for StandaloneState<M, W, R, C, D>
where
    M: Clone,
{
    fn clone(&self) -> Self {
        Self {
            read_model: self.read_model.clone(),
            coordinator: self.coordinator.clone(),
        }
    }
}

/// The standalone router: the daemon is remote. `None` is a control-plane-only server
/// with no runtime attached, which answers `503 host_runtime_disabled` after the
/// pre-branch refusal — never before it.
pub fn standalone_router<M, W, R, C, D>(
    read_model: M,
    coordinator: Option<RotateHostTokenThroughDaemon<W, R, C, D>>,
) -> Router
where
    M: ComputerReadModel,
    W: CredentialIssueUnitOfWork,
    R: EntropySource + 'static,
    C: Clock + 'static,
    D: DaemonTokenRotationChannel,
    D::Failure: DeliveryFault,
{
    Router::new()
        .route(
            HOST_ROTATE_TOKEN_PATH,
            post(standalone_rotate::<M, W, R, C, D>),
        )
        .with_state(StandaloneState {
            read_model,
            coordinator: coordinator.map(Arc::new),
        })
}

async fn standalone_rotate<M, W, R, C, D>(
    Path(host_id): Path<String>,
    requester: Option<Extension<UserId>>,
    State(state): State<StandaloneState<M, W, R, C, D>>,
) -> Response
where
    M: ComputerReadModel,
    W: CredentialIssueUnitOfWork,
    R: EntropySource + 'static,
    C: Clock + 'static,
    D: DaemonTokenRotationChannel,
    D::Failure: DeliveryFault,
{
    let Some(Extension(requester)) = requester else {
        tracing::error!("host rotate-token route reached without its human principal fact");
        return internal_error();
    };

    let owned = match resolve_and_admit(&state.read_model, &requester, host_id).await {
        Ok(owned) => owned,
        Err(rejection) => return resolve_rejection_response(rejection),
    };

    let Some(coordinator) = &state.coordinator else {
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(HostRuntimeDisabledBody {
                error: RUNTIME_DISABLED,
                code: HOST_RUNTIME_DISABLED_CODE,
            }),
        )
            .into_response();
    };

    // The row is untouched by rotation, so the admitted record is the rotated computer.
    let record = owned.record().clone();
    match coordinator.execute(owned).await {
        Ok(_receipt) => Json(StandaloneRotateResponse {
            host_id: record.id.as_str().to_owned(),
            host: host_wire(&record),
            status: "rotated",
        })
        .into_response(),
        Err(error) => daemon_error_response(error),
    }
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
        host_runtime::{
            computer::{ComputerRecord, HostKind, ProvisioningSource},
            custody::{CredentialSweep, NewLongLivedCredential},
            rotation::{DaemonRotationAck, RotatedTokenDelivery},
        },
        persistence::PersistenceFailure,
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

    /// An app-managed local computer owned by `owner` — the kind rotate acts on.
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

    fn remote(id: &str, owner: &str) -> ComputerRecord {
        ComputerRecord {
            kind: HostKind::Remote,
            provisioning_source: ProvisioningSource::UserInvite,
            ..app_managed(id, owner)
        }
    }

    fn revoked(id: &str, owner: &str) -> ComputerRecord {
        ComputerRecord {
            revoked_at: Some(5),
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
            unreachable!("the rotate route never lists")
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

    /// Plays the credential write face, recording whether the write was reached.
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

    #[derive(Clone)]
    enum DaemonOutcome {
        Stored,
        StoredWrongHost,
        Refused(String),
        NoConnection,
        Unreachable,
    }

    /// Plays the daemon channel: the ack it answers, or the transport failure it raises.
    /// Its `Failure` is the production [`DaemonRotationDeliveryError`], so the route's
    /// real [`DeliveryFault`] mapping is exercised, not a stand-in.
    #[derive(Clone)]
    struct FakeDaemon {
        outcome: DaemonOutcome,
        deliveries: Arc<AtomicUsize>,
    }

    impl DaemonTokenRotationChannel for FakeDaemon {
        type Failure = DaemonRotationDeliveryError;

        async fn deliver_rotated_token(
            &self,
            delivery: RotatedTokenDelivery,
        ) -> Result<DaemonRotationAck, Self::Failure> {
            self.deliveries.fetch_add(1, SeqCst);
            let computer = delivery.computer().clone();
            match &self.outcome {
                DaemonOutcome::Stored => Ok(DaemonRotationAck::Stored {
                    computer,
                    config_refreshed_at: 42,
                }),
                DaemonOutcome::StoredWrongHost => Ok(DaemonRotationAck::Stored {
                    computer: host("h-other"),
                    config_refreshed_at: 42,
                }),
                DaemonOutcome::Refused(reason) => Ok(DaemonRotationAck::Refused {
                    reason: reason.clone(),
                }),
                DaemonOutcome::NoConnection => Err(DaemonRotationDeliveryError::NoConnection),
                DaemonOutcome::Unreachable => Err(DaemonRotationDeliveryError::Unreachable),
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

    fn rotation(
        write: WriteOutcome,
        writes: Arc<AtomicUsize>,
    ) -> RotateHostToken<FakeCredentials, CountingEntropy, FixedClock> {
        RotateHostToken::new(
            FakeCredentials {
                outcome: write,
                writes,
            },
            CountingEntropy::default(),
            FixedClock,
        )
    }

    async fn run(router: Router, path_id: &str, with_principal: bool) -> Reply {
        let mut request = Request::post(format!("/api/hosts/{path_id}/rotate-token"));
        if with_principal {
            request = request.extension(user(REQUESTER));
        }
        let response = router
            .oneshot(request.body(Body::empty()).unwrap())
            .await
            .unwrap();
        let status = response.status();
        let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        Reply {
            status,
            body: String::from_utf8(body.to_vec()).unwrap(),
        }
    }

    fn embedded(
        read: ReadOutcome,
        write: WriteOutcome,
    ) -> (Router, Arc<AtomicUsize>, Arc<AtomicUsize>) {
        let reads = Arc::new(AtomicUsize::new(0));
        let writes = Arc::new(AtomicUsize::new(0));
        let router = embedded_router(
            FakeComputers {
                outcome: read,
                reads: reads.clone(),
            },
            rotation(write, writes.clone()),
        );
        (router, reads, writes)
    }

    fn standalone(
        read: ReadOutcome,
        write: WriteOutcome,
        daemon: Option<DaemonOutcome>,
    ) -> (Router, Arc<AtomicUsize>, Arc<AtomicUsize>, Arc<AtomicUsize>) {
        let reads = Arc::new(AtomicUsize::new(0));
        let writes = Arc::new(AtomicUsize::new(0));
        let deliveries = Arc::new(AtomicUsize::new(0));
        let coordinator = daemon.map(|outcome| {
            RotateHostTokenThroughDaemon::new(
                rotation(write, writes.clone()),
                FakeDaemon {
                    outcome,
                    deliveries: deliveries.clone(),
                },
            )
        });
        let router = standalone_router(
            FakeComputers {
                outcome: read,
                reads: reads.clone(),
            },
            coordinator,
        );
        (router, reads, writes, deliveries)
    }

    #[tokio::test]
    async fn the_embedded_arm_reveals_the_fresh_token() {
        let (router, _reads, writes) = embedded(
            ReadOutcome::Present(app_managed("h1", REQUESTER)),
            WriteOutcome::Ok,
        );
        let reply = run(router, "h1", true).await;
        assert_eq!(reply.status, StatusCode::OK);
        let body = parsed(&reply.body);
        assert_eq!(body["host_id"], "h1");
        assert_eq!(body["host"]["id"], "h1");
        assert_eq!(body["host"]["kind"], "local");
        assert!(body["host_token"].as_str().is_some_and(|t| !t.is_empty()));
        assert_eq!(writes.load(SeqCst), 1);
    }

    #[tokio::test]
    async fn the_standalone_arm_rotates_without_returning_a_token() {
        let (router, _reads, writes, deliveries) = standalone(
            ReadOutcome::Present(app_managed("h1", REQUESTER)),
            WriteOutcome::Ok,
            Some(DaemonOutcome::Stored),
        );
        let reply = run(router, "h1", true).await;
        assert_eq!(reply.status, StatusCode::OK);
        let body = parsed(&reply.body);
        assert_eq!(body["host_id"], "h1");
        assert_eq!(body["status"], "rotated");
        assert!(body.get("host_token").is_none());
        assert_eq!(deliveries.load(SeqCst), 1);
        assert_eq!(writes.load(SeqCst), 1);
    }

    #[tokio::test]
    async fn an_absent_or_foreign_computer_is_one_byte_identical_404() {
        let refused = json!({ "error": "host not found", "error_code": "host_not_found" });
        for read in [
            ReadOutcome::Absent,
            ReadOutcome::Present(app_managed("h1", "u-someone-else")),
        ] {
            let (router, _reads, writes) = embedded(read, WriteOutcome::Ok);
            let reply = run(router, "h1", true).await;
            assert_eq!(reply.status, StatusCode::NOT_FOUND);
            assert_eq!(parsed(&reply.body), refused);
            assert_eq!(writes.load(SeqCst), 0);
        }
    }

    #[tokio::test]
    async fn a_revoked_computer_is_a_409_before_any_write() {
        let (router, _reads, writes) = embedded(
            ReadOutcome::Present(revoked("h1", REQUESTER)),
            WriteOutcome::Ok,
        );
        let reply = run(router, "h1", true).await;
        assert_eq!(reply.status, StatusCode::CONFLICT);
        assert_eq!(
            parsed(&reply.body),
            json!({ "error": "host has been revoked", "error_code": "host_revoked" })
        );
        assert_eq!(writes.load(SeqCst), 0);
    }

    #[tokio::test]
    async fn a_non_local_computer_is_a_409_kind_not_supported() {
        let (router, _reads, writes) = embedded(
            ReadOutcome::Present(remote("h1", REQUESTER)),
            WriteOutcome::Ok,
        );
        let reply = run(router, "h1", true).await;
        assert_eq!(reply.status, StatusCode::CONFLICT);
        assert_eq!(
            parsed(&reply.body),
            json!({
                "error": "rotate is only supported for local hosts",
                "error_code": "kind_not_supported"
            })
        );
        assert_eq!(writes.load(SeqCst), 0);
    }

    /// A standalone computer that is revoked is `409` even with no runtime attached —
    /// the pre-branch refusal runs before the transport-absent check.
    #[tokio::test]
    async fn a_revoked_computer_on_a_runtimeless_standalone_is_409_not_503() {
        let (router, _reads, writes, _deliveries) = standalone(
            ReadOutcome::Present(revoked("h1", REQUESTER)),
            WriteOutcome::Ok,
            None,
        );
        let reply = run(router, "h1", true).await;
        assert_eq!(reply.status, StatusCode::CONFLICT);
        assert_eq!(parsed(&reply.body)["error_code"], "host_revoked");
        assert_eq!(writes.load(SeqCst), 0);
    }

    #[tokio::test]
    async fn a_standalone_without_a_runtime_is_503_host_runtime_disabled() {
        let (router, _reads, _writes, _deliveries) = standalone(
            ReadOutcome::Present(app_managed("h1", REQUESTER)),
            WriteOutcome::Ok,
            None,
        );
        let reply = run(router, "h1", true).await;
        assert_eq!(reply.status, StatusCode::SERVICE_UNAVAILABLE);
        assert_eq!(
            parsed(&reply.body),
            json!({
                "error": "host token rotation requires a daemon-host runtime; standalone server mode is control-plane only until D2",
                "code": "host_runtime_disabled"
            })
        );
    }

    #[tokio::test]
    async fn no_connected_daemon_is_503_transport_no_connection() {
        let (router, _reads, writes, _deliveries) = standalone(
            ReadOutcome::Present(app_managed("h1", REQUESTER)),
            WriteOutcome::Ok,
            Some(DaemonOutcome::NoConnection),
        );
        let reply = run(router, "h1", true).await;
        assert_eq!(reply.status, StatusCode::SERVICE_UNAVAILABLE);
        assert_eq!(
            parsed(&reply.body),
            json!({
                "error": "host token rotation transport failed",
                "error_code": "transport_no_connection"
            })
        );
        // The daemon never acknowledged, so nothing was written.
        assert_eq!(writes.load(SeqCst), 0);
    }

    #[tokio::test]
    async fn an_unreachable_daemon_is_502_transport_failed() {
        let (router, _reads, writes, _deliveries) = standalone(
            ReadOutcome::Present(app_managed("h1", REQUESTER)),
            WriteOutcome::Ok,
            Some(DaemonOutcome::Unreachable),
        );
        let reply = run(router, "h1", true).await;
        assert_eq!(reply.status, StatusCode::BAD_GATEWAY);
        assert_eq!(
            parsed(&reply.body),
            json!({
                "error": "host token rotation transport failed",
                "error_code": "transport_unreachable"
            })
        );
        assert_eq!(writes.load(SeqCst), 0);
    }

    #[tokio::test]
    async fn a_daemon_that_refuses_is_502_with_its_reason() {
        let (router, _reads, writes, _deliveries) = standalone(
            ReadOutcome::Present(app_managed("h1", REQUESTER)),
            WriteOutcome::Ok,
            Some(DaemonOutcome::Refused("config_locked".to_owned())),
        );
        let reply = run(router, "h1", true).await;
        assert_eq!(reply.status, StatusCode::BAD_GATEWAY);
        assert_eq!(
            parsed(&reply.body),
            json!({
                "error": "host token rotation rejected by daemon",
                "error_code": "host_token_rotation_failed",
                "reason": "config_locked"
            })
        );
        // A refusal is not a rotation: the write is never reached.
        assert_eq!(writes.load(SeqCst), 0);
    }

    #[tokio::test]
    async fn an_ack_from_the_wrong_daemon_is_502_with_no_reason() {
        let (router, _reads, writes, _deliveries) = standalone(
            ReadOutcome::Present(app_managed("h1", REQUESTER)),
            WriteOutcome::Ok,
            Some(DaemonOutcome::StoredWrongHost),
        );
        let reply = run(router, "h1", true).await;
        assert_eq!(reply.status, StatusCode::BAD_GATEWAY);
        assert_eq!(
            parsed(&reply.body),
            json!({
                "error": "host token rotation rejected by daemon",
                "error_code": "host_token_rotation_failed"
            })
        );
        assert_eq!(writes.load(SeqCst), 0);
    }

    /// A revoke landing under the write is the in-lock verdict's `409`, in both arms.
    #[tokio::test]
    async fn a_revoke_under_the_write_is_the_in_lock_409() {
        let (router, _reads, writes) = embedded(
            ReadOutcome::Present(app_managed("h1", REQUESTER)),
            WriteOutcome::Refused(CredentialIssueRefusal::HostRevoked),
        );
        let reply = run(router, "h1", true).await;
        assert_eq!(reply.status, StatusCode::CONFLICT);
        assert_eq!(parsed(&reply.body)["error_code"], "host_revoked");
        assert_eq!(writes.load(SeqCst), 1);
    }

    #[tokio::test]
    async fn a_write_failure_is_a_fail_closed_500() {
        let (router, _reads, _writes) = embedded(
            ReadOutcome::Present(app_managed("h1", REQUESTER)),
            WriteOutcome::Fails,
        );
        let reply = run(router, "h1", true).await;
        assert_eq!(reply.status, StatusCode::INTERNAL_SERVER_ERROR);
        assert_eq!(reply.body, "Internal Server Error");
    }

    #[tokio::test]
    async fn a_failed_read_fails_closed_before_the_write() {
        let (router, _reads, writes) = embedded(ReadOutcome::Fails, WriteOutcome::Ok);
        let reply = run(router, "h1", true).await;
        assert_eq!(reply.status, StatusCode::INTERNAL_SERVER_ERROR);
        assert_eq!(reply.body, "Internal Server Error");
        assert_eq!(writes.load(SeqCst), 0);
    }

    #[tokio::test]
    async fn a_missing_principal_reads_nothing_and_fails_closed() {
        let (router, reads, writes) = embedded(
            ReadOutcome::Present(app_managed("h1", REQUESTER)),
            WriteOutcome::Ok,
        );
        let reply = run(router, "h1", false).await;
        assert_eq!(reply.status, StatusCode::INTERNAL_SERVER_ERROR);
        assert_eq!(reply.body, "Internal Server Error");
        assert_eq!(reads.load(SeqCst), 0);
        assert_eq!(writes.load(SeqCst), 0);
    }
}
