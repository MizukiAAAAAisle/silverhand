//! The conversation-inbox reads the runtime-switch saga runs POST-COMMIT to plan
//! its best-effort re-drive.
//!
//! The saga's [`SwitchConversationCoordination`] port lives in the messaging bounded
//! context, not the host-agent one: both the pending-inbox enumerations and the
//! placement-aware participation check are messaging-owned reads. Reusing the send
//! gate's [`SELECT_AGENT_PARTICIPATES`] fragment keeps the participation authority
//! single — a focus captured before clear is reused only while that one predicate
//! still accepts it, never against a paraphrase.
//!
//! Each enumeration mirrors its TypeScript repository statement verbatim:
//! `list_pending_for_agent` is the AgentSlot restart's oldest-first origin scan
//! (`in_flight_owner IS NULL`, `GROUP BY conversation_id ORDER BY MIN(id)`), and
//! `list_pending_for_agent_since` is the ConversationSlot's during-transition nudge
//! (`created_at >= ?`, in-flight rows INCLUDED, distinct ids ordered by id).

use silverhand_backend_core::{
    agent_runtime_switch::SwitchConversationCoordination,
    identity::{AgentId, ConversationId},
    persistence::PersistenceFailure,
};
use sqlx::{Row, SqlitePool, sqlite::SqliteRow};

use crate::messaging::{MessagingStore, SELECT_AGENT_PARTICIPATES};

/// Every origin conversation with pending custody for one AgentSlot, ordered by
/// first inbox id so reconnect replay preserves global arrival order across
/// targets. `in_flight_owner IS NULL` is the drain-side narrowing: a claimed lease
/// is not a fresh restart candidate until it is rolled back under the lock.
const SELECT_PENDING_FOR_AGENT: &str = "SELECT conversation_id \
       FROM conversation_inboxes \
      WHERE agent_id = ? \
        AND delivered_at IS NULL \
        AND failed_at IS NULL \
        AND in_flight_owner IS NULL \
      GROUP BY conversation_id \
      ORDER BY MIN(id) ASC";

/// Pending pairs that gained undelivered input at or after `since_ms`, excluding
/// historical backlog. In-flight rows are DELIBERATELY included here (no
/// `in_flight_owner` narrowing): a config change nudges only what arrived while the
/// spawn gate was held, and a lease taken in that window is still such a message.
const SELECT_PENDING_FOR_AGENT_SINCE: &str = "SELECT DISTINCT conversation_id \
       FROM conversation_inboxes \
      WHERE agent_id = ? \
        AND delivered_at IS NULL \
        AND failed_at IS NULL \
        AND created_at >= ? \
      ORDER BY conversation_id ASC";

/// A pool-scoped read adapter: the saga's re-drive plan runs after the transition
/// commits and its lock releases, so it reads outside any write reservation.
#[derive(Clone)]
pub struct SqliteSwitchConversationCoordination {
    pool: SqlitePool,
}

impl<E> MessagingStore<E> {
    pub fn switch_conversation_coordination(&self) -> SqliteSwitchConversationCoordination {
        SqliteSwitchConversationCoordination {
            pool: self.pool.clone(),
        }
    }
}

fn decode_conversation_id(row: &SqliteRow) -> Result<ConversationId, PersistenceFailure> {
    let raw: String = row
        .try_get("conversation_id")
        .map_err(PersistenceFailure::from_source)?;
    ConversationId::parse(raw).map_err(PersistenceFailure::from_source)
}

impl SwitchConversationCoordination for SqliteSwitchConversationCoordination {
    async fn list_pending_for_agent(
        &self,
        agent: &AgentId,
    ) -> Result<Vec<ConversationId>, PersistenceFailure> {
        let rows = sqlx::query(SELECT_PENDING_FOR_AGENT)
            .bind(agent.as_str())
            .fetch_all(&self.pool)
            .await
            .map_err(PersistenceFailure::from_source)?;
        rows.iter().map(decode_conversation_id).collect()
    }

    async fn list_pending_for_agent_since(
        &self,
        agent: &AgentId,
        since_ms: i64,
    ) -> Result<Vec<ConversationId>, PersistenceFailure> {
        let rows = sqlx::query(SELECT_PENDING_FOR_AGENT_SINCE)
            .bind(agent.as_str())
            .bind(since_ms)
            .fetch_all(&self.pool)
            .await
            .map_err(PersistenceFailure::from_source)?;
        rows.iter().map(decode_conversation_id).collect()
    }

    async fn is_agent_participant(
        &self,
        conversation: &ConversationId,
        agent: &AgentId,
    ) -> Result<bool, PersistenceFailure> {
        let found: Option<i64> = sqlx::query_scalar(SELECT_AGENT_PARTICIPATES)
            .bind(conversation.as_str())
            .bind(agent.as_str())
            .bind(agent.as_str())
            .bind(agent.as_str())
            .fetch_optional(&self.pool)
            .await
            .map_err(PersistenceFailure::from_source)?;
        Ok(found.is_some())
    }
}
