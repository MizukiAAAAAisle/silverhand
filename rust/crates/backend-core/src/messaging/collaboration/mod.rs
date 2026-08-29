//! Conversation collaboration capabilities that are not message creation itself.
//!
//! Each child module owns one reason to change. Storage and wire adapters mirror
//! these boundaries in their crates; this module is only a stable naming facade.

// INTEGRATION SEAM: thin capability registration; no business logic belongs here.
pub mod activity;
pub mod attachment;
pub mod attention_preference;
pub mod attention_projection;
pub mod channel_directory;
pub mod channel_lifecycle;
pub mod conversation_agent_activity;
pub mod conversation_agent_directory;
pub mod conversation_agent_runtime;
pub mod conversation_message_window;
pub mod conversation_ref;
pub mod conversation_threads;
pub mod conversation_unread;
pub mod direct_pair_initiation;
pub mod human_search;
pub mod message_unread;
pub mod notification;
pub mod reaction;
mod runtime_control;
pub mod saved;
pub mod stale_message_resolution;
pub mod thread_follow;
pub mod workspace_rename_messaging;

pub use runtime_control::{
    BoundRuntimeControlSeat, ClearSessionAuditWitness, ClearSessionCommitMismatch,
    ClearSessionCommitReceipt, ClearSessionOutcome, ClearSessionProviderRefusal,
    ClearSessionRefusal, CliSessionId, EmptyCliSessionId, HardStopRuntimeOutcome,
    HardStopRuntimeProviderRefusal, HardStopRuntimeRefusal, RuntimeControlAdmission,
    RuntimeControlAdmissionRefusal, RuntimeControlAdmissionScope, RuntimeControlFailure,
    RuntimeControlObservedStatus, RuntimeControlPort, RuntimeControlSeatMismatch,
    RuntimeControlSeatPort, RuntimeControlSeatSnapshot, RuntimePlacementRefusal,
    RuntimeSeatCoordinate, RuntimeSeatTarget, RuntimeStartTarget, StartRuntimeOutcome,
    StartRuntimeProviderRefusal, StartRuntimeRefusal, check_runtime_control_admission,
    clear_agent_session, clear_conversation_session, hard_stop_runtime, seal_clear_session_commit,
    start_runtime,
};
