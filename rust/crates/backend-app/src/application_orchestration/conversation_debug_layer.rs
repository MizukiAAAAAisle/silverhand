//! The one production JSON log sink and its effective-level decision.
//!
//! Conversation debug windows extend the global filter; they never install a
//! second writer. The formatter also applies the same recursive forbidden-field
//! policy to explicit content/credential fields. Formatting is not a reason to
//! discard diagnostics: tracing messages, Display errors and Debug context survive.

use std::{collections::BTreeMap, fmt};

use serde_json::{Map, Value};
use silverhand_backend_core::foundation::identity::ConversationId;
use silverhand_backend_server::conversation_messaging::messaging::collaboration::conversation_log_debug::{
    ConversationLogDebugClock, ProductionConversationLogDebugControl,
};
use tracing::{Event, Metadata, Subscriber, field::Visit, span};
use tracing_subscriber::{
    EnvFilter, Layer,
    field::RecordFields,
    fmt::{
        FmtContext, FormattedFields, MakeWriter,
        format::{FormatEvent, FormatFields, Writer},
        time::{FormatTime, SystemTime},
        writer::BoxMakeWriter,
    },
    layer::{Context, Filter},
    registry::{LookupSpan, Registry},
};

const FORBIDDEN_FIELDS: &[&str] = &[
    "payload",
    "chunk",
    "body",
    "text",
    "prompt",
    "line",
    "env",
    "stdout",
    "stderr",
    "soft_directive",
    "authorization",
    "cookie",
    "password",
    "token",
    "access_token",
    "refresh_token",
    "host_token",
    "api_key",
    "secret",
];

fn forbidden(key: &str) -> bool {
    let key = key.to_ascii_lowercase();
    FORBIDDEN_FIELDS.contains(&key.as_str()) || key.starts_with("env_")
}

fn sanitize(value: Value, redacted: &mut u64) -> Value {
    match value {
        Value::Object(values) => Value::Object(
            values
                .into_iter()
                .filter_map(|(key, value)| {
                    if forbidden(&key) {
                        *redacted += 1;
                        None
                    } else {
                        Some((key, sanitize(value, redacted)))
                    }
                })
                .collect(),
        ),
        Value::Array(values) => Value::Array(
            values
                .into_iter()
                .map(|value| sanitize(value, redacted))
                .collect(),
        ),
        scalar => scalar,
    }
}

#[derive(Default)]
struct JsonVisitor {
    values: BTreeMap<String, Value>,
    redacted: u64,
}

impl JsonVisitor {
    fn record_value(&mut self, field: &tracing::field::Field, value: Value) {
        if forbidden(field.name()) {
            self.redacted += 1;
            return;
        }
        let value = sanitize(value, &mut self.redacted);
        self.values.insert(field.name().to_owned(), value);
    }

    fn finish(mut self) -> Map<String, Value> {
        if self.redacted > 0 {
            self.values
                .insert("redactedFieldCount".to_owned(), Value::from(self.redacted));
        }
        self.values.into_iter().collect()
    }
}

impl Visit for JsonVisitor {
    fn record_bool(&mut self, field: &tracing::field::Field, value: bool) {
        self.record_value(field, Value::Bool(value));
    }

    fn record_i64(&mut self, field: &tracing::field::Field, value: i64) {
        self.record_value(field, Value::from(value));
    }

    fn record_u64(&mut self, field: &tracing::field::Field, value: u64) {
        self.record_value(field, Value::from(value));
    }

    fn record_f64(&mut self, field: &tracing::field::Field, value: f64) {
        self.record_value(field, Value::from(value));
    }

    fn record_str(&mut self, field: &tracing::field::Field, value: &str) {
        self.record_value(field, Value::String(value.to_owned()));
    }

    fn record_debug(&mut self, field: &tracing::field::Field, value: &dyn fmt::Debug) {
        // tracing routes formatted messages and %Display errors here too.
        // Dropping this carrier loses even dependency errors such as axum's
        // "accept error: {e}". Preserve text; structured JSON still receives
        // field-level filtering. Callers must not dump credentials into prose
        // or arbitrary Debug structs: those have no parseable field contract.
        let rendered = format!("{value:?}");
        let value = serde_json::from_str(&rendered).unwrap_or(Value::String(rendered));
        self.record_value(field, value);
    }
}

#[derive(Clone, Copy, Debug, Default)]
struct SanitizedJsonFields;

