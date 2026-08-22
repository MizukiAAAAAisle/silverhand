use std::{future::Future, sync::Arc};

use axum::{
    Json, Router,
    body::Bytes,
    extract::State,
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::post,
};
use serde::{
    Deserialize, Deserializer, Serialize,
    de::{IgnoredAny, MapAccess, SeqAccess, Visitor},
};
use silverhand_backend_core::{
    host_runtime::{
        Clock, CreateHostInvite, CreatedUserInviteHost, EntropySource, HostInviteError,
        HostInviteUnitOfWork,
    },
    persistence::PersistenceFailure,
};

use crate::error;

pub const HOSTS_PATH: &str = "/api/hosts";
pub const DEFAULT_DAEMON_NPM_SPEC: &str = "@silverhand-ai/daemon@latest";

pub trait SessionUserResolver: Clone + Send + Sync + 'static {
    fn resolve_session_user(
        &self,
        bearer_token: String,
    ) -> impl Future<Output = Result<Option<String>, PersistenceFailure>> + Send;
}

struct StateInner<U, R, C, A> {
    create_host_invite: CreateHostInvite<U, R, C>,
    sessions: A,
    daemon_npm_spec: String,
}

struct HostRuntimeState<U, R, C, A>(Arc<StateInner<U, R, C, A>>);

impl<U, R, C, A> Clone for HostRuntimeState<U, R, C, A> {
    fn clone(&self) -> Self {
        Self(Arc::clone(&self.0))
    }
}

pub fn router<U, R, C, A>(
    create_host_invite: CreateHostInvite<U, R, C>,
    sessions: A,
    daemon_npm_spec: Option<String>,
) -> Router
where
    U: HostInviteUnitOfWork,
    R: EntropySource + 'static,
    C: Clock + 'static,
    A: SessionUserResolver,
{
    let daemon_npm_spec = daemon_npm_spec
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| DEFAULT_DAEMON_NPM_SPEC.to_owned());
    let state = HostRuntimeState(Arc::new(StateInner {
        create_host_invite,
        sessions,
        daemon_npm_spec,
    }));
    Router::new()
        .route(HOSTS_PATH, post(create_host::<U, R, C, A>))
        .with_state(state)
}

async fn create_host<U, R, C, A>(
    State(state): State<HostRuntimeState<U, R, C, A>>,
    headers: HeaderMap,
    body: Bytes,
) -> Response
where
    U: HostInviteUnitOfWork,
    R: EntropySource + 'static,
    C: Clock + 'static,
    A: SessionUserResolver,
{
    let Some(token) = bearer_token(&headers) else {
        return session_required();
    };
    let user_id = match state.0.sessions.resolve_session_user(token).await {
        Ok(Some(user_id)) => user_id,
        Ok(None) => return session_required(),
        Err(error) => return BoundaryError::from(error).into_response(),
    };

    if let Some(response) = validate_empty_object(&body) {
        return response;
    }

    match state.0.create_host_invite.execute(user_id).await {
        Ok(fact) => {
            let response = HostCreateResponse {
                host_id: fact.host.id().to_owned(),
                host: HostDto::from(fact.host),
                connect_token: fact.connect_token.reveal_once(),
                daemon_npm_spec: state.0.daemon_npm_spec.clone(),
            };
            (StatusCode::OK, Json(response)).into_response()
        }
        Err(error) => BoundaryError::from(error).into_response(),
    }
}

fn bearer_token(headers: &HeaderMap) -> Option<String> {
    let header = headers
        .get(axum::http::header::AUTHORIZATION)?
        .to_str()
        .ok()?;
    let split = header.find(char::is_whitespace)?;
    let (scheme, rest) = header.split_at(split);
    if !scheme.eq_ignore_ascii_case("bearer") {
        return None;
    }
    let token = rest.trim();
    (!token.is_empty()).then(|| token.to_owned())
}

fn validate_empty_object(body: &[u8]) -> Option<Response> {
    let shape = serde_json::from_slice::<TopLevelJson>(body)
        .unwrap_or_else(|_| TopLevelJson::Object(Vec::new()));
    match shape {
        TopLevelJson::Object(keys) if keys.is_empty() => None,
        TopLevelJson::Object(keys) => {
            let message = unrecognized_keys_message(&keys);
            Some(invalid_input(vec![ZodIssue::UnrecognizedKeys {
                code: "unrecognized_keys",
                keys,
                path: Vec::new(),
                message,
            }]))
        }
        TopLevelJson::Other(received) => Some(invalid_input(vec![ZodIssue::InvalidType {
            code: "invalid_type",
            expected: "object",
            received,
            path: Vec::new(),
            message: format!("Expected object, received {received}"),
        }])),
    }
}

