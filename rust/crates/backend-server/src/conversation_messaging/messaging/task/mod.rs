//! The agent task board-list boundary: the one read route that projects an agent's visible
//! tasks, and the leaves it composes.
//!
//! - [`query`] — the `?workspace_id=…&status=…` grammar → the validated list coordinate.
//! - [`wire`] — the single summary projector, the parity of the TS `taskJoinedToSummary`.
//! - [`list`] — the route: resolve the opaque board scope, fetch, trim to the viewer, project.
//!
//! Like the send boundary, this crate defines the route but does not own its process: the
//! composition mounts [`list::task_list_router`] behind the runtime-credential authority and
//! supplies the store that answers the core's board/participation ports.

mod list;
mod query;
mod wire;

pub use list::{TaskListState, task_list_router};
