//! Admission contract for the internal stale-message resolution acknowledgement.
//!
//! The operation writes nothing. Its only application question is whether this
//! agent may still post into the named conversation, answered against the exact
//! post authority messaging already uses. This module owns that question, the
//! admitted answer and the identity seal; the HTTP shape, the independent
//! `send_messages` capability and the warning record stay with their owners.
//!
//! An admitted fact carries the coordinates the authority actually selected, so
//! a consumer must bind it to the authenticated request before use. The bound
//! value has no public constructor, which makes the seal a cross-crate
//! guarantee rather than a convention each consumer re-implements.
//!
//! ```compile_fail
//! use silverhand_backend_core::{
//!     identity::{AgentId, ConversationId},
//!     messaging::collaboration::stale_message_resolution::{
//!         BoundStaleMessageResolutionAdmission, StaleMessageResolutionAdmissionFact,
//!     },
//! };
//! let fact = StaleMessageResolutionAdmissionFact::selected(
//!     AgentId::parse("agent-1").unwrap(),
//!     ConversationId::parse("conv-1").unwrap(),
//! );
//! let _forged = BoundStaleMessageResolutionAdmission(fact);
//! ```
//!
//! The same value is reachable only through the bind:
//!
//! ```
//! use silverhand_backend_core::{
//!     identity::{AgentId, ConversationId},
//!     messaging::collaboration::stale_message_resolution::StaleMessageResolutionAdmissionFact,
//! };
//! let agent = AgentId::parse("agent-1").unwrap();
//! let conversation = ConversationId::parse("conv-1").unwrap();
//! let bound = StaleMessageResolutionAdmissionFact::selected(agent.clone(), conversation.clone())
//!     .bind(&agent, &conversation)
//!     .unwrap();
//! assert_eq!(bound.into_parts(), (agent, conversation));
//! ```

use std::{error::Error, future::Future};

use crate::identity::{AgentId, ConversationId};

/// Consumer port for the one admission question this operation asks.
///
/// The adapter owns the read order and the storage snapshot; this capability
/// consumes only the closed verdict.
pub trait StaleMessageResolutionAdmissionPort {
    type Error: Error + Send + Sync + 'static;

    fn admit(
        &self,
        agent: &AgentId,
        conversation: &ConversationId,
    ) -> impl Future<
        Output = Result<
            Result<StaleMessageResolutionAdmissionFact, StaleMessageResolutionAdmissionRefusal>,
            Self::Error,
        >,
    > + Send;
}

/// The coordinates the authority actually admitted, still unbound.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct StaleMessageResolutionAdmissionFact {
    agent: AgentId,
    conversation: ConversationId,
}

impl StaleMessageResolutionAdmissionFact {
    pub fn selected(agent: AgentId, conversation: ConversationId) -> Self {
        Self {
            agent,
            conversation,
        }
    }

    pub fn bind(
        self,
        agent: &AgentId,
        conversation: &ConversationId,
    ) -> Result<BoundStaleMessageResolutionAdmission, StaleMessageResolutionAdmissionIdentityMismatch>
    {
        if &self.agent != agent || &self.conversation != conversation {
            return Err(StaleMessageResolutionAdmissionIdentityMismatch);
        }
        Ok(BoundStaleMessageResolutionAdmission(self))
    }
}

/// An admitted fact proven to belong to the authenticated request.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct BoundStaleMessageResolutionAdmission(StaleMessageResolutionAdmissionFact);

impl BoundStaleMessageResolutionAdmission {
    pub fn into_parts(self) -> (AgentId, ConversationId) {
        (self.0.agent, self.0.conversation)
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, thiserror::Error)]
#[error("stale-message resolution admission source differs from the authenticated request")]
pub struct StaleMessageResolutionAdmissionIdentityMismatch;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum StaleMessageResolutionAdmissionRefusal {
    Forbidden,
}
