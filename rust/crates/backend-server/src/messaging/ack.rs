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
//! THREE DIFFERENT WAYS EMPTINESS IS SPELLED, and they are not interchangeable:
//! `unresolved_references` is absent or non-empty (never `[]`), `metadata`/`attachments` are
//! null together when a message carries none, and an unlabelled attachment OMITS `label`
//! rather than sending null.

use serde_json::{Map, Value, json};
use silverhand_backend_core::messaging::{
    CreatedMessage, FromKind, SendMessageOutcome, ThreadReplyFact, attachments::AttachmentSnapshot,
};

use super::{
    author_wire::author_dto,
    unresolved_wire::{UNRESOLVED_REFERENCES, unresolved_member},
};

/// The acknowledgement body for a committed send.
pub(crate) fn send_ack(outcome: &SendMessageOutcome) -> Value {
    let committed = outcome.committed();
    let mut ack = Map::new();
    ack.insert("message".to_owned(), message_dto(committed.message()));

    // Present only for a reply: a main-line send changed no cluster, so there is no delta to
    // merge and an empty sidecar would invite a client to apply one.
    if let Some(reply) = committed.thread() {
        ack.insert("projections".to_owned(), projections(reply));
    }

    // ABSENT when every reference reached somebody, decided by the ONE projector both
    // success contracts consult. The empty vector is a total answer inside the outcome; the
    // wire is where it becomes silence, because a client reads presence as "you have
    // something to fix".
    if let Some(unresolved) = unresolved_member(outcome) {
        ack.insert(UNRESOLVED_REFERENCES.to_owned(), unresolved);
    }

    Value::Object(ack)
}

/// The inserted row, as every reader of this conversation sees it.
fn message_dto(message: &CreatedMessage) -> Value {
    let attachments = attachment_list(&message.attachments);
    json!({
        "id": message.id.as_str(),
        "conversation_id": message.conversation_id.as_str(),
        // RAW provenance, kept beside the resolved `author` rather than replaced by it: this is
        // what self-identification and permission logic read.
        "from_kind": from_kind_word(message.from_kind),
        "from_agent_id": optional_str(message.from_agent_id.as_ref().map(|id| id.as_str())),
        "from_user_id": optional_str(message.from_user_id.as_ref().map(|id| id.as_str())),
        // Null for a system message, which has no principal to present.
        "author": match &message.author {
            Some(author) => author_dto(author),
            None => Value::Null,
        },
        "content": message.content.as_str(),
        // ONE projection, placed twice. Computing the list here and handing the SAME value to
        // both members is what makes them unable to disagree; two calls that happen to produce
        // equal JSON would only look like a mirror (@Cindy, review plan for the terminal hash).
        "metadata": wrapped_metadata(&attachments),
        "attachments": attachments,
        // STRUCTURALLY absent, not a read that failed: a row inserted this instant has no
        // reactions, and nothing has had the chance to link a task to it.
        "reactions": Value::Null,
        "seq": message.seq.get(),
        "created_at": message.created_at_ms,
        "thread_root_id": optional_str(message.thread_root_id.as_ref().map(|id| id.as_str())),
        "linked_task": Value::Null,
    })
}

/// The authoritative deltas a reply produced, both read off the ONE committed cluster
/// projection so the count and the entry cannot describe different clusters.
fn projections(reply: &ThreadReplyFact) -> Value {
    let entry = reply.list_entry();
    json!({
        "thread_root_reply_count": {
            "root_id": entry.root_id().as_str(),
            "reply_count": entry.reply_count(),
        },
        // The `{entry}` wrapper is the contract's, reserving room for sibling hints without a
        // wire break.
        "threads_list_entry": {
            "entry": {
                "root_message_id": entry.root_id().as_str(),
                "root_author": match entry.root_author() {
                    Some(author) => author_dto(author),
                    None => Value::Null,
                },
                "root_preview": entry.root_preview(),
                "root_created_at": entry.root_created_at_ms(),
                "root_seq": entry.root_seq().get(),
                "reply_count": entry.reply_count(),
                "last_reply_at": entry.last_reply_at_ms(),
                "last_reply_message_id": entry.last_reply_message_id().as_str(),
                "repliers": Value::Array(entry.repliers().iter().map(author_dto).collect()),
                "replier_total": entry.replier_total(),
            }
        },
    })
}

