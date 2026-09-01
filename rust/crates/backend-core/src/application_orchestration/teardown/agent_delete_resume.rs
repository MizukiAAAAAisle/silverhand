//! Resuming ONE durable agent-deletion attempt: the ordered fence-then-commit
//! sequence and the retry taxonomy, with no scheduler.
//!
//! A durable deletion marker is fail-forward: once `intent::begin_agent_deletion`
//! records it, the agent WILL be torn down, and every later failure is a retry rather
//! than a lost cascade. This module owns the one ordered attempt that discharges a
//! marker; the process-local scheduler that decides WHEN to run one, coalesces
//! duplicate triggers per agent and walks the bounded retry ladder lives outside
//! `core`, because generations and timers are infrastructure, not domain facts.
//!
//! ## The order is the contract, and it is fence-then-commit
//!
//! The single-agent path purges BEFORE the control-plane rows are deleted and fails
//! closed — the same order [`crate::application_orchestration::teardown::write`] fixes for this axis, and the
//! opposite of the computer cascade, which purges after its commit best-effort because
//! the rows that could name those bytes are themselves going away. So:
//!
//!  1. [`AgentDeletionFence`] fences the agent on the EXACT daemon custody captured
//!     when the attempt began, quiesces every child — existing AND any that arrive
//!     mid-purge — and removes the home tree. This is the SINGLE child authority:
//!     there is no per-seat stop on this path, which is why [`AgentDeletionResidue`]
//!     has no such method to call.
//!  2. Only if the purge SUCCEEDS does `intent::complete_agent_deletion` take the
//!     compare-and-set that captures and deletes the rows. The purge acknowledgement
//!     is carried into that call as a sealed `intent::PurgeReceipt`, so the commit
//!     is structurally unreachable without a real fence ack — not a re-check of which
//!     generation is live, which between purge and commit could never be atomic.
//!  3. The announcement and the blob sweep are post-commit residue: best-effort,
//!     collected and logged, NEVER rolled back and never a false failure.
//!
//! ## The taxonomy is decided here so the scheduler cannot re-derive it
//!
//! [`resume_agent_deletion`] returns a [`ResumeOutcome`] the scheduler maps to
//! {stop, retry} without re-classifying anything. A purge failure and a transient
//! completing-CAS persistence fault are the ONLY retryable outcomes; a superseded
//! attempt terminates its own token; a contract fault is an integrity defect that a
//! hot retry cannot fix; a committed or already-gone row is terminal success.

use std::{error::Error, fmt, future::Future};

use crate::{
    application_orchestration::teardown::{
        contract::TeardownFailure,
        facts::StoredBlobRef,
        intent::{
            AgentDeletionAttempt, AgentDeletionLifecyclePort, CompleteDeletion, PurgeReceipt,
            complete_agent_deletion,
        },
        write::AgentTornDown,
    },
    foundation::identity::AgentId,
    foundation::persistence::PersistenceFailure,
    host_runtime::aftermath::CustodyEffectFailure,
};

/// The owning-host precommit fence + quiescence + home purge, narrowed to the
/// single-agent path and bound to ONE captured daemon connection generation.
///
/// A concrete fence is minted against the exact daemon custody that owned the agent's
/// host when the attempt began; it carries that generation as a transport capability,
/// not as an observed value it re-reads. That is why this method takes no host: there
/// is no host coordinate for it to re-resolve, so a same-instance replacement cannot
/// receive this agent's purge — the fence sends only on the generation it captured and
/// fails closed otherwise.
///
/// Its success is the gate that lets the durable delete commit. ANY failure keeps the
/// marker and is retried, so the failure carries no branch-worthy taxonomy: the resumer
/// never asks WHICH purge fault occurred, only whether the gate opened. That is
/// deliberate — a `quiesce_failed`, a `partial_purge`, a transport hiccup, a detached
/// host and a superseded generation all mean the same thing to a fail-forward marker:
/// not yet, try again on whatever generation next owns the host.
pub trait AgentDeletionFence: Clone + Send + Sync + 'static {
    fn quiesce_and_purge(
        &self,
        agent: &AgentId,
    ) -> impl Future<Output = Result<(), QuiescePurgeFailure>> + Send;
}

