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
//! ## What a generation is, and why the fence is bound to one
//!
//! An attempt can only make progress against the daemon connection that currently owns
//! the agent's host: the purge fences that live transport. A *generation* is one such
//! connection id. The scheduler never dials a generation itself; it asks
//! [`DeletionFenceBinder::bind`] for a fence pinned to the exact generation it means to
//! run against. That fence verifies its generation again AT SEND, so a same-instance
//! daemon replacement (a new generation on the same host) can never receive an older
//! chain's purge — the durable delete stays structurally unreachable behind a fence ack
//! for the generation that is actually live.
//!
//! When a daemon reconnects it gets a fresh id, so a retry chain bound to the old
//! generation is superseded. The retry ladder (`[1s, 5s, 30s]`) is per generation: a
//! fresh connection starts the ladder over, because a reconnect is new evidence that a
//! transient fault may now clear.
//!
//! ## Coalescing owes a re-drive; terminal cleanup dispatches by token identity
//!
//! A trigger that arrives while an agent's attempt is already in flight cannot simply be
//! dropped: the newer trigger may carry a newer marker (a re-created agent deleted
//! again, whose `deletion_started_at` differs), or the live generation may have moved on.
//! So a coalesced trigger records an ephemeral per-agent `rerun` bit and the single
//! owner re-drives once more before releasing — there is never a second concurrent runner
//! for one agent. Symmetrically, terminal cleanup compares the FULL attempt identity
//! (agent + host + `deletion_started_at`): a `Superseded`/`Faulted`/`Deleted` arm clears
//! the pending entry only when it still holds the exact token that just ran, so a
//! concurrently-written newer token is driven, never clobbered.
//!
//! Full-token identity governs dispatch, not just cleanup: when a re-drive switches to a
//! superseding token, the host migrates with it. Every iteration derives its host from the
//! token it is about to run and binds a fence on THAT host's generation, so a re-created
//! agent whose new marker names a different computer is purged there — never on the host a
//! prior attempt happened to run against.
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
    application_orchestration::teardown::{
        agent_delete_resume::{
            AgentDeletionFence, AgentDeletionResidue, ResidueFault, ResumeOutcome, RetryReason,
            resume_agent_deletion,
        },
        intent::{AgentDeletionAttempt, AgentDeletionLifecyclePort, pending_agent_deletions},
    },
    foundation::identity::{AgentId, HostId},
    foundation::persistence::PersistenceFailure,
};
use tokio::task::JoinHandle;

use crate::foundation::error;

/// Binds a purge fence to the daemon connection generation that owns a host, and reports
/// the live generation id for the scheduler's book-keeping.
///
/// [`bind`](Self::bind) returns a fence ONLY while `connection_id` is still the live
/// generation for `host`; a `None` means that generation has already been superseded, so
/// the caller re-drives on the current one. The minted fence captures the generation as a
/// transport capability and verifies it again at send, so nothing the scheduler holds can
/// route a purge to a replacement. [`current_generation`](Self::current_generation) is a
/// pure comparison value — the scheduler uses it to bind chains and notice reconnects,
/// never to dial — so this port carries no command channel a caller could grow a second
/// transport out of.
pub trait DeletionFenceBinder: Clone + Send + Sync + 'static {
    type Fence: AgentDeletionFence;

    fn bind(&self, host: &HostId, connection_id: &str) -> Option<Self::Fence>;

    fn current_generation(&self, host: &HostId) -> Option<String>;
}

/// The push seam the daemon attach edge drives: a host's daemon has been promoted to
/// custody on `connection_id`, so any durable deletion marker for that host can now be
/// fenced against a live generation. This is the ONLY way an attach reaches deletion
/// recovery — the [`DeletionFenceBinder`] is a pure pull/compare port that dials nothing,
/// so the resumer cannot discover an attach on its own and MUST be told here.
///
/// Object-safe on purpose: the daemon router holds it as `Arc<dyn HostReadyObserver>`, a
/// REQUIRED construction input. A composition that forgets to wire it does not type-check
/// — there is no `Option`, no setter, and no no-op default that could let an attach seal
/// while recovery silently never runs.
pub trait HostReadyObserver: Send + Sync + 'static {
    fn host_ready(&self, host: &HostId, connection_id: &str);
}

impl<L, B, R> HostReadyObserver for AgentDeletionResumer<L, B, R>
where
    L: AgentDeletionLifecyclePort,
    B: DeletionFenceBinder,
    R: AgentDeletionResidue,
{
    fn host_ready(&self, host: &HostId, connection_id: &str) {
        self.on_host_ready(host, connection_id);
    }
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
    /// An attempt for this agent is already in flight; this trigger coalesced into it and
    /// left the running owner a re-drive to honor before it releases.
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
    /// Agents whose in-flight owner owes one more re-drive because a trigger coalesced
    /// while it ran. Ephemeral, never durable: it only exists to keep a coalesced trigger
    /// from being silently lost.
    rerun: HashSet<AgentId>,
    /// The live retry generation per host.
    generations: HashMap<HostId, Generation>,
}

/// The scheduler's decision for one single-flight iteration, computed under the lock.
enum FlightStep {
    /// Keep the single-flight lock and drive this token on this generation next.
    Redrive {
        attempt: AgentDeletionAttempt,
        connection_id: String,
    },
    /// Release the lock and arm the host's retry ladder.
    ArmLadder,
    /// Release the lock and finish with this outcome.
    Release(DeletionRunOutcome),
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

    /// The live connection id currently owning `host`, as this worker's book-keeping sees
    /// it.
    fn current_connection(&self, host: &HostId) -> Option<String> {
        self.generations
            .get(host)
            .map(|generation| generation.connection_id.clone())
    }

