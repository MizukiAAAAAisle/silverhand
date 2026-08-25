//! Authenticated HTTP adapter for `POST /api/attention/observe`.

use axum::{
    Json, Router,
    body::to_bytes,
    extract::{Extension, Request, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::post,
};
use serde_json::{Map, Value, json};
use silverhand_backend_core::{
    identity::{ConversationId, UserId},
    messaging::{
        MessageSeq, NotificationId, ThreadRootId,
        collaboration::activity::observe::{
            ObservationAftermath, ObservationPort, ObserveBatch, ObserveRefusal, ObserveSource,
            ObservedSeq, StreamPosition, observe,
        },
    },
};
use std::sync::Arc;

pub const OBSERVE_PATH: &str = "/api/attention/observe";

struct Inner<P, A> {
    port: P,
    aftermath: A,
}
struct ObserveState<P, A>(Arc<Inner<P, A>>);
impl<P, A> Clone for ObserveState<P, A> {
    fn clone(&self) -> Self {
        Self(Arc::clone(&self.0))
    }
}

pub fn router<P, A>(port: P, aftermath: A) -> Router
where
    P: ObservationPort + Send + Sync + 'static,
    A: ObservationAftermath + Send + Sync + 'static,
{
    Router::new()
        .route(OBSERVE_PATH, post(observe_route::<P, A>))
        .with_state(ObserveState(Arc::new(Inner { port, aftermath })))
}

async fn observe_route<P: ObservationPort, A: ObservationAftermath>(
    State(state): State<ObserveState<P, A>>,
    principal: Option<Extension<UserId>>,
    request: Request,
) -> Response {
    let Some(Extension(viewer)) = principal else {
        tracing::error!("Activity observe route reached without its human principal fact");
        return internal();
    };
    let value = read_json(request).await;
    let batch = match parse_batch(&value) {
        Ok(batch) => batch,
        Err(issues) => return invalid(issues),
    };
    drop(value);
    match observe(&state.0.port, &state.0.aftermath, viewer, batch).await {
        Ok(Ok(done)) => {
            if let Some(error) = done.first_failure() {
                tracing::error!(error_chain=%crate::error::describe(error),"Activity observe effect failed");
            }
            Json(json!({"changed":done.committed().changed_anything()})).into_response()
        }
        Ok(Err(refusal)) => refusal_response(refusal),
        Err(error) => {
            tracing::error!(error_chain=%crate::error::describe(&error),"Activity observe failed");
            internal()
        }
    }
}

async fn read_json(request: Request) -> Value {
    match to_bytes(request.into_body(), usize::MAX)
        .await
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
    {
        Some(value) => value,
        None => json!({}),
    }
}

fn parse_batch(value: &Value) -> Result<ObserveBatch, Vec<Value>> {
    let object = root_object(value)?;
    let Some(sources) = object.get("sources") else {
        return Err(vec![type_issue(
            "array",
            "undefined",
            vec![json!("sources")],
        )]);
    };
    let Some(sources) = sources.as_array() else {
        return Err(vec![type_issue(
            "array",
            received(sources),
            vec![json!("sources")],
        )]);
    };
    if sources.is_empty() {
        return Err(vec![json!({
            "code":"too_small","minimum":1,"type":"array","inclusive":true,"exact":false,
            "message":"Array must contain at least 1 element(s)","path":["sources"]
        })]);
    }
    if sources.len() > 1_000 {
        return Err(vec![json!({
            "code":"too_big","maximum":1000,"type":"array","inclusive":true,"exact":false,
            "message":"Array must contain at most 1000 element(s)","path":["sources"]
        })]);
    }
    let mut parsed = Vec::with_capacity(sources.len());
    let mut issues = Vec::new();
    for (index, source) in sources.iter().enumerate() {
        match parse_source(source, index) {
            Ok(source) => parsed.push(source),
            Err(mut source_issues) => issues.append(&mut source_issues),
        }
    }
    if !issues.is_empty() {
        return Err(issues);
    }
    ObserveBatch::new(parsed).map_err(|_| unreachable!())
}

fn parse_source(value: &Value, index: usize) -> Result<ObserveSource, Vec<Value>> {
    let path = |field: &str| vec![json!("sources"), json!(index), json!(field)];
    let object = match value.as_object() {
        Some(object) => object,
        None => {
            return Err(vec![type_issue(
                "object",
                received(value),
                vec![json!("sources"), json!(index)],
            )]);
        }
    };
    match object.get("kind").and_then(Value::as_str) {
        Some("notification") => {
            let notification = required_nonempty_string(object, "notification_id", path)?;
            Ok(ObserveSource::Notification(
                NotificationId::parse(notification).unwrap(),
            ))
        }
        Some("stream") => {
            let conversation = required_nonempty_string(object, "conversation_id", path)?;
            let thread_root = match object.get("thread_root_id") {
                Some(Value::Null) => None,
                Some(Value::String(value)) if !value.is_empty() => {
                    Some(ThreadRootId::parse(value.clone()).unwrap())
                }
                Some(Value::String(_)) => {
                    return Err(vec![string_min_issue(vec![
                        json!("sources"),
                        json!(index),
                        json!("thread_root_id"),
                    ])]);
                }
                Some(value) => {
                    return Err(vec![type_issue(
                        "string",
                        received(value),
                        vec![json!("sources"), json!(index), json!("thread_root_id")],
                    )]);
                }
                None => {
                    return Err(vec![type_issue(
                        "string",
                        "undefined",
                        vec![json!("sources"), json!(index), json!("thread_root_id")],
                    )]);
                }
            };
            let position = parse_position(object.get("position"), index)?;
            Ok(ObserveSource::Stream {
                conversation: ConversationId::parse(conversation).unwrap(),
                thread_root,
                position,
            })
        }
        received_kind => Err(vec![json!({
            "code":"invalid_union_discriminator","options":["stream","notification"],
            "path":["sources",index,"kind"],
            "message":format!("Invalid discriminator value. Expected 'stream' | 'notification'{}",
                received_kind.map_or(String::new(), |value| format!(", received '{value}'")))
        })]),
    }
}

fn parse_position(value: Option<&Value>, index: usize) -> Result<StreamPosition, Vec<Value>> {
    let base = vec![json!("sources"), json!(index), json!("position")];
    let Some(value) = value else {
        return Err(vec![type_issue("object", "undefined", base)]);
    };
    let Some(object) = value.as_object() else {
        return Err(vec![type_issue("object", received(value), base)]);
    };
    match object.get("kind").and_then(Value::as_str) {
        Some("stream_head") => Ok(StreamPosition::StreamHead),
        Some("at_seq") => {
            let mut path = base;
            path.push(json!("seq"));
            let Some(value) = object.get("seq") else {
                return Err(vec![type_issue("number", "undefined", path)]);
            };
            let Some(number) = value.as_f64() else {
                return Err(vec![type_issue("number", received(value), path)]);
            };
            if number.fract() != 0.0 {
                return Err(vec![type_issue("integer", "float", path)]);
            }
            if number < 0.0 {
                return Err(vec![
                    json!({"code":"too_small","minimum":0,"type":"number","inclusive":true,"exact":false,
                    "message":"Number must be greater than or equal to 0","path":path}),
                ]);
            }
            const I64_EXCLUSIVE_CEILING: f64 = 9_223_372_036_854_775_808.0;
            let seq = if number >= I64_EXCLUSIVE_CEILING {
                ObservedSeq::BeyondPersistedRange
            } else {
                ObservedSeq::Persisted(MessageSeq::try_from(number as i64).map_err(|_| {
                vec![json!({"code":"too_small","minimum":0,"type":"number","inclusive":true,"exact":false,
                    "message":"Number must be greater than or equal to 0","path":path})]
                })?)
            };
            Ok(StreamPosition::AtSeq(seq))
        }
        received_kind => {
            let mut path = base;
            path.push(json!("kind"));
            Err(vec![json!({
                "code":"invalid_union_discriminator","options":["at_seq","stream_head"],"path":path,
                "message":format!("Invalid discriminator value. Expected 'at_seq' | 'stream_head'{}",
                    received_kind.map_or(String::new(), |value| format!(", received '{value}'")))
            })])
        }
    }
}

fn required_nonempty_string(
    object: &Map<String, Value>,
    field: &str,
    path: impl Fn(&str) -> Vec<Value>,
) -> Result<String, Vec<Value>> {
    match object.get(field) {
        Some(Value::String(value)) if !value.is_empty() => Ok(value.clone()),
        Some(Value::String(_)) => Err(vec![string_min_issue(path(field))]),
        Some(value) => Err(vec![type_issue("string", received(value), path(field))]),
        None => Err(vec![type_issue("string", "undefined", path(field))]),
    }
}

fn string_min_issue(path: Vec<Value>) -> Value {
    json!({"code":"too_small","minimum":1,"type":"string","inclusive":true,"exact":false,
        "message":"String must contain at least 1 character(s)","path":path})
}

fn root_object(value: &Value) -> Result<&Map<String, Value>, Vec<Value>> {
    value
        .as_object()
        .ok_or_else(|| vec![type_issue("object", received(value), Vec::new())])
}

fn received(value: &Value) -> &'static str {
    match value {
        Value::Null => "null",
        Value::Bool(_) => "boolean",
        Value::Number(_) => "number",
        Value::String(_) => "string",
        Value::Array(_) => "array",
        Value::Object(_) => "object",
    }
}