impl<'writer> FormatFields<'writer> for SanitizedJsonFields {
    fn format_fields<R: RecordFields>(
        &self,
        mut writer: Writer<'writer>,
        fields: R,
    ) -> fmt::Result {
        let mut visitor = JsonVisitor::default();
        fields.record(&mut visitor);
        write!(writer, "{}", Value::Object(visitor.finish()))
    }

    fn add_fields(
        &self,
        current: &'writer mut tracing_subscriber::fmt::FormattedFields<Self>,
        fields: &span::Record<'_>,
    ) -> fmt::Result {
        let mut values =
            serde_json::from_str::<Map<String, Value>>(current).map_err(|_| fmt::Error)?;
        let previous_redacted = values
            .remove("redactedFieldCount")
            .and_then(|value| value.as_u64())
            .unwrap_or(0);
        let mut visitor = JsonVisitor::default();
        fields.record(&mut visitor);
        let mut additions = visitor.finish();
        let added_redacted = additions
            .remove("redactedFieldCount")
            .and_then(|value| value.as_u64())
            .unwrap_or(0);
        values.extend(additions);
        if previous_redacted + added_redacted > 0 {
            values.insert(
                "redactedFieldCount".to_owned(),
                Value::from(previous_redacted + added_redacted),
            );
        }
        current.fields = Value::Object(values).to_string();
        Ok(())
    }
}

#[derive(Clone, Copy, Debug, Default)]
struct SanitizedJsonEvent;

impl<S, N> FormatEvent<S, N> for SanitizedJsonEvent
where
    S: Subscriber + for<'span> LookupSpan<'span>,
    N: for<'writer> FormatFields<'writer> + 'static,
{
    fn format_event(
        &self,
        context: &FmtContext<'_, S, N>,
        mut writer: Writer<'_>,
        event: &Event<'_>,
    ) -> fmt::Result {
        let mut visitor = JsonVisitor::default();
        event.record(&mut visitor);
        let mut timestamp = String::new();
        SystemTime.format_time(&mut Writer::new(&mut timestamp))?;

        let mut fields = visitor.finish();
        // Carry generated HTTP/CLI request identities, never arbitrary span
        // contents. Keep CLI identity intact for the existing invocation audit.
        if let Some(scope) = context.event_scope() {
            for span in scope.from_root() {
                if span.name() != "cli_request" && span.name() != "http_request" {
                    continue;
                }
                let extensions = span.extensions();
                if let Some(formatted) = extensions.get::<FormattedFields<N>>() {
                    if let Ok(values) = serde_json::from_str::<Value>(formatted.fields.as_str()) {
                        if let Some(id) = values["request_id"].as_str() {
                            let key = if span.name() == "http_request" {
                                "http_request_id"
                            } else {
                                "request_id"
                            };
                            fields.insert(key.to_owned(), Value::String(id.to_owned()));
                        }
                    }
                }
            }
        }
        let output = serde_json::json!({
            "timestamp": timestamp,
            "level": event.metadata().level().as_str(),
            "fields": fields,
            "target": event.metadata().target(),
        });
        writeln!(writer, "{output}")
    }
}

#[derive(Default)]
struct ConversationField(Option<String>);

impl Visit for ConversationField {
    fn record_str(&mut self, field: &tracing::field::Field, value: &str) {
        if field.name() == "conversation_id" {
            self.0 = Some(value.to_owned());
        }
    }

    fn record_debug(&mut self, field: &tracing::field::Field, value: &dyn fmt::Debug) {
        if field.name() == "conversation_id" {
            self.0 = Some(format!("{value:?}").trim_matches('"').to_owned());
        }
    }
}

#[derive(Clone)]
struct EffectiveLogFilter<K> {
    global: EnvFilter,
    control: ProductionConversationLogDebugControl,
    clock: K,
}

