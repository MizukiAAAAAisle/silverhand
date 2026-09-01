//! When a human's offline fact actually fires: one grace timer per user, held
//! only in this process.

use std::{
    collections::{HashMap, HashSet},
    sync::{Arc, Mutex},
    time::Duration,
};

use silverhand_backend_core::{
    foundation::identity::UserId,
    policy::presence_grace::{GraceWindow, PresenceFact, is_online, on_connect, on_disconnect},
    viewer_read_model::user_presence_last_seen::LastSeenSink,
};
use tokio::task::JoinHandle;

use crate::foundation::error;

/// Publication of a decided presence fact on the app scope. Publishing is
/// fallible because the live transport is, and it runs while the presence state
/// lock is held so that fact order equals transition order; an implementation
/// must therefore neither block nor call back into the timers.
pub trait PresenceFactSink: Clone + Send + Sync + 'static {
    type Error: std::error::Error + Send + Sync + 'static;

    fn publish(&self, fact: PresenceFact) -> Result<(), Self::Error>;
}

struct PendingOffline {
    epoch: u64,
    handle: JoinHandle<()>,
}

#[derive(Default)]
struct Tracked {
    connections: HashMap<UserId, HashSet<String>>,
    pending: HashMap<UserId, PendingOffline>,
    epochs: u64,
}

impl Tracked {
    /// Whether this exact grace window still owns the user's offline decision.
    fn owns(&self, user_id: &UserId, epoch: u64) -> bool {
        self.pending
            .get(user_id)
            .is_some_and(|pending| pending.epoch == epoch)
    }

    fn cancel_pending(&mut self, user_id: &UserId) {
        if let Some(pending) = self.pending.remove(user_id) {
            pending.handle.abort();
        }
    }
}

/// Presence is a live view of this process's connections: a restart loses every
/// pending window, exactly as the process-local registry it replaces does.
pub struct PresenceGraceTimers<L, S> {
    tracked: Arc<Mutex<Tracked>>,
    last_seen: L,
    facts: S,
    grace: GraceWindow,
}

impl<L, S> Clone for PresenceGraceTimers<L, S>
where
    L: Clone,
    S: Clone,
{
    fn clone(&self) -> Self {
        Self {
            tracked: Arc::clone(&self.tracked),
            last_seen: self.last_seen.clone(),
            facts: self.facts.clone(),
            grace: self.grace,
        }
    }
}

