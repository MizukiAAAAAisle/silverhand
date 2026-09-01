//! Production `WorkspaceDataPlane` over the one owning-host correlated-RPC
//! authority.
//!
//! Each read resolves the agent's host custody once from the live registry, then
//! pairs the workspace command kind with its exact params/result codec. The daemon
//! is the sole virtual-path authority, so `path` crosses verbatim and its
//! `forbidden_path`/`not_found` verdicts are the daemon's own, folded here into the
//! closed product taxonomy. Every transport failure, unrecognized refusal, or
//! malformed answer converges to `daemon_internal_error`/`502` — never a panic.

use std::time::Duration;

use serde_json::Value;
use silverhand_backend_core::{
    foundation::identity::{AgentId, HostId, WorkspaceId},
    workspace_data_plane::{
        WorkspaceDataPlane, WorkspaceFileRead, WorkspaceFsFault, WorkspaceFsFaultCode,
        WorkspaceTree,
    },
};

use crate::daemon_delivery::{
    CommandRefusal, HostDataPlaneAnswerMismatch, HostDataPlaneCustody, HostDataPlaneFailure,
    HostDataPlaneRequest, OwningHostDataPlane, command,
};

use super::codec;

/// TS `INDEX_TIMEOUT_MS`/`READ_TIMEOUT_MS` — both reads share one 30s budget.
const WORKSPACE_FS_TIMEOUT: Duration = Duration::from_secs(30);

pub(crate) const WORKSPACE_FS_CAPABILITY_CODES: [&str; 4] = [
    "fs_unavailable",
    "registry_unavailable",
    "forbidden_path",
    "not_found",
];

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum AgentWorkspaceFsRefusalCode {
    FsUnavailable,
    RegistryUnavailable,
    ForbiddenPath,
    NotFound,
}

impl AgentWorkspaceFsRefusalCode {
    fn parse(raw: &str) -> Option<Self> {
        match raw {
            "fs_unavailable" => Some(Self::FsUnavailable),
            "registry_unavailable" => Some(Self::RegistryUnavailable),
            "forbidden_path" => Some(Self::ForbiddenPath),
            "not_found" => Some(Self::NotFound),
            _ => None,
        }
    }
}

pub(crate) fn admits_workspace_fs_refusal(raw: &str) -> bool {
    WORKSPACE_FS_CAPABILITY_CODES.contains(&raw)
}

/// Holds no placement authority: the host coordinate is supplied per call by the
/// route off the agent row it already read, so this plane only owns the one live
/// attachment registry.
#[derive(Clone)]
pub struct ProductionWorkspaceDataPlane {
    data_plane: OwningHostDataPlane,
    timeout: Duration,
}

impl<C, D, H> crate::daemon_delivery::DaemonDeliveryRuntime<C, D, H> {
    pub fn workspace_data_plane(&self) -> ProductionWorkspaceDataPlane {
        ProductionWorkspaceDataPlane::new(self.owning_host_data_plane())
    }
}

impl ProductionWorkspaceDataPlane {
    pub(crate) fn new(data_plane: OwningHostDataPlane) -> Self {
        Self {
            data_plane,
            timeout: WORKSPACE_FS_TIMEOUT,
        }
    }

    /// Resolve the agent's host custody once. A registry that cannot be read is a
    /// `500`; an offline host is the ordinary `host_attach_pending` (`503`).
    fn capture(&self, host: &HostId) -> Result<HostDataPlaneCustody, WorkspaceFsFault> {
        self.data_plane
            .resolve(host)
            .map_err(|_| fault(WorkspaceFsFaultCode::DaemonInternalError))?
            .ok_or_else(|| fault(WorkspaceFsFaultCode::HostAttachPending))
    }
}

impl WorkspaceDataPlane for ProductionWorkspaceDataPlane {
    async fn read_tree(
        &self,
        agent: &AgentId,
        host: &HostId,
        workspace: Option<&WorkspaceId>,
    ) -> Result<WorkspaceTree, WorkspaceFsFault> {
        let custody = self.capture(host)?;
        let result = dispatch_captured(
            &self.data_plane,
            custody,
            command::agent_workspace_tree(
                codec::encode_tree(agent, workspace),
                admits_workspace_fs_refusal,
            ),
            self.timeout,
        )
        .await?;
        codec::decode_tree(&result).ok_or_else(|| fault(WorkspaceFsFaultCode::DaemonInternalError))
    }

    async fn read_file(
        &self,
        agent: &AgentId,
        host: &HostId,
        workspace: Option<&WorkspaceId>,
        path: &str,
    ) -> Result<WorkspaceFileRead, WorkspaceFsFault> {
        let custody = self.capture(host)?;
        let result = dispatch_captured(
            &self.data_plane,
            custody,
            command::agent_workspace_file_read(
                codec::encode_file(agent, workspace, path),
                admits_workspace_fs_refusal,
            ),
            self.timeout,
        )
        .await?;
        codec::decode_file(&result).ok_or_else(|| fault(WorkspaceFsFaultCode::DaemonInternalError))
    }
}

async fn dispatch_captured(
    data_plane: &OwningHostDataPlane,
    custody: HostDataPlaneCustody,
    command: command::EncodedDaemonCommand,
    timeout: Duration,
) -> Result<Value, WorkspaceFsFault> {
    let expected = custody.clone();
    let answer = data_plane
        .dispatch(HostDataPlaneRequest {
            custody,
            command,
            timeout,
        })
        .await
        .map_err(map_failure)?;
    answer
        .into_result_for(&expected)
        .map_err(|_mismatch: HostDataPlaneAnswerMismatch| {
            fault(WorkspaceFsFaultCode::DaemonInternalError)
        })
}