impl<S, K> Filter<S> for EffectiveLogFilter<K>
where
    S: Subscriber + for<'span> LookupSpan<'span>,
    K: ConversationLogDebugClock + Send + Sync + 'static,
{
    fn enabled(&self, metadata: &Metadata<'_>, context: &Context<'_, S>) -> bool {
        if metadata.target() == "silverhand::diagnostics" {
            return true;
        }
        if Filter::enabled(&self.global, metadata, context) {
            return true;
        }
        metadata.is_event() && *metadata.level() != tracing::Level::TRACE
    }

    fn event_enabled(&self, event: &Event<'_>, context: &Context<'_, S>) -> bool {
        if event.metadata().target() == "silverhand::diagnostics" {
            return true;
        }
        if Filter::enabled(&self.global, event.metadata(), context)
            && Filter::event_enabled(&self.global, event, context)
        {
            return true;
        }
        if *event.metadata().level() == tracing::Level::TRACE {
            return false;
        }
        let mut conversation = ConversationField::default();
        event.record(&mut conversation);
        let Some(raw) = conversation.0 else {
            return false;
        };
        let Ok(conversation) = ConversationId::parse(raw) else {
            return false;
        };
        let Ok(now) = self.clock.now_unix_ms() else {
            return false;
        };
        self.control.is_enabled_at(&conversation, now)
    }

    fn on_new_span(&self, attrs: &span::Attributes<'_>, id: &span::Id, context: Context<'_, S>) {
        Filter::on_new_span(&self.global, attrs, id, context);
    }

    fn on_record(&self, id: &span::Id, values: &span::Record<'_>, context: Context<'_, S>) {
        Filter::on_record(&self.global, id, values, context);
    }

    fn on_enter(&self, id: &span::Id, context: Context<'_, S>) {
        Filter::on_enter(&self.global, id, context);
    }

    fn on_exit(&self, id: &span::Id, context: Context<'_, S>) {
        Filter::on_exit(&self.global, id, context);
    }

    fn on_close(&self, id: span::Id, context: Context<'_, S>) {
        Filter::on_close(&self.global, id, context);
    }
}

pub fn production_json_layer<K, W>(
    global: EnvFilter,
    control: ProductionConversationLogDebugControl,
    clock: K,
    writer: W,
) -> impl Layer<Registry>
where
    K: ConversationLogDebugClock + Send + Sync + 'static,
    W: for<'writer> MakeWriter<'writer> + Clone + Send + Sync + 'static,
{
    crate::foundation::observability::diagnostics::DiagnosticTimings::default()
        .with_filter(tracing_subscriber::filter::filter_fn(|metadata| {
            metadata.target() == "silverhand::diagnostics"
        }))
        .and_then(
            tracing_subscriber::fmt::layer()
                .event_format(SanitizedJsonEvent)
                .fmt_fields(SanitizedJsonFields)
                .with_ansi(false)
                .with_writer(BoxMakeWriter::new(writer))
                .with_filter(EffectiveLogFilter {
                    global,
                    control,
                    clock,
                }),
        )
}

#[cfg(test)]
mod tests {
    use std::{
        convert::Infallible,
        io::Write,
        sync::{
            Arc, Mutex,
            atomic::{AtomicI64, Ordering},
        },
    };

    use silverhand_backend_server::{
        conversation_messaging::messaging::collaboration::conversation_log_debug::ConversationLogDebugControl,
        foundation::safe_log_field::safe_display,
    };
    use tracing_subscriber::{layer::SubscriberExt, registry};

    use super::*;

    #[derive(Clone)]
    struct Clock(Arc<AtomicI64>);

    impl ConversationLogDebugClock for Clock {
        type Error = Infallible;

        fn now_unix_ms(&self) -> Result<i64, Self::Error> {
            Ok(self.0.load(Ordering::SeqCst))
        }
    }

    #[derive(Clone, Default)]
    struct Buffer(Arc<Mutex<Vec<u8>>>);

    struct BufferWriter(Buffer);

    impl Write for BufferWriter {
        fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
            self.0.0.lock().unwrap().extend_from_slice(bytes);
            Ok(bytes.len())
        }

        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    impl<'writer> MakeWriter<'writer> for Buffer {
        type Writer = BufferWriter;

        fn make_writer(&'writer self) -> Self::Writer {
            BufferWriter(self.clone())
        }
    }

    fn lines(output: &Buffer) -> Vec<Value> {
        String::from_utf8(output.0.lock().unwrap().clone())
            .unwrap()
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect()
    }

    #[test]
    fn error_floor_preserves_only_cli_request_identity_from_spans() {
        let output = Buffer::default();
        let subscriber = registry().with(production_json_layer(
            EnvFilter::new("error"),
            ProductionConversationLogDebugControl::new(),
            Clock(Arc::new(AtomicI64::new(100))),
            output.clone(),
        ));
        tracing::subscriber::with_default(subscriber, || {
            let span = tracing::error_span!(
                "cli_request",
                request_id = "rust-1-46",
                title = "private title",
                query = "private query"
            );
            let _guard = span.enter();
            tracing::error!(
                stage = "task_decode",
                field = "tasks.title:non_canonical",
                "stored task violates domain contract"
            );
        });
        let events = lines(&output);
        assert_eq!(events.len(), 1);
        assert_eq!(events[0]["fields"]["request_id"], "rust-1-46");
        assert_eq!(events[0]["fields"]["field"], "tasks.title:non_canonical");
        assert!(!events[0].to_string().contains("private"));
    }

