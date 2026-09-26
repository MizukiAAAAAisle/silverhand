//! #2234 CP6: the owned lifecycle boundary for `POST /api/agents`' two post-commit
//! remote legs (the onboarding wake and the runtime start).
//!
//! The create response is sealed (`201`) BEFORE either leg touches the daemon, so each
//! leg is a structurally-independent best-effort effect that must not delay the response
//! and must not let one leg's fault or panic swallow the other. This is the production
//! [`AftermathDispatch`] seam: a narrow, owned tracker — NOT an owner-less detached
//! `tokio::spawn`. It mirrors the agent-deletion resumer's composition PATTERN (a single
//! instance built in `prepare()`, cloned into the route, held by `PreparedApp`, and
//! `close`d FIRST at shutdown while the daemon transport it drives is still alive) without
//! reusing that deletion-marker state machine — the two lifecycles are unrelated.
//!
//! Two owned-lifetime guarantees the tracker enforces (a bare `tokio::spawn` gives
//! neither):
//!   * **Cancellation completes before teardown.** [`CreateAftermath::close`] aborts every
//!     in-flight leg and then AWAITS each handle. `JoinHandle::abort` is only a
//!     cancellation *request* — the task is not dropped until its next poll — so a bare
//!     abort followed immediately by transport teardown races: the leg could still be
//!     mid-poll against a daemon transport that is closing. Awaiting the aborted handle
//!     resolves only after the runtime has DROPPED the leg's future, so when `close`
//!     returns no leg can outlive the transport.
//!   * **Settled legs are reaped without waiting for future traffic, and a panic is
//!     never swallowed.** Each leg catches its OWN unwind at the source (via
//!     `catch_unwind`) and records it the instant it settles, so a panic is observed by
//!     the panicking task itself rather than left latent on a [`JoinError`] for a later
//!     sibling or `close` to read — a read the opportunistic handle prune could otherwise
//!     drop first, permanently under-counting. Each settled leg still prunes its finished
//!     siblings so a burst followed by no further create is not retained until shutdown,
//!     and a panicking leg is isolated to its own task (its siblings and any later leg are
//!     untouched).
//!
//! It is deliberately NOT a general task framework: it owns exactly the create aftermath,
//! and stays a bespoke component until a second consumer justifies a shared abstraction.

use std::panic::AssertUnwindSafe;
use std::sync::{Arc, Mutex};

use futures_util::FutureExt;
use silverhand_backend_server::application_orchestration::agent_create::{
    AftermathDispatch, AftermathLeg,
};
use tokio::task::JoinHandle;

/// The single create-aftermath tracker. A clone shares the one `Arc<Mutex<..>>` state, so
/// the instance the route dispatches into and the instance `PreparedApp` closes at
/// shutdown are the same owner — there is never a second tracker a leg could outlive.
#[derive(Clone)]
pub struct CreateAftermath {
    state: Arc<Mutex<TrackerState>>,
}

struct TrackerState {
    /// Once closed, no further leg is accepted — a shutdown in progress must never hand a
    /// new leg to a daemon transport that is being torn down.
    closed: bool,
    /// The in-flight legs. Each is its OWN spawned task, so a panic is isolated to that
    /// task (the runtime catches it; the sibling leg's task is untouched). A settled leg
    /// prunes its finished siblings as soon as it completes, so the set does not grow
    /// unbounded across a long-lived process even without further dispatch traffic.
    legs: Vec<JoinHandle<()>>,
}

impl CreateAftermath {
    pub fn new() -> Self {
        Self {
            state: Arc::new(Mutex::new(TrackerState {
                closed: false,
                legs: Vec::new(),
            })),
        }
    }

    /// Stop accepting new legs, cancel every in-flight leg, and AWAIT the cancellation to
    /// complete. Called at shutdown FIRST — while the daemon controller and the SQLite
    /// owner the legs touch are both still alive — so a leg mid-flight is not merely asked
    /// to stop but has actually been dropped by the time this returns, ahead of the
    /// transport teardown that follows. Idempotent: a second call finds no handles.
    ///
    /// It is `async` because both production shutdown callers
    /// ([`crate::PreparedApp::close_connections`] and `serve`) are already async and
    /// `await` it before tearing down transports.
    pub async fn close(&self) {
        let handles = {
            let mut state = self.state.lock().expect("create aftermath state");
            state.closed = true;
            std::mem::take(&mut state.legs)
        };
        for handle in handles {
            handle.abort();
            // Resolves only after the runtime has DROPPED the leg's future: an aborted leg
            // resolves cancelled, the benign shutdown outcome. A panic, had one occurred,
            // was already caught and logged by the leg's own task (`dispatch` below), so
            // `close` does not need to inspect the join outcome for it.
            let _ = handle.await;
        }
    }
}

