//! The schedule-management faces render through the shared scheduling wire
//! projection. The `ScheduleDto` shape lives once in [`super::super::wire`]
//! (`scheduling::wire`) so list, cancel, and create serialize a `ScheduleView`
//! identically; this re-export keeps the module's existing `wire::ScheduleDto`
//! path stable for the list/cancel handlers.

pub(super) use crate::scheduling::wire::ScheduleDto;
