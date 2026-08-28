//! The durable runtime-transition lock: the compare-and-set state machine that lets
//! one agent change runtime without losing a session or racing a delete.
//!
//! Switching runtime is not a single write. The old-runtime sessions must be cleared
//! before the `runtime` column moves, and nothing may spawn or deliver under the agent
//! while that window is open. A durable lock on the row (`runtime_transition_target`,
//! with its paired `runtime_transition_started_at`) is what holds the window closed
//! across the clear, and its compare-and-set is what makes two concurrent switches — or
//! a switch racing a delete — fail loudly instead of interleaving.
//!
//! This is a distinct write authority from the capability-neutral
//! [`crate::agent_profile_write`] row writer, exactly as [`crate::teardown`] is: the
//! profile writer decides a per-capability column edit inside its lock, whereas this is
//! a three-step lock lifecycle — acquire, release, commit-and-release — keyed on the
//! lock columns.
//!
//! # The adapter witnesses; the domain mints the verdict
//!
//! The persistence port never mints a domain verdict. It returns a DB-observable
//! *witness* — the row the compare-and-set actually touched — and the free functions
//! here ([`begin_runtime_transition`], [`complete_runtime_transition`]) bind the
//! subject, replay the request against the witness, and seal it into the product
//! outcome. A `rows_affected == 1` proves only that *some* SQLite impl changed *a* row;
//! it cannot prove the row was the requested agent, or that the committed columns match
//! the request. So:
//!
//!  - Acquiring returns [`RuntimeTransitionLockRow`] with the `AgentId` decoded from the
//!    RETURNING row (never back-filled from the query parameter). [`begin_runtime_transition`]
//!    refuses to mint a lock whose witnessed agent/target/started-at disagree with the
//!    request — a liar or withheld-write adapter yields a fault, not a [`RuntimeTransitionLock`],
//!    so no clear or spawn ever runs off an unproven lock.
//!  - Committing returns the [`RuntimeTransitionAfterImage`] the write left behind, and
//!    [`complete_runtime_transition`] seals it field by field against the request
//!    (`runtime`, all three tuning columns, `updated_at`, and that the lock pair is
//!    cleared) before minting [`CommittedRuntimeTransition`]. A wrong-agent, missed-tuning,
//!    or mis-stamped write is a fault the boundary surfaces as a safe `500`, never a
//!    success the caller acts on.
//!
//! [`RuntimeTransitionLock`] is a private-ctor ownership token minted only by a sealed
//! acquire, and [`RuntimeTransitionWrite::abort`] / [`RuntimeTransitionWrite::complete`]
//! consume it — a caller cannot re-assemble a bare `(agent, target)` and act on a lock
//! it never acquired. The token carries `started_at`, and the adapter folds it into the
//! release/commit compare-and-set, so a *new* attempt that reacquires the same target
//! gives the *old* attempt's token a different `started_at`: the old token can no longer
//! abort or complete the new lock. That is the structural defense against the ABA the
//! TypeScript target-only CAS is racy about — a deliberate internal strengthening with
//! no change to observable non-ABA behavior.

use std::future::Future;

use thiserror::Error;

use crate::{agents::runtime::RuntimeKind, identity::AgentId, persistence::PersistenceFailure};

/// The runtime change committed in one write, mirroring the TypeScript
/// `completeRuntimeTransition` input. `runtime` is both the new `runtime` column AND the
/// lock target the commit is guarded by, so the two can never disagree. Tuning legality
/// (model/effort against the target runtime) is the upstream admission schema's job and
/// the daemon spawn is the final guard; this value is the already-validated request
/// carried verbatim to the write and sealed against the after-image.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RuntimeTransitionCommit {
    /// The runtime being committed — also the lock target this commit owns.
    pub runtime: RuntimeKind,
    pub model: Option<String>,
    pub reasoning_effort: Option<String>,
    pub fast_mode: Option<bool>,
}

/// The raw witness an acquire returns: the row the compare-and-set touched, decoded
/// from its RETURNING clause. `target` is the stored token verbatim (unparsed), so the
/// domain — not the adapter — decides whether it is a runtime the request asked for.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RuntimeTransitionLockRow {
    /// Decoded from the RETURNING `id`, never the query parameter.
    pub agent_id: AgentId,
    pub target: String,
    pub started_at: i64,
}

