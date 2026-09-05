//! The durable half of presence: persisting a viewer's sealed last-seen instant.
//!
//! This is the write counterpart of [`crate::viewer_read_model::user_presence_cold_read`]. When a
//! viewer's grace window expires into an offline fact, that fact carries a
//! [`LastSeenAt`] whose range was already enforced once, where the disconnect
//! clock entered the domain (`viewer_read_model::presence_grace::on_disconnect`). This port
//! persists that SEALED value: it never re-validates it and never reads state
//! back, so persist and wire carry the identical instant.
//!
//! Persisting is best effort — the offline fact publishes whether or not the row
//! is written — but a write that touches no row is NOT success: the addressed
//! viewer must exist, so a zero-row update is a named persistence fault the
//! caller audits, never a silently swallowed no-op. Its one implementation
//! updates the viewer row on a single statement.

use std::future::Future;

use crate::{
    foundation::identity::UserId, foundation::persistence::PersistenceFailure,
    viewer_read_model::presence::LastSeenAt,
};

/// Persists one viewer's sealed last-seen instant. The value is already
/// range-checked at the single domain entry, so this port takes it verbatim;
/// its implementation must address exactly the one viewer row and treat any
/// other affected-row count as a [`PersistenceFailure`], never a silent no-op.
pub trait LastSeenSink: Clone + Send + Sync + 'static {
    fn touch_last_seen(
        &self,
        user_id: UserId,
        last_seen_at: LastSeenAt,
    ) -> impl Future<Output = Result<(), PersistenceFailure>> + Send;
}
