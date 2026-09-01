//! The stored facts one `GET /api/hosts/{id}/resources` read needs: which agents
//! are registered on a computer, answerable only to the requester it belongs to.
//!
//! ## The ownership rule is not restated here
//!
//! "Is this computer this requester's?" already has an authority —
//! [`crate::identity_access::capability::computer_access`] — and this face consults it rather than
//! comparing an owner column of its own. That is what keeps the read face and the
//! teardown face from drifting on who a computer answers to, and it is why an
//! absent computer needs no arm here: the rule takes the absent row itself, and
//! folds it into the SAME single refusal, so a requester probing ids never learns
//! which ones exist.
//!
//! What this module owns is narrower: WHICH agents that computer has, and the
//! guarantee that they are the ones asked about.
//!
//! ## One computer coordinate drives the gate and the list
//!
//! The ownership the caller is judged against and the rows the wire lists come off
//! ONE `hosts` id, read on one snapshot. There is no public path to the agents: the
//! only way to reach them is [`visible_host_resources`], which binds the requested
//! coordinate to the bundle and to every row in it BEFORE it consults the rule. A
//! bundle assembled from one computer's ownership and another's agents is a
//! resolver defect, and it is refused as an internal contract failure rather than
//! rendered as somebody's resource list.
//!
//! The list itself is a function of the computer alone — no field of it is derived
//! from the requester — so the viewer has nothing to bind: it only gates.
//!
//! ## The order is the adapter's, not a rule
//!
//! The wire order is whatever the adapter's `ORDER BY` produces. No total order is
//! stated here, because the product's order (`agents.created_at ASC`) has no
//! tiebreaker: inventing one in the domain would contract a behavior the product
//! does not have.

use std::future::Future;

use thiserror::Error;

use crate::{
    identity::{AgentId, HostId, UserId},
    identity_access::agents::runtime::RuntimeKind,
    identity_access::capability::computer_access::{
        ComputerAccess, ComputerAccessRefused, ComputerOwnershipFacts, can_access_computer,
    },
    persistence::PersistenceFailure,
};

/// One agent registered on a computer, in the four fields this face renders.
///
/// This is the host-scoped REGISTRATION view — every agent filed under the
/// computer, whatever materialization stage it reached — not a process list and
/// not a liveness view.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct HostAgentResourceFact {
    pub id: AgentId,
    /// The `agents.host_id` this row is filed under. Not a wire field: it is what
    /// makes the row ATTRIBUTABLE, so a list resolved for another computer cannot
    /// be passed off as this one's.
    pub computer: HostId,
    pub name: String,
    pub display_name: String,
    /// The closed set the wire contract names, not a free string. Typing the field
    /// is what makes "a stored `runtime` outside the set never reaches a `200`" a
    /// property of the fact rather than a check an adapter might forget: there is no
    /// value of this type that the wire enum cannot carry, so this face cannot
    /// become a second authority on what a runtime is.
    pub runtime: RuntimeKind,
}

/// The stored facts one authenticated host-resources read is decided and projected
/// from, read together on one snapshot.
///
/// The agents are private and have no accessor. [`visible_host_resources`] is the
/// only way to reach them, so a caller cannot obtain the list without passing both
/// the coordinate bind and the ownership rule — the omission is a type error, not
/// a review note.
///
/// ```compile_fail
/// use silverhand_backend_core::{
///     identity_access::capability::computer_access::ComputerOwnershipFacts,
///     host_runtime::host_resources_read::HostResourcesFacts,
///     identity::HostId,
/// };
/// let facts = HostResourcesFacts::from_ownership(
///     ComputerOwnershipFacts { id: HostId::parse("h1").unwrap(), owner: None },
///     Vec::new(),
/// );
/// // Read directly, this list would skip both the coordinate bind and the rule.
/// let _ = facts.agents;
/// ```
///
/// The control for that gate: the same path, named the same way, reached the only
/// way it can be. A `compile_fail` block passes on ANY error, so without this the
/// gate above would also pass on a renamed type or a bad import.
///
/// ```
/// use silverhand_backend_core::{
///     identity_access::capability::computer_access::ComputerOwnershipFacts,
///     host_runtime::host_resources_read::{HostResourcesFacts, visible_host_resources},
///     identity::{HostId, UserId},
/// };
/// let owner = UserId::parse("u1").unwrap();
/// let computer = HostId::parse("h1").unwrap();
/// let facts = HostResourcesFacts::from_ownership(
///     ComputerOwnershipFacts { id: computer.clone(), owner: Some(owner.clone()) },
///     Vec::new(),
/// );
/// let visible = visible_host_resources(&owner, &computer, Some(&facts))
///     .expect("the bundle is about the computer asked about");
/// assert!(visible.expect("the owner is admitted").is_empty());
/// ```
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct HostResourcesFacts {
    ownership: ComputerOwnershipFacts,
    agents: Vec<HostAgentResourceFact>,
}

