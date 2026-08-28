//! The process-local scheduler that carries every durable agent-deletion marker to
//! its committed end, held only in this process.
//!
//! The durable marker is the ONLY recovery truth. A restart rebuilds the pending set
//! from [`pending_agent_deletions`] and nothing else; this scheduler adds no second
//! queue and no per-leg state machine. It decides only WHEN to run an attempt — it
//! coalesces duplicate triggers per agent, walks a bounded retry ladder per host
//! connection generation, and supersedes a chain whose daemon reconnected — and hands
//! the ordered work itself to [`resume_agent_deletion`], which owns the fence-then-commit
//! sequence and the retry taxonomy. This module never re-classifies an outcome; it maps
//! [`ResumeOutcome`] to {drop the token, retry the whole chain} and does no domain
//! reasoning of its own.
//!
//! ## What a generation is, and why it bounds retries
//!
//! An attempt can only make progress against the daemon connection that currently owns
//! the agent's host: the purge fences that live transport. A *generation* is one such
//! connection id. When a daemon reconnects it gets a fresh id, so a retry chain bound to
//! the old generation is superseded — a stale timer that wakes finds a different id and
//! does nothing — rather than racing the new transport. The retry ladder (`[1s, 5s,
//! 30s]`) is per generation: a fresh connection starts the ladder over, because a
//! reconnect is new evidence that a transient fault may now clear.
//!
//! ## Fail-forward, so a lost attempt is safe
//!
//! Losing an in-flight attempt to a crash or shutdown is not a lost deletion: the marker
//! is durable, so [`recover`](AgentDeletionResumer::recover) rediscovers it and the
//! idempotent purge → commit chain runs again. Shutdown therefore only has to stop
//! scheduling new work and drop its timers; it need not drain the wire.

use std::{
    collections::{HashMap, HashSet},
    sync::{Arc, Mutex},
    time::Duration,
};

use silverhand_backend_core::{
    identity::{AgentId, HostId},
    persistence::PersistenceFailure,
    teardown::{
        agent_delete_resume::{
            AgentDeletionResidue, AgentQuiescePurge, ResidueFault, ResumeOutcome, RetryReason,
            resume_agent_deletion,
        },
        intent::{AgentDeletionAttempt, AgentDeletionLifecyclePort, pending_agent_deletions},
    },
};
use tokio::task::JoinHandle;

use crate::error;

/// The live daemon connection generation that currently owns a host, if any.
///
/// A generation is one attached connection id. The resumer only ever compares this id
/// for equality — to bind a retry chain to a generation and to notice when a reconnect
/// has superseded one — and never dials through it, so the port carries no command
/// channel a caller could grow a second transport out of.
pub trait HostConnections: Clone + Send + Sync + 'static {
    fn current_generation(&self, host: &HostId) -> Option<String>;
}

/// The default retry ladder walked per host connection generation, after the immediate
/// ready/request attempt: 1s, then 5s, then 30s, then the generation gives up until a
/// reconnect starts it over.
const DEFAULT_RETRY_DELAYS_MS: [u64; 3] = [1_000, 5_000, 30_000];

/// What one drive of an attempt resolved to, for the caller of an explicit request.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum DeletionRunOutcome {
    /// The control-plane rows are gone (this attempt committed them, or a concurrent
    /// completion already had). Any post-commit residue failure was carried and logged.
    Completed,
    /// An attempt for this agent is already in flight; this trigger coalesced into it.
    AlreadyRunning,
    /// The marker is retained and will be retried — either on the scheduled ladder for
    /// an attached host, or when the owning host next attaches.
    Retained,
    /// The marker no longer matches this attempt; the token is dropped, never
    /// hot-retried. A genuinely still-pending agent re-enters through a fresh request or
    /// the next [`recover`](AgentDeletionResumer::recover).
    Superseded,
    /// An internal contract fault a retry cannot fix. The in-memory token is dropped and
    /// the fault logged; the durable marker stays on disk for a later boot to re-list.
    Faulted,
    /// The worker is shutting down and accepted no new work.
    Closed,
}

