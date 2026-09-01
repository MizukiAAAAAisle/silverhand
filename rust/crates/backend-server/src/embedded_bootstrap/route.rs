//! `POST /auth/embedded-bootstrap` — the embedded first-run session grant, ported
//! from the `routes.ts` embedded handler. The backend-app composition mounts [`router`]
//! once at the top level and serves through
//! `into_make_service_with_connect_info::<SocketAddr>()`. The handler is a thin transport over
//! [`silverhand_backend_core::embedded_bootstrap::bootstrap_session`].
//!
//! ## Every pre-verdict failure collapses to an indistinguishable 404
//!
//! Mirroring the TS contract, a non-embedded/disabled authority, a non-loopback
//! peer, a malformed body, a missing/empty token, and a wrong/already-spent token
//! ALL return a bare `404` with an empty body — a probe cannot tell "route absent"
//! from "wrong token" from "not loopback". Only AFTER a token is successfully spent
//! does the DB verdict surface: `200 { user_token, user }` on a created/selected
//! local viewer, or `409 { error, code: "bootstrap_ambiguous_user" }` when more than
//! one viewer exists. A spent token stays spent even on the 409.
//!
//! ## The loopback gate reads the real socket peer, fail-closed
//!
//! [`LoopbackPeer`] extracts `ConnectInfo<SocketAddr>` and admits only a loopback
//! IP (`127.0.0.0/8`, `::1`, IPv4-mapped `::ffff:127.x`). It runs BEFORE the body is
//! read, and absent connect-info (the extension the make-service populates) is
//! treated as non-loopback → 404. It judges the IP only; `SocketAddr` carries no
//! hostname, so there is no `localhost` string branch.

use std::net::{IpAddr, SocketAddr};

use axum::{
    Json, Router,
    extract::{ConnectInfo, FromRequestParts, State},
    http::{HeaderMap, StatusCode, request::Parts},
    response::{IntoResponse, Response},
    routing::post,
};
use garde::Validate;
use serde::{Deserialize, Serialize};
use silverhand_backend_core::{
    embedded_bootstrap::{
        BootstrapPorts, EmbeddedBootstrap, EmbeddedBootstrapUnitOfWork, bootstrap_session,
    },
    identity_access::auth::{SessionAudit, SessionClock, SessionIssue, SessionTokenMint},
    identity_access::user_identity::UserChangedSink,
};

use crate::embedded_bootstrap::token::EmbeddedBootstrapTokenAuthority;
use crate::foundation::error;
use crate::foundation::wire_admission::{ValidatedJson, ValidatedJsonRejection};
use crate::human_auth::{UserDto, log_lost_announce};

/// `authPaths.embeddedBootstrap`.
pub const EMBEDDED_BOOTSTRAP_PATH: &str = "/auth/embedded-bootstrap";

/// The safe-500 body, a bare `text/plain`, matching the crate's other routes.
const INTERNAL_ERROR_BODY: &str = "Internal Server Error";

// ===========================================================================
// The per-request loopback gate (first `FromRequestParts` extractor in the crate).
// ===========================================================================

/// A proof that the connecting TCP peer is a loopback address. Fail-closed: absent
/// connect-info or a non-loopback peer rejects with a bare 404 (the empty-body
/// indistinguishable refusal), never a distinguishable error.
pub struct LoopbackPeer;

impl<S> FromRequestParts<S> for LoopbackPeer
where
    S: Send + Sync,
{
    type Rejection = Response;

    async fn from_request_parts(parts: &mut Parts, state: &S) -> Result<Self, Self::Rejection> {
        // Delegate to axum's own `ConnectInfo` extractor: it reads the real
        // `ConnectInfo<SocketAddr>` the connect-info make-service inserts in
        // production, and transparently falls back to the test `MockConnectInfo`
        // layer. Absent both (a service not built with connect-info) it errors →
        // we fail closed to the indistinguishable 404, never trusting the peer.
        let is_loopback = ConnectInfo::<SocketAddr>::from_request_parts(parts, state)
            .await
            .is_ok_and(|ConnectInfo(addr)| is_loopback_ip(addr.ip()));
        if is_loopback {
            Ok(LoopbackPeer)
        } else {
            Err(not_found())
        }
    }
}

