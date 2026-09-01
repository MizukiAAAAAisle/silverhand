//! `identity_access` — the C1 (Identity & Access) business-owner namespace.
//!
//! A namespace container, not a business unit of its own: it groups the crate
//! roots the organization map assigns to owner `C1` under a single Rust module
//! path (`crate::identity_access::*`). It declares its members and holds no
//! domain logic itself.

pub mod access;
pub mod agent_avatar;
pub mod agent_avatar_write;
pub mod agent_detail_read;
pub mod agent_list_read;
pub mod agent_peer_profile;
pub mod agent_profile_read;
pub mod agent_profile_write;
pub mod auth;
pub mod avatar;
pub mod capability;
pub mod credential;
pub mod human_auth_flows;
pub mod internal_profile_write;
pub mod mcp_config;
pub mod participant_handle_availability;
pub mod user_identity;
pub mod workspace_cold_read;
pub mod workspace_detail_read;
pub mod workspace_face;
pub mod workspace_metadata_write;
pub mod workspace_name;
pub mod workspace_name_availability;
