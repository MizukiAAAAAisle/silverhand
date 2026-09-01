//! Production owning-host `agent_materialize` adapter.

use std::{error::Error, fmt, time::Duration};

use silverhand_backend_core::host_runtime::agent_materialize::{
    AgentMaterializePort, AgentMaterializeReceipt, AgentMaterializeRefusal, AgentMaterializeTarget,
};

use crate::application_orchestration::daemon_materialize_codec as agent_materialize_codec;
use crate::daemon_delivery::{
    CommandRefusal, DaemonRefusalCode, HostDataPlaneAnswerMismatch, HostDataPlaneFailure,
    HostDataPlaneRequest, OwningHostDataPlane, command,
};

pub(crate) const AGENT_MATERIALIZE_CAPABILITY_CODES: [&str; 6] = [
    "agent_deleting",
    "fs_quota_exceeded",
    "fs_unavailable",
    "agent_dir_collision",
    "unsupported_template",
    "unsupported_runtime",
];

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum AgentMaterializeRefusalCode {
    AgentDeleting,
    FsQuotaExceeded,
    FsUnavailable,
    AgentDirCollision,
    UnsupportedTemplate,
    UnsupportedRuntime,
}

impl AgentMaterializeRefusalCode {
    fn parse(raw: &str) -> Option<Self> {
        match raw {
            "agent_deleting" => Some(Self::AgentDeleting),
            "fs_quota_exceeded" => Some(Self::FsQuotaExceeded),
            "fs_unavailable" => Some(Self::FsUnavailable),
            "agent_dir_collision" => Some(Self::AgentDirCollision),
            "unsupported_template" => Some(Self::UnsupportedTemplate),
            "unsupported_runtime" => Some(Self::UnsupportedRuntime),
            _ => None,
        }
    }
}

pub(crate) fn admits_agent_materialize_refusal(raw: &str) -> bool {
    AGENT_MATERIALIZE_CAPABILITY_CODES.contains(&raw)
}

#[derive(Clone)]
pub struct ProductionAgentMaterialize {
    data_plane: OwningHostDataPlane,
    timeout: Duration,
}

impl<C, D, H> crate::daemon_delivery::DaemonDeliveryRuntime<C, D, H> {
    pub fn agent_materialize(&self) -> ProductionAgentMaterialize {
        ProductionAgentMaterialize::new(self.owning_host_data_plane(), self.command_timeout())
    }
}

impl ProductionAgentMaterialize {
    pub(crate) fn new(data_plane: OwningHostDataPlane, timeout: Duration) -> Self {
        Self {
            data_plane,
            timeout,
        }
    }
}

#[derive(Debug)]
pub enum AgentMaterializeFailure {
    InvalidRequest,
    RegistryUnavailable,
    NotDispatched,
    Ambiguous,
    ProtocolCorruption,
    AuthorityMismatch,
    TargetCrossedCustody,
}

impl fmt::Display for AgentMaterializeFailure {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::InvalidRequest => "agent materialize request is outside the command schema",
            Self::RegistryUnavailable => "daemon attachment registry is unavailable",
            Self::NotDispatched => "agent materialize was proven not dispatched",
            Self::Ambiguous => "agent materialize outcome is ambiguous",
            Self::ProtocolCorruption => "daemon returned an invalid agent materialize response",
            Self::AuthorityMismatch => "agent materialize answer crossed its captured custody",
            Self::TargetCrossedCustody => {
                "agent materialize target names a different host than the captured custody"
            }
        })
    }
}

impl Error for AgentMaterializeFailure {}

impl AgentMaterializePort for ProductionAgentMaterialize {
    type Error = AgentMaterializeFailure;
    type Captured = crate::daemon_delivery::HostDataPlaneCustody;

    async fn capture(
        &self,
        host: &silverhand_backend_core::identity::HostId,
    ) -> Result<Option<Self::Captured>, Self::Error> {
        // The single attachment truth: `resolve` answers `Some` custody exactly when a daemon
        // owns the host right now. The saga holds this custody across its reserve write and
        // hands it back to `materialize`, so the command lands on this exact daemon instance,
        // never a replacement that attached in between.
        self.data_plane
            .resolve(host)
            .map_err(|_| AgentMaterializeFailure::RegistryUnavailable)
    }