fn unrecognized_keys_message(keys: &[String]) -> String {
    let quoted = keys
        .iter()
        .map(|key| format!("'{key}'"))
        .collect::<Vec<_>>()
        .join(", ");
    format!("Unrecognized key(s) in object: {quoted}")
}

enum TopLevelJson {
    Object(Vec<String>),
    Other(&'static str),
}

impl<'de> Deserialize<'de> for TopLevelJson {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        deserializer.deserialize_any(TopLevelJsonVisitor)
    }
}

struct TopLevelJsonVisitor;

impl<'de> Visitor<'de> for TopLevelJsonVisitor {
    type Value = TopLevelJson;

    fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("a JSON value")
    }

    fn visit_map<M>(self, mut map: M) -> Result<Self::Value, M::Error>
    where
        M: MapAccess<'de>,
    {
        let mut keys = Vec::new();
        while let Some(key) = map.next_key::<String>()? {
            keys.push(key);
            map.next_value::<IgnoredAny>()?;
        }
        Ok(TopLevelJson::Object(keys))
    }

    fn visit_seq<A>(self, mut sequence: A) -> Result<Self::Value, A::Error>
    where
        A: SeqAccess<'de>,
    {
        while sequence.next_element::<IgnoredAny>()?.is_some() {}
        Ok(TopLevelJson::Other("array"))
    }

    fn visit_bool<E>(self, _value: bool) -> Result<Self::Value, E> {
        Ok(TopLevelJson::Other("boolean"))
    }

    fn visit_i64<E>(self, _value: i64) -> Result<Self::Value, E> {
        Ok(TopLevelJson::Other("number"))
    }

    fn visit_u64<E>(self, _value: u64) -> Result<Self::Value, E> {
        Ok(TopLevelJson::Other("number"))
    }

    fn visit_f64<E>(self, _value: f64) -> Result<Self::Value, E> {
        Ok(TopLevelJson::Other("number"))
    }

    fn visit_str<E>(self, _value: &str) -> Result<Self::Value, E> {
        Ok(TopLevelJson::Other("string"))
    }

    fn visit_string<E>(self, _value: String) -> Result<Self::Value, E> {
        Ok(TopLevelJson::Other("string"))
    }

    fn visit_none<E>(self) -> Result<Self::Value, E> {
        Ok(TopLevelJson::Other("null"))
    }

    fn visit_unit<E>(self) -> Result<Self::Value, E> {
        Ok(TopLevelJson::Other("null"))
    }
}

fn session_required() -> Response {
    (
        StatusCode::UNAUTHORIZED,
        Json(SessionRequiredResponse {
            error: "unauthorized",
        }),
    )
        .into_response()
}

fn invalid_input(issues: Vec<ZodIssue>) -> Response {
    (
        StatusCode::BAD_REQUEST,
        Json(InvalidInputResponse {
            error: "invalid input",
            issues,
        }),
    )
        .into_response()
}

#[derive(Serialize)]
struct SessionRequiredResponse {
    error: &'static str,
}

#[derive(Serialize)]
struct InvalidInputResponse {
    error: &'static str,
    issues: Vec<ZodIssue>,
}

#[derive(Serialize)]
#[serde(untagged)]
enum ZodIssue {
    UnrecognizedKeys {
        code: &'static str,
        keys: Vec<String>,
        path: Vec<String>,
        message: String,
    },
    InvalidType {
        code: &'static str,
        expected: &'static str,
        received: &'static str,
        path: Vec<String>,
        message: String,
    },
}

#[derive(Serialize)]
struct HostCreateResponse {
    host_id: String,
    host: HostDto,
    connect_token: String,
    daemon_npm_spec: String,
}

#[derive(Serialize)]
struct HostDto {
    id: String,
    name: String,
    kind: &'static str,
    created_at: i64,
    revoked_at: Option<i64>,
    last_seen_at: Option<i64>,
    activated_at: Option<i64>,
    finalized_at: Option<i64>,
    connected_host_name: Option<String>,
    provisioning_source: &'static str,
    status: &'static str,
    placeable: bool,
    creator_user_id: String,
    display_label: Option<String>,
}

impl From<CreatedUserInviteHost> for HostDto {
    fn from(host: CreatedUserInviteHost) -> Self {
        Self {
            id: host.id().to_owned(),
            name: host.name().to_owned(),
            kind: "remote",
            created_at: host.created_at(),
            revoked_at: None,
            last_seen_at: None,
            activated_at: None,
            finalized_at: None,
            connected_host_name: None,
            provisioning_source: "user_invite",
            status: "pending",
            placeable: false,
            creator_user_id: host.user_id().to_owned(),
            display_label: None,
        }
    }
}

