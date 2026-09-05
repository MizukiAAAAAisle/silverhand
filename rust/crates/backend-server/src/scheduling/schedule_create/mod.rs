//! Internal agent schedule CREATE — the C5 HTTP boundary over
//! `POST /internal/agents/{aid}/schedules`.
//!
//! The thin adapter for the create face: inbound wire admission ([`admission`])
//! into the core
//! [`ScheduleCreateRequest`](silverhand_backend_core::conversation_messaging::messaging::schedule::ScheduleCreateRequest),
//! the resolved-destination + capability admission consumed as the scheduling-owned
//! narrow [`ports`], the [`route`] handler that sequences them (resolve → capability
//! → core plan → atomic insert), and the status/error mapping. The already-mounted
//! public list/cancel faces live in the sibling [`super::schedule_management`]
//! module; this leaf adds no route registration (backend-app composes/mounts).

mod admission;
pub mod ports;
pub mod route;
