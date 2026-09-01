//! Exact, scope-keyed runtime stop boundary.
//!
//! This face starts after route admission and host selection. Its target therefore
//! carries the three coordinates already captured by the caller: the persisted host,
//! the runtime scope, and the runtime generation. It deliberately cannot choose a
//! default host, decide ownership, or discover which runtime generation is current.

use std::{error::Error, future::Future};

use crate::{
    foundation::identity::HostId,
    host_runtime::runtime_credential::{RuntimeGeneration, RuntimeScope},
};

/// The exact runtime seat an already-admitted caller wants stopped.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ScopeRuntimeStopTarget {
    host: HostId,
    scope: RuntimeScope,
    generation: RuntimeGeneration,
}

impl ScopeRuntimeStopTarget {
    pub fn new(host: HostId, scope: RuntimeScope, generation: RuntimeGeneration) -> Self {
        Self {
            host,
            scope,
            generation,
        }
    }

    pub fn host(&self) -> &HostId {
        &self.host
    }

    pub fn scope(&self) -> &RuntimeScope {
        &self.scope
    }

    pub fn generation(&self) -> RuntimeGeneration {
        self.generation
    }
}

/// The placement states the exact-host stop adapter can honestly establish.
///
/// Ownership and default-host selection have already happened before this face;
/// runtime-disabled is a provider-composition verdict. Keeping those states out is
/// what prevents this adapter from pretending it owns the whole placement taxonomy.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ScopeRuntimeStopRefusal {
    HostMissing,
    HostPendingAttach,
    HostRevoked,
    HostAttachPending,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ScopeRuntimeStopOutcome;

/// Production-facing capability consumed by bulk stop and other exact-seat owners.
pub trait ScopeRuntimeStopPort: Clone + Send + Sync + 'static {
    type Error: Error + Send + Sync + 'static;

    fn hard_stop(
        &self,
        target: &ScopeRuntimeStopTarget,
    ) -> impl Future<
        Output = Result<Result<ScopeRuntimeStopOutcome, ScopeRuntimeStopRefusal>, Self::Error>,
    > + Send;
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::foundation::identity::{AgentId, ConversationId};

    #[test]
    fn target_preserves_an_agent_slot_without_an_ambient_conversation() {
        let target = ScopeRuntimeStopTarget::new(
            HostId::parse("host-a").unwrap(),
            RuntimeScope::AgentSlot {
                agent: AgentId::parse("agent-a").unwrap(),
            },
            RuntimeGeneration::new(7).unwrap(),
        );

        assert_eq!(target.host().as_str(), "host-a");
        assert_eq!(target.generation().as_i64(), 7);
        assert!(matches!(
            target.scope(),
            RuntimeScope::AgentSlot { agent } if agent.as_str() == "agent-a"
        ));
    }

    #[test]
    fn target_preserves_a_conversation_slot_source_and_agent() {
        let target = ScopeRuntimeStopTarget::new(
            HostId::parse("host-b").unwrap(),
            RuntimeScope::ConversationSlot {
                agent: AgentId::parse("agent-b").unwrap(),
                source: ConversationId::parse("conversation-b").unwrap(),
            },
            RuntimeGeneration::new(11).unwrap(),
        );

        assert_eq!(target.host().as_str(), "host-b");
        assert_eq!(target.generation().as_i64(), 11);
        assert!(matches!(
            target.scope(),
            RuntimeScope::ConversationSlot { agent, source }
                if agent.as_str() == "agent-b" && source.as_str() == "conversation-b"
        ));
    }
}
