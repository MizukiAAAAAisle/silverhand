//! SQLite adapter for the stored half of the availability cold read.
//!
//! It supplies the facts [`silverhand_backend_core::agent_availability_read`]
//! declares, in the two reads that module separates: the agent view before the
//! ACL gate, and the host row only after it passes.
//!
//! ## The agent view is ONE deferred snapshot
//!
//! [`read_agent_view`](AgentAvailabilityReadModel::read_agent_view) reads the
//! agent row and the two set-shaped ACL arms (the human endpoints of the agent's
//! direct pairs, and the members of every workspace the agent reaches) inside a
//! single `BEGIN DEFERRED` transaction, so the visibility a caller is judged
//! against and the reachability inputs a value is later computed from come from
//! ONE view of the database. A write landing between the arm reads cannot make an
//! agent pass the ACL as it stood and then be answered from a later row.
//!
//! ## The three ACL arms are the SAME SQL the TypeScript authority runs
//!
//! The creator arm is the agent row's `created_by_user_id`; the direct-pair arm
//! is `DIRECT_PAIR_HUMAN_ENDPOINT_IDS_FOR_AGENT_SQL`, gating the OTHER endpoint on
//! `= 'human'` in both slot orders so an agent↔agent pair contributes nobody; the
//! workspace arm unions `workspace_users` over every workspace the agent is a
//! member of PLUS the agent's own agent-home workspace, exactly the set
//! `agentWorkspaceIds` (`workspaces.listForAgent`) feeds `workspaceMemberUserIds`.
//! Dropping any one arm hides a viewer admitted only by it — the differential the
//! route tests pin.
//!
//! ## Every committed value is decoded strictly
//!
//! Ids go through the domain's fallible parsers and the stage through
//! [`MaterializationStatus::parse`]: a stored value that cannot be a legal
//! identity or a known stage is corruption of a committed row and surfaces as a
//! [`PersistenceFailure`] (a safe `500`), never coerced to a default.

use std::{path::Path, time::Duration};

