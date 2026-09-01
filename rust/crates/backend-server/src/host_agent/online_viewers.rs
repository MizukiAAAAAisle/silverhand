//! Production adapter: the process presence registry answers [`OnlineViewers`].
//!
//! [`silverhand_backend_core::viewer_read_model::presence`] states the obligation this
//! impl discharges: the live half of the presence answer must come from the SAME
//! registry the `user_presence` event publishes from, and must not be re-derived
//! from a timestamp. [`PresenceGraceTimers`] is exactly that registry — its
//! `is_online` reads the live connection set and the pending grace windows and
//! nothing else — so binding the trait to it is what lets the presence route be
//! composed over the real liveness authority rather than a second projection.

use silverhand_backend_core::{
    foundation::identity::UserId, viewer_read_model::presence::OnlineViewers,
    viewer_read_model::user_presence_last_seen::LastSeenSink,
};

use crate::host_runtime::host_agent_background::presence_grace_timer::{
    PresenceFactSink, PresenceGraceTimers,
};

impl<L, S> OnlineViewers for PresenceGraceTimers<L, S>
where
    L: LastSeenSink,
    S: PresenceFactSink,
{
    fn is_online(&self, user_id: &UserId) -> bool {
        // Method-call syntax resolves to the inherent `is_online` (inherent
        // methods shadow trait methods), so this delegates to the registry rather
        // than recursing into this trait method.
        self.is_online(user_id)
    }
}
