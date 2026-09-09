//! `application_orchestration` — the cross-context application-orchestration
//! business-owner namespace.
//!
//! A namespace container, not a business unit of its own: it groups the crate
//! roots the organization map assigns to owner `application_orchestration` under a
//! single Rust module path (`crate::application_orchestration::*`). It declares its
//! members and holds no domain logic itself.
//!
//! Colocation reflects cross-context orchestration OWNERSHIP only; it does NOT merge
//! creation, materialization, and teardown into one lifecycle or transaction. Each
//! stays a distinct authority: `agent_creation` (the create/provision saga),
//! `agent_materialization` (the materialization writer/use case), and `teardown` (the
//! deletion/cascade domain — one mapped directory leaf whose internal children stay
//! internal).

pub mod agent_creation;
pub mod agent_materialization;
pub mod console_analytics;
pub mod teardown;
