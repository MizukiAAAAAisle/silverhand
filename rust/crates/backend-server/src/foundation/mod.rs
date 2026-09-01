//! Shared technical substrate, wire vocabulary, and process-wide transport/protocol
//! foundations.
//!
//! Bearer extraction, process time, and multipart streaming remain independent technical
//! leaves; colocation here does not merge their contracts or responsibilities.
//! Error-chain reporting, JSON object admission, and PATCH presence algebra likewise remain
//! independent framework leaves.

pub(crate) mod bearer;
pub mod clock;
pub(crate) mod daemon_command;
pub(crate) mod daemon_transport;
pub(crate) mod error;
pub(crate) mod multipart_transport;
pub mod scope_event_transport;
pub(crate) mod scope_event_wire;
pub(crate) mod wire_admission;
pub(crate) mod wire_patch;
