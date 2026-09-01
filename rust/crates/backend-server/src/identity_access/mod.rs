//! Identity/access transport adapters and agent-owned profile capabilities.
//!
//! Name availability, shared agent wire projection, session authentication, avatar blob
//! custody, password hashing, and workspace-name availability remain independent leaves;
//! colocation here does not merge their contracts or responsibilities.

pub mod agent_name_availability;
pub mod agent_profile_mcp_data_plane;
pub(crate) mod agent_wire;
pub mod auth;
pub mod avatar_blob;
pub(crate) mod daemon_profile_mcp_codec;
pub mod password_hasher;
pub mod scope_event_publishers;
pub mod workspace_name_availability;
