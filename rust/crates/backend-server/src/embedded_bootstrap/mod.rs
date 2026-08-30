//! Embedded-bootstrap route family (Rust residual wave).
//!
//! The `POST /auth/embedded-bootstrap` first-run session grant. [`token`] holds the
//! process-lifetime one-shot token authority; [`route`] builds the loopback-gated
//! route and handler over the core choose/create flow. The backend-app production
//! composition mounts [`route::router`] once at the top level and serves it with
//! socket connect-info so the peer gate observes the real connection.

mod route;
mod token;

pub use route::{
    EMBEDDED_BOOTSTRAP_PATH, EmbeddedBootstrapDeps, LoopbackPeer, is_loopback_ip, router,
};
pub use token::EmbeddedBootstrapTokenAuthority;
