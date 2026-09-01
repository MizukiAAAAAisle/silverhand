//! The runtime-switch saga's forced availability probe, over the owning-host data
//! plane.
//!
//! The saga asks one question before it acquires the transition lock: is the target
//! runtime DETERMINISTICALLY absent on the agent's computer? This adapter answers it
//! with a FORCED catalog round-trip (bypassing any cache) and collapses the full
//! `RuntimeAvailability` vocabulary to the single distinction the transition draws —
//! `Absent` (and total absence from the catalog) blocks; `present` /
//! `present_unverified` / `unknown` all defer to the daemon spawn last-line. Every
//! transport failure maps to the same switch-domain fault the standalone catalog
//! route reports, so the route renders one HTTP status per cause.

use silverhand_backend_core::{
    foundation::identity::HostId,
    host_runtime::agent_runtime_switch::{
        RuntimeAvailabilityProbe, RuntimeAvailabilityProbeFault, RuntimeAvailabilityVerdict,
    },
    identity_access::agents::runtime::RuntimeKind,
};

use crate::{
    daemon_delivery::OwningHostDataPlane,
    host_runtime::host_control::runtime_catalog::{
        self, RuntimeAvailability, RuntimeCatalogOutcome, RuntimeCatalogRequest,
    },
};

/// A forced-probe availability port bound to the one data plane that owns the host
/// connections. Cloneable and `'static`, so the switch route can inject it as a
/// generic port alongside the durable transition ports.
#[derive(Clone)]
pub struct DataPlaneRuntimeAvailabilityProbe {
    data_plane: OwningHostDataPlane,
}

impl DataPlaneRuntimeAvailabilityProbe {
    pub fn new(data_plane: OwningHostDataPlane) -> Self {
        Self { data_plane }
    }
}

impl RuntimeAvailabilityProbe for DataPlaneRuntimeAvailabilityProbe {
    async fn probe_runtime_available(
        &self,
        host: &HostId,
        runtime: RuntimeKind,
    ) -> Result<RuntimeAvailabilityVerdict, RuntimeAvailabilityProbeFault> {
        // No attached custody is the ordinary offline answer: nothing owns the host
        // to answer the probe, so it degrades exactly like the standalone route's
        // `computer is offline` — an attach-pending fault, not a verdict.
        let custody = match self.data_plane.resolve(host) {
            Ok(Some(custody)) => custody,
            Ok(None) => return Err(RuntimeAvailabilityProbeFault::AttachPending),
            Err(cause) => {
                tracing::error!(
                    error = %cause,
                    "runtime-switch availability probe: data plane resolve failed"
                );
                return Err(RuntimeAvailabilityProbeFault::DaemonInternalError);
            }
        };
        let coordinate = custody.clone();
        match runtime_catalog::probe(&self.data_plane, RuntimeCatalogRequest::new(custody, true))
            .await
        {
            RuntimeCatalogOutcome::Detected(catalog) => {
                let Ok(view) = catalog.rows_for(&coordinate) else {
                    // The transport answered about a coordinate this probe never
                    // asked about: a defect in this crate, surfaced as the contract
                    // violation the route maps to 500, never a daemon refusal.
                    return Err(RuntimeAvailabilityProbeFault::TransportContractViolation);
                };
                let target = view.runtimes.iter().find(|entry| entry.kind == runtime);
                match target {
                    // Missing from the catalog or definitely absent — the only two
                    // deterministic-absence signals the transition blocks on.
                    None => Ok(RuntimeAvailabilityVerdict::Absent),
                    Some(entry) if entry.state == RuntimeAvailability::Absent => {
                        Ok(RuntimeAvailabilityVerdict::Absent)
                    }
                    Some(_) => Ok(RuntimeAvailabilityVerdict::AvailableOrUnknown),
                }
            }
            RuntimeCatalogOutcome::AttachPending => {
                Err(RuntimeAvailabilityProbeFault::AttachPending)
            }
            RuntimeCatalogOutcome::Timeout => Err(RuntimeAvailabilityProbeFault::Timeout),
            RuntimeCatalogOutcome::DaemonInternalError => {
                Err(RuntimeAvailabilityProbeFault::DaemonInternalError)
            }
            RuntimeCatalogOutcome::TransportContractViolation => {
                Err(RuntimeAvailabilityProbeFault::TransportContractViolation)
            }
        }
    }
}