impl<L, S> PresenceGraceTimers<L, S>
where
    L: LastSeenSink,
    S: PresenceFactSink,
{
    pub fn new(last_seen: L, facts: S, grace: GraceWindow) -> Self {
        Self {
            tracked: Arc::new(Mutex::new(Tracked::default())),
            last_seen,
            facts,
            grace,
        }
    }

    pub fn on_connect(&self, user_id: &UserId, connection_id: &str) {
        let mut tracked = self.tracked.lock().expect("presence state");
        let already_online = is_online(
            tracked.connections.contains_key(user_id),
            tracked.pending.contains_key(user_id),
        );
        tracked.cancel_pending(user_id);
        tracked
            .connections
            .entry(user_id.clone())
            .or_default()
            .insert(connection_id.to_owned());
        if let Some(fact) = on_connect(user_id, already_online).1 {
            self.announce(fact);
        }
    }

    pub fn on_disconnect(&self, user_id: &UserId, connection_id: &str, now: i64) {
        let mut tracked = self.tracked.lock().expect("presence state");
        let Some(connections) = tracked.connections.get_mut(user_id) else {
            return;
        };
        let removed = connections.remove(connection_id);
        let remaining = connections.len();
        // The map never holds an empty connection set. A user whose last
        // connection just dropped is evicted HERE — before the fallible clock is
        // consulted — so every later arm (unknown id, remaining connection,
        // scheduled window, AND unwire-able instant) inherits a consistent map.
        // Without this, the `Err` arm's early return would strand an empty set,
        // and `is_online`'s `contains_key` would report a ghost-online viewer
        // whose physical connection is already gone.
        if remaining == 0 {
            tracked.connections.remove(user_id);
        }
        let schedule = match on_disconnect(user_id, removed, remaining, now) {
            Ok(Some(schedule)) => schedule,
            Ok(None) => return,
            Err(out_of_range) => {
                // The disconnect clock produced an instant the wire cannot carry:
                // a named fault, never a scheduled window — no offline is persisted
                // or published, so an illegal stamp reaches neither side. The
                // dropped connection is already evicted above, so no ghost remains.
                tracing::error!(
                    user_id = %user_id.as_str(),
                    error_chain = %error::describe(&out_of_range),
                    "presence: disconnect clock is not a wire-safe last_seen_at; no offline scheduled"
                );
                return;
            }
        };
        tracked.cancel_pending(user_id);
        tracked.epochs += 1;
        let epoch = tracked.epochs;

        let timers = self.clone();
        let owner = user_id.clone();
        let grace = self.grace.millis().max(0) as u64;
        let handle = tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(grace)).await;

            // The window keeps its entry across the write, so the viewer still
            // counts as present while the transition is in flight: a reconnect
            // during persistence can neither be announced and then contradicted
            // by this window, nor let this window commit behind that announce.
            if !timers
                .tracked
                .lock()
                .expect("presence state")
                .owns(&owner, epoch)
            {
                return;
            }

            let persisted = timers
                .last_seen
                .touch_last_seen(owner.clone(), schedule.disconnected_at())
                .await;

            let mut tracked = timers.tracked.lock().expect("presence state");
            if !tracked.owns(&owner, epoch) {
                return;
            }
            let reconnected = tracked.connections.contains_key(&owner);
            tracked.pending.remove(&owner);
            if let Err(error) = persisted {
                tracing::warn!(
                    user_id = %owner.as_str(),
                    last_seen_at = schedule.disconnected_at().get(),
                    error_chain = %error::describe(&error),
                    "presence: failed to persist last_seen_at"
                );
            }
            if let Some(outcome) = schedule.elapsed(reconnected) {
                timers.announce(outcome.publish);
            }
        });
        tracked
            .pending
            .insert(user_id.clone(), PendingOffline { epoch, handle });
    }

    /// Removes a single connection with no offline decision whatsoever: no clock
    /// is read, no window is scheduled, and nothing is persisted or published. The
    /// presence feed calls this — never `on_disconnect` — when its wall clock
    /// cannot seal a last-seen instant: the gone connection must still leave the
    /// live set so the viewer is not stranded online, but a clock fault is not a
    /// last-seen fact and the audit belongs to the feed, so this path is silent.
    /// A pending window from an earlier disconnect is untouched — it owns its own
    /// offline decision.
    pub fn evict(&self, user_id: &UserId, connection_id: &str) {
        let mut tracked = self.tracked.lock().expect("presence state");
        let Some(connections) = tracked.connections.get_mut(user_id) else {
            return;
        };
        connections.remove(connection_id);
        if connections.is_empty() {
            tracked.connections.remove(user_id);
        }
    }

    pub fn is_online(&self, user_id: &UserId) -> bool {
        let tracked = self.tracked.lock().expect("presence state");
        is_online(
            tracked.connections.contains_key(user_id),
            tracked.pending.contains_key(user_id),
        )
    }

    /// Drops every pending window without publishing. A pending offline is a
    /// live intention, not a durable one, so shutdown must not emit it.
    pub fn dispose(&self) {
        let mut tracked = self.tracked.lock().expect("presence state");
        let users = tracked.pending.keys().cloned().collect::<Vec<_>>();
        for user_id in users {
            tracked.cancel_pending(&user_id);
        }
        tracked.connections.clear();
    }

    /// A live publication failure never reverses the transition it describes:
    /// the durable last-seen value stands and the loss is audited once.
    fn announce(&self, fact: PresenceFact) {
        if let Err(error) = self.facts.publish(fact) {
            tracing::warn!(
                error_chain = %error::describe(&error),
                "presence: failed to publish a presence fact"
            );
        }
    }
}

