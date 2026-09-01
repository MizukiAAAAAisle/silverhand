//! Compatibility facade; runtime-control daemon adapters are owned by host runtime.

#[cfg(test)]
pub(crate) use crate::host_runtime::runtime_control::ClearDispatchOutcome;
#[cfg(test)]
pub(crate) use crate::host_runtime::runtime_control::RUNTIME_CAPABILITY_CODES;
pub(crate) use crate::host_runtime::runtime_control::RuntimeClearSessionWaiters;
pub(crate) use crate::host_runtime::runtime_control::admits_runtime_refusal;
#[cfg(test)]
pub(crate) use crate::host_runtime::runtime_control::clear_captured;
pub use crate::host_runtime::runtime_control::{
    ProductionRuntimeControl, RuntimeControlAdapterFailure,
};
