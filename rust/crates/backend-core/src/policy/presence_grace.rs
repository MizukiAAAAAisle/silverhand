//! How one human disconnect becomes an offline fact, and when it does not.

use crate::identity::UserId;

const DEFAULT_OFFLINE_GRACE_MS: i64 = 20_000;

/// The published presence fact. `Online` carries no timestamp because a
/// last-seen value only becomes meaningful once the viewer is gone.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum PresenceFact {
    Online { user_id: UserId },
    Offline { user_id: UserId, last_seen_at: i64 },
}

/// Grace between the last connection closing and the offline fact.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct GraceWindow(i64);

impl GraceWindow {
    pub fn from_millis_or_default(configured: Option<i64>) -> Self {
        Self(configured.unwrap_or(DEFAULT_OFFLINE_GRACE_MS))
    }

    pub fn millis(self) -> i64 {
        self.0
    }
}

impl Default for GraceWindow {
    fn default() -> Self {
        Self(DEFAULT_OFFLINE_GRACE_MS)
    }
}

/// A viewer counts as online for the whole grace window, so a reconnect inside
/// it is not a transition and must not re-announce one.
pub fn is_online(has_connection: bool, offline_pending: bool) -> bool {
    has_connection || offline_pending
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ConnectOutcome {
    Announce,
    AlreadyPresent,
}

pub fn on_connect(
    user_id: &UserId,
    already_online: bool,
) -> (ConnectOutcome, Option<PresenceFact>) {
    if already_online {
        return (ConnectOutcome::AlreadyPresent, None);
    }
    (
        ConnectOutcome::Announce,
        Some(PresenceFact::Online {
            user_id: user_id.clone(),
        }),
    )
}

/// Pending offline for one user. Constructed only by [`on_disconnect`], so no
/// caller can schedule a grace window without an observed last connection loss.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct OfflineSchedule {
    user_id: UserId,
    disconnected_at: i64,
}

impl OfflineSchedule {
    pub fn user_id(&self) -> &UserId {
        &self.user_id
    }

    pub fn disconnected_at(&self) -> i64 {
        self.disconnected_at
    }

    /// The offline fact dates from the disconnect, not from expiry, so a longer
    /// grace window never rewrites how long the viewer has been away.
    pub fn elapsed(self, reconnected: bool) -> Option<OfflineOutcome> {
        (!reconnected).then_some(OfflineOutcome {
            persist_last_seen_at: self.disconnected_at,
            publish: PresenceFact::Offline {
                user_id: self.user_id,
                last_seen_at: self.disconnected_at,
            },
        })
    }
}

/// Persisting the last-seen value is best effort; the fact publishes either way.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct OfflineOutcome {
    pub persist_last_seen_at: i64,
    pub publish: PresenceFact,
}

/// Only the loss of a tracked connection that leaves the user with none starts
/// a grace window; an unknown connection id changes nothing.
pub fn on_disconnect(
    user_id: &UserId,
    removed: bool,
    remaining_connections: usize,
    now: i64,
) -> Option<OfflineSchedule> {
    (removed && remaining_connections == 0).then(|| OfflineSchedule {
        user_id: user_id.clone(),
        disconnected_at: now,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn user() -> UserId {
        UserId::parse("user-1").unwrap()
    }

    #[test]
    fn a_first_connection_announces_online_without_a_timestamp() {
        let (outcome, fact) = on_connect(&user(), false);
        assert_eq!(outcome, ConnectOutcome::Announce);
        assert_eq!(fact, Some(PresenceFact::Online { user_id: user() }));
    }

    #[test]
    fn a_reconnect_inside_the_grace_window_is_not_a_transition() {
        let (outcome, fact) = on_connect(&user(), is_online(false, true));
        assert_eq!(outcome, ConnectOutcome::AlreadyPresent);
        assert_eq!(fact, None);
    }

    #[test]
    fn a_second_connection_of_a_present_viewer_announces_nothing() {
        assert!(is_online(true, false));
        assert_eq!(on_connect(&user(), true).1, None);
    }

    #[test]
    fn only_the_last_tracked_connection_schedules_offline() {
        assert_eq!(on_disconnect(&user(), false, 0, 10), None);
        assert_eq!(on_disconnect(&user(), true, 1, 10), None);
        let schedule = on_disconnect(&user(), true, 0, 10).unwrap();
        assert_eq!(schedule.disconnected_at(), 10);
        assert_eq!(schedule.user_id(), &user());
    }

    #[test]
    fn expiry_dates_the_offline_fact_from_the_disconnect() {
        let schedule = on_disconnect(&user(), true, 0, 1_700_000_000_123).unwrap();
        assert_eq!(
            schedule.elapsed(false),
            Some(OfflineOutcome {
                persist_last_seen_at: 1_700_000_000_123,
                publish: PresenceFact::Offline {
                    user_id: user(),
                    last_seen_at: 1_700_000_000_123,
                },
            })
        );
    }

    #[test]
    fn a_reconnect_before_expiry_publishes_nothing() {
        let schedule = on_disconnect(&user(), true, 0, 10).unwrap();
        assert_eq!(schedule.elapsed(true), None);
    }

    #[test]
    fn an_absent_configuration_keeps_the_twenty_second_window() {
        assert_eq!(GraceWindow::from_millis_or_default(None).millis(), 20_000);
        assert_eq!(GraceWindow::from_millis_or_default(Some(0)).millis(), 0);
        assert_eq!(
            GraceWindow::default(),
            GraceWindow::from_millis_or_default(None)
        );
    }

    #[test]
    fn an_absent_viewer_is_offline() {
        assert!(!is_online(false, false));
    }
}
