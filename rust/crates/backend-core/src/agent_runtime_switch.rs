//! The agent runtime-switch saga: change one agent's runtime driver without changing its
//! identity, losing a live session, or racing a delete.
//!
//! Switching drivers is a lifecycle transition, not a column edit. The old-runtime sessions
//! must be cleared before the `runtime` column moves, and nothing may spawn or deliver under
//! the agent while that window is open. This module orchestrates that window against narrow
//! typed ports; the durable half — the compare-and-set lock lifecycle and the committed-fact
//! seal — lives in [`crate::runtime_transition`] and is reused verbatim here.
//!
//! # Shape of the transition (mirrors the TypeScript `switchAgentRuntime`)
//!
//!  1. **Preflight** (no lock): the row exists, the target differs from the current runtime,
//!     the target is selectable, and a forced host catalog probe proves it is not
//!     deterministically absent. Availability is host-local truth — only a definite `absent`
//!     blocks; `present_unverified`/`unknown` defer to the daemon spawn last-line.
//!  2. **Acquire** the durable transition lock ([`begin_runtime_transition`]). A concurrent
//!     switch or an in-flight delete loses here, loudly, instead of interleaving.
//!  3. **Under the lock**: re-read the row (the preflight snapshot can go stale across the
//!     catalog round-trip), enumerate every live-or-resumable SEAT, return in-flight inbox
//!     claims to pending, and clear every old-runtime session. A single clear failure aborts
//!     the lock and leaves the runtime unchanged — no partial switch is ever committed.
//!  4. **Commit** the runtime + tuning in one guarded write ([`complete_runtime_transition`]),
//!     which also releases the lock. A `Lost` commit means another attempt owns the lock now.
//!  5. **Re-drive**: start the conversations that must resume under the new runtime. A restart
//!     failure is logged and counted by the caller — it NEVER rolls back the committed
//!     transition.
//!
//! # Why the saga calls the runtime-control provider directly
//!
//! The per-seat clear/start here are consequences of a transition the caller already
//! authorized (route edit-admission) and that the durable lock already fenced — not fresh
//! user actions. So the saga mints the sealed [`RuntimeSeatTarget`]/[`RuntimeStartTarget`]
//! from the SEAT FACTS it read (exactly the "internal seat-fact read for runtime-switch" the
//! target type documents) and invokes the provider directly, rather than re-running the
//! per-seat admission ladder the public clear/start endpoints use.

use std::future::Future;

use crate::{
    agents::{
        runtime::RuntimeKind, runtime_catalog::SELECTABLE_RUNTIMES,
        session_scope::AgentSessionScope,
    },
    identity::{AgentId, ConversationId, HostId, UserId},
    messaging::collaboration::{
        CliSessionId, RuntimeControlPort, RuntimeSeatTarget, RuntimeStartTarget,
    },
    persistence::PersistenceFailure,
    runtime_credential::RuntimeScope,
    runtime_event::RuntimeObservedStatus,
    runtime_transition::{
        AbortTransition, BeginTransition, CommittedRuntimeTransition, CompleteTransition,
        RuntimeTransitionCommit, RuntimeTransitionFault, RuntimeTransitionWrite,
        abort_runtime_transition, begin_runtime_transition, complete_runtime_transition,
    },
};

/// The validated runtime-switch request. Tuning legality (model/effort/fast-mode against the
/// target runtime) is the upstream admission schema's job, mirrored from the TypeScript
/// `SwitchAgentRuntimeInputSchema`; this value carries the already-validated tuning verbatim
/// to the commit.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SwitchAgentRuntimeConfig {
    pub runtime: RuntimeKind,
    pub model: Option<String>,
    pub reasoning_effort: Option<String>,
    pub fast_mode: Option<bool>,
}

impl SwitchAgentRuntimeConfig {
    fn commit(&self) -> RuntimeTransitionCommit {
        RuntimeTransitionCommit {
            model: self.model.clone(),
            reasoning_effort: self.reasoning_effort.clone(),
            fast_mode: self.fast_mode,
        }
    }
}

/// One agent + actor + the target runtime configuration.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SwitchAgentRuntimeRequest {
    pub agent: AgentId,
    pub actor: UserId,
    pub config: SwitchAgentRuntimeConfig,
}

/// The row facts and seat set the saga reads together, in ONE source-bound snapshot so a host
/// reassignment racing the request cannot split the host a restart dispatches to from the seat
/// set it was captured with (the same discipline as [`crate::agent_bulk_stop`]).
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SwitchAgentSnapshot {
    /// The id the row was read FROM — its own primary key. Bound against the requested agent so
    /// a snapshot resolved from the wrong row is a fault, never acted on.
    pub source: AgentId,
    /// The current (from) runtime, decoded from the row.
    pub runtime: RuntimeKind,
    pub session_scope: AgentSessionScope,
    pub host: HostId,
    pub seats: Vec<SwitchSeat>,
}

/// One runtime SEAT of the agent. Carries the raw observed status and the seat's CLI session so
/// the saga can decide — as a domain rule, not an adapter filter — whether the old runtime holds
/// anything behind this seat that must be cleared before the driver changes.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SwitchSeat {
    pub scope: RuntimeScope,
    pub status: RuntimeObservedStatus,
    pub cli_session_id: Option<CliSessionId>,
}

impl SwitchSeat {
    /// A seat still owns a live runtime child.
    fn is_live(&self) -> bool {
        matches!(
            self.status,
            RuntimeObservedStatus::Starting | RuntimeObservedStatus::Active
        )
    }

    /// Nothing running and nothing resumable — the old runtime holds no session behind this
    /// seat, so the transition has nothing to clear through it.
    fn holds_session(&self) -> bool {
        self.is_live() || self.cli_session_id.is_some()
    }
}

/// The single source-bound read the saga needs of the agent row and its seats. Used for both
/// the preflight read and the authoritative re-read under the lock.
pub trait SwitchAgentSnapshotRead: Clone + Send + Sync + 'static {
    fn read_switch_snapshot(
        &self,
        agent: &AgentId,
    ) -> impl Future<Output = Result<Option<SwitchAgentSnapshot>, PersistenceFailure>> + Send;
}

/// A forced host round-trip that answers only whether the target runtime is deterministically
/// absent on the agent's computer. The transport failure arms mirror the owning-host catalog
/// dispatch; the route maps each to its HTTP status.
pub trait RuntimeAvailabilityProbe: Clone + Send + Sync + 'static {
    fn probe_runtime_available(
        &self,
        host: &HostId,
        runtime: RuntimeKind,
    ) -> impl Future<Output = Result<RuntimeAvailabilityVerdict, RuntimeAvailabilityProbeFault>> + Send;
}

/// The only distinction the transition draws: a definite `Absent` blocks it; everything else
/// (`present` / `present_unverified` / `unknown`) defers to the daemon spawn last-line.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum RuntimeAvailabilityVerdict {
    Absent,
    AvailableOrUnknown,
}

