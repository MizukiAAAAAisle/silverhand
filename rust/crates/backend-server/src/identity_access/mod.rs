//! Identity/access transport adapters and agent-owned profile capabilities.
//!
//! Access governance, identity/session authentication, profile and avatar custody, shared wire
//! projection, and workspace membership/metadata remain independent leaves; complete production
//! colocation here does not merge their contracts or responsibilities.

pub mod access;
pub mod agent_audit;
pub mod agent_avatar;
pub mod agent_avatar_write;
pub mod agent_detail;
pub mod agent_list;
pub mod agent_name_availability;
pub mod agent_patch;
pub mod agent_profile_mcp_data_plane;
pub(crate) mod agent_wire;
pub mod auth;
pub mod avatar_blob;
pub(crate) mod daemon_profile_mcp_codec;
pub mod human_auth;
pub mod password_hasher;
pub mod public_profile_mcp;
pub mod scope_event_publishers;
pub mod users;
pub mod workspace_detail;
pub mod workspace_metadata_write;
pub mod workspace_name_availability;
pub mod workspaces;
