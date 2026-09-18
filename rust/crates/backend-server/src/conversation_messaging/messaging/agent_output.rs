//! What the AGENT door answers a committed send with: a flat coordinate report.
//!
//! ITS OWN PUBLISHED CONTRACT, and deliberately not the person's acknowledgement
//! ([`super::ack`]). The two doors consume ONE outcome and share ONE projector for the
//! sender-only member ([`super::unresolved_wire`]); the success payloads are two contracts
//! with two audiences, and answering both with the ACK is a real client break rather than
//! a tidier shape: a daemon reads `message_id`/`message_seq` to advance its own cursor and
//! would find neither, while receiving a whole message and cluster projections it has no
//! schema for.
//!
//! WHY THESE FOUR MEMBERS, all required. `conversation_id` is WHERE the address resolved
//! to, and this response is the only place a caller that sent by name learns the
//! coordinate its freshness cursor is keyed by. `thread_root_id` is present and NULLABLE
//! rather than omitted on the main line: the caller learns which stream its own message
//! joined, and an absent member would read as "this payload forgot".

use serde_json::{Map, Value, json};
use silverhand_backend_core::conversation_messaging::messaging::SendMessageOutcome;

use super::unresolved_wire::{UNRESOLVED_REFERENCES, unresolved_member};

/// The agent door's success body for a committed send.
pub(crate) fn agent_send_output(outcome: &SendMessageOutcome) -> Value {
    let message = outcome.committed().message();
    let mut output = Map::new();
    output.insert("message_id".to_owned(), json!(message.id.as_str()));
    output.insert(
        "conversation_id".to_owned(),
        json!(message.conversation_id.as_str()),
    );
    output.insert("message_seq".to_owned(), json!(message.seq.get()));
    output.insert(
        "thread_root_id".to_owned(),
        match &message.thread_root_id {
            Some(root) => json!(root.as_str()),
            None => Value::Null,
        },
    );
    if let Some(unresolved) = unresolved_member(outcome) {
        output.insert(UNRESOLVED_REFERENCES.to_owned(), unresolved);
    }
    Value::Object(output)
}
