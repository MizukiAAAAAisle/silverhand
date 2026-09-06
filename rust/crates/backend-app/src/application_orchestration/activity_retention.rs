//! Process-owned activity retention: sweep at boot and while idle, for both
//! deployment shapes. No persisted scheduling state or per-agent coordinator.
use std::{sync::Mutex, time::Duration};

use silverhand_backend_core::conversation_messaging::messaging::collaboration::conversation_agent_activity::ACTIVITY_RETENTION_MS;
use silverhand_backend_server::foundation::{
    clock::ProcessClock,
    scope_event_transport::ScopeEventHub,
};
use silverhand_backend_sqlite::conversation_messaging::messaging::MessagingStore;
use tokio::{task::JoinHandle, sync::watch};

pub(crate) struct ActivityRetention {
    stop: watch::Sender<bool>,
    task: Mutex<Option<JoinHandle<()>>>,
}

impl ActivityRetention {
    pub(crate) async fn start<C: ProcessClock>(
        store: MessagingStore,
        hub: ScopeEventHub,
        clock: C,
    ) -> Result<Self, crate::StartupError> {
        Self::start_with_interval(store, hub, clock, Duration::from_secs(60)).await
    }

    pub(super) async fn start_with_interval<C: ProcessClock>(
        store: MessagingStore,
        hub: ScopeEventHub,
        clock: C,
        interval: Duration,
    ) -> Result<Self, crate::StartupError> {
        sweep(&store, &hub, clock.now_unix_millis()).await?;
        let (stop, mut stopped) = watch::channel(false);
        let task = tokio::spawn(async move {
            let mut timer = tokio::time::interval(interval);
            timer.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
            timer.tick().await;
            loop {
                tokio::select! {
                    biased;
                    _ = stopped.changed() => break,
                    _ = timer.tick() => {}
                }
                if let Err(error) = sweep(&store, &hub, clock.now_unix_millis()).await {
                    tracing::warn!(%error, "activity retention sweep failed; next tick retries");
                }
            }
        });
        Ok(Self {
            stop,
            task: Mutex::new(Some(task)),
        })
    }

    pub(crate) async fn close(&self) {
        let _ = self.stop.send(true);
        let task = self.task.lock().expect("retention task lock").take();
        if let Some(task) = task {
            // Let an in-flight SQLite statement finish before releasing its owner.
            let _ = task.await;
        }
    }
}

impl Drop for ActivityRetention {
    fn drop(&mut self) {
        if let Some(task) = self.task.get_mut().expect("retention task lock").take() {
            task.abort();
        }
    }
}

async fn sweep(
    store: &MessagingStore,
    hub: &ScopeEventHub,
    now: i64,
) -> Result<(), crate::StartupError> {
    store
        .prune_expired_activity(now)
        .await
        .map_err(|source| crate::StartupError::Composition {
            name: "activity retention",
            source: Box::new(source),
        })?;
    hub.prune_activity_before(now.saturating_sub(ACTIVITY_RETENTION_MS))
        .map_err(|source| crate::StartupError::Composition {
            name: "activity replay retention",
            source: Box::new(source),
        })?;
    Ok(())
}