    #[tokio::test]
    async fn http_diagnostics_correlate_concurrent_requests_without_capturing_arguments() {
        use axum::{Router, body::Body, http::Request, routing::get};
        use http_body_util::BodyExt;
        use tower::ServiceExt;
        use tracing::Instrument;
        use tracing::instrument::WithSubscriber;
        let output = Buffer::default();
        let subscriber = registry().with(production_json_layer(
            EnvFilter::new("error"),
            ProductionConversationLogDebugControl::new(),
            Clock(Arc::new(AtomicI64::new(100))),
            output.clone(),
        ));
        let app = Router::new()
            .route("/first/{id}", get(|| async {
                async {
                    tokio::task::yield_now().await;
                    let cli = tracing::error_span!("cli_request", request_id = "rust-test-1");
                    let _entered = cli.enter();
                    tracing::error!(error = %std::io::Error::from_raw_os_error(24), "test cause");
                }.instrument(tracing::info_span!(target: "silverhand::diagnostics", "auth.test", token = "private-token")).await;
                axum::http::StatusCode::INTERNAL_SERVER_ERROR
            }))
            .route("/second", get(|| async {
                async { tokio::task::yield_now().await; }
                    .instrument(tracing::info_span!(target: "silverhand::diagnostics", "db.test")).await;
                axum::http::StatusCode::SERVICE_UNAVAILABLE
            }))
            .layer(axum::middleware::from_fn(crate::foundation::observability::observe_http));
        async {
            let (a, b) = tokio::join!(
                app.clone().oneshot(
                    Request::get("/first/private-id?token=private-query")
                        .body(Body::empty())
                        .unwrap()
                ),
                app.oneshot(Request::get("/second").body(Body::empty()).unwrap()),
            );
            a.unwrap().into_body().collect().await.unwrap();
            b.unwrap().into_body().collect().await.unwrap();
        }
        .with_subscriber(subscriber)
        .await;
        let events = lines(&output);
        let summaries: Vec<_> = events
            .iter()
            .filter(|event| event["fields"]["message"] == "HTTP request diagnostic")
            .collect();
        assert_eq!(summaries.len(), 2, "{events:?}");
        let first = summaries
            .iter()
            .find(|event| event["fields"]["request"]["route"] == "/first/:id")
            .unwrap();
        let second = summaries
            .iter()
            .find(|event| event["fields"]["request"]["route"] == "/second")
            .unwrap();
        assert_eq!(first["fields"]["phases"]["auth.test"]["count"], 1);
        assert!(first["fields"]["phases"]["db.test"].is_null());
        assert_eq!(second["fields"]["phases"]["db.test"]["count"], 1);
        assert_ne!(
            first["fields"]["request"]["request_id"],
            second["fields"]["request"]["request_id"]
        );
        let cause = events
            .iter()
            .find(|event| event["fields"]["message"] == "test cause")
            .unwrap();
        assert_eq!(
            cause["fields"]["http_request_id"],
            first["fields"]["request"]["request_id"]
        );
        assert_eq!(cause["fields"]["request_id"], "rust-test-1");
        assert_eq!(
            cause["fields"]["error"],
            std::io::Error::from_raw_os_error(24).to_string()
        );
        assert!(!serde_json::to_string(&events).unwrap().contains("private-"));
    }