struct Generation {
    connection_id: String,
    next_delay_index: usize,
    timer: Option<JoinHandle<()>>,
}

#[derive(Default)]
struct Tracked {
    closed: bool,
    /// The markers this process is still driving, keyed by agent.
    pending: HashMap<AgentId, AgentDeletionAttempt>,
    /// The agents whose attempt is running right now — the per-agent single-flight lock.
    in_flight: HashSet<AgentId>,
    /// The live retry generation per host.
    generations: HashMap<HostId, Generation>,
}

impl Tracked {
    /// Abort any pending timer and install a fresh generation at ladder position zero.
    fn install_generation(&mut self, host: &HostId, connection_id: &str) {
        if let Some(mut old) = self.generations.remove(host)
            && let Some(timer) = old.timer.take()
        {
            timer.abort();
        }
        self.generations.insert(
            host.clone(),
            Generation {
                connection_id: connection_id.to_owned(),
                next_delay_index: 0,
                timer: None,
            },
        );
    }

    /// Adopt a newly-ready generation. Returns whether it is genuinely new: an identical
    /// connection id is already owned, so re-adopting it would restart a chain that is
    /// already live.
    fn adopt_generation(&mut self, host: &HostId, connection_id: &str) -> bool {
        if self
            .generations
            .get(host)
            .is_some_and(|generation| generation.connection_id == connection_id)
        {
            return false;
        }
        self.install_generation(host, connection_id);
        true
    }
}

/// A durable-deletion worker. Cloning shares the one tracked state behind `Arc`; the
/// dependencies are cheap handles onto shared authorities, never second roots.
pub struct AgentDeletionResumer<L, Q, R, C> {
    tracked: Arc<Mutex<Tracked>>,
    lifecycle: L,
    purge: Q,
    residue: R,
    connections: C,
    retry_delays: Arc<[Duration]>,
}

impl<L, Q, R, C> Clone for AgentDeletionResumer<L, Q, R, C>
where
    L: Clone,
    Q: Clone,
    R: Clone,
    C: Clone,
{
    fn clone(&self) -> Self {
        Self {
            tracked: Arc::clone(&self.tracked),
            lifecycle: self.lifecycle.clone(),
            purge: self.purge.clone(),
            residue: self.residue.clone(),
            connections: self.connections.clone(),
            retry_delays: Arc::clone(&self.retry_delays),
        }
    }
}

