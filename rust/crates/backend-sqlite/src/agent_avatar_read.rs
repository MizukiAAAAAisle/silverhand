//! SQLite adapter for the agent-avatar serve-ref read (`GET /api/agents/{id}/avatar`).
//!
//! It reads the agents row's `(avatar_storage_key, avatar_content_type)` pair and
//! hands it to the core decoder ([`decode_agent_avatar_serve_ref`]), which enforces
//! the strict four-state contract: both-absent → [`AgentAvatarServeRef::Absent`],
//! both-present-and-valid → [`AgentAvatarServeRef::Present`], and any half-populated
//! or malformed pair → an [`AgentAvatarRowCorruption`] this adapter surfaces as a
//! [`PersistenceFailure`] (a safe `500`), never a silent `avatar not found`.
//!
//! A missing row is the same absent state as a both-`NULL` pair: the caller has
//! already cleared the visibility authority, so a row that vanished between the gate
//! and this read is simply "no avatar", not an existence signal.

use std::{path::Path, time::Duration};

use silverhand_backend_core::{
    agent_avatar::{AgentAvatarServeRef, AgentAvatarServeRefRead, decode_agent_avatar_serve_ref},
    identity::AgentId,
    persistence::PersistenceFailure,
};
use sqlx::{
    Row, SqlitePool,
    sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions, SqliteSynchronous},
};

const POOL_CONNECTIONS: u32 = 4;
const BUSY_TIMEOUT: Duration = Duration::from_secs(5);

/// The serve-ref read: only the two avatar columns, narrowed to ONE id. It is
/// deliberately NOT the full detail projection — the byte fetch needs only the
/// pointer and its content type, never the wire DTO.
const SELECT_AGENT_AVATAR_REF: &str =
    "SELECT avatar_storage_key, avatar_content_type FROM agents WHERE id = ?";

#[derive(Clone)]
pub struct SqliteAgentAvatarRead {
    pool: SqlitePool,
}

impl SqliteAgentAvatarRead {
    pub async fn open(path: impl AsRef<Path>) -> Result<Self, sqlx::Error> {
        let options = SqliteConnectOptions::new()
            .filename(path.as_ref())
            .create_if_missing(false)
            .foreign_keys(true)
            .journal_mode(SqliteJournalMode::Wal)
            .synchronous(SqliteSynchronous::Full)
            .busy_timeout(BUSY_TIMEOUT);
        let pool = SqlitePoolOptions::new()
            .max_connections(POOL_CONNECTIONS)
            .connect_with(options)
            .await?;
        Ok(Self { pool })
    }

    pub fn from_pool(pool: SqlitePool) -> Self {
        Self { pool }
    }
}