impl HostResourcesFacts {
    /// Build the bundle from the ownership facts the computer row decoded to — which
    /// carry the computer's own id — and the agents read for that same id.
    pub fn from_ownership(
        ownership: ComputerOwnershipFacts,
        agents: impl IntoIterator<Item = HostAgentResourceFact>,
    ) -> Self {
        Self {
            ownership,
            agents: agents.into_iter().collect(),
        }
    }

    fn ownership(&self) -> &ComputerOwnershipFacts {
        &self.ownership
    }

    fn agents(&self) -> &[HostAgentResourceFact] {
        &self.agents
    }

    /// Refuse a bundle that is not about `requested`, or that carries a row filed
    /// under another computer.
    fn bind_to(&self, requested: &HostId) -> Result<(), HostResourcesFactsMismatch> {
        if requested != &self.ownership.id {
            return Err(HostResourcesFactsMismatch::Computer {
                expected: requested.clone(),
                found: self.ownership.id.clone(),
            });
        }
        for agent in &self.agents {
            if agent.computer != self.ownership.id {
                return Err(HostResourcesFactsMismatch::Agent {
                    computer: self.ownership.id.clone(),
                    agent: agent.id.clone(),
                    found: agent.computer.clone(),
                });
            }
        }
        Ok(())
    }
}

/// A resolver handed back facts that do not describe the read it was asked for.
///
/// Neither arm is a product refusal: a requester cannot cause either, and cannot do
/// anything about one. They are internal contract failures a route renders as a safe
/// `500` — answering `404` would hide a defect behind a plausible refusal, and
/// answering `200` would list one computer's agents under another's id. Its own
/// vocabulary, per aggregate, so a mapping reviewed here is not reused past this
/// boundary.
#[derive(Clone, Debug, Eq, Error, PartialEq)]
pub enum HostResourcesFactsMismatch {
    #[error("host-resources facts describe computer {found:?} but the read is about {expected:?}")]
    Computer { expected: HostId, found: HostId },
    #[error(
        "host-resources facts for computer {computer:?} list agent {agent:?}, which is filed \
         under {found:?}"
    )]
    Agent {
        computer: HostId,
        agent: AgentId,
        found: HostId,
    },
}

/// The agents `viewer` may see on `requested`, or `None` when they may see nothing.
///
/// `None` covers BOTH "no such computer" and "not this requester's", because the
/// authority folds them into one refusal; a caller renders it as one
/// anti-enumeration `404` and can therefore not leak which case it was.
///
/// `facts` is passed as an `Option` rather than short-circuited by the caller so the
/// absent row stays the RULE's arm: there is exactly one place that decides an absent
/// computer answers like someone else's.
pub fn visible_host_resources<'facts>(
    viewer: &UserId,
    requested: &HostId,
    facts: Option<&'facts HostResourcesFacts>,
) -> Result<Option<&'facts [HostAgentResourceFact]>, HostResourcesFactsMismatch> {
    // The coordinate bind precedes the product judgment: otherwise a spliced bundle
    // could hide behind the refusal a stranger would have received anyway.
    if let Some(facts) = facts {
        facts.bind_to(requested)?;
    }
    match can_access_computer(viewer, facts.map(HostResourcesFacts::ownership)) {
        ComputerAccess::Held(_) => Ok(facts.map(HostResourcesFacts::agents)),
        ComputerAccess::Refused(ComputerAccessRefused::NotTheirs) => Ok(None),
    }
}

/// Loads the stored facts for one host-resources read — the computer's ownership and
/// the agents registered on it, on one snapshot.
pub trait HostResourcesReadModel {
    /// `None` when the computer row is absent — a fact the ownership rule renders as
    /// the same refusal as someone else's computer, never a failed read.
    fn read_host_resources(
        &self,
        computer: &HostId,
    ) -> impl Future<Output = Result<Option<HostResourcesFacts>, PersistenceFailure>> + Send;
}

#[cfg(test)]
mod tests {
    use super::*;