struct BoundaryError(Box<dyn std::error::Error + Send + Sync>);

impl From<PersistenceFailure> for BoundaryError {
    fn from(error: PersistenceFailure) -> Self {
        Self(Box::new(error))
    }
}

impl From<HostInviteError> for BoundaryError {
    fn from(error: HostInviteError) -> Self {
        Self(Box::new(error))
    }
}

impl IntoResponse for BoundaryError {
    fn into_response(self) -> Response {
        tracing::error!(
            error_chain = %error::describe(self.0.as_ref()),
            "create host invite failed"
        );
        (StatusCode::INTERNAL_SERVER_ERROR, "Internal Server Error").into_response()
    }
}

#[cfg(test)]
mod tests {
    use std::{
        collections::VecDeque,
        convert::Infallible,
        io::{self, Write},
        sync::{
            Arc, Mutex,
            atomic::{AtomicUsize, Ordering},
        },
    };

    use axum::{
        body::{Body, to_bytes},
        http::Request,
    };
    use silverhand_backend_core::host_runtime::{
        HostInviteWriteError, NewLongLivedCredential, NewUserInviteHost,
    };
    use tower::ServiceExt;
    use tracing_subscriber::fmt::MakeWriter;

    use super::*;

    #[derive(Clone, Copy, Default)]
    enum StoreBehavior {
        #[default]
        Succeed,
        DuplicateOnce,
        AlwaysDuplicate,
    }

    #[derive(Clone, Default)]
    struct CountingStore {
        behavior: StoreBehavior,
        calls: Arc<AtomicUsize>,
        writes: Arc<Mutex<Vec<(String, String)>>>,
    }

    impl CountingStore {
        fn with_behavior(behavior: StoreBehavior) -> Self {
            Self {
                behavior,
                ..Self::default()
            }
        }
    }

    impl HostInviteUnitOfWork for CountingStore {
        async fn create_host_and_credential(
            &self,
            host: NewUserInviteHost,
            credential: NewLongLivedCredential,
        ) -> Result<(), HostInviteWriteError> {
            let call = self.calls.fetch_add(1, Ordering::SeqCst);
            match self.behavior {
                StoreBehavior::DuplicateOnce if call == 0 => {
                    return Err(HostInviteWriteError::DuplicateHostName);
                }
                StoreBehavior::AlwaysDuplicate => {
                    return Err(HostInviteWriteError::DuplicateHostName);
                }
                StoreBehavior::Succeed | StoreBehavior::DuplicateOnce => {}
            }
            self.writes
                .lock()
                .unwrap()
                .push((host.id().to_owned(), credential.id().to_owned()));
            Ok(())
        }
    }

    #[derive(Clone)]
    struct FixedEntropy(Arc<Mutex<VecDeque<u8>>>);

    impl FixedEntropy {
        fn sequence() -> Self {
            Self(Arc::new(Mutex::new(
                (0..1024).map(|index| index as u8).collect(),
            )))
        }
    }

    impl EntropySource for FixedEntropy {
        type Error = Infallible;

        fn fill(&self, destination: &mut [u8]) -> Result<(), Self::Error> {
            let mut source = self.0.lock().unwrap();
            for byte in destination {
                *byte = source.pop_front().unwrap();
            }
            Ok(())
        }
    }

    #[derive(Clone, Copy)]
    struct FixedClock;

    impl Clock for FixedClock {
        fn unix_time_ms(&self) -> Result<i64, HostInviteError> {
            Ok(1_700_000_000_123)
        }
    }

    #[derive(Clone)]
    struct FailingEntropy;

    #[derive(Debug, thiserror::Error)]
    #[error("entropy unavailable")]
    struct EntropyUnavailable;

    impl EntropySource for FailingEntropy {
        type Error = EntropyUnavailable;

        fn fill(&self, _destination: &mut [u8]) -> Result<(), Self::Error> {
            Err(EntropyUnavailable)
        }
    }

    #[derive(Clone, Copy)]
    struct FailingClock;

    impl Clock for FailingClock {
        fn unix_time_ms(&self) -> Result<i64, HostInviteError> {
            Err(HostInviteError::Clock)
        }
    }

    #[derive(Clone, Default)]
    struct Sessions {
        calls: Arc<AtomicUsize>,
    }

