//! SQLite runtime dispatch projection and durable inbox leases.

use std::{collections::HashSet, path::Path, time::Duration};

use serde::Serialize;
use silverhand_backend_core::{
    agents::{runtime::RuntimeKind, session_scope::AgentSessionScope},
    identity::{AgentId, ConversationId, DaemonInstanceId, UserId, WorkspaceId},
    messaging::{FromKind, MessageContent, ReferencePositions},
    persistence::PersistenceFailure,
    policy::agent_presence,
    runtime_credential::{RuntimeGeneration, RuntimePrincipal, RuntimeScope},
    runtime_delivery::{
        ClaimPendingInbox, ClaimedInboxBatch, ClaimedInboxDelivery, DeliveryInstruction,
        DeliveryLeaseOwner, InboxDeliveryId, InboxSettlementDisposition, MAX_DELIVERIES_PER_BATCH,
        MAX_ENCODED_DELIVERY_BYTES, RuntimeAgentSpec, RuntimeDeliveryFailureReason,
        RuntimeDispatchReadPort, RuntimeDispatchTarget, RuntimeInboxCustodyPort, RuntimeMember,
        RuntimePlacement, RuntimeRoster, RuntimeSessionSpec, RuntimeSpawnPlan, RuntimeWorkspaceRef,
        classify_delivery_instruction, runtime_scope_for,
    },
    runtime_event::{
        CommitRuntimeConsumed, CommitRuntimeExit, CommitRuntimeSessionInit, DaemonEventDurablePort,
        ProjectRuntimeStatus, RefineRuntimeToolCallInput, RefinedRuntimeActivity,
        RuntimeActivityCommitResult, RuntimeActivityFact, RuntimeActivityKind,
        RuntimeActivityPayload, RuntimeConsumedCommitResult, RuntimeEventAdmission,
        RuntimeExitCommitResult, RuntimeExitDisposition, RuntimeSessionInitCommitResult,
        RuntimeStatusCommitResult, RuntimeStatusTarget, RuntimeToolCallInputCommitResult,
        StampRuntimePresence, UpsertRuntimeTextActivity,
    },
};
use sqlx::{
    Row, Sqlite, SqlitePool, Transaction,
    sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions, SqliteSynchronous},
};
use thiserror::Error;

const ROOT_WRITE_BEGIN: &str = "BEGIN IMMEDIATE";

#[derive(Clone)]
pub struct SqliteRuntimeDeliveryStore {
    pool: SqlitePool,
}

#[derive(Debug, Error)]
pub enum SqliteRuntimeDeliveryStoreError {
    #[error("database operation failed")]
    Sql(#[from] sqlx::Error),
}

impl SqliteRuntimeDeliveryStore {
    pub async fn open(path: impl AsRef<Path>) -> Result<Self, SqliteRuntimeDeliveryStoreError> {
        let options = SqliteConnectOptions::new()
            .filename(path.as_ref())
            .create_if_missing(false)
            .foreign_keys(true)
            .journal_mode(SqliteJournalMode::Wal)
            .synchronous(SqliteSynchronous::Full)
            .busy_timeout(Duration::from_secs(5));
        let pool = SqlitePoolOptions::new()
            .max_connections(4)
            .connect_with(options)
            .await?;
        Ok(Self { pool })
    }

    async fn resolve_target(
        &self,
        conversation: ConversationId,
        agent: AgentId,
    ) -> Result<Option<RuntimeDispatchTarget>, PersistenceFailure> {
        let Some(agent_row) = sqlx::query(
            "SELECT a.name, a.runtime, a.model, a.reasoning_effort, a.fast_mode,
                    a.host_id, a.session_scope, s.cli_session_id
               FROM agents a
               LEFT JOIN agent_runtime_slots s
                 ON s.agent_id = a.id
                AND ((a.session_scope = 'agent' AND s.conversation_id IS NULL)
                  OR (a.session_scope = 'conversation' AND s.conversation_id = ?))
              WHERE a.id = ?",
        )
        .bind(conversation.as_str())
        .bind(agent.as_str())
        .fetch_optional(&self.pool)
        .await
        .map_err(persistence)?
        else {
            return Ok(None);
        };
        let session_scope: String = agent_row.try_get("session_scope").map_err(persistence)?;
        let scope = runtime_scope_for(agent.clone(), conversation.clone(), &session_scope)
            .map_err(PersistenceFailure::from_source)?;
        let runtime: String = agent_row.try_get("runtime").map_err(persistence)?;
        let runtime = RuntimeKind::parse(&runtime)
            .ok_or_else(|| PersistenceFailure::from_source(InvalidPersistedRuntimeKind))?;
        let agent_spec = RuntimeAgentSpec {
            id: agent.clone(),
            name: agent_row.try_get("name").map_err(persistence)?,
            runtime,
            model: agent_row.try_get("model").map_err(persistence)?,
            reasoning_effort: agent_row.try_get("reasoning_effort").map_err(persistence)?,
            fast_mode: agent_row
                .try_get::<Option<i64>, _>("fast_mode")
                .map_err(persistence)?
                .map(|value| value != 0),
            cli_session_id: agent_row.try_get("cli_session_id").map_err(persistence)?,
        };
        let host_id: String = agent_row.try_get("host_id").map_err(persistence)?;
        if host_id.is_empty() {
            return Err(PersistenceFailure::from_source(
                InvalidPersistedRuntimeTarget,
            ));
        }

        let workspace_memory_index = read_workspace_memory_index(&self.pool, &agent).await?;
        let (workspace, session) = match &scope {
            RuntimeScope::AgentSlot { .. } => (None, None),
            RuntimeScope::ConversationSlot { .. } => {
                let Some(row) = sqlx::query(
                    "SELECT c.placement_kind, c.roster_policy, c.title,
                            c.spawned_by_agent_id, c.workspace_id,
                            w.name AS workspace_name
                       FROM conversations c
                       LEFT JOIN workspaces w ON w.id = c.workspace_id
                      WHERE c.id = ?",
                )
                .bind(conversation.as_str())
                .fetch_optional(&self.pool)
                .await
                .map_err(persistence)?
                else {
                    return Ok(None);
                };
                let placement_raw: String = row.try_get("placement_kind").map_err(persistence)?;
                let placement = decode_placement(&placement_raw)?;
                let roster_raw: String = row.try_get("roster_policy").map_err(persistence)?;
                let roster = decode_roster(&roster_raw)?;
                let workspace_id: Option<String> =
                    row.try_get("workspace_id").map_err(persistence)?;
                let workspace_name: Option<String> =
                    row.try_get("workspace_name").map_err(persistence)?;
                let workspace = match (workspace_id, workspace_name) {
                    (Some(id), Some(name)) => Some(RuntimeWorkspaceRef::decoded(
                        WorkspaceId::parse(id).map_err(PersistenceFailure::from_source)?,
                        name,
                    )),
                    (None, None) if placement == RuntimePlacement::DirectPair => None,
                    _ => {
                        return Err(PersistenceFailure::from_source(
                            InvalidPersistedRuntimeTarget,
                        ));
                    }
                };
                let spawned_by_agent = row
                    .try_get::<Option<String>, _>("spawned_by_agent_id")
                    .map_err(persistence)?
                    .map(AgentId::parse)
                    .transpose()
                    .map_err(PersistenceFailure::from_source)?;
                let members = read_members(&self.pool, &conversation, placement).await?;
                let session = RuntimeSessionSpec {
                    conversation: conversation.clone(),
                    placement,
                    roster,
                    title: row.try_get("title").map_err(persistence)?,
                    spawned_by_agent,
                    members,
                };
                (workspace, Some(session))
            }
        };

        Ok(Some(RuntimeDispatchTarget {
            host_id,
            conversation,
            plan: RuntimeSpawnPlan {
                scope,
                agent: agent_spec,
                workspace,
                workspace_memory_index,
                session,
            },
        }))
    }

