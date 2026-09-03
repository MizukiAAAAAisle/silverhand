//! Internal agent schedule CANCEL face (`POST /internal/agents/{aid}/schedules/cancel`).
//!
//! A thin adapter over the existing [`ScheduleCancelUnitOfWork`] authority, gated by
//! the shared internal-scheduling identity binding. Backend-app composes/mounts it.
//!
//! [`ScheduleCancelUnitOfWork`]: silverhand_backend_core::conversation_messaging::messaging::schedule::ScheduleCancelUnitOfWork

pub mod route;
