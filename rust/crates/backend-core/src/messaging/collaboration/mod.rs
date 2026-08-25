//! Conversation collaboration capabilities that are not message creation itself.
//!
//! Each child module owns one reason to change. Storage and wire adapters mirror
//! these boundaries in their crates; this module is only a stable naming facade.

// INTEGRATION SEAM: thin capability registration; no business logic belongs here.
pub mod activity;
pub mod attention_preference;
pub mod attention_projection;
pub mod notification;
pub mod reaction;
mod runtime_control;
pub mod saved;

pub use runtime_control::{
    ClearSessionOutcome, ClearSessionProviderRefusal, ClearSessionRefusal, CliSessionId,
    EmptyCliSessionId, HardStopRuntimeOutcome, HardStopRuntimeProviderRefusal,
    HardStopRuntimeRefusal, RuntimeControlAdmission, RuntimeControlAdmissionRefusal,
    RuntimeControlAdmissionScope, RuntimeControlFailure, RuntimeControlPort, RuntimeControlTarget,
    RuntimePlacementRefusal, StartRuntimeOutcome, StartRuntimeProviderRefusal, StartRuntimeRefusal,
    check_runtime_control_admission, clear_conversation_runtime_session,
    hard_stop_conversation_runtime, start_conversation_runtime,
};