/// A host catalog probe that could not produce a verdict. Each arm is the switch-domain view of
/// an owning-host data-plane failure; the route maps it to the same HTTP status the standalone
/// catalog route uses.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum RuntimeAvailabilityProbeFault {
    /// No daemon currently owns the host (or a replacement attached mid-flight).
    AttachPending,
    /// Dispatched but unacknowledged within the deadline.
    Timeout,
    /// The daemon answered with an internal error.
    DaemonInternalError,
    /// The daemon's response violated the catalog transport contract.
    TransportContractViolation,
}

/// Conversation-inbox coordination the saga needs across the transition window: reclaim
/// in-flight claims so the post-transition restart can redeliver, enumerate the pending
/// conversations to re-drive, and re-check a presentation focus against live participation.
///
/// `list_pending_for_agent` MUST return oldest-durable-pending first: the agent-scope restart
/// takes only its head.
pub trait SwitchConversationCoordination: Clone + Send + Sync + 'static {
    /// Return every in-flight claim held by this agent to pending, yielding the conversations
    /// reclaimed. A claim made before the lock is no longer valid custody; returning it lets the
    /// post-transition restart deliver under the target runtime.
    fn rollback_in_flight_for_agent(
        &self,
        agent: &AgentId,
    ) -> impl Future<Output = Result<Vec<ConversationId>, PersistenceFailure>> + Send;

    /// Every conversation with undelivered input for this agent, oldest durable pending first.
    fn list_pending_for_agent(
        &self,
        agent: &AgentId,
    ) -> impl Future<Output = Result<Vec<ConversationId>, PersistenceFailure>> + Send;

    /// Conversations that gained undelivered input at or after `since_ms` — the messages that
    /// arrived while this transition held the spawn gate.
    fn list_pending_for_agent_since(
        &self,
        agent: &AgentId,
        since_ms: i64,
    ) -> impl Future<Output = Result<Vec<ConversationId>, PersistenceFailure>> + Send;

    /// Whether the agent still participates in the conversation — the placement-aware authority,
    /// so a focus captured before clear is reused only while it remains a real binding.
    fn is_agent_participant(
        &self,
        conversation: &ConversationId,
        agent: &AgentId,
    ) -> impl Future<Output = Result<bool, PersistenceFailure>> + Send;
}

/// A committed runtime switch and the effect tallies the wire reports.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SwitchAgentRuntimeCommitted {
    /// The sealed committed transition — the authority for the new runtime + tuning. The route
    /// reprojects the agent DTO from the committed row.
    pub committed: CommittedRuntimeTransition,
    pub cleared_sessions: usize,
    pub restarted_conversations: usize,
    pub restart_failures: usize,
}

/// The product outcomes of a switch that did not commit. Ordering across simultaneously-true
/// conditions is deliberately NOT a migration contract (validator governance owns it); each arm
/// carries only its stable final semantics.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SwitchAgentRuntimeError {
    /// No such agent row (preflight or under-lock re-read).
    AgentNotFound,
    /// The agent already uses the requested runtime.
    RuntimeUnchanged,
    /// The requested runtime is not a user-selectable driver.
    RuntimeNotSelectable,
    /// The requested runtime is deterministically absent on the agent's computer.
    RuntimeNotInstalled,
    /// A transition lock is already held for this agent.
    TransitionInProgress,
    /// The agent is being deleted; a transition must not race teardown.
    DeletionInProgress,
    /// The guarded commit matched no row — another attempt owns the lock now.
    TransitionLost,
    /// At least one old-runtime session could not be cleared; the runtime was not changed.
    SessionClearFailed,
    /// The host catalog probe could not produce a verdict.
    Availability(RuntimeAvailabilityProbeFault),
    /// An internal invariant break — a persistence error or a lock-lifecycle witness fault. The
    /// boundary surfaces every arm as a safe `500`, never a product answer.
    Fault(SwitchAgentRuntimeFault),
}

/// The internal-fault payload behind [`SwitchAgentRuntimeError::Fault`].
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SwitchAgentRuntimeFault {
    /// A persistence read/write failed.
    Persistence,
    /// The snapshot resolved a row whose id is not the requested agent.
    SourceUntrustworthy,
    /// The lock-lifecycle write returned a witness that disagreed with the request.
    Transition,
}

impl From<PersistenceFailure> for SwitchAgentRuntimeError {
    fn from(_: PersistenceFailure) -> Self {
        Self::Fault(SwitchAgentRuntimeFault::Persistence)
    }
}

impl From<RuntimeTransitionFault> for SwitchAgentRuntimeError {
    fn from(fault: RuntimeTransitionFault) -> Self {
        match fault {
            RuntimeTransitionFault::Persistence(_) => {
                Self::Fault(SwitchAgentRuntimeFault::Persistence)
            }
            RuntimeTransitionFault::LockWitnessMismatch { .. }
            | RuntimeTransitionFault::CommitWitnessMismatch { .. } => {
                Self::Fault(SwitchAgentRuntimeFault::Transition)
            }
        }
    }
}

/// Transition one agent to another runtime. See the module docs for the phase shape and the
/// invariants each phase holds.
#[allow(clippy::too_many_arguments)]
pub async fn switch_agent_runtime<R, Avail, Coord, W, P>(
    reads: &R,
    availability: &Avail,
    coordination: &Coord,
    transitions: &W,
    control: &P,
    request: &SwitchAgentRuntimeRequest,
    now_ms: i64,
) -> Result<SwitchAgentRuntimeCommitted, SwitchAgentRuntimeError>
where
    R: SwitchAgentSnapshotRead,
    Avail: RuntimeAvailabilityProbe,
    Coord: SwitchConversationCoordination,
    W: RuntimeTransitionWrite,
    P: RuntimeControlPort,
{
    let agent = &request.agent;
    let target = request.config.runtime;

    // ── Preflight (no lock) ──────────────────────────────────────────────
    let preflight = load_snapshot(reads, agent).await?;
    reject_unchanged_or_unselectable(&preflight, target)?;

    match availability
        .probe_runtime_available(&preflight.host, target)
        .await
    {
        Ok(RuntimeAvailabilityVerdict::AvailableOrUnknown) => {}
        Ok(RuntimeAvailabilityVerdict::Absent) => {
            return Err(SwitchAgentRuntimeError::RuntimeNotInstalled);
        }
        Err(fault) => return Err(SwitchAgentRuntimeError::Availability(fault)),
    }

    // ── Acquire the durable lock ─────────────────────────────────────────
    let lock = match begin_runtime_transition(transitions, agent, target, now_ms).await? {
        BeginTransition::Started(lock) => lock,
        BeginTransition::NotFound => return Err(SwitchAgentRuntimeError::AgentNotFound),
        BeginTransition::InProgress => return Err(SwitchAgentRuntimeError::TransitionInProgress),
        BeginTransition::Deleting => return Err(SwitchAgentRuntimeError::DeletionInProgress),
    };

    // ── Under the lock: everything below either commits or unwinds via `abort_and_restore`. ──
    match run_locked(
        reads,
        coordination,
        transitions,
        control,
        request,
        now_ms,
        &lock,
    )
    .await
    {
        Ok(committed) => Ok(committed),
        Err(Unwound { error, restore }) => {
            // A committed transition already cleared the lock, so this abort is a target-guarded
            // no-op there; it only bites the pre-commit failure paths.
            if let Ok(AbortTransition::Released) =
                abort_runtime_transition(transitions, &lock).await
            {
                // Best effort: restore the previously-live pairs under the UNCHANGED old runtime.
                // The original failure remains the response; a later retry can finish the switch.
                for conversation in restore {
                    let restart =
                        RuntimeStartTarget::new(request.actor.clone(), agent.clone(), conversation);
                    let _ = control.start(&restart).await;
                }
            }
            Err(error)
        }
    }
}