    #[tokio::test]
    async fn http_diagnostics_cover_slow_body_fast_success_and_cancellation() {
        use axum::{Router, body::Body, http::Request, routing::get};
        use http_body_util::BodyExt;
        use tower::ServiceExt;
        use tracing::instrument::WithSubscriber;
        let output = Buffer::default();
        let subscriber = registry().with(production_json_layer(
            EnvFilter::new("error"),
            ProductionConversationLogDebugControl::new(),
            Clock(Arc::new(AtomicI64::new(100))),
            output.clone(),
        ));
        let app = Router::new()
            .route("/fast", get(|| async { "ok" }))
            .route(
                "/empty",
                get(|| async { axum::http::StatusCode::NO_CONTENT }),
            )
            .route(
                "/body",
                get(|| async {
                    Body::from_stream(futures_util::stream::once(async {
                        tokio::time::sleep(std::time::Duration::from_millis(1050)).await;
                        Ok::<_, std::io::Error>("ok")
                    }))
                }),
            )
            .route(
                "/pending",
                get(|| async {
                    std::future::pending::<()>().await;
                    "never"
                }),
            )
            .route(
                "/broken",
                get(|| async {
                    Body::from_stream(futures_util::stream::once(async {
                        Err::<String, _>(std::io::Error::other("body test failure"))
                    }))
                }),
            )
            .layer(axum::middleware::from_fn(
                crate::foundation::observability::observe_http,
            ));
        async {
            app.clone()
                .oneshot(Request::get("/fast").body(Body::empty()).unwrap())
                .await
                .unwrap()
                .into_body()
                .collect()
                .await
                .unwrap();
            assert!(lines(&output).is_empty());
            drop(
                app.clone()
                    .oneshot(Request::get("/empty").body(Body::empty()).unwrap())
                    .await
                    .unwrap(),
            );
            assert!(lines(&output).is_empty(), "empty body need not be polled");
            app.clone()
                .oneshot(Request::get("/body").body(Body::empty()).unwrap())
                .await
                .unwrap()
                .into_body()
                .collect()
                .await
                .unwrap();
            let response = app
                .clone()
                .oneshot(Request::get("/body").body(Body::empty()).unwrap())
                .await
                .unwrap();
            drop(response);
            assert!(
                app.clone()
                    .oneshot(Request::get("/broken").body(Body::empty()).unwrap())
                    .await
                    .unwrap()
                    .into_body()
                    .collect()
                    .await
                    .is_err()
            );
            assert!(
                tokio::time::timeout(
                    std::time::Duration::from_millis(10),
                    app.oneshot(Request::get("/pending").body(Body::empty()).unwrap())
                )
                .await
                .is_err()
            );
        }
        .with_subscriber(subscriber)
        .await;
        let all = lines(&output);
        let error = all
            .iter()
            .find(|event| event["fields"]["message"] == "HTTP response body failed")
            .unwrap();
        assert!(
            error["fields"]["error"]
                .as_str()
                .unwrap()
                .contains("body test failure")
        );
        let events: Vec<_> = all
            .iter()
            .filter(|event| event["fields"]["message"] == "HTTP request diagnostic")
            .collect();
        assert_eq!(events.len(), 4, "{all:?}");
        let slow = &events[0]["fields"]["request"];
        assert_eq!(slow["completion"], "complete");
        assert!(slow["body_ms"].as_f64().unwrap() >= 1000.);
        assert!(slow["handler_ms"].as_f64().unwrap() < 1000.);
        assert_eq!(
            events[1]["fields"]["request"]["completion"],
            "cancelled_body"
        );
        assert_eq!(events[2]["fields"]["request"]["completion"], "body_error");
        // No response exists yet, so status is absent rather than a fabricated 500.
        assert_eq!(events[3]["fields"]["request"]["route"], "/pending");
        assert!(events[3]["fields"]["request"]["status"].is_null());
    }

