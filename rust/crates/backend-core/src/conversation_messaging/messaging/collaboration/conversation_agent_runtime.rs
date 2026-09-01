//! Sparse durable runtime projection for a committed conversation roster.
//!
//! Roster membership chooses the population. Runtime slots contribute values
//! only; they never decide who participates in the conversation.

use std::{error::Error, future::Future};

use crate::{
    conversation_messaging::messaging::collaboration::runtime_control::CliSessionId,
    foundation::identity::{AgentId, ConversationId, UserId},
    host_runtime::runtime_credential::{RuntimeGeneration, RuntimeScope},
};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum RuntimeProjectionStatus {
    Idle,
    Starting,
    Active,
    Crashed,
}

impl RuntimeProjectionStatus {
    pub fn parse(raw: &str) -> Result<Self, UnknownRuntimeProjectionStatus> {
        match raw {
            "idle" => Ok(Self::Idle),
            "starting" => Ok(Self::Starting),
            "active" => Ok(Self::Active),
            "crashed" => Ok(Self::Crashed),
            _ => Err(UnknownRuntimeProjectionStatus),
        }
    }

    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Idle => "idle",
            Self::Starting => "starting",
            Self::Active => "active",
            Self::Crashed => "crashed",
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, thiserror::Error)]
#[error("unknown runtime projection status")]
pub struct UnknownRuntimeProjectionStatus;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct RuntimePid(i64);

impl RuntimePid {
    const MAX_JAVASCRIPT_INTEGER: i64 = 9_007_199_254_740_991;

    pub fn new(value: i64) -> Result<Self, InvalidRuntimePid> {
        (1..=Self::MAX_JAVASCRIPT_INTEGER)
            .contains(&value)
            .then_some(Self(value))
            .ok_or(InvalidRuntimePid)
    }

    pub const fn get(self) -> i64 {
        self.0
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, thiserror::Error)]
#[error("runtime pid must be positive and exact on the JavaScript wire")]
pub struct InvalidRuntimePid;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ConversationAgentRuntimeRow {
    population_conversation: ConversationId,
    population_agent: AgentId,
    slot: RuntimeScope,
    generation: RuntimeGeneration,
    cli_session: Option<CliSessionId>,
    pid: Option<RuntimePid>,
    status: RuntimeProjectionStatus,
}

impl ConversationAgentRuntimeRow {
    #[allow(clippy::too_many_arguments)]
    pub fn projected(
        population_conversation: ConversationId,
        population_agent: AgentId,
        slot: RuntimeScope,
        generation: RuntimeGeneration,
        cli_session: Option<CliSessionId>,
        pid: Option<RuntimePid>,
        status: RuntimeProjectionStatus,
    ) -> Result<Self, RuntimeProjectionCoordinateMismatch> {
        let slot_matches = slot.agent() == &population_agent
            && slot
                .source()
                .is_none_or(|source| source == &population_conversation);
        if !slot_matches {
            return Err(RuntimeProjectionCoordinateMismatch);
        }
        Ok(Self {
            population_conversation,
            population_agent,
            slot,
            generation,
            cli_session,
            pid,
            status,
        })
    }

    pub fn agent(&self) -> &AgentId {
        &self.population_agent
    }

    pub const fn scope_kind(&self) -> &'static str {
        match self.slot {
            RuntimeScope::AgentSlot { .. } => "agent",
            RuntimeScope::ConversationSlot { .. } => "conversation",
        }
    }

    pub const fn generation(&self) -> RuntimeGeneration {
        self.generation
    }

    pub fn cli_session(&self) -> Option<&CliSessionId> {
        self.cli_session.as_ref()
    }

    pub const fn pid(&self) -> Option<RuntimePid> {
        self.pid
    }

    pub const fn status(&self) -> RuntimeProjectionStatus {
        self.status
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, thiserror::Error)]
#[error("runtime slot coordinate does not serve its roster population coordinate")]
pub struct RuntimeProjectionCoordinateMismatch;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ConversationAgentRuntimeProjection {
    viewer: UserId,
    conversation: ConversationId,
    rows: Vec<ConversationAgentRuntimeRow>,
}

impl ConversationAgentRuntimeProjection {
    pub fn projected(
        viewer: UserId,
        conversation: ConversationId,
        rows: Vec<ConversationAgentRuntimeRow>,
    ) -> Result<Self, MalformedConversationAgentRuntimeProjection> {
        let coordinates_match = rows
            .iter()
            .all(|row| row.population_conversation == conversation);
        let ordered = rows
            .windows(2)
            .all(|pair| pair[0].population_agent.as_str() < pair[1].population_agent.as_str());
        if !coordinates_match || !ordered {
            return Err(MalformedConversationAgentRuntimeProjection);
        }
        Ok(Self {
            viewer,
            conversation,
            rows,
        })
    }