    /// Decide the next single-flight step for `ran` (driven on `ran_conn`) from its
    /// classified `outcome`, mutating the pending/rerun/in_flight book-keeping.
    ///
    /// A coalesced re-drive owed for this agent is consumed here. Every terminal arm is
    /// identity-guarded: it touches the pending entry ONLY when the map still holds the
    /// exact token that ran, so a concurrently-written newer token is driven instead of
    /// dropped. Releasing arms free the single-flight slot; a redrive keeps it.
    ///
    /// A re-drive resolves its generation from the host of the token it will run, not
    /// from `ran`'s: a superseding token can name a DIFFERENT computer, and driving it on
    /// `ran`'s host would fence and purge on the wrong daemon. Only the same-token owed
    /// re-drive and the ladder decision use `ran`'s own generation.
    fn next_flight_step(
        &mut self,
        agent: &AgentId,
        ran: &AgentDeletionAttempt,
        ran_conn: &str,
        outcome: &ResumeOutcome,
    ) -> FlightStep {
        let owed = self.rerun.remove(agent);
        let pending = self.pending.get(agent).cloned();
        let pending_is_ran = pending.as_ref() == Some(ran);
        // The live generation of `ran`'s own host — for same-token decisions and the ladder.
        let ran_gen = self.current_connection(ran.host_id());
        // The live generation of the freshest pending token's host, which may be a
        // different computer than `ran`'s: its re-drive must fence THAT host's generation.
        let next_gen = pending
            .as_ref()
            .and_then(|next| self.current_connection(next.host_id()));

        match outcome {
            ResumeOutcome::Deleted { .. } | ResumeOutcome::Faulted(_) => {
                let release = if matches!(outcome, ResumeOutcome::Faulted(_)) {
                    DeletionRunOutcome::Faulted
                } else {
                    DeletionRunOutcome::Completed
                };
                if pending_is_ran {
                    // This token's row is resolved and it is still the one in memory: the
                    // agent is done, clear everything.
                    self.pending.remove(agent);
                    self.rerun.remove(agent);
                    self.in_flight.remove(agent);
                    FlightStep::Release(release)
                } else if let (Some(next), Some(cur)) = (pending, next_gen) {
                    // A newer token was written while this one ran; drive it on its own
                    // host's generation rather than leaving it un-woken.
                    FlightStep::Redrive {
                        attempt: next,
                        connection_id: cur,
                    }
                } else {
                    self.in_flight.remove(agent);
                    FlightStep::Release(release)
                }
            }
            ResumeOutcome::Superseded => match (pending, next_gen) {
                // Our token lost the marker to a newer one. NEVER clear by agent id: drive
                // the newer token on ITS host's live generation, or wait for it if that
                // host is currently detached.
                (Some(next), maybe_cur) if &next != ran => match maybe_cur {
                    Some(cur) => FlightStep::Redrive {
                        attempt: next,
                        connection_id: cur,
                    },
                    None => {
                        self.in_flight.remove(agent);
                        FlightStep::Release(DeletionRunOutcome::Retained)
                    }
                },
                // Only our now-dead token is in memory: drop just it and stop. A genuinely
                // still-pending agent re-enters via `list_pending` or a fresh request.
                (Some(_), _) => {
                    self.pending.remove(agent);
                    self.in_flight.remove(agent);
                    FlightStep::Release(DeletionRunOutcome::Superseded)
                }
                (None, _) => {
                    self.in_flight.remove(agent);
                    FlightStep::Release(DeletionRunOutcome::Superseded)
                }
            },
            ResumeOutcome::Retry(_) => match pending {
                // A newer token is owed: drive it on ITS host's live generation now, or
                // retain it if that host has detached.
                Some(next) if &next != ran => match next_gen {
                    Some(cur) => FlightStep::Redrive {
                        attempt: next,
                        connection_id: cur,
                    },
                    None => {
                        self.in_flight.remove(agent);
                        FlightStep::Release(DeletionRunOutcome::Retained)
                    }
                },
                // Same token, but a coalesced re-drive is owed on a generation this attempt
                // has not run against yet: re-drive immediately rather than after a delay.
                Some(_) if owed && ran_gen.as_deref().is_some_and(|cur| cur != ran_conn) => {
                    FlightStep::Redrive {
                        attempt: ran.clone(),
                        connection_id: ran_gen.expect("ran_gen is Some in this arm"),
                    }
                }
                // Transient on `ran`'s current generation: back off along its ladder.
                Some(_) if ran_gen.is_some() => {
                    self.in_flight.remove(agent);
                    FlightStep::ArmLadder
                }
                // The host detached; retain the marker and wait for it to reattach.
                _ => {
                    self.in_flight.remove(agent);
                    FlightStep::Release(DeletionRunOutcome::Retained)
                }
            },
        }
    }
}

/// A durable-deletion worker. Cloning shares the one tracked state behind `Arc`; the
/// dependencies are cheap handles onto shared authorities, never second roots.
pub struct AgentDeletionResumer<L, B, R> {
    tracked: Arc<Mutex<Tracked>>,
    lifecycle: L,
    binder: B,
    residue: R,
    retry_delays: Arc<[Duration]>,
}

impl<L, B, R> Clone for AgentDeletionResumer<L, B, R>
where
    L: Clone,
    B: Clone,
    R: Clone,
{
    fn clone(&self) -> Self {
        Self {
            tracked: Arc::clone(&self.tracked),
            lifecycle: self.lifecycle.clone(),
            binder: self.binder.clone(),
            residue: self.residue.clone(),
            retry_delays: Arc::clone(&self.retry_delays),
        }
    }
}