    #[tokio::test]
    async fn real_sqlite_auth_pool_wait_and_query_are_separate_in_request_summary() {
        use axum::{Router, body::Body, http::Request, routing::get};
        use http_body_util::BodyExt;
        use silverhand_backend_core::identity_access::auth::{
            SessionTokenHash, SessionTtl, SessionValidation, SessionValidationPort,
        };
        use silverhand_backend_sqlite::identity_access::auth::SqliteSessionStore;
        use tower::ServiceExt;
        use tracing::instrument::WithSubscriber;
        let pool = sqlx::sqlite::SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        sqlx::raw_sql("CREATE TABLE users(id TEXT); CREATE TABLE auth_sessions(token_hash TEXT, user_id TEXT, last_used_at INTEGER, revoked_at INTEGER); INSERT INTO users VALUES ('test-user');").execute(&pool).await.unwrap();
        sqlx::query("INSERT INTO auth_sessions VALUES (?, 'test-user', 100, NULL)")
            .bind(SessionTokenHash::of_plaintext("private-test-secret").as_str())
            .execute(&pool)
            .await
            .unwrap();
        let store = SqliteSessionStore::from_pool(pool.clone());
        let held = pool.acquire().await.unwrap();
        let output = Buffer::default();
        let subscriber = registry().with(production_json_layer(
            EnvFilter::new("error"),
            ProductionConversationLogDebugControl::new(),
            Clock(Arc::new(AtomicI64::new(100))),
            output.clone(),
        ));
        let app = Router::new()
            .route(
                "/auth-probe",
                get(move || {
                    let store = store.clone();
                    async move {
                        let user = store
                            .verify_and_touch(
                                SessionTokenHash::of_plaintext("private-test-secret"),
                                SessionValidation::new(200, SessionTtl::default()),
                            )
                            .await
                            .unwrap()
                            .unwrap();
                        assert_eq!(user.as_str(), "test-user");
                        // A fast error response forces a diagnostic without waiting one second.
                        axum::http::StatusCode::INTERNAL_SERVER_ERROR
                    }
                }),
            )
            .layer(axum::middleware::from_fn(
                crate::foundation::observability::observe_http,
            ));
        async {
            let request = async {
                app.oneshot(Request::get("/auth-probe").body(Body::empty()).unwrap())
                    .await
                    .unwrap()
                    .into_body()
                    .collect()
                    .await
                    .unwrap();
            };
            tokio::pin!(request);
            assert!(futures_util::poll!(&mut request).is_pending());
            tokio::time::sleep(std::time::Duration::from_millis(30)).await;
            drop(held);
            request.await;
            let touched: i64 = sqlx::query_scalar("SELECT last_used_at FROM auth_sessions")
                .fetch_one(&pool)
                .await
                .unwrap();
            assert_eq!(touched, 200);
            // Join SQLite's worker too: it may release the final tracing span
            // reference after delivering its query result to the async caller.
            pool.close().await;
            // Pool close acknowledges connection closure, not the subsequent
            // destructor of the worker's tracing guard. Observe that terminal
            // event with a deadline instead of racing another OS thread.
            tokio::time::timeout(std::time::Duration::from_secs(2), async {
                while !lines(&output)
                    .iter()
                    .any(|event| event["fields"]["message"] == "HTTP request diagnostic")
                {
                    tokio::time::sleep(std::time::Duration::from_millis(1)).await;
                }
            })
            .await
            .expect("SQLite worker must release the request span");
        }
        .with_subscriber(subscriber)
        .await;
        let events = lines(&output);
        let event = events
            .iter()
            .find(|event| event["fields"]["message"] == "HTTP request diagnostic")
            .unwrap();
        let phases = &event["fields"]["phases"];
        assert!(phases["db.pool.acquire"]["total_ms"].as_f64().unwrap() >= 20.);
        assert_eq!(phases["db.transaction.begin"]["count"], 1);
        assert_eq!(phases["db.statement:auth.verify_and_touch"]["count"], 1);
        assert_eq!(phases["db.statement:auth.user_exists"]["count"], 1);
        assert_eq!(phases["db.statement:auth.commit"]["count"], 1);
        assert!(
            !serde_json::to_string(&events)
                .unwrap()
                .contains("private-test-secret")
        );
    }

    #[test]
    fn one_sink_combines_global_and_conversation_effective_levels() {
        let control = ProductionConversationLogDebugControl::new();
        let clock = Clock(Arc::new(AtomicI64::new(100)));
        let output = Buffer::default();
        let conversation = ConversationId::parse("conversation-a").unwrap();
        control.enable(&conversation, 200);
        let subscriber = registry().with(production_json_layer(
            EnvFilter::new("warn"),
            control.clone(),
            clock.clone(),
            output.clone(),
        ));

        tracing::subscriber::with_default(subscriber, || {
            tracing::debug!(conversation_id = "conversation-a", marker = "a-debug");
            tracing::info!(conversation_id = "conversation-a", marker = "a-info");
            tracing::debug!(conversation_id = "conversation-b", marker = "b-debug");
            tracing::info!(conversation_id = "conversation-b", marker = "b-info");
            tracing::warn!(conversation_id = "conversation-b", marker = "global-warn");
            control.disable(&conversation);
            tracing::debug!(conversation_id = "conversation-a", marker = "disabled");
            control.enable(&conversation, 200);
            clock.0.store(200, Ordering::SeqCst);
            tracing::info!(conversation_id = "conversation-a", marker = "expired");
        });

        let rendered = lines(&output);
        assert_eq!(rendered.len(), 3);
        let joined = serde_json::to_string(&rendered).unwrap();
        assert!(joined.contains("a-debug"));
        assert!(joined.contains("a-info"));
        assert!(joined.contains("global-warn"));
        assert!(!joined.contains("b-debug"));
        assert!(!joined.contains("b-info"));
        assert!(!joined.contains("disabled"));
        assert!(!joined.contains("expired"));
        assert!(!control.is_enabled_at(&conversation, 200));
    }

