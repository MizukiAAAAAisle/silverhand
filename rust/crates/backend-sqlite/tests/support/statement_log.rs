use std::sync::{Arc, Mutex};
use tracing::{
    Event, Metadata, Subscriber,
    field::{Field, Visit},
    level_filters::LevelFilter,
    span::{Attributes, Id, Record},
};

/// A minimal global subscriber that records the summary of every sqlx statement event. It
/// reports every callsite enabled so sqlx's `Drop`-time `sqlx::query` event is never
/// filtered before it reaches `event`, where only that target is recorded.
#[derive(Clone, Default)]
pub struct StatementLog {
    summaries: Arc<Mutex<Vec<String>>>,
}

impl StatementLog {
    /// The statements recorded since `from`, keeping only the reads (`SELECT …`).
    pub fn reads_since(&self, from: usize) -> Vec<String> {
        self.summaries.lock().unwrap()[from..]
            .iter()
            .filter(|summary| summary.starts_with("SELECT"))
            .cloned()
            .collect()
    }

    pub fn len(&self) -> usize {
        self.summaries.lock().unwrap().len()
    }
}

/// Pulls sqlx's `summary` field (the leading words of the SQL) off an event.
#[derive(Default)]
struct SummaryVisitor(Option<String>);

impl Visit for SummaryVisitor {
    fn record_str(&mut self, field: &Field, value: &str) {
        if field.name() == "summary" {
            self.0 = Some(value.to_owned());
        }
    }

    fn record_debug(&mut self, field: &Field, value: &dyn std::fmt::Debug) {
        if field.name() == "summary" && self.0.is_none() {
            self.0 = Some(format!("{value:?}"));
        }
    }
}

impl Subscriber for StatementLog {
    fn enabled(&self, _metadata: &Metadata<'_>) -> bool {
        true
    }

    fn max_level_hint(&self) -> Option<LevelFilter> {
        Some(LevelFilter::TRACE)
    }

    fn new_span(&self, _span: &Attributes<'_>) -> Id {
        Id::from_u64(1)
    }

    fn record(&self, _span: &Id, _values: &Record<'_>) {}

    fn record_follows_from(&self, _span: &Id, _follows: &Id) {}

    fn event(&self, event: &Event<'_>) {
        if event.metadata().target() == "sqlx::query" {
            let mut visitor = SummaryVisitor::default();
            event.record(&mut visitor);
            self.summaries
                .lock()
                .unwrap()
                .push(visitor.0.unwrap_or_default());
        }
    }

    fn enter(&self, _span: &Id) {}

    fn exit(&self, _span: &Id) {}
}