/// An opaque precommit-purge failure. Distinct from [`CustodyEffectFailure`] on
/// purpose: a custody failure means "it happened but someone was not told" and is
/// residue; a purge failure means "the gate did not open, nothing was deleted" and is
/// a retry. The source is preserved for logging, never for a control decision.
pub struct QuiescePurgeFailure {
    source: Box<dyn Error + Send + Sync>,
}

impl QuiescePurgeFailure {
    pub fn from_source<E>(source: E) -> Self
    where
        E: Error + Send + Sync + 'static,
    {
        Self {
            source: Box::new(source),
        }
    }
}

impl fmt::Debug for QuiescePurgeFailure {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        fmt::Debug::fmt(&self.source, formatter)
    }
}

impl fmt::Display for QuiescePurgeFailure {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            formatter,
            "agent quiesce-and-purge did not complete: {}",
            self.source
        )
    }
}

impl Error for QuiescePurgeFailure {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        Some(self.source.as_ref())
    }
}

/// The post-commit best-effort residue for a single-agent deletion: the terminal
/// announcement and the DM blob sweep, and nothing else.
///
/// There is deliberately no `stop_runtime_seat` and no purge here. Stopping children
/// is the pre-commit purge's fence-quiesce job (the single child authority), and the
/// home tree is already gone by the time this runs. Every method's failure is a
/// [`CustodyEffectFailure`] — "the row is gone but someone was not told" — which the
/// caller collects as [`ResidueFault`] and logs; it never rolls the durable delete
/// back and never becomes a failing response.
pub trait AgentDeletionResidue: Clone + Send + Sync + 'static {
    fn agent_deleted(
        &self,
        agent: &AgentId,
    ) -> impl Future<Output = Result<(), CustodyEffectFailure>> + Send;

    fn forget_stored_blob(
        &self,
        blob: &StoredBlobRef,
    ) -> impl Future<Output = Result<(), CustodyEffectFailure>> + Send;
}

/// Which post-commit residue effect a [`ResidueFault`] is about.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ResidueEffect {
    DeletionAnnouncement,
    BlobSweep,
}

/// A post-commit residue effect that failed after the row was already deleted. It is
/// carried, not returned as an error: the durable delete has committed, so there is
/// nothing to roll back and no honest way to report failure to a caller that already
/// saw the row disappear.
#[derive(Debug)]
pub struct ResidueFault {
    pub effect: ResidueEffect,
    pub agent: AgentId,
    pub failure: CustodyEffectFailure,
}

/// Why a resume attempt asked to be retried. Carried for logging; the scheduler
/// treats both arms identically — preserve the marker, walk the ladder.
#[derive(Debug)]
pub enum RetryReason {
    /// The precommit fence/quiesce/purge did not succeed. Nothing was deleted.
    Purge(QuiescePurgeFailure),
    /// The completing compare-and-set hit a transient persistence fault. The marker
    /// is intact and the whole idempotent purge -> commit chain is safe to replay.
    Persistence(PersistenceFailure),
}

/// The classified result of ONE resume attempt.
#[derive(Debug)]
pub enum ResumeOutcome {
    /// The row is gone: either a concurrent completion won ([`CompleteDeletion::Gone`])
    /// or this attempt committed it. Any post-commit residue faults are carried for
    /// logging. Clear the marker from the in-memory pending set; do not retry.
    Deleted { residue: Vec<ResidueFault> },
    /// The marker no longer matches this attempt — another attempt owns the deletion.
    /// Terminate THIS token; the current marker is re-derived from `list_pending` or a
    /// fresh `begin`, never by hot-retrying the stale token.
    Superseded,
    /// A genuinely transient fault. The durable marker is intact; retry the whole
    /// idempotent purge -> commit chain, bound to the host's connection generation.
    Retry(RetryReason),
    /// An internal contract fault — a spliced coordinate a retry cannot fix and a
    /// user cannot act on. The scheduler drops the token and logs; the durable marker
    /// stays on disk for a later boot to re-list.
    Faulted(TeardownFailure),
}

