//! Driver-free contract test for agent workspace enrollment.
//!
//! `FakeAccess` implements the read port and the async semantic unit of work
//! with no persistence technology in scope — a connection, row, or driver error
//! in any signature would break this build. Its `enroll_agent` models one atomic
//! transaction: it derives `created` from the membership it is about to write
//! (not a read taken beforehand), and commits the membership and its create-only
//! capability seed together, or neither, so the rollback and seed-only-on-create
//! obligations are exercised rather than merely asserted.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use silverhand_backend_core::identity::{AgentId, Principal, UserId, WorkspaceId};
use silverhand_backend_core::identity_access::access::{
    AddAgentMemberError, AgentAuthorityFacts, AgentEnrollmentReadPort, AgentEnrollmentUnitOfWork,
    AgentWorkspaceMembership, Capability, DEFAULT_AGENT_CAPABILITIES, EnrollmentClock,
    EnrollmentKey, add_workspace_agent_member,
};
use silverhand_backend_core::persistence::PersistenceFailure;

const JOINED_AT_MS: i64 = 1_700_000_000_000;

/// A deterministic clock: the use case samples it after authorization and hands
/// the value to the unit of work as the create candidate. Infallible, like the
/// production clock — reading the time is not a failure mode.
#[derive(Clone, Copy)]
struct FixedClock(i64);

impl EnrollmentClock for FixedClock {
    fn now_unix_millis(&self) -> i64 {
        self.0
    }
}

fn clock() -> FixedClock {
    FixedClock(JOINED_AT_MS)
}

#[derive(Default)]
struct Store {
    memberships: Vec<(String, String)>,
    /// One row per granted capability, as `(workspace, agent, token)` — the same
    /// grain the persisted capability table uses, so a re-seed would show up as
    /// duplicate rows.
    capabilities: Vec<(String, String, &'static str)>,
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
                id: AgentId::parse(id).unwrap(),
                created_by_user_id: UserId::parse(owner).unwrap(),
            },
        );
        self
    }
}

#[derive(Debug)]
struct DriverError(&'static str);
impl std::fmt::Display for DriverError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.0)
    }
}
impl std::error::Error for DriverError {}

impl AgentEnrollmentReadPort for FakeAccess {
    async fn agent(
        &self,
        agent_id: &AgentId,
    ) -> Result<Option<AgentAuthorityFacts>, PersistenceFailure> {
        Ok(self.agents.get(agent_id.as_str()).cloned())
    }
}

impl AgentEnrollmentUnitOfWork for FakeAccess {
    async fn enroll_agent(
        &self,
        key: EnrollmentKey,
        seed_on_create: &[Capability],
        joined_at_candidate: i64,
    ) -> Result<AgentWorkspaceMembership, PersistenceFailure> {
        // One transaction, one lock: everything below either commits together or
        // rolls back together.
        let mut store = self.store.lock().unwrap();
        let pair = (
            key.workspace_id.as_str().to_owned(),
            key.agent_id.as_str().to_owned(),
        );

        if self.fail_insert {
            return Err(PersistenceFailure::from_source(DriverError(
                "insert failed",
            )));
        }
        // `created` is the effect of the idempotent insert itself, not a prior
        // read: a fresh pair is created, an existing one is a no-op.
        let created = !store.memberships.contains(&pair);

        if created {
            // The seed runs inside the same transaction; if it fails, the whole
            // transaction rolls back and neither row persists.
            if self.fail_seed {
                return Err(PersistenceFailure::from_source(DriverError("seed failed")));
            }
            store.memberships.push(pair.clone());
            for capability in seed_on_create {
                store
                    .capabilities
                    .push((pair.0.clone(), pair.1.clone(), capability.as_str()));
            }
        }

        Ok(AgentWorkspaceMembership {
            workspace_id: key.workspace_id,
            agent_id: key.agent_id,
            joined_at_ms: joined_at_candidate,
        })
    }
}

fn ws() -> WorkspaceId {
    WorkspaceId::parse("ws-1").unwrap()
}

fn granted(store: &Store, agent: &str) -> Vec<&'static str> {
    store
        .capabilities
        .iter()
        .filter(|(_, a, _)| a == agent)
        .map(|(_, _, token)| *token)
        .collect()
}

