//! The one production JSON log sink and its effective-level decision.
//!
//! Conversation debug windows extend the global filter; they never install a
//! second writer. The formatter also applies the same recursive forbidden-field
//! policy as the TypeScript logging authority before any event reaches stderr.

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
        FmtContext, MakeWriter,
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
];

fn forbidden(key: &str) -> bool {
    FORBIDDEN_FIELDS.contains(&key) || key.starts_with("env_")
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

    fn record_debug(&mut self, _field: &tracing::field::Field, _value: &dyn fmt::Debug) {
        // `Debug` has no structural contract. Even output that happens to parse
        // as JSON cannot prove that its nested fields are safe, and `%Display`
        // reaches this same visitor method. Opaque carriers therefore fail
        // closed as a whole. Production display call sites use `safe_display`,
        // which records a reviewed string through `record_str` instead.
        self.redacted += 1;
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
        _context: &FmtContext<'_, S, N>,
        mut writer: Writer<'_>,
        event: &Event<'_>,
    ) -> fmt::Result {
        let mut visitor = JsonVisitor::default();
        event.record(&mut visitor);
        let mut timestamp = String::new();
        SystemTime.format_time(&mut Writer::new(&mut timestamp))?;
        let output = serde_json::json!({
            "timestamp": timestamp,
            "level": event.metadata().level().as_str(),
            "fields": visitor.finish(),
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
        if Filter::enabled(&self.global, metadata, context) {
            return true;
        }
        metadata.is_event() && *metadata.level() != tracing::Level::TRACE
    }

    fn event_enabled(&self, event: &Event<'_>, context: &Context<'_, S>) -> bool {
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
    tracing_subscriber::fmt::layer()
        .event_format(SanitizedJsonEvent)
        .fmt_fields(SanitizedJsonFields)
        .with_ansi(false)
        .with_writer(BoxMakeWriter::new(writer))
        .with_filter(EffectiveLogFilter {
            global,
            control,
            clock,
        })
}

#[cfg(test)]
mod tests {
    use std::{
        collections::HashMap,
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
            prompt: &'static str,
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
            let debug_map =
                HashMap::from([("prompt", "SECRET-MAP-PROMPT"), ("keep", "map-visible")]);
            let debug_struct = DebugContext {
                prompt: "SECRET-STRUCT-PROMPT",
                keep: "struct-visible",
            };
            let typed_id = ConversationId::parse("conversation-safe").unwrap();
            assert_eq!(debug_struct.keep, "struct-visible");
            assert_eq!(debug_struct.prompt, "SECRET-STRUCT-PROMPT");
            tracing::debug!(
                conversation_id = "conversation-a",
                payload = "SECRET-PAYLOAD",
                env_TOKEN = "SECRET-ENV",
                nested = %serde_json::json!({"prompt":"SECRET-PROMPT","keep":"visible"}),
                debug_json = ?serde_json::json!({"prompt":"SECRET-DEBUG-JSON","keep":"debug-json-visible"}),
                debug_map = ?debug_map,
                debug_struct = ?debug_struct,
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
        assert_eq!(rendered[0]["fields"]["redactedFieldCount"], 6);
        assert!(
            serialized.contains("redactedFieldCount"),
            "missing redaction evidence: {serialized}"
        );
        for forbidden in [
            "SECRET-PAYLOAD",
            "SECRET-ENV",
            "SECRET-PROMPT",
            "SECRET-DEBUG-JSON",
            "SECRET-MAP-PROMPT",
            "SECRET-STRUCT-PROMPT",
            "debug-json-visible",
            "map-visible",
            "struct-visible",
            "\"nested\"",
            "\"debug_map\"",
            "\"payload\"",
            "\"env_TOKEN\"",
            "\"prompt\"",
            "\"debug_json\"",
            "\"debug_struct\"",
        ] {
            assert!(!serialized.contains(forbidden), "leaked {forbidden}");
        }
    }
}
