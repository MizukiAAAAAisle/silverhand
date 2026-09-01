//! SQLite attachment read models and write units of work.

mod agent;
mod read;
mod write;

pub use agent::{AgentAttachmentStoreError, SqliteAgentAttachment};
pub use read::{AttachmentReadStoreError, SqliteAttachmentRead};
// The agent-audit attachment face reuses the by-id row load + strict decode, then
// binds the row to its audited conversation itself.
pub(crate) use read::load_attachment;
pub use write::{AttachmentWriteStoreError, SqliteAttachmentWrite};