    #[allow(clippy::too_many_arguments)]
    async fn claim<P: ReferencePositions + Sync>(
        &self,
        host_id: String,
        principal: RuntimePrincipal,
        conversation: ConversationId,
        owner: DeliveryLeaseOwner,
        now_ms: i64,
        lease_ttl_ms: i64,
        reference_positions: &P,
    ) -> Result<ClaimPendingInbox, PersistenceFailure> {
        if lease_ttl_ms <= 0 {
            return Err(PersistenceFailure::from_source(InvalidLeaseTtl));
        }
        let mut tx = self
            .pool
            .begin_with(ROOT_WRITE_BEGIN)
            .await
            .map_err(persistence)?;
        if !principal_is_current(&mut tx, &host_id, &principal).await? {
            tx.commit().await.map_err(persistence)?;
            return Ok(ClaimPendingInbox::StaleCustody);
        }
        let expires_before = now_ms.saturating_sub(lease_ttl_ms);
        sqlx::query(
            "UPDATE conversation_inboxes
                SET in_flight_owner = NULL, in_flight_at = NULL
              WHERE conversation_id = ? AND agent_id = ?
                AND delivered_at IS NULL AND failed_at IS NULL
                AND in_flight_owner IS NOT NULL
                AND in_flight_at IS NOT NULL AND in_flight_at <= ?",
        )
        .bind(conversation.as_str())
        .bind(principal.agent().as_str())
        .bind(expires_before)
        .execute(&mut *tx)
        .await
        .map_err(persistence)?;

        let rows = sqlx::query(
            "SELECT i.id AS inbox_id, i.delivery_kind, m.id AS message_id,
                    m.conversation_id AS message_conversation_id,
                    m.seq, m.from_kind, m.from_agent_id, m.from_user_id,
                    m.content, m.metadata, m.created_at, m.thread_root_id,
                    recipient.id AS recipient_id, recipient.name AS recipient_name,
                    sender_agent.name AS sender_agent_name,
                    sender_host.id AS sender_host_id,
                    COALESCE(sender_user.name,
                        CASE c.placement_kind
                            WHEN 'workspace' THEN (
                                SELECT CASE WHEN COUNT(*) = 1 THEN MAX(u.name) END
                                  FROM conversation_users cu
                                  JOIN workspace_users wu
                                    ON wu.workspace_id = c.workspace_id
                                   AND wu.user_id = cu.user_id
                                  JOIN users u ON u.id = cu.user_id
                                 WHERE cu.conversation_id = c.id
                            )
                            WHEN 'direct_pair' THEN
                                CASE
                                    WHEN c.endpoint_a_kind = 'human'
                                     AND c.endpoint_b_kind <> 'human'
                                        THEN endpoint_a_user.name
                                    WHEN c.endpoint_b_kind = 'human'
                                     AND c.endpoint_a_kind <> 'human'
                                        THEN endpoint_b_user.name
                                    ELSE NULL
                                END
                            ELSE NULL
                        END
                    ) AS sender_user_name,
                    c.placement_kind, c.title AS conversation_title,
                    c.endpoint_a_kind, c.endpoint_a_id,
                    c.endpoint_b_kind, c.endpoint_b_id,
                    endpoint_a_agent.name AS endpoint_a_agent_name,
                    endpoint_a_user.name AS endpoint_a_user_name,
                    endpoint_b_agent.name AS endpoint_b_agent_name,
                    endpoint_b_user.name AS endpoint_b_user_name,
                    w.name AS workspace_name,
                    strftime('%Y-%m-%dT%H:%M:%S', m.created_at / 1000.0,
                             'unixepoch', 'localtime') AS local_time,
                    CAST(ROUND((
                        julianday(m.created_at / 1000.0, 'unixepoch', 'localtime') -
                        julianday(m.created_at / 1000.0, 'unixepoch')
                    ) * 1440.0) AS INTEGER) AS offset_minutes
               FROM conversation_inboxes i
               JOIN messages m ON m.id = i.message_id
               JOIN agents recipient ON recipient.id = i.agent_id
               JOIN conversations c ON c.id = m.conversation_id
               LEFT JOIN workspaces w ON w.id = c.workspace_id
               LEFT JOIN agents sender_agent ON sender_agent.id = m.from_agent_id
               LEFT JOIN hosts sender_host ON sender_host.id = sender_agent.host_id
               LEFT JOIN users sender_user ON sender_user.id = m.from_user_id
               LEFT JOIN agents endpoint_a_agent
                 ON c.endpoint_a_kind = 'agent' AND endpoint_a_agent.id = c.endpoint_a_id
               LEFT JOIN users endpoint_a_user
                 ON c.endpoint_a_kind = 'human' AND endpoint_a_user.id = c.endpoint_a_id
               LEFT JOIN agents endpoint_b_agent
                 ON c.endpoint_b_kind = 'agent' AND endpoint_b_agent.id = c.endpoint_b_id
               LEFT JOIN users endpoint_b_user
                 ON c.endpoint_b_kind = 'human' AND endpoint_b_user.id = c.endpoint_b_id
              WHERE i.conversation_id = ? AND i.agent_id = ?
                AND i.delivered_at IS NULL AND i.failed_at IS NULL
                AND i.in_flight_owner IS NULL
              ORDER BY i.id ASC
              LIMIT ?",
        )
        .bind(conversation.as_str())
        .bind(principal.agent().as_str())
        .bind(i64::try_from(MAX_DELIVERIES_PER_BATCH).expect("batch limit fits i64"))
        .fetch_all(&mut *tx)
        .await
        .map_err(persistence)?;

        let mut deliveries = Vec::new();
        for row in rows {
            let delivery = decode_delivery(&row, reference_positions)?;
            let mut candidate = deliveries.clone();
            candidate.push(delivery.clone());
            if encoded_batch_size(&candidate)? > MAX_ENCODED_DELIVERY_BYTES {
                if deliveries.is_empty() {
                    sqlx::query(
                        "UPDATE conversation_inboxes
                            SET failed_at = ?, failed_reason = 'encoded_oversize'
                          WHERE id = ? AND delivered_at IS NULL AND failed_at IS NULL
                            AND in_flight_owner IS NULL",
                    )
                    .bind(now_ms)
                    .bind(delivery.id().as_i64())
                    .execute(&mut *tx)
                    .await
                    .map_err(persistence)?;
                    continue;
                }
                break;
            }
            deliveries.push(delivery);
        }
        if deliveries.is_empty() {
            tx.commit().await.map_err(persistence)?;
            return Ok(ClaimPendingInbox::Empty);
        }
        for delivery in &deliveries {
            let changed = sqlx::query(
                "UPDATE conversation_inboxes
                    SET in_flight_owner = ?, in_flight_at = ?
                  WHERE id = ? AND conversation_id = ? AND agent_id = ?
                    AND delivered_at IS NULL AND failed_at IS NULL
                    AND in_flight_owner IS NULL",
            )
            .bind(owner.as_str())
            .bind(now_ms)
            .bind(delivery.id().as_i64())
            .bind(conversation.as_str())
            .bind(principal.agent().as_str())
            .execute(&mut *tx)
            .await
            .map_err(persistence)?
            .rows_affected();
            if changed != 1 {
                return Err(PersistenceFailure::from_source(InboxLeaseInvariant));
            }
        }
        tx.commit().await.map_err(persistence)?;
        Ok(ClaimPendingInbox::Claimed(
            ClaimedInboxBatch::claimed(principal, conversation, owner, deliveries)
                .expect("non-empty deliveries produce a batch"),
        ))
    }

    #[allow(clippy::too_many_arguments)]
    async fn settle(
        &self,
        host_id: String,
        principal: RuntimePrincipal,
        conversation: ConversationId,
        owner: DeliveryLeaseOwner,
        delivery_ids: Vec<InboxDeliveryId>,
        outcome: Settlement,
        observed_at_ms: i64,
        commit_activity: bool,
        presence_at_ms: Option<i64>,
    ) -> Result<(InboxSettlementDisposition, Option<i64>, Vec<UserId>), PersistenceFailure> {
        if delivery_ids.is_empty()
            || delivery_ids.iter().copied().collect::<HashSet<_>>().len() != delivery_ids.len()
        {
            return Err(PersistenceFailure::from_source(InvalidSettlementIds));
        }
        let mut tx = self
            .pool
            .begin_with(ROOT_WRITE_BEGIN)
            .await
            .map_err(persistence)?;
        if !principal_is_current(&mut tx, &host_id, &principal).await? {
            tx.commit().await.map_err(persistence)?;
            return Ok((InboxSettlementDisposition::Stale, None, Vec::new()));
        }
        let mut already_delivered = 0_usize;
        for id in &delivery_ids {
            let row = sqlx::query(
                "SELECT conversation_id, agent_id, in_flight_owner,
                        delivered_at, failed_at
                   FROM conversation_inboxes WHERE id = ?",
            )
            .bind(id.as_i64())
            .fetch_optional(&mut *tx)
            .await
            .map_err(persistence)?;
            let Some(row) = row else {
                tx.commit().await.map_err(persistence)?;
                return Ok((InboxSettlementDisposition::Stale, None, Vec::new()));
            };
            let row_conversation: String = row.try_get("conversation_id").map_err(persistence)?;
            let row_agent: String = row.try_get("agent_id").map_err(persistence)?;
            let row_owner: Option<String> = row.try_get("in_flight_owner").map_err(persistence)?;
            let delivered_at: Option<i64> = row.try_get("delivered_at").map_err(persistence)?;
            let failed_at: Option<i64> = row.try_get("failed_at").map_err(persistence)?;
            if row_conversation != conversation.as_str() || row_agent != principal.agent().as_str()
            {
                tx.commit().await.map_err(persistence)?;
                return Ok((InboxSettlementDisposition::Stale, None, Vec::new()));
            }
            if delivered_at.is_some() && matches!(outcome, Settlement::Consumed) {
                already_delivered += 1;
                continue;
            }
            if failed_at.is_some() || row_owner.as_deref() != Some(owner.as_str()) {
                tx.commit().await.map_err(persistence)?;
                return Ok((InboxSettlementDisposition::Stale, None, Vec::new()));
            }
        }
        if already_delivered == delivery_ids.len() {
            tx.commit().await.map_err(persistence)?;
            return Ok((InboxSettlementDisposition::Duplicate, None, Vec::new()));
        }
        if already_delivered != 0 {
            return Err(PersistenceFailure::from_source(PartialSettlementInvariant));
        }

        let delivery_count = delivery_ids.len();
        for id in delivery_ids {
            let (sql, failed_reason) = match outcome {
                Settlement::Consumed => (
                    "UPDATE conversation_inboxes SET delivered_at = ?, in_flight_owner = NULL,
                            in_flight_at = NULL
                      WHERE id = ? AND in_flight_owner = ? AND delivered_at IS NULL
                        AND failed_at IS NULL",
                    None,
                ),
                Settlement::Failed(RuntimeDeliveryFailureReason::DriverRefused) => (
                    "UPDATE conversation_inboxes SET failed_at = ?, failed_reason = ?,
                            in_flight_owner = NULL, in_flight_at = NULL
                      WHERE id = ? AND in_flight_owner = ? AND delivered_at IS NULL
                        AND failed_at IS NULL",
                    Some("driver_refused"),
                ),
                Settlement::Failed(_) => (
                    "UPDATE conversation_inboxes SET in_flight_owner = NULL, in_flight_at = NULL
                      WHERE id = ? AND in_flight_owner = ? AND delivered_at IS NULL
                        AND failed_at IS NULL",
                    None,
                ),
            };
            let changed = match (outcome, failed_reason) {
                (Settlement::Consumed, _) => {
                    sqlx::query(sql)
                        .bind(observed_at_ms)
                        .bind(id.as_i64())
                        .bind(owner.as_str())
                        .execute(&mut *tx)
                        .await
                }
                (Settlement::Failed(RuntimeDeliveryFailureReason::DriverRefused), Some(reason)) => {
                    sqlx::query(sql)
                        .bind(observed_at_ms)
                        .bind(reason)
                        .bind(id.as_i64())
                        .bind(owner.as_str())
                        .execute(&mut *tx)
                        .await
                }
                (Settlement::Failed(_), _) => {
                    sqlx::query(sql)
                        .bind(id.as_i64())
                        .bind(owner.as_str())
                        .execute(&mut *tx)
                        .await
                }
            }
            .map_err(persistence)?
            .rows_affected();
            if changed != 1 {
                return Err(PersistenceFailure::from_source(InboxSettlementInvariant));
            }
        }
        let (activity_id, presence_viewers) =
            if commit_activity && matches!(outcome, Settlement::Consumed) {
                let viewers = stamp_agent_presence(
                    &mut tx,
                    principal.agent(),
                    presence_at_ms.unwrap_or(observed_at_ms),
                )
                .await?;
                let payload = serde_json::json!({ "count": delivery_count }).to_string();
                let id = insert_activity_row(
                    &mut tx,
                    conversation.as_str(),
                    principal.agent().as_str(),
                    "message_received",
                    Some(&payload),
                    observed_at_ms,
                )
                .await?;
                (Some(id), viewers)
            } else {
                (None, Vec::new())
            };
        tx.commit().await.map_err(persistence)?;
        Ok((
            InboxSettlementDisposition::Applied,
            activity_id,
            presence_viewers,
        ))
    }
}

impl RuntimeDispatchReadPort for SqliteRuntimeDeliveryStore {
    async fn resolve_dispatch_target(
        &self,
        conversation: ConversationId,
        agent: AgentId,
    ) -> Result<Option<RuntimeDispatchTarget>, PersistenceFailure> {
        self.resolve_target(conversation, agent).await
    }

