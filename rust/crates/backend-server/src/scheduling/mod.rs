//! Agent-scoped scheduling HTTP surfaces.
//!
//! Route registration remains owned by the backend application composition root; this
//! namespace owns only C5's scheduling boundary.

pub mod schedule_management;
