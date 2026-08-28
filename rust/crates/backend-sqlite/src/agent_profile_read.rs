//! SQLite adapter for the narrow internal agent-profile read.
//!
//! It supplies the facts [`silverhand_backend_core::agent_profile_read`]
//! declares — one agent's `{ id, name, display_name, description, avatar }` —
//! and NOTHING wider. Unlike [`crate::agent_detail_read`] it takes no host
//! `LEFT JOIN` and runs no `agent_view_acl`: the internal profile routes are
//! self-pinned or peer-gated in the route's own gate, never judged against a
//! viewer's arms, so this read carries no visibility authority to leak into
//! them.
//!
//! ## The id is re-sourced, not trusted from the query
//!
//! The query binds a `:aid`, but the fact's [`AgentId`] is decoded from the
//! RETURNED row's `id` column through the domain's fallible parser. A route
//! binds its response to that sealed id rather than to the coordinate it asked
//! for, so a peer read (which will look up by handle) hands back the target's
//! real id and a corrupt empty id fails closed as a read error, never a silent
//! coercion.
//!
//! ## The avatar folds to a revision, never a storage locator
//!
//! `agents.avatar_storage_key` + `updated_at` collapse HERE into
//! `Option<AvatarRevision>` using the same truthiness rule the canonical
//! `avatar_url` derivation applies (a non-empty key is an avatar; empty/NULL is
//! none). The storage key never crosses this boundary — the profile face needs
//! only presence and the cache-buster, and only a route that actually streams
//! the blob consumes a typed blob ref.

use std::{path::Path, time::Duration};

use silverhand_backend_core::{
    agent_profile_read::{AgentProfileFact, AgentProfileReadModel},
    identity::AgentId,
    messaging::AvatarRevision,
    persistence::PersistenceFailure,
};
use sqlx::{
    Row, SqlitePool,
    sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions, SqliteSynchronous},
};
use thiserror::Error;

const POOL_CONNECTIONS: u32 = 4;
const BUSY_TIMEOUT: Duration = Duration::from_secs(5);
const DEFERRED_READ_BEGIN: &str = "BEGIN DEFERRED";

/// The narrow profile read: only the columns the internal profile DTO and its
/// avatar-URL derivation consume, resolved for ONE id. No host join, no ACL SQL,
/// no wire-vocabulary columns (runtime/model/…) — those belong to the detail
/// read, not here. Composed as a `&'static str` because sqlx accepts no
/// runtime-built statement.
const SELECT_AGENT_PROFILE_ROW: &str = "SELECT id, name, display_name, description, \
     avatar_storage_key, updated_at FROM agents WHERE id = ?";

#[derive(Clone)]
pub struct SqliteAgentProfileRead {
    pool: SqlitePool,
}

/// Read failures surfaced only as the source of a [`PersistenceFailure`]. Every
/// variant is a driver fault or corruption of a committed row, never a
/// product-level refusal — an absent row is `Ok(None)`, the route's `404`.
#[derive(Debug, Error)]
pub enum AgentProfileReadError {
    #[error("database operation failed")]
    Sql(#[from] sqlx::Error),
    #[error("stored agents.id does not name a usable identity")]
    MalformedIdentity,
}

impl SqliteAgentProfileRead {
    pub async fn open(path: impl AsRef<Path>) -> Result<Self, AgentProfileReadError> {
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

    async fn read_agent_profile_fact(
        &self,
        agent: &AgentId,
    ) -> Result<Option<AgentProfileFact>, AgentProfileReadError> {
        let mut tx = self.pool.begin_with(DEFERRED_READ_BEGIN).await?;

        let row = sqlx::query(SELECT_AGENT_PROFILE_ROW)
            .bind(agent.as_str())
            .fetch_optional(&mut *tx)
            .await?;
        let Some(row) = row else {
            tx.commit().await?;
            return Ok(None);
        };

        // The id is re-sourced from the returned row, not the bound coordinate:
        // the fact is bound to a verified source, and an empty stored id fails
        // closed here rather than reaching the wire.
        let stored_id: String = row.try_get("id")?;
        let id = AgentId::parse(stored_id).map_err(|_| AgentProfileReadError::MalformedIdentity)?;

        // Truthiness, not `IS NOT NULL`: an empty key is no avatar, matching the
        // canonical `avatar_url` rule. The revision is the row's `updated_at`, the
        // same cache-buster the wire appends.
        let avatar_storage_key: Option<String> = row.try_get("avatar_storage_key")?;
        let updated_at: i64 = row.try_get("updated_at")?;
        let avatar = avatar_storage_key
            .filter(|key| !key.is_empty())
            .map(|_| AvatarRevision::at(updated_at));

        let fact = AgentProfileFact {
            id,
            name: row.try_get("name")?,
            display_name: row.try_get("display_name")?,
            description: row.try_get("description")?,
            avatar,
        };

        tx.commit().await?;
        Ok(Some(fact))
    }
}

impl AgentProfileReadModel for SqliteAgentProfileRead {
    async fn read_agent_profile(
        &self,
        agent: &AgentId,
    ) -> Result<Option<AgentProfileFact>, PersistenceFailure> {
        self.read_agent_profile_fact(agent)
            .await
            .map_err(PersistenceFailure::from_source)
    }
}
