use super::MessagingStore;
use silverhand_backend_core::{
    foundation::{identity::Principal, persistence::PersistenceFailure},
    identity_access::profile_message_counts::{
        MessageCountYear, ProfileMessageCountRead, ProfileMessageCounts,
    },
};

impl<E: Clone + Send + Sync + 'static> ProfileMessageCountRead for MessagingStore<E> {
    async fn read_counts(
        &self,
        subject: &Principal,
        year: &MessageCountYear,
    ) -> Result<ProfileMessageCounts, PersistenceFailure> {
        // Both queries share a snapshot: deletion cannot split earliest-year and counts.
        let mut tx = self
            .pool
            .begin()
            .await
            .map_err(PersistenceFailure::from_source)?;
        // CROSS JOIN keeps the <=366 calendar rows outermost. Ordinary JOIN can
        // make SQLite scan every subject row against every day, losing time bounds.
        let (first_sql, days_sql, id): (&'static str, &'static str, &str) = match subject {
            Principal::Human { user_id } => (
                "SELECT MIN(created_at) FROM messages WHERE from_kind='user' AND from_user_id=? AND cc_source_message_id IS NULL",
                "SELECT CAST(d.key AS INTEGER),COUNT(*) FROM json_each(?) AS d CROSS JOIN messages AS m ON m.created_at>=json_extract(d.value,'$[0]') AND m.created_at<json_extract(d.value,'$[1]') WHERE m.from_kind='user' AND m.from_user_id=? AND m.cc_source_message_id IS NULL GROUP BY d.key ORDER BY CAST(d.key AS INTEGER)",
                user_id.as_str(),
            ),
            Principal::Agent { agent_id } => (
                "SELECT MIN(created_at) FROM messages WHERE from_kind='agent' AND from_agent_id=? AND cc_source_message_id IS NULL",
                "SELECT CAST(d.key AS INTEGER),COUNT(*) FROM json_each(?) AS d CROSS JOIN messages AS m ON m.created_at>=json_extract(d.value,'$[0]') AND m.created_at<json_extract(d.value,'$[1]') WHERE m.from_kind='agent' AND m.from_agent_id=? AND m.cc_source_message_id IS NULL GROUP BY d.key ORDER BY CAST(d.key AS INTEGER)",
                agent_id.as_str(),
            ),
            Principal::System => {
                return Err(PersistenceFailure::from_source(std::io::Error::other(
                    "system has no profile",
                )));
            }
        };
        let earliest_ms = sqlx::query_scalar::<_, Option<i64>>(first_sql)
            .bind(id)
            .fetch_one(&mut *tx)
            .await
            .map_err(PersistenceFailure::from_source)?;
        let days = sqlx::query_as::<_, (i64, i64)>(days_sql)
            .bind(serde_json::to_string(&year.day_bounds).map_err(PersistenceFailure::from_source)?)
            .bind(id)
            .fetch_all(&mut *tx)
            .await
            .map_err(PersistenceFailure::from_source)?;
        tx.commit().await.map_err(PersistenceFailure::from_source)?;
        Ok(ProfileMessageCounts { earliest_ms, days })
    }
}
