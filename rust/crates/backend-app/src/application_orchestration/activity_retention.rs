//! Process-owned activity retention: sweep at boot and while idle, for both
//! deployment shapes. No persisted scheduling state or per-agent coordinator.
use chrono::{TimeZone, Utc};
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
        wake_cap: Duration,
    ) -> Result<Self, crate::StartupError> {
        sweep(&store, &hub, clock.now_unix_millis()).await?;
        let (stop, mut stopped) = watch::channel(false);
        let task = tokio::spawn(async move {
            let mut deadline = next_shanghai_six(clock.now_unix_millis());
            loop {
                // Recheck wall time on bounded wakes, including clock adjustments.
                // Only reaching the calendar deadline performs a sweep.
                let now = clock.now_unix_millis();
                let delay =
                    Duration::from_millis(deadline.saturating_sub(now).max(1) as u64).min(wake_cap);
                tokio::select! {
                    biased;
                    _ = stopped.changed() => break,
                    _ = tokio::time::sleep(delay) => {}
                }
                let now = clock.now_unix_millis();
                if now < deadline {
                    continue;
                }
                if let Err(error) = sweep(&store, &hub, now).await {
                    tracing::warn!(%error, "activity retention sweep failed; next daily deadline retries");
                }
                deadline = next_shanghai_six(clock.now_unix_millis());
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

/// Strictly future local 06:00, independent of startup and sweep duration.
fn next_shanghai_six(now: i64) -> i64 {
    let local = chrono::DateTime::<Utc>::from_timestamp_millis(now)
        .expect("process clock is a representable timestamp")
        .with_timezone(&chrono_tz::Asia::Shanghai);
    let mut date = local.date_naive();
    loop {
        let next = chrono_tz::Asia::Shanghai
            .from_local_datetime(&date.and_hms_opt(6, 0, 0).unwrap())
            .single()
            .expect("Shanghai 06:00 is unambiguous")
            .timestamp_millis();
        if next > now {
            return next;
        }
        date = date.succ_opt().expect("next calendar day");
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn daily_deadline_is_strictly_next_shanghai_six() {
        let six = chrono_tz::Asia::Shanghai
            .with_ymd_and_hms(2026, 9, 7, 6, 0, 0)
            .unwrap()
            .timestamp_millis();
        assert_eq!(next_shanghai_six(six - 1), six);
        assert_eq!(next_shanghai_six(six), six + 86_400_000);
        assert_eq!(next_shanghai_six(six + 1), six + 86_400_000);
        assert_eq!(next_shanghai_six(six + 20 * 3_600_000), six + 86_400_000);
    }
}