impl AgentAvatarServeRefRead for SqliteAgentAvatarRead {
    async fn read_agent_avatar_serve_ref(
        &self,
        agent: &AgentId,
    ) -> Result<AgentAvatarServeRef, PersistenceFailure> {
        let row = sqlx::query(SELECT_AGENT_AVATAR_REF)
            .bind(agent.as_str())
            .fetch_optional(&self.pool)
            .await
            .map_err(PersistenceFailure::from_source)?;
        // No row is the same "no avatar" as a both-NULL pair: visibility was already
        // settled, so a vanished row is not an existence oracle.
        let Some(row) = row else {
            return Ok(AgentAvatarServeRef::Absent);
        };
        let storage_key: Option<String> = row
            .try_get("avatar_storage_key")
            .map_err(PersistenceFailure::from_source)?;
        let content_type: Option<String> = row
            .try_get("avatar_content_type")
            .map_err(PersistenceFailure::from_source)?;
        // The two columns are decoded as ONE typed shape; corruption becomes a
        // safe-500 carrying its cause, never folded into `avatar not found`.
        decode_agent_avatar_serve_ref(storage_key.as_deref(), content_type.as_deref())
            .map_err(PersistenceFailure::from_source)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use silverhand_backend_core::avatar::AvatarContentType;
    use sqlx::{Connection, Executor, SqliteConnection};

    const CURRENT_SCHEMA: &str =
        include_str!("../../../../packages/backend/tests/migration-baseline/schema-current.sql");

    // A host + creator, then four agents exercising every reachable stored shape:
    //  - `a-present`: a valid key + allowlisted content type (the serve coordinate);
    //  - `a-absent`: both columns NULL (no avatar);
    //  - `a-empty`: an EMPTY key with a content type — passes the NULL-coupling CHECK
    //    but never came from the writer, so it is corruption;
    //  - `a-badmime`: a valid key with a content type outside the allowlist.
    // A half-NULL pair is unreachable (the schema CHECK rejects it), so that decode
    // arm is proven at the core unit layer instead.
    const SEED_SQL: &str = "\
INSERT INTO users (id, name, display_name, created_at, updated_at) \
  VALUES ('user-1', 'owner', 'Owner', 1, 1); \
INSERT INTO hosts (id, name, kind, created_at) VALUES ('host-1', 'Host', 'local', 1); \
INSERT INTO agents (id, name, display_name, runtime, host_id, created_by_user_id, avatar_storage_key, avatar_content_type, created_at, updated_at) \
  VALUES ('a-present', 'p', 'P', 'claude', 'host-1', 'user-1', 'agents/a-present/avatars/blob-0.png', 'image/png', 10, 100); \
INSERT INTO agents (id, name, display_name, runtime, host_id, created_by_user_id, created_at, updated_at) \
  VALUES ('a-absent', 'ab', 'Ab', 'claude', 'host-1', 'user-1', 10, 100); \
INSERT INTO agents (id, name, display_name, runtime, host_id, created_by_user_id, avatar_storage_key, avatar_content_type, created_at, updated_at) \
  VALUES ('a-empty', 'e', 'E', 'claude', 'host-1', 'user-1', '', 'image/png', 10, 100); \
INSERT INTO agents (id, name, display_name, runtime, host_id, created_by_user_id, avatar_storage_key, avatar_content_type, created_at, updated_at) \
  VALUES ('a-badmime', 'b', 'B', 'claude', 'host-1', 'user-1', 'agents/a-badmime/avatars/blob-0', 'application/pdf', 10, 100);";

    async fn open_seeded() -> (tempfile::TempDir, SqliteAgentAvatarRead) {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("agent-avatar-read.sqlite");
        let options = SqliteConnectOptions::new()
            .filename(&path)
            .create_if_missing(true)
            .foreign_keys(true);
        let mut db = SqliteConnection::connect_with(&options).await.unwrap();
        db.execute(sqlx::raw_sql(CURRENT_SCHEMA)).await.unwrap();
        db.execute(sqlx::raw_sql(SEED_SQL)).await.unwrap();
        db.close().await.unwrap();
        let adapter = SqliteAgentAvatarRead::open(&path).await.unwrap();
        (directory, adapter)
    }

    fn agent(id: &str) -> AgentId {
        AgentId::parse(id).unwrap()
    }

    #[tokio::test]
    async fn a_valid_pair_decodes_to_the_serve_coordinate() {
        let (_dir, adapter) = open_seeded().await;
        let decoded = adapter
            .read_agent_avatar_serve_ref(&agent("a-present"))
            .await
            .unwrap();
        let AgentAvatarServeRef::Present {
            pointer,
            content_type,
        } = decoded
        else {
            panic!("expected Present");
        };
        assert_eq!(pointer.as_str(), "agents/a-present/avatars/blob-0.png");
        assert_eq!(content_type, AvatarContentType::Png);
    }

    #[tokio::test]
    async fn both_null_columns_are_absent() {
        let (_dir, adapter) = open_seeded().await;
        assert_eq!(
            adapter
                .read_agent_avatar_serve_ref(&agent("a-absent"))
                .await
                .unwrap(),
            AgentAvatarServeRef::Absent
        );
    }

    #[tokio::test]
    async fn a_missing_row_is_absent_not_an_error() {
        let (_dir, adapter) = open_seeded().await;
        assert_eq!(
            adapter
                .read_agent_avatar_serve_ref(&agent("nobody"))
                .await
                .unwrap(),
            AgentAvatarServeRef::Absent
        );
    }

    #[tokio::test]
    async fn an_empty_key_row_is_a_safe_500_not_absent() {
        let (_dir, adapter) = open_seeded().await;
        adapter
            .read_agent_avatar_serve_ref(&agent("a-empty"))
            .await
            .expect_err("an empty stored key is corruption, never `avatar not found`");
    }

    #[tokio::test]
    async fn an_out_of_allowlist_content_type_is_a_safe_500() {
        let (_dir, adapter) = open_seeded().await;
        adapter
            .read_agent_avatar_serve_ref(&agent("a-badmime"))
            .await
            .expect_err("a stored content type outside the allowlist is corruption");
    }
}
