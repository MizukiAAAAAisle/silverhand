//! Production exact-seat runtime stop adapter.
//!
//! Persisted lifecycle decides whether a named host may be touched; only an active
//! host reaches the live attachment registry. The command-specific half then sends
//! the existing `runtime_stop` payload through the shared, generation-bound owning-
//! host data plane.

use std::{error::Error, fmt, time::Duration};

use silverhand_backend_core::{
    foundation::identity::HostId,
    foundation::persistence::PersistenceFailure,
    host_runtime::scope_runtime_stop::{
        ScopeRuntimeStopOutcome, ScopeRuntimeStopPort, ScopeRuntimeStopRefusal,
        ScopeRuntimeStopTarget,
    },
    host_runtime::{
        lifecycle::{HostLifecycleStatus, lifecycle_status},
        read::ComputerReadModel,
    },
};

use crate::application_orchestration::daemon_delivery::{
    HostDataPlaneAnswerMismatch, HostDataPlaneCustody, HostDataPlaneFailure, HostDataPlaneRequest,
    OwningHostDataPlane, command,
};
use crate::host_runtime::daemon_runtime_codecs::runtime_stop::{RuntimeStopCommand, valid_result};

#[derive(Clone)]
pub struct ProductionScopeRuntimeStop<H> {
    computers: H,
    data_plane: OwningHostDataPlane,
    timeout: Duration,
}

impl<C, D, H> crate::application_orchestration::daemon_delivery::DaemonDeliveryRuntime<C, D, H>
where
    H: ComputerReadModel,
{
    pub fn scope_runtime_stop(&self) -> ProductionScopeRuntimeStop<H> {
        ProductionScopeRuntimeStop::new(
            self.host_credentials(),
            self.owning_host_data_plane(),
            self.command_timeout(),
        )
    }
}

impl<H> ProductionScopeRuntimeStop<H> {
    pub(crate) fn new(computers: H, data_plane: OwningHostDataPlane, timeout: Duration) -> Self {
        Self {
            computers,
            data_plane,
            timeout,
        }
    }
}

#[derive(Debug)]
pub enum ScopeRuntimeStopFailure {
    HostRead(PersistenceFailure),
    HostFactsMismatch { expected: HostId, actual: HostId },
    GenerationOutOfWireRange { generation: i64 },
    RegistryUnavailable,
    NotDispatched,
    Ambiguous,
    TimedOut,
    DaemonRefused,
    AuthorityMismatch,
    ProtocolCorruption,
}

impl fmt::Display for ScopeRuntimeStopFailure {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::HostRead(_) => "runtime stop host facts could not be read",
            Self::HostFactsMismatch { .. } => {
                "runtime stop host facts did not match the requested host"
            }
            Self::GenerationOutOfWireRange { .. } => {
                "runtime stop generation is outside the daemon wire range"
            }
            Self::RegistryUnavailable => "runtime stop attachment registry is unavailable",
            Self::NotDispatched => "runtime stop was proven not dispatched",
            Self::Ambiguous => "runtime stop outcome is ambiguous",
            Self::TimedOut => "runtime stop timed out",
            Self::DaemonRefused => "daemon refused runtime stop",
            Self::AuthorityMismatch => "runtime stop answer crossed its captured custody",
            Self::ProtocolCorruption => "daemon returned an invalid runtime stop response",
        })
    }
}

impl Error for ScopeRuntimeStopFailure {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match self {
            Self::HostRead(source) => Some(source),
            _ => None,
        }
    }
}