impl<L, B, R> AgentDeletionResumer<L, B, R>
where
    L: AgentDeletionLifecyclePort,
    B: DeletionFenceBinder,
    R: AgentDeletionResidue,
{
    /// Assemble the worker over production authorities with the default retry ladder.
    pub fn new(lifecycle: L, binder: B, residue: R) -> Self {
        Self {
            tracked: Arc::new(Mutex::new(Tracked::default())),
            lifecycle,
            binder,
            residue,
            retry_delays: DEFAULT_RETRY_DELAYS_MS
                .into_iter()
                .map(Duration::from_millis)
                .collect(),
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
            if let Some(connection_id) = self.binder.current_generation(&host) {
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
    /// this returns still resumes. The insert OVERWRITES any prior token for the agent, so
    /// a fresh request supersedes a stale in-flight token by identity, never the reverse.
    /// If the host is attached, the request resets that host's ladder to a fresh immediate
    /// attempt; if it is not, the marker simply waits for the host to attach.
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
        }
        let Some(connection_id) = self.binder.current_generation(&host) else {
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
        self.run_single_flight(&attempt, &connection_id).await
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
                || tracked
                    .generations
                    .get(&host)
                    .is_none_or(|generation| generation.connection_id != connection_id)
            {
                return;
            }
        }
        // The daemon may have been replaced between scheduling and waking; the live
        // registry is the authority on which connection owns the host now.
        if self.binder.current_generation(&host).as_deref() != Some(connection_id.as_str()) {
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
            self.run_single_flight(&attempt, &connection_id).await;
        }
    }

    /// Run one marker under the per-agent single-flight lock, re-driving in place while the
    /// book-keeping still owes work for it, then map the final classified outcome.
    ///
    /// A marker already in flight coalesces: it records an owed re-drive and returns
    /// immediately, so exactly one owner ever drives an agent and it honors the coalesced
    /// trigger before releasing. Each iteration derives its host from the token it is about
    /// to run — a re-drive may have switched to a token on a DIFFERENT computer — and binds
    /// a fresh fence on that host. A stale captured generation does not spin on the
    /// scheduler ledger: it asks the binder for the host's LIVE generation and re-drives
    /// there, or releases and waits for `on_host_ready` when the host has detached.
    async fn run_single_flight(
        &self,
        attempt: &AgentDeletionAttempt,
        connection_id: &str,
    ) -> DeletionRunOutcome {
        let agent = attempt.agent_id().clone();
        {
            let mut tracked = self.tracked.lock().expect("resumer state");
            if tracked.closed {
                return DeletionRunOutcome::Closed;
            }
            if !tracked.in_flight.insert(agent.clone()) {
                // Coalesce into the running owner and leave it a re-drive to honor.
                tracked.rerun.insert(agent.clone());
                return DeletionRunOutcome::AlreadyRunning;
            }
        }

        let mut ran = attempt.clone();
        let mut conn = connection_id.to_owned();

        loop {
            // The host follows the token every iteration: a re-drive that switched to a
            // superseding token on another computer must fence THAT host, never the one a
            // prior iteration ran against.
            let host = ran.host_id().clone();

            let Some(fence) = self.binder.bind(&host, &conn) else {
                // The generation we captured is no longer live. Consult the binder's LIVE
                // generation — never the scheduler ledger, which can lag a reconnect and
                // would busy-loop if fed back — for the freshest pending token's host.
                self.log_stale(&ran);
                let next = {
                    let mut tracked = self.tracked.lock().expect("resumer state");
                    if tracked.closed {
                        tracked.in_flight.remove(&agent);
                        return DeletionRunOutcome::Closed;
                    }
                    tracked.pending.get(&agent).cloned()
                };
                let Some(next) = next else {
                    // Nothing pending for this agent any more: release and let a durable
                    // marker, if any, be rediscovered on the next boot.
                    let mut tracked = self.tracked.lock().expect("resumer state");
                    tracked.in_flight.remove(&agent);
                    return DeletionRunOutcome::Retained;
                };
                match self.binder.current_generation(next.host_id()) {
                    Some(live) => {
                        let mut tracked = self.tracked.lock().expect("resumer state");
                        if tracked.closed {
                            tracked.in_flight.remove(&agent);
                            return DeletionRunOutcome::Closed;
                        }
                        // Track the live generation so a later ladder step reasons about the
                        // same id, then re-drive the freshest token on it. This makes
                        // progress: the binder just reported this id live, so the next bind
                        // opens — never the stale conn we entered with.
                        tracked.adopt_generation(next.host_id(), &live);
                        ran = next;
                        conn = live;
                    }
                    None => {
                        // The freshest token's host is detached: keep the durable marker and
                        // let its `on_host_ready` drive it, rather than spinning.
                        let mut tracked = self.tracked.lock().expect("resumer state");
                        tracked.in_flight.remove(&agent);
                        return DeletionRunOutcome::Retained;
                    }
                }
                continue;
            };

            let outcome = resume_agent_deletion(&self.lifecycle, &fence, &self.residue, &ran).await;
            self.log_resolved(&ran, &outcome);

            let step = {
                let mut tracked = self.tracked.lock().expect("resumer state");
                if tracked.closed {
                    // Shutdown: release the slot and stop re-driving. The durable marker
                    // makes the dropped attempt safe to rediscover on the next boot.
                    tracked.in_flight.remove(&agent);
                    return DeletionRunOutcome::Closed;
                }
                tracked.next_flight_step(&agent, &ran, &conn, &outcome)
            };

            match step {
                FlightStep::Redrive {
                    attempt: next,
                    connection_id: next_conn,
                } => {
                    ran = next;
                    conn = next_conn;
                }
                FlightStep::ArmLadder => {
                    self.schedule_next_retry(&host);
                    return DeletionRunOutcome::Retained;
                }
                FlightStep::Release(outcome) => return outcome,
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
                host_id = crate::foundation::safe_log_field::safe_display(&(host.as_str())),
                connection_id = crate::foundation::safe_log_field::safe_display(&(connection_id)),
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

    /// Emit the log line for one resolved iteration's classified outcome.
    fn log_resolved(&self, attempt: &AgentDeletionAttempt, outcome: &ResumeOutcome) {
        match outcome {
            ResumeOutcome::Deleted { residue } => {
                self.log_completed(attempt, residue);
            }
            ResumeOutcome::Retry(reason) => {
                self.log_retry(attempt, reason);
            }
            ResumeOutcome::Superseded => {
                tracing::info!(
                    agent_id = crate::foundation::safe_log_field::safe_display(
                        &(attempt.agent_id().as_str())
                    ),
                    host_id = crate::foundation::safe_log_field::safe_display(
                        &(attempt.host_id().as_str())
                    ),
                    "agent deletion attempt superseded; the marker moved on, dropping this token"
                );
            }
            ResumeOutcome::Faulted(failure) => {
                tracing::error!(
                    agent_id = crate::foundation::safe_log_field::safe_display(
                        &(attempt.agent_id().as_str())
                    ),
                    host_id = crate::foundation::safe_log_field::safe_display(
                        &(attempt.host_id().as_str())
                    ),
                    error_chain = crate::foundation::safe_log_field::safe_display(
                        &(error::describe(failure))
                    ),
                    "agent deletion hit an internal contract fault; dropping the in-memory token, the durable marker stays for a later boot"
                );
            }
        }
    }

    /// Emit the log line when a captured generation was no longer live at bind time.
    fn log_stale(&self, attempt: &AgentDeletionAttempt) {
        tracing::info!(
            agent_id =
                crate::foundation::safe_log_field::safe_display(&(attempt.agent_id().as_str())),
            host_id =
                crate::foundation::safe_log_field::safe_display(&(attempt.host_id().as_str())),
            "agent deletion could not fence the captured daemon generation; it was superseded, re-driving on the live one or awaiting a reconnect"
        );
    }

    fn log_completed(&self, attempt: &AgentDeletionAttempt, residue: &[ResidueFault]) {
        for fault in residue {
            tracing::warn!(
                agent_id = crate::foundation::safe_log_field::safe_display(&(fault.agent.as_str())),
                effect = ?fault.effect,
                error_chain = crate::foundation::safe_log_field::safe_display(&(error::describe(&fault.failure))),
                "agent deletion committed but a post-commit effect failed; carried, never rolled back"
            );
        }
        tracing::info!(
            agent_id =
                crate::foundation::safe_log_field::safe_display(&(attempt.agent_id().as_str())),
            host_id =
                crate::foundation::safe_log_field::safe_display(&(attempt.host_id().as_str())),
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
            agent_id =
                crate::foundation::safe_log_field::safe_display(&(attempt.agent_id().as_str())),
            host_id =
                crate::foundation::safe_log_field::safe_display(&(attempt.host_id().as_str())),
            error_chain = crate::foundation::safe_log_field::safe_display(&(chain)),
            "agent deletion could not complete this attempt; retaining the durable marker and retrying"
        );
    }
}

#[cfg(test)]
mod tests {
    use std::{
        io,
        sync::atomic::{AtomicBool, AtomicUsize, Ordering::SeqCst},
    };

    use silverhand_backend_core::{
        application_orchestration::teardown::{
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
        host_runtime::aftermath::CustodyEffectFailure,
        identity_access::agent_lifecycle::MaterializationStatus,
    };
    use tokio::sync::Notify;

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

    /// A lifecycle port whose `list_pending` is configurable and whose `complete` answer
    /// can be pinned per `deletion_started_at`, so a test can make one token lose the
    /// marker (`AttemptLost`) while a newer one commits.
    #[derive(Clone)]
    struct FakeLifecycle {
        pending: Arc<Mutex<Vec<PersistedDeletionIntent>>>,
        complete: Arc<Mutex<CompleteDeletion>>,
        complete_by_started_at: Arc<Mutex<HashMap<i64, CompleteDeletion>>>,
        host_by_started_at: Arc<Mutex<HashMap<i64, HostId>>>,
        completes: Arc<AtomicUsize>,
    }

    impl FakeLifecycle {
        fn new(pending: Vec<PersistedDeletionIntent>, complete: CompleteDeletion) -> Self {
            Self {
                pending: Arc::new(Mutex::new(pending)),
                complete: Arc::new(Mutex::new(complete)),
                complete_by_started_at: Arc::new(Mutex::new(HashMap::new())),
                host_by_started_at: Arc::new(Mutex::new(HashMap::new())),
                completes: Arc::new(AtomicUsize::new(0)),
            }
        }

        fn pin_complete(&self, started_at: i64, outcome: CompleteDeletion) {
            self.complete_by_started_at
                .lock()
                .expect("overrides")
                .insert(started_at, outcome);
        }

        /// Mint the marker for `started_at` on `host_id` instead of the default `h1`, so a
        /// re-created agent's newer token can name a different computer.
        fn pin_host(&self, started_at: i64, host_id: HostId) {
            self.host_by_started_at
                .lock()
                .expect("host overrides")
                .insert(started_at, host_id);
        }
    }

    impl AgentDeletionLifecyclePort for FakeLifecycle {
        async fn begin(
            &self,
            agent_id: &AgentId,
            started_at: i64,
        ) -> Result<BeginDeletionRecord, PersistenceFailure> {
            let host_id = self
                .host_by_started_at
                .lock()
                .expect("host overrides")
                .get(&started_at)
                .cloned()
                .unwrap_or_else(|| host("h1"));
            Ok(BeginDeletionRecord::Started(PersistedDeletionIntent {
                agent_id: agent_id.clone(),
                host_id,
                deletion_started_at: started_at,
            }))
        }

        async fn list_pending(&self) -> Result<Vec<PersistedDeletionIntent>, PersistenceFailure> {
            Ok(self.pending.lock().expect("pending").clone())
        }

        async fn complete(
            &self,
            attempt: &AgentDeletionAttempt,
        ) -> Result<CompleteDeletion, TeardownFailure> {
            self.completes.fetch_add(1, SeqCst);
            if let Some(outcome) = self
                .complete_by_started_at
                .lock()
                .expect("overrides")
                .get(&attempt.deletion_started_at())
            {
                return Ok(outcome.clone());
            }
            Ok(self.complete.lock().expect("complete").clone())
        }
    }

    /// The one shared daemon fake: the live generation per host, the purge frames that
    /// actually reached a generation, and a one-shot gate a test can block the first purge
    /// on to interleave a concurrent trigger.
    #[derive(Clone, Default)]
    struct FakeDaemon {
        generations: Arc<Mutex<HashMap<String, String>>>,
        frames: Arc<Mutex<Vec<(String, String)>>>,
        attempts: Arc<AtomicUsize>,
        fail: Arc<AtomicBool>,
        gate: Arc<Notify>,
        gate_armed: Arc<AtomicBool>,
    }

    impl FakeDaemon {
        fn attach(&self, host_id: &str, connection_id: &str) {
            self.generations
                .lock()
                .expect("generations")
                .insert(host_id.to_owned(), connection_id.to_owned());
        }

        fn set_fail(&self, fail: bool) {
            self.fail.store(fail, SeqCst);
        }

        /// Block the next purge until [`release_gate`](Self::release_gate).
        fn arm_gate(&self) {
            self.gate_armed.store(true, SeqCst);
        }

        fn release_gate(&self) {
            self.gate.notify_waiters();
        }

        fn attempts(&self) -> usize {
            self.attempts.load(SeqCst)
        }

        fn frames_to(&self, connection_id: &str) -> usize {
            self.frames
                .lock()
                .expect("frames")
                .iter()
                .filter(|(conn, _)| conn == connection_id)
                .count()
        }

        fn live(&self, host_id: &str) -> Option<String> {
            self.generations
                .lock()
                .expect("generations")
                .get(host_id)
                .cloned()
        }
    }

    /// A fence pinned to the generation it was bound on. It verifies that generation is
    /// still live AT SEND — mirroring the production transport — so a frame lands only on
    /// the connection the fence captured, never on a replacement.
    #[derive(Clone)]
    struct FakeFence {
        daemon: FakeDaemon,
        host: String,
        connection_id: String,
    }

    impl AgentDeletionFence for FakeFence {
        async fn quiesce_and_purge(&self, agent: &AgentId) -> Result<(), QuiescePurgeFailure> {
            self.daemon.attempts.fetch_add(1, SeqCst);
            if self.daemon.gate_armed.swap(false, SeqCst) {
                self.daemon.gate.notified().await;
            }
            if self.daemon.fail.load(SeqCst) {
                return Err(QuiescePurgeFailure::from_source(io::Error::other(
                    "daemon detached",
                )));
            }
            if self.daemon.live(&self.host).as_deref() != Some(self.connection_id.as_str()) {
                return Err(QuiescePurgeFailure::from_source(io::Error::other(
                    "connection generation superseded before purge",
                )));
            }
            self.daemon
                .frames
                .lock()
                .expect("frames")
                .push((self.connection_id.clone(), agent.as_str().to_owned()));
            Ok(())
        }
    }

    /// Binds a fence only while the requested generation is still live, and reports the
    /// live generation for the scheduler's book-keeping.
    #[derive(Clone)]
    struct FakeBinder {
        daemon: FakeDaemon,
    }

    impl DeletionFenceBinder for FakeBinder {
        type Fence = FakeFence;

        fn bind(&self, host: &HostId, connection_id: &str) -> Option<FakeFence> {
            if self.daemon.live(host.as_str()).as_deref() == Some(connection_id) {
                Some(FakeFence {
                    daemon: self.daemon.clone(),
                    host: host.as_str().to_owned(),
                    connection_id: connection_id.to_owned(),
                })
            } else {
                None
            }
        }

        fn current_generation(&self, host: &HostId) -> Option<String> {
            self.daemon.live(host.as_str())
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

    struct Harness {
        resumer: AgentDeletionResumer<FakeLifecycle, FakeBinder, FakeResidue>,
        lifecycle: FakeLifecycle,
        daemon: FakeDaemon,
    }

    fn build(
        pending: Vec<PersistedDeletionIntent>,
        complete: CompleteDeletion,
        fail: bool,
    ) -> Harness {
        let lifecycle = FakeLifecycle::new(pending, complete);
        let daemon = FakeDaemon::default();
        daemon.set_fail(fail);
        let resumer = AgentDeletionResumer::new(
            lifecycle.clone(),
            FakeBinder {
                daemon: daemon.clone(),
            },
            FakeResidue::default(),
        );
        Harness {
            resumer,
            lifecycle,
            daemon,
        }
    }

    /// Lets every runnable task drain. No wall-clock time is involved.
    async fn settle() {
        for _ in 0..16 {
            tokio::task::yield_now().await;
        }
    }

    /// Mint the durable attempt the only way one can be minted: from a marker the port
    /// produced for this exact agent, at `started_at`.
    async fn attempt_at(
        lifecycle: &FakeLifecycle,
        agent_id: &str,
        started_at: i64,
    ) -> AgentDeletionAttempt {
        let BeginDeletion::Started(attempt) =
            begin_agent_deletion(lifecycle, &agent(agent_id), started_at)
                .await
                .expect("begin")
        else {
            panic!("expected a started attempt");
        };
        attempt
    }

    async fn attempt(lifecycle: &FakeLifecycle, agent_id: &str) -> AgentDeletionAttempt {
        attempt_at(lifecycle, agent_id, 5).await
    }

    #[tokio::test(start_paused = true)]
    async fn recover_drives_a_pending_marker_on_a_connected_host() {
        let h = build(vec![intent("a1", "h1", 5)], CompleteDeletion::Gone, false);
        h.daemon.attach("h1", "conn-1");

        h.resumer.recover().await.expect("recover");
        settle().await;

        assert_eq!(h.daemon.attempts(), 1);
        assert_eq!(h.lifecycle.completes.load(SeqCst), 1);
    }

    #[tokio::test(start_paused = true)]
    async fn a_pending_marker_on_a_detached_host_waits_for_ready() {
        let h = build(vec![intent("a1", "h1", 5)], CompleteDeletion::Gone, false);
        // No connection for h1 yet.
        h.resumer.recover().await.expect("recover");
        settle().await;
        assert_eq!(h.daemon.attempts(), 0, "a detached host does no daemon IO");

        // The host attaches; now the marker is driven.
        h.daemon.attach("h1", "conn-1");
        h.resumer.on_host_ready(&host("h1"), "conn-1");
        settle().await;

        assert_eq!(h.daemon.attempts(), 1);
        assert_eq!(h.lifecycle.completes.load(SeqCst), 1);
    }

    #[tokio::test(start_paused = true)]
    async fn a_failed_purge_never_reaches_the_commit() {
        let h = build(vec![], CompleteDeletion::Gone, true);
        h.daemon.attach("h1", "conn-1");
        let attempt = attempt(&h.lifecycle, "a1").await;

        let outcome = h.resumer.try_now(attempt).await;

        assert_eq!(outcome, DeletionRunOutcome::Retained);
        assert_eq!(h.daemon.attempts(), 1);
        assert_eq!(
            h.lifecycle.completes.load(SeqCst),
            0,
            "the fence never opened, so the durable delete must not commit"
        );
    }

    #[tokio::test(start_paused = true)]
    async fn the_retry_ladder_walks_one_five_thirty_then_stops() {
        let h = build(vec![], CompleteDeletion::Gone, true);
        h.daemon.attach("h1", "conn-1");
        let attempt = attempt(&h.lifecycle, "a1").await;

        // Immediate request attempt.
        assert_eq!(
            h.resumer.try_now(attempt).await,
            DeletionRunOutcome::Retained
        );
        assert_eq!(h.daemon.attempts(), 1);

        // Let the first armed timer register its sleep before the clock moves.
        settle().await;
        for (advance_ms, expected_calls) in
            [(999, 1), (1, 2), (4_999, 2), (1, 3), (29_999, 3), (1, 4)]
        {
            tokio::time::advance(Duration::from_millis(advance_ms)).await;
            settle().await;
            assert_eq!(h.daemon.attempts(), expected_calls);
        }

        // Ladder exhausted: further time triggers nothing until a reconnect.
        tokio::time::advance(Duration::from_secs(300)).await;
        settle().await;
        assert_eq!(h.daemon.attempts(), 4);
    }

    #[tokio::test(start_paused = true)]
    async fn a_reconnect_restarts_a_stalled_ladder() {
        let h = build(vec![], CompleteDeletion::Gone, true);
        h.daemon.attach("h1", "conn-1");
        let attempt = attempt(&h.lifecycle, "a1").await;
        h.resumer.try_now(attempt).await;
        assert_eq!(h.daemon.attempts(), 1);

        // The daemon reconnects on a new generation: the old scheduled retry is superseded
        // and the new generation takes a fresh immediate attempt.
        h.daemon.attach("h1", "conn-2");
        h.resumer.on_host_ready(&host("h1"), "conn-2");
        settle().await;
        assert_eq!(h.daemon.attempts(), 2);

        // The superseded conn-1 timer must not also fire when its old delay elapses.
        tokio::time::advance(Duration::from_millis(1_000)).await;
        settle().await;
        // Only conn-2's fresh ladder step fired.
        assert_eq!(h.daemon.attempts(), 3);
    }

    #[tokio::test(start_paused = true)]
    async fn a_duplicate_trigger_coalesces_into_the_running_attempt() {
        let h = build(vec![], CompleteDeletion::Gone, false);
        h.daemon.attach("h1", "conn-1");
        let attempt = attempt(&h.lifecycle, "a1").await;

        // Hold the first purge so the duplicate is guaranteed to overlap its owner.
        h.daemon.arm_gate();
        let worker = h.resumer.clone();
        let first_attempt = attempt.clone();
        let first = tokio::spawn(async move { worker.try_now(first_attempt).await });
        settle().await;
        assert_eq!(h.daemon.attempts(), 1);
        assert_eq!(h.lifecycle.completes.load(SeqCst), 0);
        assert_eq!(
            h.resumer.try_now(attempt).await,
            DeletionRunOutcome::AlreadyRunning
        );
        h.resumer.on_host_ready(&host("h1"), "conn-1");
        settle().await;
        assert_eq!(
            h.daemon.attempts(),
            1,
            "no second purge while the first is held"
        );
        h.daemon.release_gate();
        assert_eq!(first.await.unwrap(), DeletionRunOutcome::Completed);
        assert_eq!(
            h.lifecycle.completes.load(SeqCst),
            1,
            "the per-agent single-flight admits exactly one commit"
        );
    }

    #[tokio::test(start_paused = true)]
    async fn a_lost_attempt_is_dropped_not_retried() {
        let h = build(vec![], CompleteDeletion::AttemptLost, false);
        h.daemon.attach("h1", "conn-1");
        let attempt = attempt(&h.lifecycle, "a1").await;

        let outcome = h.resumer.try_now(attempt).await;
        assert_eq!(outcome, DeletionRunOutcome::Superseded);

        // No retry is armed for a superseded token.
        tokio::time::advance(Duration::from_secs(300)).await;
        settle().await;
        assert_eq!(h.daemon.attempts(), 1);
        assert_eq!(h.lifecycle.completes.load(SeqCst), 1);
    }

    #[tokio::test(start_paused = true)]
    async fn a_committed_marker_runs_the_terminal_announcement() {
        let h = build(vec![], torn_down("a1", "h1"), false);
        h.daemon.attach("h1", "conn-1");
        let residue = FakeResidue::default();
        let resumer = AgentDeletionResumer::new(
            h.lifecycle.clone(),
            FakeBinder {
                daemon: h.daemon.clone(),
            },
            residue.clone(),
        );
        let attempt = attempt(&h.lifecycle, "a1").await;
        assert_eq!(
            resumer.try_now(attempt).await,
            DeletionRunOutcome::Completed
        );
        assert_eq!(residue.announced.load(SeqCst), 1);
    }

    #[tokio::test(start_paused = true)]
    async fn close_stops_the_ladder_and_refuses_new_work() {
        let h = build(vec![], CompleteDeletion::Gone, true);
        h.daemon.attach("h1", "conn-1");
        let attempt = attempt(&h.lifecycle, "a1").await;
        h.resumer.try_now(attempt.clone()).await;
        assert_eq!(h.daemon.attempts(), 1);

        h.resumer.close();

        // The armed retry never fires after close.
        tokio::time::advance(Duration::from_secs(300)).await;
        settle().await;
        assert_eq!(h.daemon.attempts(), 1);

        // And a fresh request is refused.
        assert_eq!(h.resumer.try_now(attempt).await, DeletionRunOutcome::Closed);
    }

    #[tokio::test(start_paused = true)]
    async fn a_transient_purge_fault_recovers_on_the_next_attempt() {
        let h = build(vec![], CompleteDeletion::Gone, false);
        h.daemon.attach("h1", "conn-1");
        let attempt = attempt(&h.lifecycle, "a1").await;

        // First purge fails → retry armed; then the fault clears and the ladder step
        // completes it.
        h.daemon.set_fail(true);
        assert_eq!(
            h.resumer.try_now(attempt).await,
            DeletionRunOutcome::Retained
        );
        assert_eq!(h.lifecycle.completes.load(SeqCst), 0);

        // Let the armed timer register its sleep before the clock moves.
        settle().await;
        h.daemon.set_fail(false);
        tokio::time::advance(Duration::from_millis(1_000)).await;
        settle().await;
        assert_eq!(h.lifecycle.completes.load(SeqCst), 1);
    }

    // α — a reconnect DURING an in-flight purge: the captured fence refuses at send
    // (verify-at-send stale) and the coalesced ready trigger is not lost. Without the
    // rerun bit the successor's trigger would be dropped as `AlreadyRunning` and the
    // marker would strand until a boot.
    #[tokio::test(start_paused = true)]
    async fn a_generation_change_mid_purge_redrives_on_the_live_generation() {
        let h = build(vec![], CompleteDeletion::Gone, false);
        h.daemon.attach("h1", "conn-1");
        let attempt = attempt(&h.lifecycle, "a1").await;

        // Block A's purge on conn-1 while it holds the single-flight lock.
        h.daemon.arm_gate();
        let worker = h.resumer.clone();
        let a = tokio::spawn(async move { worker.try_now(attempt).await });
        settle().await;

        // A new generation takes the host, and its ready signal coalesces into A.
        h.daemon.attach("h1", "conn-2");
        h.resumer.on_host_ready(&host("h1"), "conn-2");
        settle().await;

        // Release A: its conn-1 fence refuses at send, and the owed re-drive runs it on
        // conn-2 to completion — with no wall-clock time.
        h.daemon.release_gate();
        let outcome = a.await.expect("A task");

        assert_eq!(outcome, DeletionRunOutcome::Completed);
        assert_eq!(
            h.daemon.frames_to("conn-1"),
            0,
            "the stale generation gets no frame"
        );
        assert_eq!(h.daemon.frames_to("conn-2"), 1);
        assert_eq!(h.lifecycle.completes.load(SeqCst), 1);
    }

    // β — entering with a connection id that is already stale: bind returns None and the
    // loop re-drives on the live generation rather than committing against a dead one.
    #[tokio::test(start_paused = true)]
    async fn a_stale_bind_redrives_on_the_live_generation() {
        let h = build(vec![], CompleteDeletion::Gone, false);
        // conn-B is live; conn-A is already gone.
        h.daemon.attach("h1", "conn-B");
        let attempt = attempt(&h.lifecycle, "a1").await;

        // Seed the worker as if conn-B's generation and this marker were already tracked,
        // then drive the marker on the STALE conn-A.
        {
            let mut tracked = h.resumer.tracked.lock().expect("state");
            tracked.install_generation(&host("h1"), "conn-B");
            tracked.pending.insert(agent("a1"), attempt.clone());
        }
        let outcome = h.resumer.run_single_flight(&attempt, "conn-A").await;

        assert_eq!(outcome, DeletionRunOutcome::Completed);
        assert_eq!(h.daemon.frames_to("conn-A"), 0);
        assert_eq!(h.daemon.frames_to("conn-B"), 1);
        assert_eq!(h.lifecycle.completes.load(SeqCst), 1);
    }

    // γ — the terminal-identity discriminator. A is in flight; `try_now(B)` overwrites the
    // tracked pending token with a NEWER marker and coalesces. A then loses the marker
    // (`AttemptLost` → Superseded). A unified terminal clear-by-agent-id would delete B's
    // fresh token and strand it; the identity-guarded clear must instead drive B to
    // completion — with no boot, no reconnect and no third trigger.
    #[tokio::test(start_paused = true)]
    async fn a_superseding_token_written_mid_flight_is_driven_not_clobbered() {
        let h = build(vec![], CompleteDeletion::Gone, false);
        h.daemon.attach("h1", "conn-1");
        // A (started_at 5) loses the marker; B (started_at 9) commits.
        h.lifecycle.pin_complete(5, CompleteDeletion::AttemptLost);
        h.lifecycle.pin_complete(9, CompleteDeletion::Gone);
        let a_attempt = attempt_at(&h.lifecycle, "a1", 5).await;
        let b_attempt = attempt_at(&h.lifecycle, "a1", 9).await;

        // Block A's purge while it owns the single-flight lock.
        h.daemon.arm_gate();
        let worker = h.resumer.clone();
        let a = tokio::spawn(async move { worker.try_now(a_attempt).await });
        settle().await;

        // B's request overwrites the pending token and coalesces (no second runner).
        assert_eq!(
            h.resumer.try_now(b_attempt).await,
            DeletionRunOutcome::AlreadyRunning
        );

        // Release A: A is superseded, and the SAME owner drives B to completion.
        h.daemon.release_gate();
        let outcome = a.await.expect("A task");

        assert_eq!(outcome, DeletionRunOutcome::Completed);
        assert_eq!(
            h.daemon.frames_to("conn-1"),
            2,
            "both A and B purged on conn-1; B was not clobbered by A's terminal cleanup"
        );
        assert_eq!(
            h.lifecycle.completes.load(SeqCst),
            2,
            "A's lost completion and B's winning completion both ran"
        );
        assert!(
            h.resumer.tracked.lock().expect("state").pending.is_empty(),
            "B's committed token is cleared once it truly completes"
        );
    }

    // δ — the cross-host discriminator. A re-created agent's newer token names a DIFFERENT
    // computer. A is in flight on h1; `try_now(B)` overwrites the pending token with B on
    // h2 and coalesces. A then loses the marker (`AttemptLost` → Superseded). The owed
    // re-drive must run B on h2's own generation; a host-fixed loop would carry B's agent
    // back to h1 and purge the wrong daemon.
    #[tokio::test(start_paused = true)]
    async fn a_superseding_token_on_a_new_host_purges_only_its_own_host() {
        let h = build(vec![], CompleteDeletion::Gone, false);
        h.daemon.attach("h1", "conn-h1");
        h.daemon.attach("h2", "conn-h2");
        // A (started_at 5) lives on h1 and loses the marker; B (started_at 9) lives on h2
        // and commits.
        h.lifecycle.pin_host(5, host("h1"));
        h.lifecycle.pin_host(9, host("h2"));
        h.lifecycle.pin_complete(5, CompleteDeletion::AttemptLost);
        h.lifecycle.pin_complete(9, CompleteDeletion::Gone);
        let a_attempt = attempt_at(&h.lifecycle, "a1", 5).await;
        let b_attempt = attempt_at(&h.lifecycle, "a1", 9).await;
        assert_eq!(a_attempt.host_id().as_str(), "h1");
        assert_eq!(b_attempt.host_id().as_str(), "h2");

        // Block A's purge on h1 while it owns the single-flight lock.
        h.daemon.arm_gate();
        let worker = h.resumer.clone();
        let a = tokio::spawn(async move { worker.try_now(a_attempt).await });
        settle().await;

        // B's request (the re-created agent, now living on h2) overwrites the pending token
        // and coalesces (no second runner).
        assert_eq!(
            h.resumer.try_now(b_attempt).await,
            DeletionRunOutcome::AlreadyRunning
        );

        // Release A: A purges h1 and loses the marker, and the SAME owner drives B on h2 to
        // completion — no wall-clock time, no reconnect, no third trigger.
        h.daemon.release_gate();
        let outcome = a.await.expect("A task");

        assert_eq!(outcome, DeletionRunOutcome::Completed);
        assert_eq!(
            h.daemon.frames_to("conn-h1"),
            1,
            "only A purged h1; B was never carried to A's host"
        );
        assert_eq!(h.daemon.frames_to("conn-h2"), 1, "B purged its own host h2");
        assert_eq!(
            h.lifecycle.completes.load(SeqCst),
            2,
            "A's lost completion and B's winning completion both ran"
        );
    }

    // ε₁ — a stale bind consults the binder's LIVE generation, not the scheduler ledger.
    // The registry has already moved h1 to conn-B, but the ledger still holds conn-A
    // because no `on_host_ready(conn-B)` has updated it yet — a legal event window. Driving
    // on the stale conn-A must re-drive on the binder's live conn-B. Feeding the ledger's
    // conn-A back (bind None → ledger conn-A → bind None …) would busy-loop with no await.
    #[tokio::test(start_paused = true)]
    async fn a_stale_ledger_generation_redrives_on_binder_live_truth() {
        let h = build(vec![], CompleteDeletion::Gone, false);
        h.daemon.attach("h1", "conn-B");
        let attempt = attempt(&h.lifecycle, "a1").await;
        {
            let mut tracked = h.resumer.tracked.lock().expect("state");
            tracked.install_generation(&host("h1"), "conn-A");
            tracked.pending.insert(agent("a1"), attempt.clone());
        }

        let outcome = h.resumer.run_single_flight(&attempt, "conn-A").await;

        assert_eq!(outcome, DeletionRunOutcome::Completed);
        assert_eq!(
            h.daemon.frames_to("conn-A"),
            0,
            "the dead ledger id gets no frame"
        );
        assert_eq!(h.daemon.frames_to("conn-B"), 1);
        assert_eq!(h.lifecycle.completes.load(SeqCst), 1);
    }

    // ε₂ — a stale bind whose host has no live generation retains without spinning. The
    // ledger still holds a dead conn-A but the binder reports the host detached: the loop
    // must release the single-flight and wait for `on_host_ready`, never spin on conn-A.
    // Under paused time a busy-loop would hang the test; termination is the assertion.
    #[tokio::test(start_paused = true)]
    async fn a_stale_bind_with_a_detached_host_retains_without_spinning() {
        let h = build(vec![], CompleteDeletion::Gone, false);
        // No connection for h1: the binder's live generation is None.
        let attempt = attempt(&h.lifecycle, "a1").await;
        {
            let mut tracked = h.resumer.tracked.lock().expect("state");
            tracked.install_generation(&host("h1"), "conn-A");
            tracked.pending.insert(agent("a1"), attempt.clone());
        }

        let outcome = h.resumer.run_single_flight(&attempt, "conn-A").await;

        assert_eq!(outcome, DeletionRunOutcome::Retained);
        assert_eq!(h.daemon.attempts(), 0, "nothing was purged");
        assert_eq!(h.lifecycle.completes.load(SeqCst), 0);
        assert!(
            !h.resumer
                .tracked
                .lock()
                .expect("state")
                .in_flight
                .contains(&agent("a1")),
            "the single-flight slot is released for `on_host_ready` to re-drive"
        );
    }
}
