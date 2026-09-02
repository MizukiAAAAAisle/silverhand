//! SQLite adapters for the agent and computer teardown application axes.
//!
//! The unit of work owns the transaction. Its facts, intent, and cascade
//! siblings project or mutate within that authority; runtime-session projection
//! remains a narrow C2 helper in `host_runtime`.

mod cascade;
mod facts;
mod intent;
mod unit_of_work;
