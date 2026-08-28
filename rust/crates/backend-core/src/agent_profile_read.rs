//! The narrow stored facts one internal agent-profile read projects.
//!
//! The internal profile routes (`GET /internal/agents/{aid}/profile` and the
//! peer read) return only `{ id, name, display_name, description, avatar_url }`.
//! Unlike [`crate::agent_detail_read`], that face needs NO host `LEFT JOIN` and
//! NO viewer ACL: an internal route is self-pinned (or, for a peer, gated by
//! workspace membership in the route's own gate), never judged against the
//! creator / direct-pair / workspace-member arms the detail read carries.
//!
//! So this module states ONLY the missing lookup capability — read one agent's
//! narrow profile columns by id — and returns a minimal fact. It deliberately
//! does not reuse the wider [`crate::agent_detail_read::AgentDetailProjection`]
//! nor reproduce the detail ACL, so it cannot pull the visibility gate of a
//! viewer-scoped read into a route that is capability-gated instead.

use std::future::Future;

use crate::{identity::AgentId, messaging::AvatarRevision, persistence::PersistenceFailure};

/// The narrow profile face of one agent row.
///
/// `id` is the SEALED, row-sourced [`AgentId`], not the query coordinate: a
/// caller reads by a request `:aid` (or, for a peer, by handle), and the fact
/// hands back the id the returned row actually carries so the route binds its
/// response to a verified source rather than trusting the adapter returned the
/// right row. `name` is likewise a committed source witness — a peer read can
/// confirm the projection's origin against it.
///
/// The avatar is a folded [`AvatarRevision`], never a storage locator: the row's
/// non-empty pointer + `updated_at` collapse to `Some(revision)` (`None` for an
/// empty/absent pointer), which is the entire input the canonical `avatar_url`
/// derivation needs — presence and cache-buster. The storage key never crosses
/// this boundary; only a route that actually reads the blob consumes a typed
/// blob ref. There is no second avatar-URL rule here.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AgentProfileFact {
    pub id: AgentId,
    pub name: String,
    pub display_name: String,
    pub description: Option<String>,
    pub avatar: Option<AvatarRevision>,
}

/// Reads the narrow profile facts for one agent by id.
///
/// `None` is the row being absent — a fact the route renders as a `404`, never a
/// failed read. This is the whole contract: no ACL, no host facts, no refusal
/// ordering. Those all belong to the route's gate, not to the read.
pub trait AgentProfileReadModel {
    fn read_agent_profile(
        &self,
        agent: &AgentId,
    ) -> impl Future<Output = Result<Option<AgentProfileFact>, PersistenceFailure>> + Send;
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    #[derive(Default)]
    struct FakeProfiles {
        rows: HashMap<String, AgentProfileFact>,
    }

    impl AgentProfileReadModel for FakeProfiles {
        async fn read_agent_profile(
            &self,
            agent: &AgentId,
        ) -> Result<Option<AgentProfileFact>, PersistenceFailure> {
            Ok(self.rows.get(agent.as_str()).cloned())
        }
    }

    fn agent(id: &str) -> AgentId {
        AgentId::parse(id).expect("agent id")
    }

    #[tokio::test]
    async fn a_present_row_projects_and_a_missing_row_is_none() {
        let mut profiles = FakeProfiles::default();
        profiles.rows.insert(
            "a1".to_string(),
            AgentProfileFact {
                id: agent("a1"),
                name: "agent-one".to_string(),
                display_name: "Agent One".to_string(),
                description: Some("hi".to_string()),
                avatar: Some(AvatarRevision::at(2000)),
            },
        );

        let found = profiles.read_agent_profile(&agent("a1")).await.unwrap();
        assert_eq!(
            found,
            Some(AgentProfileFact {
                id: agent("a1"),
                name: "agent-one".to_string(),
                display_name: "Agent One".to_string(),
                description: Some("hi".to_string()),
                avatar: Some(AvatarRevision::at(2000)),
            })
        );
        assert_eq!(
            profiles.read_agent_profile(&agent("absent")).await.unwrap(),
            None
        );
    }
}
