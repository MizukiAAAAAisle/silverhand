//! When a human's offline fact actually fires: one grace timer per user, held
//! only in this process.

use std::{
    collections::{HashMap, HashSet},
    future::Future,
    sync::{Arc, Mutex},
    time::Duration,
};

use silverhand_backend_core::{
    identity::UserId,
    persistence::PersistenceFailure,
    policy::presence_grace::{GraceWindow, PresenceFact, is_online, on_connect, on_disconnect},
};
use tokio::task::JoinHandle;

/// Last-seen persistence. Takes the decided value; it never reads state back.
pub trait LastSeenSink: Clone + Send + Sync + 'static {
    fn touch_last_seen(
        &self,
        user_id: UserId,
        last_seen_at: i64,
    ) -> impl Future<Output = Result<(), PersistenceFailure>> + Send;
}

/// Publication of a decided presence fact on the app scope.
pub trait PresenceFactSink: Clone + Send + Sync + 'static {
    fn publish(&self, fact: PresenceFact);
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
        let announce = {
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
            on_connect(user_id, already_online).1
        };
        if let Some(fact) = announce {
            self.facts.publish(fact);
        }
    }

    pub fn on_disconnect(&self, user_id: &UserId, connection_id: &str, now: i64) {
        let mut tracked = self.tracked.lock().expect("presence state");
        let Some(connections) = tracked.connections.get_mut(user_id) else {
            return;
        };
        let removed = connections.remove(connection_id);
        let remaining = connections.len();
        let Some(schedule) = on_disconnect(user_id, removed, remaining, now) else {
            return;
        };
        tracked.connections.remove(user_id);
        tracked.cancel_pending(user_id);
        tracked.epochs += 1;
        let epoch = tracked.epochs;

        let timers = self.clone();
        let owner = user_id.clone();
        let grace = self.grace.millis().max(0) as u64;
        let handle = tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(grace)).await;
            let reconnected = {
                let mut tracked = timers.tracked.lock().expect("presence state");
                match tracked.pending.get(&owner) {
                    Some(pending) if pending.epoch == epoch => {
                        tracked.pending.remove(&owner);
                    }
                    // A newer window or a cancel already owns this user.
                    _ => return,
                }
                tracked.connections.contains_key(&owner)
            };
            let Some(outcome) = schedule.elapsed(reconnected) else {
                return;
            };
            if let Err(error) = timers
                .last_seen
                .touch_last_seen(owner.clone(), outcome.persist_last_seen_at)
                .await
            {
                tracing::warn!(
                    user_id = %owner.as_str(),
                    last_seen_at = outcome.persist_last_seen_at,
                    error = %error,
                    "presence: failed to persist last_seen_at"
                );
            }
            timers.facts.publish(outcome.publish);
        });
        tracked
            .pending
            .insert(user_id.clone(), PendingOffline { epoch, handle });
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
}

#[cfg(test)]
mod tests {
    use std::sync::mpsc::{Receiver, Sender, channel};

    use super::*;

    #[derive(Clone)]
    struct RecordingSinks {
        facts: Sender<PresenceFact>,
        touched: Sender<(UserId, i64)>,
        fail_persist: bool,
    }

    impl LastSeenSink for RecordingSinks {
        async fn touch_last_seen(
            &self,
            user_id: UserId,
            last_seen_at: i64,
        ) -> Result<(), PersistenceFailure> {
            self.touched.send((user_id, last_seen_at)).unwrap();
            if self.fail_persist {
                return Err(PersistenceFailure::from_source(std::io::Error::other(
                    "disk gone",
                )));
            }
            Ok(())
        }
    }

    impl PresenceFactSink for RecordingSinks {
        fn publish(&self, fact: PresenceFact) {
            self.facts.send(fact).unwrap();
        }
    }

    struct Harness {
        timers: PresenceGraceTimers<RecordingSinks, RecordingSinks>,
        facts: Receiver<PresenceFact>,
        touched: Receiver<(UserId, i64)>,
    }

    fn harness(grace_ms: i64, fail_persist: bool) -> Harness {
        let (facts_tx, facts) = channel();
        let (touched_tx, touched) = channel();
        let sinks = RecordingSinks {
            facts: facts_tx,
            touched: touched_tx,
            fail_persist,
        };
        Harness {
            timers: PresenceGraceTimers::new(
                sinks.clone(),
                sinks,
                GraceWindow::from_millis_or_default(Some(grace_ms)),
            ),
            facts,
            touched,
        }
    }

