use silverhand_backend_core::{
    foundation::persistence::PersistenceFailure,
    identity::{ConversationId, UserId},
    messaging::{
        MessageId,
        collaboration::saved::{
            CommittedSave, CommittedUnsave, SavedMutationPort, SavedMutationRefusal,
        },
    },
};
use sqlx::{QueryBuilder, Row, Sqlite};

use crate::messaging::collaboration::conversation_participation::{
    SELECT_CONVERSATION, decode_conversation, participating_viewer,
};

use super::{SELECT_JOINED, SavedStoreError, SqliteSavedStore, decode_entries};

struct AuthorizedMessage<'a> {
    tx: sqlx::Transaction<'a, Sqlite>,
    viewer: UserId,
    message: MessageId,
}

impl<E> SavedMutationPort for SqliteSavedStore<E>
where
    E: silverhand_backend_core::messaging::environment::SendClock
        + silverhand_backend_core::messaging::environment::SendEntropy
        + Clone
        + Send
        + Sync
        + 'static,
{
    type Error = PersistenceFailure;

    async fn save(
        &self,
        viewer: UserId,
        message: MessageId,
    ) -> Result<Result<CommittedSave, SavedMutationRefusal>, Self::Error> {
        let authorized = match self.authorized(&viewer, &message).await? {
            Ok(authorized) => authorized,
            Err(refusal) => return Ok(Err(refusal)),
        };
        let AuthorizedMessage {
            mut tx,
            viewer,
            message,
        } = authorized;
        let entry = self.new_entry_id()?;
        let saved_at = self.now()?;
        let changed = sqlx::query(
            "INSERT OR IGNORE INTO saved_messages (id, user_id, message_id, conversation_id, saved_at) SELECT ?, ?, m.id, m.conversation_id, ? FROM messages m WHERE m.id = ?",
        )
        .bind(entry.as_str())
        .bind(viewer.as_str())
        .bind(saved_at.get())
        .bind(message.as_str())
        .execute(&mut *tx)
        .await
        .map_err(SavedStoreError::from)?
        .rows_affected()
            == 1;
        let mut query = QueryBuilder::<Sqlite>::new(SELECT_JOINED);
        query
            .push(" WHERE sm.user_id = ")
            .push_bind(viewer.as_str())
            .push(" AND sm.message_id = ")
            .push_bind(message.as_str());
        let rows = query
            .build()
            .fetch_all(&mut *tx)
            .await
            .map_err(SavedStoreError::from)?;
        let mut entries = decode_entries(&mut tx, rows).await?;
        let entry = entries.pop().ok_or(SavedStoreError::MalformedIdentity)?;
        if !entries.is_empty() {
            return Err(SavedStoreError::MalformedIdentity.into());
        }
        let committed = CommittedSave::committed(viewer, message, entry, changed);
        tx.commit().await.map_err(SavedStoreError::from)?;
        Ok(Ok(committed))
    }

    async fn unsave(
        &self,
        viewer: UserId,
        message: MessageId,
    ) -> Result<Result<CommittedUnsave, SavedMutationRefusal>, Self::Error> {
        let authorized = match self.authorized(&viewer, &message).await? {
            Ok(authorized) => authorized,
            Err(refusal) => return Ok(Err(refusal)),
        };
        let AuthorizedMessage {
            mut tx,
            viewer,
            message,
        } = authorized;
        let mut existing_query = QueryBuilder::<Sqlite>::new(SELECT_JOINED);
        existing_query
            .push(" WHERE sm.user_id = ")
            .push_bind(viewer.as_str())
            .push(" AND sm.message_id = ")
            .push_bind(message.as_str());
        let existing_rows = existing_query
            .build()
            .fetch_all(&mut *tx)
            .await
            .map_err(SavedStoreError::from)?;
        let mut existing = decode_entries(&mut tx, existing_rows).await?;
        let changed = if let Some(entry) = existing.pop() {
            if !existing.is_empty() {
                return Err(SavedStoreError::MalformedIdentity.into());
            }
            let deleted = sqlx::query("DELETE FROM saved_messages WHERE id = ?")
                .bind(entry.id().as_str())
                .execute(&mut *tx)
                .await
                .map_err(SavedStoreError::from)?
                .rows_affected();
            if deleted != 1 {
                return Err(SavedStoreError::MalformedIdentity.into());
            }
            let remains: i64 = sqlx::query_scalar(
                "SELECT COUNT(*) FROM saved_messages WHERE user_id = ? AND message_id = ?",
            )
            .bind(viewer.as_str())
            .bind(message.as_str())
            .fetch_one(&mut *tx)
            .await
            .map_err(SavedStoreError::from)?;
            if remains != 0 {
                return Err(SavedStoreError::MalformedIdentity.into());
            }
            true
        } else {
            false
        };
        let committed = CommittedUnsave::committed(viewer, message, changed);
        tx.commit().await.map_err(SavedStoreError::from)?;
        Ok(Ok(committed))
    }
}

impl<E> SqliteSavedStore<E>
where
    E: silverhand_backend_core::messaging::environment::SendClock
        + silverhand_backend_core::messaging::environment::SendEntropy
        + Clone
        + Send
        + Sync
        + 'static,
{
    async fn authorized<'a>(
        &'a self,
        viewer: &UserId,
        message: &MessageId,
    ) -> Result<Result<AuthorizedMessage<'a>, SavedMutationRefusal>, PersistenceFailure> {
        let mut tx = self
            .pool
            .begin_with("BEGIN IMMEDIATE")
            .await
            .map_err(SavedStoreError::from)?;
        let row = sqlx::query("SELECT id,conversation_id FROM messages WHERE id=?")
            .bind(message.as_str())
            .fetch_optional(&mut *tx)
            .await
            .map_err(SavedStoreError::from)?;
        let Some(row) = row else {
            tx.rollback().await.map_err(SavedStoreError::from)?;
            return Ok(Err(SavedMutationRefusal));
        };
        let source_message = MessageId::parse(
            row.try_get::<String, _>("id")
                .map_err(SavedStoreError::from)?,
        )
        .map_err(|_| SavedStoreError::MalformedIdentity)?;
        if &source_message != message {
            return Err(SavedStoreError::MalformedIdentity.into());
        }
        let conversation = ConversationId::parse(
            row.try_get::<String, _>("conversation_id")
                .map_err(SavedStoreError::from)?,
        )
        .map_err(|_| SavedStoreError::MalformedIdentity)?;
        let conversation_row = sqlx::query(SELECT_CONVERSATION)
            .bind(conversation.as_str())
            .fetch_one(&mut *tx)
            .await
            .map_err(SavedStoreError::from)?;
        let (source_conversation, placement) =
            decode_conversation(&conversation_row, &conversation)
                .map_err(PersistenceFailure::from)?;
        let Some(source_viewer) =
            participating_viewer(&mut tx, viewer, &source_conversation, &placement)
                .await
                .map_err(PersistenceFailure::from)?
        else {
            tx.rollback().await.map_err(SavedStoreError::from)?;
            return Ok(Err(SavedMutationRefusal));
        };
        Ok(Ok(AuthorizedMessage {
            tx,
            viewer: source_viewer,
            message: source_message,
        }))
    }
}
