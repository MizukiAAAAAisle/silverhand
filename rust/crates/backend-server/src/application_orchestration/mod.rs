//! Cross-context application sagas, daemon command codecs, and post-commit fan-out.
//!
//! The production-settled namespace is closed: daemon delivery remains a separately named
//! compatibility facade at the crate root, while its canonical module and workspace-rename
//! fan-out live here.

pub(crate) mod daemon_delivery;
pub(crate) mod daemon_materialize_codec;
pub mod workspace_rename_fanout;
