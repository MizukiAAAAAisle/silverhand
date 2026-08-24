//! Whether an agent is visible, and to exactly whom.
//!
//! One reason to change: the audience of an agent. Authority to act on one is a
//! separate rule with a separate reason ([`super::agent_authority`]).
//!
//! The predicate and its audience dual are the same value read twice. A fan-out
//! that invalidates a cached view must reach exactly the humans a read of that
//! agent would serve, so the two directions are not two functions kept in step by
//! discipline: [`AgentViewerArms`] holds one resolved set, the predicate tests
//! membership in it and the dual returns it.

use std::collections::{BTreeSet, HashSet};

use crate::{
    agent_lifecycle::MaterializationStatus,
    capability::{decision::Decision, principal::Principal},
    identity::{AgentId, UserId},
};

/// The humans admitted by the visibility ACL.
///
/// The three arms are named by the constructor, which is the single place a
/// fourth arm can be added — and adding one there obliges every fact source to
/// supply it. Once resolved they are one set, because the arms are a union and
/// nothing downstream asks which one admitted a viewer.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AgentViewerArms {
    admitted: HashSet<UserId>,
}

impl AgentViewerArms {
    /// * `creator` — the human who created the agent. Absent for a row with no
    ///   recorded creator.
    /// * `direct_pair_human_endpoints` — the human endpoint of every human↔agent
    ///   direct pair this agent is in. An agent↔agent pair contributes nobody.
    /// * `shared_workspace_members` — the members of every workspace the agent
    ///   reaches. For a human, workspace visibility IS membership, so this is the
    ///   exact dual of the workspace arm and not an over-approximation.
    pub fn new(
        creator: Option<UserId>,
        direct_pair_human_endpoints: impl IntoIterator<Item = UserId>,
        shared_workspace_members: impl IntoIterator<Item = UserId>,
    ) -> Self {
        let mut admitted = HashSet::new();
        admitted.extend(creator);
        admitted.extend(direct_pair_human_endpoints);
        admitted.extend(shared_workspace_members);
        Self { admitted }
    }

    fn admits(&self, user_id: &UserId) -> bool {
        self.admitted.contains(user_id)
    }
}

/// Which materialization stages a view admits.
///
/// A WIDENER over the already-ACL-scoped candidate set: it can never reveal
/// another principal's row. The default is active-only, so a face that wants to
/// see a pending or failed row has to say so at its own call site, where the
/// reason for wanting it is visible.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct VisibleStages(BTreeSet<MaterializationStatus>);

impl VisibleStages {
    pub fn active_only() -> Self {
        Self(BTreeSet::from([MaterializationStatus::Active]))
    }

    pub fn including(stages: impl IntoIterator<Item = MaterializationStatus>) -> Self {
        Self(stages.into_iter().collect())
    }

    fn admits(&self, status: MaterializationStatus) -> bool {
        self.0.contains(&status)
    }
}

impl Default for VisibleStages {
    fn default() -> Self {
        Self::active_only()
    }
}

/// The facts a visibility decision reads — nothing else about the agent.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AgentVisibility {
    pub viewers: AgentViewerArms,
    pub materialization_status: MaterializationStatus,
}

/// Why a view was refused. Every arm is a 404-shaped answer on the product
/// surfaces, which is the point: an agent nobody may see must be
/// indistinguishable from one that does not exist, so the surface cannot become
/// an existence oracle.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ViewRefused {
    /// The row is absent. A fact, not a failed read.
    AgentAbsent,
    /// The principal is outside the ACL.
    NotAViewer,
    /// Inside the ACL, but this view does not admit the agent's current stage.
    StageNotVisible,
}

/// May this principal see this agent?
///
/// `subject` is the agent the request names; it is what an agent principal's
/// self arm is decided against. `agent` is `None` when the row is absent. A read
/// that could not be performed never arrives here — it is the caller's `Err`.
pub fn can_view_agent(
    principal: &Principal,
    subject: &AgentId,
    agent: Option<&AgentVisibility>,
    stages: &VisibleStages,
) -> Decision<ViewRefused> {
    // System bypasses both gates: it comes from internal hosts and migrations,
    // never from a public surface, and it reads no row to decide.
    if matches!(principal, Principal::System) {
        return Decision::Allow;
    }
    let Some(agent) = agent else {
        return Decision::Denied(ViewRefused::AgentAbsent);
    };
    if !admitted_by_acl(principal, subject, agent) {
        return Decision::Denied(ViewRefused::NotAViewer);
    }
    if !stages.admits(agent.materialization_status) {
        return Decision::Denied(ViewRefused::StageNotVisible);
    }
    Decision::Allow
}