    fn user(id: &str) -> UserId {
        UserId::parse(id).expect("user id")
    }

    fn computer(id: &str) -> HostId {
        HostId::parse(id).expect("host id")
    }

    fn agent_on(id: &str, host: &str) -> HostAgentResourceFact {
        HostAgentResourceFact {
            id: AgentId::parse(id).expect("agent id"),
            computer: computer(host),
            name: format!("{id}-name"),
            display_name: format!("{id} display"),
            runtime: RuntimeKind::Qoder,
        }
    }

    fn owned_by(owner: Option<&str>, agents: Vec<HostAgentResourceFact>) -> HostResourcesFacts {
        HostResourcesFacts::from_ownership(
            ComputerOwnershipFacts {
                id: computer("h1"),
                owner: owner.map(user),
            },
            agents,
        )
    }

    fn visible_ids(
        viewer: &str,
        requested: &str,
        facts: Option<&HostResourcesFacts>,
    ) -> Result<Option<Vec<String>>, HostResourcesFactsMismatch> {
        Ok(
            visible_host_resources(&user(viewer), &computer(requested), facts)?.map(|agents| {
                agents
                    .iter()
                    .map(|agent| agent.id.as_str().to_string())
                    .collect()
            }),
        )
    }

    #[test]
    fn the_owner_sees_every_agent_registered_on_the_computer_in_the_given_order() {
        let facts = owned_by(Some("u1"), vec![agent_on("a1", "h1"), agent_on("a2", "h1")]);
        assert_eq!(
            visible_ids("u1", "h1", Some(&facts)).unwrap(),
            Some(vec!["a1".to_string(), "a2".to_string()])
        );
    }

    /// A computer with no agents is an EMPTY list for its owner, not a refusal: the
    /// caller renders `200 {"agents":[]}`, which is what tells "yours, and idle"
    /// apart from "not yours".
    #[test]
    fn an_owned_computer_with_no_agents_is_an_empty_list_not_a_refusal() {
        let facts = owned_by(Some("u1"), vec![]);
        assert_eq!(visible_ids("u1", "h1", Some(&facts)).unwrap(), Some(vec![]));
    }

    /// The three ways a requester sees nothing are ONE answer, so the surface is
    /// never an existence oracle for computer ids.
    #[test]
    fn absent_someone_elses_and_ownerless_are_the_same_refusal() {
        assert_eq!(visible_ids("u1", "h1", None).unwrap(), None);
        let theirs = owned_by(Some("u2"), vec![agent_on("a1", "h1")]);
        assert_eq!(visible_ids("u1", "h1", Some(&theirs)).unwrap(), None);
        let ownerless = owned_by(None, vec![agent_on("a1", "h1")]);
        assert_eq!(visible_ids("u1", "h1", Some(&ownerless)).unwrap(), None);
    }

    /// Facts about another computer are refused even though they are internally
    /// consistent AND owned by the asker: without the bind, the owner of `h1` would
    /// be handed `h2`'s agent list under `h1`'s id.
    #[test]
    fn a_bundle_about_another_computer_is_an_internal_contract_failure() {
        let facts = owned_by(Some("u1"), vec![agent_on("a1", "h1")]);
        assert_eq!(
            visible_ids("u1", "h2", Some(&facts)).unwrap_err(),
            HostResourcesFactsMismatch::Computer {
                expected: computer("h2"),
                found: computer("h1"),
            }
        );
    }

    /// The splice the ownership rule cannot catch: legal ownership facts for the
    /// asker's own computer, carrying a row filed under a different one.
    #[test]
    fn an_agent_filed_under_another_computer_is_an_internal_contract_failure() {
        let facts = owned_by(Some("u1"), vec![agent_on("a1", "h1"), agent_on("a2", "h2")]);
        assert_eq!(
            visible_ids("u1", "h1", Some(&facts)).unwrap_err(),
            HostResourcesFactsMismatch::Agent {
                computer: computer("h1"),
                agent: AgentId::parse("a2").unwrap(),
                found: computer("h2"),
            }
        );
    }

    /// The bind runs BEFORE the rule, so a splice cannot hide behind the refusal a
    /// stranger receives anyway.
    #[test]
    fn a_splice_is_reported_even_to_a_requester_who_would_be_refused() {
        let facts = owned_by(Some("u2"), vec![agent_on("a1", "h2")]);
        assert!(visible_ids("u1", "h1", Some(&facts)).is_err());
    }
}