/// Fold every transport arm and daemon refusal into the closed product taxonomy.
/// Both wire kinds admit the same four business codes, so the code alone decides
/// the arm; anything the closed set does not admit — a foreign refusal vocabulary,
/// a not-dispatched/ambiguous outcome, a corrupt frame, an unreadable registry —
/// safely converges to `daemon_internal_error`.
fn map_failure(failure: HostDataPlaneFailure) -> WorkspaceFsFault {
    match failure {
        HostDataPlaneFailure::NoCurrentDaemon
        | HostDataPlaneFailure::ConnectionGenerationMismatch
        | HostDataPlaneFailure::DaemonInstanceMismatch => {
            fault(WorkspaceFsFaultCode::HostAttachPending)
        }
        HostDataPlaneFailure::TimedOut => fault(WorkspaceFsFaultCode::DaemonTimeout),
        HostDataPlaneFailure::Refused(CommandRefusal::Capability(refusal)) => {
            let Some(code) = AgentWorkspaceFsRefusalCode::parse(refusal.code()) else {
                return fault(WorkspaceFsFaultCode::DaemonInternalError);
            };
            fault(match code {
                AgentWorkspaceFsRefusalCode::FsUnavailable => WorkspaceFsFaultCode::FsUnavailable,
                AgentWorkspaceFsRefusalCode::RegistryUnavailable => {
                    WorkspaceFsFaultCode::RegistryUnavailable
                }
                AgentWorkspaceFsRefusalCode::ForbiddenPath => WorkspaceFsFaultCode::ForbiddenPath,
                AgentWorkspaceFsRefusalCode::NotFound => WorkspaceFsFaultCode::NotFound,
            })
        }
        HostDataPlaneFailure::NotDispatched
        | HostDataPlaneFailure::Ambiguous
        | HostDataPlaneFailure::ProtocolCorruption
        | HostDataPlaneFailure::RegistryUnavailable
        | HostDataPlaneFailure::Refused(_) => fault(WorkspaceFsFaultCode::DaemonInternalError),
    }
}

/// Product-authored stable messages only. The daemon's arbitrary `message` string
/// is discarded at refusal decode and cannot cross the typed port; only `code` and
/// its HTTP status are the byte-contract.
fn fault(code: WorkspaceFsFaultCode) -> WorkspaceFsFault {
    let message = match code {
        WorkspaceFsFaultCode::HostAttachPending => "host runtime is not currently attached",
        WorkspaceFsFaultCode::DaemonTimeout => "workspace request timed out",
        WorkspaceFsFaultCode::DaemonInternalError => "workspace request failed",
        WorkspaceFsFaultCode::FsUnavailable => "agent workspace storage is unavailable",
        WorkspaceFsFaultCode::RegistryUnavailable => "agent workspace registry is unavailable",
        WorkspaceFsFaultCode::ForbiddenPath => "path is not accessible",
        WorkspaceFsFaultCode::NotFound => "path not found",
    };
    WorkspaceFsFault {
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
                HostDataPlaneFailure::NoCurrentDaemon,
                WorkspaceFsFaultCode::HostAttachPending,
            ),
            (
                HostDataPlaneFailure::ConnectionGenerationMismatch,
                WorkspaceFsFaultCode::HostAttachPending,
            ),
            (
                HostDataPlaneFailure::DaemonInstanceMismatch,
                WorkspaceFsFaultCode::HostAttachPending,
            ),
            (
                HostDataPlaneFailure::TimedOut,
                WorkspaceFsFaultCode::DaemonTimeout,
            ),
            (
                HostDataPlaneFailure::Refused(CommandRefusal::capability("fs_unavailable")),
                WorkspaceFsFaultCode::FsUnavailable,
            ),
            (
                HostDataPlaneFailure::Refused(CommandRefusal::capability("registry_unavailable")),
                WorkspaceFsFaultCode::RegistryUnavailable,
            ),
            (
                HostDataPlaneFailure::Refused(CommandRefusal::capability("forbidden_path")),
                WorkspaceFsFaultCode::ForbiddenPath,
            ),
            (
                HostDataPlaneFailure::Refused(CommandRefusal::capability("not_found")),
                WorkspaceFsFaultCode::NotFound,
            ),
            // A transport registry read failure is distinct from the daemon's own
            // `registry_unavailable` refusal: unreadable custody is our 502, not a
            // product 503.
            (
                HostDataPlaneFailure::RegistryUnavailable,
                WorkspaceFsFaultCode::DaemonInternalError,
            ),
            (
                HostDataPlaneFailure::NotDispatched,
                WorkspaceFsFaultCode::DaemonInternalError,
            ),
            (
                HostDataPlaneFailure::Ambiguous,
                WorkspaceFsFaultCode::DaemonInternalError,
            ),
            (
                HostDataPlaneFailure::ProtocolCorruption,
                WorkspaceFsFaultCode::DaemonInternalError,
            ),
            // A refusal in a vocabulary this family never speaks is not a product
            // answer.
            (
                HostDataPlaneFailure::Refused(CommandRefusal::Response(
                    DaemonRefusalCode::InternalError,
                )),
                WorkspaceFsFaultCode::DaemonInternalError,
            ),
            (
                HostDataPlaneFailure::Refused(CommandRefusal::capability("agent_deleting")),
                WorkspaceFsFaultCode::DaemonInternalError,
            ),
        ];

        for (failure, expected) in cases {
            let mapped = map_failure(failure);
            assert_eq!(mapped.code, expected);
            assert!(
                !mapped.message.is_empty()
                    && !mapped.message.contains("upstream")
                    && !mapped.message.contains("daemon said"),
                "messages are product-authored, never daemon strings"
            );
        }
    }
}