use silverhand_backend_core::{
    agent_availability_read::{AgentAvailabilityReadModel, AgentViewFacts},
    agent_lifecycle::MaterializationStatus,
    capability::agent_view::{AgentViewerArms, AgentVisibility},
    cold_read::availability::HostReachabilityFacts,
    identity::{AgentId, HostId, UserId},
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

const SELECT_AGENT_ROW: &str = "SELECT id, host_id, created_by_user_id, materialization_status, \
     deletion_started_at FROM agents WHERE id = ?";

/// Port of `DIRECT_PAIR_HUMAN_ENDPOINT_IDS_FOR_AGENT_SQL`: the human endpoint of
/// every human↔agent direct pair this agent is in, both slot orders, with the
/// OTHER endpoint gated on `'human'`. Binds the agent id once per arm.
const SELECT_DIRECT_PAIR_HUMAN_ENDPOINTS: &str = "SELECT endpoint_b_id AS user_id \
       FROM conversations \
      WHERE placement_kind = 'direct_pair' \
        AND endpoint_a_kind = 'agent' AND endpoint_a_id = ? \
        AND endpoint_b_kind = 'human' \
      UNION \
     SELECT endpoint_a_id AS user_id \
       FROM conversations \
      WHERE placement_kind = 'direct_pair' \
        AND endpoint_b_kind = 'agent' AND endpoint_b_id = ? \
        AND endpoint_a_kind = 'human'";

/// The workspace arm: the members of every workspace the agent reaches — the
/// regular workspaces it is a `workspace_members` row of, plus its own agent-home
/// workspace (`owner_agent_id = agent`). The exact set `agentWorkspaceIds` hands
/// `workspaceMemberUserIds`. Binds the agent id once per arm of the inner union.
const SELECT_SHARED_WORKSPACE_MEMBERS: &str = "SELECT DISTINCT wu.user_id \
       FROM workspace_users wu \
      WHERE wu.workspace_id IN ( \
        SELECT w.id FROM workspaces w \
          JOIN workspace_members wm ON wm.workspace_id = w.id \
         WHERE wm.agent_id = ? AND w.owner_agent_id IS NULL \
        UNION \
        SELECT w.id FROM workspaces w WHERE w.owner_agent_id = ? \
      )";

const SELECT_HOST_ROW: &str = "SELECT revoked_at FROM hosts WHERE id = ?";

#[derive(Clone)]
pub struct SqliteAgentAvailabilityColdRead {
    pool: SqlitePool,
}

/// Read failures surfaced only as the source of a [`PersistenceFailure`]. Every
/// variant is a driver fault or corruption of a committed row, never a
/// product-level refusal — those are decisions the core capabilities make from
/// the facts this returns.
#[derive(Debug, Error)]
pub enum AgentAvailabilityColdReadError {
    #[error("database operation failed")]
    Sql(#[from] sqlx::Error),
    #[error("stored column {column} does not name a usable identity")]
    MalformedIdentity { column: &'static str },
    #[error("stored agents.materialization_status holds {value:?}, which is not a known stage")]
    MalformedStatus { value: String },
}

impl SqliteAgentAvailabilityColdRead {
    pub async fn open(path: impl AsRef<Path>) -> Result<Self, AgentAvailabilityColdReadError> {
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

    async fn read_agent_view_facts(
        &self,
        agent: &AgentId,
    ) -> Result<Option<AgentViewFacts>, AgentAvailabilityColdReadError> {
        let mut tx = self.pool.begin_with(DEFERRED_READ_BEGIN).await?;

        let row = sqlx::query(SELECT_AGENT_ROW)
            .bind(agent.as_str())
            .fetch_optional(&mut *tx)
            .await?;
        let Some(row) = row else {
            tx.commit().await?;
            return Ok(None);
        };

        let source: String = row.try_get("id")?;
        let source = AgentId::parse(source).map_err(|_| {
            AgentAvailabilityColdReadError::MalformedIdentity {
                column: "agents.id",
            }
        })?;
        let host_id: String = row.try_get("host_id")?;
        let host_id = HostId::parse(host_id).map_err(|_| {
            AgentAvailabilityColdReadError::MalformedIdentity {
                column: "agents.host_id",
            }
        })?;
        let creator: String = row.try_get("created_by_user_id")?;
        let creator = UserId::parse(creator).map_err(|_| {
            AgentAvailabilityColdReadError::MalformedIdentity {
                column: "agents.created_by_user_id",
            }
        })?;
        let status_raw: String = row.try_get("materialization_status")?;
        let materialization_status = MaterializationStatus::parse(&status_raw)
            .map_err(|_| AgentAvailabilityColdReadError::MalformedStatus { value: status_raw })?;
        let deletion_started_at: Option<i64> = row.try_get("deletion_started_at")?;

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

        let viewers = AgentViewerArms::new(
            Some(creator),
            direct_pair_human_endpoints,
            shared_workspace_members,
        );
        Ok(Some(AgentViewFacts::from_source(
            source,
            AgentVisibility {
                viewers,
                materialization_status,
            },
            host_id,
            deletion_started_at,
        )))
    }

    async fn read_host_reachability_row(
        &self,
        host: &HostId,
    ) -> Result<Option<HostReachabilityFacts>, AgentAvailabilityColdReadError> {
        let Some(row) = sqlx::query(SELECT_HOST_ROW)
            .bind(host.as_str())
            .fetch_optional(&self.pool)
            .await?
        else {
            return Ok(None);
        };
        let revoked_at: Option<i64> = row.try_get("revoked_at")?;
        Ok(Some(HostReachabilityFacts {
            id: host.clone(),
            revoked_at,
        }))
    }
}

fn decode_user_ids(
    rows: &[sqlx::sqlite::SqliteRow],
    column: &'static str,
) -> Result<Vec<UserId>, AgentAvailabilityColdReadError> {
    let mut ids = Vec::with_capacity(rows.len());
    for row in rows {
        let raw: String = row.try_get("user_id")?;
        let id = UserId::parse(raw)
            .map_err(|_| AgentAvailabilityColdReadError::MalformedIdentity { column })?;
        ids.push(id);
    }
    Ok(ids)
}

impl AgentAvailabilityReadModel for SqliteAgentAvailabilityColdRead {
    async fn read_agent_view(
        &self,
        agent: &AgentId,
    ) -> Result<Option<AgentViewFacts>, PersistenceFailure> {
        self.read_agent_view_facts(agent)
            .await
            .map_err(PersistenceFailure::from_source)
    }

    async fn read_host_reachability(
        &self,
        host: &HostId,
    ) -> Result<Option<HostReachabilityFacts>, PersistenceFailure> {
        self.read_host_reachability_row(host)
            .await
            .map_err(PersistenceFailure::from_source)
    }
}
