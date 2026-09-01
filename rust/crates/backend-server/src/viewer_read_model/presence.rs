//! Human-presence policy and its narrow product-event publication effect.

use std::{sync::Arc, time::Duration};

use axum::Router;
use silverhand_backend_core::{
    foundation::identity::UserId,
    foundation::scope_event::EventScope,
    policy::presence_grace::{GraceWindow, PresenceFact},
    viewer_read_model::user_presence_cold_read::UserPresenceReadModel,
    viewer_read_model::user_presence_last_seen::LastSeenSink,
};

use crate::{
    foundation::{
        scope_event_transport::{ConnectionLifecycle, ScopeEventHub, ScopeEventHubError},
        scope_event_wire::ProductEvent,
    },
    host_runtime::host_agent_background::presence_grace_timer::{
        PresenceFactSink, PresenceGraceTimers,
    },
};

/// Narrow publication adapter for presence facts. It owns no clock, grace or persistence
/// policy; those decisions are complete before a fact reaches this boundary.
#[derive(Clone)]
pub struct HubPresencePublisher {
    hub: ScopeEventHub,
}

#[cfg(test)]
pub(crate) type HubPresenceSink = HubPresencePublisher;

impl HubPresencePublisher {
    pub(crate) fn new(hub: ScopeEventHub) -> Self {
        Self { hub }
    }
}

impl PresenceFactSink for HubPresencePublisher {
    type Error = ScopeEventHubError;

    fn publish(&self, fact: PresenceFact) -> Result<(), Self::Error> {
        self.hub.publish_user_presence(&fact)
    }
}

impl ScopeEventHub {
    /// Derive the presence effect from this hub. No public constructor can point the
    /// publisher at a different transport silently.
    pub fn presence_publisher(&self) -> HubPresencePublisher {
        HubPresencePublisher::new(self.clone())
    }

    pub(crate) fn publish_user_presence(
        &self,
        fact: &PresenceFact,
    ) -> Result<(), ScopeEventHubError> {
        let event = match fact {
            PresenceFact::Online { user_id } => ProductEvent::UserPresence {
                user_id: user_id.as_str().to_owned(),
                presence: "online",
                last_seen_at: None,
            },
            PresenceFact::Offline {
                user_id,
                last_seen_at,
            } => ProductEvent::UserPresence {
                user_id: user_id.as_str().to_owned(),
                presence: "offline",
                last_seen_at: Some(last_seen_at.get()),
            },
        };
        self.publish(EventScope::App, event)
    }
}

/// Presence's wall-clock capability. It lives with presence policy, not websocket
/// transport: a failed clock read is handled as a presence-domain eviction decision.
pub trait DisconnectClock: Send + Sync {
    type Error: std::error::Error + Send + Sync + 'static;

    fn read_unix_ms(&self) -> Result<i64, Self::Error>;
}

#[derive(Clone, Copy, Debug, Default)]
pub struct SystemDisconnectClock;

#[derive(Debug)]
pub enum SystemClockFault {
    BeforeEpoch(std::time::SystemTimeError),
    MillisOverflow(u128),
}

impl std::fmt::Display for SystemClockFault {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::BeforeEpoch(_) => {
                formatter.write_str("system wall clock is set before the unix epoch")
            }
            Self::MillisOverflow(millis) => write!(
                formatter,
                "system wall clock elapsed {millis} ms exceeds the i64 instant range"
            ),
        }
    }
}

impl std::error::Error for SystemClockFault {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::BeforeEpoch(error) => Some(error),
            Self::MillisOverflow(_) => None,
        }
    }
}

pub(crate) fn duration_to_unix_ms(elapsed: Duration) -> Result<i64, SystemClockFault> {
    let millis = elapsed.as_millis();
    i64::try_from(millis).map_err(|_| SystemClockFault::MillisOverflow(millis))
}

impl DisconnectClock for SystemDisconnectClock {
    type Error = SystemClockFault;

    fn read_unix_ms(&self) -> Result<i64, Self::Error> {
        let elapsed = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_err(SystemClockFault::BeforeEpoch)?;
        duration_to_unix_ms(elapsed)
    }
}

/// Turns clock-free websocket lifetime observations into presence grace transitions.
pub struct PresenceConnectionFeed<C, L, S> {
    timers: PresenceGraceTimers<L, S>,
    clock: C,
}

impl<C, L, S> PresenceConnectionFeed<C, L, S> {
    pub fn new(timers: PresenceGraceTimers<L, S>, clock: C) -> Self {
        Self { timers, clock }
    }
}

impl<C, L, S> ConnectionLifecycle for PresenceConnectionFeed<C, L, S>
where
    C: DisconnectClock,
    L: LastSeenSink,
    S: PresenceFactSink,
{
    fn on_connect(&self, viewer: &UserId, connection_id: &str) {
        self.timers.on_connect(viewer, connection_id);
    }

    fn on_disconnect(&self, viewer: &UserId, connection_id: &str) {
        match self.clock.read_unix_ms() {
            Ok(now) => self.timers.on_disconnect(viewer, connection_id, now),
            Err(error) => {
                tracing::error!(
                    user_id = %viewer.as_str(),
                    error_chain = %crate::foundation::error::describe(&error),
                    "presence: disconnect wall clock unavailable; evicting the connection without an offline instant"
                );
                self.timers.evict(viewer, connection_id);
            }
        }
    }
}

/// Compose one presence authority from cold read, last-seen persistence, a publisher,
/// disconnect clock and grace policy. Scope transport is supplied only through the typed
/// publisher; the policy cannot construct or select a hub.
pub fn compose_presence_vertical<U, L, K>(
    presence_cold_read: U,
    last_seen_sink: L,
    publication: HubPresencePublisher,
    disconnect_clock: K,
    grace: GraceWindow,
) -> (
    Router,
    Arc<dyn ConnectionLifecycle>,
    PresenceGraceTimers<L, HubPresencePublisher>,
)
where
    U: UserPresenceReadModel + Clone + Send + Sync + 'static,
    L: LastSeenSink + Clone + Send + Sync + 'static,
    K: DisconnectClock + 'static,
{
    let timers = PresenceGraceTimers::new(last_seen_sink, publication, grace);
    let router = crate::host_agent::presence::router(presence_cold_read, timers.clone());
    let feed: Arc<dyn ConnectionLifecycle> = Arc::new(PresenceConnectionFeed::new(
        timers.clone(),
        disconnect_clock,
    ));
    (router, feed, timers)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn elapsed_millis_never_wrap_into_a_presence_instant() {
        let overflow = Duration::from_millis(i64::MAX as u64)
            .checked_add(Duration::from_millis(1))
            .expect("test duration");
        assert!(matches!(
            duration_to_unix_ms(overflow),
            Err(SystemClockFault::MillisOverflow(_))
        ));
    }
}