#[cfg(test)]
mod tests {
    use std::{
        convert::Infallible,
        io::{self, Write},
    };

    use silverhand_backend_core::cold_read::presence::LastSeenAt;
    use silverhand_backend_core::foundation::persistence::PersistenceFailure;
    use thiserror::Error;
    use tokio::sync::{
        Semaphore,
        mpsc::{UnboundedReceiver, UnboundedSender, unbounded_channel},
    };
    use tracing_subscriber::fmt::MakeWriter;

    use super::*;

    const GRACE_MS: i64 = 20_000;

    #[derive(Debug, Error)]
    #[error("transport registry poisoned")]
    struct TransportPoisoned;

    #[derive(Debug, Error)]
    #[error("presence fact rejected")]
    struct PublishRejected {
        #[source]
        source: TransportPoisoned,
    }

    #[derive(Clone)]
    struct RecordingSinks {
        facts: UnboundedSender<PresenceFact>,
        touched: UnboundedSender<(UserId, i64)>,
        fail_persist: bool,
        fail_publish: bool,
        hold: Option<Arc<Semaphore>>,
    }

    impl LastSeenSink for RecordingSinks {
        async fn touch_last_seen(
            &self,
            user_id: UserId,
            last_seen_at: LastSeenAt,
        ) -> Result<(), PersistenceFailure> {
            self.touched.send((user_id, last_seen_at.get())).unwrap();
            if let Some(hold) = &self.hold {
                let _permit = hold.acquire().await.expect("write barrier");
            }
            if self.fail_persist {
                return Err(PersistenceFailure::from_source(std::io::Error::other(
                    "disk gone",
                )));
            }
            Ok(())
        }
    }

    impl PresenceFactSink for RecordingSinks {
        type Error = PublishRejected;

        fn publish(&self, fact: PresenceFact) -> Result<(), Self::Error> {
            self.facts.send(fact).unwrap();
            if self.fail_publish {
                return Err(PublishRejected {
                    source: TransportPoisoned,
                });
            }
            Ok(())
        }
    }

    #[derive(Default)]
    struct Sinks {
        fail_persist: bool,
        fail_publish: bool,
        hold: Option<Arc<Semaphore>>,
    }

    struct Harness {
        timers: PresenceGraceTimers<RecordingSinks, RecordingSinks>,
        facts: UnboundedReceiver<PresenceFact>,
        touched: UnboundedReceiver<(UserId, i64)>,
    }

    fn build(sinks: Sinks) -> Harness {
        let (facts_tx, facts) = unbounded_channel();
        let (touched_tx, touched) = unbounded_channel();
        let recording = RecordingSinks {
            facts: facts_tx,
            touched: touched_tx,
            fail_persist: sinks.fail_persist,
            fail_publish: sinks.fail_publish,
            hold: sinks.hold,
        };
        Harness {
            timers: PresenceGraceTimers::new(
                recording.clone(),
                recording,
                GraceWindow::from_millis_or_default(Some(GRACE_MS)),
            ),
            facts,
            touched,
        }
    }

    fn harness() -> Harness {
        build(Sinks::default())
    }

    /// The returned barrier holds the last-seen write open until it is given a
    /// permit, so a test can act while the transition is in flight.
    fn harness_holding_the_write() -> (Harness, Arc<Semaphore>) {
        let barrier = Arc::new(Semaphore::new(0));
        (
            build(Sinks {
                hold: Some(Arc::clone(&barrier)),
                ..Sinks::default()
            }),
            barrier,
        )
    }

    /// Virtual time only: reaching the deadline is an explicit step, so a
    /// negative assertion states "the deadline passed and nothing happened"
    /// rather than "the test did not wait long enough".
    async fn reach_the_deadline() {
        // A window registers its sleep the first time its task is polled, so the
        // clock may only move once every started window is actually waiting.
        settle().await;
        tokio::time::advance(Duration::from_millis(GRACE_MS as u64 + 1)).await;
        settle().await;
    }

