//! Production owning-host `agent_materialize` adapter.

use std::{error::Error, fmt, time::Duration};

use silverhand_backend_core::agent_materialize::{
    AgentMaterializePort, AgentMaterializeReceipt, AgentMaterializeRefusal, AgentMaterializeTarget,
};

use crate::daemon_delivery::{
    AgentMaterializeRefusalCode, CommandRefusal, DaemonRefusalCode, HostDataPlaneAnswerMismatch,
    HostDataPlaneCommandKind, HostDataPlaneFailure, HostDataPlaneRequest, OwningHostDataPlane,
    agent_materialize_codec,
};

#[derive(Clone)]
pub struct ProductionAgentMaterialize {
    data_plane: OwningHostDataPlane,
    timeout: Duration,
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
        })
    }
}

impl Error for AgentMaterializeFailure {}

impl AgentMaterializePort for ProductionAgentMaterialize {
    type Error = AgentMaterializeFailure;

    async fn materialize(
        &self,
        target: &AgentMaterializeTarget,
    ) -> Result<Result<AgentMaterializeReceipt, AgentMaterializeRefusal>, Self::Error> {
        let params = agent_materialize_codec::encode(target)
            .map_err(|_| AgentMaterializeFailure::InvalidRequest)?;
        let Some(custody) = self
            .data_plane
            .resolve(target.host())
            .map_err(|_| AgentMaterializeFailure::RegistryUnavailable)?
        else {
            return Ok(Err(AgentMaterializeRefusal::HostAttachPending));
        };
        materialize_captured(&self.data_plane, custody, params, self.timeout).await
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
            kind: HostDataPlaneCommandKind::AgentMaterialize,
            params,
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
        CommandRefusal::AgentMaterializeScoped(code) => Some(match code {
            AgentMaterializeRefusalCode::AgentDeleting => AgentMaterializeRefusal::AgentDeleting,
            AgentMaterializeRefusalCode::FsQuotaExceeded => {
                AgentMaterializeRefusal::FsQuotaExceeded
            }
            AgentMaterializeRefusalCode::FsUnavailable => AgentMaterializeRefusal::FsUnavailable,
            AgentMaterializeRefusalCode::AgentDirCollision => {
                AgentMaterializeRefusal::AgentDirCollision
            }
            AgentMaterializeRefusalCode::UnsupportedTemplate => {
                AgentMaterializeRefusal::UnsupportedTemplate
            }
            AgentMaterializeRefusalCode::UnsupportedRuntime => {
                AgentMaterializeRefusal::UnsupportedRuntime
            }
        }),
        CommandRefusal::Response(DaemonRefusalCode::ShuttingDown) => {
            Some(AgentMaterializeRefusal::DaemonShuttingDown)
        }
        CommandRefusal::Response(
            DaemonRefusalCode::UnknownIntent
            | DaemonRefusalCode::InvalidParams
            | DaemonRefusalCode::InternalError
            | DaemonRefusalCode::RequestTooLarge,
        ) => Some(AgentMaterializeRefusal::DaemonInternalError),
        CommandRefusal::RuntimeScoped(_) | CommandRefusal::AgentFilesPurgeScoped(_) => None,
    }
}
