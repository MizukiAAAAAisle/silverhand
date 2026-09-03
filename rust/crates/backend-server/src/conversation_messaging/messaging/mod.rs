//! The product create-message boundary: the two send routes and everything they pass
//! through before a request becomes a committed send.
//!
//! - [`envelope`] — the ingress fence, applied to the whole body before anything else
//!   about the request is considered.
//! - [`admission`] — what a request must BE, decided before any principal is known.
//! - [`execute`] — the one place a settled request becomes a committed send.
//! - [`adapters`] — the two doors, which differ only in the order they ask their gates.
//! - [`ack`] / [`agent_output`] — the two doors' own published success contracts.
//! - [`message_wire`] — the single projector authority for a committed message, consumed by
//!   both the ACK and the conversation-scope `message` broadcast frame.
//! - [`aftermath`] — the one required post-commit fan-out from a successful outcome.
//! - [`unresolved_wire`] — the sender-only diagnostic, shared by both of them.
//! - [`outcome`] — how a send that reached the write unit is answered.
//! - [`references`] — where in a body a reference can address from.
//! - [`router`] — the routes those doors hang on.
//! - [`send_request`] — the flat snake_case refusals the product routes answer with.
//!
//! This crate defines the product boundary but does not own its process. The executable
//! composition mounts [`router::send_routers`] behind the distinct human-session and runtime
//! credential authorities; library-only uses of [`router::send_router`] still have to provide
//! authenticated principal facts themselves.

// Internal stages: this module's own layout, which no consumer should couple to. The
// router and the ports a composition must implement are the public face.
pub(crate) mod ack;
pub mod adapters;
pub(crate) mod admission;
pub mod aftermath;
pub(crate) mod agent_capability_wire;
pub(crate) mod agent_output;
pub(crate) mod author_wire;
pub mod collaboration;
pub(crate) mod envelope;
pub(crate) mod execute;
pub(crate) mod message_wire;
pub(crate) mod outcome;
pub(crate) mod references;
pub mod router;
pub(crate) mod send_request;
mod target_observer;
pub(crate) mod target_refusal_wire;
pub mod task;
pub(crate) mod unresolved_wire;

/// The pre-parse body bound. Public because it is part of the contract rather than an
/// implementation detail: the refusal reports it, and a client that pre-checks its own
/// request needs the same number.
pub use send_request::MESSAGE_SEND_MAX_BODY_BYTES;
pub use target_observer::TargetAddressRefusalLog;

// The shared contracts this crate answers to. A test module rather than a public path: the
// artifacts they read are checked in beside the other implementation, and the rule they
// exercise is deliberately not reachable from outside.
#[cfg(test)]
mod contracts;