    /// Lets every runnable task drain. No wall-clock time is involved.
    async fn settle() {
        for _ in 0..16 {
            tokio::task::yield_now().await;
        }
    }

    fn user(id: &str) -> UserId {
        UserId::parse(id).unwrap()
    }

    fn online(id: &str) -> PresenceFact {
        PresenceFact::Online { user_id: user(id) }
    }

    fn offline(id: &str, last_seen_at: i64) -> PresenceFact {
        PresenceFact::Offline {
            user_id: user(id),
            last_seen_at: LastSeenAt::from_stored(last_seen_at).unwrap(),
        }
    }

    #[tokio::test(start_paused = true)]
    async fn a_first_connection_publishes_online_once_per_transition() {
        let mut h = harness();
        h.timers.on_connect(&user("user-1"), "c1");
        h.timers.on_connect(&user("user-1"), "c2");
        settle().await;

        assert_eq!(h.facts.try_recv().unwrap(), online("user-1"));
        assert!(h.facts.try_recv().is_err());
        assert!(h.timers.is_online(&user("user-1")));
    }

    #[tokio::test(start_paused = true)]
    async fn the_offline_fact_dates_from_the_disconnect_not_the_expiry() {
        let mut h = harness();
        h.timers.on_connect(&user("user-1"), "c1");
        h.timers
            .on_disconnect(&user("user-1"), "c1", 1_700_000_000_123);
        assert!(h.timers.is_online(&user("user-1")));

        reach_the_deadline().await;

        assert_eq!(h.facts.try_recv().unwrap(), online("user-1"));
        assert_eq!(
            h.facts.try_recv().unwrap(),
            offline("user-1", 1_700_000_000_123)
        );
        assert_eq!(
            h.touched.try_recv().unwrap(),
            (user("user-1"), 1_700_000_000_123)
        );
        assert!(!h.timers.is_online(&user("user-1")));
    }

    #[tokio::test(start_paused = true)]
    async fn a_reconnect_inside_the_window_cancels_the_offline_fact_and_stays_quiet() {
        let mut h = harness();
        h.timers.on_connect(&user("user-1"), "c1");
        h.timers.on_disconnect(&user("user-1"), "c1", 10);
        assert!(h.timers.is_online(&user("user-1")));
        h.timers.on_connect(&user("user-1"), "c2");
        assert_eq!(h.facts.try_recv().unwrap(), online("user-1"));

        reach_the_deadline().await;

        assert!(h.facts.try_recv().is_err());
        assert!(h.touched.try_recv().is_err());
        assert!(h.timers.is_online(&user("user-1")));
    }

    #[tokio::test(start_paused = true)]
    async fn a_superseded_window_stays_silent_and_the_newer_one_publishes_once() {
        let mut h = harness();
        h.timers.on_connect(&user("user-1"), "c1");
        h.timers.on_disconnect(&user("user-1"), "c1", 10);
        h.timers.on_connect(&user("user-1"), "c2");
        h.timers.on_disconnect(&user("user-1"), "c2", 20);

        reach_the_deadline().await;

        assert_eq!(h.facts.try_recv().unwrap(), online("user-1"));
        assert_eq!(h.facts.try_recv().unwrap(), offline("user-1", 20));
        assert!(h.facts.try_recv().is_err());
        assert_eq!(h.touched.try_recv().unwrap(), (user("user-1"), 20));
        assert!(h.touched.try_recv().is_err());
    }

    #[tokio::test(start_paused = true)]
    async fn a_remaining_connection_starts_no_window() {
        let mut h = harness();
        h.timers.on_connect(&user("user-1"), "c1");
        h.timers.on_connect(&user("user-1"), "c2");
        h.timers.on_disconnect(&user("user-1"), "c1", 10);

        reach_the_deadline().await;

        assert_eq!(h.facts.try_recv().unwrap(), online("user-1"));
        assert!(h.facts.try_recv().is_err());
        assert!(h.touched.try_recv().is_err());
        assert!(h.timers.is_online(&user("user-1")));
    }

