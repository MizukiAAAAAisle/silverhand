//! Embedded-bootstrap core capability — the choose/create bootstrap unit of work
//! and its own auth/token lifecycle (#task:2248 scaffold). A genuinely new
//! top-level bounded context: not the human-credentialed session, not the runtime
//! credential, so it earns its own crate-root namespace.
//!
//! The choose/create authority and its session-issuing flow live in [`flow`];
//! the port [`EmbeddedBootstrapUnitOfWork`] is implemented by the SQLite adapter and
//! consumed by backend-app's mounted production bootstrap route.

mod flow;

pub use flow::{
    BootstrapChoice, BootstrapPorts, EmbeddedBootstrap, EmbeddedBootstrapError,
    EmbeddedBootstrapUnitOfWork, bootstrap_session,
};
