//! The SQLite adapter for the host-agent teardown ports.
//!
//! One store, [`SqliteHostAgentStore`], implements every teardown port over a
//! product database it does NOT own. The leaves split by concern, not by port: the
//! row decoders and the facts projection are shared by the read hints and by the
//! in-lock re-reads, so a hint and the write that acts on it can never disagree
//! about how a column becomes a fact.
//!
//!  - `store` opens the pool and speaks the one write-reservation begin.
//!  - `decode` turns persisted tokens into the closed vocabularies core owns.
//!  - `facts` projects rows into the narrow facts each phase reads.
//!  - `teardown` owns the single trait surface for the agent write axis.
//!  - `cascade` is the computer axis the trait delegates to.
//!  - `intent` is the durable deletion-intent lifecycle.
//!  - `runtime_transition` is the durable runtime-transition lock lifecycle.
//!  - `runtime_switch` is the source-bound agent-row snapshot the switch saga reads.

mod agent_graph_read;
mod agent_materialization;
mod cascade;
mod decode;
mod facts;
mod intent;
mod runtime_switch;
mod runtime_transition;
mod store;
mod teardown;

pub use store::{SqliteHostAgentStore, SqliteHostAgentStoreError};
