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
//! It is deliberately NOT a general task framework: it owns exactly the create aftermath,
//! and stays a bespoke component until a second consumer justifies a shared abstraction.

use std::sync::{Arc, Mutex};

use silverhand_backend_server::host_agent::agent_create::{AftermathDispatch, AftermathLeg};
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
    /// task (the runtime catches it; the sibling leg's task is untouched). Finished and
    /// panicked handles are recycled on the next dispatch, so a long-lived process never
    /// accumulates an unbounded set of completed handles.
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

    /// Stop accepting new legs and cancel every in-flight leg. Idempotent. Called at
    /// shutdown FIRST — synchronously, while the daemon controller and the SQLite owner the
    /// legs touch are both still alive — so a leg mid-flight is aborted rather than racing a
    /// half-torn-down transport, and no leg dispatched after this point ever runs.
    pub fn close(&self) {
        let mut state = self.state.lock().expect("create aftermath state");
        state.closed = true;
        for leg in state.legs.drain(..) {
            leg.abort();
        }
    }

    /// The count of retained leg handles. Test-only observability: it lets the composition
    /// close-wiring witness prove a post-shutdown dispatch was rejected (stays `0`) and the
    /// unit tests prove completed handles are recycled rather than accumulated.
    #[cfg(test)]
    pub(crate) fn in_flight_len(&self) -> usize {
        self.state
            .lock()
            .expect("create aftermath state")
            .legs
            .len()
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
        // Recycle completed/panicked handles so the set never grows unbounded across a
        // long-lived process's create traffic.
        state.legs.retain(|handle| !handle.is_finished());
        state.legs.push(tokio::spawn(leg));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::time::Duration;
    use tokio::sync::Notify;
    use tokio::time::timeout;

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

    /// `close` cancels a leg that is still in flight: a leg parked on remote IO is aborted
    /// before it can complete, and the handle set is drained. This is the shutdown-cancels-
    /// in-flight boundary — a leg must never outlive the transport it drives.
    #[tokio::test]
    async fn close_cancels_an_in_flight_leg() {
        let tracker = CreateAftermath::new();
        let started = Arc::new(AtomicUsize::new(0));
        let parked = Arc::new(Notify::new());
        let never = Arc::new(Notify::new());
        let finished = Arc::new(Notify::new());
        {
            let started = started.clone();
            let parked = parked.clone();
            let never = never.clone();
            let finished = finished.clone();
            tracker.dispatch(Box::pin(async move {
                started.fetch_add(1, Ordering::SeqCst);
                parked.notify_one();
                // Blocks until someone fires `never` — which the test only does AFTER the
                // abort, so a still-running leg would reach `finished` but an aborted one
                // never resumes past this await.
                never.notified().await;
                finished.notify_one();
            }));
        }
        timeout(Duration::from_secs(5), parked.notified())
            .await
            .expect("the leg must reach its await point");
        assert_eq!(tracker.in_flight_len(), 1, "one leg is in flight");

        tracker.close();
        assert_eq!(tracker.in_flight_len(), 0, "close drains the handle set");

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
        tracker.close();
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
        assert_eq!(tracker.in_flight_len(), 0, "no leg is spawned after close");
        assert!(
            timeout(Duration::from_millis(200), done.notified())
                .await
                .is_err(),
            "a leg dispatched after close never runs"
        );
        assert_eq!(ran.load(Ordering::SeqCst), 0);
    }

    /// Completed handles are recycled on the next dispatch, so a long-lived process never
    /// accumulates finished handles. A first leg runs to completion, is still retained
    /// (nothing prunes eagerly), then the next dispatch drops it before pushing — the set
    /// holds exactly one live handle, not two.
    #[tokio::test]
    async fn completed_handles_are_recycled_on_next_dispatch() {
        let tracker = CreateAftermath::new();
        let done1 = Arc::new(Notify::new());
        {
            let done1 = done1.clone();
            tracker.dispatch(Box::pin(async move {
                done1.notify_one();
            }));
        }
        timeout(Duration::from_secs(5), done1.notified())
            .await
            .expect("first leg must run");
        // Let the completed task settle so its handle reports finished.
        for _ in 0..16 {
            tokio::task::yield_now().await;
        }
        assert_eq!(
            tracker.in_flight_len(),
            1,
            "the finished handle is still retained until the next dispatch prunes it"
        );

        let done2 = Arc::new(Notify::new());
        {
            let done2 = done2.clone();
            tracker.dispatch(Box::pin(async move {
                done2.notify_one();
            }));
        }
        assert_eq!(
            tracker.in_flight_len(),
            1,
            "the finished first handle was recycled; only the new leg remains"
        );
    }

    /// A panicking leg is isolated to its own task: the runtime catches the panic, the
    /// sibling leg still runs, and the tracker's lock is not poisoned — a later dispatch
    /// still works.
    #[tokio::test]
    async fn a_panicking_leg_does_not_poison_the_tracker() {
        let tracker = CreateAftermath::new();
        tracker.dispatch(Box::pin(async {
            panic!("leg blew up");
        }));

        let sibling_ran = Arc::new(AtomicUsize::new(0));
        let sibling_done = Arc::new(Notify::new());
        {
            let sibling_ran = sibling_ran.clone();
            let sibling_done = sibling_done.clone();
            tracker.dispatch(Box::pin(async move {
                sibling_ran.fetch_add(1, Ordering::SeqCst);
                sibling_done.notify_one();
            }));
        }
        timeout(Duration::from_secs(5), sibling_done.notified())
            .await
            .expect("the sibling leg must run despite the panicking leg");
        assert_eq!(sibling_ran.load(Ordering::SeqCst), 1);

        // The tracker still accepts work — its Mutex was never poisoned by the panic.
        let later_ran = Arc::new(AtomicUsize::new(0));
        let later_done = Arc::new(Notify::new());
        {
            let later_ran = later_ran.clone();
            let later_done = later_done.clone();
            tracker.dispatch(Box::pin(async move {
                later_ran.fetch_add(1, Ordering::SeqCst);
                later_done.notify_one();
            }));
        }
        timeout(Duration::from_secs(5), later_done.notified())
            .await
            .expect("the tracker still dispatches after a panicking leg");
        assert_eq!(later_ran.load(Ordering::SeqCst), 1);
    }
}
