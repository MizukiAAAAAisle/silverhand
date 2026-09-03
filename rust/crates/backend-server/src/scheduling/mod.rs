//! Agent-scoped scheduling HTTP surfaces.
//!
//! Route registration remains owned by the backend application composition root; this
//! namespace owns only C5's scheduling boundary.

pub mod schedule_cancel;
pub mod schedule_create;
pub mod schedule_list;
pub mod schedule_management;
pub(crate) mod wire;
