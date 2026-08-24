use silverhand_backend_core::{
    identity::UserId,
    messaging::{
        MessageId,
        collaboration::saved::{
            CommittedSave, CommittedUnsave, SavedAction, SavedChangeFact, SavedMutationPort,
            SavedMutationRefusal,
        },
    },
    persistence::PersistenceFailure,
};
use sqlx::{QueryBuilder, Row, Sqlite};

use super::{SELECT_JOINED, SavedStoreError, SqliteSavedStore, decode_entries, push_participates};

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
        let mut tx = match self.authorized(&viewer, &message).await? {
            Ok(tx) => tx,
            Err(refusal) => return Ok(Err(refusal)),
        };
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
        let committed = CommittedSave::committed(
            entry,
            changed.then(|| SavedChangeFact::committed(viewer, message, SavedAction::Save)),
        );
        tx.commit().await.map_err(SavedStoreError::from)?;
        Ok(Ok(committed))
    }

    async fn unsave(
        &self,
        viewer: UserId,
        message: MessageId,
    ) -> Result<Result<CommittedUnsave, SavedMutationRefusal>, Self::Error> {
        let mut tx = match self.authorized(&viewer, &message).await? {
            Ok(tx) => tx,
            Err(refusal) => return Ok(Err(refusal)),
        };
        let changed =
            sqlx::query("DELETE FROM saved_messages WHERE user_id = ? AND message_id = ?")
                .bind(viewer.as_str())
                .bind(message.as_str())
                .execute(&mut *tx)
                .await
                .map_err(SavedStoreError::from)?
                .rows_affected()
                == 1;
        let committed = CommittedUnsave::committed(
            changed.then(|| SavedChangeFact::committed(viewer, message, SavedAction::Unsave)),
        );
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
    ) -> Result<Result<sqlx::Transaction<'a, Sqlite>, SavedMutationRefusal>, PersistenceFailure>
    {
        let mut tx = self
            .pool
            .begin_with("BEGIN IMMEDIATE")
            .await
            .map_err(SavedStoreError::from)?;
        let mut authority = QueryBuilder::<Sqlite>::new("SELECT c.placement_kind, ");
        push_participates(&mut authority, viewer.as_str());
        authority.push(" AS participates FROM messages m JOIN conversations c ON c.id = m.conversation_id WHERE m.id = ");
        authority.push_bind(message.as_str());
        let row = authority
            .build()
            .fetch_optional(&mut *tx)
            .await
            .map_err(SavedStoreError::from)?;
        let Some(row) = row else {
            tx.rollback().await.map_err(SavedStoreError::from)?;
            return Ok(Err(SavedMutationRefusal));
        };
        match row
            .try_get::<String, _>("placement_kind")
            .map_err(SavedStoreError::from)?
            .as_str()
        {
            "workspace" | "direct_pair" => {}
            _ => return Err(SavedStoreError::MalformedPlacement.into()),
        }
        if row
            .try_get::<i64, _>("participates")
            .map_err(SavedStoreError::from)?
            == 0
        {
            tx.rollback().await.map_err(SavedStoreError::from)?;
            return Ok(Err(SavedMutationRefusal));
        }
        Ok(Ok(tx))
    }
}
