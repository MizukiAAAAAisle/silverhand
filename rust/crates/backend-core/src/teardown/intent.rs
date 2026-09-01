//! The durable deletion intent — the fail-forward marker that makes an active
//! agent's teardown survive a crash.
//!
//! Persisting the intent BEFORE any daemon work is what closes new dispatch and
//! turns every later failure into a retry rather than a lost cascade. Nothing
//! remote may run inside the short write that takes it.
//!
//! ## The attempt token is minted here and nowhere else
//!
//! [`AgentDeletionAttempt`] has private fields and no public constructor, and the
//! persistence port never returns one — it returns the durable row's parts
//! ([`PersistedDeletionIntent`]) and this module mints the token from them. So a
//! caller cannot assemble an attempt out of an agent id it happens to hold and
//! ask for a deletion to be completed: the only attempts in existence came from a
//! marker that is actually on disk.
//!
//! Being on disk is not enough for the request-shaped half of that. A caller names
//! ONE agent and gets back a marker's parts, and a marker for some other agent would
//! mint a token that routes a purge and a fan-out at a row nobody asked about — so
//! the mint that serves a request binds the parts to the requested id, and the
//! completing call binds the committed teardown back to the attempt. Both mismatches
//! are internal contract failures ([`crate::teardown::contract`]), never product
//! answers: the refusal arms here are facts a user can act on, and a spliced
//! coordinate is not one of them.
//!
//! Boot discovery is the one mint with no request to bind to: each pending marker IS
//! its own coordinate, and there is no second channel to disagree with it.

use std::future::Future;

use crate::{
    foundation::persistence::PersistenceFailure,
    identity::{AgentId, HostId},
    teardown::{
        contract::{TeardownContractViolation, TeardownFailure, same_agent, same_computer},
        write::AgentTornDown,
    },
};

/// A deletion attempt that is durably recorded. Carries exactly what completing
/// it needs: which agent, which computer its host-local work routes to, and the
/// marker's own timestamp, which is the token the completing CAS matches on.
///
/// ```compile_fail
/// use silverhand_backend_core::teardown::intent::AgentDeletionAttempt;
/// // Assembled from parts, this would authorize completing a deletion no marker
/// // on disk ever started.
/// let _: AgentDeletionAttempt = AgentDeletionAttempt {
///     agent_id: unimplemented!(),
///     host_id: unimplemented!(),
///     deletion_started_at: unimplemented!(),
/// };
/// ```
///
/// The control for that gate. It does not mint one — every mint is behind an async
/// port call, and the runtime proof that the sanctioned path yields a token lives in
/// this module's tests. What it does rule out is the gate above passing for a reason
/// other than the one claimed: the path, the name and the accessors are real here, so
/// the only thing left for that block to fail on is the private fields.
///
/// ```
/// use silverhand_backend_core::{
///     identity::{AgentId, HostId},
///     teardown::intent::AgentDeletionAttempt,
/// };
/// fn parts(attempt: &AgentDeletionAttempt) -> (&AgentId, &HostId, i64) {
///     (attempt.agent_id(), attempt.host_id(), attempt.deletion_started_at())
/// }
/// ```
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AgentDeletionAttempt {
    agent_id: AgentId,
    host_id: HostId,
    deletion_started_at: i64,
}

impl AgentDeletionAttempt {
    /// Private on purpose — see the module doc. The only inputs are the parts of
    /// a marker that persistence read back.
    ///
    /// Infallible because it has nothing to bind to: its one caller is boot
    /// discovery, where the marker is the whole request.
    fn mint(intent: PersistedDeletionIntent) -> Self {
        Self {
            agent_id: intent.agent_id,
            host_id: intent.host_id,
            deletion_started_at: intent.deletion_started_at,
        }
    }

    /// The mint that serves a request: the parts must describe the agent the
    /// caller named. A marker read back for another agent would mint a token whose
    /// purge and whose announcement route at a row nobody asked about.
    fn mint_for(
        requested: &AgentId,
        intent: PersistedDeletionIntent,
    ) -> Result<Self, TeardownContractViolation> {
        same_agent(requested, &intent.agent_id)?;
        Ok(Self::mint(intent))
    }