fn from_kind_word(kind: FromKind) -> &'static str {
    match kind {
        FromKind::User => "user",
        FromKind::Agent => "agent",
        FromKind::System => "system",
    }
}

fn optional_str(value: Option<&str>) -> Value {
    match value {
        Some(value) => json!(value),
        None => Value::Null,
    }
}

/// The stored metadata, which on this path holds attachments and nothing else.
///
/// It takes the ALREADY PROJECTED list rather than the snapshots, so there is exactly one place
/// that turns a snapshot into JSON. Null when the list is — the same condition, read off the same
/// value, so the typed member cannot describe attachments the metadata does not.
fn wrapped_metadata(attachments: &Value) -> Value {
    if attachments.is_null() {
        return Value::Null;
    }
    json!({ "attachments": attachments })
}

fn attachment_list(attachments: &[AttachmentSnapshot]) -> Value {
    if attachments.is_empty() {
        return Value::Null;
    }
    snapshots(attachments)
}

fn snapshots(attachments: &[AttachmentSnapshot]) -> Value {
    Value::Array(
        attachments
            .iter()
            .map(|snapshot| {
                let mut object = Map::new();
                object.insert("id".to_owned(), json!(snapshot.id.as_str()));
                object.insert("filename".to_owned(), json!(snapshot.filename));
                object.insert("size".to_owned(), json!(snapshot.size));
                object.insert("content_type".to_owned(), json!(snapshot.content_type));
                // OMITTED when the sender assigned none, which is not the same wire fact as a
                // null label: the contract makes it optional so a bare-id caller's attachment
                // falls back to a positional label downstream.
                if let Some(label) = &snapshot.label {
                    object.insert("label".to_owned(), json!(label.to_string()));
                }
                Value::Object(object)
            })
            .collect(),
    )
}

#[cfg(test)]
mod tests {
    use silverhand_backend_core::messaging::{
        AttachmentId,
        attachments::{AttachmentLabel, AttachmentSnapshot},
    };

    use super::*;

    fn snapshot(label: Option<&str>) -> AttachmentSnapshot {
        AttachmentSnapshot {
            id: AttachmentId::parse("att-1").unwrap(),
            filename: "notes.txt".to_owned(),
            size: 12,
            content_type: "text/plain".to_owned(),
            label: label.map(|text| AttachmentLabel::parse(text).expect("a legal label")),
        }
    }

    /// `metadata` IS NOT A FREE-FORM RECORD on this path, and may never become one.
    ///
    /// Both members come from the one `CreatedMessage.attachments`, so they live and die
    /// together and cannot describe different attachments. Asserted as whole JSON over a closed
    /// key set: the failure this guards is a second key quietly appearing in `metadata`, which a
    /// field probe would never notice.
    #[test]
    fn metadata_mirrors_the_attachments_and_carries_nothing_else() {
        assert_eq!(attachment_list(&[]), Value::Null);
        assert_eq!(wrapped_metadata(&Value::Null), Value::Null);

        let projected = attachment_list(&[snapshot(Some("Image #1"))]);
        assert_eq!(
            projected,
            json!([{
                "id": "att-1",
                "filename": "notes.txt",
                "size": 12,
                "content_type": "text/plain",
                "label": "Image #1",
            }])
        );
        // The metadata wraps the value the typed member IS, rather than re-projecting the
        // snapshots — so the two cannot describe different attachments. That property is
        // structural; this only reads it back.
        assert_eq!(
            wrapped_metadata(&projected),
            json!({ "attachments": projected })
        );
    }

    /// An unlabelled attachment OMITS `label`; it does not send null.
    ///
    /// A third spelling of emptiness on this surface, and the reason it matters: the contract
    /// makes the member optional so a bare-id caller's attachment falls back to a positional
    /// label downstream. A null would be a value that consumer has to special-case.
    #[test]
    fn an_unlabelled_attachment_omits_the_member() {
        let bare = attachment_list(&[snapshot(None)]);
        let entry = &bare[0];
        assert!(entry.get("label").is_none(), "{entry}");
        assert_eq!(
            entry,
            &json!({
                "id": "att-1",
                "filename": "notes.txt",
                "size": 12,
                "content_type": "text/plain",
            })
        );
    }
}
