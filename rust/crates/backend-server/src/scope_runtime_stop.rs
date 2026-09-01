//! Compatibility facade; exact-seat stop is owned by host runtime.

#[cfg(test)]
pub(crate) use crate::host_runtime::scope_runtime_stop::stop_captured;
pub use crate::host_runtime::scope_runtime_stop::{
    ProductionScopeRuntimeStop, ScopeRuntimeStopFailure,
};