    async fn current_custodies_for_host(
        &self,
        host_id: String,
    ) -> Result<Vec<RuntimePrincipal>, PersistenceFailure> {
        let rows = sqlx::query(
            "SELECT s.agent_id, s.conversation_id, s.generation,
                    s.claimed_by_daemon_instance_id, a.session_scope
               FROM agent_runtime_slots s
               JOIN agents a ON a.id = s.agent_id
              WHERE a.host_id = ? AND s.claimed_by_daemon_instance_id IS NOT NULL
              ORDER BY s.id",
        )
        .bind(&host_id)
        .fetch_all(&self.pool)
        .await
        .map_err(persistence)?;
        rows.into_iter()
            .map(|row| {
                let agent =
                    AgentId::parse(row.try_get::<String, _>("agent_id").map_err(persistence)?)
                        .map_err(PersistenceFailure::from_source)?;
                let conversation = row
                    .try_get::<Option<String>, _>("conversation_id")
                    .map_err(persistence)?
                    .map(ConversationId::parse)
                    .transpose()
                    .map_err(PersistenceFailure::from_source)?;
                let session_scope: String = row.try_get("session_scope").map_err(persistence)?;
                let invalid_target =
                    || PersistenceFailure::from_source(InvalidPersistedRuntimeTarget);
                let scope =
                    match AgentSessionScope::parse(&session_scope).ok_or_else(invalid_target)? {
                        AgentSessionScope::Conversation => {
                            let source = conversation.ok_or_else(invalid_target)?;
                            RuntimeScope::ConversationSlot { agent, source }
                        }
                        AgentSessionScope::Agent => {
                            if conversation.is_some() {
                                return Err(invalid_target());
                            }
                            RuntimeScope::AgentSlot { agent }
                        }
                    };
                let generation =
                    RuntimeGeneration::new(row.try_get("generation").map_err(persistence)?)
                        .map_err(PersistenceFailure::from_source)?;
                let persisted_daemon = DaemonInstanceId::parse(
                    row.try_get::<String, _>("claimed_by_daemon_instance_id")
                        .map_err(persistence)?,
                )
                .map_err(PersistenceFailure::from_source)?;
                Ok(RuntimePrincipal::for_scope(
                    scope,
                    silverhand_backend_core::runtime_credential::RuntimeCustody::new(
                        generation,
                        persisted_daemon,
                    ),
                ))
            })
            .collect()
    }
}

impl RuntimeInboxCustodyPort for SqliteRuntimeDeliveryStore {
    async fn claim_pending<P: ReferencePositions + Sync>(
        &self,
        host_id: String,
        principal: RuntimePrincipal,
        conversation: ConversationId,
        owner: DeliveryLeaseOwner,
        now_ms: i64,
        lease_ttl_ms: i64,
        reference_positions: &P,
    ) -> Result<ClaimPendingInbox, PersistenceFailure> {
        self.claim(
            host_id,
            principal,
            conversation,
            owner,
            now_ms,
            lease_ttl_ms,
            reference_positions,
        )
        .await
    }

    async fn settle_consumed(
        &self,
        host_id: String,
        principal: RuntimePrincipal,
        conversation: ConversationId,
        owner: DeliveryLeaseOwner,
        delivery_ids: Vec<InboxDeliveryId>,
        observed_at_ms: i64,
    ) -> Result<InboxSettlementDisposition, PersistenceFailure> {
        self.settle(
            host_id,
            principal,
            conversation,
            owner,
            delivery_ids,
            Settlement::Consumed,
            observed_at_ms,
            false,
            None,
        )
        .await
        .map(|(disposition, _, _)| disposition)
    }

    async fn settle_failed(
        &self,
        host_id: String,
        principal: RuntimePrincipal,
        conversation: ConversationId,
        owner: DeliveryLeaseOwner,
        delivery_ids: Vec<InboxDeliveryId>,
        reason: RuntimeDeliveryFailureReason,
        observed_at_ms: i64,
    ) -> Result<InboxSettlementDisposition, PersistenceFailure> {
        self.settle(
            host_id,
            principal,
            conversation,
            owner,
            delivery_ids,
            Settlement::Failed(reason),
            observed_at_ms,
            false,
            None,
        )
        .await
        .map(|(disposition, _, _)| disposition)
    }

    async fn release_owner(&self, owner: DeliveryLeaseOwner) -> Result<u64, PersistenceFailure> {
        let changed = sqlx::query(
            "UPDATE conversation_inboxes
                SET in_flight_owner = NULL, in_flight_at = NULL
              WHERE in_flight_owner = ? AND delivered_at IS NULL AND failed_at IS NULL",
        )
        .bind(owner.as_str())
        .execute(&self.pool)
        .await
        .map_err(persistence)?
        .rows_affected();
        Ok(changed)
    }
}

impl DaemonEventDurablePort for SqliteRuntimeDeliveryStore {
    async fn current_admission(
        &self,
        host_id: String,
        scope: RuntimeScope,
    ) -> Result<Option<RuntimeEventAdmission>, PersistenceFailure> {
        let mut tx = self.pool.begin().await.map_err(persistence)?;
        let row = match &scope {
            RuntimeScope::ConversationSlot { agent, source } => sqlx::query(
                "SELECT s.generation, s.claimed_by_daemon_instance_id
                   FROM agent_runtime_slots s
                   JOIN agents a ON a.id = s.agent_id
                  WHERE s.agent_id = ? AND s.conversation_id = ? AND a.host_id = ?",
            )
            .bind(agent.as_str())
            .bind(source.as_str())
            .bind(&host_id)
            .fetch_optional(&mut *tx)
            .await
            .map_err(persistence)?,
            RuntimeScope::AgentSlot { agent } => sqlx::query(
                "SELECT s.generation, s.claimed_by_daemon_instance_id
                   FROM agent_runtime_slots s
                   JOIN agents a ON a.id = s.agent_id
                  WHERE s.agent_id = ? AND s.conversation_id IS NULL AND a.host_id = ?",
            )
            .bind(agent.as_str())
            .bind(&host_id)
            .fetch_optional(&mut *tx)
            .await
            .map_err(persistence)?,
        };
        let Some(row) = row else {
            tx.commit().await.map_err(persistence)?;
            return Ok(None);
        };
        let generation = RuntimeGeneration::new(row.try_get("generation").map_err(persistence)?)
            .map_err(PersistenceFailure::from_source)?;
        let daemon = row
            .try_get::<Option<String>, _>("claimed_by_daemon_instance_id")
            .map_err(persistence)?
            .map(DaemonInstanceId::parse)
            .transpose()
            .map_err(PersistenceFailure::from_source)?;
        tx.commit().await.map_err(persistence)?;
        Ok(daemon.map(|daemon| {
            RuntimeEventAdmission::new(
                host_id,
                RuntimePrincipal::for_scope(
                    scope,
                    silverhand_backend_core::runtime_credential::RuntimeCustody::new(
                        generation, daemon,
                    ),
                ),
            )
        }))
    }

    async fn commit_exit(
        &self,
        event: CommitRuntimeExit,
    ) -> Result<RuntimeExitCommitResult, PersistenceFailure> {
        let mut tx = self
            .pool
            .begin_with(ROOT_WRITE_BEGIN)
            .await
            .map_err(persistence)?;
        let admission = event.admission();
        let principal = admission.principal();
        let row = current_slot_row(&mut tx, admission).await?;
        let Some(row) = row else {
            tx.commit().await.map_err(persistence)?;
            return Ok(RuntimeExitCommitResult::new(
                RuntimeExitDisposition::Stale,
                None,
                Vec::new(),
            ));
        };
        let slot_id: i64 = row.try_get("id").map_err(persistence)?;
        let generation = RuntimeGeneration::new(row.try_get("generation").map_err(persistence)?)
            .map_err(PersistenceFailure::from_source)?;
        let daemon = row
            .try_get::<Option<String>, _>("claimed_by_daemon_instance_id")
            .map_err(persistence)?
            .map(DaemonInstanceId::parse)
            .transpose()
            .map_err(PersistenceFailure::from_source)?;
        if generation != principal.custody().generation()
            || daemon.as_ref() != Some(principal.custody().daemon_instance())
        {
            tx.commit().await.map_err(persistence)?;
            return Ok(RuntimeExitCommitResult::new(
                RuntimeExitDisposition::Stale,
                None,
                Vec::new(),
            ));
        }
        let changed = sqlx::query(
            "UPDATE agent_runtime_slots
                SET claimed_by_daemon_instance_id = NULL,
                    observed_status = ?, observed_pid = NULL,
                    cli_session_id = CASE WHEN ? THEN NULL ELSE cli_session_id END
              WHERE id = ? AND generation = ? AND claimed_by_daemon_instance_id = ?",
        )
        .bind(event.status().as_str())
        .bind(event.clear_cli_session_id())
        .bind(slot_id)
        .bind(generation.as_i64())
        .bind(principal.custody().daemon_instance().as_str())
        .execute(&mut *tx)
        .await
        .map_err(persistence)?
        .rows_affected();
        if changed != 1 {
            return Err(PersistenceFailure::from_source(RuntimeExitInvariant));
        }
        insert_runtime_projection_event(
            &mut tx,
            slot_id,
            principal,
            "generation_finalized",
            event.status().as_str(),
            None,
            event.observed_at().as_unix_millis(),
        )
        .await?;
        let lease_cleanup = match principal {
            RuntimePrincipal::ConversationSlot { agent, source, .. } => sqlx::query(
                "UPDATE conversation_inboxes
                        SET in_flight_owner = NULL, in_flight_at = NULL
                      WHERE conversation_id = ? AND agent_id = ?
                        AND in_flight_owner IS NOT NULL
                        AND delivered_at IS NULL AND failed_at IS NULL",
            )
            .bind(source.as_str())
            .bind(agent.as_str())
            .execute(&mut *tx)
            .await
            .map_err(persistence)?
            .rows_affected(),
            RuntimePrincipal::AgentSlot { agent, .. } => sqlx::query(
                "UPDATE conversation_inboxes
                        SET in_flight_owner = NULL, in_flight_at = NULL
                      WHERE agent_id = ? AND in_flight_owner IS NOT NULL
                        AND delivered_at IS NULL AND failed_at IS NULL",
            )
            .bind(agent.as_str())
            .execute(&mut *tx)
            .await
            .map_err(persistence)?
            .rows_affected(),
        };
        let _ = lease_cleanup;
        let activity_id = if let Some(activity) = event.pending_activity() {
            Some(insert_activity(&mut tx, activity).await?)
        } else {
            None
        };
        let status_targets =
            status_targets_for(&mut tx, principal, event.origin_conversation()).await?;
        tx.commit().await.map_err(persistence)?;
        Ok(RuntimeExitCommitResult::new(
            RuntimeExitDisposition::Applied,
            activity_id,
            status_targets,
        ))
    }

