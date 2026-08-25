//! SQLite adapter for the agent-detail cold read.
//!
//! It supplies the facts [`silverhand_backend_core::agent_detail_read`] declares:
//! the agent row, its host `LEFT JOIN`, and the two set-shaped ACL arms, resolved
//! together on ONE `BEGIN DEFERRED` snapshot so the visibility a caller is judged
//! against and the values projected to the wire come from one view of the database.
//!
//! ## The ACL arms are the SHARED authority
//!
//! The direct-pair and workspace arms run [`crate::agent_view_acl`], the SAME SQL
//! `GET /api/agents/{id}/availability` decides against, so the two faces cannot
//! drift on who may see an agent. The creator arm is the agent row's
//! `created_by_user_id`, decoded ONCE and used both as the ACL creator and as the
//! wire's `created_by_user_id` — the gate input and the wire echo can never differ.
//!
//! ## Every committed value is decoded strictly
//!
//! Ids go through the domain's fallible parsers, the stage through
//! [`MaterializationStatus::parse`], and the reachable integer columns through an
//! `i64` decode: a stored value that cannot be a legal identity, a known stage, or a
//! number is corruption of a committed row and surfaces as a [`PersistenceFailure`]
//! (a safe `500`), never coerced to a default. The wire-shaped strings the DTO
//! passes through verbatim (name, runtime, model, …) carry no decode of their own.

use std::{path::Path, time::Duration};

use silverhand_backend_core::{
    agent_detail_read::{AgentDetailFacts, AgentDetailProjection, AgentDetailReadModel},
    agent_lifecycle::MaterializationStatus,
    identity::{AgentId, UserId},
    persistence::PersistenceFailure,
};
use sqlx::{
    Row, SqlitePool,
    sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions, SqliteSynchronous},
};
use thiserror::Error;

use crate::agent_view_acl::{SELECT_DIRECT_PAIR_HUMAN_ENDPOINTS, SELECT_SHARED_WORKSPACE_MEMBERS};

const POOL_CONNECTIONS: u32 = 4;
const BUSY_TIMEOUT: Duration = Duration::from_secs(5);
const DEFERRED_READ_BEGIN: &str = "BEGIN DEFERRED";

/// The agent row plus its host `LEFT JOIN` — every column the detail DTO projects,
/// in one bounded read. `idempotency_key`, the runtime-transition columns and
/// `last_activity_at` are deliberately unselected: they are not on the DTO.
const SELECT_AGENT_DETAIL_ROW: &str = "SELECT a.id, a.name, a.display_name, a.runtime, a.model, \
       a.reasoning_effort, a.fast_mode, a.host_id, a.description, a.session_scope, \
       a.created_by_user_id, a.avatar_storage_key, a.materialization_status, \
       a.materialization_failed_code, a.materialization_failed_at, a.deletion_started_at, \
       a.created_at, a.updated_at, h.display_label AS host_display_label, h.name AS host_name \
       FROM agents a LEFT JOIN hosts h ON h.id = a.host_id WHERE a.id = ?";

#[derive(Clone)]
pub struct SqliteAgentDetailColdRead {
    pool: SqlitePool,
}

