//! Public enrollment authority without a second implementation of persistence.
//! Actual idempotency, capability seeding and rollback belong to SQLite tests.

use silverhand_backend_core::foundation::identity::{AgentId, Principal, UserId, WorkspaceId};
use silverhand_backend_core::foundation::persistence::PersistenceFailure;
use silverhand_backend_core::identity_access::access::{
    AddAgentMemberError, AgentAuthorityFacts, AgentEnrollmentReadPort, AgentEnrollmentUnitOfWork,
    AgentWorkspaceMembership, Capability, EnrollmentClock, EnrollmentKey,
    add_workspace_agent_member,
};
use std::sync::{
    Arc,
    atomic::{AtomicUsize, Ordering},
};

#[derive(Clone)]
struct Boundary {
    exists: bool,
    writes: Arc<AtomicUsize>,
}

impl AgentEnrollmentReadPort for Boundary {
    async fn agent(&self, id: &AgentId) -> Result<Option<AgentAuthorityFacts>, PersistenceFailure> {
        assert_eq!(id.as_str(), "agent-1");
        Ok(self.exists.then(|| AgentAuthorityFacts {
            id: id.clone(),
            created_by_user_id: UserId::parse("owner").unwrap(),
        }))
    }
}

impl AgentEnrollmentUnitOfWork for Boundary {
    async fn enroll_agent(
        &self,
        key: EnrollmentKey,
        _: &[Capability],
        stamp: i64,
    ) -> Result<AgentWorkspaceMembership, PersistenceFailure> {
        self.writes.fetch_add(1, Ordering::SeqCst);
        Ok(AgentWorkspaceMembership {
            workspace_id: key.workspace_id,
            agent_id: key.agent_id,
            joined_at_ms: stamp,
        })
    }
}

#[derive(Clone)]
struct Clock;
impl EnrollmentClock for Clock {
    fn now_unix_millis(&self) -> i64 {
        123
    }
}

#[tokio::test]
async fn owner_and_system_enroll_but_other_principals_and_missing_agents_do_not() {
    let human = |id| Principal::Human {
        user_id: UserId::parse(id).unwrap(),
    };
    for (principal, exists, expected) in [
        (human("owner"), true, "allowed"),
        (human("intruder"), true, "not_owned"),
        (
            Principal::Agent {
                agent_id: AgentId::parse("agent-1").unwrap(),
            },
            true,
            "not_owned",
        ),
        (Principal::System, true, "allowed"),
        (Principal::System, false, "not_found"),
    ] {
        let boundary = Boundary {
            exists,
            writes: Arc::default(),
        };
        let result = add_workspace_agent_member(
            &boundary,
            &boundary,
            &Clock,
            &principal,
            WorkspaceId::parse("ws-1").unwrap(),
            AgentId::parse("agent-1").unwrap(),
        )
        .await;
        match expected {
            "allowed" => assert_eq!(
                result.unwrap(),
                AgentWorkspaceMembership {
                    workspace_id: WorkspaceId::parse("ws-1").unwrap(),
                    agent_id: AgentId::parse("agent-1").unwrap(),
                    joined_at_ms: 123,
                }
            ),
            "not_owned" => assert!(matches!(result, Err(AddAgentMemberError::AgentNotOwned))),
            "not_found" => assert!(matches!(result, Err(AddAgentMemberError::AgentNotFound))),
            _ => unreachable!(),
        }
        assert_eq!(
            boundary.writes.load(Ordering::SeqCst),
            usize::from(expected == "allowed")
        );
    }
}