impl<L, Q, R, C> AgentDeletionResumer<L, Q, R, C>
where
    L: AgentDeletionLifecyclePort,
    Q: AgentQuiescePurge,
    R: AgentDeletionResidue,
    C: HostConnections,
{
    /// Assemble the worker over production authorities with the default retry ladder.
    pub fn new(lifecycle: L, purge: Q, residue: R, connections: C) -> Self {
        Self::with_retry_delays(
            lifecycle,
            purge,
            residue,
            connections,
            DEFAULT_RETRY_DELAYS_MS
                .into_iter()
                .map(Duration::from_millis)
                .collect(),
        )
    }

    /// As [`new`](Self::new), with an explicit ladder — the seam the paused-time tests
    /// drive.
    pub fn with_retry_delays(
        lifecycle: L,
        purge: Q,
        residue: R,
        connections: C,
        retry_delays: Vec<Duration>,
    ) -> Self {
        Self {
            tracked: Arc::new(Mutex::new(Tracked::default())),
            lifecycle,
            purge,
            residue,
            connections,
            retry_delays: retry_delays.into(),
        }
    }

    /// Rebuild the pending set from the durable markers and drive every one whose host is
    /// already attached. This is the only place markers are discovered; it performs no
    /// daemon IO for a host that is not currently connected — that host's markers wait
    /// for [`on_host_ready`](Self::on_host_ready).
    pub async fn recover(&self) -> Result<(), PersistenceFailure> {
        let attempts = pending_agent_deletions(&self.lifecycle).await?;
        let hosts = {
            let mut tracked = self.tracked.lock().expect("resumer state");
            if tracked.closed {
                return Ok(());
            }
            let mut hosts = HashSet::new();
            for attempt in attempts {
                hosts.insert(attempt.host_id().clone());
                tracked.pending.insert(attempt.agent_id().clone(), attempt);
            }
            hosts
        };
        for host in hosts {
            if let Some(connection_id) = self.connections.current_generation(&host) {
                self.on_host_ready(&host, &connection_id);
            }
        }
        Ok(())
    }

    /// A daemon has (re)attached for `host` on connection `connection_id`. Adopt the
    /// generation and take the first, immediate attempt at every marker on that host; the
    /// retry ladder only begins after that attempt asks to be retried. An identical
    /// connection id that is already owned is a no-op, so a repeated ready signal cannot
    /// stack duplicate chains.
    pub fn on_host_ready(&self, host: &HostId, connection_id: &str) {
        {
            let mut tracked = self.tracked.lock().expect("resumer state");
            if tracked.closed || !tracked.adopt_generation(host, connection_id) {
                return;
            }
        }
        self.spawn_host_generation(host.clone(), connection_id.to_owned());
    }

    /// Drive one marker right now — the explicit-request entry, e.g. behind a delete
    /// endpoint. The marker is retained under this worker before any IO, so a crash after
    /// this returns still resumes. If the host is attached, the request resets that host's
    /// ladder to a fresh immediate attempt; if it is not, the marker simply waits for the
    /// host to attach.
    pub async fn try_now(&self, attempt: AgentDeletionAttempt) -> DeletionRunOutcome {
        let host = attempt.host_id().clone();
        {
            let mut tracked = self.tracked.lock().expect("resumer state");
            if tracked.closed {
                return DeletionRunOutcome::Closed;
            }
            tracked
                .pending
                .insert(attempt.agent_id().clone(), attempt.clone());
            if tracked.in_flight.contains(attempt.agent_id()) {
                return DeletionRunOutcome::AlreadyRunning;
            }
        }
        let Some(connection_id) = self.connections.current_generation(&host) else {
            // No live daemon owns the host: nothing to fence against yet. The marker is
            // retained and its host's `on_host_ready` will drive it.
            return DeletionRunOutcome::Retained;
        };
        {
            let mut tracked = self.tracked.lock().expect("resumer state");
            if tracked.closed {
                return DeletionRunOutcome::Closed;
            }
            // An explicit request always earns a fresh immediate attempt and a fresh
            // ladder, even on the same connection.
            tracked.install_generation(&host, &connection_id);
        }
        self.run_single_flight(&attempt).await
    }

    /// Stop scheduling and drop every pending timer. A restart loses in-flight attempts,
    /// which the durable marker makes safe: each is rediscovered by the next `recover`.
    pub fn close(&self) {
        let mut tracked = self.tracked.lock().expect("resumer state");
        tracked.closed = true;
        for (_, mut generation) in tracked.generations.drain() {
            if let Some(timer) = generation.timer.take() {
                timer.abort();
            }
        }
    }

    fn spawn_host_generation(&self, host: HostId, connection_id: String) {
        let worker = self.clone();
        tokio::spawn(async move {
            worker.run_host_generation(host, connection_id).await;
        });
    }

    /// Attempt every marker on `host`, provided this exact generation still owns it. Each
    /// marker runs through the shared single-flight, so a marker already in flight (from a
    /// request or an overlapping generation) is joined by coalescing, not run twice.
    async fn run_host_generation(&self, host: HostId, connection_id: String) {
        {
            let tracked = self.tracked.lock().expect("resumer state");
            if tracked.closed
                || !tracked
                    .generations
                    .get(&host)
                    .is_some_and(|generation| generation.connection_id == connection_id)
            {
                return;
            }
        }
        // The daemon may have been replaced between scheduling and waking; the live
        // registry is the authority on which connection owns the host now.
        if self.connections.current_generation(&host).as_deref() != Some(connection_id.as_str()) {
            return;
        }
        let attempts = {
            let tracked = self.tracked.lock().expect("resumer state");
            tracked
                .pending
                .values()
                .filter(|attempt| attempt.host_id() == &host)
                .cloned()
                .collect::<Vec<_>>()
        };
        for attempt in attempts {
            self.run_single_flight(&attempt).await;
        }
    }

    /// Run one attempt under the per-agent single-flight lock, then apply its classified
    /// outcome to the pending set and, for a retry, arm the host ladder. A marker already
    /// in flight returns immediately — the running attempt owns the result and any retry.
    async fn run_single_flight(&self, attempt: &AgentDeletionAttempt) -> DeletionRunOutcome {
        {
            let mut tracked = self.tracked.lock().expect("resumer state");
            if tracked.closed {
                return DeletionRunOutcome::Closed;
            }
            if !tracked.in_flight.insert(attempt.agent_id().clone()) {
                return DeletionRunOutcome::AlreadyRunning;
            }
        }

        let outcome =
            resume_agent_deletion(&self.lifecycle, &self.purge, &self.residue, attempt).await;

        let agent = attempt.agent_id();
        {
            let mut tracked = self.tracked.lock().expect("resumer state");
            tracked.in_flight.remove(agent);
            match &outcome {
                ResumeOutcome::Deleted { .. }
                | ResumeOutcome::Superseded
                | ResumeOutcome::Faulted(_) => {
                    tracked.pending.remove(agent);
                }
                // A retry keeps the marker under this worker; the ladder is armed below,
                // outside the lock, because arming re-enters it.
                ResumeOutcome::Retry(_) => {}
            }
        }

        match outcome {
            ResumeOutcome::Deleted { residue } => {
                self.log_completed(attempt, &residue);
                DeletionRunOutcome::Completed
            }
            ResumeOutcome::Superseded => {
                tracing::info!(
                    agent_id = %attempt.agent_id().as_str(),
                    host_id = %attempt.host_id().as_str(),
                    "agent deletion attempt superseded; the marker moved on, dropping this token"
                );
                DeletionRunOutcome::Superseded
            }
            ResumeOutcome::Retry(reason) => {
                self.log_retry(attempt, &reason);
                self.schedule_next_retry(attempt.host_id());
                DeletionRunOutcome::Retained
            }
            ResumeOutcome::Faulted(failure) => {
                tracing::error!(
                    agent_id = %attempt.agent_id().as_str(),
                    host_id = %attempt.host_id().as_str(),
                    error_chain = %error::describe(&failure),
                    "agent deletion hit an internal contract fault; dropping the in-memory token, the durable marker stays for a later boot"
                );
                DeletionRunOutcome::Faulted
            }
        }
    }

    /// Arm the next ladder step for `host`, if a generation owns it and no timer is
    /// already pending. One timer per generation drives every marker on the host, so
    /// several markers asking to retry share one step rather than stacking timers.
    fn schedule_next_retry(&self, host: &HostId) {
        let mut tracked = self.tracked.lock().expect("resumer state");
        if tracked.closed {
            return;
        }
        let Some(generation) = tracked.generations.get(host) else {
            return;
        };
        if generation.timer.is_some() {
            return;
        }
        let index = generation.next_delay_index;
        let connection_id = generation.connection_id.clone();
        let Some(delay) = self.retry_delays.get(index).copied() else {
            tracing::warn!(
                host_id = %host.as_str(),
                connection_id = %connection_id,
                attempts = index,
                "agent deletion retry ladder exhausted for this host connection generation; awaiting a reconnect"
            );
            return;
        };

        let worker = self.clone();
        let host_key = host.clone();
        let armed = connection_id.clone();
        let handle = tokio::spawn(async move {
            tokio::time::sleep(delay).await;
            {
                let mut tracked = worker.tracked.lock().expect("resumer state");
                match tracked.generations.get_mut(&host_key) {
                    // Still our generation: release the timer slot so a further retry can
                    // arm, then run.
                    Some(generation) if generation.connection_id == armed => {
                        generation.timer = None;
                    }
                    // Superseded while we slept: a newer generation owns the slot, and
                    // clearing its timer would strand it. Leave it untouched.
                    _ => return,
                }
            }
            worker.run_host_generation(host_key, armed).await;
        });

        let generation = tracked
            .generations
            .get_mut(host)
            .expect("generation present under the same lock");
        generation.next_delay_index += 1;
        generation.timer = Some(handle);
    }

    fn log_completed(&self, attempt: &AgentDeletionAttempt, residue: &[ResidueFault]) {
        for fault in residue {
            tracing::warn!(
                agent_id = %fault.agent.as_str(),
                effect = ?fault.effect,
                error_chain = %error::describe(&fault.failure),
                "agent deletion committed but a post-commit effect failed; carried, never rolled back"
            );
        }
        tracing::info!(
            agent_id = %attempt.agent_id().as_str(),
            host_id = %attempt.host_id().as_str(),
            deletion_started_at = attempt.deletion_started_at(),
            "agent deletion completed"
        );
    }

    fn log_retry(&self, attempt: &AgentDeletionAttempt, reason: &RetryReason) {
        let chain = match reason {
            RetryReason::Purge(failure) => error::describe(failure),
            RetryReason::Persistence(failure) => error::describe(failure),
        };
        tracing::warn!(
            agent_id = %attempt.agent_id().as_str(),
            host_id = %attempt.host_id().as_str(),
            error_chain = %chain,
            "agent deletion could not complete this attempt; retaining the durable marker and retrying"
        );
    }
}

