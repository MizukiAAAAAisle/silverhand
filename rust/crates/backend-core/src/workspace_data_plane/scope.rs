//! Resolving which workspace an agent-pane read is scoped to, and whether the
//! caller may reach it.
//!
//! The pane has two views. With no `workspace_id` the read is the agent's broad
//! home view — already gated by "may this human see this agent" upstream, so no
//! further workspace fact is consulted. With a `workspace_id` it is the narrower
//! per-workspace view, and that id must clear three questions before any daemon
//! round trip: the workspace exists, the human may view it, and the agent is a
//! member of it.
//!
//! Those three questions are NOT three independent boolean reads a handler ANDs
//! together. The production reader takes them under ONE read transaction and
//! returns [`AgentWorkspaceScopeFacts`] bound to the workspace it read for; this
//! pure resolver then judges the branch. Membership itself is the domain's rule,
//! not the SQL's: a workspace that is an agent's private home has no member
//! roster, so the agent is a member exactly when it owns that home; any other
//! workspace goes by its explicit member edge. The reader supplies both facts and
//! this function chooses between them, so the role/ownership rule lives here and
//! is never copied into a query.

use crate::identity::{AgentId, UserId, WorkspaceId};

/// Facts about one named workspace, read under a single transaction and bound to
/// the FULL triple they were read for — the workspace id, the viewing human, and
/// the subject agent. `owner_agent_id` present marks a private agent-home
/// container (which carries no member roster); the two membership booleans are
/// the human's `workspace_users` edge and the agent's `workspace_members` edge.
///
/// The two edges are naked booleans, so binding them to the coordinates they were
/// read for is what makes them trustworthy: a reader that answered for some other
/// human or agent would stamp THOSE coordinates, and the route rejects a bundle
/// whose triple does not match the request as a resolver defect (a safe `500`)
/// before any daemon round trip. Without the stamp a `(viewer B, agent B)` bundle
/// could authorize a `(viewer A, agent A)` request. The fields are read together
/// so the resolver judges one consistent snapshot, never three reads that could
/// tear against a concurrent enrollment.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AgentWorkspaceScopeFacts {
    requested: WorkspaceId,
    viewer: UserId,
    subject_agent: AgentId,
    present: bool,
    owner_agent_id: Option<AgentId>,
    human_is_member: bool,
    agent_is_workspace_member: bool,
}

impl AgentWorkspaceScopeFacts {
    /// The sole constructor: an adapter states every fact at once, so no partial
    /// snapshot can exist. `requested`/`viewer`/`subject_agent` are the exact
    /// coordinates the reader read the two edges for, which the route source-binds
    /// against the coordinates it asked about.
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        requested: WorkspaceId,
        viewer: UserId,
        subject_agent: AgentId,
        present: bool,
        owner_agent_id: Option<AgentId>,
        human_is_member: bool,
        agent_is_workspace_member: bool,
    ) -> Self {
        Self {
            requested,
            viewer,
            subject_agent,
            present,
            owner_agent_id,
            human_is_member,
            agent_is_workspace_member,
        }
    }

    /// The workspace id these facts were read for. The route rejects a bundle
    /// read for a different id as a resolver defect, never a product answer.
    pub fn requested(&self) -> &WorkspaceId {
        &self.requested
    }

    /// The viewing human the `human_is_member` edge was read for.
    pub fn viewer(&self) -> &UserId {
        &self.viewer
    }

    /// The subject agent the `agent_is_workspace_member` edge (and the home-owner
    /// comparison) was read for.
    pub fn subject_agent(&self) -> &AgentId {
        &self.subject_agent
    }
}

/// Why a scoped workspace read was refused, or that it is authorized. Each arm is
/// the domain outcome; the route maps it to the product status + code + message.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum AgentWorkspaceScopeResolution {
    /// The workspace exists, the human may view it, and the agent is a member:
    /// the read is scoped to [`AgentWorkspaceScopeFacts::requested`].
    Authorized,
    Refused(AgentWorkspaceScopeRefusal),
}

/// The three refusal arms of a scoped workspace read. Absence and "the human
/// cannot view it" stay distinct because the TypeScript surface renders them with
/// distinct codes and statuses; non-membership is its own 404 with its own code.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum AgentWorkspaceScopeRefusal {
    /// No such workspace row. `404 workspace_not_found`.
    WorkspaceNotFound,
    /// The workspace exists but this human is not on its roster. `403 forbidden`.
    ViewerForbidden,
    /// The human may view it, but the agent is not a member. `404
    /// workspace_agent_not_member`.
    AgentNotAMember,
}