    #[tokio::test(start_paused = true)]
    async fn an_unknown_connection_id_changes_nothing() {
        let mut h = harness();
        h.timers.on_connect(&user("user-1"), "c1");
        h.timers.on_disconnect(&user("user-1"), "other", 10);
        h.timers.on_disconnect(&user("user-2"), "c1", 10);

        reach_the_deadline().await;

        assert_eq!(h.facts.try_recv().unwrap(), online("user-1"));
        assert!(h.facts.try_recv().is_err());
        assert!(h.touched.try_recv().is_err());
        assert!(h.timers.is_online(&user("user-1")));
    }

    #[tokio::test(start_paused = true)]
    async fn dispose_drops_pending_windows_without_publishing() {
        let mut h = harness();
        h.timers.on_connect(&user("user-1"), "c1");
        h.timers.on_disconnect(&user("user-1"), "c1", 10);
        h.timers.dispose();
        assert!(!h.timers.is_online(&user("user-1")));

        reach_the_deadline().await;

        assert_eq!(h.facts.try_recv().unwrap(), online("user-1"));
        assert!(h.facts.try_recv().is_err());
        assert!(h.touched.try_recv().is_err());
    }

    #[tokio::test(start_paused = true)]
    async fn a_reconnect_during_the_last_seen_write_never_publishes_a_stale_offline() {
        let (mut h, barrier) = harness_holding_the_write();
        h.timers.on_connect(&user("user-1"), "c1");
        h.timers.on_disconnect(&user("user-1"), "c1", 42);

        reach_the_deadline().await;

        // The transition is in flight: the write was entered and is blocked, and
        // the viewer still counts as present because the window holds its entry.
        assert_eq!(h.touched.try_recv().unwrap(), (user("user-1"), 42));
        assert_eq!(h.facts.try_recv().unwrap(), online("user-1"));
        assert!(h.facts.try_recv().is_err());
        assert!(h.timers.is_online(&user("user-1")));

        h.timers.on_connect(&user("user-1"), "c2");
        barrier.add_permits(1);
        settle().await;

        assert!(h.timers.is_online(&user("user-1")));
        assert!(
            h.facts.try_recv().is_err(),
            "a viewer that is present again must be neither re-announced nor described as absent"
        );
    }

    #[tokio::test(start_paused = true)]
    async fn a_failed_last_seen_write_still_publishes_offline_and_audits_the_chain() {
        let logs = LogBuffer::default();
        let _guard = tracing::subscriber::set_default(json_subscriber(&logs));
        let mut h = build(Sinks {
            fail_persist: true,
            ..Sinks::default()
        });
        h.timers.on_connect(&user("user-1"), "c1");
        h.timers.on_disconnect(&user("user-1"), "c1", 42);

        reach_the_deadline().await;

        assert_eq!(h.facts.try_recv().unwrap(), online("user-1"));
        assert_eq!(h.facts.try_recv().unwrap(), offline("user-1", 42));
        assert_eq!(
            logs.chains("presence: failed to persist last_seen_at"),
            vec!["persistence operation failed: disk gone".to_owned()]
        );
    }

    #[tokio::test(start_paused = true)]
    async fn a_failed_publication_is_audited_once_per_lost_fact_with_its_full_chain() {
        let logs = LogBuffer::default();
        let _guard = tracing::subscriber::set_default(json_subscriber(&logs));
        let h = build(Sinks {
            fail_publish: true,
            ..Sinks::default()
        });
        h.timers.on_connect(&user("user-1"), "c1");
        h.timers.on_disconnect(&user("user-1"), "c1", 42);

        reach_the_deadline().await;

        // Two lost facts, two audit lines, and the transition still committed.
        assert_eq!(
            logs.chains("presence: failed to publish a presence fact"),
            vec![
                "presence fact rejected: transport registry poisoned".to_owned(),
                "presence fact rejected: transport registry poisoned".to_owned(),
            ]
        );
        assert!(!h.timers.is_online(&user("user-1")));
    }

