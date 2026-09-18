//! Operation summaries belong to the request; explicit completion records, not
//! the final release of tracing handles, determine timing and emission.
use serde_json::{Map, Value};
use std::{collections::BTreeMap, sync::OnceLock};
use tracing::{Subscriber, field::Visit, span};
use tracing_subscriber::{Layer, layer::Context, registry::LookupSpan};

pub(crate) const TARGET: &str = "silverhand::diagnostics";

#[derive(Default)]
struct Fields(Map<String, Value>);

impl Visit for Fields {
    fn record_str(&mut self, field: &tracing::field::Field, value: &str) {
        if matches!(
            field.name(),
            "request_id" | "method" | "route" | "completion" | "command" | "query_name" | "outcome"
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
    fn record_bool(&mut self, field: &tracing::field::Field, value: bool) {
        if field.name() == "operation_finished" {
            self.0.insert(field.name().into(), value.into());
        }
    }
    fn record_debug(&mut self, _: &tracing::field::Field, _: &dyn std::fmt::Debug) {}
}

#[derive(Default)]
struct Phase {
    count: u64,
    total_ms: f64,
    max_ms: f64,
    outcomes: BTreeMap<String, u64>,
}

#[derive(Default)]
struct Timing {
    fields: Fields,
    phases: BTreeMap<String, Phase>,
}

#[derive(Default)]
pub(crate) struct DiagnosticTimings {
    dispatcher: OnceLock<tracing::dispatcher::WeakDispatch>,
}

impl DiagnosticTimings {
    fn emit(&self, emit: impl FnOnce()) {
        // Weak dispatch avoids a subscriber/span ownership cycle and supports
        // terminal records emitted on a worker's thread.
        if let Some(dispatcher) = self
            .dispatcher
            .get()
            .and_then(tracing::dispatcher::WeakDispatch::upgrade)
        {
            tracing::dispatcher::with_default(&dispatcher, emit);
        }
    }
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
        let mut timing = Timing::default();
        attrs.record(&mut timing.fields);
        if let Some(span) = ctx.span(id) {
            span.extensions_mut().insert(timing);
        }
    }

    fn on_record(&self, id: &span::Id, values: &span::Record<'_>, ctx: Context<'_, S>) {
        let Some(span) = ctx.span(id) else {
            return;
        };
        let is_request = span.name() == "http_request";
        let timing = {
            let mut extensions = span.extensions_mut();
            let Some(timing) = extensions.get_mut::<Timing>() else {
                return;
            };
            values.record(&mut timing.fields);
            let finished = if is_request {
                timing.fields.0.contains_key("completion")
            } else {
                timing
                    .fields
                    .0
                    .get("operation_finished")
                    .and_then(Value::as_bool)
                    == Some(true)
            };
            if !finished {
                return;
            }
            // Consume once. Late span closes/clones and duplicate records cannot
            // extend duration or emit a second request summary.
            extensions.remove::<Timing>().unwrap()
        };
        let Some(elapsed_ms) = timing.fields.0.get("elapsed_ms").and_then(Value::as_f64) else {
            return;
        };
        if !is_request {
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
                        phase.count += 1;
                        phase.total_ms += elapsed_ms;
                        phase.max_ms = phase.max_ms.max(elapsed_ms);
                        let outcome = timing
                            .fields
                            .0
                            .get("outcome")
                            .and_then(Value::as_str)
                            .unwrap_or("cancelled");
                        *phase.outcomes.entry(outcome.into()).or_default() += 1;
                    }
                    // A detached operation completed after the request boundary:
                    // it must not reopen the completed request or alter its time.
                    return;
                }
            }
            if elapsed_ms >= 1000. {
                self.emit(|| tracing::warn!(target: "silverhand::diagnostics", parent: None,
                    phase = span.name(), elapsed_ms, details = %serde_json::Value::Object(timing.fields.0), "slow background operation"));
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
        let phases: Map<String, Value> = timing.phases.into_iter().map(|(name, phase)| {
            (name, serde_json::json!({"count": phase.count, "total_ms": phase.total_ms, "max_ms": phase.max_ms, "outcomes": phase.outcomes}))
        }).collect();
        // All registry extension locks were released before emission.
        self.emit(|| tracing::warn!(target: "silverhand::diagnostics", parent: None,
            elapsed_ms, request = %serde_json::Value::Object(timing.fields.0), phases = %serde_json::Value::Object(phases), "HTTP request diagnostic"));
    }
}