/// What acquiring the lock observed, as a DB witness. `Locked` carries the touched row;
/// the refusal arms are why the lock could not be taken, in the TypeScript authority's
/// precedence — an in-flight delete answers before an in-flight transition.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum BeginTransitionRecord {
    /// The compare-and-set acquired the lock; this is the row it touched.
    Locked(RuntimeTransitionLockRow),
    /// No such agent row.
    NotFound,
    /// The row is being deleted — a transition must not race the teardown.
    Deleting,
    /// A transition lock is already held (for this or another target).
    InProgress,
}

/// The raw after-image a commit returns: every column the write set, decoded from the
/// RETURNING clause, plus the lock pair (both must read NULL for the release to have
/// happened). The domain seals this against the request.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RuntimeTransitionAfterImage {
    pub agent_id: AgentId,
    pub runtime: String,
    pub model: Option<String>,
    pub reasoning_effort: Option<String>,
    /// Raw `0` / `1` / null column; the domain decodes it to `Option<bool>`.
    pub fast_mode: Option<i64>,
    pub updated_at: i64,
    pub transition_target: Option<String>,
    pub transition_started_at: Option<i64>,
}

/// What committing observed, as a DB witness. `Lost` means the guarded compare-and-set
/// matched no row — another attempt owns the lock, or it was aborted — so nothing was
/// written; it is a product arm, not a fault.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum CompleteTransitionRecord {
    Committed(RuntimeTransitionAfterImage),
    Lost,
}

/// A source-bound ownership token for a held runtime-transition lock. Minted ONLY by
/// [`begin_runtime_transition`] after it seals the acquire witness against the request,
/// so possessing one is proof the lock was durably taken for this exact agent, target,
/// and instant. Its private fields cannot be re-assembled from a bare request.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RuntimeTransitionLock {
    agent_id: AgentId,
    target: RuntimeKind,
    started_at: i64,
}

impl RuntimeTransitionLock {
    /// Bind the subject and replay the request against the acquire witness. The
    /// witnessed `AgentId` must equal the request's, the witnessed target token must
    /// parse and equal the requested target, and the witnessed started-at must equal the
    /// clock the request stamped. Any disagreement is an internal invariant break, not a
    /// product answer.
    fn seal(
        requested_agent: &AgentId,
        requested_target: RuntimeKind,
        now_ms: i64,
        row: RuntimeTransitionLockRow,
    ) -> Result<Self, RuntimeTransitionFault> {
        if &row.agent_id != requested_agent {
            return Err(RuntimeTransitionFault::LockWitnessMismatch {
                reason: "acquire witness names a different agent than the request",
            });
        }
        let witnessed = RuntimeKind::parse(&row.target).ok_or({
            RuntimeTransitionFault::LockWitnessMismatch {
                reason: "acquire witness carries an unknown runtime token",
            }
        })?;
        if witnessed != requested_target {
            return Err(RuntimeTransitionFault::LockWitnessMismatch {
                reason: "acquire witness target differs from the requested target",
            });
        }
        if row.started_at != now_ms {
            return Err(RuntimeTransitionFault::LockWitnessMismatch {
                reason: "acquire witness started-at differs from the request clock",
            });
        }
        Ok(Self {
            agent_id: row.agent_id,
            target: requested_target,
            started_at: now_ms,
        })
    }

    pub fn agent_id(&self) -> &AgentId {
        &self.agent_id
    }

    pub fn target(&self) -> RuntimeKind {
        self.target
    }

    pub fn started_at(&self) -> i64 {
        self.started_at
    }
}

/// A sealed, committed runtime change: the after-image proven to match the request.
/// Minted only by [`complete_runtime_transition`], so an upper layer that holds one may
/// start the target-runtime session knowing the durable row actually carries it.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CommittedRuntimeTransition {
    agent_id: AgentId,
    runtime: RuntimeKind,
    model: Option<String>,
    reasoning_effort: Option<String>,
    fast_mode: Option<bool>,
    updated_at: i64,
}