/// Run one ordered fence-then-commit attempt against the durable marker `attempt`.
///
/// Every branch is total and classified: see [`ResumeOutcome`]. The function performs
/// no scheduling, holds no timer and knows no connection generation — it is the
/// domain sequence a scheduler drives, and it is safe to call again on the same
/// attempt because the purge is idempotent and the completing CAS is keyed on this
/// exact attempt.
pub async fn resume_agent_deletion<L, F, R>(
    lifecycle: &L,
    fence: &F,
    residue: &R,
    attempt: &AgentDeletionAttempt,
) -> ResumeOutcome
where
    L: AgentDeletionLifecyclePort,
    F: AgentDeletionFence,
    R: AgentDeletionResidue,
{
    // 1. Fence, quiesce and purge on the captured generation. Fails closed: a failure
    //    here — a transient fault OR a generation that a replacement has taken — means
    //    nothing downstream runs and the marker is retried untouched.
    if let Err(failure) = fence.quiesce_and_purge(attempt.agent_id()).await {
        return ResumeOutcome::Retry(RetryReason::Purge(failure));
    }

    // 2. The fence acked on the captured custody. That acknowledgement — carried as a
    //    sealed [`PurgeReceipt`], the sole key `complete_agent_deletion` accepts — is
    //    what admits the durable capture+delete. There is deliberately no liveness
    //    re-check between here and the commit: the completing CAS is itself atomic and
    //    keyed on this attempt's marker, and a check-then-commit could never be.
    let committed = match complete_agent_deletion(lifecycle, attempt, PurgeReceipt::sealed()).await
    {
        Ok(outcome) => outcome,
        Err(TeardownFailure::Persistence(persistence)) => {
            return ResumeOutcome::Retry(RetryReason::Persistence(persistence));
        }
        Err(failure @ TeardownFailure::Contract(_)) => {
            return ResumeOutcome::Faulted(failure);
        }
    };

    match committed {
        CompleteDeletion::AttemptLost => ResumeOutcome::Superseded,
        CompleteDeletion::Gone => ResumeOutcome::Deleted {
            residue: Vec::new(),
        },
        // 3. Post-commit residue: best-effort, collected, never rolled back.
        CompleteDeletion::Committed(torn) => ResumeOutcome::Deleted {
            residue: run_residue(residue, &torn).await,
        },
    }
}

/// Fire the two post-commit residue effects and collect whatever failed. The order
/// is announce-then-sweep, matching the reference; neither failure short-circuits the
/// other, because the row is gone and both are owed independently.
async fn run_residue<R>(residue: &R, torn: &AgentTornDown) -> Vec<ResidueFault>
where
    R: AgentDeletionResidue,
{
    let agent = &torn.facts().id;
    let mut faults = Vec::new();
    if let Err(failure) = residue.agent_deleted(agent).await {
        faults.push(ResidueFault {
            effect: ResidueEffect::DeletionAnnouncement,
            agent: agent.clone(),
            failure,
        });
    }
    for blob in &torn.capture().dm_blob_refs {
        if let Err(failure) = residue.forget_stored_blob(blob).await {
            faults.push(ResidueFault {
                effect: ResidueEffect::BlobSweep,
                agent: agent.clone(),
                failure,
            });
        }
    }
    faults
}

#[cfg(test)]
mod tests {
    use std::sync::{
        Arc, Mutex,
        atomic::{AtomicUsize, Ordering::SeqCst},
    };

    use super::*;
    use crate::{
        application_orchestration::teardown::{
            contract::TeardownContractViolation,
            eligibility::{AgentTeardownEligibility, EligibilityVerdict, hold_eligibility},
            facts::{AgentTeardownCapture, AgentTeardownFacts},
            intent::{
                BeginDeletion, BeginDeletionRecord, PersistedDeletionIntent, begin_agent_deletion,
            },
        },
        foundation::identity::HostId,
        foundation::persistence::PersistenceFailure,
        identity_access::agent_lifecycle::MaterializationStatus,
    };