    impl SessionUserResolver for Sessions {
        async fn resolve_session_user(
            &self,
            bearer_token: String,
        ) -> Result<Option<String>, PersistenceFailure> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            Ok((bearer_token == "session-ok").then(|| "user-1".to_owned()))
        }
    }

    fn test_router(store: CountingStore, sessions: Sessions) -> Router {
        test_router_with_spec(store, sessions, None)
    }

    fn test_router_with_spec(
        store: CountingStore,
        sessions: Sessions,
        daemon_npm_spec: Option<String>,
    ) -> Router {
        router(
            CreateHostInvite::new(store, FixedEntropy::sequence(), FixedClock),
            sessions,
            daemon_npm_spec,
        )
    }

    fn parity_fixture() -> serde_json::Value {
        serde_json::from_str(include_str!("fixtures/create_host_invite_parity.json")).unwrap()
    }

    fn normalize_success(mut body: serde_json::Value) -> serde_json::Value {
        body["host_id"] = serde_json::json!("<host_id>");
        body["host"]["id"] = serde_json::json!("<host_id>");
        body["host"]["name"] = serde_json::json!("<host_name>");
        body["host"]["created_at"] = serde_json::json!(0);
        body["host"]["creator_user_id"] = serde_json::json!("<user_id>");
        body["connect_token"] = serde_json::json!("<connect_token>");
        body
    }

    async fn response(
        app: Router,
        authorization: Option<&str>,
        body: &'static str,
    ) -> (StatusCode, String) {
        let mut request = Request::post(HOSTS_PATH)
            .header("content-type", "application/json")
            .body(Body::from(body))
            .unwrap();
        if let Some(authorization) = authorization {
            request.headers_mut().insert(
                axum::http::header::AUTHORIZATION,
                authorization.parse().unwrap(),
            );
        }
        let response = app.oneshot(request).await.unwrap();
        let status = response.status();
        let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        (status, String::from_utf8(body.to_vec()).unwrap())
    }

    #[tokio::test]
    async fn projects_the_exact_create_host_response_bytes() {
        let store = CountingStore::default();
        let sessions = Sessions::default();
        let (status, body) = response(
            test_router(store.clone(), sessions),
            Some("Bearer session-ok"),
            "{}",
        )
        .await;

        assert_eq!(status, StatusCode::OK);
        assert_eq!(
            body,
            concat!(
                "{\"host_id\":\"AAECAwQFBgcICQoL\",\"host\":{",
                "\"id\":\"AAECAwQFBgcICQoL\",",
                "\"name\":\"computer-0c0d0e0f\",\"kind\":\"remote\",",
                "\"created_at\":1700000000123,\"revoked_at\":null,\"last_seen_at\":null,",
                "\"activated_at\":null,\"finalized_at\":null,\"connected_host_name\":null,",
                "\"provisioning_source\":\"user_invite\",\"status\":\"pending\",",
                "\"placeable\":false,\"creator_user_id\":\"user-1\",\"display_label\":null},",
                "\"connect_token\":\"HB0eHyAhIiMkJSYnKCkqKywtLi8wMTIzNDU2Nzg5Ojs\",",
                "\"daemon_npm_spec\":\"@silverhand-ai/daemon@latest\"}"
            )
        );
        assert_eq!(store.calls.load(Ordering::SeqCst), 1);
        assert_eq!(
            normalize_success(serde_json::from_str(&body).unwrap()),
            parity_fixture()["success"]["body"]
        );
    }

    #[tokio::test]
    async fn missing_and_invalid_sessions_match_the_ts_contract_before_the_uow() {
        for authorization in [None, Some("Bearer invalid")] {
            let store = CountingStore::default();
            let sessions = Sessions::default();
            let (status, body) =
                response(test_router(store.clone(), sessions), authorization, "{}").await;
            assert_eq!(status, StatusCode::UNAUTHORIZED);
            assert_eq!(body, "{\"error\":\"unauthorized\"}");
            assert_eq!(
                serde_json::from_str::<serde_json::Value>(&body).unwrap(),
                parity_fixture()[if authorization.is_none() {
                    "missing_session"
                } else {
                    "invalid_session"
                }]["body"]
            );
            assert_eq!(store.calls.load(Ordering::SeqCst), 0);
        }
    }

    #[tokio::test]
    async fn strict_unknown_fields_preserve_zod_input_order_before_the_uow() {
        let store = CountingStore::default();
        let sessions = Sessions::default();
        let (status, body) = response(
            test_router(store.clone(), sessions),
            Some("Bearer session-ok"),
            "{\"zeta\":true,\"alpha\":true}",
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(
            body,
            "{\"error\":\"invalid input\",\"issues\":[{\"code\":\"unrecognized_keys\",\"keys\":[\"zeta\",\"alpha\"],\"path\":[],\"message\":\"Unrecognized key(s) in object: 'zeta', 'alpha'\"}]}"
        );
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&body).unwrap(),
            parity_fixture()["unknown_field"]["body"]
        );
        assert_eq!(store.calls.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn malformed_json_keeps_the_ts_empty_object_fallback() {
        let store = CountingStore::default();
        let sessions = Sessions::default();
        let (status, _) = response(
            test_router(store.clone(), sessions),
            Some("Bearer session-ok"),
            "not-json",
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(store.calls.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn trims_a_configured_daemon_package_spec() {
        let store = CountingStore::default();
        let sessions = Sessions::default();
        let (status, body) = response(
            test_router_with_spec(
                store,
                sessions,
                Some("  file:/repo/packages/silverhand-daemon  ".into()),
            ),
            Some("Bearer session-ok"),
            "{}",
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&body).unwrap()["daemon_npm_spec"],
            "file:/repo/packages/silverhand-daemon"
        );
    }

    #[tokio::test]
    async fn one_duplicate_name_retries_then_returns_success() {
        let store = CountingStore::with_behavior(StoreBehavior::DuplicateOnce);
        let app = test_router(store.clone(), Sessions::default());
        let (status, _) = response(app, Some("Bearer session-ok"), "{}").await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(store.calls.load(Ordering::SeqCst), 2);
    }

    #[tokio::test(flavor = "current_thread")]
    async fn entropy_failure_is_one_safe_boundary_refusal_before_the_uow() {
        let store = CountingStore::default();
        let app = router(
            CreateHostInvite::new(store.clone(), FailingEntropy, FixedClock),
            Sessions::default(),
            None,
        );
        assert_safe_failure(app, &store, 0, "entropy unavailable").await;
    }

    #[tokio::test(flavor = "current_thread")]
    async fn clock_failure_is_one_safe_boundary_refusal_before_the_uow() {
        let store = CountingStore::default();
        let app = router(
            CreateHostInvite::new(store.clone(), FixedEntropy::sequence(), FailingClock),
            Sessions::default(),
            None,
        );
        assert_safe_failure(
            app,
            &store,
            0,
            "system time is outside the supported Unix-millisecond range",
        )
        .await;
    }

    #[tokio::test(flavor = "current_thread")]
    async fn name_exhaustion_is_one_safe_boundary_refusal_after_eight_attempts() {
        let store = CountingStore::with_behavior(StoreBehavior::AlwaysDuplicate);
        let app = test_router(store.clone(), Sessions::default());
        assert_safe_failure(app, &store, 8, "unable to allocate a unique host name").await;
    }

    async fn assert_safe_failure(
        app: Router,
        store: &CountingStore,
        expected_calls: usize,
        expected_chain: &str,
    ) {
        let logs = LogBuffer::default();
        let subscriber = tracing_subscriber::fmt()
            .json()
            .without_time()
            .with_target(false)
            .with_writer(logs.clone())
            .finish();
        let _guard = tracing::subscriber::set_default(subscriber);
        let (status, body) = response(app, Some("Bearer session-ok"), "{}").await;
        assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR);
        assert_eq!(body, "Internal Server Error");
        assert_eq!(store.calls.load(Ordering::SeqCst), expected_calls);

        let errors = logs
            .events()
            .into_iter()
            .filter(|event| event["level"] == "ERROR")
            .collect::<Vec<_>>();
        assert_eq!(errors.len(), 1);
        let chain = errors[0]["fields"]["error_chain"].as_str().unwrap();
        assert!(chain.contains(expected_chain));
        assert!(!chain.contains("HB0eHyAhIiMkJSYnKCkqKywtLi8wMTIzNDU2Nzg5Ojs"));
    }

    #[derive(Clone, Default)]
    struct LogBuffer(Arc<Mutex<Vec<u8>>>);

    impl LogBuffer {
        fn events(&self) -> Vec<serde_json::Value> {
            let bytes = self.0.lock().unwrap().clone();
            String::from_utf8(bytes)
                .unwrap()
                .lines()
                .map(|line| serde_json::from_str(line).unwrap())
                .collect()
        }
    }

    struct LogWriter(LogBuffer);

    impl Write for LogWriter {
        fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
            self.0.0.lock().unwrap().extend_from_slice(bytes);
            Ok(bytes.len())
        }

        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }

    impl<'a> MakeWriter<'a> for LogBuffer {
        type Writer = LogWriter;

        fn make_writer(&'a self) -> Self::Writer {
            LogWriter(self.clone())
        }
    }
}