    #[test]
    fn global_debug_and_window_write_one_sanitized_json_line() {
        #[derive(Debug)]
        struct DebugContext {
            reason: &'static str,
            keep: &'static str,
        }

        let control = ProductionConversationLogDebugControl::new();
        let clock = Clock(Arc::new(AtomicI64::new(100)));
        let output = Buffer::default();
        control.enable(&ConversationId::parse("conversation-a").unwrap(), 200);
        let subscriber = registry().with(production_json_layer(
            EnvFilter::new("debug"),
            control,
            clock,
            output.clone(),
        ));

        tracing::subscriber::with_default(subscriber, || {
            let debug_struct = DebugContext {
                reason: "connection refused",
                keep: "struct-visible",
            };
            let typed_id = ConversationId::parse("conversation-safe").unwrap();
            assert_eq!(debug_struct.keep, "struct-visible");
            assert_eq!(debug_struct.reason, "connection refused");
            tracing::debug!(
                conversation_id = "conversation-a",
                payload = "SECRET-PAYLOAD",
                env_TOKEN = "SECRET-ENV",
                nested = %serde_json::json!({"prompt":"SECRET-PROMPT","keep":"visible"}),
                debug_json = ?serde_json::json!({"reason":"connection refused","keep":"debug-json-visible"}),
                debug_struct = ?debug_struct,
                Authorization = %"SECRET-BEARER",
                error_chain = safe_display(&"outer failure: inner failure"),
                typed_id = safe_display(&typed_id.as_str()),
                scalar = 7,
                label = "faithful",
                marker = "one-line"
            );
        });

        let rendered = lines(&output);
        assert_eq!(rendered.len(), 1);
        let serialized = serde_json::to_string(&rendered[0]).unwrap();
        assert!(serialized.contains("one-line"));
        assert!(serialized.contains("outer failure: inner failure"));
        assert!(serialized.contains("conversation-safe"));
        assert!(serialized.contains("\"scalar\":7"));
        assert!(serialized.contains("faithful"));
        assert_eq!(rendered[0]["fields"]["redactedFieldCount"], 4);
        assert_eq!(rendered[0]["fields"]["nested"]["keep"], "visible");
        assert!(serialized.contains("debug-json-visible"));
        assert!(serialized.contains("connection refused"));
        assert!(serialized.contains("struct-visible"));
        assert!(
            serialized.contains("redactedFieldCount"),
            "missing redaction evidence: {serialized}"
        );
        for forbidden in [
            "SECRET-PAYLOAD",
            "SECRET-ENV",
            "SECRET-PROMPT",
            "SECRET-BEARER",
            "\"payload\"",
            "\"env_TOKEN\"",
            "\"prompt\"",
        ] {
            assert!(!serialized.contains(forbidden), "leaked {forbidden}");
        }
    }

    #[test]
    fn dependency_message_and_display_debug_errors_keep_the_actual_cause() {
        let output = Buffer::default();
        let subscriber = registry().with(production_json_layer(
            EnvFilter::new("error"),
            ProductionConversationLogDebugControl::new(),
            Clock(Arc::new(AtomicI64::new(100))),
            output.clone(),
        ));
        let error = std::io::Error::from_raw_os_error(24);
        tracing::subscriber::with_default(subscriber, || {
            tracing::error!(target: "axum::serve::listener", "accept error: {error}");
            tracing::error!(error = %error, context = ?error, request_id = "rust-test-1", "request failed");
        });
        let events = lines(&output);
        assert_eq!(events.len(), 2);
        assert_eq!(
            events[0]["fields"]["message"],
            format!("accept error: {error}")
        );
        assert_eq!(events[1]["fields"]["error"], error.to_string());
        assert_eq!(events[1]["fields"]["context"], format!("{error:?}"));
        assert_eq!(events[1]["fields"]["request_id"], "rust-test-1");
        assert!(
            events
                .iter()
                .all(|event| event["fields"].get("redactedFieldCount").is_none())
        );
    }
}