/// Judge a scoped workspace read over one snapshot of facts.
///
/// The subject agent and viewer are read from the facts themselves, not passed
/// alongside: the route has already source-bound the bundle's triple to the
/// request, so the coordinates the two edges were read for ARE the request's. The
/// order mirrors the product ladder exactly: existence first (so a caller who may
/// not view a workspace cannot tell a real one from an invented one only via this
/// rung — existence is already public to a viewer here, but non-existence must
/// precede the view check to match the surface), then the human's view right,
/// then the agent's membership. Membership picks the owner-identity rule for a
/// home container and the explicit edge otherwise; the facts carry both and this
/// is the sole place that chooses.
pub fn resolve_agent_workspace_scope(
    facts: &AgentWorkspaceScopeFacts,
) -> AgentWorkspaceScopeResolution {
    if !facts.present {
        return AgentWorkspaceScopeResolution::Refused(
            AgentWorkspaceScopeRefusal::WorkspaceNotFound,
        );
    }
    if !facts.human_is_member {
        return AgentWorkspaceScopeResolution::Refused(AgentWorkspaceScopeRefusal::ViewerForbidden);
    }
    let agent_is_member = match &facts.owner_agent_id {
        // A private agent-home container has no roster: the agent is a member
        // exactly when it is the home's owner.
        Some(owner) => owner == &facts.subject_agent,
        // Any other workspace goes by its explicit member edge.
        None => facts.agent_is_workspace_member,
    };
    if !agent_is_member {
        return AgentWorkspaceScopeResolution::Refused(AgentWorkspaceScopeRefusal::AgentNotAMember);
    }
    AgentWorkspaceScopeResolution::Authorized
}

/// The single-transaction reader behind [`resolve_agent_workspace_scope`]. It
/// reads the existence, ownership, and both membership edges of one workspace
/// under one read transaction and returns them bound to the requested id. It
/// decides nothing: the branch is the pure resolver's, so no membership rule is
/// ever re-implemented in SQL.
pub trait AgentWorkspaceScopeRead {
    fn read_agent_workspace_scope(
        &self,
        workspace: &WorkspaceId,
        viewer: &UserId,
        agent: &AgentId,
    ) -> impl std::future::Future<
        Output = Result<AgentWorkspaceScopeFacts, crate::persistence::PersistenceFailure>,
    > + Send;
}

#[cfg(test)]
mod tests {
    use super::*;

    fn workspace(id: &str) -> WorkspaceId {
        WorkspaceId::parse(id).expect("workspace id")
    }

    fn agent(id: &str) -> AgentId {
        AgentId::parse(id).expect("agent id")
    }

    fn user(id: &str) -> UserId {
        UserId::parse(id).expect("user id")
    }

    #[test]
    fn an_absent_workspace_is_not_found_before_any_other_check() {
        // Not present, and every other fact set to what WOULD admit: absence wins.
        let facts = AgentWorkspaceScopeFacts::new(
            workspace("w1"),
            user("u1"),
            agent("a1"),
            false,
            None,
            true,
            true,
        );
        assert_eq!(
            resolve_agent_workspace_scope(&facts),
            AgentWorkspaceScopeResolution::Refused(AgentWorkspaceScopeRefusal::WorkspaceNotFound)
        );
    }

    #[test]
    fn a_non_viewing_human_is_forbidden_even_when_the_agent_is_a_member() {
        let facts = AgentWorkspaceScopeFacts::new(
            workspace("w1"),
            user("u1"),
            agent("a1"),
            true,
            None,
            false,
            true,
        );
        assert_eq!(
            resolve_agent_workspace_scope(&facts),
            AgentWorkspaceScopeResolution::Refused(AgentWorkspaceScopeRefusal::ViewerForbidden)
        );
    }

    #[test]
    fn a_regular_workspace_goes_by_the_explicit_member_edge() {
        let member = AgentWorkspaceScopeFacts::new(
            workspace("w1"),
            user("u1"),
            agent("a1"),
            true,
            None,
            true,
            true,
        );
        assert_eq!(
            resolve_agent_workspace_scope(&member),
            AgentWorkspaceScopeResolution::Authorized
        );
        let non_member = AgentWorkspaceScopeFacts::new(
            workspace("w1"),
            user("u1"),
            agent("a1"),
            true,
            None,
            true,
            false,
        );
        assert_eq!(
            resolve_agent_workspace_scope(&non_member),
            AgentWorkspaceScopeResolution::Refused(AgentWorkspaceScopeRefusal::AgentNotAMember)
        );
    }

    #[test]
    fn a_home_container_admits_only_its_owner_ignoring_the_member_edge() {
        // owner matches: authorized even though the (impossible) member edge is false.
        let owned = AgentWorkspaceScopeFacts::new(
            workspace("w1"),
            user("u1"),
            agent("a1"),
            true,
            Some(agent("a1")),
            true,
            false,
        );
        assert_eq!(
            resolve_agent_workspace_scope(&owned),
            AgentWorkspaceScopeResolution::Authorized
        );
        // owner is a different agent: not a member even though the member edge is true.
        let other = AgentWorkspaceScopeFacts::new(
            workspace("w1"),
            user("u1"),
            agent("a1"),
            true,
            Some(agent("a2")),
            true,
            true,
        );
        assert_eq!(
            resolve_agent_workspace_scope(&other),
            AgentWorkspaceScopeResolution::Refused(AgentWorkspaceScopeRefusal::AgentNotAMember)
        );
    }
}