impl CommittedRuntimeTransition {
    /// Bind the subject and seal the after-image field by field against the request. The
    /// committed agent must be the lock's, the lock pair must read cleared, and every
    /// written column (`runtime`, all three tuning fields, `updated_at`) must equal what
    /// the request asked to write.
    fn seal(
        lock: &RuntimeTransitionLock,
        commit: &RuntimeTransitionCommit,
        now_ms: i64,
        after: RuntimeTransitionAfterImage,
    ) -> Result<Self, RuntimeTransitionFault> {
        if &after.agent_id != lock.agent_id() {
            return Err(RuntimeTransitionFault::CommitWitnessMismatch {
                reason: "committed after-image names a different agent than the lock",
            });
        }
        if after.transition_target.is_some() || after.transition_started_at.is_some() {
            return Err(RuntimeTransitionFault::CommitWitnessMismatch {
                reason: "committed after-image did not clear the lock pair",
            });
        }
        let runtime = RuntimeKind::parse(&after.runtime).ok_or({
            RuntimeTransitionFault::CommitWitnessMismatch {
                reason: "committed after-image carries an unknown runtime token",
            }
        })?;
        if runtime != commit.runtime {
            return Err(RuntimeTransitionFault::CommitWitnessMismatch {
                reason: "committed runtime differs from the requested runtime",
            });
        }
        if after.model != commit.model {
            return Err(RuntimeTransitionFault::CommitWitnessMismatch {
                reason: "committed model differs from the request",
            });
        }
        if after.reasoning_effort != commit.reasoning_effort {
            return Err(RuntimeTransitionFault::CommitWitnessMismatch {
                reason: "committed reasoning_effort differs from the request",
            });
        }
        if decode_fast_mode(after.fast_mode)? != commit.fast_mode {
            return Err(RuntimeTransitionFault::CommitWitnessMismatch {
                reason: "committed fast_mode differs from the request",
            });
        }
        if after.updated_at != now_ms {
            return Err(RuntimeTransitionFault::CommitWitnessMismatch {
                reason: "committed updated_at differs from the request clock",
            });
        }
        Ok(Self {
            agent_id: after.agent_id,
            runtime,
            model: after.model,
            reasoning_effort: after.reasoning_effort,
            fast_mode: commit.fast_mode,
            updated_at: now_ms,
        })
    }

    pub fn agent_id(&self) -> &AgentId {
        &self.agent_id
    }

    pub fn runtime(&self) -> RuntimeKind {
        self.runtime
    }

    pub fn model(&self) -> Option<&str> {
        self.model.as_deref()
    }

    pub fn reasoning_effort(&self) -> Option<&str> {
        self.reasoning_effort.as_deref()
    }

    pub fn fast_mode(&self) -> Option<bool> {
        self.fast_mode
    }

    pub fn updated_at(&self) -> i64 {
        self.updated_at
    }
}

/// The stored `fast_mode` column decoded to `Option<bool>`. Anything but null / `0` / `1`
/// is a corrupt after-image, sealed as a mismatch rather than silently coerced.
fn decode_fast_mode(raw: Option<i64>) -> Result<Option<bool>, RuntimeTransitionFault> {
    match raw {
        None => Ok(None),
        Some(0) => Ok(Some(false)),
        Some(1) => Ok(Some(true)),
        Some(_) => Err(RuntimeTransitionFault::CommitWitnessMismatch {
            reason: "committed fast_mode column is neither null, 0, nor 1",
        }),
    }
}

/// The domain verdict of an acquire: `Started` carries the sealed ownership token.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum BeginTransition {
    Started(RuntimeTransitionLock),
    NotFound,
    Deleting,
    InProgress,
}

/// The domain verdict of a commit.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum CompleteTransition {
    Committed(CommittedRuntimeTransition),
    Lost,
}

/// Whether releasing a pre-commit lock matched. A release that finds no matching lock is
/// a no-op, not a failure: the lock may already have committed (which clears it) or been
/// reacquired by another attempt (whose `started_at` this token no longer matches).
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum AbortTransition {
    Released,
    NotHeld,
}