/// The error carried out of the under-lock body: the product/fault answer plus the pairs to
/// restore under the old runtime if the abort still holds the lock.
struct Unwound {
    error: SwitchAgentRuntimeError,
    restore: Vec<ConversationId>,
}

impl From<SwitchAgentRuntimeError> for Unwound {
    /// A failure discovered before any seat was cleared has nothing to restore.
    fn from(error: SwitchAgentRuntimeError) -> Self {
        Self {
            error,
            restore: Vec::new(),
        }
    }
}

#[allow(clippy::too_many_arguments)]
async fn run_locked<R, Coord, W, P>(
    reads: &R,
    coordination: &Coord,
    transitions: &W,
    control: &P,
    request: &SwitchAgentRuntimeRequest,
    now_ms: i64,
    lock: &crate::runtime_transition::RuntimeTransitionLock,
) -> Result<SwitchAgentRuntimeCommitted, Unwound>
where
    R: SwitchAgentSnapshotRead,
    Coord: SwitchConversationCoordination,
    W: RuntimeTransitionWrite,
    P: RuntimeControlPort,
{
    let agent = &request.agent;
    let target = request.config.runtime;

    // Re-read under the lock: the preflight row can go stale across the catalog round-trip, so a
    // transition another request just committed to the same target must fail loudly here rather
    // than overwrite its tuning.
    let locked = load_snapshot(reads, agent).await?;
    reject_unchanged_or_unselectable(&locked, target).map_err(Unwound::from)?;

    // SEATS, not conversations: what must be cleared is every live-or-resumable SESSION, wherever
    // it sits. One row per seat, every placement — a DM or inbox session cannot be silently
    // excluded and switched out from under.
    let mut to_clear: Vec<RuntimeScope> = Vec::new();
    let mut live_before: Vec<ConversationId> = Vec::new();
    let mut agent_slot_was_live = false;
    for seat in &locked.seats {
        if !seat.holds_session() {
            continue;
        }
        match &seat.scope {
            RuntimeScope::AgentSlot { .. } => {
                agent_slot_was_live = seat.is_live();
            }
            RuntimeScope::ConversationSlot { source, .. } => {
                if seat.is_live() {
                    live_before.push(source.clone());
                }
            }
        }
        to_clear.push(seat.scope.clone());
    }

    // A claim made before the lock is no longer valid custody; returning it to pending lets the
    // post-transition restart deliver under the target runtime.
    let reclaimed = coordination
        .rollback_in_flight_for_agent(agent)
        .await
        .map_err(SwitchAgentRuntimeError::from)?;

    // Clear every old-runtime session. ALL are attempted (no short-circuit) so a stuck seat does
    // not hide behind an earlier failure; a single failure then aborts without committing.
    let mut clear_failed = false;
    let mut agent_focus: Option<ConversationId> = None;
    for scope in &to_clear {
        let seat_target = RuntimeSeatTarget::new(request.actor.clone(), scope.clone());
        match control.clear_session(&seat_target).await {
            Ok(Ok(outcome)) => {
                if matches!(scope, RuntimeScope::AgentSlot { .. }) && agent_focus.is_none() {
                    agent_focus = outcome.focus_conversation_id().cloned();
                }
            }
            Ok(Err(_refusal)) => clear_failed = true,
            Err(_transport) => clear_failed = true,
        }
    }
    if clear_failed {
        return Err(Unwound {
            error: SwitchAgentRuntimeError::SessionClearFailed,
            restore: restore_targets(
                locked.session_scope,
                agent_slot_was_live,
                &agent_focus,
                &live_before,
            ),
        });
    }

    // A focus captured before clear is only a presentation coordinate. Reuse it only while the
    // placement-aware participant authority still accepts it; never substitute another binding.
    let agent_resume_focus = match (locked.session_scope, &agent_focus) {
        (AgentSessionScope::Agent, Some(focus))
            if coordination
                .is_agent_participant(focus, agent)
                .await
                .map_err(SwitchAgentRuntimeError::from)? =>
        {
            Some(focus.clone())
        }
        _ => None,
    };

    // ── Commit the runtime + tuning and release the lock in one guarded write. ──
    let committed =
        match complete_runtime_transition(transitions, lock, &request.config.commit(), now_ms)
            .await
            .map_err(SwitchAgentRuntimeError::from)?
        {
            CompleteTransition::Committed(committed) => committed,
            CompleteTransition::Lost => {
                return Err(Unwound {
                    error: SwitchAgentRuntimeError::TransitionLost,
                    // The lock is no longer ours; the target-guarded abort will find nothing and no
                    // restore fires. Cleared sessions stay cleared for whoever owns the lock now.
                    restore: Vec::new(),
                });
            }
        };

    // ── Re-drive: start the conversations that must resume under the new runtime. ──
    let newly_pending = coordination
        .list_pending_for_agent_since(agent, now_ms)
        .await
        .map_err(SwitchAgentRuntimeError::from)?;
    let resume = resume_targets(
        coordination,
        agent,
        locked.session_scope,
        agent_slot_was_live,
        &reclaimed,
        &newly_pending,
        &live_before,
        agent_resume_focus,
    )
    .await
    .map_err(SwitchAgentRuntimeError::from)?;

    let mut restarted = 0usize;
    let mut restart_failures = 0usize;
    for conversation in resume {
        let restart = RuntimeStartTarget::new(request.actor.clone(), agent.clone(), conversation);
        match control.start(&restart).await {
            // A committed transition is NEVER rolled back by a restart failure — it is logged and
            // counted only. The AgentSlot ready-replay / inbox trigger will pick up the rest.
            Ok(Ok(_)) => restarted += 1,
            Ok(Err(_)) | Err(_) => restart_failures += 1,
        }
    }

    Ok(SwitchAgentRuntimeCommitted {
        committed,
        cleared_sessions: to_clear.len(),
        restarted_conversations: restarted,
        restart_failures,
    })
}

/// The pairs to restart under the OLD runtime when a pre-commit failure aborts the lock.
fn restore_targets(
    session_scope: AgentSessionScope,
    agent_slot_was_live: bool,
    agent_focus: &Option<ConversationId>,
    live_before: &[ConversationId],
) -> Vec<ConversationId> {
    match session_scope {
        AgentSessionScope::Agent => match (agent_slot_was_live, agent_focus) {
            (true, Some(focus)) => vec![focus.clone()],
            _ => Vec::new(),
        },
        AgentSessionScope::Conversation => live_before.to_vec(),
    }
}