    async fn materialize(
        &self,
        captured: Self::Captured,
        target: &AgentMaterializeTarget,
    ) -> Result<Result<AgentMaterializeReceipt, AgentMaterializeRefusal>, Self::Error> {
        // The captured custody is bound to ONE host; a target naming a different host would
        // dispatch its params to the wrong daemon (the answer-side `into_result_for` bind
        // only protects the reply, not the command). The saga always pairs them from one
        // resolved host, so a divergence is a caller fault, not a product outcome.
        if captured.host() != target.host() {
            return Err(AgentMaterializeFailure::TargetCrossedCustody);
        }
        let params = agent_materialize_codec::encode(target)
            .map_err(|_| AgentMaterializeFailure::InvalidRequest)?;
        materialize_captured(&self.data_plane, captured, params, self.timeout).await
    }
}

pub(crate) async fn materialize_captured(
    data_plane: &OwningHostDataPlane,
    custody: crate::daemon_delivery::HostDataPlaneCustody,
    params: serde_json::Value,
    timeout: Duration,
) -> Result<Result<AgentMaterializeReceipt, AgentMaterializeRefusal>, AgentMaterializeFailure> {
    let expected = custody.clone();
    let answer = data_plane
        .dispatch(HostDataPlaneRequest {
            custody,
            command: command::agent_materialize(params, admits_agent_materialize_refusal),
            timeout,
        })
        .await;
    let answer = match answer {
        Ok(answer) => answer,
        Err(
            HostDataPlaneFailure::NoCurrentDaemon
            | HostDataPlaneFailure::ConnectionGenerationMismatch
            | HostDataPlaneFailure::DaemonInstanceMismatch,
        ) => return Ok(Err(AgentMaterializeRefusal::HostAttachPending)),
        Err(HostDataPlaneFailure::NotDispatched) => {
            return Err(AgentMaterializeFailure::NotDispatched);
        }
        Err(HostDataPlaneFailure::Ambiguous) => {
            return Err(AgentMaterializeFailure::Ambiguous);
        }
        Err(HostDataPlaneFailure::TimedOut) => {
            // Dispatched but unacknowledged within the deadline: a product outcome
            // (`materialize_timeout` → 504), not a transport fault. The reserved row
            // is left pending and the create is retryable, exactly like the other
            // refusals.
            return Ok(Err(AgentMaterializeRefusal::MaterializeTimeout));
        }
        Err(HostDataPlaneFailure::RegistryUnavailable) => {
            return Err(AgentMaterializeFailure::RegistryUnavailable);
        }
        Err(HostDataPlaneFailure::ProtocolCorruption) => {
            return Err(AgentMaterializeFailure::ProtocolCorruption);
        }
        Err(HostDataPlaneFailure::Refused(refusal)) => {
            return map_refusal(refusal).map_or_else(
                || Err(AgentMaterializeFailure::ProtocolCorruption),
                |refusal| Ok(Err(refusal)),
            );
        }
    };
    let result =
        answer
            .into_result_for(&expected)
            .map_err(|_mismatch: HostDataPlaneAnswerMismatch| {
                AgentMaterializeFailure::AuthorityMismatch
            })?;
    agent_materialize_codec::decode_result(&result)
        .map(Ok)
        .ok_or(AgentMaterializeFailure::ProtocolCorruption)
}

fn map_refusal(refusal: CommandRefusal) -> Option<AgentMaterializeRefusal> {
    match refusal {
        CommandRefusal::Capability(refusal) => {
            let code = AgentMaterializeRefusalCode::parse(refusal.code())?;
            Some(match code {
                AgentMaterializeRefusalCode::AgentDeleting => {
                    AgentMaterializeRefusal::AgentDeleting
                }
                AgentMaterializeRefusalCode::FsQuotaExceeded => {
                    AgentMaterializeRefusal::FsQuotaExceeded
                }
                AgentMaterializeRefusalCode::FsUnavailable => {
                    AgentMaterializeRefusal::FsUnavailable
                }
                AgentMaterializeRefusalCode::AgentDirCollision => {
                    AgentMaterializeRefusal::AgentDirCollision
                }
                AgentMaterializeRefusalCode::UnsupportedTemplate => {
                    AgentMaterializeRefusal::UnsupportedTemplate
                }
                AgentMaterializeRefusalCode::UnsupportedRuntime => {
                    AgentMaterializeRefusal::UnsupportedRuntime
                }
            })
        }
        CommandRefusal::Response(DaemonRefusalCode::ShuttingDown) => {
            Some(AgentMaterializeRefusal::DaemonShuttingDown)
        }
        CommandRefusal::Response(
            DaemonRefusalCode::UnknownIntent
            | DaemonRefusalCode::InvalidParams
            | DaemonRefusalCode::InternalError
            | DaemonRefusalCode::RequestTooLarge,
        ) => Some(AgentMaterializeRefusal::DaemonInternalError),
    }
}
