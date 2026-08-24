//! Conversation collaboration capabilities that are not message creation itself.
//!
//! Each child module owns one reason to change. Storage and wire adapters mirror
//! these boundaries in their crates; this module is only a stable naming facade.

mod runtime_control;

pub use runtime_control::{
    ClearSessionOutcome, CliSessionId, EmptyCliSessionId, RuntimeControlAdmission,
    RuntimeControlCommand, RuntimeControlFailure, RuntimeControlOperation, RuntimeControlOutcome,
    RuntimeControlPort, RuntimeControlProviderRefusal, RuntimeControlRefusal,
    control_conversation_runtime,
};
