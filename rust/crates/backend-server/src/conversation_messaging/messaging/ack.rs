//! The acknowledgement a PERSON's send gets back, projected from one committed send.
//!
//! A STRICT SUPERSET of the payload the whole conversation receives, never a different shape:
//! the renderer runs one idempotent apply seam over the ACK and the broadcast frame, so a
//! second shape here would make the sender's own view converge differently from everyone
//! else's. What the ACK adds is exactly what has an audience of one — which of this sender's
//! references reached nobody.
//!
//! ONE DOOR'S CONTRACT, not the send path's. The agent door answers its own flat coordinate
//! report ([`super::agent_output`]) with its own status, because it has its own published
//! schema and its own client. What the two doors genuinely share is the ONE
//! `SendMessageOutcome` they project from and the ONE sender-only projector
//! ([`super::unresolved_wire`]) — answering both with this DTO handed a daemon a payload it
//! cannot read (@Cindy, terminal review P0).
//!
//! BOTH HALVES COME FROM THE SAME OUTCOME. The committed half is what everyone may see; the
//! unresolved half is the sender's alone. Projecting them from one value is what stops this
//! door from answering a send inconsistently with what it published.
//!
//! `unresolved_references` is absent or non-empty (never `[]`) — the one member that has an
//! audience of one, which is why it lives HERE and not in [`super::message_wire`]: the shared
//! row that both this door and the broadcast frame project is that module's, and this door
//! appends its sender-only diagnostic on top of it.

use serde_json::Value;
use silverhand_backend_core::conversation_messaging::messaging::SendMessageOutcome;

use super::{
    message_wire::message_event_payload,
    unresolved_wire::{UNRESOLVED_REFERENCES, unresolved_member},
};

/// The acknowledgement body for a committed send.
pub(crate) fn send_ack(outcome: &SendMessageOutcome) -> Value {
    let committed = outcome.committed();
    // The shared `{message, projections?}` payload — the SAME projector authority the
    // conversation-scope `message` broadcast frame invokes. The ACK is its strict
    // superset: it appends `unresolved_references` and nothing else.
    let mut ack = message_event_payload(committed.message(), committed.thread());

    // ABSENT when every reference reached somebody, decided by the ONE projector both
    // success contracts consult. The empty vector is a total answer inside the outcome; the
    // wire is where it becomes silence, because a client reads presence as "you have
    // something to fix".
    if let Some(unresolved) = unresolved_member(outcome)
        && let Value::Object(ack) = &mut ack
    {
        ack.insert(UNRESOLVED_REFERENCES.to_owned(), unresolved);
    }

    ack
}