fn type_issue(expected: &str, actual: &str, path: Vec<Value>) -> Value {
    let message = if actual == "undefined" {
        "Required".to_owned()
    } else {
        format!("Expected {expected}, received {actual}")
    };
    json!({"code":"invalid_type","expected":expected,"received":actual,"path":path,"message":message})
}

fn invalid(issues: Vec<Value>) -> Response {
    (
        StatusCode::BAD_REQUEST,
        Json(json!({"error":"invalid input","issues":issues})),
    )
        .into_response()
}

fn refusal_response(refusal: ObserveRefusal) -> Response {
    let (status, code, message) = match refusal {
        ObserveRefusal::ConversationNotFound => (
            StatusCode::NOT_FOUND,
            "conversation_not_found",
            "conversation not found",
        ),
        ObserveRefusal::Forbidden => (
            StatusCode::FORBIDDEN,
            "forbidden",
            "cannot observe this conversation",
        ),
        ObserveRefusal::ThreadRootNotFound => (
            StatusCode::NOT_FOUND,
            "thread_root_not_found",
            "thread root message not found in this channel",
        ),
        ObserveRefusal::ThreadRootIsReply => (
            StatusCode::BAD_REQUEST,
            "thread_root_is_reply",
            "thread_root_id must be a root message, not a reply",
        ),
        ObserveRefusal::PositionFuture => (
            StatusCode::BAD_REQUEST,
            "position_future",
            "position seq is beyond the current stream head",
        ),
    };
    (status, Json(json!({"error":message,"code":code}))).into_response()
}

