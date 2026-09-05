//! Shared in-transaction append of a task lifecycle system message.
//!
//! Every task mutation writer (status/claim/unclaim/edit; create has its own inline
//! append tied to the row insert) appends its `task_*` event with the SAME shared
//! message primitives the create writer uses, inside the writer's own reserved-writer
//! transaction, so the notice commits atomically with the row change. This helper is
//! that one append — it holds no policy, only the mechanical seq-reserve → insert →
//! stream-head-advance the whole crate shares.

use silverhand_backend_core::conversation_messaging::messaging::ThreadRootId as MessagingThreadRootId;
use silverhand_backend_core::conversation_messaging::messaging::task::{
    CreatedEventMessageId, TaskCommittedEventMessage, TaskEventMessage,
};
use silverhand_backend_core::foundation::identity::ConversationId;
use silverhand_backend_core::foundation::persistence::PersistenceFailure;
use sqlx::Sqlite;

use super::super::{
    FROM_KIND_SYSTEM, INSERT_MESSAGE, MessagingStoreError, ReserveSeqFault, bump_stream_head_on,
    reserve_next_seq_on,
};
use super::{corrupt, driver};

/// A random base64url message id (12 bytes, mirroring `randomBytes(12).base64url`).
fn new_message_id() -> Result<String, PersistenceFailure> {
    use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
    let mut bytes = [0_u8; 12];
    getrandom::fill(&mut bytes)
        .map_err(|error| PersistenceFailure::from_source(super::TaskStoreError::Entropy(error)))?;
    Ok(URL_SAFE_NO_PAD.encode(bytes))
}

/// Append `event` as a system message in `conversation` on the writer's own
/// transaction, at `now`, under the optional `thread_root`. Returns the appended
/// message's id as a [`CreatedEventMessageId`] for the mutation witness.
///
/// It reserves the next per-conversation seq, inserts the system message, and
/// advances the stream head — the same three primitives the create writer uses — so
/// a task event participates in the conversation's ordering exactly as any other
/// message, and the append lives inside the caller's `BEGIN IMMEDIATE`.
pub(super) async fn append_task_event(
    tx: &mut sqlx::Transaction<'_, Sqlite>,
    conversation: &ConversationId,
    thread_root: Option<&str>,
    event: &TaskEventMessage,
    now: i64,
) -> Result<TaskCommittedEventMessage, PersistenceFailure> {
    let message_id = new_message_id()?;
    let seq = reserve_next_seq_on(tx, conversation)
        .await
        .map_err(|fault| match fault {
            ReserveSeqFault::Driver(error) => driver(error),
            ReserveSeqFault::Ordinal(error) => {
                PersistenceFailure::from_source(MessagingStoreError::Ordinal(error))
            }
        })?;
    sqlx::query(INSERT_MESSAGE)
        .bind(&message_id)
        .bind(conversation.as_str())
        .bind(FROM_KIND_SYSTEM)
        .bind(None::<&str>)
        .bind(None::<&str>)
        .bind(&event.content)
        .bind(&event.metadata)
        .bind(seq.get())
        .bind(now)
        .bind(thread_root)
        .bind(None::<&str>)
        .bind(None::<&str>)
        .bind(None::<&str>)
        .bind(None::<&str>)
        .execute(&mut **tx)
        .await
        .map_err(driver)?;
    let message_thread_root = thread_root
        .map(MessagingThreadRootId::parse)
        .transpose()
        .map_err(|_| corrupt("tasks.thread_root_id"))?;
    bump_stream_head_on(tx, conversation, message_thread_root.as_ref(), seq)
        .await
        .map_err(driver)?;
    Ok(TaskCommittedEventMessage {
        id: CreatedEventMessageId::parse(message_id)
            .map_err(|_| corrupt("task_event.message_id"))?,
        conversation_id: conversation.clone(),
        thread_root_id: thread_root
            .map(silverhand_backend_core::conversation_messaging::messaging::task::ThreadRootId::parse)
            .transpose()
            .map_err(|_| corrupt("tasks.thread_root_id"))?,
        message: event.clone(),
        seq: seq.get(),
        created_at: now,
    })
}
