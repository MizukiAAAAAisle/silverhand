//! The durable runtime-transition lock: the compare-and-set state machine that lets
//! one agent change runtime without losing a session or racing a delete.
//!
//! Switching runtime is not a single write. The old-runtime sessions must be cleared
//! before the `runtime` column moves, and nothing may spawn or deliver under the
//! agent while that window is open. A durable lock on the row
//! (`runtime_transition_target`, with its paired `runtime_transition_started_at`) is
//! what holds the window closed across the clear, and its compare-and-set is what
//! makes two concurrent switches — or a switch racing a delete — fail loudly instead
//! of interleaving.
//!
//! This is a distinct write authority from the capability-neutral
//! [`crate::agent_profile_write`] row writer, exactly as [`crate::teardown`] is a
//! distinct authority: the profile writer decides a per-capability column edit inside
//! its lock, whereas this authority is a three-step lock lifecycle — acquire, release,
//! commit-and-release — keyed on the lock columns. In particular [`RuntimeTransitionWrite::complete`]
//! writes the `runtime` + tuning columns AND clears the lock as ONE compare-and-set on
//! the target it owns, so the ownership guard gates the tuning write itself; splitting
//! the release from the write would reopen the very window the lock exists to close.
//!
//! Every arm the port returns is a DB-observable WITNESS, never a product verdict: the
//! use case maps `Lost` / `InProgress` / `Deleting` to the stable route errors. A
//! broken serialized compare-and-set is not one of these arms — it is an internal
//! fault the adapter raises as [`PersistenceFailure`].

use std::future::Future;

use crate::{agents::runtime::RuntimeKind, identity::AgentId, persistence::PersistenceFailure};

/// The runtime change committed in one write, mirroring the TypeScript
/// `completeRuntimeTransition` input. `runtime` is both the new `runtime` column AND
/// the lock target the commit's compare-and-set matches on, so the two can never
/// disagree. Tuning legality (model/effort against the target runtime) is the upstream
/// admission schema's job and the daemon spawn is the final guard; this value is the
/// already-validated request carried verbatim to the write.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RuntimeTransitionCommit {
    /// The runtime being committed — also the lock target this commit owns.
    pub runtime: RuntimeKind,
    pub model: Option<String>,
    pub reasoning_effort: Option<String>,
    pub fast_mode: Option<bool>,
}

/// What acquiring the lock found. `Started` is the only arm that changed a fact
/// (null → target); the rest are why it could not, in the TypeScript authority's
/// precedence — an in-flight delete answers before an in-flight transition.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum BeginTransition {
    /// The lock is now held for the requested target; the `runtime` column is
    /// unchanged until `complete`.
    Started,
    /// No such agent row.
    NotFound,
    /// The row is being deleted — a transition must not race the teardown.
    Deleting,
    /// A transition lock is already held (for this or another target).
    InProgress,
}

/// Whether releasing a pre-commit lock matched. A release that finds no matching lock
/// is a no-op, not a failure: the transition may already have committed (which clears
/// the lock) on another path, or never held it.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum AbortTransition {
    Released,
    NotHeld,
}

/// What committing the runtime + tuning found. `Lost` means the lock this commit owned
/// is gone — another attempt took the row — so nothing was written.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum CompleteTransition {
    /// The `runtime` + tuning were written and the lock released, as one CAS.
    Committed,
    /// The target guard did not match: ownership was lost before commit, nothing
    /// written.
    Lost,
}

/// The durable runtime-transition lock lifecycle. Every write is short and holds no
/// remote IO: `begin` and `abort` touch only the lock columns, and `complete` writes
/// the `runtime` + tuning and clears the lock in ONE compare-and-set on the owned
/// target. The `runtime` column stays authoritative until `complete`, so a lock
/// interrupted before commit can be rolled back with `abort` without reconstructing an
/// epoch.
pub trait RuntimeTransitionWrite: Clone + Send + Sync + 'static {
    /// Acquire the lock for `target` without changing the current runtime.
    fn begin(
        &self,
        agent: &AgentId,
        target: RuntimeKind,
        now_ms: i64,
    ) -> impl Future<Output = Result<BeginTransition, PersistenceFailure>> + Send;

    /// Release a lock held for `target` after a pre-commit failure.
    fn abort(
        &self,
        agent: &AgentId,
        target: RuntimeKind,
    ) -> impl Future<Output = Result<AbortTransition, PersistenceFailure>> + Send;

    /// Commit the runtime + tuning and release the lock, guarded by the owned target.
    /// `now_ms` stamps `updated_at`.
    fn complete(
        &self,
        agent: &AgentId,
        commit: &RuntimeTransitionCommit,
        now_ms: i64,
    ) -> impl Future<Output = Result<CompleteTransition, PersistenceFailure>> + Send;
}
