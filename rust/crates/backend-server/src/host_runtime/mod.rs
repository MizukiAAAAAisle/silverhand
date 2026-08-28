use std::{collections::HashSet, sync::Arc};

use axum::{
    Json, Router,
    body::Bytes,
    extract::{Extension, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::post,
};
use serde::{
    Deserialize, Deserializer, Serialize,
    de::{IgnoredAny, MapAccess, SeqAccess, Visitor},
};
use silverhand_backend_core::{
    host_runtime::{
        environment::{Clock, EntropySource},
        invite::{CreateHostInvite, HostInviteError, HostInviteUnitOfWork},
    },
    identity::UserId,
    persistence::PersistenceFailure,
};

use crate::error;

pub mod cascade_effects;
pub mod claim;
pub mod delete;
pub mod detail;
pub(crate) mod host_wire;
pub mod list;
pub mod resolve;
pub mod revoke;
pub mod rotate_connect_token;
pub mod rotate_token;

use host_wire::HostDto;

pub const HOSTS_PATH: &str = "/api/hosts";
pub const DEFAULT_DAEMON_NPM_SPEC: &str = "@silverhand-ai/daemon@latest";

struct StateInner<U, R, C> {
    create_host_invite: CreateHostInvite<U, R, C>,
    daemon_npm_spec: String,
}

struct HostRuntimeState<U, R, C>(Arc<StateInner<U, R, C>>);

impl<U, R, C> Clone for HostRuntimeState<U, R, C> {
    fn clone(&self) -> Self {
        Self(Arc::clone(&self.0))
    }
}

pub fn router<U, R, C>(
    create_host_invite: CreateHostInvite<U, R, C>,
    daemon_npm_spec: Option<String>,
) -> Router
where
    U: HostInviteUnitOfWork,
    R: EntropySource + 'static,
    C: Clock + 'static,
{
    let daemon_npm_spec = resolve_daemon_npm_spec(daemon_npm_spec);
    let state = HostRuntimeState(Arc::new(StateInner {
        create_host_invite,
        daemon_npm_spec,
    }));
    Router::new()
        .route(HOSTS_PATH, post(create_host::<U, R, C>))
        .with_state(state)
}

/// Resolve the daemon package spec the connect-command card shows: a configured value,
/// trimmed, or the default when it is absent or blank. Pinned to `daemonNpmSpec()` in
/// `packages/backend/src/routes/hosts.ts`, and shared by the create-invite response and
/// the connect-token rotation response so the two can never show a different spec.
pub(super) fn resolve_daemon_npm_spec(configured: Option<String>) -> String {
    configured
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| DEFAULT_DAEMON_NPM_SPEC.to_owned())
}