    pub fn agent_id(&self) -> &AgentId {
        &self.agent_id
    }

    pub fn host_id(&self) -> &HostId {
        &self.host_id
    }

    pub fn deletion_started_at(&self) -> i64 {
        self.deletion_started_at
    }
}

/// The parts of a durable deletion marker, as persistence read them. An adapter
/// produces this; only this module turns it into an attempt.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PersistedDeletionIntent {
    pub agent_id: AgentId,
    pub host_id: HostId,
    pub deletion_started_at: i64,
}

/// What the marker write found, in persistence's own vocabulary.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum BeginDeletionRecord {
    /// The real null → timestamp transition. Only this arm changed a fact, which
    /// is why only this arm may drive an announcement.
    Started(PersistedDeletionIntent),
    /// A marker was already there: this request changed nothing.
    AlreadyPending(PersistedDeletionIntent),
    NotFound,
    /// Present, but not at a stage a deletion may begin from.
    NotActive,
    /// A runtime transition holds the row; deleting now would race it.
    RuntimeTransitionInProgress,
}

/// The same outcomes with the token minted. Distinct from
/// [`BeginDeletionRecord`] because the mint is this module's act, not the
/// adapter's.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum BeginDeletion {
    Started(AgentDeletionAttempt),
    AlreadyPending(AgentDeletionAttempt),
    NotFound,
    NotActive,
    RuntimeTransitionInProgress,
}

/// What completing an attempt found.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum CompleteDeletion {
    /// The row is already gone — a concurrent completion won, and this is not a
    /// failure.
    Gone,
    /// The marker no longer matches this attempt: another attempt owns the
    /// deletion now, so this one must not delete anything.
    AttemptLost,
    /// Boxed: this is the only arm that carries facts, and the refusals are
    /// what a hot retry loop moves around.
    ///
    /// The completing write's compare-and-set is "still active, still on the
    /// computer this attempt routes to", which IS
    /// [`crate::teardown::eligibility::AgentTeardownEligibility::ActiveOn`] — so it
    /// mints its witness through the same rule the other producers use rather than
    /// re-stating the comparison for itself.
    Committed(Box<AgentTornDown>),
}

/// The durable half of the deletion lifecycle. Both writes are short and hold no
/// remote IO: the marker write is a compare-and-set on the stage and the absent
/// marker, and the completing write is a compare-and-set on this exact attempt.
pub trait AgentDeletionLifecyclePort: Clone + Send + Sync + 'static {
    fn begin(
        &self,
        agent_id: &AgentId,
        started_at: i64,
    ) -> impl Future<Output = Result<BeginDeletionRecord, PersistenceFailure>> + Send;

    /// Boot discovery only. Dispatch begins after transport attachment, never
    /// from this read.
    fn list_pending(
        &self,
    ) -> impl Future<Output = Result<Vec<PersistedDeletionIntent>, PersistenceFailure>> + Send;

    /// Capture and delete, keyed on the attempt. The capture is taken in the same
    /// write that deletes the rows it derives from.
    ///
    /// Fails with [`TeardownFailure`] rather than a persistence error alone because
    /// the committed arm carries an [`AgentTornDown`], and sealing one is part of
    /// implementing this: an implementation whose witness, capture and captured seats
    /// do not describe one agent must surface that as the defect it is.
    fn complete(
        &self,
        attempt: &AgentDeletionAttempt,
    ) -> impl Future<Output = Result<CompleteDeletion, TeardownFailure>> + Send;
}

