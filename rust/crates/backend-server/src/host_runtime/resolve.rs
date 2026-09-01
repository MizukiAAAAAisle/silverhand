//! The bootstrap door's second half: `GET /api/hosts/connect-token/resolve`.
//!
//! A copied connection command carries no computer id. The daemon proves possession
//! of its connect token as the `Authorization: Bearer` credential, and learns the
//! server-side computer id it is namespacing under — nothing more.
//!
//! There is NO human session here, so the fail-closed-on-missing-principal rule the
//! other host routes follow does not apply: an absent or unusable credential is an
//! ordinary `401`, the daemon's to fix, not a composition fault.
//!
//! Three authorities, in order:
//!
//!  1. PRESENT — extract the bearer credential. Absent or wrong-scheme is `401`
//!     `unauthorized`, decided before any read.
//!  2. VERIFY — [`verify_host_token`] judges the presented token against the persisted
//!     verifier. EVERY rejection reason collapses to one `401`: a holder must learn
//!     only that its token was refused, never why, or a stolen token could map the
//!     fleet it came from.
//!  3. RESOLVE — [`admit_connect_token_resolution`] re-judges custody and binding on a
//!     LATER read of the computer, so a row revoked between the credential's join and
//!     now refuses rather than resolves. Every unresolvable reason is one `403`
//!     `forbidden`.

use axum::{
    Json, Router,
    extract::State,
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::get,
};
use serde::Serialize;
use silverhand_backend_core::{
    foundation::identity::HostId,
    host_runtime::{
        custody::{
            HostCredentialLookup, VerifyHostTokenFact, admit_connect_token_resolution,
            verify_host_token,
        },
        read::ComputerReadModel,
    },
};

use crate::{bearer::strict_bearer_credential, clock::ProcessClock, error};

use super::{ErrorBody, internal_error};

/// The product route template. A fixed path, not a `{id}` capture: the whole point is
/// that the caller does not yet know its computer id.
pub const HOST_CONNECT_TOKEN_RESOLVE_PATH: &str = "/api/hosts/connect-token/resolve";

/// The two refusals this route speaks, message and code identical, pinned to the
/// TypeScript handler.
const UNAUTHORIZED: &str = "unauthorized";
const FORBIDDEN: &str = "forbidden";

#[derive(Clone)]
struct ResolveState<L, R, C> {
    credentials: L,
    computers: R,
    clock: C,
}

pub fn router<L, R, C>(credentials: L, computers: R, clock: C) -> Router
where
    L: HostCredentialLookup,
    R: ComputerReadModel,
    C: ProcessClock,
{
    Router::new()
        .route(HOST_CONNECT_TOKEN_RESOLVE_PATH, get(resolve::<L, R, C>))
        .with_state(ResolveState {
            credentials,
            computers,
            clock,
        })
}

async fn resolve<L, R, C>(
    State(state): State<ResolveState<L, R, C>>,
    headers: HeaderMap,
) -> Response
where
    L: HostCredentialLookup,
    R: ComputerReadModel,
    C: ProcessClock,
{
    let Some(token) = strict_bearer_credential(&headers) else {
        return unauthorized();
    };

    let verdict = match verify_host_token(
        &state.credentials,
        token.to_owned(),
        state.clock.now_unix_millis(),
    )
    .await
    {
        Ok(verdict) => verdict,
        Err(cause) => {
            tracing::error!(
                error_chain = %error::describe(&cause),
                "connect-token verification read failed"
            );
            return internal_error();
        }
    };

    let VerifyHostTokenFact::Accepted { host_id, .. } = verdict else {
        return unauthorized();
    };

    // A credential whose stored host_id is not a coordinate names no computer — the
    // same refusal an unresolvable one gets, so a stolen token cannot tell an odd
    // stored id from a computer it may not ask about.
    let Ok(computer) = HostId::parse(host_id) else {
        return forbidden();
    };

    let record = match state.computers.read_computer(computer.clone()).await {
        Ok(record) => record,
        Err(cause) => {
            tracing::error!(
                error_chain = %error::describe(&cause),
                "connect-token computer read failed"
            );
            return internal_error();
        }
    };

    match admit_connect_token_resolution(record.as_ref()) {
        Ok(()) => Json(ResolveResponse {
            host_id: computer.into_inner(),
        })
        .into_response(),
        Err(_) => forbidden(),
    }
}

/// Success body: `{ "host_id": "<id>" }` — the one fact a proven daemon may learn.
#[derive(Serialize)]
struct ResolveResponse {
    host_id: String,
}

fn unauthorized() -> Response {
    (
        StatusCode::UNAUTHORIZED,
        Json(ErrorBody {
            error: UNAUTHORIZED,
            error_code: UNAUTHORIZED,
        }),
    )
        .into_response()
}