    async fn commit_consumed(
        &self,
        event: CommitRuntimeConsumed,
    ) -> Result<RuntimeConsumedCommitResult, PersistenceFailure> {
        let (disposition, activity_id, presence_viewers) = self
            .settle(
                event.host_id().to_owned(),
                event.principal().clone(),
                event.conversation().clone(),
                event.owner().clone(),
                event.delivery_ids().to_vec(),
                Settlement::Consumed,
                event.observed_at().as_unix_millis(),
                true,
                Some(event.presence_at().as_unix_millis()),
            )
            .await?;
        Ok(RuntimeConsumedCommitResult::new(
            disposition,
            activity_id,
            presence_viewers,
        ))
    }

    async fn commit_session_init(
        &self,
        event: CommitRuntimeSessionInit,
    ) -> Result<Option<RuntimeSessionInitCommitResult>, PersistenceFailure> {
        let mut tx = self
            .pool
            .begin_with(ROOT_WRITE_BEGIN)
            .await
            .map_err(persistence)?;
        let Some(row) = current_slot_row(&mut tx, event.admission()).await? else {
            tx.commit().await.map_err(persistence)?;
            return Ok(None);
        };
        let slot_id: i64 = row.try_get("id").map_err(persistence)?;
        let generation = RuntimeGeneration::new(row.try_get("generation").map_err(persistence)?)
            .map_err(PersistenceFailure::from_source)?;
        let daemon = row
            .try_get::<Option<String>, _>("claimed_by_daemon_instance_id")
            .map_err(persistence)?
            .map(DaemonInstanceId::parse)
            .transpose()
            .map_err(PersistenceFailure::from_source)?;
        let principal = event.admission().principal();
        if generation != principal.custody().generation()
            || daemon.as_ref() != Some(principal.custody().daemon_instance())
        {
            tx.commit().await.map_err(persistence)?;
            return Ok(None);
        }
        let changed = sqlx::query(
            "UPDATE agent_runtime_slots
                SET observed_status = 'active', cli_session_id = ?
              WHERE id = ? AND generation = ? AND claimed_by_daemon_instance_id = ?",
        )
        .bind(event.cli_session_id())
        .bind(slot_id)
        .bind(generation.as_i64())
        .bind(principal.custody().daemon_instance().as_str())
        .execute(&mut *tx)
        .await
        .map_err(persistence)?
        .rows_affected();
        if changed != 1 {
            return Err(PersistenceFailure::from_source(RuntimeProjectionInvariant));
        }
        insert_runtime_projection_event(
            &mut tx,
            slot_id,
            principal,
            "projection_updated",
            "active",
            Some(event.cli_session_id()),
            event.observed_at().as_unix_millis(),
        )
        .await?;
        let presence_viewers =
            stamp_agent_presence(&mut tx, event.agent(), event.presence_at().as_unix_millis())
                .await?;
        let activity = RuntimeActivityFact::new(
            event.conversation().clone(),
            event.agent().clone(),
            RuntimeActivityKind::SessionInit,
            RuntimeActivityPayload::Text {
                text: event.cli_session_id().to_owned(),
            },
            event.observed_at(),
        );
        let activity_id = insert_activity(&mut tx, &activity).await?;
        let status_targets = status_targets_for(&mut tx, principal, event.conversation()).await?;
        tx.commit().await.map_err(persistence)?;
        Ok(Some(RuntimeSessionInitCommitResult::new(
            activity_id,
            presence_viewers,
            status_targets,
        )))
    }

    async fn project_status(
        &self,
        event: ProjectRuntimeStatus,
    ) -> Result<Option<RuntimeStatusCommitResult>, PersistenceFailure> {
        let mut tx = self
            .pool
            .begin_with(ROOT_WRITE_BEGIN)
            .await
            .map_err(persistence)?;
        let Some(row) = current_slot_row(&mut tx, event.admission()).await? else {
            tx.commit().await.map_err(persistence)?;
            return Ok(None);
        };
        let slot_id: i64 = row.try_get("id").map_err(persistence)?;
        let generation = RuntimeGeneration::new(row.try_get("generation").map_err(persistence)?)
            .map_err(PersistenceFailure::from_source)?;
        let daemon = row
            .try_get::<Option<String>, _>("claimed_by_daemon_instance_id")
            .map_err(persistence)?
            .map(DaemonInstanceId::parse)
            .transpose()
            .map_err(PersistenceFailure::from_source)?;
        if generation != event.admission().principal().custody().generation()
            || daemon.as_ref() != Some(event.admission().principal().custody().daemon_instance())
        {
            tx.commit().await.map_err(persistence)?;
            return Ok(None);
        }
        let changed = sqlx::query(
            "UPDATE agent_runtime_slots
                SET observed_status = ?,
                    cli_session_id = COALESCE(?, cli_session_id)
              WHERE id = ? AND generation = ? AND claimed_by_daemon_instance_id = ?",
        )
        .bind(event.status().as_str())
        .bind(event.cli_session_id())
        .bind(slot_id)
        .bind(generation.as_i64())
        .bind(
            event
                .admission()
                .principal()
                .custody()
                .daemon_instance()
                .as_str(),
        )
        .execute(&mut *tx)
        .await
        .map_err(persistence)?
        .rows_affected();
        if changed != 1 {
            return Err(PersistenceFailure::from_source(RuntimeProjectionInvariant));
        }
        insert_runtime_projection_event(
            &mut tx,
            slot_id,
            event.admission().principal(),
            "projection_updated",
            event.status().as_str(),
            event.cli_session_id(),
            event.observed_at().as_unix_millis(),
        )
        .await?;
        let targets = status_targets_for(
            &mut tx,
            event.admission().principal(),
            event.origin_conversation(),
        )
        .await?;
        tx.commit().await.map_err(persistence)?;
        Ok(Some(RuntimeStatusCommitResult::new(targets)))
    }

    async fn record_activity(
        &self,
        admission: RuntimeEventAdmission,
        event: RuntimeActivityFact,
        presence_at: silverhand_backend_core::runtime_credential::RuntimeEventTime,
    ) -> Result<Option<RuntimeActivityCommitResult>, PersistenceFailure> {
        let mut tx = self
            .pool
            .begin_with(ROOT_WRITE_BEGIN)
            .await
            .map_err(persistence)?;
        if !principal_is_current_in_tx(&mut tx, &admission).await? {
            tx.commit().await.map_err(persistence)?;
            return Ok(None);
        }
        let viewers =
            stamp_agent_presence(&mut tx, event.agent(), presence_at.as_unix_millis()).await?;
        let id = insert_activity(&mut tx, &event).await?;
        tx.commit().await.map_err(persistence)?;
        Ok(Some(RuntimeActivityCommitResult::new(id, viewers)))
    }

    async fn upsert_text_activity(
        &self,
        event: UpsertRuntimeTextActivity,
    ) -> Result<Option<RuntimeActivityCommitResult>, PersistenceFailure> {
        let mut tx = self
            .pool
            .begin_with(ROOT_WRITE_BEGIN)
            .await
            .map_err(persistence)?;
        if !principal_is_current_in_tx(&mut tx, event.admission()).await? {
            tx.commit().await.map_err(persistence)?;
            return Ok(None);
        }
        let viewers = stamp_agent_presence(
            &mut tx,
            event.event().agent(),
            event.presence_at().as_unix_millis(),
        )
        .await?;
        let id = if let Some(previous_id) = event.previous_event_id() {
            let payload = activity_payload_json(event.event().payload())?;
            let changed = sqlx::query(
                "UPDATE conversation_events
                    SET payload = ?
                  WHERE id = ? AND conversation_id = ? AND agent_id = ? AND kind = ?",
            )
            .bind(payload)
            .bind(previous_id)
            .bind(event.event().conversation().as_str())
            .bind(event.event().agent().as_str())
            .bind(event.event().kind().as_str())
            .execute(&mut *tx)
            .await
            .map_err(persistence)?
            .rows_affected();
            if changed != 1 {
                return Err(PersistenceFailure::from_source(RuntimeActivityInvariant));
            }
            previous_id
        } else {
            insert_activity(&mut tx, event.event()).await?
        };
        tx.commit().await.map_err(persistence)?;
        Ok(Some(RuntimeActivityCommitResult::new(id, viewers)))
    }

