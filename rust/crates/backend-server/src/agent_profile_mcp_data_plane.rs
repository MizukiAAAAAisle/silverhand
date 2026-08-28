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
    agent_profile_mcp::{
        AgentProfileMcpDataPlane, AgentProfileMcpPlacementRead, McpBytesWritten, McpDataPlaneFault,
        McpDataPlaneFaultCode, McpProbeCommand, McpProbeOutcome,
    },
    identity::AgentId,
};

use crate::daemon_delivery::{
    AgentProfileMcpRefusalCode, CommandRefusal, HostDataPlaneAnswerMismatch,
    HostDataPlaneCommandKind, HostDataPlaneCustody, HostDataPlaneFailure, HostDataPlaneRequest,
    OwningHostDataPlane, agent_profile_mcp_codec,
};

const PROFILE_MCP_TIMEOUT: Duration = Duration::from_secs(30);
const MCP_PROBE_TIMEOUT: Duration = Duration::from_secs(45);

#[derive(Clone)]
pub struct ProductionAgentProfileMcpDataPlane<P> {
    placements: P,
    data_plane: OwningHostDataPlane,
    profile_timeout: Duration,
    probe_timeout: Duration,
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
        HostDataPlaneCommandKind::AgentProfileMcpRead,
        agent_profile_mcp_codec::encode_read(agent),
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
        HostDataPlaneCommandKind::AgentProfileMcpWrite,
        agent_profile_mcp_codec::encode_write(agent, raw),
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
        HostDataPlaneCommandKind::McpProbe,
        agent_profile_mcp_codec::encode_probe(agent, command),
        timeout,
    )
    .await?;
    agent_profile_mcp_codec::decode_probe(&result)
        .ok_or_else(|| fault(McpDataPlaneFaultCode::DaemonInternalError))
}

async fn dispatch_captured(
    data_plane: &OwningHostDataPlane,
    custody: HostDataPlaneCustody,
    kind: HostDataPlaneCommandKind,
    params: Value,
    timeout: Duration,
) -> Result<Value, McpDataPlaneFault> {
    let expected = custody.clone();
    let answer = data_plane
        .dispatch(HostDataPlaneRequest {
            custody,
            kind,
            params,
            timeout,
        })
        .await
        .map_err(|failure| map_failure(kind, failure))?;
    answer
        .into_result_for(&expected)
        .map_err(|_mismatch: HostDataPlaneAnswerMismatch| {
            fault(McpDataPlaneFaultCode::DaemonInternalError)
        })
}

fn map_failure(kind: HostDataPlaneCommandKind, failure: HostDataPlaneFailure) -> McpDataPlaneFault {
    match failure {
        HostDataPlaneFailure::NoCurrentDaemon
        | HostDataPlaneFailure::ConnectionGenerationMismatch
        | HostDataPlaneFailure::DaemonInstanceMismatch => {
            fault(McpDataPlaneFaultCode::HostAttachPending)
        }
        HostDataPlaneFailure::TimedOut => fault(McpDataPlaneFaultCode::DaemonTimeout),
        HostDataPlaneFailure::Refused(CommandRefusal::AgentProfileMcpScoped(code)) => {
            let code = match (kind, code) {
                (
                    HostDataPlaneCommandKind::AgentProfileMcpRead
                    | HostDataPlaneCommandKind::AgentProfileMcpWrite
                    | HostDataPlaneCommandKind::McpProbe,
                    AgentProfileMcpRefusalCode::FsUnavailable,
                ) => McpDataPlaneFaultCode::FsUnavailable,
                (
                    HostDataPlaneCommandKind::AgentProfileMcpWrite,
                    AgentProfileMcpRefusalCode::InvalidConfig,
                ) => McpDataPlaneFaultCode::InvalidConfig,
                (
                    HostDataPlaneCommandKind::AgentProfileMcpWrite
                    | HostDataPlaneCommandKind::McpProbe,
                    AgentProfileMcpRefusalCode::AgentDeleting,
                ) => McpDataPlaneFaultCode::AgentDeleting,
                _ => McpDataPlaneFaultCode::DaemonInternalError,
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
    use crate::daemon_delivery::{DaemonRefusalCode, RuntimeRefusalCode};

    #[test]
    fn every_transport_and_refusal_arm_maps_into_the_closed_product_taxonomy() {
        let cases = [
            (
                HostDataPlaneCommandKind::AgentProfileMcpRead,
                HostDataPlaneFailure::NoCurrentDaemon,
                McpDataPlaneFaultCode::HostAttachPending,
            ),
            (
                HostDataPlaneCommandKind::AgentProfileMcpWrite,
                HostDataPlaneFailure::TimedOut,
                McpDataPlaneFaultCode::DaemonTimeout,
            ),
            (
                HostDataPlaneCommandKind::AgentProfileMcpRead,
                HostDataPlaneFailure::Refused(CommandRefusal::AgentProfileMcpScoped(
                    AgentProfileMcpRefusalCode::FsUnavailable,
                )),
                McpDataPlaneFaultCode::FsUnavailable,
            ),
            (
                HostDataPlaneCommandKind::AgentProfileMcpWrite,
                HostDataPlaneFailure::Refused(CommandRefusal::AgentProfileMcpScoped(
                    AgentProfileMcpRefusalCode::InvalidConfig,
                )),
                McpDataPlaneFaultCode::InvalidConfig,
            ),
            (
                HostDataPlaneCommandKind::McpProbe,
                HostDataPlaneFailure::Refused(CommandRefusal::AgentProfileMcpScoped(
                    AgentProfileMcpRefusalCode::AgentDeleting,
                )),
                McpDataPlaneFaultCode::AgentDeleting,
            ),
            (
                HostDataPlaneCommandKind::AgentProfileMcpRead,
                HostDataPlaneFailure::Refused(CommandRefusal::Response(
                    DaemonRefusalCode::InternalError,
                )),
                McpDataPlaneFaultCode::DaemonInternalError,
            ),
            (
                HostDataPlaneCommandKind::McpProbe,
                HostDataPlaneFailure::Refused(CommandRefusal::RuntimeScoped(
                    RuntimeRefusalCode::RegistryUnavailable,
                )),
                McpDataPlaneFaultCode::DaemonInternalError,
            ),
            (
                HostDataPlaneCommandKind::AgentProfileMcpRead,
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