    #[tokio::test(start_paused = true)]
    async fn an_invalid_disconnect_clock_clears_the_connection_and_never_ghosts_online() {
        use silverhand_backend_core::cold_read::presence::MAX_SAFE_INTEGER;

        let mut h = harness();
        // Both wire-unsafe boundaries: below range and above MAX_SAFE_INTEGER.
        for (id, bad_clock) in [("user-neg", -1), ("user-max", MAX_SAFE_INTEGER + 1)] {
            h.timers.on_connect(&user(id), "c1");
            assert_eq!(h.facts.try_recv().unwrap(), online(id));
            assert!(h.timers.is_online(&user(id)));

            // The last connection drops with an unwire-able instant: a named
            // fault, so nothing is scheduled, persisted, or published...
            h.timers.on_disconnect(&user(id), "c1", bad_clock);
            reach_the_deadline().await;
            assert!(h.facts.try_recv().is_err());
            assert!(h.touched.try_recv().is_err());
            // ...but the gone connection must leave NO ghost-online empty entry.
            assert!(
                !h.timers.is_online(&user(id)),
                "an invalid disconnect clock stranded {id} ghost-online"
            );

            // A legal reconnect is therefore a genuine transition again, and must
            // announce Online exactly once — impossible if the stale empty entry
            // had made it look `already_online`.
            h.timers.on_connect(&user(id), "c2");
            settle().await;
            assert_eq!(h.facts.try_recv().unwrap(), online(id));
            assert!(h.facts.try_recv().is_err());
            assert!(h.timers.is_online(&user(id)));
        }
    }

    #[tokio::test(start_paused = true)]
    async fn an_infallible_sink_needs_no_error_type_of_its_own() {
        #[derive(Clone)]
        struct NoEffects;

        impl LastSeenSink for NoEffects {
            async fn touch_last_seen(
                &self,
                _user_id: UserId,
                _last_seen_at: LastSeenAt,
            ) -> Result<(), PersistenceFailure> {
                Ok(())
            }
        }

        impl PresenceFactSink for NoEffects {
            type Error = Infallible;

            fn publish(&self, _fact: PresenceFact) -> Result<(), Self::Error> {
                Ok(())
            }
        }

        let timers = PresenceGraceTimers::new(
            NoEffects,
            NoEffects,
            GraceWindow::from_millis_or_default(Some(GRACE_MS)),
        );
        timers.on_connect(&user("user-1"), "c1");
        timers.on_disconnect(&user("user-1"), "c1", 10);

        reach_the_deadline().await;

        assert!(!timers.is_online(&user("user-1")));
    }

    fn json_subscriber(logs: &LogBuffer) -> impl tracing::Subscriber + Send + Sync {
        tracing_subscriber::fmt()
            .json()
            .without_time()
            .with_target(false)
            .with_writer(logs.clone())
            .finish()
    }

    #[derive(Clone, Default)]
    struct LogBuffer(Arc<Mutex<Vec<u8>>>);

    impl LogBuffer {
        fn chains(&self, message: &str) -> Vec<String> {
            let bytes = self.0.lock().unwrap().clone();
            String::from_utf8(bytes)
                .unwrap()
                .lines()
                .map(|line| serde_json::from_str::<serde_json::Value>(line).unwrap())
                .filter(|event| event["fields"]["message"] == message)
                .map(|event| event["fields"]["error_chain"].as_str().unwrap().to_owned())
                .collect()
        }
    }

    struct LogWriter(LogBuffer);

    impl Write for LogWriter {
        fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
            self.0.0.lock().unwrap().extend_from_slice(bytes);
            Ok(bytes.len())
        }

        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }

    impl<'a> MakeWriter<'a> for LogBuffer {
        type Writer = LogWriter;

        fn make_writer(&'a self) -> Self::Writer {
            LogWriter(self.clone())
        }
    }
}
