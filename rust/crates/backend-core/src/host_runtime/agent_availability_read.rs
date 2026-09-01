//! The stored facts one `GET /api/agents/:id/availability` read needs.
//!
//! Availability composes TWO capabilities that were landed separately — the
//! visibility ACL ([`crate::identity_access::capability::agent_view`]) and the reachability rule
//! ([`crate::cold_read::availability`]) — and this port supplies the facts each
//! reads. It holds no rule of its own: facts in, application structs out, so the
//! route and its tests share one authority without a driver.
//!
//! ## The ACL and the agent's own reachability facts are ONE snapshot
//!
//! [`AgentViewFacts`] bundles the visibility a refusal is decided against with the
//! reachability inputs a value is computed from, because both are read from the
//! SAME agent row on ONE snapshot. Reading them apart would let the row a caller
//! is judged against differ from the row a value is produced for — an agent could
//! pass the ACL as it stood, then have its `host_id` or deletion marker read from a
//! later write. The adapter that implements this therefore reads the agent row and
//! its three ACL arms under a single deferred snapshot.
//!
//! ## The host row is read AFTER the ACL, so it is its own read
//!
//! Reachability's host channel is deliberately not part of that bundle. The route
//! must refuse a caller who may not see the agent BEFORE it reads anything about
//! the host the agent sits on — access precedes product — so the host fact is a
//! second read taken only once the ACL admits the caller. Its absence is a fact
//! (the agent's host is not, or is no longer, a host of ours), not a failed read,
//! which is why it is `Option` rather than an error.

use std::future::Future;

use crate::{
    cold_read::availability::{AgentAvailabilityFacts, HostReachabilityFacts},
    foundation::persistence::PersistenceFailure,
    identity::{AgentId, HostId},
    identity_access::capability::agent_view::AgentVisibility,
};

/// The agent-side half of an availability read: who may see the agent, and the
/// reachability inputs carried on its own row. Read together on one snapshot.
///
/// The bundle is sealed to ONE decoded source id — the `agents.id` the adapter
/// actually read back, never the request echo. Both the ACL a caller is judged
/// against and the reachability inputs a value is computed from hang off that one
/// coordinate, and [`source`](Self::source) is what the route binds to the id it
/// was asked for BEFORE either decision. Were the fields open, an adapter could
/// resolve the visibility of one row and the reachability of another and the seal
/// would be vacuous, so construction goes through [`from_source`](Self::from_source),
/// which derives `availability.id` from that single source.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AgentViewFacts {
    /// The `agents.id` decoded from the row this view was read from.
    source: AgentId,
    /// The visibility ACL and materialization stage the view is decided against.
    visibility: AgentVisibility,
    /// The reachability inputs on the agent's own row: its coordinate (equal to
    /// `source` by construction), the host it sits on, and whether it is mid
    /// hard-delete.
    availability: AgentAvailabilityFacts,
}

impl AgentViewFacts {
    /// Build a view from the ONE source id the row was read back with, deriving the
    /// reachability coordinate from it so the ACL and the value cannot describe two
    /// different rows.
    pub fn from_source(
        source: AgentId,
        visibility: AgentVisibility,
        host_id: HostId,
        deletion_started_at: Option<i64>,
    ) -> Self {
        Self {
            availability: AgentAvailabilityFacts {
                id: source.clone(),
                host_id,
                deletion_started_at,
            },
            source,
            visibility,
        }
    }

    /// The decoded `agents.id` this view describes — the coordinate the route binds
    /// to the requested id before it consults the ACL or reads reachability.
    pub fn source(&self) -> &AgentId {
        &self.source
    }

    /// The visibility ACL and materialization stage the refusal is decided against.
    pub fn visibility(&self) -> &AgentVisibility {
        &self.visibility
    }

    /// The reachability inputs on the agent's own row.
    pub fn availability(&self) -> &AgentAvailabilityFacts {
        &self.availability
    }
}

/// Loads the stored facts for one availability read. The two halves are separate
/// methods, not one call, because the route reads them at two different points:
/// the agent view before the ACL gate, and the host row only after it passes.
pub trait AgentAvailabilityReadModel {
    /// The agent row and its resolved visibility ACL, on one snapshot. `None` when
    /// the row is absent — a fact the ACL renders as "not a viewer of a row that
    /// is not there", never a failed read.
    fn read_agent_view(
        &self,
        agent: &AgentId,
    ) -> impl Future<Output = Result<Option<AgentViewFacts>, PersistenceFailure>> + Send;

    /// The reachability facts of the host the agent sits on. `None` when there is
    /// no such host row, which the reachability rule reads as `HostGone`.
    fn read_host_reachability(
        &self,
        host: &HostId,
    ) -> impl Future<Output = Result<Option<HostReachabilityFacts>, PersistenceFailure>> + Send;
}