/// Read failures surfaced only as the source of a [`PersistenceFailure`]. Every
/// variant is a driver fault or corruption of a committed row, never a
/// product-level refusal — those are decisions the core capability makes from the
/// facts this returns.
#[derive(Debug, Error)]
pub enum AgentDetailColdReadError {
    #[error("database operation failed")]
    Sql(#[from] sqlx::Error),
    #[error("stored column {column} does not name a usable identity")]
    MalformedIdentity { column: &'static str },
    #[error("stored agents.materialization_status holds {value:?}, which is not a known stage")]
    MalformedStatus { value: String },
}

impl SqliteAgentDetailColdRead {
    pub async fn open(path: impl AsRef<Path>) -> Result<Self, AgentDetailColdReadError> {
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

    async fn read_agent_detail_facts(
        &self,
        agent: &AgentId,
    ) -> Result<Option<AgentDetailFacts>, AgentDetailColdReadError> {
        let mut tx = self.pool.begin_with(DEFERRED_READ_BEGIN).await?;

        let row = sqlx::query(SELECT_AGENT_DETAIL_ROW)
            .bind(agent.as_str())
            .fetch_optional(&mut *tx)
            .await?;
        let Some(row) = row else {
            tx.commit().await?;
            return Ok(None);
        };

        let source: String = row.try_get("id")?;
        let source =
            AgentId::parse(source).map_err(|_| AgentDetailColdReadError::MalformedIdentity {
                column: "agents.id",
            })?;
        let created_by: String = row.try_get("created_by_user_id")?;
        let created_by =
            UserId::parse(created_by).map_err(|_| AgentDetailColdReadError::MalformedIdentity {
                column: "agents.created_by_user_id",
            })?;
        let status_raw: String = row.try_get("materialization_status")?;
        let materialization_status = MaterializationStatus::parse(&status_raw)
            .map_err(|_| AgentDetailColdReadError::MalformedStatus { value: status_raw })?;

        // SQLite stores the boolean as 0/1; a non-numeric text in the affinity-only
        // column is a decode error above, never a silent `false`. `agentRowToDto`
        // maps null → null and any value → Boolean(fast), which for the stored 0/1 is
        // exactly this `!= 0`.
        let fast_mode: Option<i64> = row.try_get("fast_mode")?;
        let fast_mode = fast_mode.map(|value| value != 0);

        let projection = AgentDetailProjection {
            name: row.try_get("name")?,
            display_name: row.try_get("display_name")?,
            runtime: row.try_get("runtime")?,
            model: row.try_get("model")?,
            reasoning_effort: row.try_get("reasoning_effort")?,
            fast_mode,
            host_id: row.try_get("host_id")?,
            host_display_label: row.try_get("host_display_label")?,
            host_name: row.try_get("host_name")?,
            description: row.try_get("description")?,
            session_scope: row.try_get("session_scope")?,
            avatar_storage_key: row.try_get("avatar_storage_key")?,
            materialization_failed_code: row.try_get("materialization_failed_code")?,
            materialization_failed_at: row.try_get("materialization_failed_at")?,
            deletion_started_at: row.try_get("deletion_started_at")?,
            created_at: row.try_get("created_at")?,
            updated_at: row.try_get("updated_at")?,
        };

        let pair_human_rows = sqlx::query(SELECT_DIRECT_PAIR_HUMAN_ENDPOINTS)
            .bind(agent.as_str())
            .bind(agent.as_str())
            .fetch_all(&mut *tx)
            .await?;
        let workspace_member_rows = sqlx::query(SELECT_SHARED_WORKSPACE_MEMBERS)
            .bind(agent.as_str())
            .bind(agent.as_str())
            .fetch_all(&mut *tx)
            .await?;

        tx.commit().await?;

        let direct_pair_human_endpoints =
            decode_user_ids(&pair_human_rows, "conversations.direct_pair human endpoint")?;
        let shared_workspace_members =
            decode_user_ids(&workspace_member_rows, "workspace_users.user_id")?;

        // The creator is passed ONCE: `from_source` seeds the ACL creator arm from it
        // and the wire's `created_by_user_id` reads the same field, so the adapter
        // cannot admit one human and render another.
        Ok(Some(AgentDetailFacts::from_source(
            source,
            created_by,
            direct_pair_human_endpoints,
            shared_workspace_members,
            materialization_status,
            projection,
        )))
    }
}

fn decode_user_ids(
    rows: &[sqlx::sqlite::SqliteRow],
    column: &'static str,
) -> Result<Vec<UserId>, AgentDetailColdReadError> {
    let mut ids = Vec::with_capacity(rows.len());
    for row in rows {
        let raw: String = row.try_get("user_id")?;
        let id = UserId::parse(raw)
            .map_err(|_| AgentDetailColdReadError::MalformedIdentity { column })?;
        ids.push(id);
    }
    Ok(ids)
}

impl AgentDetailReadModel for SqliteAgentDetailColdRead {
    async fn read_agent_detail(
        &self,
        agent: &AgentId,
    ) -> Result<Option<AgentDetailFacts>, PersistenceFailure> {
        self.read_agent_detail_facts(agent)
            .await
            .map_err(PersistenceFailure::from_source)
    }
}
