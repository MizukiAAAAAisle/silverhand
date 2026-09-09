//! `foundation` — a private dependency-substrate container for backend-app.
//!
//! Not a bounded context and not the application composition surface: it groups the
//! backend-app crate roots the organization map assigns to owner `foundation` under a
//! single Rust module path (`crate::foundation::*`). It declares its members and holds
//! no orchestration logic itself, and it does not absorb the `application_orchestration`
//! composition context or the cfg-test schema support.

pub(crate) mod request_perimeter;

pub(crate) mod observability;
pub(crate) mod operator_console;