/// The conversations to re-drive after a committed switch.
#[allow(clippy::too_many_arguments)]
async fn resume_targets<Coord: SwitchConversationCoordination>(
    coordination: &Coord,
    agent: &AgentId,
    session_scope: AgentSessionScope,
    agent_slot_was_live: bool,
    reclaimed: &[ConversationId],
    newly_pending: &[ConversationId],
    live_before: &[ConversationId],
    agent_resume_focus: Option<ConversationId>,
) -> Result<Vec<ConversationId>, PersistenceFailure> {
    match session_scope {
        AgentSessionScope::Agent => {
            // One AgentSlot gets one restart target. Origin is presentation only: prefer the
            // oldest durable pending origin, otherwise reuse the focus observed before clear.
            // Starting once is enough — AgentSlot ready-replay drains the rest in inbox order.
            let should_resume =
                agent_slot_was_live || !reclaimed.is_empty() || !newly_pending.is_empty();
            let oldest_pending = if should_resume {
                coordination
                    .list_pending_for_agent(agent)
                    .await?
                    .into_iter()
                    .next()
            } else {
                None
            };
            let target = oldest_pending.or(if should_resume {
                agent_resume_focus
            } else {
                None
            });
            Ok(target.into_iter().collect())
        }
        AgentSessionScope::Conversation => {
            // Restore live pairs and reclaimed claims, and nudge only messages that arrived while
            // this transition held the spawn gate — never turn historical backlog into a restart
            // herd. Deduped, insertion order preserved.
            let mut resume: Vec<ConversationId> = Vec::new();
            for conversation in live_before
                .iter()
                .chain(reclaimed.iter())
                .chain(newly_pending.iter())
            {
                if !resume.contains(conversation) {
                    resume.push(conversation.clone());
                }
            }
            Ok(resume)
        }
    }
}

/// Read a snapshot and bind its source to the requested agent. A snapshot whose row id is not the
/// requested agent is a fault, not a product answer.
async fn load_snapshot<R: SwitchAgentSnapshotRead>(
    reads: &R,
    agent: &AgentId,
) -> Result<SwitchAgentSnapshot, SwitchAgentRuntimeError> {
    let snapshot = reads
        .read_switch_snapshot(agent)
        .await?
        .ok_or(SwitchAgentRuntimeError::AgentNotFound)?;
    if &snapshot.source != agent {
        return Err(SwitchAgentRuntimeError::Fault(
            SwitchAgentRuntimeFault::SourceUntrustworthy,
        ));
    }
    Ok(snapshot)
}

