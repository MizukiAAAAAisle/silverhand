//! Production `AgentProfileMcpDataPlane` over persisted placement and the one
//! owning-host correlated-RPC authority.
//!
//! Each operation first reads one source-bound `{agent, host, deleting}` fact.
//! Deleting agents short-circuit before the live registry is touched. Active
//! facts capture exact host/daemon/connection custody once; command-specific
//! codecs then pair one existing wire kind with its exact params/result schema.

use std::time::Duration;

use serde_json::Value;
use silverhand_backend_core::{
    foundation::identity::AgentId,
    identity_access::agent_profile_mcp::{
        AgentProfileMcpDataPlane, AgentProfileMcpPlacementRead, McpBytesWritten, McpDataPlaneFault,
        McpDataPlaneFaultCode, McpProbeCommand, McpProbeOutcome,
    },
};

use crate::daemon_delivery::{
    CommandRefusal, HostDataPlaneAnswerMismatch, HostDataPlaneCustody, HostDataPlaneFailure,
    HostDataPlaneRequest, OwningHostDataPlane, command,
};
use crate::identity_access::daemon_profile_mcp_codec as agent_profile_mcp_codec;

const PROFILE_MCP_TIMEOUT: Duration = Duration::from_secs(30);
const MCP_PROBE_TIMEOUT: Duration = Duration::from_secs(45);

pub(crate) const PROFILE_MCP_READ_CAPABILITY_CODES: [&str; 1] = ["fs_unavailable"];
pub(crate) const PROFILE_MCP_WRITE_CAPABILITY_CODES: [&str; 3] =
    ["fs_unavailable", "invalid_config", "agent_deleting"];
