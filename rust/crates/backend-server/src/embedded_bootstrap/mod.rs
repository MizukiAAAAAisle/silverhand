//! Embedded-bootstrap route family (Rust residual wave).
//!
//! The `POST /auth/embedded-bootstrap` first-run session grant. [`token`] holds the
//! process-lifetime one-shot token authority; [`route`] builds the loopback-gated
//! route and handler over the core choose/create flow. UNMOUNTED — no composition
//! root names [`route::router`] yet, and production `serve()` is not switched to
//! connect-info here; that flip is the ratified convergence step.

mod route;
mod token;

pub use route::{EMBEDDED_BOOTSTRAP_PATH, EmbeddedBootstrapDeps, LoopbackPeer, router};
pub use token::EmbeddedBootstrapTokenAuthority;
