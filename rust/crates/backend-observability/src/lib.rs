//! Caller-owned operation timing. Spans propagate context; an explicit terminal
//! record measures the operation, independently of downstream span clones.
use std::{future::Future, time::Instant};
use tracing::{Instrument, Span};

/// The span must declare elapsed_ms, outcome and operation_finished fields.
/// Dropping a polled operation without a result records cancellation, never success.
#[must_use = "keep the operation alive until its result or cancellation"]
pub struct Operation {
    span: Span,
    started: Instant,
    outcome: &'static str,
}

impl Operation {
    pub fn current() -> Self {
        Self::new(Span::current())
    }

    fn new(span: Span) -> Self {
        Self {
            span,
            started: Instant::now(),
            outcome: "cancelled",
        }
    }

    pub fn finish<T, E>(mut self, result: &Result<T, E>) {
        self.outcome = if result.is_ok() { "ok" } else { "error" };
    }
}

impl Drop for Operation {
    fn drop(&mut self) {
        self.span
            .record("elapsed_ms", self.started.elapsed().as_secs_f64() * 1000.);
        self.span.record("outcome", self.outcome);
        // Last record is the commit point for the collector. This does not close
        // the span: other code may still own it for correlation.
        self.span.record("operation_finished", true);
    }
}

/// Standard Instrument propagation plus timing from first poll to result/drop.
pub trait Observe<T, E>: Future<Output = Result<T, E>> + Sized {
    fn observe(self, span: Span) -> impl Future<Output = Result<T, E>> {
        async move {
            let operation = Operation::current();
            let result = self.await;
            operation.finish(&result);
            result
        }
        .instrument(span)
    }
}
impl<F, T, E> Observe<T, E> for F where F: Future<Output = Result<T, E>> {}

/// Declare the bounded fields consumed by the operation collector. Span names
/// are static callsite identities, never SQL text, ids or user input.
#[macro_export]
macro_rules! operation_span {
    ($name:literal) => {
        tracing::info_span!(target: "silverhand::diagnostics", $name,
            elapsed_ms = tracing::field::Empty,
            outcome = tracing::field::Empty,
            operation_finished = tracing::field::Empty)
    };
}