pub(crate) const MCP_PROBE_CAPABILITY_CODES: [&str; 2] = ["fs_unavailable", "agent_deleting"];

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum AgentProfileMcpRefusalCode {
    AgentDeleting,
    FsUnavailable,
    InvalidConfig,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum ProfileMcpOperation {
    Read,
    Write,
    Probe,
}

impl AgentProfileMcpRefusalCode {
    fn parse(operation: ProfileMcpOperation, raw: &str) -> Option<Self> {
        match (operation, raw) {
            (ProfileMcpOperation::Read, "fs_unavailable")
            | (ProfileMcpOperation::Write, "fs_unavailable")
            | (ProfileMcpOperation::Probe, "fs_unavailable") => Some(Self::FsUnavailable),
            (ProfileMcpOperation::Write, "invalid_config") => Some(Self::InvalidConfig),
            (ProfileMcpOperation::Write | ProfileMcpOperation::Probe, "agent_deleting") => {
                Some(Self::AgentDeleting)
            }
            _ => None,
        }
    }
}

pub(crate) fn admits_profile_mcp_read_refusal(raw: &str) -> bool {
    PROFILE_MCP_READ_CAPABILITY_CODES.contains(&raw)
}

pub(crate) fn admits_profile_mcp_write_refusal(raw: &str) -> bool {
    PROFILE_MCP_WRITE_CAPABILITY_CODES.contains(&raw)
}

pub(crate) fn admits_mcp_probe_refusal(raw: &str) -> bool {
    MCP_PROBE_CAPABILITY_CODES.contains(&raw)
}

#[derive(Clone)]
pub struct ProductionAgentProfileMcpDataPlane<P> {
    placements: P,
    data_plane: OwningHostDataPlane,
    profile_timeout: Duration,
    probe_timeout: Duration,
}

impl<C, D, H> crate::daemon_delivery::DaemonDeliveryRuntime<C, D, H> {
    pub fn agent_profile_mcp_data_plane<P>(
        &self,
        placements: P,
    ) -> ProductionAgentProfileMcpDataPlane<P>
    where
        P: silverhand_backend_core::identity_access::agent_profile_mcp::AgentProfileMcpPlacementRead,
    {
        ProductionAgentProfileMcpDataPlane::new(placements, self.owning_host_data_plane())
    }
}

impl<P> ProductionAgentProfileMcpDataPlane<P> {
    pub(crate) fn new(placements: P, data_plane: OwningHostDataPlane) -> Self {
        Self {
            placements,
            data_plane,
            profile_timeout: PROFILE_MCP_TIMEOUT,
            probe_timeout: MCP_PROBE_TIMEOUT,
        }
    }
}

impl<P> ProductionAgentProfileMcpDataPlane<P>
where
    P: AgentProfileMcpPlacementRead,
{
    async fn capture(
        &self,
        requested: &AgentId,
    ) -> Result<HostDataPlaneCustody, McpDataPlaneFault> {
        let placement = self
            .placements
            .read_mcp_placement(requested)
            .await
            .map_err(|_| fault(McpDataPlaneFaultCode::DaemonInternalError))?
            .ok_or_else(|| fault(McpDataPlaneFaultCode::DaemonInternalError))?;
        if placement.source() != requested {
            return Err(fault(McpDataPlaneFaultCode::DaemonInternalError));
        }
        if placement.deletion_pending() {
            return Err(fault(McpDataPlaneFaultCode::AgentDeleting));
        }
        self.data_plane
            .resolve(placement.host())
            .map_err(|_| fault(McpDataPlaneFaultCode::DaemonInternalError))?
            .ok_or_else(|| fault(McpDataPlaneFaultCode::HostAttachPending))
    }
}

impl<P> AgentProfileMcpDataPlane for ProductionAgentProfileMcpDataPlane<P>
where
    P: AgentProfileMcpPlacementRead,
{
    async fn read_config(&self, agent: &AgentId) -> Result<Option<String>, McpDataPlaneFault> {
        let custody = self.capture(agent).await?;
        read_captured(&self.data_plane, custody, agent, self.profile_timeout).await
    }

    async fn write_config(
        &self,
        agent: &AgentId,
        raw: &str,
    ) -> Result<McpBytesWritten, McpDataPlaneFault> {
        let custody = self.capture(agent).await?;
        write_captured(&self.data_plane, custody, agent, raw, self.profile_timeout).await
    }

    async fn probe(
        &self,
        agent: &AgentId,
        command: &McpProbeCommand,
    ) -> Result<McpProbeOutcome, McpDataPlaneFault> {
        let custody = self.capture(agent).await?;
        probe_captured(
            &self.data_plane,
            custody,
            agent,
            command,
            self.probe_timeout,
        )
        .await
    }
}

pub(crate) async fn read_captured(
    data_plane: &OwningHostDataPlane,
    custody: HostDataPlaneCustody,
    agent: &AgentId,
    timeout: Duration,
) -> Result<Option<String>, McpDataPlaneFault> {
    let result = dispatch_captured(
        data_plane,
        custody,
        command::agent_profile_mcp_read(
            agent_profile_mcp_codec::encode_read(agent),
            admits_profile_mcp_read_refusal,
        ),
        ProfileMcpOperation::Read,
        timeout,
    )
    .await?;
    agent_profile_mcp_codec::decode_read(&result)
        .ok_or_else(|| fault(McpDataPlaneFaultCode::DaemonInternalError))
}

pub(crate) async fn write_captured(
    data_plane: &OwningHostDataPlane,
    custody: HostDataPlaneCustody,
    agent: &AgentId,
    raw: &str,
    timeout: Duration,
) -> Result<McpBytesWritten, McpDataPlaneFault> {
    let result = dispatch_captured(
        data_plane,
        custody,
        command::agent_profile_mcp_write(
            agent_profile_mcp_codec::encode_write(agent, raw),
            admits_profile_mcp_write_refusal,
        ),
        ProfileMcpOperation::Write,
        timeout,
    )
    .await?;
    agent_profile_mcp_codec::decode_write(&result)
        .ok_or_else(|| fault(McpDataPlaneFaultCode::DaemonInternalError))
}

pub(crate) async fn probe_captured(
    data_plane: &OwningHostDataPlane,
    custody: HostDataPlaneCustody,
    agent: &AgentId,
    command: &McpProbeCommand,
    timeout: Duration,
) -> Result<McpProbeOutcome, McpDataPlaneFault> {
    let result = dispatch_captured(
        data_plane,
        custody,
        command::mcp_probe(
            agent_profile_mcp_codec::encode_probe(agent, command),
            admits_mcp_probe_refusal,
        ),
        ProfileMcpOperation::Probe,
        timeout,
    )
    .await?;
    agent_profile_mcp_codec::decode_probe(&result)
        .ok_or_else(|| fault(McpDataPlaneFaultCode::DaemonInternalError))
}

async fn dispatch_captured(
    data_plane: &OwningHostDataPlane,
    custody: HostDataPlaneCustody,
    command: command::EncodedDaemonCommand,
    operation: ProfileMcpOperation,
    timeout: Duration,
) -> Result<Value, McpDataPlaneFault> {
    let expected = custody.clone();
    let answer = data_plane
        .dispatch(HostDataPlaneRequest {
            custody,
            command,
            timeout,
        })
        .await
        .map_err(|failure| map_failure(operation, failure))?;
    answer
        .into_result_for(&expected)
        .map_err(|_mismatch: HostDataPlaneAnswerMismatch| {
            fault(McpDataPlaneFaultCode::DaemonInternalError)
        })
}

fn map_failure(operation: ProfileMcpOperation, failure: HostDataPlaneFailure) -> McpDataPlaneFault {
    match failure {
        HostDataPlaneFailure::NoCurrentDaemon
        | HostDataPlaneFailure::ConnectionGenerationMismatch
        | HostDataPlaneFailure::DaemonInstanceMismatch => {
            fault(McpDataPlaneFaultCode::HostAttachPending)
        }
        HostDataPlaneFailure::TimedOut => fault(McpDataPlaneFaultCode::DaemonTimeout),
        HostDataPlaneFailure::Refused(CommandRefusal::Capability(refusal)) => {
            let code = match AgentProfileMcpRefusalCode::parse(operation, refusal.code()) {
                Some(AgentProfileMcpRefusalCode::FsUnavailable) => {
                    McpDataPlaneFaultCode::FsUnavailable
                }
                Some(AgentProfileMcpRefusalCode::InvalidConfig) => {
                    McpDataPlaneFaultCode::InvalidConfig
                }
                Some(AgentProfileMcpRefusalCode::AgentDeleting) => {
                    McpDataPlaneFaultCode::AgentDeleting
                }
                None => McpDataPlaneFaultCode::DaemonInternalError,
            };
            fault(code)
        }
        HostDataPlaneFailure::NotDispatched
        | HostDataPlaneFailure::Ambiguous
        | HostDataPlaneFailure::ProtocolCorruption
        | HostDataPlaneFailure::RegistryUnavailable
        | HostDataPlaneFailure::Refused(_) => fault(McpDataPlaneFaultCode::DaemonInternalError),
    }
}

/// Product-authored stable messages only. The daemon's arbitrary `message`
/// string is intentionally discarded at refusal decode and cannot cross the
/// typed port.
fn fault(code: McpDataPlaneFaultCode) -> McpDataPlaneFault {
    let message = match code {
        McpDataPlaneFaultCode::HostAttachPending => "host runtime is not currently attached",
        McpDataPlaneFaultCode::DaemonTimeout => "daemon request timed out",
        McpDataPlaneFaultCode::DaemonInternalError => "daemon request failed",
        McpDataPlaneFaultCode::FsUnavailable => "agent MCP storage is unavailable",
        McpDataPlaneFaultCode::InvalidConfig => "daemon rejected the MCP config",
        McpDataPlaneFaultCode::AgentDeleting => "agent is being deleted",
    };
    McpDataPlaneFault {
        code,
        message: message.to_owned(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::daemon_delivery::DaemonRefusalCode;

    #[test]
    fn every_transport_and_refusal_arm_maps_into_the_closed_product_taxonomy() {
        let cases = [
            (
                ProfileMcpOperation::Read,
                HostDataPlaneFailure::NoCurrentDaemon,
                McpDataPlaneFaultCode::HostAttachPending,
            ),
            (
                ProfileMcpOperation::Write,
                HostDataPlaneFailure::TimedOut,
                McpDataPlaneFaultCode::DaemonTimeout,
            ),
            (
                ProfileMcpOperation::Read,
                HostDataPlaneFailure::Refused(CommandRefusal::capability("fs_unavailable")),
                McpDataPlaneFaultCode::FsUnavailable,
            ),
            (
                ProfileMcpOperation::Write,
                HostDataPlaneFailure::Refused(CommandRefusal::capability("invalid_config")),
                McpDataPlaneFaultCode::InvalidConfig,
            ),
            (
                ProfileMcpOperation::Probe,
                HostDataPlaneFailure::Refused(CommandRefusal::capability("agent_deleting")),
                McpDataPlaneFaultCode::AgentDeleting,
            ),
            (
                ProfileMcpOperation::Read,
                HostDataPlaneFailure::Refused(CommandRefusal::Response(
                    DaemonRefusalCode::InternalError,
                )),
                McpDataPlaneFaultCode::DaemonInternalError,
            ),
            (
                ProfileMcpOperation::Probe,
                HostDataPlaneFailure::Refused(CommandRefusal::capability("registry_unavailable")),
                McpDataPlaneFaultCode::DaemonInternalError,
            ),
            (
                ProfileMcpOperation::Read,
                HostDataPlaneFailure::ProtocolCorruption,
                McpDataPlaneFaultCode::DaemonInternalError,
            ),
        ];

        for (kind, failure, expected) in cases {
            let mapped = map_failure(kind, failure);
            assert_eq!(mapped.code, expected);
            assert!(
                !mapped.message.contains("upstream") && !mapped.message.contains("secret"),
                "messages are product-authored, never daemon strings"
            );
        }
    }
}