/// Whether an IP is a loopback address: IPv4 `127.0.0.0/8`, IPv6 `::1`, or an
/// IPv4-mapped loopback `::ffff:127.x.x.x`. `SocketAddr` carries no hostname, so
/// there is deliberately no `localhost` branch.
///
/// # Convergence-owned surface
///
/// This is `pub` solely so the composition root can decide, at startup, whether to
/// arm the embedded-bootstrap token authority using the SAME loopback judgement the
/// request-time [`LoopbackPeer`] gate applies to the bound listener's local address.
/// It is the ONE loopback predicate for this authority — the launcher must not grow
/// a second `IpAddr::is_loopback` / config-string variant that could drift from the
/// gate. It belongs to the embedded-bootstrap authority, not a general network
/// helper: do not reuse it for unrelated address checks, and do not glob re-export it.
pub fn is_loopback_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => v4.is_loopback(),
        IpAddr::V6(v6) => {
            v6.is_loopback() || v6.to_ipv4_mapped().is_some_and(|v4| v4.is_loopback())
        }
    }
}

// ===========================================================================
// Composition + router.
// ===========================================================================

/// Everything the bootstrap route needs, assembled by the composition root and used
/// directly as the axum state. Generic per capability, `Clone` because every port
/// is (the token authority shares one `Arc`).
#[derive(Clone)]
pub struct EmbeddedBootstrapDeps<Uow, Mint, Iss, Sink, Clk> {
    /// The atomic single-viewer choose-or-create unit of work.
    pub bootstrap: Uow,
    /// The session token mint.
    pub mint: Mint,
    /// The session issue write.
    pub sessions: Iss,
    /// The `user_changed` announce sink (fired only on a create).
    pub user_changed: Sink,
    /// The request-instant clock.
    pub clock: Clk,
    /// The one-shot bootstrap token authority (disabled off the embedded path).
    pub token: EmbeddedBootstrapTokenAuthority,
}

/// Build the single-route embedded-bootstrap router. Backend-app mounts this once at the
/// top level and serves it with socket connect-info; this factory remains responsible only
/// for the bounded route state and handler.
pub fn router<Uow, Mint, Iss, Sink, Clk>(
    deps: EmbeddedBootstrapDeps<Uow, Mint, Iss, Sink, Clk>,
) -> Router
where
    Uow: EmbeddedBootstrapUnitOfWork,
    Mint: SessionTokenMint,
    Iss: SessionIssue,
    Sink: UserChangedSink,
    Clk: SessionClock,
{
    Router::new()
        .route(
            EMBEDDED_BOOTSTRAP_PATH,
            post(bootstrap::<Uow, Mint, Iss, Sink, Clk>),
        )
        .with_state(deps)
}

// ===========================================================================
// The handler.
// ===========================================================================

async fn bootstrap<Uow, Mint, Iss, Sink, Clk>(
    State(deps): State<EmbeddedBootstrapDeps<Uow, Mint, Iss, Sink, Clk>>,
    // Runs before the body: a non-loopback peer is a 404 without reading the body.
    _peer: LoopbackPeer,
    headers: HeaderMap,
    // Any body fault (malformed, non-object, missing/wrong-typed token) is the
    // indistinguishable 404, never the native structural rejection.
    body: Result<ValidatedJson<BootstrapRaw>, ValidatedJsonRejection>,
) -> Response
where
    Uow: EmbeddedBootstrapUnitOfWork,
    Mint: SessionTokenMint,
    Iss: SessionIssue,
    Sink: UserChangedSink,
    Clk: SessionClock,
{
    let Ok(ValidatedJson(raw)) = body else {
        return not_found();
    };
    let token = raw.token.trim();
    if token.is_empty() {
        return not_found();
    }

    // Atomic one-shot consume. A wrong/empty/already-spent/disabled token → 404 with
    // no session and no DB touch. A success permanently spends the token BEFORE the
    // DB verdict, so even the 409 below leaves it invalidated.
    if !deps.token.consume(token).await {
        return not_found();
    }

    let audit = capture_audit(&headers);
    let now_ms = deps.clock.now_unix_millis();
    let ports = BootstrapPorts {
        unit_of_work: &deps.bootstrap,
        mint: &deps.mint,
        sessions: &deps.sessions,
        user_changed: &deps.user_changed,
    };
    match bootstrap_session(ports, &audit, now_ms).await {
        Ok(EmbeddedBootstrap::Session {
            user,
            secret,
            announce,
        }) => {
            log_lost_announce(&announce, "embedded bootstrap");
            Json(BootstrapSessionResponse {
                user_token: secret.into_wire(),
                user: UserDto::from_record(&user),
            })
            .into_response()
        }
        Ok(EmbeddedBootstrap::Ambiguous) => ambiguous_user(),
        Err(cause) => {
            tracing::error!(error_chain = %error::describe(&cause), "embedded bootstrap flow failed");
            internal_error()
        }
    }
}

