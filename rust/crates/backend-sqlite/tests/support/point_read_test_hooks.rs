//! Request-scoped cancellation latch, compiled only by the owning unit tests.
tokio::task_local! {
    pub(super) static POINT_READ_ENTERED: std::sync::Arc<tokio::sync::Notify>;
}