impl<H> ScopeRuntimeStopPort for ProductionScopeRuntimeStop<H>
where
    H: ComputerReadModel,
{
    type Error = ScopeRuntimeStopFailure;

    async fn hard_stop(
        &self,
        target: &ScopeRuntimeStopTarget,
    ) -> Result<Result<ScopeRuntimeStopOutcome, ScopeRuntimeStopRefusal>, Self::Error> {
        let requested_host = target.host().clone();
        let Some(computer) = self
            .computers
            .read_computer(requested_host.clone())
            .await
            .map_err(ScopeRuntimeStopFailure::HostRead)?
        else {
            return Ok(Err(ScopeRuntimeStopRefusal::HostMissing));
        };
        if computer.id != requested_host {
            return Err(ScopeRuntimeStopFailure::HostFactsMismatch {
                expected: requested_host,
                actual: computer.id,
            });
        }

        match lifecycle_status(&computer.lifecycle()) {
            HostLifecycleStatus::Pending | HostLifecycleStatus::Attached => {
                return Ok(Err(ScopeRuntimeStopRefusal::HostPendingAttach));
            }
            HostLifecycleStatus::Revoked => {
                return Ok(Err(ScopeRuntimeStopRefusal::HostRevoked));
            }
            HostLifecycleStatus::Active => {}
        }

        // Encode before resolving the live registry. A generation the daemon cannot
        // represent must not observe an attachment, much less enter its FIFO.
        let command =
            RuntimeStopCommand::encode(target.scope(), target.generation()).map_err(|source| {
                ScopeRuntimeStopFailure::GenerationOutOfWireRange {
                    generation: source.generation(),
                }
            })?;

        let custody = self
            .data_plane
            .resolve(target.host())
            .map_err(|_| ScopeRuntimeStopFailure::RegistryUnavailable)?;
        let Some(custody) = custody else {
            return Ok(Err(ScopeRuntimeStopRefusal::HostAttachPending));
        };
        stop_captured(&self.data_plane, custody, command, self.timeout).await
    }
}

/// Command-specific adapter over an already-captured owning-host custody. Kept
/// crate-private so callers cannot pair the raw transport kind with free-form JSON.
pub(crate) async fn stop_captured(
    data_plane: &OwningHostDataPlane,
    custody: HostDataPlaneCustody,
    command: RuntimeStopCommand,
    timeout: Duration,
) -> Result<Result<ScopeRuntimeStopOutcome, ScopeRuntimeStopRefusal>, ScopeRuntimeStopFailure> {
    let expected = custody.clone();
    let answer = data_plane
        .dispatch(HostDataPlaneRequest {
            custody,
            command: command::runtime_stop(command.into_params()),
            timeout,
        })
        .await;
    let answer = match answer {
        Ok(answer) => answer,
        Err(
            HostDataPlaneFailure::NoCurrentDaemon
            | HostDataPlaneFailure::ConnectionGenerationMismatch
            | HostDataPlaneFailure::DaemonInstanceMismatch,
        ) => return Ok(Err(ScopeRuntimeStopRefusal::HostAttachPending)),
        Err(HostDataPlaneFailure::NotDispatched) => {
            return Err(ScopeRuntimeStopFailure::NotDispatched);
        }
        Err(HostDataPlaneFailure::Ambiguous) => {
            return Err(ScopeRuntimeStopFailure::Ambiguous);
        }
        Err(HostDataPlaneFailure::TimedOut) => return Err(ScopeRuntimeStopFailure::TimedOut),
        Err(HostDataPlaneFailure::Refused(_)) => {
            return Err(ScopeRuntimeStopFailure::DaemonRefused);
        }
        Err(HostDataPlaneFailure::ProtocolCorruption) => {
            return Err(ScopeRuntimeStopFailure::ProtocolCorruption);
        }
        Err(HostDataPlaneFailure::RegistryUnavailable) => {
            return Err(ScopeRuntimeStopFailure::RegistryUnavailable);
        }
    };
    let result =
        answer
            .into_result_for(&expected)
            .map_err(|_mismatch: HostDataPlaneAnswerMismatch| {
                ScopeRuntimeStopFailure::AuthorityMismatch
            })?;
    if !valid_result(&result) {
        return Err(ScopeRuntimeStopFailure::ProtocolCorruption);
    }
    Ok(Ok(ScopeRuntimeStopOutcome))
}
