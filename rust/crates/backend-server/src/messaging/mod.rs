//! The product create-message boundary: the two send routes and everything they pass
//! through before a request becomes a committed send.
//!
//! - [`envelope`] — the ingress fence, applied to the whole body before anything else
//!   about the request is considered.
//! - [`admission`] — what a request must BE, decided before any principal is known.
//! - [`execute`] — the one place a settled request becomes a committed send.
//! - [`adapters`] — the two doors, which differ only in the order they ask their gates.
//! - [`outcome`] — how a send that reached the write unit is answered.
//! - [`references`] — where in a body a reference can address from.
//! - [`router`] — the routes those doors hang on.
//! - [`send_request`] — the flat snake_case refusals the product routes answer with.
//!
//! WHAT MAY NOT BE CLAIMED FROM THIS: the routes are DEFINED, not mounted. No
//! composition root builds [`router::send_router`], there is no authentication middleware
//! to supply the principals it reads, and a COMMITTED send still has no acknowledgement to
//! answer with. Refusals are projected; the success half is not.

// Internal stages: this module's own layout, which no consumer should couple to. The
// router and the ports a composition must implement are the public face.
pub mod adapters;
pub(crate) mod admission;
pub(crate) mod envelope;
pub(crate) mod execute;
pub(crate) mod outcome;
pub(crate) mod references;
pub mod router;
pub(crate) mod send_request;

/// The pre-parse body bound. Public because it is part of the contract rather than an
/// implementation detail: the refusal reports it, and a client that pre-checks its own
/// request needs the same number.
pub use send_request::MESSAGE_SEND_MAX_BODY_BYTES;

// The shared contracts this crate answers to. A test module rather than a public path: the
// artifacts they read are checked in beside the other implementation, and the rule they
// exercise is deliberately not reachable from outside.
#[cfg(test)]
mod contracts;
