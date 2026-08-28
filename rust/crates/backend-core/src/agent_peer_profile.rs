//! The peer-profile target-resolution tail (`GET
//! /internal/agents/{aid}/peer-profile`).
//!
//! The route reads ANOTHER agent's narrow profile by a caller-supplied handle.
//! Its caller-side gates — the conversation floor, the workspace horizon, the
//! `read_messages` capability — are resolved in the SERVER handler BEFORE this
//! runs, and deliberately so: nothing about the target, not even whether the
//! handle exists, may be observable by a caller who fails them (anti-enumeration,
//! #957). By the time [`resolve_peer_target`] is called the caller has already
//! earned the right to ask "who is this handle in this workspace"; this function
//! is only the target tail.
//!
//! ## The tail's own order is load-bearing too
//!
//! read-by-handle → BIND the returned name to the requested handle → require the
//! target be a member of the workspace. The binding is FIRST: a reader that
//! hands back the wrong row is a safe `500` that short-circuits before the
//! membership edge is even consulted, so a broken read can never be laundered
//! into a membership answer about some other agent. Past the binding, an unknown
//! handle and a handle that resolves to a non-member collapse into ONE
//! [`PeerTargetOutcome::NotFound`] — the single, indistinguishable `404` the
//! route serves, so a caller cannot enumerate who exists across workspaces.

use std::future::Future;

use crate::{
    agent_profile_read::{
        AgentProfileFact, AgentProfileReadModel, ProfileReadFault, bind_to_handle,
    },
    identity::{AgentId, WorkspaceId},
    persistence::PersistenceFailure,
};

/// Whether an agent is a member of a workspace — the authoritative
/// `workspace_members` edge the peer read gates its target on.
///
/// This is the NARROW requirement the peer tail consumes: a single boolean edge,
/// not a membership directory or a governance read. Its production adapter is the
/// canonical `workspace_members` query (`SELECT 1 FROM workspace_members WHERE
/// workspace_id = ? AND agent_id = ?`), the same edge the TS `workspaces.isMember`
/// resolves — this port must be answerable by that authority directly, with no
/// second membership model minted here.
pub trait PeerTargetMembership {
    fn agent_is_member(
        &self,
        workspace: &WorkspaceId,
        agent: &AgentId,
    ) -> impl Future<Output = Result<bool, PersistenceFailure>> + Send;
}

/// The target tail's outcome. `NotFound` is the collapsed `404`: it does not say
/// whether the collapse was an unknown handle or a known-but-non-member agent,
/// because distinguishing them would answer a cross-workspace existence question.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum PeerTargetOutcome {
    Found(AgentProfileFact),
    NotFound,
}

