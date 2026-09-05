//! Cross-context application sagas, daemon command codecs, and post-commit fan-out.
//!
//! The production-settled namespace is closed: daemon delivery, its codec consumers, and
//! workspace-rename fan-out live only under this canonical context.

pub mod agent_create;
pub mod agent_delete;
pub mod daemon_delivery;
pub(crate) mod daemon_materialize_codec;
pub mod workspace_rename_fanout;
