//! Compatibility facade; profile-MCP daemon access is owned by identity access.

pub use crate::identity_access::agent_profile_mcp_data_plane::ProductionAgentProfileMcpDataPlane;
#[cfg(test)]
pub(crate) use crate::identity_access::agent_profile_mcp_data_plane::{
    MCP_PROBE_CAPABILITY_CODES, PROFILE_MCP_READ_CAPABILITY_CODES,
    PROFILE_MCP_WRITE_CAPABILITY_CODES, admits_mcp_probe_refusal, admits_profile_mcp_read_refusal,
    admits_profile_mcp_write_refusal, read_captured,
};
