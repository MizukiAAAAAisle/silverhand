//! Deleting a computer: the order the two phases must happen in, and what the
//! committed half owes afterwards.
//!
//! The rules this sequences are not restated here. Whether the computer is the
//! requester's is [`can_access_computer`]'s, whether its lifecycle is a user
//! request's to end is [`hold_computer_lifecycle`]'s, whether its dependency set
//! admits the cascade is [`super::cascade::admit_cascade`]'s, and all three are
//! decided AGAIN inside [`AgentTeardownUnitOfWork::cascade_computer`] from facts read
//! under the mechanism. What is decided here is only the sequence — and the sequence
//! is the part that can destroy something a refusal was about to prevent.
//!
//! ## The pre-lock verdicts are thrown away
//!
//! This module mints two witnesses before the lock and hands NEITHER to the write:
//! [`AgentTeardownUnitOfWork::cascade_computer`] takes a coordinate and the consent,
//! nothing else. So the pre-lock reads can only make the answer come sooner, never
//! make it different, which is what makes answering "not yours" without taking a
//! write lock safe.
//!
//! The two reads are also separate ([`AgentTeardownReadPort`] keeps ownership and
//! lifecycle apart so neither rule can read the other's facts), so the row can
//! disappear between them. That answers as "not theirs" — the same answer a
//! never-existing computer gets, for the same anti-enumeration reason.
//!
//! ## Everything unrollbackable happens after the commit
//!
//! A non-2xx means nothing happened, INCLUDING bytes. Every effect below runs once
//! the rows are gone, so a refusal cannot leave a half-deleted computer behind: an
//! agent whose host-local tree was purged for a request that then failed would be a
//! half-delete no retry can undo.
//!
//! The price is that this phase cannot fail the request. It is reported instead —
//! [`DeletedComputer::residue`] — because residue left here can no longer be found
//! from the database: the rows that could name those bytes are the rows just
//! deleted.
//!
//! [`can_access_computer`]: crate::identity_access::capability::computer_access::can_access_computer
//! [`hold_computer_lifecycle`]: super::cascade::hold_computer_lifecycle

use std::future::Future;

use thiserror::Error;

use crate::{
    application_orchestration::teardown::{
        cascade::{CascadeConsent, CascadeRefused, ComputerLifecycle, hold_computer_lifecycle},
        contract::TeardownFailure,
        facts::{AgentRuntimeSessionFacts, StoredBlobRef, is_running_session},
        read::AgentTeardownReadPort,
        write::{
            AgentTeardownUnitOfWork, ComputerCascade, ComputerCascadeCommit, ComputerTeardownKey,
        },
    },
    foundation::identity::{AgentId, HostId, UserId},
    foundation::persistence::PersistenceFailure,
    host_runtime::aftermath::{CustodyEffectFailure, DaemonConnectionControl},
    identity_access::capability::computer_access::{ComputerAccess, can_access_computer},
};

/// What a committed computer cascade owes the rest of the system.
///
/// One capability with four named effects rather than four ports: the rows are
/// already gone, so every one of these is best-effort and unrollbackable, and they
/// are owed by the SAME committed cascade. Naming each of them is what keeps a
/// mounted implementation from quietly owing less than the cascade destroyed.
///
/// It is required, not optional. A composition root that cannot answer these has no
/// business mounting a door that deletes a computer: the alternative — a door that
/// commits and then decides the effects were optional — is exactly the silent
/// half-delete this sequencing exists to prevent.
pub trait ComputerCascadeEffects: Clone + Send + Sync + 'static {
    /// The terminal identity fan-out for one deleted agent row.
    fn agent_deleted(
        &self,
        agent: &AgentId,
    ) -> impl Future<Output = Result<(), CustodyEffectFailure>> + Send;

    /// Stop the live child this seat owned.
    ///
    /// The computer is passed EXPLICITLY because it is captured routing: a
    /// dispatcher that resolved the daemon from the agent's own row would resolve
    /// nothing by now, and a stop that cannot be routed is a warning where a running
    /// child should have been.
    fn stop_runtime_seat(
        &self,
        computer: &HostId,
        seat: &AgentRuntimeSessionFacts,
    ) -> impl Future<Output = Result<(), CustodyEffectFailure>> + Send;

    /// Purge what this agent kept on that computer's disk.
    fn purge_host_local_files(
        &self,
        computer: &HostId,
        agent: &AgentId,
    ) -> impl Future<Output = Result<(), CustodyEffectFailure>> + Send;

    /// Forget one stored blob whose owning row is gone.
    fn forget_stored_blob(
        &self,
        blob: &StoredBlobRef,
    ) -> impl Future<Output = Result<(), CustodyEffectFailure>> + Send;
}