    async fn refine_tool_call_input(
        &self,
        event: RefineRuntimeToolCallInput,
    ) -> Result<Option<RuntimeToolCallInputCommitResult>, PersistenceFailure> {
        let mut tx = self
            .pool
            .begin_with(ROOT_WRITE_BEGIN)
            .await
            .map_err(persistence)?;
        if !principal_is_current_in_tx(&mut tx, event.admission()).await? {
            tx.commit().await.map_err(persistence)?;
            return Ok(None);
        }
        let viewers =
            stamp_agent_presence(&mut tx, event.agent(), event.observed_at().as_unix_millis())
                .await?;
        let Some(row) = sqlx::query(
            "SELECT id, payload, created_at
               FROM conversation_events
              WHERE conversation_id = ? AND agent_id = ? AND kind = 'tool_call'
                AND json_extract(payload, '$.tool_call_id') = ?
              ORDER BY id DESC LIMIT 1",
        )
        .bind(event.conversation().as_str())
        .bind(event.agent().as_str())
        .bind(event.tool_call_id())
        .fetch_optional(&mut *tx)
        .await
        .map_err(persistence)?
        else {
            tx.commit().await.map_err(persistence)?;
            return Ok(Some(RuntimeToolCallInputCommitResult::new(None, viewers)));
        };
        let id: i64 = row.try_get("id").map_err(persistence)?;
        let created_at: i64 = row.try_get("created_at").map_err(persistence)?;
        let payload: Option<String> = row.try_get("payload").map_err(persistence)?;
        let mut payload = payload
            .as_deref()
            .map(serde_json::from_str::<serde_json::Value>)
            .transpose()
            .map_err(PersistenceFailure::from_source)?
            .unwrap_or_else(|| serde_json::json!({}));
        let object = payload
            .as_object_mut()
            .ok_or_else(|| PersistenceFailure::from_source(RuntimeActivityInvariant))?;
        object.insert(
            "input".to_owned(),
            serde_json::from_str(event.input_json()).map_err(PersistenceFailure::from_source)?,
        );
        let payload_json =
            serde_json::to_string(&payload).map_err(PersistenceFailure::from_source)?;
        let changed = sqlx::query("UPDATE conversation_events SET payload = ? WHERE id = ?")
            .bind(&payload_json)
            .bind(id)
            .execute(&mut *tx)
            .await
            .map_err(persistence)?
            .rows_affected();
        if changed != 1 {
            return Err(PersistenceFailure::from_source(RuntimeActivityInvariant));
        }
        tx.commit().await.map_err(persistence)?;
        Ok(Some(RuntimeToolCallInputCommitResult::new(
            Some(RefinedRuntimeActivity::new(
                id,
                payload_json,
                silverhand_backend_core::runtime_credential::RuntimeEventTime::from_unix_millis(
                    created_at,
                ),
            )),
            viewers,
        )))
    }

    async fn stamp_presence(
        &self,
        event: StampRuntimePresence,
    ) -> Result<Option<Vec<UserId>>, PersistenceFailure> {
        let mut tx = self
            .pool
            .begin_with(ROOT_WRITE_BEGIN)
            .await
            .map_err(persistence)?;
        if !principal_is_current_in_tx(&mut tx, event.admission()).await? {
            tx.commit().await.map_err(persistence)?;
            return Ok(None);
        }
        let viewers =
            stamp_agent_presence(&mut tx, event.agent(), event.observed_at().as_unix_millis())
                .await?;
        tx.commit().await.map_err(persistence)?;
        Ok(Some(viewers))
    }
}

#[derive(Clone, Copy)]
enum Settlement {
    Consumed,
    Failed(RuntimeDeliveryFailureReason),
}

async fn current_slot_row(
    tx: &mut Transaction<'_, Sqlite>,
    admission: &RuntimeEventAdmission,
) -> Result<Option<sqlx::sqlite::SqliteRow>, PersistenceFailure> {
    match admission.principal() {
        RuntimePrincipal::ConversationSlot { agent, source, .. } => sqlx::query(
            "SELECT s.id, s.generation, s.claimed_by_daemon_instance_id
               FROM agent_runtime_slots s
               JOIN agents a ON a.id = s.agent_id
              WHERE s.agent_id = ? AND s.conversation_id = ? AND a.host_id = ?",
        )
        .bind(agent.as_str())
        .bind(source.as_str())
        .bind(admission.host_id())
        .fetch_optional(&mut **tx)
        .await
        .map_err(persistence),
        RuntimePrincipal::AgentSlot { agent, .. } => sqlx::query(
            "SELECT s.id, s.generation, s.claimed_by_daemon_instance_id
               FROM agent_runtime_slots s
               JOIN agents a ON a.id = s.agent_id
              WHERE s.agent_id = ? AND s.conversation_id IS NULL AND a.host_id = ?",
        )
        .bind(agent.as_str())
        .bind(admission.host_id())
        .fetch_optional(&mut **tx)
        .await
        .map_err(persistence),
    }
}

async fn principal_is_current_in_tx(
    tx: &mut Transaction<'_, Sqlite>,
    admission: &RuntimeEventAdmission,
) -> Result<bool, PersistenceFailure> {
    let Some(row) = current_slot_row(tx, admission).await? else {
        return Ok(false);
    };
    let generation = RuntimeGeneration::new(row.try_get("generation").map_err(persistence)?)
        .map_err(PersistenceFailure::from_source)?;
    let daemon = row
        .try_get::<Option<String>, _>("claimed_by_daemon_instance_id")
        .map_err(persistence)?
        .map(DaemonInstanceId::parse)
        .transpose()
        .map_err(PersistenceFailure::from_source)?;
    Ok(generation == admission.principal().custody().generation()
        && daemon.as_ref() == Some(admission.principal().custody().daemon_instance()))
}

async fn stamp_agent_presence(
    tx: &mut Transaction<'_, Sqlite>,
    agent: &AgentId,
    observed_at: i64,
) -> Result<Vec<UserId>, PersistenceFailure> {
    // The observation about to be written must itself be a usable instant: a stamp
    // whose away deadline could leave the wire-safe range must never enter the DB,
    // or a later presence read would inherit a value it is bound to reject.
    // Validated BEFORE the UPDATE, so a bad observation aborts the whole transaction
    // and fires no presence viewers.
    let observed = agent_presence::ActivityInstant::new(observed_at)
        .map_err(PersistenceFailure::from_source)?;
    let previous =
        sqlx::query_scalar::<_, Option<i64>>("SELECT last_activity_at FROM agents WHERE id = ?")
            .bind(agent.as_str())
            .fetch_optional(&mut **tx)
            .await
            .map_err(persistence)?
            .ok_or_else(|| PersistenceFailure::from_source(RuntimeActivityInvariant))?;
    // A corrupt previous stamp must NOT be silently judged "still online": decode it
    // through the SAME authority the read uses, so a committed value out of domain is
    // a fault, not a washed-away boundary that suppresses the viewers.
    let previous = previous
        .map(agent_presence::ActivityInstant::new)
        .transpose()
        .map_err(PersistenceFailure::from_source)?;
    let changed = sqlx::query(
        "UPDATE agents
            SET last_activity_at = CASE
                WHEN last_activity_at IS NULL OR last_activity_at < ? THEN ?
                ELSE last_activity_at END
          WHERE id = ?",
    )
    .bind(observed.get())
    .bind(observed.get())
    .bind(agent.as_str())
    .execute(&mut **tx)
    .await
    .map_err(persistence)?
    .rows_affected();
    if changed != 1 {
        return Err(PersistenceFailure::from_source(RuntimeActivityInvariant));
    }
    let was_online = previous.is_some_and(|previous| observed.get() < previous.away_at());
    if was_online {
        return Ok(Vec::new());
    }
    let rows = sqlx::query(
        "SELECT viewer_id FROM (
             SELECT created_by_user_id AS viewer_id
               FROM agents
              WHERE id = ? AND materialization_status = 'active'
                AND created_by_user_id IS NOT NULL
             UNION
             SELECT CASE
                        WHEN endpoint_a_kind = 'agent' AND endpoint_a_id = ?
                         AND endpoint_b_kind = 'human' THEN endpoint_b_id
                        WHEN endpoint_b_kind = 'agent' AND endpoint_b_id = ?
                         AND endpoint_a_kind = 'human' THEN endpoint_a_id
                    END AS viewer_id
               FROM conversations
              WHERE placement_kind = 'direct_pair'
                AND status = 'active'
                AND ((endpoint_a_kind = 'agent' AND endpoint_a_id = ?
                      AND endpoint_b_kind = 'human')
                  OR (endpoint_b_kind = 'agent' AND endpoint_b_id = ?
                      AND endpoint_a_kind = 'human'))
             UNION
             SELECT wu.user_id AS viewer_id
               FROM workspace_members wm
               JOIN workspace_users wu ON wu.workspace_id = wm.workspace_id
               JOIN agents a ON a.id = wm.agent_id
              WHERE wm.agent_id = ? AND a.materialization_status = 'active'
         ) WHERE viewer_id IS NOT NULL ORDER BY viewer_id",
    )
    .bind(agent.as_str())
    .bind(agent.as_str())
    .bind(agent.as_str())
    .bind(agent.as_str())
    .bind(agent.as_str())
    .bind(agent.as_str())
    .fetch_all(&mut **tx)
    .await
    .map_err(persistence)?;
    rows.into_iter()
        .map(|row| {
            UserId::parse(row.try_get::<String, _>("viewer_id").map_err(persistence)?)
                .map_err(PersistenceFailure::from_source)
        })
        .collect()
}

async fn status_targets_for(
    tx: &mut Transaction<'_, Sqlite>,
    principal: &RuntimePrincipal,
    origin: &ConversationId,
) -> Result<Vec<RuntimeStatusTarget>, PersistenceFailure> {
    match principal {
        RuntimePrincipal::ConversationSlot { source, .. } => Ok(vec![RuntimeStatusTarget::new(
            source.clone(),
            source == origin,
        )]),
        RuntimePrincipal::AgentSlot { agent, .. } => {
            let rows = sqlx::query(
                "SELECT c.id
                   FROM conversations c
                  WHERE (c.placement_kind = 'workspace'
                         AND EXISTS (
                           SELECT 1 FROM conversation_agents ca
                            WHERE ca.conversation_id = c.id AND ca.agent_id = ?
                         ))
                     OR (c.placement_kind = 'direct_pair'
                         AND ((c.endpoint_a_kind = 'agent' AND c.endpoint_a_id = ?)
                           OR (c.endpoint_b_kind = 'agent' AND c.endpoint_b_id = ?)))
                  ORDER BY c.id",
            )
            .bind(agent.as_str())
            .bind(agent.as_str())
            .bind(agent.as_str())
            .fetch_all(&mut **tx)
            .await
            .map_err(persistence)?;
            rows.into_iter()
                .map(|row| {
                    let conversation =
                        ConversationId::parse(row.try_get::<String, _>("id").map_err(persistence)?)
                            .map_err(PersistenceFailure::from_source)?;
                    let carries_origin_detail = &conversation == origin;
                    Ok(RuntimeStatusTarget::new(
                        conversation,
                        carries_origin_detail,
                    ))
                })
                .collect()
        }
    }
}