/// A fault in the lock lifecycle — a driver error, or a witness that disagrees with the
/// request. Every arm is an internal invariant break the boundary surfaces as a safe
/// `500`; none is a product answer. The `reason` is a static label for the boundary log,
/// small enough to keep the error variant off `clippy::result_large_err`.
#[derive(Debug, Error)]
pub enum RuntimeTransitionFault {
    #[error(transparent)]
    Persistence(#[from] PersistenceFailure),
    #[error("runtime-transition acquire witness disagreed with the request: {reason}")]
    LockWitnessMismatch { reason: &'static str },
    #[error("runtime-transition committed after-image disagreed with the request: {reason}")]
    CommitWitnessMismatch { reason: &'static str },
}

/// The durable runtime-transition lock lifecycle. Every write is short and holds no
/// remote IO: `begin` and `abort` touch only the lock columns, and `complete` writes the
/// `runtime` + tuning and clears the lock in ONE compare-and-set on the owned target and
/// started-at. Each returns a DB witness; the free functions in this module seal them.
pub trait RuntimeTransitionWrite: Clone + Send + Sync + 'static {
    /// Acquire the lock for `target` without changing the current runtime, returning the
    /// row the compare-and-set touched.
    fn begin(
        &self,
        agent: &AgentId,
        target: RuntimeKind,
        now_ms: i64,
    ) -> impl Future<Output = Result<BeginTransitionRecord, PersistenceFailure>> + Send;

    /// Release the lock this token owns, guarded by its target AND started-at.
    fn abort(
        &self,
        lock: &RuntimeTransitionLock,
    ) -> impl Future<Output = Result<AbortTransition, PersistenceFailure>> + Send;

    /// Commit the runtime + tuning and clear the lock this token owns, guarded by its
    /// target AND started-at, returning the after-image. `now_ms` stamps `updated_at`.
    fn complete(
        &self,
        lock: &RuntimeTransitionLock,
        commit: &RuntimeTransitionCommit,
        now_ms: i64,
    ) -> impl Future<Output = Result<CompleteTransitionRecord, PersistenceFailure>> + Send;
}

/// Acquire the lock and seal the witness into an ownership token. A witness that names a
/// different agent/target/started-at than the request yields a fault, never a
/// [`BeginTransition::Started`], so nothing downstream runs off an unproven lock.
pub async fn begin_runtime_transition<P: RuntimeTransitionWrite>(
    port: &P,
    agent: &AgentId,
    target: RuntimeKind,
    now_ms: i64,
) -> Result<BeginTransition, RuntimeTransitionFault> {
    Ok(match port.begin(agent, target, now_ms).await? {
        BeginTransitionRecord::Locked(row) => {
            BeginTransition::Started(RuntimeTransitionLock::seal(agent, target, now_ms, row)?)
        }
        BeginTransitionRecord::NotFound => BeginTransition::NotFound,
        BeginTransitionRecord::Deleting => BeginTransition::Deleting,
        BeginTransitionRecord::InProgress => BeginTransition::InProgress,
    })
}

/// Release a lock held by this token after a pre-commit failure.
pub async fn abort_runtime_transition<P: RuntimeTransitionWrite>(
    port: &P,
    lock: &RuntimeTransitionLock,
) -> Result<AbortTransition, PersistenceFailure> {
    port.abort(lock).await
}

/// Commit the runtime + tuning under this token and seal the after-image field by field
/// against the request. A committed row that disagrees on any written column, or that
/// did not clear the lock, yields a fault — never a [`CompleteTransition::Committed`] the
/// caller acts on.
pub async fn complete_runtime_transition<P: RuntimeTransitionWrite>(
    port: &P,
    lock: &RuntimeTransitionLock,
    commit: &RuntimeTransitionCommit,
    now_ms: i64,
) -> Result<CompleteTransition, RuntimeTransitionFault> {
    Ok(match port.complete(lock, commit, now_ms).await? {
        CompleteTransitionRecord::Committed(after) => CompleteTransition::Committed(
            CommittedRuntimeTransition::seal(lock, commit, now_ms, after)?,
        ),
        CompleteTransitionRecord::Lost => CompleteTransition::Lost,
    })
}

#[cfg(test)]
mod tests {
    use std::sync::{
        Arc,
        atomic::{AtomicUsize, Ordering::SeqCst},
    };

    use super::*;

    fn agent(id: &str) -> AgentId {
        AgentId::parse(id).expect("agent id")
    }

    fn commit() -> RuntimeTransitionCommit {
        RuntimeTransitionCommit {
            runtime: RuntimeKind::Codex,
            model: Some("gpt".to_string()),
            reasoning_effort: Some("high".to_string()),
            fast_mode: Some(true),
        }
    }

    /// A faithful after-image for `commit()` committed at `now_ms`, with the lock cleared.
    fn faithful_after(id: &str, now_ms: i64) -> RuntimeTransitionAfterImage {
        RuntimeTransitionAfterImage {
            agent_id: agent(id),
            runtime: "codex".to_string(),
            model: Some("gpt".to_string()),
            reasoning_effort: Some("high".to_string()),
            fast_mode: Some(1),
            updated_at: now_ms,
            transition_target: None,
            transition_started_at: None,
        }
    }

    /// A fake whose begin/complete outcomes are scripted, counting how often each write is
    /// reached — so a rejected witness proves as zero downstream calls, not just a fault.
    #[derive(Clone)]
    struct ScriptedPort {
        begin: BeginTransitionRecord,
        complete: CompleteTransitionRecord,
        begins: Arc<AtomicUsize>,
        aborts: Arc<AtomicUsize>,
        completes: Arc<AtomicUsize>,
    }

    impl ScriptedPort {
        fn new(begin: BeginTransitionRecord, complete: CompleteTransitionRecord) -> Self {
            Self {
                begin,
                complete,
                begins: Arc::new(AtomicUsize::new(0)),
                aborts: Arc::new(AtomicUsize::new(0)),
                completes: Arc::new(AtomicUsize::new(0)),
            }
        }
    }

    impl RuntimeTransitionWrite for ScriptedPort {
        async fn begin(
            &self,
            _agent: &AgentId,
            _target: RuntimeKind,
            _now_ms: i64,
        ) -> Result<BeginTransitionRecord, PersistenceFailure> {
            self.begins.fetch_add(1, SeqCst);
            Ok(self.begin.clone())
        }

        async fn abort(
            &self,
            _lock: &RuntimeTransitionLock,
        ) -> Result<AbortTransition, PersistenceFailure> {
            self.aborts.fetch_add(1, SeqCst);
            Ok(AbortTransition::Released)
        }

        async fn complete(
            &self,
            _lock: &RuntimeTransitionLock,
            _commit: &RuntimeTransitionCommit,
            _now_ms: i64,
        ) -> Result<CompleteTransitionRecord, PersistenceFailure> {
            self.completes.fetch_add(1, SeqCst);
            Ok(self.complete.clone())
        }
    }

    fn locked(id: &str, target: &str, started_at: i64) -> BeginTransitionRecord {
        BeginTransitionRecord::Locked(RuntimeTransitionLockRow {
            agent_id: agent(id),
            target: target.to_string(),
            started_at,
        })
    }

    async fn a_sealed_lock() -> (ScriptedPort, RuntimeTransitionLock) {
        let port = ScriptedPort::new(
            locked("a1", "codex", 5),
            CompleteTransitionRecord::Committed(faithful_after("a1", 42)),
        );
        let BeginTransition::Started(lock) =
            begin_runtime_transition(&port, &agent("a1"), RuntimeKind::Codex, 5)
                .await
                .unwrap()
        else {
            panic!("expected a sealed lock");
        };
        (port, lock)
    }

    #[tokio::test]
    async fn begin_seals_a_faithful_witness_into_a_lock() {
        let (_port, lock) = a_sealed_lock().await;
        assert_eq!(lock.agent_id(), &agent("a1"));
        assert_eq!(lock.target(), RuntimeKind::Codex);
        assert_eq!(lock.started_at(), 5);
    }

    /// A liar writer returns a lock witness for a DIFFERENT agent: the seal refuses, so no
    /// ownership token is produced and nothing downstream can run.
    #[tokio::test]
    async fn begin_rejects_a_witness_for_another_agent() {
        let port = ScriptedPort::new(locked("other", "codex", 5), CompleteTransitionRecord::Lost);
        let fault = begin_runtime_transition(&port, &agent("a1"), RuntimeKind::Codex, 5)
            .await
            .unwrap_err();
        assert!(matches!(
            fault,
            RuntimeTransitionFault::LockWitnessMismatch { .. }
        ));
    }

    /// A withheld / mis-stamped write returns a witness whose target and started-at do not
    /// match the request; each is a fault before any lock is minted.
    #[tokio::test]
    async fn begin_rejects_a_witness_that_misreports_target_or_started_at() {
        let wrong_target =
            ScriptedPort::new(locked("a1", "cursor", 5), CompleteTransitionRecord::Lost);
        assert!(matches!(
            begin_runtime_transition(&wrong_target, &agent("a1"), RuntimeKind::Codex, 5)
                .await
                .unwrap_err(),
            RuntimeTransitionFault::LockWitnessMismatch { .. }
        ));

        let wrong_started =
            ScriptedPort::new(locked("a1", "codex", 9), CompleteTransitionRecord::Lost);
        assert!(matches!(
            begin_runtime_transition(&wrong_started, &agent("a1"), RuntimeKind::Codex, 5)
                .await
                .unwrap_err(),
            RuntimeTransitionFault::LockWitnessMismatch { .. }
        ));
    }

    #[tokio::test]
    async fn begin_passes_through_the_refusal_arms() {
        for record in [
            BeginTransitionRecord::NotFound,
            BeginTransitionRecord::Deleting,
            BeginTransitionRecord::InProgress,
        ] {
            let port = ScriptedPort::new(record.clone(), CompleteTransitionRecord::Lost);
            let verdict = begin_runtime_transition(&port, &agent("a1"), RuntimeKind::Codex, 5)
                .await
                .unwrap();
            let expected = match record {
                BeginTransitionRecord::NotFound => BeginTransition::NotFound,
                BeginTransitionRecord::Deleting => BeginTransition::Deleting,
                BeginTransitionRecord::InProgress => BeginTransition::InProgress,
                BeginTransitionRecord::Locked(_) => unreachable!(),
            };
            assert_eq!(verdict, expected);
        }
    }

    #[tokio::test]
    async fn complete_seals_a_faithful_after_image() {
        let (port, lock) = a_sealed_lock().await;
        let CompleteTransition::Committed(sealed) =
            complete_runtime_transition(&port, &lock, &commit(), 42)
                .await
                .unwrap()
        else {
            panic!("expected a committed transition");
        };
        assert_eq!(sealed.agent_id(), &agent("a1"));
        assert_eq!(sealed.runtime(), RuntimeKind::Codex);
        assert_eq!(sealed.model(), Some("gpt"));
        assert_eq!(sealed.reasoning_effort(), Some("high"));
        assert_eq!(sealed.fast_mode(), Some(true));
        assert_eq!(sealed.updated_at(), 42);
    }

    /// Every way the after-image can disagree with the request is a fault, not a success:
    /// wrong agent, any wrong tuning column, a wrong stamp, or an uncleared lock.
    #[tokio::test]
    async fn complete_rejects_an_after_image_that_disagrees() {
        let (_p, lock) = a_sealed_lock().await;

        let mut wrong_agent = faithful_after("a1", 42);
        wrong_agent.agent_id = agent("other");

        let mut wrong_runtime = faithful_after("a1", 42);
        wrong_runtime.runtime = "cursor".to_string();

        let mut missed_model = faithful_after("a1", 42);
        missed_model.model = None;

        let mut wrong_effort = faithful_after("a1", 42);
        wrong_effort.reasoning_effort = Some("low".to_string());

        let mut wrong_fast = faithful_after("a1", 42);
        wrong_fast.fast_mode = Some(0);

        let mut wrong_stamp = faithful_after("a1", 42);
        wrong_stamp.updated_at = 41;

        let mut lock_left = faithful_after("a1", 42);
        lock_left.transition_target = Some("codex".to_string());
        lock_left.transition_started_at = Some(5);

        for after in [
            wrong_agent,
            wrong_runtime,
            missed_model,
            wrong_effort,
            wrong_fast,
            wrong_stamp,
            lock_left,
        ] {
            let port = ScriptedPort::new(
                locked("a1", "codex", 5),
                CompleteTransitionRecord::Committed(after),
            );
            let fault = complete_runtime_transition(&port, &lock, &commit(), 42)
                .await
                .unwrap_err();
            assert!(matches!(
                fault,
                RuntimeTransitionFault::CommitWitnessMismatch { .. }
            ));
        }
    }

    #[tokio::test]
    async fn complete_passes_through_a_lost_guard() {
        let (_p, lock) = a_sealed_lock().await;
        let port = ScriptedPort::new(locked("a1", "codex", 5), CompleteTransitionRecord::Lost);
        assert_eq!(
            complete_runtime_transition(&port, &lock, &commit(), 42)
                .await
                .unwrap(),
            CompleteTransition::Lost
        );
    }
}