/// The humans who may currently see this agent — the audience dual of
/// [`can_view_agent`] under the default view.
///
/// Agent principals are absent by construction: only human arms are unioned, and
/// the scopes this feeds carry user ids. A row outside the default view has an
/// empty audience, since it is a 404 for everyone.
pub fn agent_viewer_user_ids(agent: Option<&AgentVisibility>) -> HashSet<UserId> {
    let Some(agent) = agent else {
        return HashSet::new();
    };
    if !VisibleStages::active_only().admits(agent.materialization_status) {
        return HashSet::new();
    }
    agent.viewers.admitted.clone()
}

/// Run the ACL before the stage widener even though the conjunction is
/// order-independent: the widener applies to an already-scoped candidate set,
/// and stating the gate in stage-first order would invite a later reader to
/// treat the stage list as an ACL-relaxing knob.
fn admitted_by_acl(principal: &Principal, subject: &AgentId, agent: &AgentVisibility) -> bool {
    match principal {
        // Unreachable: the caller returned above. Kept exhaustive so a new
        // principal arm has to state its ACL here rather than inherit one.
        Principal::System => true,
        Principal::Human { user_id } => agent.viewers.admits(user_id),
        // An agent views only itself.
        Principal::Agent { agent_id } => agent_id == subject,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn user(id: &str) -> UserId {
        UserId::parse(id).expect("user id")
    }

    fn agent_id(id: &str) -> AgentId {
        AgentId::parse(id).expect("agent id")
    }

    fn owned_by(creator: &str, status: MaterializationStatus) -> AgentVisibility {
        AgentVisibility {
            viewers: AgentViewerArms::new(Some(user(creator)), [], []),
            materialization_status: status,
        }
    }

    #[test]
    fn the_system_decides_without_reading_the_row() {
        let verdict = can_view_agent(
            &Principal::System,
            &agent_id("a1"),
            None,
            &VisibleStages::active_only(),
        );
        assert!(verdict.is_allowed());
    }

    #[test]
    fn an_absent_row_refuses_every_named_principal() {
        let stages = VisibleStages::active_only();
        let subject = agent_id("a1");
        for principal in [
            Principal::human(user("u1")),
            Principal::agent(agent_id("a1")),
        ] {
            assert_eq!(
                can_view_agent(&principal, &subject, None, &stages),
                Decision::Denied(ViewRefused::AgentAbsent)
            );
        }
    }

    #[test]
    fn each_arm_admits_on_its_own() {
        let stages = VisibleStages::active_only();
        for viewers in [
            AgentViewerArms::new(Some(user("u1")), [], []),
            AgentViewerArms::new(None, [user("u1")], []),
            AgentViewerArms::new(None, [], [user("u1")]),
        ] {
            let agent = AgentVisibility {
                viewers,
                materialization_status: MaterializationStatus::Active,
            };
            assert!(
                can_view_agent(
                    &Principal::human(user("u1")),
                    &agent_id("a1"),
                    Some(&agent),
                    &stages
                )
                .is_allowed()
            );
        }
    }

    #[test]
    fn a_human_outside_every_arm_is_refused_by_the_acl() {
        let agent = owned_by("owner", MaterializationStatus::Active);
        assert_eq!(
            can_view_agent(
                &Principal::human(user("stranger")),
                &agent_id("a1"),
                Some(&agent),
                &VisibleStages::active_only()
            ),
            Decision::Denied(ViewRefused::NotAViewer)
        );
    }

    #[test]
    fn the_stage_widener_never_relaxes_the_acl() {
        let agent = owned_by("owner", MaterializationStatus::Failed);
        let subject = agent_id("a1");
        let every_stage = VisibleStages::including([
            MaterializationStatus::PendingMaterialization,
            MaterializationStatus::Active,
            MaterializationStatus::Failed,
        ]);
        // The owner sees the failed row once the face opts in.
        assert!(
            can_view_agent(
                &Principal::human(user("owner")),
                &subject,
                Some(&agent),
                &every_stage
            )
            .is_allowed()
        );
        // A stranger does not, however wide the stage list is.
        assert_eq!(
            can_view_agent(
                &Principal::human(user("stranger")),
                &subject,
                Some(&agent),
                &every_stage
            ),
            Decision::Denied(ViewRefused::NotAViewer)
        );
    }

    #[test]
    fn a_refusal_names_the_acl_before_it_names_the_stage() {
        // Both arms render the same 404, so this is not a wire property — it is
        // this decision's own contract. A stage-first order would report a fact
        // about a row the caller was never admitted to see, and would make the
        // stage list look like the gate that failed.
        assert_eq!(
            can_view_agent(
                &Principal::human(user("stranger")),
                &agent_id("a1"),
                Some(&owned_by("owner", MaterializationStatus::Failed)),
                &VisibleStages::active_only()
            ),
            Decision::Denied(ViewRefused::NotAViewer)
        );
    }

    #[test]
    fn the_default_view_hides_every_stage_but_active() {
        for status in [
            MaterializationStatus::PendingMaterialization,
            MaterializationStatus::Failed,
        ] {
            assert_eq!(
                can_view_agent(
                    &Principal::human(user("owner")),
                    &agent_id("a1"),
                    Some(&owned_by("owner", status)),
                    &VisibleStages::default()
                ),
                Decision::Denied(ViewRefused::StageNotVisible)
            );
        }
    }

    #[test]
    fn an_agent_sees_only_itself() {
        let agent = owned_by("owner", MaterializationStatus::Active);
        let stages = VisibleStages::active_only();
        let itself = Principal::agent(agent_id("a1"));
        assert!(can_view_agent(&itself, &agent_id("a1"), Some(&agent), &stages).is_allowed());
        assert_eq!(
            can_view_agent(&itself, &agent_id("a2"), Some(&agent), &stages),
            Decision::Denied(ViewRefused::NotAViewer)
        );
        // Being the subject does not widen the stage gate.
        assert_eq!(
            can_view_agent(
                &itself,
                &agent_id("a1"),
                Some(&owned_by(
                    "owner",
                    MaterializationStatus::PendingMaterialization
                )),
                &stages
            ),
            Decision::Denied(ViewRefused::StageNotVisible)
        );
    }

    #[test]
    fn an_agent_principal_borrows_no_human_arm() {
        // The creator of an agent is a human id; an agent principal whose own id
        // happens to appear in a human arm still gets in only as the subject.
        let agent = AgentVisibility {
            viewers: AgentViewerArms::new(None, [], [user("a2")]),
            materialization_status: MaterializationStatus::Active,
        };
        assert_eq!(
            can_view_agent(
                &Principal::agent(agent_id("a2")),
                &agent_id("a1"),
                Some(&agent),
                &VisibleStages::active_only()
            ),
            Decision::Denied(ViewRefused::NotAViewer)
        );
    }

    #[test]
    fn the_audience_is_exactly_the_humans_the_predicate_admits() {
        let agent = AgentVisibility {
            viewers: AgentViewerArms::new(Some(user("owner")), [user("pair")], [user("member")]),
            materialization_status: MaterializationStatus::Active,
        };
        let audience = agent_viewer_user_ids(Some(&agent));
        assert_eq!(
            audience,
            HashSet::from([user("owner"), user("pair"), user("member")])
        );
        // Membership in the audience and the predicate's verdict agree for every
        // human, admitted or not — they read one value.
        for candidate in ["owner", "pair", "member", "stranger"] {
            let admitted = can_view_agent(
                &Principal::human(user(candidate)),
                &agent_id("a1"),
                Some(&agent),
                &VisibleStages::active_only(),
            )
            .is_allowed();
            assert_eq!(admitted, audience.contains(&user(candidate)));
        }
    }

    #[test]
    fn a_row_outside_the_default_view_has_no_audience() {
        for status in [
            MaterializationStatus::PendingMaterialization,
            MaterializationStatus::Failed,
        ] {
            assert!(agent_viewer_user_ids(Some(&owned_by("owner", status))).is_empty());
        }
        assert!(agent_viewer_user_ids(None).is_empty());
    }
}