async fn create_host<U, R, C>(
    State(state): State<HostRuntimeState<U, R, C>>,
    principal: Option<Extension<UserId>>,
    body: Bytes,
) -> Response
where
    U: HostInviteUnitOfWork,
    R: EntropySource + 'static,
    C: Clock + 'static,
{
    let Some(Extension(user_id)) = principal else {
        tracing::error!("host invite route reached without its human principal fact");
        return (StatusCode::INTERNAL_SERVER_ERROR, "Internal Server Error").into_response();
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

pub(super) fn unrecognized_keys_message(keys: &[String]) -> String {
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
        let mut seen = HashSet::new();
        while let Some(key) = map.next_key::<String>()? {
            if seen.insert(key.clone()) {
                keys.push(key);
            }
            map.next_value::<IgnoredAny>()?;
        }
        Ok(TopLevelJson::Object(js_object_keys(keys)))
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

pub(super) fn js_object_keys(keys: Vec<String>) -> Vec<String> {
    let mut indexes = Vec::new();
    let mut named = Vec::new();
    for key in keys {
        match js_array_index(&key) {
            Some(index) => indexes.push((index, key)),
            None => named.push(key),
        }
    }
    indexes.sort_unstable_by_key(|(index, _)| *index);
    indexes
        .into_iter()
        .map(|(_, key)| key)
        .chain(named)
        .collect()
}

fn js_array_index(key: &str) -> Option<u32> {
    if key != "0" && key.starts_with('0') {
        return None;
    }
    let index = key.parse::<u32>().ok()?;
    (index != u32::MAX && index.to_string() == key).then_some(index)
}

pub(super) fn invalid_input(issues: Vec<ZodIssue>) -> Response {
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
struct InvalidInputResponse {
    error: &'static str,
    issues: Vec<ZodIssue>,
}

#[derive(Serialize)]
#[serde(untagged)]
pub(super) enum ZodIssue {
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
    InvalidString {
        validation: &'static str,
        code: &'static str,
        message: &'static str,
        path: Vec<String>,
    },
    TooSmall {
        code: &'static str,
        minimum: i64,
        #[serde(rename = "type")]
        value_type: &'static str,
        inclusive: bool,
        exact: bool,
        message: &'static str,
        path: Vec<String>,
    },
    TooBig {
        code: &'static str,
        maximum: i64,
        #[serde(rename = "type")]
        value_type: &'static str,
        inclusive: bool,
        exact: bool,
        message: &'static str,
        path: Vec<String>,
    },
}

/// The anti-enumeration refusal shared by every host route that names a computer: an
/// absent computer and one the requester does not own collapse to the same `404`, so
/// no surface becomes an existence oracle for computer ids. Pinned to the TypeScript
/// handlers (`{ error: 'host not found', error_code: 'host_not_found' }`), so a drift
/// shows here rather than route by route.
pub(super) const HOST_NOT_FOUND: &str = "host not found";
pub(super) const HOST_NOT_FOUND_CODE: &str = "host_not_found";

/// The unmapped-failure body: these routes register no error handler, so an
/// unexpected failure falls to the framework default — a plain-text `500`, never a
/// JSON envelope.
pub(super) const INTERNAL_ERROR_BODY: &str = "Internal Server Error";

/// A refusal that carries a machine-readable `error_code` beside its message. Shared
/// by the host routes whose refusals the renderer branches on.
#[derive(Serialize)]
pub(super) struct ErrorBody {
    pub error: &'static str,
    pub error_code: &'static str,
}

pub(super) fn host_not_found() -> Response {
    (
        StatusCode::NOT_FOUND,
        Json(ErrorBody {
            error: HOST_NOT_FOUND,
            error_code: HOST_NOT_FOUND_CODE,
        }),
    )
        .into_response()
}

pub(super) fn internal_error() -> Response {
    (StatusCode::INTERNAL_SERVER_ERROR, INTERNAL_ERROR_BODY).into_response()
}

#[derive(Serialize)]
struct HostCreateResponse {
    host_id: String,
    host: HostDto,
    connect_token: String,
    daemon_npm_spec: String,
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
        custody::NewLongLivedCredential,
        invite::{HostInviteWriteError, NewUserInviteHost},
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
        type Error = Infallible;

        fn unix_time_ms(&self) -> Result<i64, Self::Error> {
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

    #[derive(Debug, thiserror::Error)]
    #[error("clock unavailable")]
    struct ClockUnavailable;

    impl Clock for FailingClock {
        type Error = ClockUnavailable;

        fn unix_time_ms(&self) -> Result<i64, Self::Error> {
            Err(ClockUnavailable)
        }
    }

    fn test_router(store: CountingStore) -> Router {
        test_router_with_spec(store, None)
    }

    fn test_router_with_spec(store: CountingStore, daemon_npm_spec: Option<String>) -> Router {
        router(
            CreateHostInvite::new(store, FixedEntropy::sequence(), FixedClock),
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

    fn user() -> UserId {
        UserId::parse("user-1").unwrap()
    }

    async fn response(app: Router, principal: Option<UserId>, body: &str) -> (StatusCode, String) {
        let mut request = Request::post(HOSTS_PATH)
            .header("content-type", "application/json")
            .body(Body::from(body.to_owned()))
            .unwrap();
        if let Some(principal) = principal {
            request.extensions_mut().insert(principal);
        }
        let response = app.oneshot(request).await.unwrap();
        let status = response.status();
        let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        (status, String::from_utf8(body.to_vec()).unwrap())
    }

    #[tokio::test]
    async fn projects_the_create_host_response_with_json_semantic_parity() {
        let store = CountingStore::default();
        let (status, body) = response(test_router(store.clone()), Some(user()), "{}").await;

        assert_eq!(status, StatusCode::OK);
        let response: serde_json::Value = serde_json::from_str(&body).unwrap();
        assert_eq!(response["host_id"], "AAECAwQFBgcICQoL");
        assert_eq!(response["host"]["name"], "computer-0c0d0e0f");
        assert_eq!(response["host"]["created_at"], 1_700_000_000_123_i64);
        assert_eq!(
            response["connect_token"],
            "HB0eHyAhIiMkJSYnKCkqKywtLi8wMTIzNDU2Nzg5Ojs"
        );
        assert_eq!(store.calls.load(Ordering::SeqCst), 1);
        assert_eq!(
            normalize_success(response),
            parity_fixture()["success"]["body"]
        );
    }

    #[tokio::test]
    async fn a_missing_principal_fails_closed_before_the_uow() {
        let store = CountingStore::default();
        let (status, body) = response(test_router(store.clone()), None, "{}").await;
        assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR);
        assert_eq!(body, "Internal Server Error");
        assert_eq!(store.calls.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn strict_unknown_fields_preserve_zod_input_order_before_the_uow() {
        let store = CountingStore::default();
        let (status, body) = response(
            test_router(store.clone()),
            Some(user()),
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
    async fn raw_unknown_fields_match_json_parse_and_object_keys_semantics() {
        for entry in parity_fixture()["raw_unknown_fields"].as_array().unwrap() {
            let store = CountingStore::default();
            let raw_body = entry["raw_body"].as_str().unwrap();
            let (status, body) = response(test_router(store.clone()), Some(user()), raw_body).await;
            assert_eq!(status.as_u16(), entry["status"].as_u64().unwrap() as u16);
            assert_eq!(
                serde_json::from_str::<serde_json::Value>(&body).unwrap(),
                entry["body"]
            );
            assert_eq!(store.calls.load(Ordering::SeqCst), 0);
        }
    }

    #[tokio::test]
    async fn non_object_shapes_match_zod_before_the_uow() {
        for entry in parity_fixture()["invalid_shapes"].as_array().unwrap() {
            let store = CountingStore::default();
            let raw_body = serde_json::to_string(&entry["request"]).unwrap();
            let (status, body) =
                response(test_router(store.clone()), Some(user()), &raw_body).await;
            assert_eq!(status.as_u16(), entry["status"].as_u64().unwrap() as u16);
            assert_eq!(
                serde_json::from_str::<serde_json::Value>(&body).unwrap(),
                entry["body"]
            );
            assert_eq!(store.calls.load(Ordering::SeqCst), 0);
        }
    }

    #[tokio::test]
    async fn malformed_json_keeps_the_ts_empty_object_fallback() {
        let store = CountingStore::default();
        let (status, _) = response(test_router(store.clone()), Some(user()), "not-json").await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(store.calls.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn trims_a_configured_daemon_package_spec() {
        let store = CountingStore::default();
        let (status, body) = response(
            test_router_with_spec(
                store,
                Some("  file:/repo/packages/silverhand-daemon  ".into()),
            ),
            Some(user()),
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
        let app = test_router(store.clone());
        let (status, _) = response(app, Some(user()), "{}").await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(store.calls.load(Ordering::SeqCst), 2);
    }

    #[tokio::test(flavor = "current_thread")]
    async fn entropy_failure_is_one_safe_boundary_refusal_before_the_uow() {
        let store = CountingStore::default();
        let app = router(
            CreateHostInvite::new(store.clone(), FailingEntropy, FixedClock),
            None,
        );
        assert_safe_failure(app, &store, 0, "entropy unavailable").await;
    }

    #[tokio::test(flavor = "current_thread")]
    async fn clock_failure_is_one_safe_boundary_refusal_before_the_uow() {
        let store = CountingStore::default();
        let app = router(
            CreateHostInvite::new(store.clone(), FixedEntropy::sequence(), FailingClock),
            None,
        );
        assert_safe_failure(app, &store, 0, "clock unavailable").await;
    }

    #[tokio::test(flavor = "current_thread")]
    async fn name_exhaustion_is_one_safe_boundary_refusal_after_eight_attempts() {
        let store = CountingStore::with_behavior(StoreBehavior::AlwaysDuplicate);
        let app = test_router(store.clone());
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
        let (status, body) = response(app, Some(user()), "{}").await;
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