#[cfg(test)]
mod tests {
    use std::{
        io,
        sync::atomic::{AtomicUsize, Ordering::SeqCst},
    };

    use silverhand_backend_core::{
        agent_lifecycle::MaterializationStatus,
        host_runtime::aftermath::CustodyEffectFailure,
        teardown::{
            agent_delete_resume::QuiescePurgeFailure,
            contract::TeardownFailure,
            eligibility::{AgentTeardownEligibility, EligibilityVerdict, hold_eligibility},
            facts::{AgentTeardownCapture, AgentTeardownFacts, StoredBlobRef},
            intent::{
                BeginDeletion, BeginDeletionRecord, CompleteDeletion, PersistedDeletionIntent,
                begin_agent_deletion,
            },
            write::AgentTornDown,
        },
    };

    use super::*;

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

    fn torn_down(agent_id: &str, host_id: &str) -> CompleteDeletion {
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
            dm_blob_refs: Vec::new(),
            dm_channel_id: None,
            regular_workspace_count: 0,
        };
        CompleteDeletion::Committed(Box::new(
            AgentTornDown::seal(&id, held, capture).expect("one agent"),
        ))
    }

    /// A lifecycle port whose `list_pending` and `complete` are configurable, counting
    /// completes so a test can prove the commit was or was not reached.
    #[derive(Clone)]
    struct FakeLifecycle {
        pending: Arc<Mutex<Vec<PersistedDeletionIntent>>>,
        complete: Arc<Mutex<CompleteDeletion>>,
        completes: Arc<AtomicUsize>,
    }

    impl FakeLifecycle {
        fn new(pending: Vec<PersistedDeletionIntent>, complete: CompleteDeletion) -> Self {
            Self {
                pending: Arc::new(Mutex::new(pending)),
                complete: Arc::new(Mutex::new(complete)),
                completes: Arc::new(AtomicUsize::new(0)),
            }
        }
    }

    impl AgentDeletionLifecyclePort for FakeLifecycle {
        async fn begin(
            &self,
            agent_id: &AgentId,
            started_at: i64,
        ) -> Result<BeginDeletionRecord, PersistenceFailure> {
            Ok(BeginDeletionRecord::Started(PersistedDeletionIntent {
                agent_id: agent_id.clone(),
                host_id: host("h1"),
                deletion_started_at: started_at,
            }))
        }

        async fn list_pending(&self) -> Result<Vec<PersistedDeletionIntent>, PersistenceFailure> {
            Ok(self.pending.lock().expect("pending").clone())
        }

        async fn complete(
            &self,
            _attempt: &AgentDeletionAttempt,
        ) -> Result<CompleteDeletion, TeardownFailure> {
            self.completes.fetch_add(1, SeqCst);
            Ok(self.complete.lock().expect("complete").clone())
        }
    }

    /// A purge that can be flipped to fail, counting every call.
    #[derive(Clone)]
    struct FakePurge {
        calls: Arc<AtomicUsize>,
        fail: Arc<Mutex<bool>>,
    }

    impl FakePurge {
        fn new(fail: bool) -> Self {
            Self {
                calls: Arc::new(AtomicUsize::new(0)),
                fail: Arc::new(Mutex::new(fail)),
            }
        }

        fn set_fail(&self, fail: bool) {
            *self.fail.lock().expect("fail") = fail;
        }
    }

    impl AgentQuiescePurge for FakePurge {
        async fn quiesce_and_purge(
            &self,
            _host: &HostId,
            _agent: &AgentId,
        ) -> Result<(), QuiescePurgeFailure> {
            self.calls.fetch_add(1, SeqCst);
            if *self.fail.lock().expect("fail") {
                return Err(QuiescePurgeFailure::from_source(io::Error::other(
                    "daemon detached",
                )));
            }
            Ok(())
        }
    }

    #[derive(Clone, Default)]
    struct FakeResidue {
        announced: Arc<AtomicUsize>,
    }

    impl AgentDeletionResidue for FakeResidue {
        async fn agent_deleted(&self, _agent: &AgentId) -> Result<(), CustodyEffectFailure> {
            self.announced.fetch_add(1, SeqCst);
            Ok(())
        }

        async fn forget_stored_blob(
            &self,
            _blob: &StoredBlobRef,
        ) -> Result<(), CustodyEffectFailure> {
            Ok(())
        }
    }

    /// A settable view of which connection currently owns each host.
    #[derive(Clone, Default)]
    struct FakeConnections {
        generations: Arc<Mutex<HashMap<String, String>>>,
    }

    impl FakeConnections {
        fn attach(&self, host_id: &str, connection_id: &str) {
            self.generations
                .lock()
                .expect("generations")
                .insert(host_id.to_owned(), connection_id.to_owned());
        }
    }

    impl HostConnections for FakeConnections {
        fn current_generation(&self, host: &HostId) -> Option<String> {
            self.generations
                .lock()
                .expect("generations")
                .get(host.as_str())
                .cloned()
        }
    }

    struct Harness {
        resumer: AgentDeletionResumer<FakeLifecycle, FakePurge, FakeResidue, FakeConnections>,
        lifecycle: FakeLifecycle,
        purge: FakePurge,
        connections: FakeConnections,
    }

    fn build(
        pending: Vec<PersistedDeletionIntent>,
        complete: CompleteDeletion,
        fail: bool,
    ) -> Harness {
        let lifecycle = FakeLifecycle::new(pending, complete);
        let purge = FakePurge::new(fail);
        let connections = FakeConnections::default();
        let resumer = AgentDeletionResumer::with_retry_delays(
            lifecycle.clone(),
            purge.clone(),
            FakeResidue::default(),
            connections.clone(),
            vec![
                Duration::from_millis(1_000),
                Duration::from_millis(5_000),
                Duration::from_millis(30_000),
            ],
        );
        Harness {
            resumer,
            lifecycle,
            purge,
            connections,
        }
    }

    /// Lets every runnable task drain. No wall-clock time is involved.
    async fn settle() {
        for _ in 0..16 {
            tokio::task::yield_now().await;
        }
    }

    /// Mint the durable attempt the only way one can be minted: from a marker the port
    /// produced for this exact agent.
    async fn attempt(lifecycle: &FakeLifecycle, agent_id: &str) -> AgentDeletionAttempt {
        let BeginDeletion::Started(attempt) = begin_agent_deletion(lifecycle, &agent(agent_id), 5)
            .await
            .expect("begin")
        else {
            panic!("expected a started attempt");
        };
        attempt
    }

    #[tokio::test(start_paused = true)]
    async fn recover_drives_a_pending_marker_on_a_connected_host() {
        let h = build(vec![intent("a1", "h1", 5)], CompleteDeletion::Gone, false);
        h.connections.attach("h1", "conn-1");

        h.resumer.recover().await.expect("recover");
        settle().await;

        assert_eq!(h.purge.calls.load(SeqCst), 1);
        assert_eq!(h.lifecycle.completes.load(SeqCst), 1);
    }

    #[tokio::test(start_paused = true)]
    async fn a_pending_marker_on_a_detached_host_waits_for_ready() {
        let h = build(vec![intent("a1", "h1", 5)], CompleteDeletion::Gone, false);
        // No connection for h1 yet.
        h.resumer.recover().await.expect("recover");
        settle().await;
        assert_eq!(
            h.purge.calls.load(SeqCst),
            0,
            "a detached host does no daemon IO"
        );

        // The host attaches; now the marker is driven.
        h.connections.attach("h1", "conn-1");
        h.resumer.on_host_ready(&host("h1"), "conn-1");
        settle().await;

        assert_eq!(h.purge.calls.load(SeqCst), 1);
        assert_eq!(h.lifecycle.completes.load(SeqCst), 1);
    }

    #[tokio::test(start_paused = true)]
    async fn a_failed_purge_never_reaches_the_commit_and_arms_the_ladder() {
        let h = build(vec![], CompleteDeletion::Gone, true);
        h.connections.attach("h1", "conn-1");
        let attempt = attempt(&h.lifecycle, "a1").await;

        let outcome = h.resumer.try_now(attempt).await;

        assert_eq!(outcome, DeletionRunOutcome::Retained);
        assert_eq!(h.purge.calls.load(SeqCst), 1);
        assert_eq!(
            h.lifecycle.completes.load(SeqCst),
            0,
            "the fence never opened, so the durable delete must not commit"
        );
    }

    #[tokio::test(start_paused = true)]
    async fn the_retry_ladder_walks_one_five_thirty_then_stops() {
        let h = build(vec![], CompleteDeletion::Gone, true);
        h.connections.attach("h1", "conn-1");
        let attempt = attempt(&h.lifecycle, "a1").await;

        // Immediate request attempt.
        assert_eq!(
            h.resumer.try_now(attempt).await,
            DeletionRunOutcome::Retained
        );
        assert_eq!(h.purge.calls.load(SeqCst), 1);

        // Let the first armed timer register its sleep before the clock moves.
        settle().await;
        for (advance_ms, expected_calls) in [(999, 1), (1, 2), (5_000, 3), (30_000, 4)] {
            tokio::time::advance(Duration::from_millis(advance_ms)).await;
            settle().await;
            assert_eq!(h.purge.calls.load(SeqCst), expected_calls);
        }

        // Ladder exhausted: further time triggers nothing until a reconnect.
        tokio::time::advance(Duration::from_secs(300)).await;
        settle().await;
        assert_eq!(h.purge.calls.load(SeqCst), 4);
    }

    #[tokio::test(start_paused = true)]
    async fn a_reconnect_restarts_a_stalled_ladder() {
        let h = build(vec![], CompleteDeletion::Gone, true);
        h.connections.attach("h1", "conn-1");
        let attempt = attempt(&h.lifecycle, "a1").await;
        h.resumer.try_now(attempt).await;
        assert_eq!(h.purge.calls.load(SeqCst), 1);

        // The daemon reconnects on a new generation: the old scheduled retry is
        // superseded and the new generation takes a fresh immediate attempt.
        h.connections.attach("h1", "conn-2");
        h.resumer.on_host_ready(&host("h1"), "conn-2");
        settle().await;
        assert_eq!(h.purge.calls.load(SeqCst), 2);

        // The superseded conn-1 timer must not also fire when its old delay elapses.
        tokio::time::advance(Duration::from_millis(1_000)).await;
        settle().await;
        // Only conn-2's fresh ladder step fired.
        assert_eq!(h.purge.calls.load(SeqCst), 3);
    }

    #[tokio::test(start_paused = true)]
    async fn a_duplicate_trigger_coalesces_into_the_running_attempt() {
        let h = build(vec![], CompleteDeletion::Gone, false);
        h.connections.attach("h1", "conn-1");
        let attempt = attempt(&h.lifecycle, "a1").await;

        // Two ready signals plus a request all name the same agent; only one commit runs.
        h.resumer.on_host_ready(&host("h1"), "conn-1");
        let outcome = h.resumer.try_now(attempt).await;
        h.resumer.on_host_ready(&host("h1"), "conn-1");
        settle().await;

        assert!(matches!(
            outcome,
            DeletionRunOutcome::Completed | DeletionRunOutcome::AlreadyRunning
        ));
        assert_eq!(
            h.lifecycle.completes.load(SeqCst),
            1,
            "the per-agent single-flight admits exactly one commit"
        );
    }

    #[tokio::test(start_paused = true)]
    async fn a_lost_attempt_is_dropped_not_retried() {
        let h = build(vec![], CompleteDeletion::AttemptLost, false);
        h.connections.attach("h1", "conn-1");
        let attempt = attempt(&h.lifecycle, "a1").await;

        let outcome = h.resumer.try_now(attempt).await;
        assert_eq!(outcome, DeletionRunOutcome::Superseded);

        // No retry is armed for a superseded token.
        tokio::time::advance(Duration::from_secs(300)).await;
        settle().await;
        assert_eq!(h.purge.calls.load(SeqCst), 1);
        assert_eq!(h.lifecycle.completes.load(SeqCst), 1);
    }

    #[tokio::test(start_paused = true)]
    async fn a_committed_marker_runs_the_terminal_announcement() {
        let h = build(vec![], torn_down("a1", "h1"), false);
        h.connections.attach("h1", "conn-1");
        let residue_announced = {
            // Rebuild with a residue we can observe.
            let residue = FakeResidue::default();
            let resumer = AgentDeletionResumer::with_retry_delays(
                h.lifecycle.clone(),
                h.purge.clone(),
                residue.clone(),
                h.connections.clone(),
                vec![Duration::from_millis(1_000)],
            );
            let attempt = attempt(&h.lifecycle, "a1").await;
            assert_eq!(
                resumer.try_now(attempt).await,
                DeletionRunOutcome::Completed
            );
            residue.announced.load(SeqCst)
        };
        assert_eq!(residue_announced, 1);
    }

    #[tokio::test(start_paused = true)]
    async fn close_stops_the_ladder_and_refuses_new_work() {
        let h = build(vec![], CompleteDeletion::Gone, true);
        h.connections.attach("h1", "conn-1");
        let attempt = attempt(&h.lifecycle, "a1").await;
        h.resumer.try_now(attempt.clone()).await;
        assert_eq!(h.purge.calls.load(SeqCst), 1);

        h.resumer.close();

        // The armed retry never fires after close.
        tokio::time::advance(Duration::from_secs(300)).await;
        settle().await;
        assert_eq!(h.purge.calls.load(SeqCst), 1);

        // And a fresh request is refused.
        assert_eq!(h.resumer.try_now(attempt).await, DeletionRunOutcome::Closed);
    }

    #[tokio::test(start_paused = true)]
    async fn a_transient_completion_fault_recovers_when_the_next_attempt_succeeds() {
        let h = build(vec![], CompleteDeletion::Gone, false);
        h.connections.attach("h1", "conn-1");
        let attempt = attempt(&h.lifecycle, "a1").await;

        // First purge fails → retry armed; then the fault clears and the ladder step
        // completes it.
        h.purge.set_fail(true);
        assert_eq!(
            h.resumer.try_now(attempt).await,
            DeletionRunOutcome::Retained
        );
        assert_eq!(h.lifecycle.completes.load(SeqCst), 0);

        // Let the armed timer register its sleep before the clock moves.
        settle().await;
        h.purge.set_fail(false);
        tokio::time::advance(Duration::from_millis(1_000)).await;
        settle().await;
        assert_eq!(h.lifecycle.completes.load(SeqCst), 1);
    }
}
