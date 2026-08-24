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

use std::future::Future;

use crate::{
    identity::{AgentId, HostId},
    persistence::PersistenceFailure,
    teardown::write::AgentTornDown,
};

/// A deletion attempt that is durably recorded. Carries exactly what completing
/// it needs: which agent, which computer its host-local work routes to, and the
/// marker's own timestamp, which is the token the completing CAS matches on.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AgentDeletionAttempt {
    agent_id: AgentId,
    host_id: HostId,
    deletion_started_at: i64,
}

impl AgentDeletionAttempt {
    /// Private on purpose — see the module doc. The only inputs are the parts of
    /// a marker that persistence read back.
    fn mint(intent: PersistedDeletionIntent) -> Self {
        Self {
            agent_id: intent.agent_id,
            host_id: intent.host_id,
            deletion_started_at: intent.deletion_started_at,
        }
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
    fn complete(
        &self,
        attempt: &AgentDeletionAttempt,
    ) -> impl Future<Output = Result<CompleteDeletion, PersistenceFailure>> + Send;
}

/// Record the fail-forward intent for one agent.
pub async fn begin_agent_deletion<P>(
    port: &P,
    agent_id: &AgentId,
    started_at: i64,
) -> Result<BeginDeletion, PersistenceFailure>
where
    P: AgentDeletionLifecyclePort,
{
    Ok(match port.begin(agent_id, started_at).await? {
        BeginDeletionRecord::Started(intent) => {
            BeginDeletion::Started(AgentDeletionAttempt::mint(intent))
        }
        BeginDeletionRecord::AlreadyPending(intent) => {
            BeginDeletion::AlreadyPending(AgentDeletionAttempt::mint(intent))
        }
        BeginDeletionRecord::NotFound => BeginDeletion::NotFound,
        BeginDeletionRecord::NotActive => BeginDeletion::NotActive,
        BeginDeletionRecord::RuntimeTransitionInProgress => {
            BeginDeletion::RuntimeTransitionInProgress
        }
    })
}

/// The attempts a restart inherits.
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

#[cfg(test)]
mod tests {
    use std::sync::{Arc, Mutex};

    use super::*;

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
        ) -> Result<CompleteDeletion, PersistenceFailure> {
            self.completed.lock().expect("lock").push(attempt.clone());
            Ok(CompleteDeletion::Gone)
        }
    }

    fn lifecycle(begin: BeginDeletionRecord) -> FakeLifecycle {
        FakeLifecycle {
            begin,
            pending: Vec::new(),
            completed: Arc::new(Mutex::new(Vec::new())),
        }
    }

    #[tokio::test]
    async fn a_marker_that_was_written_yields_an_attempt_carrying_its_routing() {
        let port = lifecycle(BeginDeletionRecord::Started(intent("a1", "h1", 4242)));
        let BeginDeletion::Started(attempt) = begin_agent_deletion(&port, &agent("a1"), 4242)
            .await
            .expect("begin")
        else {
            panic!("expected a started attempt");
        };
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
        let BeginDeletion::Started(attempt) = begin_agent_deletion(&port, &agent("a1"), 5)
            .await
            .expect("begin")
        else {
            panic!("expected a started attempt");
        };
        assert_eq!(
            port.complete(&attempt).await.expect("complete"),
            CompleteDeletion::Gone
        );
        assert_eq!(port.completed.lock().expect("lock").as_slice(), &[attempt]);
    }
}