    fn agent(id: &str) -> AgentId {
        AgentId::parse(id).expect("agent id")
    }

    fn host(id: &str) -> HostId {
        HostId::parse(id).expect("host id")
    }

    fn intent(agent_id: &str, host_id: &str, at: i64) -> PersistedDeletionIntent {
        PersistedDeletionIntent {
            agent_id: agent(agent_id),
            host_id: host(host_id),
            deletion_started_at: at,
        }
    }

    /// A committed teardown, sealed the only way one can be, carrying `blobs` DM blob
    /// refs so a sweep has something to fail on.
    fn torn_down(agent_id: &str, host_id: &str, blobs: usize) -> CompleteDeletion {
        let id = agent(agent_id);
        let host_id = host(host_id);
        let EligibilityVerdict::Held(held) = hold_eligibility(
            &AgentTeardownEligibility::ActiveOn {
                host_id: host_id.clone(),
            },
            AgentTeardownFacts {
                id: id.clone(),
                name: agent_id.into(),
                display_name: agent_id.into(),
                runtime: "claude".into(),
                host_id,
                materialization_status: MaterializationStatus::Active,
                failed_code: None,
                deletion_started_at: None,
            },
        ) else {
            panic!("expected the rule to admit");
        };
        let capture = AgentTeardownCapture {
            agent_id: id.clone(),
            runtime_sessions: Vec::new(),
            dm_blob_refs: (0..blobs)
                .map(|n| StoredBlobRef {
                    storage: "local".into(),
                    storage_key: format!("dm/{agent_id}/{n}"),
                })
                .collect(),
            dm_channel_id: None,
            regular_workspace_count: 0,
        };
        CompleteDeletion::Committed(Box::new(
            AgentTornDown::seal(&id, held, capture).expect("one agent"),
        ))
    }

    /// One shared step ledger, so a test can assert the ABSOLUTE order across the two
    /// dependencies — the only way to prove purge precedes complete.
    #[derive(Clone, Default)]
    struct Steps(Arc<Mutex<Vec<&'static str>>>);

    impl Steps {
        fn record(&self, step: &'static str) {
            self.0.lock().expect("steps").push(step);
        }

        fn taken(&self) -> Vec<&'static str> {
            self.0.lock().expect("steps").clone()
        }
    }

    #[derive(Clone)]
    struct FakeFence {
        steps: Steps,
        fail: bool,
    }

    impl AgentDeletionFence for FakeFence {
        async fn quiesce_and_purge(&self, _agent: &AgentId) -> Result<(), QuiescePurgeFailure> {
            self.steps.record("purge");
            if self.fail {
                return Err(QuiescePurgeFailure::from_source(std::io::Error::other(
                    "daemon detached",
                )));
            }
            Ok(())
        }
    }

    #[derive(Clone)]
    struct FakeLifecycle {
        steps: Steps,
        begin: BeginDeletionRecord,
        complete: Arc<Mutex<Result<CompleteDeletion, TeardownFailure>>>,
        completes: Arc<AtomicUsize>,
    }

    impl AgentDeletionLifecyclePort for FakeLifecycle {
        async fn begin(
            &self,
            _agent_id: &AgentId,
            _started_at: i64,
        ) -> Result<BeginDeletionRecord, PersistenceFailure> {
            Ok(self.begin.clone())
        }

        async fn list_pending(&self) -> Result<Vec<PersistedDeletionIntent>, PersistenceFailure> {
            Ok(Vec::new())
        }