/// Resolve a peer target after the caller-side gates have passed: read by handle,
/// bind the returned name to `handle`, then require the target be a member of
/// `workspace`.
///
/// Order: the source-binding runs BEFORE membership, so a dishonest reader is a
/// safe `500` ([`ProfileReadFault::Source`]) and the membership edge is never
/// consulted for a row that is not the requested handle. Unknown handle → the
/// membership edge is not consulted (there is nothing to check) and the outcome
/// is `NotFound`; a bound non-member → `NotFound` as well. The two collapse into
/// the one indistinguishable answer.
pub async fn resolve_peer_target<R, M>(
    reader: &R,
    membership: &M,
    handle: &str,
    workspace: &WorkspaceId,
) -> Result<PeerTargetOutcome, ProfileReadFault>
where
    R: AgentProfileReadModel + ?Sized,
    M: PeerTargetMembership + ?Sized,
{
    let Some(fact) = reader.read_agent_profile_by_handle(handle).await? else {
        return Ok(PeerTargetOutcome::NotFound);
    };
    // Bind FIRST — a wrong row is a fault, not a membership question.
    let fact = bind_to_handle(handle, fact)?;
    if membership.agent_is_member(workspace, &fact.id).await? {
        Ok(PeerTargetOutcome::Found(fact))
    } else {
        Ok(PeerTargetOutcome::NotFound)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::messaging::AvatarRevision;
    use std::{
        collections::{HashMap, HashSet},
        sync::atomic::{AtomicBool, Ordering},
    };

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

        async fn read_agent_profile_by_handle(
            &self,
            handle: &str,
        ) -> Result<Option<AgentProfileFact>, PersistenceFailure> {
            Ok(self.rows.values().find(|fact| fact.name == handle).cloned())
        }
    }

    /// A liar whose by-handle read returns a row whose name is NOT the handle.
    struct LiarReader {
        row: AgentProfileFact,
    }

    impl AgentProfileReadModel for LiarReader {
        async fn read_agent_profile(
            &self,
            _agent: &AgentId,
        ) -> Result<Option<AgentProfileFact>, PersistenceFailure> {
            Ok(Some(self.row.clone()))
        }

        async fn read_agent_profile_by_handle(
            &self,
            _handle: &str,
        ) -> Result<Option<AgentProfileFact>, PersistenceFailure> {
            Ok(Some(self.row.clone()))
        }
    }

    /// Records whether the membership edge was consulted, so a test can prove the
    /// binding short-circuits BEFORE it.
    struct RecordingMembership {
        members: HashSet<String>,
        consulted: AtomicBool,
    }

    impl RecordingMembership {
        fn with(members: impl IntoIterator<Item = &'static str>) -> Self {
            Self {
                members: members.into_iter().map(str::to_string).collect(),
                consulted: AtomicBool::new(false),
            }
        }

        fn consulted(&self) -> bool {
            self.consulted.load(Ordering::SeqCst)
        }
    }

    impl PeerTargetMembership for RecordingMembership {
        async fn agent_is_member(
            &self,
            _workspace: &WorkspaceId,
            agent: &AgentId,
        ) -> Result<bool, PersistenceFailure> {
            self.consulted.store(true, Ordering::SeqCst);
            Ok(self.members.contains(agent.as_str()))
        }
    }

    fn agent(id: &str) -> AgentId {
        AgentId::parse(id).expect("agent id")
    }

    fn workspace() -> WorkspaceId {
        WorkspaceId::parse("w1").expect("workspace id")
    }

    fn fact(id: &str, name: &str) -> AgentProfileFact {
        AgentProfileFact {
            id: agent(id),
            name: name.to_string(),
            display_name: name.to_string(),
            description: None,
            avatar: Some(AvatarRevision::at(10)),
        }
    }

    #[tokio::test]
    async fn a_bound_member_is_found() {
        let profiles = FakeProfiles {
            rows: HashMap::from([("t1".to_string(), fact("t1", "target"))]),
        };
        let membership = RecordingMembership::with(["t1"]);
        let outcome = resolve_peer_target(&profiles, &membership, "target", &workspace())
            .await
            .expect("honest read");
        assert_eq!(outcome, PeerTargetOutcome::Found(fact("t1", "target")));
    }

    #[tokio::test]
    async fn a_bound_non_member_collapses_to_not_found() {
        let profiles = FakeProfiles {
            rows: HashMap::from([("t1".to_string(), fact("t1", "target"))]),
        };
        // Membership is consulted (the handle bound) and answers false.
        let membership = RecordingMembership::with([]);
        let outcome = resolve_peer_target(&profiles, &membership, "target", &workspace())
            .await
            .expect("honest read");
        assert_eq!(outcome, PeerTargetOutcome::NotFound);
        assert!(membership.consulted(), "a bound handle is checked");
    }

    #[tokio::test]
    async fn an_unknown_handle_collapses_without_consulting_membership() {
        let profiles = FakeProfiles {
            rows: HashMap::new(),
        };
        let membership = RecordingMembership::with(["t1"]);
        let outcome = resolve_peer_target(&profiles, &membership, "ghost", &workspace())
            .await
            .expect("absent is not a fault");
        assert_eq!(outcome, PeerTargetOutcome::NotFound);
        assert!(
            !membership.consulted(),
            "no row means nothing to check membership for"
        );
    }

    /// Liar-reader test #2 (by-handle): a reader that returns a row whose name is
    /// not the requested handle is a safe `500`, AND the membership edge is never
    /// consulted — the binding short-circuits before it, so a broken read cannot
    /// be laundered into a membership answer about another agent.
    #[tokio::test]
    async fn a_by_handle_liar_is_a_source_violation_before_membership() {
        use crate::agent_profile_read::ProfileSourceViolation;

        let liar = LiarReader {
            row: fact("t1", "someone-else"),
        };
        let membership = RecordingMembership::with(["t1"]);
        let outcome = resolve_peer_target(&liar, &membership, "target", &workspace()).await;
        match outcome {
            Err(ProfileReadFault::Source(ProfileSourceViolation::Handle {
                requested,
                returned,
            })) => {
                assert_eq!(requested, "target");
                assert_eq!(returned, "someone-else");
            }
            other => panic!("expected a handle source violation, got {other:?}"),
        }
        assert!(
            !membership.consulted(),
            "the binding must short-circuit before membership"
        );
    }
}