// ===========================================================================
// Request-boundary admission.
// ===========================================================================

/// The `POST /auth/embedded-bootstrap` body: a required string `token`. An absent or
/// wrong-typed `token`, or a non-object body, is a decode fault the handler maps to
/// the indistinguishable 404. Unknown extra keys are ignored, exactly as the TS
/// handler reads only `body.token`.
#[derive(Debug, Deserialize, Validate)]
struct BootstrapRaw {
    #[garde(skip)]
    token: String,
}

/// Capture the session audit breadcrumbs, mirroring the TS `authSessionMetadata`:
/// the `user-agent` header and the first `x-forwarded-for` hop else `x-real-ip`.
fn capture_audit(headers: &HeaderMap) -> SessionAudit {
    let user_agent = header_value(headers, "user-agent");
    let ip_first_seen = first_forwarded_for(headers).or_else(|| header_value(headers, "x-real-ip"));
    SessionAudit::capture(user_agent.as_deref(), ip_first_seen.as_deref())
}

fn header_value(headers: &HeaderMap, name: &str) -> Option<String> {
    headers
        .get(name)
        .and_then(|value| value.to_str().ok())
        .map(str::to_owned)
}

fn first_forwarded_for(headers: &HeaderMap) -> Option<String> {
    let raw = header_value(headers, "x-forwarded-for")?;
    let first = raw.split(',').next()?.trim();
    (!first.is_empty()).then(|| first.to_owned())
}

// ===========================================================================
// Wire projection.
// ===========================================================================

/// `{ user_token, user }` — the same session-issue envelope signup/login return,
/// reusing the shared [`UserDto`] projection (with its avatar arm).
#[derive(Serialize)]
struct BootstrapSessionResponse {
    user_token: String,
    user: UserDto,
}

/// The `409` body: `{ error, code: "bootstrap_ambiguous_user" }`, byte-for-byte the
/// TS refusal.
#[derive(Serialize)]
struct AmbiguousUserBody {
    error: &'static str,
    code: &'static str,
}

fn ambiguous_user() -> Response {
    (
        StatusCode::CONFLICT,
        Json(AmbiguousUserBody {
            error: "embedded bootstrap cannot choose among multiple users",
            code: "bootstrap_ambiguous_user",
        }),
    )
        .into_response()
}

/// The bare, empty-body `404` every pre-verdict refusal collapses to.
fn not_found() -> Response {
    StatusCode::NOT_FOUND.into_response()
}