/// The two row-level product refusals shared by the preflight and the under-lock re-read.
fn reject_unchanged_or_unselectable(
    snapshot: &SwitchAgentSnapshot,
    target: RuntimeKind,
) -> Result<(), SwitchAgentRuntimeError> {
    if snapshot.runtime == target {
        return Err(SwitchAgentRuntimeError::RuntimeUnchanged);
    }
    if !SELECTABLE_RUNTIMES.contains(&target) {
        return Err(SwitchAgentRuntimeError::RuntimeNotSelectable);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::{
        collections::VecDeque,
        sync::{Arc, Mutex},
    };

    use crate::{
        messaging::collaboration::{
            ClearSessionOutcome, ClearSessionProviderRefusal, RuntimePlacementRefusal,
            StartRuntimeOutcome, StartRuntimeProviderRefusal,
        },
        runtime_transition::{
            BeginTransitionRecord, CompleteTransitionRecord, RuntimeTransitionAfterImage,
            RuntimeTransitionLock, RuntimeTransitionLockRow,
        },
    };

    use super::*;

    // ── identity helpers ────────────────────────────────────────────────

    fn agent(id: &str) -> AgentId {
        AgentId::parse(id).expect("agent id")
    }
    fn user(id: &str) -> UserId {
        UserId::parse(id).expect("user id")
    }
    fn host(id: &str) -> HostId {
        HostId::parse(id).expect("host id")
    }
    fn conv(id: &str) -> ConversationId {
        ConversationId::parse(id).expect("conversation id")
    }
    fn cli(id: &str) -> CliSessionId {
        CliSessionId::parse(id).expect("cli session id")
    }

    const NOW: i64 = 1_000;
    const AGENT: &str = "agent-1";
    const ACTOR: &str = "user-1";
    const HOST: &str = "host-1";

    fn request(from: RuntimeKind, to: RuntimeKind) -> (SwitchAgentRuntimeRequest, RuntimeKind) {
        (
            SwitchAgentRuntimeRequest {
                agent: agent(AGENT),
                actor: user(ACTOR),
                config: SwitchAgentRuntimeConfig {
                    runtime: to,
                    model: Some("gpt".into()),
                    reasoning_effort: None,
                    fast_mode: None,
                },
            },
            from,
        )
    }

    fn conversation_seat(id: &str, status: RuntimeObservedStatus) -> SwitchSeat {
        SwitchSeat {
            scope: RuntimeScope::ConversationSlot {
                agent: agent(AGENT),
                source: conv(id),
            },
            status,
            cli_session_id: Some(cli(id)),
        }
    }

    fn agent_seat(status: RuntimeObservedStatus, resumable: bool) -> SwitchSeat {
        SwitchSeat {
            scope: RuntimeScope::AgentSlot {
                agent: agent(AGENT),
            },
            status,
            cli_session_id: resumable.then(|| cli("agent-seat")),
        }
    }

    fn snapshot(
        from: RuntimeKind,
        scope: AgentSessionScope,
        seats: Vec<SwitchSeat>,
    ) -> SwitchAgentSnapshot {
        SwitchAgentSnapshot {
            source: agent(AGENT),
            runtime: from,
            session_scope: scope,
            host: host(HOST),
            seats,
        }
    }

    // ── snapshot read fake: a queue consumed preflight-then-locked ───────

    type ScriptedSnapshot = Result<Option<SwitchAgentSnapshot>, PersistenceFailure>;

    #[derive(Clone)]
    struct SnapshotReads {
        queued: Arc<Mutex<VecDeque<ScriptedSnapshot>>>,
        calls: Arc<Mutex<usize>>,
    }

    impl SnapshotReads {
        /// Same snapshot answered for both the preflight and the under-lock re-read.
        fn stable(snapshot: SwitchAgentSnapshot) -> Self {
            Self::scripted(vec![Ok(Some(snapshot.clone())), Ok(Some(snapshot))])
        }
        fn scripted(answers: Vec<ScriptedSnapshot>) -> Self {
            Self {
                queued: Arc::new(Mutex::new(answers.into())),
                calls: Arc::new(Mutex::new(0)),
            }
        }
        fn calls(&self) -> usize {
            *self.calls.lock().unwrap()
        }
    }

    impl SwitchAgentSnapshotRead for SnapshotReads {
        async fn read_switch_snapshot(
            &self,
            _agent: &AgentId,
        ) -> Result<Option<SwitchAgentSnapshot>, PersistenceFailure> {
            *self.calls.lock().unwrap() += 1;
            self.queued.lock().unwrap().pop_front().unwrap_or(Ok(None))
        }
    }

    // ── availability probe fake ──────────────────────────────────────────

    #[derive(Clone)]
    struct Probe {
        verdict: Result<RuntimeAvailabilityVerdict, RuntimeAvailabilityProbeFault>,
        calls: Arc<Mutex<usize>>,
    }
    impl Probe {
        fn available() -> Self {
            Self::new(Ok(RuntimeAvailabilityVerdict::AvailableOrUnknown))
        }
        fn new(verdict: Result<RuntimeAvailabilityVerdict, RuntimeAvailabilityProbeFault>) -> Self {
            Self {
                verdict,
                calls: Arc::new(Mutex::new(0)),
            }
        }
        fn calls(&self) -> usize {
            *self.calls.lock().unwrap()
        }
    }
    impl RuntimeAvailabilityProbe for Probe {
        async fn probe_runtime_available(
            &self,
            _host: &HostId,
            _runtime: RuntimeKind,
        ) -> Result<RuntimeAvailabilityVerdict, RuntimeAvailabilityProbeFault> {
            *self.calls.lock().unwrap() += 1;
            self.verdict
        }
    }

    // ── conversation coordination fake ───────────────────────────────────

    #[derive(Clone, Default)]
    struct Coordination {
        reclaimed: Vec<ConversationId>,
        pending: Vec<ConversationId>,
        pending_since: Vec<ConversationId>,
        participant: bool,
        rollback_calls: Arc<Mutex<usize>>,
    }
    impl SwitchConversationCoordination for Coordination {
        async fn rollback_in_flight_for_agent(
            &self,
            _agent: &AgentId,
        ) -> Result<Vec<ConversationId>, PersistenceFailure> {
            *self.rollback_calls.lock().unwrap() += 1;
            Ok(self.reclaimed.clone())
        }
        async fn list_pending_for_agent(
            &self,
            _agent: &AgentId,
        ) -> Result<Vec<ConversationId>, PersistenceFailure> {
            Ok(self.pending.clone())
        }
        async fn list_pending_for_agent_since(
            &self,
            _agent: &AgentId,
            _since_ms: i64,
        ) -> Result<Vec<ConversationId>, PersistenceFailure> {
            Ok(self.pending_since.clone())
        }
        async fn is_agent_participant(
            &self,
            _conversation: &ConversationId,
            _agent: &AgentId,
        ) -> Result<bool, PersistenceFailure> {
            Ok(self.participant)
        }
    }

    // ── runtime-transition write fake ────────────────────────────────────

    fn faithful_after(now_ms: i64) -> RuntimeTransitionAfterImage {
        RuntimeTransitionAfterImage {
            agent_id: agent(AGENT),
            runtime: "codex".into(),
            model: Some("gpt".into()),
            reasoning_effort: None,
            fast_mode: None,
            updated_at: now_ms,
            transition_target: None,
            transition_started_at: None,
        }
    }

    #[derive(Clone)]
    struct Transitions {
        begin: BeginTransitionRecord,
        complete: CompleteTransitionRecord,
        begins: Arc<Mutex<usize>>,
        aborts: Arc<Mutex<usize>>,
        completes: Arc<Mutex<usize>>,
    }
    impl Transitions {
        fn new(begin: BeginTransitionRecord, complete: CompleteTransitionRecord) -> Self {
            Self {
                begin,
                complete,
                begins: Arc::new(Mutex::new(0)),
                aborts: Arc::new(Mutex::new(0)),
                completes: Arc::new(Mutex::new(0)),
            }
        }
        /// A writer that locks and commits faithfully to `codex` at `NOW`.
        fn committing() -> Self {
            Self::new(
                BeginTransitionRecord::Locked(RuntimeTransitionLockRow {
                    agent_id: agent(AGENT),
                    target: "codex".into(),
                    started_at: NOW,
                }),
                CompleteTransitionRecord::Committed(faithful_after(NOW)),
            )
        }
        fn begins(&self) -> usize {
            *self.begins.lock().unwrap()
        }
        fn aborts(&self) -> usize {
            *self.aborts.lock().unwrap()
        }
        fn completes(&self) -> usize {
            *self.completes.lock().unwrap()
        }
    }
    impl RuntimeTransitionWrite for Transitions {
        async fn begin(
            &self,
            _agent: &AgentId,
            _target: RuntimeKind,
            _now_ms: i64,
        ) -> Result<BeginTransitionRecord, PersistenceFailure> {
            *self.begins.lock().unwrap() += 1;
            Ok(self.begin.clone())
        }
        async fn abort(
            &self,
            _lock: &RuntimeTransitionLock,
        ) -> Result<AbortTransition, PersistenceFailure> {
            *self.aborts.lock().unwrap() += 1;
            Ok(AbortTransition::Released)
        }
        async fn complete(
            &self,
            _lock: &RuntimeTransitionLock,
            _commit: &RuntimeTransitionCommit,
            _now_ms: i64,
        ) -> Result<CompleteTransitionRecord, PersistenceFailure> {
            *self.completes.lock().unwrap() += 1;
            Ok(self.complete.clone())
        }
    }

    // ── runtime-control provider fake ────────────────────────────────────

    #[derive(Clone, Copy)]
    enum ClearScript {
        Ok,
        Refuse,
        Transport,
    }

    #[derive(Clone)]
    struct Control {
        clears: Arc<Mutex<VecDeque<ClearScript>>>,
        /// The scope of every clear_session call, in order.
        cleared: Arc<Mutex<Vec<RuntimeScope>>>,
        /// The presentation origin of every start call, in order.
        started: Arc<Mutex<Vec<ConversationId>>>,
    }
    #[derive(Debug)]
    struct NeverFails;
    impl std::fmt::Display for NeverFails {
        fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            f.write_str("never fails")
        }
    }
    impl std::error::Error for NeverFails {}
    impl Control {
        fn new() -> Self {
            Self {
                clears: Arc::new(Mutex::new(VecDeque::new())),
                cleared: Arc::new(Mutex::new(Vec::new())),
                started: Arc::new(Mutex::new(Vec::new())),
            }
        }
        fn scripting(scripts: Vec<ClearScript>) -> Self {
            let control = Self::new();
            *control.clears.lock().unwrap() = scripts.into();
            control
        }
        fn cleared(&self) -> Vec<RuntimeScope> {
            self.cleared.lock().unwrap().clone()
        }
        fn started(&self) -> Vec<ConversationId> {
            self.started.lock().unwrap().clone()
        }
    }
    impl RuntimeControlPort for Control {
        type Error = NeverFails;

        async fn start(
            &self,
            target: &RuntimeStartTarget,
        ) -> Result<Result<StartRuntimeOutcome, StartRuntimeProviderRefusal>, Self::Error> {
            self.started
                .lock()
                .unwrap()
                .push(target.presentation_origin().clone());
            Ok(Ok(StartRuntimeOutcome))
        }
        async fn hard_stop(
            &self,
            _target: &RuntimeSeatTarget,
        ) -> Result<
            Result<
                crate::messaging::collaboration::HardStopRuntimeOutcome,
                crate::messaging::collaboration::HardStopRuntimeProviderRefusal,
            >,
            Self::Error,
        > {
            unreachable!("switch saga never hard-stops")
        }
        async fn clear_session(
            &self,
            target: &RuntimeSeatTarget,
        ) -> Result<Result<ClearSessionOutcome, ClearSessionProviderRefusal>, Self::Error> {
            let scope = target.scope().clone();
            self.cleared.lock().unwrap().push(scope.clone());
            let script = self
                .clears
                .lock()
                .unwrap()
                .pop_front()
                .unwrap_or(ClearScript::Ok);
            Ok(match script {
                ClearScript::Ok => Ok(match scope {
                    // The agent seat carries the presentation focus the saga may reuse.
                    RuntimeScope::AgentSlot { .. } => {
                        ClearSessionOutcome::committed_presenting(None, true, Some(conv("focus")))
                    }
                    RuntimeScope::ConversationSlot { .. } => {
                        ClearSessionOutcome::committed(None, true)
                    }
                }),
                ClearScript::Refuse => Err(ClearSessionProviderRefusal::Placement(
                    RuntimePlacementRefusal::HostMissing,
                )),
                ClearScript::Transport => return Err(NeverFails),
            })
        }
    }

    // ── the assembled saga call ──────────────────────────────────────────

    struct Harness {
        reads: SnapshotReads,
        probe: Probe,
        coordination: Coordination,
        transitions: Transitions,
        control: Control,
    }
    impl Harness {
        async fn run(
            &self,
            request: &SwitchAgentRuntimeRequest,
        ) -> Result<SwitchAgentRuntimeCommitted, SwitchAgentRuntimeError> {
            switch_agent_runtime(
                &self.reads,
                &self.probe,
                &self.coordination,
                &self.transitions,
                &self.control,
                request,
                NOW,
            )
            .await
        }
    }

    // ─────────────────────────────────────────────────────────────────────
    // Preflight refusals never touch the lock or any effect.
    // ─────────────────────────────────────────────────────────────────────

    #[tokio::test]
    async fn unchanged_runtime_refuses_before_the_lock() {
        let (req, _from) = request(RuntimeKind::Codex, RuntimeKind::Codex);
        let harness = Harness {
            reads: SnapshotReads::stable(snapshot(
                RuntimeKind::Codex,
                AgentSessionScope::Agent,
                vec![],
            )),
            probe: Probe::available(),
            coordination: Coordination::default(),
            transitions: Transitions::committing(),
            control: Control::new(),
        };
        assert_eq!(
            harness.run(&req).await,
            Err(SwitchAgentRuntimeError::RuntimeUnchanged)
        );
        assert_eq!(harness.transitions.begins(), 0, "no lock acquired");
        assert!(harness.control.cleared().is_empty(), "no session cleared");
        assert_eq!(
            harness.probe.calls(),
            0,
            "unchanged short-circuits before probe"
        );
    }

    #[tokio::test]
    async fn a_non_selectable_runtime_refuses_before_the_lock() {
        // Cursor is a real RuntimeKind that is NOT in SELECTABLE_RUNTIMES.
        let (req, from) = request(RuntimeKind::Codex, RuntimeKind::Cursor);
        let harness = Harness {
            reads: SnapshotReads::stable(snapshot(from, AgentSessionScope::Agent, vec![])),
            probe: Probe::available(),
            coordination: Coordination::default(),
            transitions: Transitions::committing(),
            control: Control::new(),
        };
        assert_eq!(
            harness.run(&req).await,
            Err(SwitchAgentRuntimeError::RuntimeNotSelectable)
        );
        assert_eq!(harness.transitions.begins(), 0, "no lock acquired");
        assert_eq!(
            harness.probe.calls(),
            0,
            "unselectable short-circuits before the probe"
        );
    }

    #[tokio::test]
    async fn deterministically_absent_runtime_refuses_before_the_lock() {
        let (req, from) = request(RuntimeKind::Claude, RuntimeKind::Codex);
        let harness = Harness {
            reads: SnapshotReads::stable(snapshot(from, AgentSessionScope::Agent, vec![])),
            probe: Probe::new(Ok(RuntimeAvailabilityVerdict::Absent)),
            coordination: Coordination::default(),
            transitions: Transitions::committing(),
            control: Control::new(),
        };
        assert_eq!(
            harness.run(&req).await,
            Err(SwitchAgentRuntimeError::RuntimeNotInstalled)
        );
        assert_eq!(
            harness.transitions.begins(),
            0,
            "absent probe blocks before the lock"
        );
        assert!(harness.control.cleared().is_empty());
    }

    #[tokio::test]
    async fn probe_fault_surfaces_and_never_takes_the_lock() {
        let (req, from) = request(RuntimeKind::Claude, RuntimeKind::Codex);
        let harness = Harness {
            reads: SnapshotReads::stable(snapshot(from, AgentSessionScope::Agent, vec![])),
            probe: Probe::new(Err(RuntimeAvailabilityProbeFault::AttachPending)),
            coordination: Coordination::default(),
            transitions: Transitions::committing(),
            control: Control::new(),
        };
        assert_eq!(
            harness.run(&req).await,
            Err(SwitchAgentRuntimeError::Availability(
                RuntimeAvailabilityProbeFault::AttachPending
            ))
        );
        assert_eq!(harness.transitions.begins(), 0);
    }

    #[tokio::test]
    async fn missing_agent_refuses() {
        let (req, _from) = request(RuntimeKind::Claude, RuntimeKind::Codex);
        let harness = Harness {
            reads: SnapshotReads::scripted(vec![Ok(None)]),
            probe: Probe::available(),
            coordination: Coordination::default(),
            transitions: Transitions::committing(),
            control: Control::new(),
        };
        assert_eq!(
            harness.run(&req).await,
            Err(SwitchAgentRuntimeError::AgentNotFound)
        );
        assert_eq!(harness.probe.calls(), 0);
    }

    #[tokio::test]
    async fn a_snapshot_from_a_foreign_row_is_a_fault_not_an_answer() {
        let (req, from) = request(RuntimeKind::Claude, RuntimeKind::Codex);
        let mut foreign = snapshot(from, AgentSessionScope::Agent, vec![]);
        foreign.source = agent("someone-else");
        let harness = Harness {
            reads: SnapshotReads::scripted(vec![Ok(Some(foreign))]),
            probe: Probe::available(),
            coordination: Coordination::default(),
            transitions: Transitions::committing(),
            control: Control::new(),
        };
        assert_eq!(
            harness.run(&req).await,
            Err(SwitchAgentRuntimeError::Fault(
                SwitchAgentRuntimeFault::SourceUntrustworthy
            ))
        );
        assert_eq!(harness.transitions.begins(), 0);
    }

    // ─────────────────────────────────────────────────────────────────────
    // Lock-acquisition outcomes.
    // ─────────────────────────────────────────────────────────────────────

    #[tokio::test]
    async fn concurrent_transition_loses_the_lock_race() {
        let (req, from) = request(RuntimeKind::Claude, RuntimeKind::Codex);
        let harness = Harness {
            reads: SnapshotReads::stable(snapshot(from, AgentSessionScope::Agent, vec![])),
            probe: Probe::available(),
            coordination: Coordination::default(),
            transitions: Transitions::new(
                BeginTransitionRecord::InProgress,
                CompleteTransitionRecord::Lost,
            ),
            control: Control::new(),
        };
        assert_eq!(
            harness.run(&req).await,
            Err(SwitchAgentRuntimeError::TransitionInProgress)
        );
        assert!(
            harness.control.cleared().is_empty(),
            "a lost lock clears nothing"
        );
    }

    #[tokio::test]
    async fn a_deleting_agent_refuses_the_transition() {
        let (req, from) = request(RuntimeKind::Claude, RuntimeKind::Codex);
        let harness = Harness {
            reads: SnapshotReads::stable(snapshot(from, AgentSessionScope::Agent, vec![])),
            probe: Probe::available(),
            coordination: Coordination::default(),
            transitions: Transitions::new(
                BeginTransitionRecord::Deleting,
                CompleteTransitionRecord::Lost,
            ),
            control: Control::new(),
        };
        assert_eq!(
            harness.run(&req).await,
            Err(SwitchAgentRuntimeError::DeletionInProgress)
        );
    }

    // ─────────────────────────────────────────────────────────────────────
    // Under the lock: re-read staleness, clear-all, commit, re-drive.
    // ─────────────────────────────────────────────────────────────────────

    #[tokio::test]
    async fn a_target_reached_by_a_racing_commit_is_caught_on_the_under_lock_reread() {
        // Preflight sees claude→codex; by the time the lock is held another request has
        // already committed codex, so the re-read must refuse rather than overwrite tuning.
        let (req, _from) = request(RuntimeKind::Claude, RuntimeKind::Codex);
        let harness = Harness {
            reads: SnapshotReads::scripted(vec![
                Ok(Some(snapshot(
                    RuntimeKind::Claude,
                    AgentSessionScope::Agent,
                    vec![],
                ))),
                Ok(Some(snapshot(
                    RuntimeKind::Codex,
                    AgentSessionScope::Agent,
                    vec![],
                ))),
            ]),
            probe: Probe::available(),
            coordination: Coordination::default(),
            transitions: Transitions::committing(),
            control: Control::new(),
        };
        assert_eq!(
            harness.run(&req).await,
            Err(SwitchAgentRuntimeError::RuntimeUnchanged)
        );
        assert_eq!(harness.reads.calls(), 2, "preflight + under-lock re-read");
        assert_eq!(harness.transitions.begins(), 1, "the lock was taken");
        assert_eq!(harness.transitions.aborts(), 1, "then aborted");
        assert_eq!(harness.transitions.completes(), 0, "never committed");
    }

    #[tokio::test]
    async fn conversation_scope_clears_every_live_or_resumable_seat_then_commits_and_redrives() {
        let (req, from) = request(RuntimeKind::Claude, RuntimeKind::Codex);
        let seats = vec![
            conversation_seat("c-active", RuntimeObservedStatus::Active),
            conversation_seat("c-starting", RuntimeObservedStatus::Starting),
            SwitchSeat {
                scope: RuntimeScope::ConversationSlot {
                    agent: agent(AGENT),
                    source: conv("c-resumable"),
                },
                status: RuntimeObservedStatus::Idle,
                cli_session_id: Some(cli("c-resumable")),
            },
            // Idle with no resumable session: nothing to clear, nothing to restart.
            SwitchSeat {
                scope: RuntimeScope::ConversationSlot {
                    agent: agent(AGENT),
                    source: conv("c-dead"),
                },
                status: RuntimeObservedStatus::Idle,
                cli_session_id: None,
            },
        ];
        let harness = Harness {
            reads: SnapshotReads::stable(snapshot(from, AgentSessionScope::Conversation, seats)),
            probe: Probe::available(),
            coordination: Coordination {
                reclaimed: vec![conv("c-reclaimed")],
                pending_since: vec![conv("c-active"), conv("c-late")],
                ..Coordination::default()
            },
            transitions: Transitions::committing(),
            control: Control::new(),
        };
        let committed = harness.run(&req).await.expect("commit");

        // Every live-or-resumable seat cleared; the dead one skipped.
        assert_eq!(committed.cleared_sessions, 3);
        assert_eq!(harness.control.cleared().len(), 3);
        assert_eq!(harness.transitions.completes(), 1);
        assert_eq!(harness.transitions.aborts(), 0);
        assert_eq!(*harness.coordination.rollback_calls.lock().unwrap(), 1);

        // Re-drive is live-before ∪ reclaimed ∪ newly-pending, deduped, insertion-ordered.
        // Only the two live conversations were live-before (resumable-idle is not restarted).
        assert_eq!(
            harness.control.started(),
            vec![
                conv("c-active"),
                conv("c-starting"),
                conv("c-reclaimed"),
                conv("c-late"),
            ]
        );
        assert_eq!(committed.restarted_conversations, 4);
        assert_eq!(committed.restart_failures, 0);
    }

    #[tokio::test]
    async fn a_single_clear_failure_aborts_without_committing_and_restores_old_runtime() {
        let (req, from) = request(RuntimeKind::Claude, RuntimeKind::Codex);
        let seats = vec![
            conversation_seat("c-a", RuntimeObservedStatus::Active),
            conversation_seat("c-b", RuntimeObservedStatus::Active),
        ];
        let harness = Harness {
            reads: SnapshotReads::stable(snapshot(from, AgentSessionScope::Conversation, seats)),
            probe: Probe::available(),
            coordination: Coordination::default(),
            transitions: Transitions::committing(),
            // First clear succeeds, second refuses: still both attempted (no short-circuit).
            control: Control::scripting(vec![ClearScript::Ok, ClearScript::Refuse]),
        };
        assert_eq!(
            harness.run(&req).await,
            Err(SwitchAgentRuntimeError::SessionClearFailed)
        );
        assert_eq!(
            harness.control.cleared().len(),
            2,
            "all seats attempted, no short-circuit"
        );
        assert_eq!(harness.transitions.completes(), 0, "never committed");
        assert_eq!(harness.transitions.aborts(), 1, "lock aborted");
        // Both live-before conversations restored under the OLD runtime, best-effort.
        assert_eq!(harness.control.started(), vec![conv("c-a"), conv("c-b")]);
    }

    #[tokio::test]
    async fn a_transport_error_on_clear_also_aborts() {
        let (req, from) = request(RuntimeKind::Claude, RuntimeKind::Codex);
        let harness = Harness {
            reads: SnapshotReads::stable(snapshot(
                from,
                AgentSessionScope::Conversation,
                vec![conversation_seat("c-a", RuntimeObservedStatus::Active)],
            )),
            probe: Probe::available(),
            coordination: Coordination::default(),
            transitions: Transitions::committing(),
            control: Control::scripting(vec![ClearScript::Transport]),
        };
        assert_eq!(
            harness.run(&req).await,
            Err(SwitchAgentRuntimeError::SessionClearFailed)
        );
        assert_eq!(harness.transitions.completes(), 0);
        assert_eq!(harness.transitions.aborts(), 1);
    }

    #[tokio::test]
    async fn a_lost_commit_leaves_cleared_sessions_and_fires_no_restore() {
        let (req, from) = request(RuntimeKind::Claude, RuntimeKind::Codex);
        let harness = Harness {
            reads: SnapshotReads::stable(snapshot(
                from,
                AgentSessionScope::Conversation,
                vec![conversation_seat("c-a", RuntimeObservedStatus::Active)],
            )),
            probe: Probe::available(),
            coordination: Coordination::default(),
            transitions: Transitions::new(
                BeginTransitionRecord::Locked(RuntimeTransitionLockRow {
                    agent_id: agent(AGENT),
                    target: "codex".into(),
                    started_at: NOW,
                }),
                CompleteTransitionRecord::Lost,
            ),
            control: Control::new(),
        };
        assert_eq!(
            harness.run(&req).await,
            Err(SwitchAgentRuntimeError::TransitionLost)
        );
        assert_eq!(
            harness.control.cleared().len(),
            1,
            "the seat was cleared before the lost commit"
        );
        assert!(
            harness.control.started().is_empty(),
            "a lost commit restores nothing"
        );
    }

    // ─────────────────────────────────────────────────────────────────────
    // Agent-scope re-drive: one restart target only.
    // ─────────────────────────────────────────────────────────────────────

    #[tokio::test]
    async fn agent_scope_restarts_only_the_oldest_pending_conversation() {
        let (req, from) = request(RuntimeKind::Claude, RuntimeKind::Codex);
        let harness = Harness {
            reads: SnapshotReads::stable(snapshot(
                from,
                AgentSessionScope::Agent,
                vec![agent_seat(RuntimeObservedStatus::Active, false)],
            )),
            probe: Probe::available(),
            coordination: Coordination {
                pending: vec![conv("oldest"), conv("newer")],
                pending_since: vec![conv("late")],
                ..Coordination::default()
            },
            transitions: Transitions::committing(),
            control: Control::new(),
        };
        let committed = harness.run(&req).await.expect("commit");
        assert_eq!(committed.cleared_sessions, 1);
        assert_eq!(
            harness.control.started(),
            vec![conv("oldest")],
            "one AgentSlot restart at the oldest pending origin"
        );
        assert_eq!(committed.restarted_conversations, 1);
    }

    #[tokio::test]
    async fn agent_scope_reuses_the_cleared_focus_only_while_still_a_participant() {
        let (req, from) = request(RuntimeKind::Claude, RuntimeKind::Codex);
        // No pending conversations, but the agent seat was live and its focus is still a
        // participant → resume at the focus captured before clear.
        let live_participant = Harness {
            reads: SnapshotReads::stable(snapshot(
                from,
                AgentSessionScope::Agent,
                vec![agent_seat(RuntimeObservedStatus::Active, false)],
            )),
            probe: Probe::available(),
            coordination: Coordination {
                participant: true,
                ..Coordination::default()
            },
            transitions: Transitions::committing(),
            control: Control::new(),
        };
        let committed = live_participant.run(&req).await.expect("commit");
        assert_eq!(
            live_participant.control.started(),
            vec![conv("focus")],
            "focus reused while participation holds"
        );
        assert_eq!(committed.restarted_conversations, 1);

        // Same shape but the focus is no longer a participant → nothing to restart.
        let gone = Harness {
            reads: SnapshotReads::stable(snapshot(
                from,
                AgentSessionScope::Agent,
                vec![agent_seat(RuntimeObservedStatus::Active, false)],
            )),
            probe: Probe::available(),
            coordination: Coordination {
                participant: false,
                ..Coordination::default()
            },
            transitions: Transitions::committing(),
            control: Control::new(),
        };
        let committed = gone.run(&req).await.expect("commit");
        assert!(
            gone.control.started().is_empty(),
            "a stale focus is never restarted"
        );
        assert_eq!(committed.restarted_conversations, 0);
    }

    #[tokio::test]
    async fn agent_scope_with_nothing_live_and_no_pending_restarts_nothing() {
        let (req, from) = request(RuntimeKind::Claude, RuntimeKind::Codex);
        let harness = Harness {
            reads: SnapshotReads::stable(snapshot(
                from,
                AgentSessionScope::Agent,
                vec![agent_seat(RuntimeObservedStatus::Idle, false)],
            )),
            probe: Probe::available(),
            coordination: Coordination {
                participant: true,
                ..Coordination::default()
            },
            transitions: Transitions::committing(),
            control: Control::new(),
        };
        let committed = harness.run(&req).await.expect("commit");
        assert_eq!(
            committed.cleared_sessions, 0,
            "an idle agent seat holds no session"
        );
        assert!(harness.control.started().is_empty());
        assert_eq!(committed.restarted_conversations, 0);
    }

    #[tokio::test]
    async fn a_restart_failure_after_commit_is_counted_never_rolled_back() {
        let (req, from) = request(RuntimeKind::Claude, RuntimeKind::Codex);
        // A committing writer; the control port refuses the restart. The transition stays
        // committed and the failure is only counted.
        #[derive(Clone)]
        struct RefusingStart(Control);
        impl RuntimeControlPort for RefusingStart {
            type Error = NeverFails;
            async fn start(
                &self,
                _target: &RuntimeStartTarget,
            ) -> Result<Result<StartRuntimeOutcome, StartRuntimeProviderRefusal>, Self::Error>
            {
                Ok(Err(StartRuntimeProviderRefusal::ShuttingDown))
            }
            async fn hard_stop(
                &self,
                _target: &RuntimeSeatTarget,
            ) -> Result<
                Result<
                    crate::messaging::collaboration::HardStopRuntimeOutcome,
                    crate::messaging::collaboration::HardStopRuntimeProviderRefusal,
                >,
                Self::Error,
            > {
                unreachable!()
            }
            async fn clear_session(
                &self,
                target: &RuntimeSeatTarget,
            ) -> Result<Result<ClearSessionOutcome, ClearSessionProviderRefusal>, Self::Error>
            {
                self.0.clear_session(target).await
            }
        }
        let committed = switch_agent_runtime(
            &SnapshotReads::stable(snapshot(
                from,
                AgentSessionScope::Conversation,
                vec![conversation_seat("c-a", RuntimeObservedStatus::Active)],
            )),
            &Probe::available(),
            &Coordination::default(),
            &Transitions::committing(),
            &RefusingStart(Control::new()),
            &req,
            NOW,
        )
        .await
        .expect("transition still commits despite restart refusal");
        assert_eq!(committed.restarted_conversations, 0);
        assert_eq!(
            committed.restart_failures, 1,
            "the refusal is counted, not rolled back"
        );
    }
}
