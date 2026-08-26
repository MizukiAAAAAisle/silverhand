//! The stored facts one `GET /api/agents/{id}/presence` read needs.
//!
//! Presence composes the SAME visibility ACL as availability and detail
//! ([`crate::capability::agent_view`]) with ONE projected fact — the agent's
//! `last_activity_at`, decoded into a validated
//! [`crate::policy::agent_presence::ActivityInstant`] whose
//! [`away_at`](crate::policy::agent_presence::ActivityInstant::away_at) is the
//! wire `away_at`. It holds no rule of its own: facts in, the away deadline out,
//! so the route and its tests share one authority without a driver.
//!
//! ## One row, one snapshot
//!
//! Everything comes off the agent row read together with the two set-shaped ACL
//! arms on ONE deferred snapshot, so the visibility a caller is judged against
//! and the activity stamp later projected come from ONE view of the database.
//!
//! ## The away deadline is clock-free; `server_now` is the route's
//!
//! [`away_at`](AgentPresenceFacts::away_at) applies the validated instant's shared
//! window with no wall clock — the SAME boundary the runtime-delivery writer treats
//! as "still online", so a write that calls an agent present and a read that reports
//! it away agree by construction. The response's `server_now` is a separate
//! emit-only value the route stamps from its own clock; it is not a stored fact
//! and never reaches this layer, mirroring how CP1's
//! [`crate::policy::presence_grace`] decides without owning a clock.

use std::future::Future;

use crate::{
    capability::agent_view::AgentVisibility, identity::AgentId, persistence::PersistenceFailure,
    policy::agent_presence::ActivityInstant,
};

/// The stored facts one authenticated agent-presence read is decided and
/// projected from, read together on one snapshot.
///
/// Sealed to ONE decoded source id — the `agents.id` the adapter read back, never
/// the request echo — so the route can bind it to the id it was asked for BEFORE
/// the ACL decision. The visibility the caller is judged against and the
/// `last_activity_at` the deadline is projected from both describe that one row.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AgentPresenceFacts {
    source: AgentId,
    visibility: AgentVisibility,
    last_activity_at: Option<ActivityInstant>,
}

impl AgentPresenceFacts {
    /// Build a presence bundle from the ONE source id the row was read back with,
    /// its resolved visibility, and its VALIDATED `last_activity_at` (absent when
    /// the agent has never been active). The stamp arrives already decoded into an
    /// [`ActivityInstant`], so the bundle is valid by construction — a corrupt
    /// committed value was refused at the adapter's decode, never here. Naming the
    /// source explicitly is what lets the route refuse a bundle resolved for another
    /// agent.
    pub fn from_source(
        source: AgentId,
        visibility: AgentVisibility,
        last_activity_at: Option<ActivityInstant>,
    ) -> Self {
        Self {
            source,
            visibility,
            last_activity_at,
        }
    }

    /// The decoded `agents.id` this bundle describes — the coordinate the route
    /// binds to the requested id before it consults the ACL.
    pub fn source(&self) -> &AgentId {
        &self.source
    }

    /// The visibility ACL and materialization stage the refusal is decided against.
    pub fn visibility(&self) -> &AgentVisibility {
        &self.visibility
    }

    /// The absolute epoch-ms deadline at which this agent projects to Away, or
    /// `None` when it has never been active (no fabricated deadline). Clock-free:
    /// the validated [`ActivityInstant`] applies the shared window with a total add
    /// that cannot overflow. This layer never adds its own arithmetic, so the
    /// deadline cannot drift from the writer's "still online" boundary.
    pub fn away_at(&self) -> Option<i64> {
        self.last_activity_at.map(ActivityInstant::away_at)
    }
}

/// Loads the stored facts for one agent-presence read — the agent row's activity
/// stamp and its resolved visibility ACL, on one snapshot.
pub trait AgentPresenceReadModel {
    /// `None` when the row is absent — a fact the ACL renders as "not a viewer of a
    /// row that is not there", never a failed read.
    fn read_agent_presence(
        &self,
        agent: &AgentId,
    ) -> impl Future<Output = Result<Option<AgentPresenceFacts>, PersistenceFailure>> + Send;
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        agent_lifecycle::MaterializationStatus,
        capability::agent_view::{AgentViewerArms, AgentVisibility},
        identity::AgentId,
        policy::agent_presence,
    };

    fn facts(last_activity_at: Option<i64>) -> AgentPresenceFacts {
        AgentPresenceFacts::from_source(
            AgentId::parse("a1").unwrap(),
            AgentVisibility {
                viewers: AgentViewerArms::new(None, [], []),
                materialization_status: MaterializationStatus::Active,
            },
            last_activity_at.map(|value| ActivityInstant::new(value).unwrap()),
        )
    }

    /// A never-active agent has NO fabricated deadline: the bundle forwards the
    /// `None` straight through rather than inventing a future one.
    #[test]
    fn a_never_active_agent_has_no_away_deadline() {
        assert_eq!(facts(None).away_at(), None);
    }

    /// The deadline is the validated instant's shared window — the bundle adds no
    /// arithmetic of its own, so it cannot diverge from the writer's boundary.
    #[test]
    fn away_at_is_the_shared_window_applied_to_the_stamp() {
        assert_eq!(
            facts(Some(1_000)).away_at(),
            Some(ActivityInstant::new(1_000).unwrap().away_at())
        );
        assert_eq!(
            facts(Some(1_000)).away_at(),
            Some(1_000 + agent_presence::AWAY_TTL_MS)
        );
    }
}