/// Which post-commit effect a piece of residue is about.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum CascadeEffect {
    DeletionAnnouncement,
    RuntimeStop,
    HostLocalPurge,
    BlobSweep,
}

/// One post-commit effect that did not complete, and the agent whose destruction
/// owed it.
///
/// The agent is carried because that is the only way the failure can be acted on:
/// what is left behind is one agent's bytes or one agent's running child, and no row
/// naming either survives the commit.
#[derive(Debug)]
pub struct CascadeResidue {
    pub effect: CascadeEffect,
    pub agent: AgentId,
    pub failure: CustodyEffectFailure,
}

/// A computer that is gone, and what its destruction did not manage to finish.
#[derive(Debug)]
pub struct DeletedComputer {
    /// The sealed cascade, so the caller's summary log can account for what was
    /// destroyed without re-reading rows that no longer exist.
    pub cascade: ComputerCascade,
    /// Every post-commit effect that failed, in the order attempted. Empty is the
    /// normal case and the only one that leaves nothing behind.
    pub residue: Vec<CascadeResidue>,
    /// Set when the daemon's socket could not be dropped. Host-scoped rather than
    /// per-agent, and attempted exactly once — the computer's credentials died with
    /// its row, so a socket still attached can no longer re-authenticate.
    pub daemon_disconnect_failure: Option<CustodyEffectFailure>,
}

/// Why no computer was deleted.
///
/// The cascade's own refusals are forwarded rather than re-spelled: each one carries
/// the set it was decided on, and restating them here would be a second vocabulary
/// that can drift from the rule that produces them.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum DeleteComputerRefusal {
    /// No such computer, someone else's, or one that vanished under the request. One
    /// answer, so a requester probing ids learns nothing.
    NotTheirs,
    /// Theirs, but the platform owns this computer's lifecycle.
    NotUserManaged,
    Cascade(CascadeRefused),
}