fn internal_error() -> Response {
    (StatusCode::INTERNAL_SERVER_ERROR, INTERNAL_ERROR_BODY).into_response()
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{
        body::{Body, to_bytes},
        extract::connect_info::MockConnectInfo,
        http::Request,
    };
    use silverhand_backend_core::{
        embedded_bootstrap::BootstrapChoice,
        foundation::identity::UserId,
        foundation::persistence::PersistenceFailure,
        host_runtime::environment::EntropySource,
        identity_access::auth::{
            EntropySessionTokenMint, MintedSession, SessionMintError, SessionTokenHash,
        },
        identity_access::user_identity::{UserChangedAnnounceFailure, UserRecord},
    };
    use std::{
        net::{Ipv4Addr, Ipv6Addr},
        sync::{
            Arc, Mutex,
            atomic::{AtomicUsize, Ordering},
        },
    };
    use thiserror::Error;
    use tower::ServiceExt;

    const TOKEN: &str = "the-bootstrap-token";

    fn record() -> UserRecord {
        UserRecord {
            id: UserId::parse("localuser").unwrap(),
            handle: "local".to_owned(),
            display_name: "Local User".to_owned(),
            email: None,
            avatar: None,
            created_at: 10,
            updated_at: 10,
        }
    }

    #[derive(Clone)]
    struct FakeUow(BootstrapChoice);
    impl EmbeddedBootstrapUnitOfWork for FakeUow {
        async fn choose_or_create(
            &self,
            _now_ms: i64,
        ) -> Result<BootstrapChoice, PersistenceFailure> {
            Ok(self.0.clone())
        }
    }

    #[derive(Clone)]
    struct CountingEntropy(Arc<Mutex<u8>>);
    #[derive(Debug, Error)]
    #[error("never")]
    struct NeverFails;
    impl EntropySource for CountingEntropy {
        type Error = NeverFails;
        fn fill(&self, destination: &mut [u8]) -> Result<(), Self::Error> {
            let mut cursor = self.0.lock().unwrap();
            for slot in destination.iter_mut() {
                *slot = *cursor;
                *cursor = cursor.wrapping_add(1);
            }
            Ok(())
        }
    }

    #[derive(Clone)]
    struct FakeMint;
    impl SessionTokenMint for FakeMint {
        fn mint(&self) -> Result<MintedSession, SessionMintError> {
            EntropySessionTokenMint::new(CountingEntropy(Arc::new(Mutex::new(1)))).mint()
        }
    }

    #[derive(Clone)]
    struct RecordingIssue(Arc<AtomicUsize>);
    impl SessionIssue for RecordingIssue {
        async fn issue(
            &self,
            _user_id: &UserId,
            _token_hash: SessionTokenHash,
            _audit: &SessionAudit,
            _now_ms: i64,
        ) -> Result<(), PersistenceFailure> {
            self.0.fetch_add(1, Ordering::SeqCst);
            Ok(())
        }
    }

    #[derive(Clone)]
    struct FakeSink(Arc<AtomicUsize>);
    impl UserChangedSink for FakeSink {
        async fn user_changed(&self, _user_id: &UserId) -> Result<(), UserChangedAnnounceFailure> {
            self.0.fetch_add(1, Ordering::SeqCst);
            Ok(())
        }
    }

    #[derive(Clone)]
    struct FixedClock;
    impl SessionClock for FixedClock {
        fn now_unix_millis(&self) -> i64 {
            1_000
        }
    }

    struct Harness {
        issues: Arc<AtomicUsize>,
        announces: Arc<AtomicUsize>,
        router: Router,
    }

    fn harness(choice: BootstrapChoice, token: EmbeddedBootstrapTokenAuthority) -> Harness {
        let issues = Arc::new(AtomicUsize::new(0));
        let announces = Arc::new(AtomicUsize::new(0));
        let deps = EmbeddedBootstrapDeps {
            bootstrap: FakeUow(choice),
            mint: FakeMint,
            sessions: RecordingIssue(issues.clone()),
            user_changed: FakeSink(announces.clone()),
            clock: FixedClock,
            token,
        };
        Harness {
            issues,
            announces,
            router: router(deps),
        }
    }

    fn armed_token() -> (
        EmbeddedBootstrapTokenAuthority,
        tempfile::TempDir,
        std::path::PathBuf,
    ) {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("embedded-bootstrap");
        std::fs::write(&file, format!("{TOKEN}\n")).unwrap();
        (
            EmbeddedBootstrapTokenAuthority::enabled(TOKEN, file.clone()),
            dir,
            file,
        )
    }

    fn request(body: &str) -> Request<Body> {
        Request::builder()
            .method("POST")
            .uri(EMBEDDED_BOOTSTRAP_PATH)
            .header("content-type", "application/json")
            .body(Body::from(body.to_owned()))
            .unwrap()
    }

    /// Dispatch through the router, optionally injecting a connect-info peer via the
    /// `MockConnectInfo` layer (the ONLY place connect-info is injected — never a
    /// global harness). `peer: None` leaves connect-info absent (fail-closed case).
    async fn send(h: &Harness, peer: Option<SocketAddr>, body: &str) -> (StatusCode, String) {
        let response = match peer {
            Some(addr) => h
                .router
                .clone()
                .layer(MockConnectInfo(addr))
                .oneshot(request(body))
                .await
                .unwrap(),
            None => h.router.clone().oneshot(request(body)).await.unwrap(),
        };
        let status = response.status();
        let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        (status, String::from_utf8(bytes.to_vec()).unwrap())
    }

    fn loopback_v4() -> SocketAddr {
        SocketAddr::from((Ipv4Addr::new(127, 0, 0, 1), 54321))
    }

    fn body(token: &str) -> String {
        format!("{{\"token\":\"{token}\"}}")
    }

    #[tokio::test]
    async fn loopback_valid_token_zero_users_mints_a_session_and_announces_once() {
        let (token, _dir, file) = armed_token();
        let h = harness(BootstrapChoice::Created { user: record() }, token);

        let (status, out) = send(&h, Some(loopback_v4()), &body(TOKEN)).await;
        assert_eq!(status, StatusCode::OK);
        assert!(out.contains("\"user_token\":"));
        assert!(out.contains("\"name\":\"local\""));
        assert!(!out.contains("email"), "email is never projected");
        assert_eq!(h.issues.load(Ordering::SeqCst), 1, "one session minted");
        assert_eq!(
            h.announces.load(Ordering::SeqCst),
            1,
            "created announces once"
        );
        assert!(!file.exists(), "token file unlinked on consume");
    }

    #[tokio::test]
    async fn a_replayed_token_is_a_404_and_mints_nothing() {
        let (token, _dir, _file) = armed_token();
        let h = harness(BootstrapChoice::Created { user: record() }, token);

        let (first, _) = send(&h, Some(loopback_v4()), &body(TOKEN)).await;
        assert_eq!(first, StatusCode::OK);
        let (second, out) = send(&h, Some(loopback_v4()), &body(TOKEN)).await;
        assert_eq!(second, StatusCode::NOT_FOUND);
        assert!(out.is_empty(), "404 body is empty");
        assert_eq!(
            h.issues.load(Ordering::SeqCst),
            1,
            "no second mint on replay"
        );
    }

    #[tokio::test]
    async fn a_non_loopback_peer_is_a_404_and_never_consumes_the_token() {
        let (token, _dir, _file) = armed_token();
        let h = harness(BootstrapChoice::Created { user: record() }, token);

        // Public IPv4 → 404, and the token must be untouched.
        let remote = SocketAddr::from((Ipv4Addr::new(8, 8, 8, 8), 443));
        let (status, _) = send(&h, Some(remote), &body(TOKEN)).await;
        assert_eq!(status, StatusCode::NOT_FOUND);
        assert_eq!(h.issues.load(Ordering::SeqCst), 0);

        // The same token now works from loopback → the peer gate ran BEFORE consume.
        let (ok, _) = send(&h, Some(loopback_v4()), &body(TOKEN)).await;
        assert_eq!(ok, StatusCode::OK);
    }

    #[tokio::test]
    async fn absent_connect_info_is_fail_closed_404() {
        let (token, _dir, _file) = armed_token();
        let h = harness(BootstrapChoice::Created { user: record() }, token);
        let (status, _) = send(&h, None, &body(TOKEN)).await;
        assert_eq!(status, StatusCode::NOT_FOUND);
        assert_eq!(h.issues.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn an_ipv4_mapped_loopback_peer_is_accepted() {
        let (token, _dir, _file) = armed_token();
        let h = harness(BootstrapChoice::Created { user: record() }, token);
        let mapped = SocketAddr::from((Ipv4Addr::new(127, 0, 0, 1).to_ipv6_mapped(), 5000));
        assert!(matches!(mapped.ip(), IpAddr::V6(_)));
        let (status, _) = send(&h, Some(mapped), &body(TOKEN)).await;
        assert_eq!(status, StatusCode::OK);
    }

    #[tokio::test]
    async fn a_non_loopback_ipv6_peer_is_rejected() {
        let (token, _dir, _file) = armed_token();
        let h = harness(BootstrapChoice::Created { user: record() }, token);
        let remote = SocketAddr::from((Ipv6Addr::new(0x2001, 0xdb8, 0, 0, 0, 0, 0, 1), 443));
        let (status, _) = send(&h, Some(remote), &body(TOKEN)).await;
        assert_eq!(status, StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn a_loopback_ipv6_peer_is_accepted() {
        let (token, _dir, _file) = armed_token();
        let h = harness(BootstrapChoice::Created { user: record() }, token);
        let local = SocketAddr::from((Ipv6Addr::LOCALHOST, 5000));
        let (status, _) = send(&h, Some(local), &body(TOKEN)).await;
        assert_eq!(status, StatusCode::OK);
    }

    #[tokio::test]
    async fn a_wrong_token_is_a_404_and_leaves_the_real_token_live() {
        let (token, _dir, _file) = armed_token();
        let h = harness(BootstrapChoice::Selected { user: record() }, token);
        let (bad, _) = send(&h, Some(loopback_v4()), &body("nope")).await;
        assert_eq!(bad, StatusCode::NOT_FOUND);
        assert_eq!(h.issues.load(Ordering::SeqCst), 0);
        let (ok, _) = send(&h, Some(loopback_v4()), &body(TOKEN)).await;
        assert_eq!(ok, StatusCode::OK);
    }

    #[tokio::test]
    async fn an_empty_token_is_a_404() {
        let (token, _dir, _file) = armed_token();
        let h = harness(BootstrapChoice::Created { user: record() }, token);
        let (status, _) = send(&h, Some(loopback_v4()), &body("   ")).await;
        assert_eq!(status, StatusCode::NOT_FOUND);
        assert_eq!(h.issues.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn a_non_object_body_is_a_404() {
        let (token, _dir, _file) = armed_token();
        let h = harness(BootstrapChoice::Created { user: record() }, token);
        // A JSON array is a structural fault the ObjectOnly admission rejects; the
        // handler maps it to the indistinguishable 404, never a 422.
        let (status, _) = send(&h, Some(loopback_v4()), "[\"x\"]").await;
        assert_eq!(status, StatusCode::NOT_FOUND);
    }

    // The next three are true body-fault discriminators: each is dispatched from a
    // loopback peer with the authority ARMED, so the only possible cause of the 404
    // is the body shape — and none of them may consume the token or mint a session.

    #[tokio::test]
    async fn malformed_json_is_a_404_and_does_not_consume() {
        let (token, _dir, _file) = armed_token();
        let h = harness(BootstrapChoice::Created { user: record() }, token);
        // Truncated object → a JSON syntax fault → decode Err → 404.
        let (status, _) = send(&h, Some(loopback_v4()), "{\"token\":").await;
        assert_eq!(status, StatusCode::NOT_FOUND);
        assert_eq!(
            h.issues.load(Ordering::SeqCst),
            0,
            "no mint on malformed body"
        );
        // The real token survives, proving no consume happened on the fault.
        let (ok, _) = send(&h, Some(loopback_v4()), &body(TOKEN)).await;
        assert_eq!(ok, StatusCode::OK);
    }

    #[tokio::test]
    async fn a_missing_token_field_is_a_404() {
        let (token, _dir, _file) = armed_token();
        let h = harness(BootstrapChoice::Created { user: record() }, token);
        // Well-formed object, but the required `token` string is absent → decode Err.
        let (status, _) = send(&h, Some(loopback_v4()), "{}").await;
        assert_eq!(status, StatusCode::NOT_FOUND);
        assert_eq!(h.issues.load(Ordering::SeqCst), 0);
        let (ok, _) = send(&h, Some(loopback_v4()), &body(TOKEN)).await;
        assert_eq!(ok, StatusCode::OK);
    }

    #[tokio::test]
    async fn a_wrong_typed_token_is_a_404() {
        let (token, _dir, _file) = armed_token();
        let h = harness(BootstrapChoice::Created { user: record() }, token);
        // `token` present but a number, not a string → decode Err → 404.
        let (status, _) = send(&h, Some(loopback_v4()), "{\"token\":123}").await;
        assert_eq!(status, StatusCode::NOT_FOUND);
        assert_eq!(h.issues.load(Ordering::SeqCst), 0);
        let (ok, _) = send(&h, Some(loopback_v4()), &body(TOKEN)).await;
        assert_eq!(ok, StatusCode::OK);
    }

    #[tokio::test]
    async fn one_user_selects_and_never_announces() {
        let (token, _dir, _file) = armed_token();
        let h = harness(BootstrapChoice::Selected { user: record() }, token);
        let (status, out) = send(&h, Some(loopback_v4()), &body(TOKEN)).await;
        assert_eq!(status, StatusCode::OK);
        assert!(out.contains("\"user_token\":"));
        assert_eq!(h.issues.load(Ordering::SeqCst), 1, "select still mints");
        assert_eq!(
            h.announces.load(Ordering::SeqCst),
            0,
            "select never announces"
        );
    }

    #[tokio::test]
    async fn many_users_is_a_409_with_the_ambiguous_code_and_a_spent_token() {
        let (token, _dir, _file) = armed_token();
        let h = harness(BootstrapChoice::Conflict, token);
        let (status, out) = send(&h, Some(loopback_v4()), &body(TOKEN)).await;
        assert_eq!(status, StatusCode::CONFLICT);
        assert!(out.contains("\"code\":\"bootstrap_ambiguous_user\""));
        assert_eq!(h.issues.load(Ordering::SeqCst), 0, "409 mints nothing");
        // The token was spent BEFORE the 409, so a replay is a 404.
        let (replay, _) = send(&h, Some(loopback_v4()), &body(TOKEN)).await;
        assert_eq!(replay, StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn a_disabled_authority_is_a_404_even_from_loopback() {
        let h = harness(
            BootstrapChoice::Created { user: record() },
            EmbeddedBootstrapTokenAuthority::disabled(),
        );
        let (status, _) = send(&h, Some(loopback_v4()), &body(TOKEN)).await;
        assert_eq!(status, StatusCode::NOT_FOUND);
        assert_eq!(h.issues.load(Ordering::SeqCst), 0);
    }
}
