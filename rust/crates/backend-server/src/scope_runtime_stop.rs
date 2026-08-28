//! Production exact-seat runtime stop adapter.
//!
//! Persisted lifecycle decides whether a named host may be touched; only an active
//! host reaches the live attachment registry. The command-specific half then sends
//! the existing `runtime_stop` payload through the shared, generation-bound owning-
//! host data plane.

use std::{error::Error, fmt, time::Duration};

use serde_json::{Value, json};
use silverhand_backend_core::{
    host_runtime::{
        lifecycle::{HostLifecycleStatus, lifecycle_status},
        read::ComputerReadModel,
    },
    identity::HostId,
    persistence::PersistenceFailure,
    runtime_credential::{RuntimeGeneration, RuntimeScope},
    scope_runtime_stop::{
        ScopeRuntimeStopOutcome, ScopeRuntimeStopPort, ScopeRuntimeStopRefusal,
        ScopeRuntimeStopTarget,
    },
};

use crate::daemon_delivery::{
    HostDataPlaneAnswerMismatch, HostDataPlaneCommandKind, HostDataPlaneCustody,
    HostDataPlaneFailure, HostDataPlaneRequest, OwningHostDataPlane, scope_wire,
};

#[derive(Clone)]
pub struct ProductionScopeRuntimeStop<H> {
    computers: H,
    data_plane: OwningHostDataPlane,
    timeout: Duration,
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

        let custody = self
            .data_plane
            .resolve(target.host())
            .map_err(|_| ScopeRuntimeStopFailure::RegistryUnavailable)?;
        let Some(custody) = custody else {
            return Ok(Err(ScopeRuntimeStopRefusal::HostAttachPending));
        };
        stop_captured(
            &self.data_plane,
            custody,
            target.scope(),
            target.generation(),
            self.timeout,
        )
        .await
    }
}

/// Command-specific adapter over an already-captured owning-host custody. Kept
/// crate-private so callers cannot pair the raw transport kind with free-form JSON.
pub(crate) async fn stop_captured(
    data_plane: &OwningHostDataPlane,
    custody: HostDataPlaneCustody,
    scope: &RuntimeScope,
    generation: RuntimeGeneration,
    timeout: Duration,
) -> Result<Result<ScopeRuntimeStopOutcome, ScopeRuntimeStopRefusal>, ScopeRuntimeStopFailure> {
    let expected = custody.clone();
    let answer = data_plane
        .dispatch(HostDataPlaneRequest {
            custody,
            kind: HostDataPlaneCommandKind::RuntimeStop,
            params: json!({
                "runtime_scope": scope_wire(scope),
                "runtime_generation": generation.as_i64(),
                "mode": "hard",
            }),
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
        Err(HostDataPlaneFailure::Refused) => {
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

pub(crate) fn valid_result(result: &Value) -> bool {
    let Some(object) = result.as_object() else {
        return false;
    };
    object.len() == 3
        && object.get("mode").and_then(Value::as_str) == Some("hard")
        && object.get("stopped").and_then(Value::as_bool).is_some()
        && object
            .get("exit_code")
            .is_some_and(|value| value.is_null() || value.as_i64().is_some())
}
