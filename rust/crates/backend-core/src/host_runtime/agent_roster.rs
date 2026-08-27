//! The agents a computer carries — the enumeration the availability fan-out
//! walks when a computer's reachability moves.
//!
//! When custody of a computer changes ([`aftermath`](super::aftermath)), every
//! agent bound to it changes availability together: they share the computer's
//! reachability, so a revoke or a daemon attach/detach moves them all at once.
//! The [`AgentAvailabilityAnnouncer`](super::aftermath::AgentAvailabilityAnnouncer)
//! is handed only the computer id, so SOMETHING has to turn that id into the set
//! of agents whose viewers must refetch. That is this read port.
//!
//! It is deliberately narrow and viewer-BLIND: it lists EVERY agent filed under
//! the computer, not a caller-visible subset. Per-agent visibility is a second,
//! separate step the fan-out applies afterwards (each agent's own viewer audience
//! decides who is told), so mixing an ACL in here would silently drop agents from
//! the fan-out — a viewer who may see an agent this port hid would keep a stale
//! Online. A computer with no agents is an empty set, not a refusal. Every failure
//! is a [`PersistenceFailure`]; this runs post-commit off a sealed custody fact,
//! so there is no product `4xx` on the path.

use std::future::Future;

use crate::{
    identity::{AgentId, HostId},
    persistence::PersistenceFailure,
};

/// Enumerates the agents bound to a computer, for the post-commit availability
/// fan-out.
///
/// The order of the returned ids is not part of the contract — the fan-out fires
/// one independent per-agent, per-viewer frame and no reader observes a sequence
/// — but a deterministic order keeps the adapter's own tests legible.
pub trait ComputerAgentsReadPort: Clone + Send + Sync + 'static {
    fn agent_ids_on_computer(
        &self,
        computer: &HostId,
    ) -> impl Future<Output = Result<Vec<AgentId>, PersistenceFailure>> + Send;
}