#[derive(Debug, Error)]
pub enum DeleteComputerError {
    #[error("the computer was not deleted")]
    Refused(DeleteComputerRefusal),
    #[error(transparent)]
    Persistence(#[from] PersistenceFailure),
    #[error(transparent)]
    Teardown(#[from] TeardownFailure),
}

/// Delete a user-managed computer together with everything rooted on it.
#[derive(Clone)]
pub struct DeleteComputer<R, U, E, D> {
    read: R,
    unit_of_work: U,
    effects: E,
    daemons: D,
}

impl<R, U, E, D> DeleteComputer<R, U, E, D>
where
    R: AgentTeardownReadPort,
    U: AgentTeardownUnitOfWork,
    E: ComputerCascadeEffects,
    D: DaemonConnectionControl,
{
    pub fn new(read: R, unit_of_work: U, effects: E, daemons: D) -> Self {
        Self {
            read,
            unit_of_work,
            effects,
            daemons,
        }
    }

    pub async fn execute(
        &self,
        requester: &UserId,
        computer: HostId,
        consent: CascadeConsent,
    ) -> Result<DeletedComputer, DeleteComputerError> {
        self.preflight(requester, &computer).await?;

        let cascade = match self
            .unit_of_work
            .cascade_computer(
                ComputerTeardownKey {
                    host_id: computer.clone(),
                    user_id: requester.clone(),
                },
                consent,
            )
            .await?
        {
            ComputerCascadeCommit::Refused(refused) => {
                return Err(DeleteComputerError::Refused(
                    DeleteComputerRefusal::Cascade(refused),
                ));
            }
            // The conditional row delete matched nothing, so the whole scope rolled
            // back. Answering "not theirs" rather than a success reports what this
            // request actually caused.
            ComputerCascadeCommit::ComputerGone => {
                return Err(DeleteComputerError::Refused(
                    DeleteComputerRefusal::NotTheirs,
                ));
            }
            ComputerCascadeCommit::Committed(cascade) => cascade,
        };

        let residue = self.settle(&cascade).await;
        let daemon_disconnect_failure = self.daemons.disconnect(computer).await.err();
        Ok(DeletedComputer {
            cascade,
            residue,
            daemon_disconnect_failure,
        })
    }

    /// The two refusals that need no coordination to answer. A HINT: both are
    /// re-decided under the mechanism from its own reads.
    async fn preflight(
        &self,
        requester: &UserId,
        computer: &HostId,
    ) -> Result<(), DeleteComputerError> {
        let ownership = self.read.read_computer_ownership(computer).await?;
        let ComputerAccess::Held(access) = can_access_computer(requester, ownership.as_ref())
        else {
            return Err(DeleteComputerError::Refused(
                DeleteComputerRefusal::NotTheirs,
            ));
        };
        let Some(facts) = self.read.read_computer_lifecycle(computer).await? else {
            return Err(DeleteComputerError::Refused(
                DeleteComputerRefusal::NotTheirs,
            ));
        };
        match hold_computer_lifecycle(access, facts).map_err(TeardownFailure::from)? {
            ComputerLifecycle::Held(_) => Ok(()),
            ComputerLifecycle::NotUserManaged => Err(DeleteComputerError::Refused(
                DeleteComputerRefusal::NotUserManaged,
            )),
        }
    }

    /// Phase two, off the captures only. Every failure is collected instead of
    /// returned: the computer is already gone, so there is nothing left for a caller
    /// to retry or roll back, and hiding the residue would make it unfindable.
    async fn settle(&self, cascade: &ComputerCascade) -> Vec<CascadeResidue> {
        let mut residue = Vec::new();
        let computer = cascade.computer();

        // Both halves: the full cascades and the row-only failed rows. A client told
        // an agent is deleted must be told it for every row that went.
        for agent in cascade.deleted_agents() {
            if let Err(failure) = self.effects.agent_deleted(&agent.id).await {
                residue.push(CascadeResidue {
                    effect: CascadeEffect::DeletionAnnouncement,
                    agent: agent.id.clone(),
                    failure,
                });
            }
        }

        for torn in cascade.torn_down() {
            let agent = &torn.facts().id;
            // Every seat is re-stopped from the capture, not deduplicated against
            // anything: seats came from one snapshot of a table keyed by seat, and a
            // daemon's stop is idempotent, so the only thing a dedup could remove is
            // a duplicate that cannot occur.
            for seat in torn
                .capture()
                .runtime_sessions
                .iter()
                .filter(|seat| is_running_session(seat))
            {
                if let Err(failure) = self.effects.stop_runtime_seat(computer, seat).await {
                    residue.push(CascadeResidue {
                        effect: CascadeEffect::RuntimeStop,
                        agent: agent.clone(),
                        failure,
                    });
                }
            }
            if let Err(failure) = self.effects.purge_host_local_files(computer, agent).await {
                residue.push(CascadeResidue {
                    effect: CascadeEffect::HostLocalPurge,
                    agent: agent.clone(),
                    failure,
                });
            }
            for blob in &torn.capture().dm_blob_refs {
                if let Err(failure) = self.effects.forget_stored_blob(blob).await {
                    residue.push(CascadeResidue {
                        effect: CascadeEffect::BlobSweep,
                        agent: agent.clone(),
                        failure,
                    });
                }
            }
        }

        residue
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        application_orchestration::teardown::{
            cascade::{CascadeAdmission, admit_cascade},
            eligibility::{AgentTeardownEligibility, EligibilityVerdict, hold_eligibility},
            facts::{AgentTeardownCapture, AgentTeardownFacts, ComputerTeardownFacts},
            write::{AgentTeardownCommit, AgentTeardownKey, AgentTornDown},
        },
        foundation::identity::ConversationId,
        host_runtime::computer::{HostKind, ProvisioningSource},
        host_runtime::runtime_credential::{RuntimeGeneration, RuntimeScope},
        host_runtime::runtime_event::RuntimeObservedStatus,
        identity_access::agent_lifecycle::MaterializationStatus,
        identity_access::capability::computer_access::ComputerOwnershipFacts,
    };
    use std::sync::{Arc, Mutex};

    const OWNER: &str = "u1";
    const COMPUTER: &str = "h1";

    fn user(id: &str) -> UserId {
        UserId::parse(id).expect("user id")
    }

    fn host(id: &str) -> HostId {
        HostId::parse(id).expect("host id")
    }

    fn agent(id: &str) -> AgentId {
        AgentId::parse(id).expect("agent id")
    }

    fn agent_facts(id: &str, status: MaterializationStatus) -> AgentTeardownFacts {
        AgentTeardownFacts {
            id: agent(id),
            name: id.into(),
            display_name: id.into(),
            runtime: "claude".into(),
            host_id: host(COMPUTER),
            materialization_status: status,
            failed_code: None,
            deletion_started_at: None,
        }
    }

    fn seat(agent_id: &str, status: RuntimeObservedStatus) -> AgentRuntimeSessionFacts {
        AgentRuntimeSessionFacts {
            scope: RuntimeScope::ConversationSlot {
                agent: agent(agent_id),
                source: ConversationId::parse("c1").expect("conversation id"),
            },
            status,
            generation: RuntimeGeneration::new(1).expect("generation"),
        }
    }

    fn capture(
        id: &str,
        seats: Vec<AgentRuntimeSessionFacts>,
        blobs: usize,
    ) -> AgentTeardownCapture {
        AgentTeardownCapture {
            agent_id: agent(id),
            runtime_sessions: seats,
            dm_blob_refs: (0..blobs)
                .map(|index| StoredBlobRef {
                    storage: "local".into(),
                    storage_key: format!("{id}/{index}"),
                })
                .collect(),
            dm_channel_id: None,
            regular_workspace_count: 0,
        }
    }

    /// Minted the way production mints it, through both rules.
    fn torn_down(id: &str, seats: Vec<AgentRuntimeSessionFacts>, blobs: usize) -> AgentTornDown {
        let EligibilityVerdict::Held(held) = hold_eligibility(
            &AgentTeardownEligibility::ActiveOn {
                host_id: host(COMPUTER),
            },
            agent_facts(id, MaterializationStatus::Active),
        ) else {
            panic!("expected the rule to admit");
        };
        AgentTornDown::seal(&agent(id), held, capture(id, seats, blobs)).expect("one agent")
    }

    fn committed(dependents: Vec<AgentTeardownFacts>, torn: Vec<AgentTornDown>) -> ComputerCascade {
        let ComputerAccess::Held(access) =
            crate::identity_access::capability::computer_access::can_access_computer(
                &user(OWNER),
                Some(&ComputerOwnershipFacts {
                    id: host(COMPUTER),
                    owner: Some(user(OWNER)),
                }),
            )
        else {
            panic!("expected the owner to be admitted");
        };
        let ComputerLifecycle::Held(lifecycle) =
            hold_computer_lifecycle(access, user_managed()).expect("one computer")
        else {
            panic!("expected a user-managed computer");
        };
        let CascadeAdmission::Admitted(admitted) =
            admit_cascade(lifecycle, dependents, CascadeConsent::Confirmed).expect("one computer")
        else {
            panic!("expected the cascade to be admitted");
        };
        ComputerCascade::seal(
            &ComputerTeardownKey {
                host_id: host(COMPUTER),
                user_id: user(OWNER),
            },
            admitted,
            torn,
        )
        .expect("one cascade")
    }

    fn user_managed() -> ComputerTeardownFacts {
        ComputerTeardownFacts {
            id: host(COMPUTER),
            kind: HostKind::Remote,
            provisioning_source: ProvisioningSource::UserInvite,
        }
    }

    fn platform_owned() -> ComputerTeardownFacts {
        ComputerTeardownFacts {
            id: host(COMPUTER),
            kind: HostKind::Local,
            provisioning_source: ProvisioningSource::AppInstall,
        }
    }

    #[derive(Debug, Eq, PartialEq)]
    enum Step {
        CascadeCommitted {
            computer: String,
            requester: String,
            consent: CascadeConsent,
        },
        Announced(String),
        Stopped {
            computer: String,
            agent: String,
        },
        Purged {
            computer: String,
            agent: String,
        },
        Swept(String),
        Disconnected(String),
    }

    #[derive(Debug, Error)]
    #[error("the double was told to fail")]
    struct Refused;

    struct State {
        ownership: Option<ComputerOwnershipFacts>,
        lifecycle: Option<ComputerTeardownFacts>,
        commit: Option<ComputerCascadeCommit>,
        failing: Vec<CascadeEffect>,
        disconnect_fails: bool,
        steps: Vec<Step>,
    }

    /// One double playing the read face, the write mechanism, every post-commit
    /// effect and the daemon socket, so a test can assert the ORDER across all four.
    #[derive(Clone)]
    struct World(Arc<Mutex<State>>);

    impl World {
        fn new(commit: Option<ComputerCascadeCommit>) -> Self {
            Self(Arc::new(Mutex::new(State {
                ownership: Some(ComputerOwnershipFacts {
                    id: host(COMPUTER),
                    owner: Some(user(OWNER)),
                }),
                lifecycle: Some(user_managed()),
                commit,
                failing: Vec::new(),
                disconnect_fails: false,
                steps: Vec::new(),
            })))
        }

        fn record(&self, step: Step) {
            self.0.lock().expect("state").steps.push(step);
        }

        fn steps(&self) -> Vec<Step> {
            std::mem::take(&mut self.0.lock().expect("state").steps)
        }

        fn answer(&self, effect: CascadeEffect) -> Result<(), CustodyEffectFailure> {
            if self.0.lock().expect("state").failing.contains(&effect) {
                return Err(CustodyEffectFailure::from_source(Refused));
            }
            Ok(())
        }

        fn failing(self, effects: &[CascadeEffect]) -> Self {
            self.0.lock().expect("state").failing = effects.to_vec();
            self
        }
    }

    impl AgentTeardownReadPort for World {
        async fn read_agent_facts(
            &self,
            _agent_id: &AgentId,
        ) -> Result<Option<AgentTeardownFacts>, PersistenceFailure> {
            unreachable!("the computer door never reads one agent's facts")
        }

        async fn is_deletion_pending(
            &self,
            _agent_id: &AgentId,
        ) -> Result<bool, PersistenceFailure> {
            unreachable!("the computer door never asks about one agent's intent")
        }

        async fn list_runtime_sessions(
            &self,
            _agent_id: &AgentId,
        ) -> Result<Vec<AgentRuntimeSessionFacts>, PersistenceFailure> {
            unreachable!("the computer door stops from the capture, never from a hint")
        }

        async fn read_computer_ownership(
            &self,
            _host_id: &HostId,
        ) -> Result<Option<ComputerOwnershipFacts>, PersistenceFailure> {
            Ok(self.0.lock().expect("state").ownership.clone())
        }

        async fn read_computer_lifecycle(
            &self,
            _host_id: &HostId,
        ) -> Result<Option<ComputerTeardownFacts>, PersistenceFailure> {
            Ok(self.0.lock().expect("state").lifecycle.clone())
        }
    }

    impl AgentTeardownUnitOfWork for World {
        async fn tear_down_agent(
            &self,
            _key: AgentTeardownKey,
            _expected: AgentTeardownEligibility,
        ) -> Result<AgentTeardownCommit, TeardownFailure> {
            unreachable!("the computer door never tears down one agent")
        }

        async fn cascade_computer(
            &self,
            key: ComputerTeardownKey,
            consent: CascadeConsent,
        ) -> Result<ComputerCascadeCommit, TeardownFailure> {
            self.record(Step::CascadeCommitted {
                computer: key.host_id.as_str().to_owned(),
                requester: key.user_id.as_str().to_owned(),
                consent,
            });
            Ok(self
                .0
                .lock()
                .expect("state")
                .commit
                .take()
                .expect("one cascade per test"))
        }
    }

    impl ComputerCascadeEffects for World {
        async fn agent_deleted(&self, agent: &AgentId) -> Result<(), CustodyEffectFailure> {
            self.record(Step::Announced(agent.as_str().to_owned()));
            self.answer(CascadeEffect::DeletionAnnouncement)
        }

        async fn stop_runtime_seat(
            &self,
            computer: &HostId,
            seat: &AgentRuntimeSessionFacts,
        ) -> Result<(), CustodyEffectFailure> {
            self.record(Step::Stopped {
                computer: computer.as_str().to_owned(),
                agent: seat.scope.agent().as_str().to_owned(),
            });
            self.answer(CascadeEffect::RuntimeStop)
        }

        async fn purge_host_local_files(
            &self,
            computer: &HostId,
            agent: &AgentId,
        ) -> Result<(), CustodyEffectFailure> {
            self.record(Step::Purged {
                computer: computer.as_str().to_owned(),
                agent: agent.as_str().to_owned(),
            });
            self.answer(CascadeEffect::HostLocalPurge)
        }

        async fn forget_stored_blob(
            &self,
            blob: &StoredBlobRef,
        ) -> Result<(), CustodyEffectFailure> {
            self.record(Step::Swept(blob.storage_key.clone()));
            self.answer(CascadeEffect::BlobSweep)
        }
    }

    impl DaemonConnectionControl for World {
        async fn disconnect(&self, computer: HostId) -> Result<(), CustodyEffectFailure> {
            self.record(Step::Disconnected(computer.as_str().to_owned()));
            if self.0.lock().expect("state").disconnect_fails {
                return Err(CustodyEffectFailure::from_source(Refused));
            }
            Ok(())
        }
    }

    fn door(world: &World) -> DeleteComputer<World, World, World, World> {
        DeleteComputer::new(world.clone(), world.clone(), world.clone(), world.clone())
    }

    async fn refusal(world: &World) -> DeleteComputerRefusal {
        let error = door(world)
            .execute(&user(OWNER), host(COMPUTER), CascadeConsent::Confirmed)
            .await
            .expect_err("a refusal");
        let DeleteComputerError::Refused(refusal) = error else {
            panic!("expected a product refusal");
        };
        refusal
    }

    #[tokio::test]
    async fn a_computer_that_is_not_theirs_answers_like_one_that_never_existed() {
        for ownership in [
            None,
            Some(ComputerOwnershipFacts {
                id: host(COMPUTER),
                owner: Some(user("someone-else")),
            }),
            Some(ComputerOwnershipFacts {
                id: host(COMPUTER),
                owner: None,
            }),
        ] {
            let world = World::new(None);
            world.0.lock().expect("state").ownership = ownership;
            assert_eq!(refusal(&world).await, DeleteComputerRefusal::NotTheirs);
            assert!(
                world.steps().is_empty(),
                "a refused request must not reach the mechanism"
            );
        }
    }

    #[tokio::test]
    async fn a_computer_that_vanished_between_the_two_reads_is_not_theirs_either() {
        let world = World::new(None);
        world.0.lock().expect("state").lifecycle = None;
        assert_eq!(refusal(&world).await, DeleteComputerRefusal::NotTheirs);
        assert!(world.steps().is_empty());
    }

    #[tokio::test]
    async fn a_platform_owned_computer_is_refused_before_the_lock() {
        let world = World::new(None);
        world.0.lock().expect("state").lifecycle = Some(platform_owned());
        assert_eq!(refusal(&world).await, DeleteComputerRefusal::NotUserManaged);
        assert!(world.steps().is_empty());
    }

    #[tokio::test]
    async fn the_write_is_told_the_coordinate_and_the_consent_and_nothing_else() {
        let world = World::new(Some(ComputerCascadeCommit::Committed(committed(
            Vec::new(),
            Vec::new(),
        ))));
        door(&world)
            .execute(&user(OWNER), host(COMPUTER), CascadeConsent::Absent)
            .await
            .expect("a deleted computer");
        assert_eq!(
            world.steps(),
            vec![
                Step::CascadeCommitted {
                    computer: COMPUTER.into(),
                    requester: OWNER.into(),
                    consent: CascadeConsent::Absent,
                },
                Step::Disconnected(COMPUTER.into()),
            ],
        );
    }

    #[tokio::test]
    async fn the_in_lock_refusal_is_the_answer_even_when_the_hints_admitted() {
        let world = World::new(Some(ComputerCascadeCommit::Refused(
            CascadeRefused::ConsentRequired {
                dependents: vec![agent_facts("a1", MaterializationStatus::Active)],
            },
        )));
        assert_eq!(
            refusal(&world).await,
            DeleteComputerRefusal::Cascade(CascadeRefused::ConsentRequired {
                dependents: vec![agent_facts("a1", MaterializationStatus::Active)],
            }),
        );
    }

    #[tokio::test]
    async fn a_computer_gone_under_the_lock_reports_nothing_deleted() {
        let world = World::new(Some(ComputerCascadeCommit::ComputerGone));
        assert_eq!(refusal(&world).await, DeleteComputerRefusal::NotTheirs);
        assert!(
            !world
                .steps()
                .iter()
                .any(|step| !matches!(step, Step::CascadeCommitted { .. })),
            "a rolled-back scope owes no post-commit effect"
        );
    }

    #[tokio::test]
    async fn every_deleted_row_is_announced_and_only_a_full_teardown_owes_more() {
        let failed = agent_facts("a-failed", MaterializationStatus::Failed);
        let active = agent_facts("a-active", MaterializationStatus::Active);
        let world = World::new(Some(ComputerCascadeCommit::Committed(committed(
            vec![failed, active],
            vec![torn_down(
                "a-active",
                vec![seat("a-active", RuntimeObservedStatus::Active)],
                2,
            )],
        ))));
        let deleted = door(&world)
            .execute(&user(OWNER), host(COMPUTER), CascadeConsent::Confirmed)
            .await
            .expect("a deleted computer");
        assert!(deleted.residue.is_empty());
        assert_eq!(
            world.steps(),
            vec![
                Step::CascadeCommitted {
                    computer: COMPUTER.into(),
                    requester: OWNER.into(),
                    consent: CascadeConsent::Confirmed,
                },
                Step::Announced("a-failed".into()),
                Step::Announced("a-active".into()),
                Step::Stopped {
                    computer: COMPUTER.into(),
                    agent: "a-active".into(),
                },
                Step::Purged {
                    computer: COMPUTER.into(),
                    agent: "a-active".into(),
                },
                Step::Swept("a-active/0".into()),
                Step::Swept("a-active/1".into()),
                Step::Disconnected(COMPUTER.into()),
            ],
        );
    }

    #[tokio::test]
    async fn a_seat_that_owns_no_live_child_is_not_stopped() {
        let world = World::new(Some(ComputerCascadeCommit::Committed(committed(
            vec![agent_facts("a1", MaterializationStatus::Active)],
            vec![torn_down(
                "a1",
                vec![
                    seat("a1", RuntimeObservedStatus::Idle),
                    seat("a1", RuntimeObservedStatus::Crashed),
                    seat("a1", RuntimeObservedStatus::Starting),
                ],
                0,
            )],
        ))));
        door(&world)
            .execute(&user(OWNER), host(COMPUTER), CascadeConsent::Confirmed)
            .await
            .expect("a deleted computer");
        assert_eq!(
            world
                .steps()
                .iter()
                .filter(|step| matches!(step, Step::Stopped { .. }))
                .count(),
            1,
            "only the starting seat still owns a child",
        );
    }

    #[tokio::test]
    async fn a_failed_effect_is_reported_and_the_delete_stands() {
        for effect in [
            CascadeEffect::DeletionAnnouncement,
            CascadeEffect::RuntimeStop,
            CascadeEffect::HostLocalPurge,
            CascadeEffect::BlobSweep,
        ] {
            let world = World::new(Some(ComputerCascadeCommit::Committed(committed(
                vec![agent_facts("a1", MaterializationStatus::Active)],
                vec![torn_down(
                    "a1",
                    vec![seat("a1", RuntimeObservedStatus::Active)],
                    1,
                )],
            ))))
            .failing(&[effect]);
            let deleted = door(&world)
                .execute(&user(OWNER), host(COMPUTER), CascadeConsent::Confirmed)
                .await
                .expect("the delete stands");
            let reported: Vec<CascadeEffect> = deleted
                .residue
                .iter()
                .map(|residue| residue.effect)
                .collect();
            assert_eq!(reported, vec![effect]);
            assert_eq!(deleted.residue[0].agent, agent("a1"));
            assert!(
                world.steps().contains(&Step::Disconnected(COMPUTER.into())),
                "residue must not stop the rest of the phase",
            );
        }
    }

    #[tokio::test]
    async fn a_socket_that_will_not_close_is_reported_and_the_delete_stands() {
        let world = World::new(Some(ComputerCascadeCommit::Committed(committed(
            Vec::new(),
            Vec::new(),
        ))));
        world.0.lock().expect("state").disconnect_fails = true;
        let deleted = door(&world)
            .execute(&user(OWNER), host(COMPUTER), CascadeConsent::Confirmed)
            .await
            .expect("the delete stands");
        assert!(deleted.daemon_disconnect_failure.is_some());
        assert!(deleted.residue.is_empty());
    }
}
