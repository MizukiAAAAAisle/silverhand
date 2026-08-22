//! Driver-free contract test for agent workspace enrollment.
//!
//! `FakeAccess` implements the read and unit-of-work ports with no persistence
//! technology in scope — a connection, row, or driver error in any signature
//! would break this build. Its transaction stages writes and applies them only
//! when the write-core returns `Ok`, so the rollback and seed-only-on-create
//! obligations are exercised, not just asserted.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use silverhand_backend_core::access::{
    AddAgentMemberError, AgentAuthorityFacts, AgentEnrollmentReadPort, AgentEnrollmentUnitOfWork,
    AgentId, AgentMembershipTx, AgentWorkspaceMembership, EnrollmentKey, MembershipInsertOutcome,
    Principal, UserId, WorkspaceId, add_workspace_agent_member, enroll_agent_into_workspace,
};
use silverhand_backend_core::persistence::PersistenceFailure;

const JOINED_AT_MS: i64 = 1_700_000_000_000;

#[derive(Default)]
struct Store {
    memberships: Vec<(String, String)>,
    seeded_agents: Vec<String>,
}

#[derive(Clone, Default)]
struct FakeAccess {
    agents: HashMap<String, AgentAuthorityFacts>,
    store: Arc<Mutex<Store>>,
    fail_insert: bool,
    fail_seed: bool,
}

impl FakeAccess {
    fn with_agent(mut self, id: &str, owner: &str) -> Self {
        self.agents.insert(
            id.to_owned(),
            AgentAuthorityFacts {
                id: AgentId::new(id),
                created_by_user_id: UserId::new(owner),
            },
        );
        self
    }
}

impl AgentEnrollmentReadPort for FakeAccess {
    async fn agent(
        &self,
        agent_id: &AgentId,
    ) -> Result<Option<AgentAuthorityFacts>, PersistenceFailure> {
        Ok(self.agents.get(agent_id.as_str()).cloned())
    }
}

/// Stages membership + seed and reports `created` from a snapshot of the store
/// taken at transaction open; nothing reaches the store until the enclosing
/// `enroll` commits.
struct FakeTx {
    key: EnrollmentKey,
    already_member: bool,
    fail_insert: bool,
    fail_seed: bool,
    staged_member: Option<AgentWorkspaceMembership>,
    staged_seed: bool,
}

#[derive(Debug)]
struct DriverError(&'static str);
impl std::fmt::Display for DriverError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.0)
    }
}
impl std::error::Error for DriverError {}

impl AgentMembershipTx for FakeTx {
    fn insert_workspace_membership(
        &mut self,
    ) -> Result<MembershipInsertOutcome, PersistenceFailure> {
        if self.fail_insert {
            return Err(PersistenceFailure::from_source(DriverError(
                "insert failed",
            )));
        }
        let member = AgentWorkspaceMembership {
            workspace_id: self.key.workspace_id.clone(),
            agent_id: self.key.agent_id.clone(),
            joined_at_ms: JOINED_AT_MS,
        };
        self.staged_member = Some(member.clone());
        Ok(MembershipInsertOutcome {
            member,
            created: !self.already_member,
        })
    }

    fn seed_capability_defaults(&mut self) -> Result<(), PersistenceFailure> {
        if self.fail_seed {
            return Err(PersistenceFailure::from_source(DriverError("seed failed")));
        }
        self.staged_seed = true;
        Ok(())
    }
}

impl AgentEnrollmentUnitOfWork for FakeAccess {
    async fn enroll(
        &self,
        key: EnrollmentKey,
        write_core: impl FnOnce(
            &mut dyn AgentMembershipTx,
        ) -> Result<AgentWorkspaceMembership, PersistenceFailure>
        + Send,
    ) -> Result<AgentWorkspaceMembership, PersistenceFailure> {
        let pair = (
            key.workspace_id.as_str().to_owned(),
            key.agent_id.as_str().to_owned(),
        );
        let already_member = {
            let store = self.store.lock().unwrap();
            store.memberships.contains(&pair)
        };
        let mut tx = FakeTx {
            key,
            already_member,
            fail_insert: self.fail_insert,
            fail_seed: self.fail_seed,
            staged_member: None,
            staged_seed: false,
        };
        let result = write_core(&mut tx);
        // Commit staged writes only on success; otherwise the transaction rolls
        // back and the store is untouched.
        if result.is_ok() {
            let mut store = self.store.lock().unwrap();
            if !already_member {
                store.memberships.push(pair);
            }
            if tx.staged_seed {
                store
                    .seeded_agents
                    .push(tx.key.agent_id.as_str().to_owned());
            }
        }
        result
    }
}

fn ws() -> WorkspaceId {
    WorkspaceId::new("ws-1")
}