async fn insert_runtime_projection_event(
    tx: &mut Transaction<'_, Sqlite>,
    slot_id: i64,
    principal: &RuntimePrincipal,
    event_kind: &'static str,
    status: &'static str,
    cli_session_id: Option<&str>,
    occurred_at: i64,
) -> Result<(), PersistenceFailure> {
    sqlx::query(
        "INSERT INTO agent_runtime_events (
            slot_id, agent_id, conversation_id, generation, event_kind,
            daemon_instance_id, observed_status, observed_pid, cli_session_id, occurred_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)",
    )
    .bind(slot_id)
    .bind(principal.agent().as_str())
    .bind(principal.source().map(ConversationId::as_str))
    .bind(principal.custody().generation().as_i64())
    .bind(event_kind)
    .bind(
        (event_kind != "generation_finalized")
            .then(|| principal.custody().daemon_instance().as_str()),
    )
    .bind(status)
    .bind(cli_session_id)
    .bind(occurred_at)
    .execute(&mut **tx)
    .await
    .map_err(persistence)?;
    Ok(())
}

async fn insert_activity(
    tx: &mut Transaction<'_, Sqlite>,
    event: &RuntimeActivityFact,
) -> Result<i64, PersistenceFailure> {
    let payload = activity_payload_json(event.payload())?;
    insert_activity_row(
        tx,
        event.conversation().as_str(),
        event.agent().as_str(),
        event.kind().as_str(),
        payload.as_deref(),
        event.created_at().as_unix_millis(),
    )
    .await
}

async fn insert_activity_row(
    tx: &mut Transaction<'_, Sqlite>,
    conversation: &str,
    agent: &str,
    kind: &str,
    payload: Option<&str>,
    created_at: i64,
) -> Result<i64, PersistenceFailure> {
    let result = sqlx::query(
        "INSERT INTO conversation_events (conversation_id, agent_id, kind, payload, created_at)
         VALUES (?, ?, ?, ?, ?)",
    )
    .bind(conversation)
    .bind(agent)
    .bind(kind)
    .bind(payload)
    .bind(created_at)
    .execute(&mut **tx)
    .await
    .map_err(persistence)?;
    Ok(result.last_insert_rowid())
}

fn activity_payload_json(
    payload: &RuntimeActivityPayload,
) -> Result<Option<String>, PersistenceFailure> {
    let value = match payload {
        RuntimeActivityPayload::None => return Ok(None),
        RuntimeActivityPayload::Text { text } => serde_json::json!({ "text": text }),
        RuntimeActivityPayload::ToolCall {
            name,
            input_json,
            tool_call_id,
        } => {
            let input = serde_json::from_str::<serde_json::Value>(input_json)
                .map_err(PersistenceFailure::from_source)?;
            serde_json::json!({ "name": name, "input": input, "tool_call_id": tool_call_id })
        }
        RuntimeActivityPayload::ToolOutput {
            name,
            tool_call_id,
            outcome,
        } => {
            serde_json::json!({ "name": name, "tool_call_id": tool_call_id, "outcome": outcome })
        }
        RuntimeActivityPayload::ApiResponse { status, message } => {
            serde_json::json!({ "status": status, "message": message })
        }
        RuntimeActivityPayload::Error {
            message,
            code,
            fatal,
        } => {
            serde_json::json!({ "message": message, "code": code, "fatal": fatal })
        }
        RuntimeActivityPayload::ParsedEventDropped {
            parsed_kind,
            encoded_bytes,
            reason,
        } => serde_json::json!({
            "parsed_kind": parsed_kind,
            "encoded_bytes": encoded_bytes,
            "reason": reason,
        }),
        RuntimeActivityPayload::MessageReceived { count } => serde_json::json!({ "count": count }),
    };
    serde_json::to_string(&value)
        .map(Some)
        .map_err(PersistenceFailure::from_source)
}

async fn principal_is_current(
    tx: &mut Transaction<'_, Sqlite>,
    host_id: &str,
    principal: &RuntimePrincipal,
) -> Result<bool, PersistenceFailure> {
    let row = match principal {
        RuntimePrincipal::ConversationSlot { agent, source, .. } => sqlx::query(
            "SELECT s.generation, s.claimed_by_daemon_instance_id
               FROM agent_runtime_slots s
               JOIN agents a ON a.id = s.agent_id
              WHERE s.agent_id = ? AND s.conversation_id = ? AND a.host_id = ?",
        )
        .bind(agent.as_str())
        .bind(source.as_str())
        .bind(host_id)
        .fetch_optional(&mut **tx)
        .await
        .map_err(persistence)?,
        RuntimePrincipal::AgentSlot { agent, .. } => sqlx::query(
            "SELECT s.generation, s.claimed_by_daemon_instance_id
               FROM agent_runtime_slots s
               JOIN agents a ON a.id = s.agent_id
              WHERE s.agent_id = ? AND s.conversation_id IS NULL AND a.host_id = ?",
        )
        .bind(agent.as_str())
        .bind(host_id)
        .fetch_optional(&mut **tx)
        .await
        .map_err(persistence)?,
    };
    let Some(row) = row else {
        return Ok(false);
    };
    let generation = RuntimeGeneration::new(row.try_get("generation").map_err(persistence)?)
        .map_err(PersistenceFailure::from_source)?;
    let daemon: Option<String> = row
        .try_get("claimed_by_daemon_instance_id")
        .map_err(persistence)?;
    let daemon = daemon
        .map(silverhand_backend_core::identity::DaemonInstanceId::parse)
        .transpose()
        .map_err(PersistenceFailure::from_source)?;
    Ok(generation == principal.custody().generation()
        && daemon.as_ref() == Some(principal.custody().daemon_instance()))
}

fn decode_delivery(
    row: &sqlx::sqlite::SqliteRow,
    reference_positions: &impl ReferencePositions,
) -> Result<ClaimedInboxDelivery, PersistenceFailure> {
    let id = InboxDeliveryId::parse(row.try_get("inbox_id").map_err(persistence)?)
        .map_err(PersistenceFailure::from_source)?;
    let seq: i64 = row.try_get("seq").map_err(persistence)?;
    if seq < 0 {
        return Err(PersistenceFailure::from_source(InvalidPersistedMessageSeq));
    }
    let content = MessageContent::parse(row.try_get::<String, _>("content").map_err(persistence)?)
        .map_err(PersistenceFailure::from_source)?;
    let from_kind: String = row.try_get("from_kind").map_err(persistence)?;
    let from = match from_kind.as_str() {
        "agent" => FromKind::Agent,
        "user" => FromKind::User,
        "system" => FromKind::System,
        _ => {
            return Err(PersistenceFailure::from_source(
                InvalidPersistedDeliveryKind,
            ));
        }
    };
    let delivery_kind: Option<String> = row.try_get("delivery_kind").map_err(persistence)?;
    let instruction = match delivery_kind.as_deref().unwrap_or("turn") {
        "observe" => DeliveryInstruction::Other,
        "turn" => classify_delivery_instruction(
            from,
            &content,
            row.try_get::<String, _>("recipient_name")
                .map_err(persistence)?
                .as_str(),
            reference_positions,
        ),
        _ => {
            return Err(PersistenceFailure::from_source(
                InvalidPersistedDeliveryKind,
            ));
        }
    };
    let message_id: String = row.try_get("message_id").map_err(persistence)?;
    let target = delivery_target(row)?;
    let timestamp = delivery_timestamp(row)?;
    let metadata = row
        .try_get::<Option<String>, _>("metadata")
        .map_err(persistence)?
        .and_then(|raw| serde_json::from_str::<serde_json::Value>(&raw).ok());
    let task = task_header(metadata.as_ref());
    let sender = sender_header(row, from)?;
    let presentation = render_delivery_presentation(
        &message_id,
        &sender,
        &target,
        &timestamp,
        task,
        content.as_str(),
        &attachment_suffix(metadata.as_ref()),
    );
    Ok(ClaimedInboxDelivery::decoded(
        id,
        seq,
        presentation,
        instruction,
    ))
}

fn render_delivery_presentation(
    message_id: &str,
    sender: &str,
    target: &str,
    timestamp: &str,
    task: Option<(i64, &str)>,
    content: &str,
    attachment_suffix: &str,
) -> String {
    let task = task
        .map(|(number, status)| format!(" task=#{number} status={status}"))
        .unwrap_or_default();
    format!(
        "[msg_id={message_id} {sender} target={target} time={timestamp}{task}]\n{content}{attachment_suffix}"
    )
}

fn sender_header(
    row: &sqlx::sqlite::SqliteRow,
    from: FromKind,
) -> Result<String, PersistenceFailure> {
    match from {
        FromKind::Agent => {
            let handle: Option<String> = row.try_get("sender_agent_name").map_err(persistence)?;
            let computer: Option<String> = row.try_get("sender_host_id").map_err(persistence)?;
            Ok(format_sender(from, handle.as_deref(), computer.as_deref()))
        }
        FromKind::User => {
            let handle: Option<String> = row.try_get("sender_user_name").map_err(persistence)?;
            Ok(format_sender(from, handle.as_deref(), None))
        }
        FromKind::System => Ok(format_sender(from, None, None)),
    }
}

fn format_sender(from: FromKind, handle: Option<&str>, computer: Option<&str>) -> String {
    match from {
        FromKind::Agent => {
            let sender = handle.map_or_else(|| "agent".into(), |value| format!("@{value}"));
            let computer = computer.map_or_else(String::new, |value| format!(" computer={value}"));
            format!("sender={sender} type=agent{computer}")
        }
        FromKind::User => {
            let sender = handle.map_or_else(|| "user".into(), |value| format!("@{value}"));
            format!("sender={sender} type=human")
        }
        FromKind::System => "sender=system type=system".into(),
    }
}

fn delivery_timestamp(row: &sqlx::sqlite::SqliteRow) -> Result<String, PersistenceFailure> {
    let local: String = row.try_get("local_time").map_err(persistence)?;
    let offset: i64 = row.try_get("offset_minutes").map_err(persistence)?;
    let sign = if offset >= 0 { '+' } else { '-' };
    let absolute = offset.unsigned_abs();
    Ok(format!(
        "{local}{sign}{:02}:{:02}",
        absolute / 60,
        absolute % 60
    ))
}