        async fn complete(
            &self,
            _attempt: &AgentDeletionAttempt,
        ) -> Result<CompleteDeletion, TeardownFailure> {
            self.steps.record("complete");
            self.completes.fetch_add(1, SeqCst);
            match &*self.complete.lock().expect("complete") {
                Ok(outcome) => Ok(outcome.clone()),
                Err(TeardownFailure::Persistence(_)) => Err(TeardownFailure::Persistence(
                    PersistenceFailure::from_source(std::io::Error::other("db busy")),
                )),
                Err(TeardownFailure::Contract(violation)) => {
                    Err(TeardownFailure::Contract(violation.clone()))
                }
            }
        }
    }

    #[derive(Clone, Default)]
    struct FakeResidue {
        announced: Arc<AtomicUsize>,
        swept: Arc<AtomicUsize>,
        fail_announce: bool,
        fail_sweep: bool,
    }

    impl AgentDeletionResidue for FakeResidue {
        async fn agent_deleted(&self, _agent: &AgentId) -> Result<(), CustodyEffectFailure> {
            self.announced.fetch_add(1, SeqCst);
            if self.fail_announce {
                return Err(CustodyEffectFailure::from_source(std::io::Error::other(
                    "hub down",
                )));
            }
            Ok(())
        }

        async fn forget_stored_blob(
            &self,
            _blob: &StoredBlobRef,
        ) -> Result<(), CustodyEffectFailure> {
            self.swept.fetch_add(1, SeqCst);
            if self.fail_sweep {
                return Err(CustodyEffectFailure::from_source(std::io::Error::other(
                    "blob store down",
                )));
            }
            Ok(())
        }
    }

    fn lifecycle(complete: Result<CompleteDeletion, TeardownFailure>) -> FakeLifecycle {
        FakeLifecycle {
            steps: Steps::default(),
            begin: BeginDeletionRecord::Started(intent("a1", "h1", 5)),
            complete: Arc::new(Mutex::new(complete)),
            completes: Arc::new(AtomicUsize::new(0)),
        }
    }

    /// Mint the attempt the only way it can be: from a marker the port produced.
    async fn attempt(port: &FakeLifecycle) -> AgentDeletionAttempt {
        let BeginDeletion::Started(attempt) = begin_agent_deletion(port, &agent("a1"), 5)
            .await
            .expect("begin")
        else {
            panic!("expected a started attempt");
        };
        attempt
    }

    #[tokio::test]
    async fn purge_runs_before_the_durable_commit() {
        let steps = Steps::default();
        let mut port = lifecycle(Ok(CompleteDeletion::Gone));
        port.steps = steps.clone();
        let attempt = attempt(&port).await;
        let purge = FakeFence {
            steps: steps.clone(),
            fail: false,
        };
        let outcome = resume_agent_deletion(&port, &purge, &FakeResidue::default(), &attempt).await;
        assert!(matches!(outcome, ResumeOutcome::Deleted { .. }));
        assert_eq!(steps.taken(), vec!["purge", "complete"]);
    }

    #[tokio::test]
    async fn a_failed_purge_never_reaches_the_commit() {
        // Deleting the purge-before-commit order would let the rows go while the
        // daemon was never fenced; this is the discriminator that catches it.
        let steps = Steps::default();
        let mut port = lifecycle(Ok(CompleteDeletion::Gone));
        port.steps = steps.clone();
        let attempt = attempt(&port).await;
        let purge = FakeFence {
            steps: steps.clone(),
            fail: true,
        };
        let outcome = resume_agent_deletion(&port, &purge, &FakeResidue::default(), &attempt).await;
        assert!(matches!(
            outcome,
            ResumeOutcome::Retry(RetryReason::Purge(_))
        ));
        assert_eq!(steps.taken(), vec!["purge"]);
        assert_eq!(port.completes.load(SeqCst), 0);
    }

    #[tokio::test]
    async fn a_committed_teardown_runs_announce_then_sweep_per_blob() {
        let port = lifecycle(Ok(torn_down("a1", "h1", 2)));
        let attempt = attempt(&port).await;
        let residue = FakeResidue::default();
        let outcome = resume_agent_deletion(
            &port,
            &FakeFence {
                steps: Steps::default(),
                fail: false,
            },
            &residue,
            &attempt,
        )
        .await;
        let ResumeOutcome::Deleted { residue: faults } = outcome else {
            panic!("committed row is deleted");
        };
        assert!(faults.is_empty());
        assert_eq!(residue.announced.load(SeqCst), 1);
        assert_eq!(residue.swept.load(SeqCst), 2);
    }

