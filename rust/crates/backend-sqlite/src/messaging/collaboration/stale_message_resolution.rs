//! One-snapshot admission for the internal stale-message resolution route.
//!
//! The operation does not write the product database. It still consumes the
//! exact post authority used by messaging: selected conversation placement,
//! actual agent participation and the half-dead direct-pair narrowing. The
//! independent `send_messages` capability remains a separate port at the HTTP
//! boundary.

use silverhand_backend_core::{
    identity::{AgentId, ConversationId},
    persistence::PersistenceFailure,
};
use sqlx::SqlitePool;
use thiserror::Error;

use crate::messaging::{MessagingStore, authorities::ConversationAuthorityReader, driver};

#[derive(Clone)]
pub struct SqliteStaleMessageResolutionAdmission {
    pool: SqlitePool,
}

impl<E> MessagingStore<E> {
    pub fn stale_message_resolution_admission(&self) -> SqliteStaleMessageResolutionAdmission {
        SqliteStaleMessageResolutionAdmission {
            pool: self.pool.clone(),
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct StaleMessageResolutionAdmissionSource {
    agent: AgentId,
    conversation: ConversationId,
}

impl StaleMessageResolutionAdmissionSource {
    pub fn agent(&self) -> &AgentId {
        &self.agent
    }

    pub fn conversation(&self) -> &ConversationId {
        &self.conversation
    }

    pub fn bind(
        self,
        agent: &AgentId,
        conversation: &ConversationId,
    ) -> Result<Self, StaleMessageResolutionAdmissionIdentityMismatch> {
        if &self.agent != agent || &self.conversation != conversation {
            return Err(StaleMessageResolutionAdmissionIdentityMismatch);
        }
        Ok(self)
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Error)]
#[error("stale-message resolution admission source differs from the authenticated request")]
pub struct StaleMessageResolutionAdmissionIdentityMismatch;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum StaleMessageResolutionAdmissionRefusal {
    Forbidden,
}

impl SqliteStaleMessageResolutionAdmission {
    pub async fn admit(
        &self,
        agent: &AgentId,
        conversation: &ConversationId,
    ) -> Result<
        Result<StaleMessageResolutionAdmissionSource, StaleMessageResolutionAdmissionRefusal>,
        PersistenceFailure,
    > {
        let mut tx = self
            .pool
            .begin_with("BEGIN DEFERRED")
            .await
            .map_err(driver)?;
        let outcome = {
            let mut reads = ConversationAuthorityReader::new(&mut tx);
            let Some(selected) = reads.conversation(conversation).await? else {
                return commit_refusal(tx).await;
            };
            let Some(source_agent) = reads.agent_participation_source(&selected, agent).await?
            else {
                return commit_refusal(tx).await;
            };
            if !reads.accepts_posts(&selected).await? {
                return commit_refusal(tx).await;
            }
            StaleMessageResolutionAdmissionSource {
                agent: source_agent,
                conversation: selected.id,
            }
        };
        tx.commit().await.map_err(driver)?;
        Ok(Ok(outcome))
    }
}

async fn commit_refusal(
    tx: sqlx::Transaction<'_, sqlx::Sqlite>,
) -> Result<
    Result<StaleMessageResolutionAdmissionSource, StaleMessageResolutionAdmissionRefusal>,
    PersistenceFailure,
> {
    tx.commit().await.map_err(driver)?;
    Ok(Err(StaleMessageResolutionAdmissionRefusal::Forbidden))
}