fn delivery_target(row: &sqlx::sqlite::SqliteRow) -> Result<String, PersistenceFailure> {
    use crate::messaging::authorities::{address_id, encode_name_segment};

    let conversation: String = row
        .try_get("message_conversation_id")
        .map_err(persistence)?;
    if !address_id(&conversation) {
        return Err(PersistenceFailure::from_source(InvalidPersistedAddress));
    }
    let thread: Option<String> = row.try_get("thread_root_id").map_err(persistence)?;
    if thread.as_deref().is_some_and(|value| !address_id(value)) {
        return Err(PersistenceFailure::from_source(InvalidPersistedAddress));
    }
    let suffix = thread.map_or_else(String::new, |root| format!("/thread:{root}"));
    let fallback = || format!("#conv:{conversation}{suffix}");
    match row
        .try_get::<String, _>("placement_kind")
        .map_err(persistence)?
        .as_str()
    {
        "workspace" => {
            let workspace: Option<String> = row.try_get("workspace_name").map_err(persistence)?;
            let title: String = row.try_get("conversation_title").map_err(persistence)?;
            let Some(workspace) = workspace.and_then(|value| encode_name_segment(&value, 64))
            else {
                return Ok(fallback());
            };
            let Some(title) = encode_name_segment(&title, 128) else {
                return Ok(fallback());
            };
            let named = format!("#{workspace}/{title}{suffix}");
            Ok(if named.len() <= 512 {
                named
            } else {
                fallback()
            })
        }
        "direct_pair" => {
            let recipient: String = row.try_get("recipient_id").map_err(persistence)?;
            let a_kind: Option<String> = row.try_get("endpoint_a_kind").map_err(persistence)?;
            let a_id: Option<String> = row.try_get("endpoint_a_id").map_err(persistence)?;
            let b_kind: Option<String> = row.try_get("endpoint_b_kind").map_err(persistence)?;
            let b_id: Option<String> = row.try_get("endpoint_b_id").map_err(persistence)?;
            let other = match (
                a_kind.as_deref(),
                a_id.as_deref(),
                b_kind.as_deref(),
                b_id.as_deref(),
            ) {
                (Some("agent"), Some(a), Some(kind), Some(_)) if a == recipient => {
                    endpoint_handle(row, "endpoint_b_agent_name", "endpoint_b_user_name", kind)?
                }
                (Some(kind), Some(_), Some("agent"), Some(b)) if b == recipient => {
                    endpoint_handle(row, "endpoint_a_agent_name", "endpoint_a_user_name", kind)?
                }
                (Some("agent" | "human"), Some(_), Some("agent" | "human"), Some(_)) => None,
                _ => {
                    return Err(PersistenceFailure::from_source(
                        InvalidPersistedRuntimeTarget,
                    ));
                }
            };
            Ok(other
                .map(|handle| format!("dm:@{handle}{suffix}"))
                .unwrap_or_else(fallback))
        }
        _ => Err(PersistenceFailure::from_source(
            InvalidPersistedRuntimeTarget,
        )),
    }
}

fn endpoint_handle(
    row: &sqlx::sqlite::SqliteRow,
    agent_field: &'static str,
    user_field: &'static str,
    kind: &str,
) -> Result<Option<String>, PersistenceFailure> {
    match kind {
        "agent" => row.try_get(agent_field).map_err(persistence),
        "human" => row.try_get(user_field).map_err(persistence),
        _ => Err(PersistenceFailure::from_source(
            InvalidPersistedRuntimeTarget,
        )),
    }
}

fn task_header(metadata: Option<&serde_json::Value>) -> Option<(i64, &str)> {
    let object = metadata?.as_object()?;
    let subtype = object.get("subtype")?.as_str()?;
    if !matches!(
        subtype,
        "task_create" | "task_claim" | "task_unclaim" | "task_status" | "task_edit"
    ) {
        return None;
    }
    let number = object.get("task_number")?.as_i64()?;
    let status = object.get("task_status")?.as_str()?;
    (number > 0
        && matches!(
            status,
            "todo" | "in_progress" | "in_review" | "done" | "closed"
        ))
    .then_some((number, status))
}

fn attachment_suffix(metadata: Option<&serde_json::Value>) -> String {
    let Some(attachments) = metadata
        .and_then(serde_json::Value::as_object)
        .and_then(|object| object.get("attachments"))
        .and_then(serde_json::Value::as_array)
    else {
        return String::new();
    };
    let mut parsed = attachments
        .iter()
        .filter_map(attachment_from_value)
        .collect::<Vec<_>>();
    if parsed.is_empty() {
        return String::new();
    }
    assign_attachment_labels(&mut parsed);
    let count = parsed.len();
    let header = if count == 1 {
        "[1 attachment — the label (e.g. `Image #1`) is how the sender refers to it; use `silverhand file view --attachment-id <id>` with the id below to read it]".to_owned()
    } else {
        format!(
            "[{count} attachments — the label (e.g. `Image #1`) is how the sender refers to each; use `silverhand file view --attachment-id <id>` with each id below to read them]"
        )
    };
    let lines = parsed
        .into_iter()
        .map(|attachment| {
            let filename = serde_json::to_string(&attachment.filename)
                .expect("serializing a String cannot fail");
            format!(
                "  - {} — id={} filename={} content_type={} size={}",
                attachment.label.expect("labels were assigned"),
                attachment.id,
                filename,
                attachment.content_type,
                attachment.size
            )
        })
        .collect::<Vec<_>>()
        .join("\n");
    format!("\n\n{header}\n{lines}")
}

struct PresentedAttachment {
    id: String,
    filename: String,
    size: i64,
    content_type: String,
    label: Option<String>,
}

fn attachment_from_value(value: &serde_json::Value) -> Option<PresentedAttachment> {
    let value = value.as_object()?;
    let label = value
        .get("label")
        .and_then(serde_json::Value::as_str)
        .and_then(canonical_attachment_label);
    Some(PresentedAttachment {
        id: value.get("id")?.as_str()?.to_owned(),
        filename: value.get("filename")?.as_str()?.to_owned(),
        size: value.get("size")?.as_i64()?,
        content_type: value.get("content_type")?.as_str()?.to_owned(),
        label,
    })
}

fn canonical_attachment_label(label: &str) -> Option<String> {
    let label = label.trim();
    let (kind, number) = label.split_once(" #")?;
    (matches!(kind, "Image" | "File")
        && number.len() <= 4
        && number.starts_with(|character: char| ('1'..='9').contains(&character))
        && number.chars().all(|character| character.is_ascii_digit()))
    .then(|| format!("{kind} #{number}"))
}

fn assign_attachment_labels(attachments: &mut [PresentedAttachment]) {
    let mut used_images = HashSet::new();
    let mut used_files = HashSet::new();
    for attachment in attachments.iter() {
        if let Some(label) = &attachment.label
            && let Some((kind, number)) = label.split_once(" #")
            && let Ok(number) = number.parse::<usize>()
        {
            match kind {
                "Image" => {
                    used_images.insert(number);
                }
                "File" => {
                    used_files.insert(number);
                }
                _ => {}
            }
        }
    }
    let mut next_image = 1;
    let mut next_file = 1;
    for attachment in attachments
        .iter_mut()
        .filter(|attachment| attachment.label.is_none())
    {
        let (kind, used, next) = if attachment.content_type.starts_with("image/") {
            ("Image", &mut used_images, &mut next_image)
        } else {
            ("File", &mut used_files, &mut next_file)
        };
        while used.contains(next) {
            *next += 1;
        }
        attachment.label = Some(format!("{kind} #{}", *next));
        used.insert(*next);
        *next += 1;
    }
}

#[derive(Serialize)]
struct EncodedDelivery<'a> {
    delivery_id: i64,
    seq: i64,
    presentation: EncodedPresentation<'a>,
}

#[derive(Serialize)]
struct EncodedPresentation<'a> {
    body: &'a str,
    instruction: &'static str,
}

fn encoded_batch_size(deliveries: &[ClaimedInboxDelivery]) -> Result<usize, PersistenceFailure> {
    let value = deliveries
        .iter()
        .map(|delivery| EncodedDelivery {
            delivery_id: delivery.id().as_i64(),
            seq: delivery.seq(),
            presentation: EncodedPresentation {
                body: delivery.presentation(),
                instruction: instruction_wire(delivery.instruction()),
            },
        })
        .collect::<Vec<_>>();
    serde_json::to_vec(&value)
        .map(|encoded| encoded.len())
        .map_err(PersistenceFailure::from_source)
}

fn instruction_wire(instruction: DeliveryInstruction) -> &'static str {
    match instruction {
        DeliveryInstruction::UserForRecipient => "user_for_recipient",
        DeliveryInstruction::UserForOther => "user_for_other",
        DeliveryInstruction::NonSystemMention => "non_system_mention",
        DeliveryInstruction::System => "system",
        DeliveryInstruction::Other => "other",
    }
}

async fn read_workspace_memory_index(
    pool: &SqlitePool,
    agent: &AgentId,
) -> Result<Vec<RuntimeWorkspaceRef>, PersistenceFailure> {
    let rows = sqlx::query(
        "SELECT DISTINCT w.id, w.name
           FROM workspaces w
           LEFT JOIN workspace_members wm ON wm.workspace_id = w.id
          WHERE w.owner_agent_id = ? OR wm.agent_id = ?
          ORDER BY w.id",
    )
    .bind(agent.as_str())
    .bind(agent.as_str())
    .fetch_all(pool)
    .await
    .map_err(persistence)?;
    rows.into_iter()
        .map(|row| {
            Ok(RuntimeWorkspaceRef::decoded(
                WorkspaceId::parse(row.try_get::<String, _>("id").map_err(persistence)?)
                    .map_err(PersistenceFailure::from_source)?,
                row.try_get("name").map_err(persistence)?,
            ))
        })
        .collect()
}

