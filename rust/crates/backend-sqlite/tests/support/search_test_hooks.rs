//! Request-local diagnostics, absent from production search builds.
tokio::task_local! {
    pub(super) static SEARCH_TIMING: std::cell::Cell<std::time::Duration>;
    pub(super) static SEARCH_ROW_ENTERED: std::sync::Arc<tokio::sync::Notify>;
}
