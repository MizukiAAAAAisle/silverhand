//! Workspace-rooted channel-directory contracts.
//!
//! The URL is workspace-shaped, but the projected rows are conversation facts.
//! Active, workspace-archived and global-archived reads stay operation-specific;
//! their different visibility sets cannot be interchanged by a port.

mod create;
mod read;

pub use create::*;
pub use read::*;