    async fn next_fact(facts: &Receiver<PresenceFact>) -> PresenceFact {
        for _ in 0..200 {
            if let Ok(fact) = facts.try_recv() {
                return fact;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        panic!("no presence fact published");
    }

    fn user(id: &str) -> UserId {
        UserId::parse(id).unwrap()
    }

    #[tokio::test]
    async fn a_first_connection_publishes_online_once_per_transition() {
        let h = harness(0, false);
        h.timers.on_connect(&user("user-1"), "c1");
        h.timers.on_connect(&user("user-1"), "c2");
        assert_eq!(
            next_fact(&h.facts).await,
            PresenceFact::Online {
                user_id: user("user-1")
            }
        );
        assert!(h.facts.try_recv().is_err());
        assert!(h.timers.is_online(&user("user-1")));
    }

    #[tokio::test]
    async fn the_offline_fact_dates_from_the_disconnect_not_the_expiry() {
        let h = harness(0, false);
        h.timers.on_connect(&user("user-1"), "c1");
        next_fact(&h.facts).await;
        h.timers
            .on_disconnect(&user("user-1"), "c1", 1_700_000_000_123);
        assert_eq!(
            next_fact(&h.facts).await,
            PresenceFact::Offline {
                user_id: user("user-1"),
                last_seen_at: 1_700_000_000_123,
            }
        );
        assert_eq!(
            h.touched.try_recv().unwrap(),
            (user("user-1"), 1_700_000_000_123)
        );
        assert!(!h.timers.is_online(&user("user-1")));
    }

    #[tokio::test]
    async fn a_reconnect_inside_the_window_cancels_the_offline_fact_and_stays_quiet() {
        let h = harness(60_000, false);
        h.timers.on_connect(&user("user-1"), "c1");
        next_fact(&h.facts).await;
        h.timers.on_disconnect(&user("user-1"), "c1", 10);
        assert!(h.timers.is_online(&user("user-1")));
        h.timers.on_connect(&user("user-1"), "c2");

        tokio::time::sleep(Duration::from_millis(30)).await;
        assert!(h.facts.try_recv().is_err());
        assert!(h.touched.try_recv().is_err());
        assert!(h.timers.is_online(&user("user-1")));
    }

    #[tokio::test]
    async fn a_remaining_connection_starts_no_window() {
        let h = harness(0, false);
        h.timers.on_connect(&user("user-1"), "c1");
        h.timers.on_connect(&user("user-1"), "c2");
        next_fact(&h.facts).await;
        h.timers.on_disconnect(&user("user-1"), "c1", 10);
        tokio::time::sleep(Duration::from_millis(20)).await;
        assert!(h.facts.try_recv().is_err());
        assert!(h.timers.is_online(&user("user-1")));
    }

    #[tokio::test]
    async fn an_unknown_connection_id_changes_nothing() {
        let h = harness(0, false);
        h.timers.on_connect(&user("user-1"), "c1");
        next_fact(&h.facts).await;
        h.timers.on_disconnect(&user("user-1"), "other", 10);
        h.timers.on_disconnect(&user("user-2"), "c1", 10);
        tokio::time::sleep(Duration::from_millis(20)).await;
        assert!(h.facts.try_recv().is_err());
        assert!(h.timers.is_online(&user("user-1")));
    }

    #[tokio::test]
    async fn a_failed_last_seen_write_still_publishes_offline() {
        let h = harness(0, true);
        h.timers.on_connect(&user("user-1"), "c1");
        next_fact(&h.facts).await;
        h.timers.on_disconnect(&user("user-1"), "c1", 42);
        assert_eq!(
            next_fact(&h.facts).await,
            PresenceFact::Offline {
                user_id: user("user-1"),
                last_seen_at: 42,
            }
        );
    }

    #[tokio::test]
    async fn dispose_drops_pending_windows_without_publishing() {
        let h = harness(30, false);
        h.timers.on_connect(&user("user-1"), "c1");
        next_fact(&h.facts).await;
        h.timers.on_disconnect(&user("user-1"), "c1", 10);
        h.timers.dispose();
        assert!(!h.timers.is_online(&user("user-1")));
        tokio::time::sleep(Duration::from_millis(60)).await;
        assert!(h.facts.try_recv().is_err());
    }
}