#[tokio::test]
async fn owner_enrolls_own_agent_and_seeds_on_first_create() {
    let fake = FakeAccess::default().with_agent("agent-1", "user-1");
    let principal = Principal::Human {
        user_id: UserId::parse("user-1").unwrap(),
    };

    let member = add_workspace_agent_member(
        &fake,
        &fake,
        &clock(),
        &principal,
        ws(),
        AgentId::parse("agent-1").unwrap(),
    )
    .await
    .expect("owner may enroll own agent");

    assert_eq!(member.agent_id, AgentId::parse("agent-1").unwrap());
    let store = fake.store.lock().unwrap();
    assert_eq!(store.memberships.len(), 1);
    let expected: Vec<&str> = DEFAULT_AGENT_CAPABILITIES
        .iter()
        .map(Capability::as_str)
        .collect();
    assert_eq!(granted(&store, "agent-1"), expected);
}

#[tokio::test]
async fn re_enroll_does_not_reseed() {
    let fake = FakeAccess::default().with_agent("agent-1", "user-1");
    let principal = Principal::Human {
        user_id: UserId::parse("user-1").unwrap(),
    };

    add_workspace_agent_member(
        &fake,
        &fake,
        &clock(),
        &principal,
        ws(),
        AgentId::parse("agent-1").unwrap(),
    )
    .await
    .unwrap();
    add_workspace_agent_member(
        &fake,
        &fake,
        &clock(),
        &principal,
        ws(),
        AgentId::parse("agent-1").unwrap(),
    )
    .await
    .expect("re-enroll is idempotent");

    let store = fake.store.lock().unwrap();
    assert_eq!(store.memberships.len(), 1, "no duplicate membership row");
    assert_eq!(
        granted(&store, "agent-1").len(),
        DEFAULT_AGENT_CAPABILITIES.len(),
        "seed runs only on create — no duplicated capability rows"
    );
}

#[tokio::test]
async fn missing_agent_is_not_found() {
    let fake = FakeAccess::default();
    let principal = Principal::System;

    let err = add_workspace_agent_member(
        &fake,
        &fake,
        &clock(),
        &principal,
        ws(),
        AgentId::parse("ghost").unwrap(),
    )
    .await
    .unwrap_err();

    assert!(matches!(err, AddAgentMemberError::AgentNotFound));
    assert!(fake.store.lock().unwrap().memberships.is_empty());
}

#[tokio::test]
async fn foreign_agent_is_not_owned() {
    let fake = FakeAccess::default().with_agent("agent-1", "owner");
    let principal = Principal::Human {
        user_id: UserId::parse("intruder").unwrap(),
    };

    let err = add_workspace_agent_member(
        &fake,
        &fake,
        &clock(),
        &principal,
        ws(),
        AgentId::parse("agent-1").unwrap(),
    )
    .await
    .unwrap_err();

    assert!(matches!(err, AddAgentMemberError::AgentNotOwned));
    assert!(fake.store.lock().unwrap().memberships.is_empty());
}

#[tokio::test]
async fn agent_principal_can_never_enroll() {
    let fake = FakeAccess::default().with_agent("agent-1", "user-1");
    let principal = Principal::Agent {
        agent_id: AgentId::parse("agent-1").unwrap(),
    };

    let err = add_workspace_agent_member(
        &fake,
        &fake,
        &clock(),
        &principal,
        ws(),
        AgentId::parse("agent-1").unwrap(),
    )
    .await
    .unwrap_err();

    assert!(matches!(err, AddAgentMemberError::AgentNotOwned));
}

#[tokio::test]
async fn system_may_enroll_any_existing_agent() {
    let fake = FakeAccess::default().with_agent("agent-1", "someone-else");
    let principal = Principal::System;

    add_workspace_agent_member(
        &fake,
        &fake,
        &clock(),
        &principal,
        ws(),
        AgentId::parse("agent-1").unwrap(),
    )
    .await
    .expect("system enrolls regardless of ownership");
}

#[tokio::test]
async fn persistence_failure_rolls_back_and_surfaces() {
    let mut fake = FakeAccess::default().with_agent("agent-1", "user-1");
    fake.fail_seed = true;
    let principal = Principal::Human {
        user_id: UserId::parse("user-1").unwrap(),
    };

    let err = add_workspace_agent_member(
        &fake,
        &fake,
        &clock(),
        &principal,
        ws(),
        AgentId::parse("agent-1").unwrap(),
    )
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
    assert!(
        store.capabilities.is_empty(),
        "rolled back: no capability seed"
    );
}