fn forbidden() -> Response {
    (
        StatusCode::FORBIDDEN,
        Json(ErrorBody {
            error: FORBIDDEN,
            error_code: FORBIDDEN,
        }),
    )
        .into_response()
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
        foundation::identity::UserId,
        foundation::persistence::PersistenceFailure,
        host_runtime::{
            computer::{ComputerRecord, HostKind, ProvisioningSource},
            custody::{CredentialAuthState, CredentialKind},
        },
    };
    use tower::ServiceExt;

    use super::*;

    const NOW: i64 = 1_700_000_000_000;

    fn user(id: &str) -> UserId {
        UserId::parse(id).expect("user id")
    }

    fn host(id: &str) -> HostId {
        HostId::parse(id).expect("host id")
    }

    /// A credential state `verify_host_token` accepts, naming computer `host` bound to
    /// `owner`.
    fn accepted(host: &str, owner: &str) -> CredentialAuthState {
        CredentialAuthState {
            credential_id: "c1".to_owned(),
            host_id: host.to_owned(),
            host_user_id: Some(user(owner)),
            kind: CredentialKind::LongLived,
            expires_at: None,
            consumed_at: None,
            credential_revoked_at: None,
            host_revoked_at: None,
        }
    }

    /// A live, user-managed computer — the one shape `admit_connect_token_resolution`
    /// resolves.
    fn live_user_managed(id: &str, owner: &str) -> ComputerRecord {
        ComputerRecord {
            id: host(id),
            name: format!("{id}-name"),
            kind: HostKind::Remote,
            created_at: 1,
            owner: Some(user(owner)),
            installation_id: None,
            last_seen_at: None,
            activated_at: Some(11),
            finalized_at: Some(12),
            revoked_at: None,
            provisioning_source: ProvisioningSource::UserInvite,
            display_label: None,
        }
    }

    #[derive(Clone)]
    enum CredOutcome {
        Found(CredentialAuthState),
        Absent,
        Fails,
    }

    #[derive(Clone)]
    struct FakeCredentials {
        outcome: CredOutcome,
        lookups: Arc<AtomicUsize>,
    }

    impl HostCredentialLookup for FakeCredentials {
        async fn lookup_by_token_hash(
            &self,
            _token_hash: String,
        ) -> Result<Option<CredentialAuthState>, PersistenceFailure> {
            self.lookups.fetch_add(1, SeqCst);
            match &self.outcome {
                CredOutcome::Found(state) => Ok(Some(state.clone())),
                CredOutcome::Absent => Ok(None),
                CredOutcome::Fails => Err(PersistenceFailure::from_source(io::Error::other(
                    "credentials gone",
                ))),
            }
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
            unreachable!("connect-token resolution never lists")
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

    #[derive(Clone, Copy)]
    struct FixedClock;

    impl ProcessClock for FixedClock {
        fn now_unix_millis(&self) -> i64 {
            NOW
        }
    }

    struct Reply {
        status: StatusCode,
        body: String,
        lookups: usize,
        reads: usize,
    }

    async fn resolve_with(
        cred: CredOutcome,
        read: ReadOutcome,
        authorization: Option<&str>,
    ) -> Reply {
        let lookups = Arc::new(AtomicUsize::new(0));
        let reads = Arc::new(AtomicUsize::new(0));
        let credentials = FakeCredentials {
            outcome: cred,
            lookups: lookups.clone(),
        };
        let computers = FakeComputers {
            outcome: read,
            reads: reads.clone(),
        };
        let mut request = Request::get(HOST_CONNECT_TOKEN_RESOLVE_PATH);
        if let Some(value) = authorization {
            request = request.header("authorization", value);
        }
        let response = router(credentials, computers, FixedClock)
            .oneshot(request.body(Body::empty()).unwrap())
            .await
            .unwrap();
        let status = response.status();
        let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        Reply {
            status,
            body: String::from_utf8(body.to_vec()).unwrap(),
            lookups: lookups.load(SeqCst),
            reads: reads.load(SeqCst),
        }
    }

    fn parsed(body: &str) -> Value {
        serde_json::from_str::<Value>(body).unwrap()
    }

    /// A proven daemon on a live user-managed computer learns its own id, and nothing
    /// else.
    #[tokio::test]
    async fn a_proven_token_resolves_the_live_user_managed_computers_id() {
        let reply = resolve_with(
            CredOutcome::Found(accepted("h1", "u1")),
            ReadOutcome::Present(live_user_managed("h1", "u1")),
            Some("Bearer good-token"),
        )
        .await;
        assert_eq!(reply.status, StatusCode::OK);
        assert_eq!(parsed(&reply.body), json!({ "host_id": "h1" }));
        assert_eq!(reply.lookups, 1);
        assert_eq!(reply.reads, 1);
    }

    /// The bearer grammar is case-insensitive and tolerates padding, exactly as the
    /// TypeScript `/^Bearer\s+(.+)$/i` did.
    #[tokio::test]
    async fn a_case_insensitive_padded_bearer_still_resolves() {
        let reply = resolve_with(
            CredOutcome::Found(accepted("h1", "u1")),
            ReadOutcome::Present(live_user_managed("h1", "u1")),
            Some("bEaReR\t  good-token  "),
        )
        .await;
        assert_eq!(reply.status, StatusCode::OK);
        assert_eq!(parsed(&reply.body), json!({ "host_id": "h1" }));
    }

    /// No credential at all is `401` before any read — there is nothing to verify.
    #[tokio::test]
    async fn an_absent_authorization_header_is_unauthorized_before_any_read() {
        let reply = resolve_with(
            CredOutcome::Found(accepted("h1", "u1")),
            ReadOutcome::Present(live_user_managed("h1", "u1")),
            None,
        )
        .await;
        assert_eq!(reply.status, StatusCode::UNAUTHORIZED);
        assert_eq!(
            parsed(&reply.body),
            json!({ "error": "unauthorized", "error_code": "unauthorized" })
        );
        assert_eq!(reply.lookups, 0);
        assert_eq!(reply.reads, 0);
    }

    /// A non-bearer scheme presents no credential this route accepts, so it is the same
    /// `401` before any read.
    #[tokio::test]
    async fn a_non_bearer_scheme_is_unauthorized_before_any_read() {
        let reply = resolve_with(
            CredOutcome::Found(accepted("h1", "u1")),
            ReadOutcome::Present(live_user_managed("h1", "u1")),
            Some("Basic good-token"),
        )
        .await;
        assert_eq!(reply.status, StatusCode::UNAUTHORIZED);
        assert_eq!(reply.lookups, 0);
        assert_eq!(reply.reads, 0);
    }

    /// A token no verifier matches is `401`, and never reaches the computer read.
    #[tokio::test]
    async fn an_unknown_token_is_unauthorized() {
        let reply = resolve_with(
            CredOutcome::Absent,
            ReadOutcome::Present(live_user_managed("h1", "u1")),
            Some("Bearer nope"),
        )
        .await;
        assert_eq!(reply.status, StatusCode::UNAUTHORIZED);
        assert_eq!(reply.lookups, 1);
        assert_eq!(reply.reads, 0);
    }

    /// A token the verifier rejects for cause — here a revoked host — is the SAME `401`
    /// as an unknown one, never a `403`: the holder learns only that it was refused.
    #[tokio::test]
    async fn a_rejected_credential_is_unauthorized_not_forbidden() {
        let mut revoked_host = accepted("h1", "u1");
        revoked_host.host_revoked_at = Some(5);
        let reply = resolve_with(
            CredOutcome::Found(revoked_host),
            ReadOutcome::Present(live_user_managed("h1", "u1")),
            Some("Bearer good-token"),
        )
        .await;
        assert_eq!(reply.status, StatusCode::UNAUTHORIZED);
        assert_eq!(reply.lookups, 1);
        assert_eq!(reply.reads, 0);
    }

    /// A verified token whose computer is no longer resolvable — gone, revoked since,
    /// or never user-managed — is ONE `403`, so a later read can refuse what the
    /// credential's own join once admitted.
    #[tokio::test]
    async fn an_accepted_token_for_an_unresolvable_computer_is_one_forbidden() {
        let refused = json!({ "error": "forbidden", "error_code": "forbidden" });

        let mut revoked = live_user_managed("h1", "u1");
        revoked.revoked_at = Some(5);
        let mut app_install = live_user_managed("h1", "u1");
        app_install.provisioning_source = ProvisioningSource::AppInstall;

        for read in [
            ReadOutcome::Absent,
            ReadOutcome::Present(revoked),
            ReadOutcome::Present(app_install),
        ] {
            let reply = resolve_with(
                CredOutcome::Found(accepted("h1", "u1")),
                read,
                Some("Bearer good-token"),
            )
            .await;
            assert_eq!(reply.status, StatusCode::FORBIDDEN);
            assert_eq!(parsed(&reply.body), refused);
            assert_eq!(reply.lookups, 1);
            assert_eq!(reply.reads, 1);
        }
    }

    #[tokio::test]
    async fn a_credential_lookup_failure_is_the_frameworks_plain_500() {
        let reply = resolve_with(
            CredOutcome::Fails,
            ReadOutcome::Present(live_user_managed("h1", "u1")),
            Some("Bearer good-token"),
        )
        .await;
        assert_eq!(reply.status, StatusCode::INTERNAL_SERVER_ERROR);
        assert_eq!(reply.body, "Internal Server Error");
        assert_eq!(reply.reads, 0);
    }

    #[tokio::test]
    async fn a_computer_read_failure_is_the_frameworks_plain_500() {
        let reply = resolve_with(
            CredOutcome::Found(accepted("h1", "u1")),
            ReadOutcome::Fails,
            Some("Bearer good-token"),
        )
        .await;
        assert_eq!(reply.status, StatusCode::INTERNAL_SERVER_ERROR);
        assert_eq!(reply.body, "Internal Server Error");
        assert_eq!(reply.lookups, 1);
        assert_eq!(reply.reads, 1);
    }
}
