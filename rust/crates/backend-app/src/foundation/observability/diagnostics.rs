//! Local summaries of standard tracing spans, independent of metrics/exporters.
//! Only the explicit diagnostics target participates; no argument capture or
//! global request map. State lives with the request span and dies with it.
use serde_json::{Map, Value};
use std::{collections::BTreeMap, sync::OnceLock, time::Instant};
use tracing::{Subscriber, field::Visit, span};
use tracing_subscriber::{Layer, layer::Context, registry::LookupSpan};

pub(crate) const TARGET: &str = "silverhand::diagnostics";

#[derive(Default)]
struct Fields(Map<String, Value>);

impl Visit for Fields {
    fn record_str(&mut self, field: &tracing::field::Field, value: &str) {
        if matches!(
            field.name(),
            "request_id" | "method" | "route" | "completion" | "command" | "query_name"
        ) {
            self.0.insert(field.name().into(), value.into());
        }
    }
    fn record_f64(&mut self, field: &tracing::field::Field, value: f64) {
        if matches!(field.name(), "handler_ms" | "body_ms" | "elapsed_ms") {
            self.0.insert(field.name().into(), value.into());
        }
    }
    fn record_u64(&mut self, field: &tracing::field::Field, value: u64) {
        if field.name() == "status" {
            self.0.insert("status".into(), value.into());
        }
    }
    fn record_debug(&mut self, _: &tracing::field::Field, _: &dyn std::fmt::Debug) {}
}

struct Timing {
    started: Instant,
    fields: Fields,
    phases: BTreeMap<String, (u64, f64, f64)>,
}

#[derive(Default)]
pub(crate) struct DiagnosticTimings {
    dispatcher: OnceLock<tracing::dispatcher::WeakDispatch>,
}

impl<S> Layer<S> for DiagnosticTimings
where
    S: Subscriber + for<'a> LookupSpan<'a>,
{
    fn on_register_dispatch(&self, dispatcher: &tracing::Dispatch) {
        let _ = self.dispatcher.set(dispatcher.downgrade());
    }
    fn on_new_span(&self, attrs: &span::Attributes<'_>, id: &span::Id, ctx: Context<'_, S>) {
        if attrs.metadata().target() != TARGET {
            return;
        }
        let mut fields = Fields::default();
        attrs.record(&mut fields);
        if let Some(span) = ctx.span(id) {
            span.extensions_mut().insert(Timing {
                started: Instant::now(),
                fields,
                phases: BTreeMap::new(),
            });
        }
    }

    fn on_record(&self, id: &span::Id, values: &span::Record<'_>, ctx: Context<'_, S>) {
        if let Some(span) = ctx.span(id) {
            if let Some(timing) = span.extensions_mut().get_mut::<Timing>() {
                values.record(&mut timing.fields);
            }
        }
    }

    fn on_close(&self, id: span::Id, ctx: Context<'_, S>) {
        let Some(span) = ctx.span(&id) else {
            return;
        };
        let Some(mut timing) = span.extensions_mut().remove::<Timing>() else {
            return;
        };
        let elapsed_ms = timing
            .fields
            .0
            .get("elapsed_ms")
            .and_then(Value::as_f64)
            .unwrap_or_else(|| timing.started.elapsed().as_secs_f64() * 1000.);
        if span.name() != "http_request" {
            for ancestor in span.scope().skip(1) {
                if ancestor.name() == "http_request" && ancestor.metadata().target() == TARGET {
                    if let Some(root) = ancestor.extensions_mut().get_mut::<Timing>() {
                        let detail = timing
                            .fields
                            .0
                            .get("command")
                            .or_else(|| timing.fields.0.get("query_name"))
                            .and_then(Value::as_str);
                        let name = detail
                            .map(|detail| format!("{}:{detail}", span.name()))
                            .unwrap_or_else(|| span.name().to_owned());
                        let phase = root.phases.entry(name).or_default();
                        phase.0 += 1;
                        phase.1 += elapsed_ms;
                        phase.2 = phase.2.max(elapsed_ms);
                    }
                    return;
                }
            }
            // Background command/query waits also remain diagnosable without an HTTP parent.
            if elapsed_ms >= 1000. {
                if let Some(dispatcher) = self
                    .dispatcher
                    .get()
                    .and_then(tracing::dispatcher::WeakDispatch::upgrade)
                {
                    tracing::dispatcher::with_default(&dispatcher, || {
                        tracing::warn!(target: "silverhand::diagnostics", parent: None, phase = span.name(), elapsed_ms,
                            details = %serde_json::Value::Object(timing.fields.0), "slow background operation");
                    });
                }
            }
            return;
        }
        let status = timing
            .fields
            .0
            .get("status")
            .and_then(Value::as_u64)
            .unwrap_or(0);
        let completion = timing
            .fields
            .0
            .get("completion")
            .and_then(Value::as_str)
            .unwrap_or("cancelled_before_headers");
        if elapsed_ms < 1000. && status < 500 && completion == "complete" {
            return;
        }
        timing
            .fields
            .0
            .entry("completion")
            .or_insert_with(|| Value::String("cancelled_before_headers".into()));
        let phases: Map<String, Value> = timing
            .phases
            .into_iter()
            .map(|(name, (count, total_ms, max_ms))| {
                (
                    name.into(),
                    serde_json::json!({"count": count, "total_ms": total_ms, "max_ms": max_ms}),
                )
            })
            .collect();
        // Do not emit while holding registry extension locks. Explicit fields also
        // keep this event useful after the request span has been closed.
        // SQLx may release its last span reference on its worker thread. Route
        // the event to the originating subscriber, not that thread's default.
        // A weak handle avoids a subscriber -> span -> subscriber ownership cycle.
        if let Some(dispatcher) = self
            .dispatcher
            .get()
            .and_then(tracing::dispatcher::WeakDispatch::upgrade)
        {
            tracing::dispatcher::with_default(&dispatcher, || {
                tracing::warn!(target: "silverhand::diagnostics", parent: None, elapsed_ms,
                    request = %serde_json::Value::Object(timing.fields.0), phases = %serde_json::Value::Object(phases),
                    "HTTP request diagnostic");
            });
        }
    }
}
