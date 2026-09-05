//! SQLite adapters that participate directly in application orchestration.
//!
//! These leaves implement application ports over the shared host-agent store.
//! The namespace owns their orchestration-facing responsibilities, while the
//! connection pool and decoding substrate remain in `foundation::host_agent_store`.

mod agent_graph_read;
mod agent_materialization;
mod agent_teardown;
