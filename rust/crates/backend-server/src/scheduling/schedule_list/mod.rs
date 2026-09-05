//! Internal agent schedule LIST face (`POST /internal/agents/{aid}/schedules/list`).
//!
//! A thin adapter over the existing [`ScheduleListReadModel`] authority, gated by
//! the shared internal-scheduling identity binding. Backend-app composes/mounts it.
//!
//! [`ScheduleListReadModel`]: silverhand_backend_core::conversation_messaging::messaging::schedule::ScheduleListReadModel

pub mod route;