    #[tokio::test]
    async fn residue_failures_are_carried_not_rolled_back() {
        let port = lifecycle(Ok(torn_down("a1", "h1", 1)));
        let attempt = attempt(&port).await;
        let residue = FakeResidue {
            fail_announce: true,
            fail_sweep: true,
            ..FakeResidue::default()
        };
        let outcome = resume_agent_deletion(
            &port,
            &FakeFence {
                steps: Steps::default(),
                fail: false,
            },
            &residue,
            &attempt,
        )
        .await;
        let ResumeOutcome::Deleted { residue: faults } = outcome else {
            panic!("the row committed; residue failure does not un-commit it");
        };
        // Both effects were attempted and both faults kept — none short-circuits the
        // other, and the outcome is still Deleted.
        assert_eq!(
            faults.iter().map(|f| f.effect).collect::<Vec<_>>(),
            vec![
                ResidueEffect::DeletionAnnouncement,
                ResidueEffect::BlobSweep
            ]
        );
        assert_eq!(residue.announced.load(SeqCst), 1);
        assert_eq!(residue.swept.load(SeqCst), 1);
    }

    #[tokio::test]
    async fn a_concurrent_completion_is_terminal_not_residue() {
        let port = lifecycle(Ok(CompleteDeletion::Gone));
        let attempt = attempt(&port).await;
        let residue = FakeResidue::default();
        let outcome = resume_agent_deletion(
            &port,
            &FakeFence {
                steps: Steps::default(),
                fail: false,
            },
            &residue,
            &attempt,
        )
        .await;
        let ResumeOutcome::Deleted { residue: faults } = outcome else {
            panic!("gone is deleted");
        };
        assert!(faults.is_empty());
        // Gone carries no witness, so no residue runs.
        assert_eq!(residue.announced.load(SeqCst), 0);
        assert_eq!(residue.swept.load(SeqCst), 0);
    }

    #[tokio::test]
    async fn a_lost_attempt_is_superseded_not_retried() {
        let port = lifecycle(Ok(CompleteDeletion::AttemptLost));
        let attempt = attempt(&port).await;
        let outcome = resume_agent_deletion(
            &port,
            &FakeFence {
                steps: Steps::default(),
                fail: false,
            },
            &FakeResidue::default(),
            &attempt,
        )
        .await;
        assert!(matches!(outcome, ResumeOutcome::Superseded));
    }

    #[tokio::test]
    async fn a_transient_persistence_fault_on_commit_is_retryable() {
        let port = lifecycle(Err(TeardownFailure::Persistence(
            PersistenceFailure::from_source(std::io::Error::other("db busy")),
        )));
        let attempt = attempt(&port).await;
        let outcome = resume_agent_deletion(
            &port,
            &FakeFence {
                steps: Steps::default(),
                fail: false,
            },
            &FakeResidue::default(),
            &attempt,
        )
        .await;
        assert!(matches!(
            outcome,
            ResumeOutcome::Retry(RetryReason::Persistence(_))
        ));
    }

    #[tokio::test]
    async fn a_contract_fault_is_not_retryable() {
        let violation = TeardownContractViolation::AgentMismatch {
            expected: agent("a1"),
            found: agent("a2"),
        };
        let port = lifecycle(Err(TeardownFailure::Contract(violation)));
        let attempt = attempt(&port).await;
        let outcome = resume_agent_deletion(
            &port,
            &FakeFence {
                steps: Steps::default(),
                fail: false,
            },
            &FakeResidue::default(),
            &attempt,
        )
        .await;
        assert!(matches!(outcome, ResumeOutcome::Faulted(_)));
    }
}