#[tokio::test]
async fn owner_enrolls_own_agent_and_seeds_on_first_create() {
    let fake = FakeAccess::default().with_agent("agent-1", "user-1");
    let principal = Principal::Human {
        user_id: UserId::new("user-1"),
    };

    let member =
        add_workspace_agent_member(&fake, &fake, &principal, ws(), AgentId::new("agent-1"))
            .await
            .expect("owner may enroll own agent");

    assert_eq!(member.agent_id, AgentId::new("agent-1"));
    let store = fake.store.lock().unwrap();
    assert_eq!(store.memberships.len(), 1);
    assert_eq!(store.seeded_agents, vec!["agent-1".to_owned()]);
}

#[tokio::test]
async fn re_enroll_does_not_reseed() {
    let fake = FakeAccess::default().with_agent("agent-1", "user-1");
    let principal = Principal::Human {
        user_id: UserId::new("user-1"),
    };

    add_workspace_agent_member(&fake, &fake, &principal, ws(), AgentId::new("agent-1"))
        .await
        .unwrap();
    add_workspace_agent_member(&fake, &fake, &principal, ws(), AgentId::new("agent-1"))
        .await
        .expect("re-enroll is idempotent");

    let store = fake.store.lock().unwrap();
    assert_eq!(store.memberships.len(), 1, "no duplicate membership row");
    assert_eq!(store.seeded_agents.len(), 1, "seed runs only on create");
}

#[tokio::test]
async fn missing_agent_is_not_found() {
    let fake = FakeAccess::default();
    let principal = Principal::System;

    let err = add_workspace_agent_member(&fake, &fake, &principal, ws(), AgentId::new("ghost"))
        .await
        .unwrap_err();

    assert!(matches!(err, AddAgentMemberError::AgentNotFound));
    assert!(fake.store.lock().unwrap().memberships.is_empty());
}

#[tokio::test]
async fn foreign_agent_is_not_owned() {
    let fake = FakeAccess::default().with_agent("agent-1", "owner");
    let principal = Principal::Human {
        user_id: UserId::new("intruder"),
    };

    let err = add_workspace_agent_member(&fake, &fake, &principal, ws(), AgentId::new("agent-1"))
        .await
        .unwrap_err();

    assert!(matches!(err, AddAgentMemberError::AgentNotOwned));
    assert!(fake.store.lock().unwrap().memberships.is_empty());
}

#[tokio::test]
async fn agent_principal_can_never_enroll() {
    let fake = FakeAccess::default().with_agent("agent-1", "user-1");
    let principal = Principal::Agent {
        agent_id: AgentId::new("agent-1"),
    };

    let err = add_workspace_agent_member(&fake, &fake, &principal, ws(), AgentId::new("agent-1"))
        .await
        .unwrap_err();

    assert!(matches!(err, AddAgentMemberError::AgentNotOwned));
}

#[tokio::test]
async fn system_may_enroll_any_existing_agent() {
    let fake = FakeAccess::default().with_agent("agent-1", "someone-else");
    let principal = Principal::System;

    add_workspace_agent_member(&fake, &fake, &principal, ws(), AgentId::new("agent-1"))
        .await
        .expect("system enrolls regardless of ownership");
}

#[tokio::test]
async fn persistence_failure_rolls_back_and_surfaces() {
    let mut fake = FakeAccess::default().with_agent("agent-1", "user-1");
    fake.fail_seed = true;
    let principal = Principal::Human {
        user_id: UserId::new("user-1"),
    };

    let err = add_workspace_agent_member(&fake, &fake, &principal, ws(), AgentId::new("agent-1"))
        .await
        .unwrap_err();

    match err {
        AddAgentMemberError::Persistence(p) => {
            assert!(std::error::Error::source(&p).is_some(), "cause preserved");
        }
        other => panic!("expected persistence failure, got {other:?}"),
    }
    let store = fake.store.lock().unwrap();
    assert!(store.memberships.is_empty(), "rolled back: no membership");
    assert!(store.seeded_agents.is_empty(), "rolled back: no seed");
}

/// The write-core is directly usable against a bare `&mut dyn AgentMembershipTx`
/// with no unit-of-work in scope, holding the seed policy outside any adapter.
#[test]
fn write_core_seeds_only_when_created() {
    struct OneShotTx {
        created: bool,
        seeded: bool,
    }
    impl AgentMembershipTx for OneShotTx {
        fn insert_workspace_membership(
            &mut self,
        ) -> Result<MembershipInsertOutcome, PersistenceFailure> {
            Ok(MembershipInsertOutcome {
                member: AgentWorkspaceMembership {
                    workspace_id: WorkspaceId::new("ws-1"),
                    agent_id: AgentId::new("agent-1"),
                    joined_at_ms: JOINED_AT_MS,
                },
                created: self.created,
            })
        }
        fn seed_capability_defaults(&mut self) -> Result<(), PersistenceFailure> {
            self.seeded = true;
            Ok(())
        }
    }

    let mut fresh = OneShotTx {
        created: true,
        seeded: false,
    };
    enroll_agent_into_workspace(&mut fresh).unwrap();
    assert!(fresh.seeded, "fresh row seeds");

    let mut existing = OneShotTx {
        created: false,
        seeded: false,
    };
    enroll_agent_into_workspace(&mut existing).unwrap();
    assert!(!existing.seeded, "existing row does not re-seed");
}