async fn read_members(
    pool: &SqlitePool,
    conversation: &ConversationId,
    placement: RuntimePlacement,
) -> Result<Vec<RuntimeMember>, PersistenceFailure> {
    let rows = match placement {
        RuntimePlacement::Workspace => sqlx::query(
            "SELECT 'agent' AS kind, a.id, a.name, a.display_name, a.runtime
               FROM conversation_agents ca JOIN agents a ON a.id = ca.agent_id
              WHERE ca.conversation_id = ?
              UNION ALL
             SELECT 'human' AS kind, u.id, u.name, u.display_name, NULL AS runtime
               FROM conversation_users cu JOIN users u ON u.id = cu.user_id
              WHERE cu.conversation_id = ?
              ORDER BY kind, id",
        )
        .bind(conversation.as_str())
        .bind(conversation.as_str())
        .fetch_all(pool)
        .await
        .map_err(persistence)?,
        RuntimePlacement::DirectPair => sqlx::query(
            "SELECT c.endpoint_a_kind AS kind, c.endpoint_a_id AS id,
                    CASE c.endpoint_a_kind WHEN 'agent' THEN a.name ELSE u.name END AS name,
                    CASE c.endpoint_a_kind WHEN 'agent' THEN a.display_name ELSE u.display_name END AS display_name,
                    CASE c.endpoint_a_kind WHEN 'agent' THEN a.runtime ELSE NULL END AS runtime
               FROM conversations c
               LEFT JOIN agents a ON c.endpoint_a_kind = 'agent' AND a.id = c.endpoint_a_id
               LEFT JOIN users u ON c.endpoint_a_kind = 'human' AND u.id = c.endpoint_a_id
              WHERE c.id = ?
              UNION ALL
             SELECT c.endpoint_b_kind AS kind, c.endpoint_b_id AS id,
                    CASE c.endpoint_b_kind WHEN 'agent' THEN a.name ELSE u.name END AS name,
                    CASE c.endpoint_b_kind WHEN 'agent' THEN a.display_name ELSE u.display_name END AS display_name,
                    CASE c.endpoint_b_kind WHEN 'agent' THEN a.runtime ELSE NULL END AS runtime
               FROM conversations c
               LEFT JOIN agents a ON c.endpoint_b_kind = 'agent' AND a.id = c.endpoint_b_id
               LEFT JOIN users u ON c.endpoint_b_kind = 'human' AND u.id = c.endpoint_b_id
              WHERE c.id = ?",
        )
        .bind(conversation.as_str())
        .bind(conversation.as_str())
        .fetch_all(pool)
        .await
        .map_err(persistence)?,
    };
    rows.into_iter()
        .map(|row| {
            let kind: String = row.try_get("kind").map_err(persistence)?;
            let id: String = row.try_get("id").map_err(persistence)?;
            let name: Option<String> = row.try_get("name").map_err(persistence)?;
            let display_name: Option<String> = row.try_get("display_name").map_err(persistence)?;
            match kind.as_str() {
                "agent" => {
                    let runtime: Option<String> = row.try_get("runtime").map_err(persistence)?;
                    let runtime = runtime.ok_or_else(|| {
                        PersistenceFailure::from_source(InvalidPersistedRuntimeMember)
                    })?;
                    let runtime = RuntimeKind::parse(&runtime).ok_or_else(|| {
                        PersistenceFailure::from_source(InvalidPersistedRuntimeKind)
                    })?;
                    Ok(RuntimeMember::Agent {
                        id: AgentId::parse(id).map_err(PersistenceFailure::from_source)?,
                        name: name.ok_or_else(|| {
                            PersistenceFailure::from_source(InvalidPersistedRuntimeMember)
                        })?,
                        display_name: display_name.ok_or_else(|| {
                            PersistenceFailure::from_source(InvalidPersistedRuntimeMember)
                        })?,
                        runtime,
                    })
                }
                "human" => Ok(RuntimeMember::Human {
                    id: UserId::parse(id).map_err(PersistenceFailure::from_source)?,
                    name: name.ok_or_else(|| {
                        PersistenceFailure::from_source(InvalidPersistedRuntimeMember)
                    })?,
                    display_name: display_name.ok_or_else(|| {
                        PersistenceFailure::from_source(InvalidPersistedRuntimeMember)
                    })?,
                }),
                _ => Err(PersistenceFailure::from_source(
                    InvalidPersistedRuntimeMember,
                )),
            }
        })
        .collect()
}

fn decode_placement(raw: &str) -> Result<RuntimePlacement, PersistenceFailure> {
    match raw {
        "workspace" => Ok(RuntimePlacement::Workspace),
        "direct_pair" => Ok(RuntimePlacement::DirectPair),
        _ => Err(PersistenceFailure::from_source(
            InvalidPersistedRuntimeTarget,
        )),
    }
}

fn decode_roster(raw: &str) -> Result<RuntimeRoster, PersistenceFailure> {
    match raw {
        "open" => Ok(RuntimeRoster::Open),
        "fixed" => Ok(RuntimeRoster::Fixed),
        _ => Err(PersistenceFailure::from_source(
            InvalidPersistedRuntimeTarget,
        )),
    }
}

fn persistence(error: sqlx::Error) -> PersistenceFailure {
    PersistenceFailure::from_source(error)
}

#[derive(Debug, Error)]
#[error("runtime delivery lease ttl must be positive")]
struct InvalidLeaseTtl;

#[derive(Debug, Error)]
#[error("persisted runtime dispatch target is invalid")]
struct InvalidPersistedRuntimeTarget;

#[derive(Debug, Error)]
#[error("persisted runtime kind is unsupported")]
struct InvalidPersistedRuntimeKind;

#[derive(Debug, Error)]
#[error("persisted runtime member is invalid")]
struct InvalidPersistedRuntimeMember;

#[derive(Debug, Error)]
#[error("persisted message sequence is invalid")]
struct InvalidPersistedMessageSeq;

#[derive(Debug, Error)]
#[error("persisted message coordinate is not addressable")]
struct InvalidPersistedAddress;

#[derive(Debug, Error)]
#[error("persisted inbox delivery kind is unsupported")]
struct InvalidPersistedDeliveryKind;

#[derive(Debug, Error)]
#[error("inbox lease changed while the writer reservation was held")]
struct InboxLeaseInvariant;

#[derive(Debug, Error)]
#[error("inbox settlement ids must be non-empty and unique")]
struct InvalidSettlementIds;

#[derive(Debug, Error)]
#[error("inbox settlement mixed already-settled and unsettled rows")]
struct PartialSettlementInvariant;

#[derive(Debug, Error)]
#[error("inbox settlement changed while the writer reservation was held")]
struct InboxSettlementInvariant;

#[derive(Debug, Error)]
#[error("runtime exit changed while the writer reservation was held")]
struct RuntimeExitInvariant;

#[derive(Debug, Error)]
#[error("runtime projection changed while the writer reservation was held")]
struct RuntimeProjectionInvariant;

#[derive(Debug, Error)]
#[error("runtime activity agent changed while the writer reservation was held")]
struct RuntimeActivityInvariant;

#[cfg(test)]
mod presentation_tests {
    use std::ops::Range;

    use serde_json::Value;

    use super::*;

    struct FixtureReferencePositions;

    impl ReferencePositions for FixtureReferencePositions {
        fn autolink_spans(&self, content: &MessageContent) -> Vec<Range<usize>> {
            let body = content.as_str();
            let mut spans = Vec::new();
            let mut offset = 0;
            while let Some(start) = body[offset..].find("<silverhand://") {
                let start = offset + start;
                let Some(end) = body[start..].find('>') else {
                    break;
                };
                spans.push(start..start + end + 1);
                offset = start + end + 1;
            }
            spans
        }
    }

    #[test]
    fn rust_projection_consumes_the_shared_cross_language_fixtures() {
        let fixture: Value = serde_json::from_str(include_str!(
            "../../../../packages/shared/tests/fixtures/runtime-delivery-presentation.json"
        ))
        .unwrap();
        for case in fixture["cases"].as_array().unwrap() {
            let header = case["header"].as_object().unwrap();
            let sender = header["sender"].as_object().unwrap();
            let (kind, from) = match sender["kind"].as_str().unwrap() {
                "agent" => (FromKind::Agent, FromKind::Agent),
                "human" => (FromKind::User, FromKind::User),
                "system" => (FromKind::System, FromKind::System),
                other => panic!("unexpected fixture sender kind {other}"),
            };
            let sender = format_sender(
                kind,
                sender.get("handle").and_then(Value::as_str),
                sender.get("computer").and_then(Value::as_str),
            );
            let task = header
                .get("task")
                .filter(|value| !value.is_null())
                .map(|task| {
                    (
                        task["number"].as_i64().unwrap(),
                        task["status"].as_str().unwrap(),
                    )
                });
            let metadata = serde_json::json!({ "attachments": case["attachments"] });
            let body = render_delivery_presentation(
                header["messageId"].as_str().unwrap(),
                &sender,
                header["target"].as_str().unwrap(),
                header["timestamp"].as_str().unwrap(),
                task,
                case["content"].as_str().unwrap(),
                &attachment_suffix(Some(&metadata)),
            );
            assert_eq!(body, case["expectedBody"].as_str().unwrap());

            let content = MessageContent::parse(case["content"].as_str().unwrap()).unwrap();
            let signal = classify_delivery_instruction(
                from,
                &content,
                case.get("recipientAgentName")
                    .and_then(Value::as_str)
                    .unwrap_or(""),
                &FixtureReferencePositions,
            );
            assert_eq!(
                instruction_wire(signal),
                case["expectedInstruction"].as_str().unwrap()
            );
        }
        let mut observed = HashSet::new();
        for case in fixture["instructionCases"].as_array().unwrap() {
            let from = match case["fromKind"].as_str().unwrap() {
                "agent" => FromKind::Agent,
                "user" => FromKind::User,
                "system" => FromKind::System,
                other => panic!("unexpected fixture from kind {other}"),
            };
            let content = MessageContent::parse(case["content"].as_str().unwrap()).unwrap();
            let signal = classify_delivery_instruction(
                from,
                &content,
                case["recipientAgentName"].as_str().unwrap(),
                &FixtureReferencePositions,
            );
            let wire = instruction_wire(signal);
            assert_eq!(wire, case["expectedInstruction"].as_str().unwrap());
            observed.insert(wire);
        }
        assert_eq!(
            observed,
            HashSet::from([
                "user_for_recipient",
                "user_for_other",
                "non_system_mention",
                "system",
                "other",
            ])
        );
    }
}