/// Record the fail-forward intent for one agent.
pub async fn begin_agent_deletion<P>(
    port: &P,
    agent_id: &AgentId,
    started_at: i64,
) -> Result<BeginDeletion, TeardownFailure>
where
    P: AgentDeletionLifecyclePort,
{
    Ok(match port.begin(agent_id, started_at).await? {
        BeginDeletionRecord::Started(intent) => {
            BeginDeletion::Started(AgentDeletionAttempt::mint_for(agent_id, intent)?)
        }
        BeginDeletionRecord::AlreadyPending(intent) => {
            BeginDeletion::AlreadyPending(AgentDeletionAttempt::mint_for(agent_id, intent)?)
        }
        BeginDeletionRecord::NotFound => BeginDeletion::NotFound,
        BeginDeletionRecord::NotActive => BeginDeletion::NotActive,
        BeginDeletionRecord::RuntimeTransitionInProgress => {
            BeginDeletion::RuntimeTransitionInProgress
        }
    })
}

/// The attempts a restart inherits.
///
/// Keeps the narrower persistence error: this seals nothing and binds nothing, because
/// each marker is its own coordinate. A caller in a teardown-failure context converts.
pub async fn pending_agent_deletions<P>(
    port: &P,
) -> Result<Vec<AgentDeletionAttempt>, PersistenceFailure>
where
    P: AgentDeletionLifecyclePort,
{
    Ok(port
        .list_pending()
        .await?
        .into_iter()
        .map(AgentDeletionAttempt::mint)
        .collect())
}

/// Proof that a host-local purge fence acknowledged before a completion ran.
///
/// This is a structural obligation on the CALL CHAIN, not a claim about any fence
/// implementation's honesty. Its only constructor is [`PurgeReceipt::sealed`], which is
/// `pub(crate)` and minted at exactly one site — [`crate::teardown::agent_delete_resume`],
/// immediately after the fence port returns `Ok`. Because [`complete_agent_deletion`]
/// consumes one by value, the borrow checker makes "complete without first awaiting the
/// fence" unwriteable from outside this crate: a server-side caller cannot name the type
/// to mint it, so it must route through the resume free function that mints it in order.
/// It does not, and cannot, prove that the fence actually quiesced the right daemon
/// generation — the verify-at-send guard in the transport does that; this only proves the
/// two steps were sequenced.
pub struct PurgeReceipt {
    _seal: (),
}

impl PurgeReceipt {
    /// Minted only after a real fence `Ok`, from inside this crate. See the type doc.
    pub(crate) fn sealed() -> Self {
        Self { _seal: () }
    }
}

/// Complete one attempt, and bind what came back to the attempt that asked.
///
/// [`AgentTornDown`] is already sealed around the agent the write ran for, so this is
/// not that check again: it is the OUTER coordinate. The attempt is what a retry loop
/// holds, what routes the host-local purge and whose id the announcement carries, so a
/// committed teardown of another agent — or of this agent on a computer the attempt
/// never routed to — would send that work somewhere this attempt never named.
///
/// Every mismatch here is an internal contract failure, in the same vocabulary the
/// seals speak. This is the ONLY place the outer binding happens: a consumer that
/// calls [`AgentDeletionLifecyclePort::complete`] itself receives the committed arm
/// unbound, so going through this function is an obligation on consumers, not
/// something the type system takes away from them.
///
/// The [`PurgeReceipt`] argument is consumed to make the fence-then-commit order
/// structural rather than documented: see that type.
pub async fn complete_agent_deletion<P>(
    port: &P,
    attempt: &AgentDeletionAttempt,
    receipt: PurgeReceipt,
) -> Result<CompleteDeletion, TeardownFailure>
where
    P: AgentDeletionLifecyclePort,
{
    let PurgeReceipt { _seal: () } = receipt;
    let outcome = port.complete(attempt).await?;
    if let CompleteDeletion::Committed(torn) = &outcome {
        same_agent(attempt.agent_id(), &torn.facts().id)?;
        same_computer(attempt.host_id(), &torn.facts().host_id)?;
    }
    Ok(outcome)
}

#[cfg(test)]
mod tests {
    use std::sync::{Arc, Mutex};

    use super::*;
    use crate::{
        identity_access::agent_lifecycle::MaterializationStatus,
        teardown::{
            eligibility::{AgentTeardownEligibility, EligibilityVerdict, hold_eligibility},
            facts::{AgentTeardownCapture, AgentTeardownFacts},
        },
    };

    fn agent(id: &str) -> AgentId {
        AgentId::parse(id).expect("agent id")
    }