impl Default for CreateAftermath {
    fn default() -> Self {
        Self::new()
    }
}

impl AftermathDispatch for CreateAftermath {
    fn dispatch(&self, leg: AftermathLeg) {
        let mut state = self.state.lock().expect("create aftermath state");
        if state.closed {
            // Shutdown has begun: drop the leg unrun. The `201` is already sealed and the
            // wake/start are best-effort live intentions (not durable state), so a dropped
            // leg is a benign miss, never a lost commit.
            return;
        }
        // Opportunistic prune keeps the common path bounded even before the self-reap
        // below fires (e.g. the very first dispatch after a long idle). It drops FINISHED
        // handles without inspecting their join outcome, which is sound only because a
        // panic is caught and logged at the source below — never left latent on a
        // `JoinError` for this prune to discard unread.
        state.legs.retain(|handle| !handle.is_finished());
        let weak = Arc::downgrade(&self.state);
        state.legs.push(tokio::spawn(async move {
            // Log at the source before a completed handle can be pruned. A panic in
            // best-effort work must remain visible without any later dispatch or close.
            if AssertUnwindSafe(leg).catch_unwind().await.is_err() {
                tracing::error!("create-aftermath leg panicked");
            }
            // Self-reap: the instant this leg settles it prunes its FINISHED siblings, so a
            // burst that is never followed by another dispatch is not retained until
            // shutdown. Its own handle is still running (not finished), so it stays until
            // the next sibling settles or `close` drains it — a single residual handle,
            // never the batch. Panic reporting is already done above; this is purely
            // handle-set bounding. Best-effort: skip if the tracker is gone.
            if let Some(state) = weak.upgrade() {
                state
                    .lock()
                    .expect("create aftermath state")
                    .legs
                    .retain(|handle| !handle.is_finished());
            }
        }));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
    use std::time::Duration;
    use tokio::sync::Notify;
    use tokio::time::timeout;

    /// Sets a flag when dropped — the witness that a leg's FUTURE has actually been
    /// dropped (cancellation completed), not merely that its business tail did not run.
    struct DropFlag(Arc<AtomicBool>);
    impl Drop for DropFlag {
        fn drop(&mut self) {
            self.0.store(true, Ordering::SeqCst);
        }
    }

    /// A leg handed to the tracker is actually run.
    #[tokio::test]
    async fn a_dispatched_leg_runs() {
        let tracker = CreateAftermath::new();
        let ran = Arc::new(AtomicUsize::new(0));
        let done = Arc::new(Notify::new());
        {
            let ran = ran.clone();
            let done = done.clone();
            tracker.dispatch(Box::pin(async move {
                ran.fetch_add(1, Ordering::SeqCst);
                done.notify_one();
            }));
        }
        timeout(Duration::from_secs(5), done.notified())
            .await
            .expect("the dispatched leg must run");
        assert_eq!(ran.load(Ordering::SeqCst), 1);
    }

    /// `close` cancels a leg that is still in flight AND waits for the cancellation to
    /// complete: a leg parked on remote IO is aborted, its future is dropped before
    /// `close().await` returns (the `DropFlag` proves it), and the handle set is drained.
    /// This is the shutdown-cancels-in-flight boundary — a leg must never outlive the
    /// transport it drives, and the drain-await is what makes that true rather than a
    /// best-hope. (Revert `close` to a bare synchronous abort with no await and the
    /// `dropped-after-close` assertion below reddens: on the current-thread runtime the
    /// aborted task has not yet been polled, so its future — and its `DropFlag` — is still
    /// alive when a non-awaiting `close` returns.)
    #[tokio::test]
    async fn close_awaits_cancellation_of_an_in_flight_leg() {
        let tracker = CreateAftermath::new();
        let started = Arc::new(AtomicUsize::new(0));
        let dropped = Arc::new(AtomicBool::new(false));
        let parked = Arc::new(Notify::new());
        let never = Arc::new(Notify::new());
        let finished = Arc::new(Notify::new());
        {
            let started = started.clone();
            let drop_flag = DropFlag(dropped.clone());
            let parked = parked.clone();
            let never = never.clone();
            let finished = finished.clone();
            tracker.dispatch(Box::pin(async move {
                // Keep the guard alive across the await so its drop marks the cancellation.
                let _drop_flag = drop_flag;
                started.fetch_add(1, Ordering::SeqCst);
                parked.notify_one();
                // Blocks until someone fires `never` — which the test only does AFTER the
                // close, so a still-running leg would reach `finished` but an aborted one
                // never resumes past this await.
                never.notified().await;
                finished.notify_one();
            }));
        }
        timeout(Duration::from_secs(5), parked.notified())
            .await
            .expect("the leg must reach its await point");
        assert!(
            !dropped.load(Ordering::SeqCst),
            "the leg is still parked, not dropped"
        );

        tracker.close().await;
        assert!(
            dropped.load(Ordering::SeqCst),
            "close().await must not return until the aborted leg's future is dropped"
        );

        // Firing `never` now must not resurrect the aborted leg.
        never.notify_one();
        assert!(
            timeout(Duration::from_millis(200), finished.notified())
                .await
                .is_err(),
            "the in-flight leg was aborted by close and never completes"
        );
        assert_eq!(started.load(Ordering::SeqCst), 1, "the leg had started");
    }

    /// A dispatch after `close` is a silent no-op: no task is spawned and the leg never
    /// runs. Shutdown must never hand a fresh leg to a transport being torn down.
    #[tokio::test]
    async fn dispatch_after_close_is_a_no_op() {
        let tracker = CreateAftermath::new();
        tracker.close().await;
        let (sent, mut received) = tokio::sync::oneshot::channel();
        tracker.dispatch(Box::pin(async move {
            let _ = sent.send(());
        }));
        assert_eq!(
            received.try_recv(),
            Err(tokio::sync::oneshot::error::TryRecvError::Closed),
            "closed dispatch drops the future immediately without executing it"
        );
    }

    /// Settled legs are reaped WITHOUT a further dispatch: a burst of legs that all
    /// complete does not retain the whole batch until shutdown. As each leg settles it
    /// prunes its finished siblings, so the set converges to at most one residual handle
    /// (the last-settling leg cannot reap its own still-running task) purely on task
    /// completion — no new business request required.
    #[tokio::test]
    async fn settled_legs_are_reaped_without_a_further_dispatch() {
        let tracker = CreateAftermath::new();
        let remaining = Arc::new(AtomicUsize::new(4));
        let all_done = Arc::new(Notify::new());
        for _ in 0..4 {
            let remaining = remaining.clone();
            let all_done = all_done.clone();
            tracker.dispatch(Box::pin(async move {
                if remaining.fetch_sub(1, Ordering::SeqCst) == 1 {
                    all_done.notify_one();
                }
            }));
        }
        timeout(Duration::from_secs(5), all_done.notified())
            .await
            .expect("all four legs must run");
        // Let the self-reap tasks settle.
        for _ in 0..32 {
            tokio::task::yield_now().await;
        }
        let retained = tracker.state.lock().unwrap().legs.len();
        assert!(
            retained <= 1,
            "settled legs are reaped on completion, leaving at most one residual handle, not \
             the whole batch (found {})",
            retained
        );
    }

    /// A panic must emit an operational error before another dispatch or shutdown.
    /// A retained internal counter alone would not prove anyone can diagnose it.
    #[test]
    fn a_panicking_leg_is_observed_at_the_source_before_any_reaping() {
        let log = tempfile::NamedTempFile::new().unwrap();
        let subscriber = tracing_subscriber::fmt()
            .json()
            .with_max_level(tracing::Level::ERROR)
            .with_writer(Arc::new(log.reopen().unwrap()))
            .finish();
        // Every task runs on this thread. No worker pool crosses the local subscriber;
        // SQLx integration tests use the separate process/global-subscriber harness.
        let _subscriber = tracing::subscriber::set_default(subscriber);
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        runtime.block_on(async {
            let tracker = CreateAftermath::new();
            tracker.dispatch(Box::pin(async { panic!("leg blew up") }));
            timeout(Duration::from_secs(5), async {
                while std::fs::read(log.path()).unwrap().is_empty() {
                    tokio::task::yield_now().await;
                }
            })
            .await
            .expect("panic must be logged without a sibling or close");

            for _ in 0..2 {
                let (sent, received) = tokio::sync::oneshot::channel();
                tracker.dispatch(Box::pin(async move { sent.send(()).unwrap() }));
                timeout(Duration::from_secs(5), received)
                    .await
                    .expect("tracker still dispatches after panic")
                    .unwrap();
            }
            let entries: Vec<serde_json::Value> = std::fs::read_to_string(log.path())
                .unwrap()
                .lines()
                .map(|line| serde_json::from_str(line).unwrap())
                .collect();
            assert_eq!(
                entries.len(),
                1,
                "reaping must not lose or duplicate the error"
            );
            assert_eq!(entries[0]["level"], "ERROR");
            assert_eq!(
                entries[0]["fields"]["message"],
                "create-aftermath leg panicked"
            );
            tracker.close().await;
        });
    }
}