fn internal() -> Response {
    (
        StatusCode::INTERNAL_SERVER_ERROR,
        Json(json!({"error":"internal error"})),
    )
        .into_response()
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{
        body::{Body, to_bytes},
        http::Request,
    };
    use silverhand_backend_core::messaging::collaboration::activity::observe::{
        CommittedObservation, ObservationEffectFailure, ObservedConversation,
    };
    use silverhand_backend_sqlite::messaging::MessagingStore;
    use sqlx::{Connection, Executor, Row, SqliteConnection, sqlite::SqliteConnectOptions};
    use std::{
        io::{self, Write},
        sync::Mutex,
    };
    use tower::ServiceExt;
    use tracing_subscriber::fmt::MakeWriter;

    #[derive(Clone, Default)]
    struct Effects(Arc<Mutex<Vec<&'static str>>>);
    impl ObservationAftermath for Effects {
        async fn conversation_changed(
            &self,
            _: &CommittedObservation,
            conversation: &ObservedConversation,
        ) -> Result<(), ObservationEffectFailure> {
            self.0
                .lock()
                .unwrap()
                .push(if conversation.workspace_id().is_some() {
                    "conversation"
                } else {
                    "pair"
                });
            Ok(())
        }
        async fn badge_changed(
            &self,
            _: &CommittedObservation,
            _: &silverhand_backend_core::identity::WorkspaceId,
        ) -> Result<(), ObservationEffectFailure> {
            self.0.lock().unwrap().push("badge");
            Ok(())
        }
        async fn notifications_dismissed(
            &self,
            _: &CommittedObservation,
        ) -> Result<(), ObservationEffectFailure> {
            self.0.lock().unwrap().push("dismiss");
            Ok(())
        }
    }

    #[derive(Debug, thiserror::Error)]
    #[error("first aftermath cause")]
    struct FirstAftermathCause;

    #[derive(Debug, thiserror::Error)]
    #[error("later aftermath cause")]
    struct LaterAftermathCause;

    #[derive(Clone, Default)]
    struct FailingEffects(Arc<Mutex<Vec<&'static str>>>);

    impl ObservationAftermath for FailingEffects {
        async fn conversation_changed(
            &self,
            _: &CommittedObservation,
            _: &ObservedConversation,
        ) -> Result<(), ObservationEffectFailure> {
            self.0.lock().unwrap().push("conversation");
            Err(ObservationEffectFailure::from_source(FirstAftermathCause))
        }

        async fn badge_changed(
            &self,
            _: &CommittedObservation,
            _: &silverhand_backend_core::identity::WorkspaceId,
        ) -> Result<(), ObservationEffectFailure> {
            self.0.lock().unwrap().push("badge");
            Err(ObservationEffectFailure::from_source(LaterAftermathCause))
        }

        async fn notifications_dismissed(
            &self,
            _: &CommittedObservation,
        ) -> Result<(), ObservationEffectFailure> {
            self.0.lock().unwrap().push("dismiss");
            Err(ObservationEffectFailure::from_source(LaterAftermathCause))
        }
    }

    #[derive(Clone, Default)]
    struct LogBuffer(Arc<Mutex<Vec<u8>>>);

    impl LogBuffer {
        fn events(&self) -> Vec<Value> {
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

    async fn fixture_store() -> (tempfile::TempDir, std::path::PathBuf, MessagingStore) {
        const SCHEMA: &str = include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../../packages/backend/tests/migration-baseline/schema-current.sql"
        ));
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("activity-observe-wire.sqlite");
        let options = SqliteConnectOptions::new()
            .filename(&path)
            .create_if_missing(true)
            .foreign_keys(true);
        let mut db = SqliteConnection::connect_with(&options).await.unwrap();
        db.execute(sqlx::raw_sql(SCHEMA)).await.unwrap();
        for sql in [
            "INSERT INTO users(id,name,display_name,created_at,updated_at) VALUES('local','local-observe','Local',1,1),('other','other-observe','Other',1,1)",
            "INSERT INTO workspaces(id,name,name_key,created_at,updated_at) VALUES('w','W','w-observe',1,1),('w2','Forbidden','forbidden-observe',1,1)",
            "INSERT INTO workspace_users(workspace_id,user_id,joined_at) VALUES('w','local',1)",
            "INSERT INTO conversations(id,workspace_id,placement_kind,roster_policy,title,title_key,status,created_at,updated_at,latest_message_seq) VALUES('c','w','workspace','open','C','c-observe','open',1,1,2)",
            "INSERT INTO conversations(id,workspace_id,placement_kind,roster_policy,title,title_key,status,created_at,updated_at,latest_message_seq) VALUES('forbidden','w2','workspace','fixed','Private','private-observe','open',1,1,0)",
            "INSERT INTO conversation_users(conversation_id,user_id,joined_at) VALUES('c','local',1)",
            "INSERT INTO messages(id,conversation_id,from_kind,from_user_id,content,seq,created_at,thread_root_id) VALUES('m1','c','user','other','one',1,1,NULL),('m2','c','user','other','two',2,2,NULL),('root','c','user','other','root',3,3,NULL),('reply','c','user','other','reply',4,4,'root')",
            "INSERT INTO conversation_stream_heads(conversation_id,thread_root_id,latest_seq) VALUES('c',NULL,2)",
            "INSERT INTO notifications(id,kind,user_id,workspace_id,conversation_id,message_id,payload,created_at) VALUES('n1','mention_self','local','w','c','m1','{}',1),('n2','mention_self','local','w','c','m2','{}',2)",
        ] {
            sqlx::query(sql).execute(&mut db).await.unwrap();
        }
        db.close().await.unwrap();
        let store = MessagingStore::open(&path).await.unwrap();
        (dir, path, store)
    }

    async fn call(app: Router, body: Value, authenticated: bool) -> (StatusCode, Value) {
        call_raw(app, serde_json::to_string(&body).unwrap(), authenticated).await
    }

    async fn call_raw(app: Router, body: String, authenticated: bool) -> (StatusCode, Value) {
        let mut request = Request::builder()
            .method("POST")
            .uri(OBSERVE_PATH)
            .header("content-type", "application/json")
            .body(Body::from(body))
            .unwrap();
        if authenticated {
            request
                .extensions_mut()
                .insert(UserId::parse("local").unwrap());
        }
        let response = app.oneshot(request).await.unwrap();
        let status = response.status();
        let body =
            serde_json::from_slice(&to_bytes(response.into_body(), usize::MAX).await.unwrap())
                .unwrap();
        (status, body)
    }

    #[tokio::test]
    async fn real_router_commits_once_then_reports_idempotent_and_postcommit_effects() {
        let (_dir, path, store) = fixture_store().await;
        let effects = Effects::default();
        let app = router(store.observation(), effects.clone());
        let body = json!({"sources":[
            {"kind":"stream","conversation_id":"c","thread_root_id":null,
             "position":{"kind":"at_seq","seq":1}},
            {"kind":"notification","notification_id":"n2"}
        ]});
        let first = call(app.clone(), body.clone(), true).await;
        assert_eq!(first, (StatusCode::OK, json!({"changed":true})));
        assert_eq!(*effects.0.lock().unwrap(), ["conversation", "dismiss"]);

        effects.0.lock().unwrap().clear();
        let second = call(app, body, true).await;
        assert_eq!(second, (StatusCode::OK, json!({"changed":false})));
        assert!(effects.0.lock().unwrap().is_empty());

        let mut db = SqliteConnection::connect(&format!("sqlite:{}", path.display()))
            .await
            .unwrap();
        let cursor: i64 = sqlx::query_scalar("SELECT last_read_seq FROM conversation_reads WHERE user_id='local' AND conversation_id='c' AND thread_root_id IS NULL")
            .fetch_one(&mut db).await.unwrap();
        assert_eq!(cursor, 1);
        assert!(
            sqlx::query("SELECT read_at FROM notifications WHERE id='n1'")
                .fetch_one(&mut db)
                .await
                .unwrap()
                .get::<Option<i64>, _>("read_at")
                .is_some()
        );
    }

    #[tokio::test(flavor = "current_thread")]
    async fn aftermath_failures_preserve_commit_and_report_only_the_first_cause() {
        let (_dir, path, store) = fixture_store().await;
        let effects = FailingEffects::default();
        let app = router(store.observation(), effects.clone());
        let logs = LogBuffer::default();
        let subscriber = tracing_subscriber::fmt()
            .json()
            .with_max_level(tracing::Level::ERROR)
            .with_writer(logs.clone())
            .finish();
        let _guard = tracing::subscriber::set_default(subscriber);

        let (status, body) = call(
            app,
            json!({"sources":[
                {"kind":"stream","conversation_id":"c","thread_root_id":null,
                 "position":{"kind":"at_seq","seq":1}},
                {"kind":"notification","notification_id":"n2"}
            ]}),
            true,
        )
        .await;
        assert_eq!((status, &body), (StatusCode::OK, &json!({"changed":true})));
        assert_eq!(*effects.0.lock().unwrap(), ["conversation", "dismiss"]);
        assert!(!body.to_string().contains("aftermath cause"));

        let mut db = SqliteConnection::connect(&format!("sqlite:{}", path.display()))
            .await
            .unwrap();
        let cursor: i64 = sqlx::query_scalar("SELECT last_read_seq FROM conversation_reads WHERE user_id='local' AND conversation_id='c' AND thread_root_id IS NULL")
            .fetch_one(&mut db).await.unwrap();
        assert_eq!(cursor, 1);
        let read_at: Option<i64> =
            sqlx::query_scalar("SELECT read_at FROM notifications WHERE id='n2'")
                .fetch_one(&mut db)
                .await
                .unwrap();
        assert!(read_at.is_some());

        let errors = logs.events();
        assert_eq!(errors.len(), 1);
        assert_eq!(
            errors[0]["fields"]["message"],
            "Activity observe effect failed"
        );
        let chain = errors[0]["fields"]["error_chain"].as_str().unwrap();
        assert!(chain.contains("a committed observation effect failed"));
        assert!(chain.contains("first aftermath cause"));
        assert!(!chain.contains("later aftermath cause"));
    }

    #[tokio::test]
    async fn auth_and_wire_refusals_precede_product_writes() {
        let (_dir, path, store) = fixture_store().await;
        let app = router(store.observation(), Effects::default());
        let missing = call(app.clone(), json!({"sources":[]}), false).await;
        assert_eq!(missing.0, StatusCode::INTERNAL_SERVER_ERROR);

        let invalid = call(app.clone(), json!({"sources":[]}), true).await;
        assert_eq!(invalid.0, StatusCode::BAD_REQUEST);
        assert_eq!(invalid.1["error"], "invalid input");

        let future = call(
            app,
            json!({"sources":[{
                "kind":"stream","conversation_id":"c","thread_root_id":null,
                "position":{"kind":"at_seq","seq":3}
            }]}),
            true,
        )
        .await;
        assert_eq!(
            future,
            (
                StatusCode::BAD_REQUEST,
                json!({
                    "error":"position seq is beyond the current stream head","code":"position_future"
                })
            )
        );
        let mut db = SqliteConnection::connect(&format!("sqlite:{}", path.display()))
            .await
            .unwrap();
        let count: i64 = sqlx::query_scalar("SELECT count(*) FROM conversation_reads")
            .fetch_one(&mut db)
            .await
            .unwrap();
        assert_eq!(count, 0);
    }

    #[tokio::test]
    async fn production_router_consumes_the_ts_signed_observe_wire() {
        let fixture: Value = serde_json::from_str(include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../../packages/backend/tests/fixtures/activity-observe-wire.json"
        )))
        .unwrap();
        for case in fixture.as_array().unwrap() {
            let (_dir, _path, store) = fixture_store().await;
            let app = router(store.observation(), Effects::default());
            let raw = case["request_json"]
                .as_str()
                .map(str::to_owned)
                .unwrap_or_else(|| serde_json::to_string(&case["request"]).unwrap());
            let (status, body) = call_raw(app, raw, true).await;
            assert_eq!(
                status.as_u16(),
                case["status"].as_u64().unwrap() as u16,
                "{}",
                case["name"]
            );
            assert_eq!(body, case["body"], "{}", case["name"]);
        }
        assert_eq!(fixture.as_array().unwrap().len(), 16);
    }
}