    pub fn bind(
        self,
        requested_viewer: &UserId,
        requested_conversation: &ConversationId,
    ) -> Result<BoundConversationAgentRuntimeProjection, ConversationAgentRuntimeIdentityMismatch>
    {
        if &self.viewer != requested_viewer
            || &self.conversation != requested_conversation
            || self.rows.iter().any(|row| {
                &row.population_conversation != requested_conversation
                    || row
                        .slot
                        .source()
                        .is_some_and(|source| source != requested_conversation)
            })
        {
            return Err(ConversationAgentRuntimeIdentityMismatch);
        }
        Ok(BoundConversationAgentRuntimeProjection(self))
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct BoundConversationAgentRuntimeProjection(ConversationAgentRuntimeProjection);

impl BoundConversationAgentRuntimeProjection {
    pub fn rows(&self) -> &[ConversationAgentRuntimeRow] {
        &self.0.rows
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, thiserror::Error)]
#[error("conversation runtime rows are not a unique coordinate-closed total order")]
pub struct MalformedConversationAgentRuntimeProjection;

#[derive(Clone, Copy, Debug, Eq, PartialEq, thiserror::Error)]
#[error("conversation runtime projection differs from the requested viewer/conversation")]
pub struct ConversationAgentRuntimeIdentityMismatch;

#[derive(Clone, Copy, Debug, Eq, PartialEq, thiserror::Error)]
pub enum ConversationAgentRuntimeRefusal {
    #[error("channel not found")]
    NotFound,
    #[error("viewer cannot read channel runtime")]
    Forbidden,
}

pub trait ConversationAgentRuntimeReadPort {
    type Error: Error + Send + Sync + 'static;

    fn read(
        &self,
        viewer: &UserId,
        conversation: &ConversationId,
    ) -> impl Future<
        Output = Result<
            Result<ConversationAgentRuntimeProjection, ConversationAgentRuntimeRefusal>,
            Self::Error,
        >,
    > + Send;
}

#[cfg(test)]
mod tests {
    use super::*;

    fn row(agent: &str, source: Option<&str>) -> ConversationAgentRuntimeRow {
        let agent = AgentId::parse(agent).unwrap();
        let slot = match source {
            Some(source) => RuntimeScope::ConversationSlot {
                agent: agent.clone(),
                source: ConversationId::parse(source).unwrap(),
            },
            None => RuntimeScope::AgentSlot {
                agent: agent.clone(),
            },
        };
        ConversationAgentRuntimeRow::projected(
            ConversationId::parse("c").unwrap(),
            agent,
            slot,
            RuntimeGeneration::new(1).unwrap(),
            None,
            RuntimePid::new(7).ok(),
            RuntimeProjectionStatus::Active,
        )
        .unwrap()
    }

    #[test]
    fn projection_is_totally_ordered_and_binds_viewer_conversation_and_slot_sources() {
        let projection = ConversationAgentRuntimeProjection::projected(
            UserId::parse("viewer").unwrap(),
            ConversationId::parse("c").unwrap(),
            vec![row("a", None), row("b", Some("c"))],
        )
        .unwrap();
        assert!(
            projection
                .clone()
                .bind(
                    &UserId::parse("other").unwrap(),
                    &ConversationId::parse("c").unwrap()
                )
                .is_err()
        );
        assert!(
            projection
                .clone()
                .bind(
                    &UserId::parse("viewer").unwrap(),
                    &ConversationId::parse("other").unwrap()
                )
                .is_err()
        );
        assert_eq!(
            projection
                .bind(
                    &UserId::parse("viewer").unwrap(),
                    &ConversationId::parse("c").unwrap()
                )
                .unwrap()
                .rows()
                .len(),
            2
        );
        assert!(
            ConversationAgentRuntimeProjection::projected(
                UserId::parse("viewer").unwrap(),
                ConversationId::parse("c").unwrap(),
                vec![row("b", Some("c")), row("a", None)],
            )
            .is_err()
        );
        assert!(
            ConversationAgentRuntimeRow::projected(
                ConversationId::parse("c").unwrap(),
                AgentId::parse("a").unwrap(),
                RuntimeScope::ConversationSlot {
                    agent: AgentId::parse("a").unwrap(),
                    source: ConversationId::parse("foreign").unwrap(),
                },
                RuntimeGeneration::new(0).unwrap(),
                None,
                None,
                RuntimeProjectionStatus::Idle,
            )
            .is_err()
        );
    }

    #[test]
    fn scalar_and_token_domains_are_closed() {
        assert!(RuntimePid::new(0).is_err());
        assert_eq!(RuntimePid::new(1).unwrap().get(), 1);
        for token in ["idle", "starting", "active", "crashed"] {
            let status = RuntimeProjectionStatus::parse(token).unwrap();
            assert_eq!(status.as_str(), token);
        }
        assert!(RuntimeProjectionStatus::parse("stopped").is_err());
    }
}
