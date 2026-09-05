//! The stored half of the `user_presence` cold read: the last-seen facts for
//! every listed viewer, loaded once before the live stream keeps them fresh.
//!
//! Presence has TWO authorities and only one of them is durable. The stored
//! last-seen stamp lives in the viewer rows this port reads; whether a viewer is
//! present RIGHT NOW comes from the process-local registry behind
//! [`crate::viewer_read_model::presence::OnlineViewers`] — the same registry the
//! `user_presence` event publishes from. The boundary composes the two through
//! [`crate::viewer_read_model::presence::read_user_presence`], so this port returns the
//! raw stored facts ONLY, never a presence answer: it cannot become a second
//! liveness authority whose value no event announces.
//!
//! The facts are returned in the order the list must be presented (viewer
//! creation order); [`crate::viewer_read_model::presence::read_user_presence`] preserves
//! that order, so the ordering authority is the one SQL the adapter runs.

use std::future::Future;

use crate::{
    foundation::persistence::PersistenceFailure, viewer_read_model::presence::UserPresenceFacts,
};

/// Loads the stored last-seen facts for the listed viewers. Its one
/// implementation reads the viewer rows on a single snapshot; the boundary stays
/// generic over this port and is driven by a driver-free fake in tests.
pub trait UserPresenceReadModel {
    fn list_user_presence_facts(
        &self,
    ) -> impl Future<Output = Result<Vec<UserPresenceFacts>, PersistenceFailure>> + Send;
}