    fn intent(agent_id: &str, host_id: &str, at: i64) -> PersistedDeletionIntent {
        PersistedDeletionIntent {
            agent_id: agent(agent_id),
            host_id: HostId::parse(host_id).expect("host id"),
            deletion_started_at: at,
        }
    }

    #[derive(Clone)]
    struct FakeLifecycle {
        begin: BeginDeletionRecord,
        pending: Vec<PersistedDeletionIntent>,
        complete: CompleteDeletion,
        completed: Arc<Mutex<Vec<AgentDeletionAttempt>>>,
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
            Ok(self.pending.clone())
        }

        async fn complete(
            &self,
            attempt: &AgentDeletionAttempt,
        ) -> Result<CompleteDeletion, TeardownFailure> {
            self.completed.lock().expect("lock").push(attempt.clone());
            Ok(self.complete.clone())
        }
    }

    fn lifecycle(begin: BeginDeletionRecord) -> FakeLifecycle {
        FakeLifecycle {
            begin,
            pending: Vec::new(),
            complete: CompleteDeletion::Gone,
            completed: Arc::new(Mutex::new(Vec::new())),
        }
    }

    /// Obtained the way production obtains it: the token cannot be built from parts,
    /// so every test that needs one asks the rule for it.
    async fn attempt(
        port: &FakeLifecycle,
        agent_id: &str,
        started_at: i64,
    ) -> AgentDeletionAttempt {
        let BeginDeletion::Started(attempt) =
            begin_agent_deletion(port, &agent(agent_id), started_at)
                .await
                .expect("begin")
        else {
            panic!("expected a started attempt");
        };
        attempt
    }

    /// A committed teardown, sealed the only way one can be.
    fn torn_down(agent_id: &str, host_id: &str) -> CompleteDeletion {
        let id = agent(agent_id);
        let host = HostId::parse(host_id).expect("host id");
        let EligibilityVerdict::Held(held) = hold_eligibility(
            &AgentTeardownEligibility::ActiveOn {
                host_id: host.clone(),
            },
            AgentTeardownFacts {
                id: id.clone(),
                name: agent_id.into(),
                display_name: agent_id.into(),
                runtime: "claude".into(),
                host_id: host,
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
            dm_blob_refs: Vec::new(),
            dm_channel_id: None,
            regular_workspace_count: 0,
        };
        CompleteDeletion::Committed(Box::new(
            AgentTornDown::seal(&id, held, capture).expect("one agent"),
        ))
    }

    #[tokio::test]
    async fn a_marker_that_was_written_yields_an_attempt_carrying_its_routing() {
        let port = lifecycle(BeginDeletionRecord::Started(intent("a1", "h1", 4242)));
        let attempt = attempt(&port, "a1", 4242).await;
        assert_eq!(attempt.agent_id(), &agent("a1"));
        assert_eq!(attempt.host_id().as_str(), "h1");
        assert_eq!(attempt.deletion_started_at(), 4242);
    }

    #[tokio::test]
    async fn an_existing_marker_is_a_distinct_answer_from_having_written_one() {
        let port = lifecycle(BeginDeletionRecord::AlreadyPending(intent("a1", "h1", 7)));
        assert!(matches!(
            begin_agent_deletion(&port, &agent("a1"), 9)
                .await
                .expect("begin"),
            BeginDeletion::AlreadyPending(_)
        ));
    }

    #[tokio::test]
    async fn a_refusal_carries_no_attempt_at_all() {
        for record in [
            BeginDeletionRecord::NotFound,
            BeginDeletionRecord::NotActive,
            BeginDeletionRecord::RuntimeTransitionInProgress,
        ] {
            let port = lifecycle(record);
            let outcome = begin_agent_deletion(&port, &agent("a1"), 1)
                .await
                .expect("begin");
            assert!(!matches!(
                outcome,
                BeginDeletion::Started(_) | BeginDeletion::AlreadyPending(_)
            ));
        }
    }

    #[tokio::test]
    async fn a_marker_read_back_for_another_agent_mints_no_token() {
        // Both arms mint, so both are bound: a token minted here would route a1's
        // request at a2's computer, and the caller would have no way to tell.
        for record in [
            BeginDeletionRecord::Started(intent("a2", "h2", 1)),
            BeginDeletionRecord::AlreadyPending(intent("a2", "h2", 1)),
        ] {
            let port = lifecycle(record);
            let failure = begin_agent_deletion(&port, &agent("a1"), 1)
                .await
                .expect_err("a spliced marker is not an answer");
            assert_eq!(
                failure.violation(),
                Some(&TeardownContractViolation::AgentMismatch {
                    expected: agent("a1"),
                    found: agent("a2"),
                })
            );
        }
    }

    #[tokio::test]
    async fn a_restart_inherits_one_attempt_per_durable_marker() {
        let mut port = lifecycle(BeginDeletionRecord::NotFound);
        port.pending = vec![intent("a1", "h1", 1), intent("a2", "h2", 2)];
        let attempts = pending_agent_deletions(&port).await.expect("pending");
        assert_eq!(
            attempts
                .iter()
                .map(|a| (a.agent_id().as_str(), a.host_id().as_str()))
                .collect::<Vec<_>>(),
            vec![("a1", "h1"), ("a2", "h2")]
        );
    }

    #[tokio::test]
    async fn completing_can_only_name_an_attempt_that_a_marker_produced() {
        // The token cannot be built from parts here, so this test has to obtain
        // one the same way production does. That is the whole guarantee.
        let port = lifecycle(BeginDeletionRecord::Started(intent("a1", "h1", 5)));
        let attempt = attempt(&port, "a1", 5).await;
        assert_eq!(
            complete_agent_deletion(&port, &attempt, PurgeReceipt::sealed())
                .await
                .expect("complete"),
            CompleteDeletion::Gone
        );
        assert_eq!(port.completed.lock().expect("lock").as_slice(), &[attempt]);
    }

    #[tokio::test]
    async fn a_committed_teardown_is_the_attempts_own_agent_and_computer() {
        let mut port = lifecycle(BeginDeletionRecord::Started(intent("a1", "h1", 5)));
        let attempt = attempt(&port, "a1", 5).await;
        port.complete = torn_down("a1", "h1");
        assert_eq!(
            complete_agent_deletion(&port, &attempt, PurgeReceipt::sealed())
                .await
                .expect("complete"),
            torn_down("a1", "h1")
        );
    }

    #[tokio::test]
    async fn a_committed_teardown_of_another_agent_is_not_this_attempts() {
        // Well-formed on its own — sealed around a2 throughout — and still a splice
        // here: this attempt's retry loop and purge routing name a1.
        let mut port = lifecycle(BeginDeletionRecord::Started(intent("a1", "h1", 5)));
        let attempt = attempt(&port, "a1", 5).await;
        port.complete = torn_down("a2", "h1");
        let failure = complete_agent_deletion(&port, &attempt, PurgeReceipt::sealed())
            .await
            .expect_err("a spliced outcome is not an answer");
        assert_eq!(
            failure.violation(),
            Some(&TeardownContractViolation::AgentMismatch {
                expected: agent("a1"),
                found: agent("a2"),
            })
        );
    }

    #[tokio::test]
    async fn a_committed_teardown_on_another_computer_is_not_this_attempts() {
        // The agent matches, so only the placement check catches it: the attempt
        // purged h1's tree, and a row that committed on h2 leaves h2 holding files
        // with no row left to retry from.
        let mut port = lifecycle(BeginDeletionRecord::Started(intent("a1", "h1", 5)));
        let attempt = attempt(&port, "a1", 5).await;
        port.complete = torn_down("a1", "h2");
        let failure = complete_agent_deletion(&port, &attempt, PurgeReceipt::sealed())
            .await
            .expect_err("a spliced outcome is not an answer");
        assert_eq!(
            failure.violation(),
            Some(&TeardownContractViolation::ComputerMismatch {
                expected: HostId::parse("h1").expect("host id"),
                found: HostId::parse("h2").expect("host id"),
            })
        );
    }
}
