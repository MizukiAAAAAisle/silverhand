//! Production `HostConnectivity`: the create unit of work's narrow view of the daemon
//! attachment registry.
//!
//! The create UoW consults this once, before it reserves a row, to fail the common
//! offline case fast. [`OwningHostDataPlane`] already owns that truth — it answers
//! `Some` custody exactly when a daemon is attached right now, and is the SAME registry
//! the eventual `agent_materialize` dispatch captures custody from — so the fail-fast
//! gate and the command speak one truth about attachment. We give core its narrow
//! boolean view by implementing the port directly on that authority rather than wrapping
//! it: there is no second attachment fact to hold. A replacement daemon arriving between
//! this probe and the command is caught again inside `dispatch`.

use silverhand_backend_core::{
    agent_creation::HostConnectivity, identity::HostId, persistence::PersistenceFailure,
};

use crate::daemon_delivery::OwningHostDataPlane;

impl HostConnectivity for OwningHostDataPlane {
    async fn is_attached(&self, host: &HostId) -> Result<bool, PersistenceFailure> {
        self.resolve(host)
            .map(|custody| custody.is_some())
            .map_err(PersistenceFailure::from_source)
    }
}
