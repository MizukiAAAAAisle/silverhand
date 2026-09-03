//! The shared in-transaction write gate for task mutations: per-task participation
//! and direct-pair read-only, decided on the mutation's OWN transaction connection.
//!
//! Both the `status` and `edit` writes run this before their task-row decision, in
//! the TS order (participation → read-only). It reuses the crate's existing
//! transaction-bound authorities — the shared participation predicates and the
//! connection-bound [`ConversationAuthorityReader`] — so there is ONE spelling of
//! each membership rule and none is awaited as an external port under the write
//! lock (only same-connection SQL).

use silverhand_backend_core::foundation::identity::{AgentId, ConversationId, UserId, WorkspaceId};
use silverhand_backend_core::foundation::persistence::PersistenceFailure;
use sqlx::{Sqlite, Transaction};

use super::super::authorities::{ConversationAuthorityReader, TaskWriteAuthorityReader};
use super::super::{SELECT_AGENT_PARTICIPATES, SELECT_USER_PARTICIPATES};
use super::driver;

/// The gate's verdict for a mutation actor over a task's conversation.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) enum GateVerdict {
    /// Participation holds and the conversation accepts posts — proceed.
    Admit,
    /// The agent aggregate itself no longer exists. Kept distinct from a
    /// participation miss for internal agent mutation wire parity.
    AgentNotFound,
    /// Not a participant, or the conversation vanished — the uniform anti-
    /// enumeration miss (write-face ACL).
    NotFound,
    /// A direct-pair conversation whose peer endpoint is gone — read-only.
    ReadOnly,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) enum AgentTaskCapabilityGate {
    Write,
    WriteAndRead,
}

/// Re-prove participation, writability, and the task's own workspace capability
/// on the mutation transaction. Capability denial is `NotFound` so a by-id
/// request cannot turn a guessed global id into a capability oracle. Direct-pair
/// tasks have no workspace capability axis.
pub(super) async fn agent_task_gate(
    tx: &mut Transaction<'_, Sqlite>,
    conversation: &ConversationId,
    agent: &AgentId,
    required: AgentTaskCapabilityGate,
) -> Result<GateVerdict, PersistenceFailure> {
    if !agent_exists(tx, agent).await? {
        return Ok(GateVerdict::AgentNotFound);
    }
    let verdict = agent_gate(tx, conversation, agent).await?;
    if verdict != GateVerdict::Admit {
        return Ok(verdict);
    }

    let placement: Option<(String, Option<String>)> =
        sqlx::query_as("SELECT placement_kind,workspace_id FROM conversations WHERE id = ?")
            .bind(conversation.as_str())
            .fetch_optional(&mut **tx)
            .await
            .map_err(driver)?;
    let Some((kind, workspace)) = placement else {
        return Ok(GateVerdict::NotFound);
    };
    if kind == "direct_pair" {
        return Ok(GateVerdict::Admit);
    }
    let Some(workspace) = (kind == "workspace").then_some(workspace).flatten() else {
        return Ok(GateVerdict::NotFound);
    };
    let workspace =
        WorkspaceId::parse(workspace).map_err(|_| super::corrupt("conversations.workspace_id"))?;
    let mut authority = TaskWriteAuthorityReader::new(tx);
    if !authority.may_write_tasks(&workspace, agent).await? {
        return Ok(GateVerdict::NotFound);
    }
    if required == AgentTaskCapabilityGate::WriteAndRead
        && !authority.may_read_tasks(&workspace, agent).await?
    {
        return Ok(GateVerdict::NotFound);
    }
    Ok(GateVerdict::Admit)
}

/// Fresh aggregate existence on the caller's reserved-writer connection. Runtime
/// credentials and display-name fallbacks are not existence witnesses.
pub(super) async fn agent_exists(
    tx: &mut Transaction<'_, Sqlite>,
    agent: &AgentId,
) -> Result<bool, PersistenceFailure> {
    let present: Option<i64> = sqlx::query_scalar("SELECT 1 FROM agents WHERE id = ?")
        .bind(agent.as_str())
        .fetch_optional(&mut **tx)
        .await
        .map_err(driver)?;
    Ok(present.is_some())
}

/// Run participation → read-only for an AGENT actor on `conversation`, reading only
/// this transaction's connection.
pub(super) async fn agent_gate(
    tx: &mut Transaction<'_, Sqlite>,
    conversation: &ConversationId,
    agent: &AgentId,
) -> Result<GateVerdict, PersistenceFailure> {
    // PARTICIPATION: the shared predicate (direct_pair deliberately not narrowed by
    // endpoint_deleted — a gone peer is a read-only fact). A non-participant is the
    // uniform NotFound.
    let participates: Option<i64> = sqlx::query_scalar(SELECT_AGENT_PARTICIPATES)
        .bind(conversation.as_str())
        .bind(agent.as_str())
        .bind(agent.as_str())
        .bind(agent.as_str())
        .fetch_optional(&mut **tx)
        .await
        .map_err(driver)?;
    if participates.is_none() {
        return Ok(GateVerdict::NotFound);
    }
    read_only_gate(tx, conversation).await
}

/// Run participation → read-only for a HUMAN actor on `conversation`.
pub(super) async fn user_gate(
    tx: &mut Transaction<'_, Sqlite>,
    conversation: &ConversationId,
    user: &UserId,
) -> Result<GateVerdict, PersistenceFailure> {
    let participates: Option<i64> = sqlx::query_scalar(SELECT_USER_PARTICIPATES)
        .bind(conversation.as_str())
        .bind(user.as_str())
        .bind(user.as_str())
        .bind(user.as_str())
        .bind(user.as_str())
        .fetch_optional(&mut **tx)
        .await
        .map_err(driver)?;
    if participates.is_none() {
        return Ok(GateVerdict::NotFound);
    }
    read_only_gate(tx, conversation).await
}

/// The read-only half, shared by both actor kinds and judged AFTER participation:
/// a direct pair whose peer is gone (`accepts_posts == false`) is read-only; a
/// vanished conversation is the uniform miss.
async fn read_only_gate(
    tx: &mut Transaction<'_, Sqlite>,
    conversation: &ConversationId,
) -> Result<GateVerdict, PersistenceFailure> {
    let mut authority = ConversationAuthorityReader::new(&mut *tx);
    match authority.conversation(conversation).await? {
        None => Ok(GateVerdict::NotFound),
        Some(placement) => {
            if authority.accepts_posts(&placement).await? {
                Ok(GateVerdict::Admit)
            } else {
                Ok(GateVerdict::ReadOnly)
            }
        }
    }
}
