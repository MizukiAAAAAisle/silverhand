//! Freshness: whether a runtime may speak before it has consumed what it was
//! sent.
//!
//! The property belongs to the runtime's field of view, not to a stream. A human
//! has no runtime and therefore no consumption position to be behind, so a human
//! send never meets this guard.

use super::{AgentId, ConversationId, EnvironmentUnavailable, SendActor, SendEntropy};

/// The delivery scope a runtime's freshness is judged in. It is the agent's own
/// declared session scope, not a property of the send.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum RuntimeScope {
    /// Judged against the conversation the runtime is bound to.
    Conversation,
    /// Judged against every conversation the agent has undelivered input in.
    Agent,
}

impl RuntimeScope {
    pub fn parse_session_scope(raw: &str) -> Option<Self> {
        match raw {
            "conversation" => Some(Self::Conversation),
            "agent" => Some(Self::Agent),
            _ => None,
        }
    }

    /// The persisted `session_scope` token — the inverse of [`Self::parse_session_scope`],
    /// so a writer binding this and a reader parsing it round-trip through one authority.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Conversation => "conversation",
            Self::Agent => "agent",
        }
    }
}

/// Whether this send is subject to the guard at all.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum FreshnessGate {
    /// The actor has no runtime, so there is nothing to be behind.
    NotApplicable,
    /// The sender asked to send anyway. Recorded, because a send that overtook
    /// undelivered input is worth observing after it commits.
    Bypassed,
    Check(AgentId),
}

pub fn freshness_gate(actor: &SendActor, bypass_requested: bool) -> FreshnessGate {
    match actor {
        SendActor::User(_) => FreshnessGate::NotApplicable,
        SendActor::Agent(_) if bypass_requested => FreshnessGate::Bypassed,
        SendActor::Agent(agent) => FreshnessGate::Check(agent.clone()),
    }
}

/// The runtime's own scope could not be determined. Not a refusal: widening an
/// unknown scope to the broader arm would latch a runtime into an undrainable
/// state, and narrowing it would let a stale send through, so neither direction
/// is a safe default and the send fails as a violated invariant instead.
#[derive(Debug, thiserror::Error)]
pub enum FreshnessGuardInvariant {
    #[error("agent row is absent, so its freshness scope cannot be determined")]
    AgentAbsent { agent: AgentId },
    #[error("agent declares a session scope this build does not know")]
    UnknownSessionScope { agent: AgentId },
}

/// Identifies one stale refusal so the caller can name it when resolving. Minted
/// per refusal and never persisted: it correlates a rejection with the resolution
/// that follows it, nothing more.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct StaleEventId(String);

impl StaleEventId {
    pub fn mint(entropy: &impl SendEntropy) -> Result<Self, EnvironmentUnavailable> {
        let mut bytes = [0u8; 16];
        entropy.fill(&mut bytes)?;
        // Version 4, variant 1: the shape consumers already parse.
        bytes[6] = (bytes[6] & 0x0f) | 0x40;
        bytes[8] = (bytes[8] & 0x3f) | 0x80;

        let mut text = String::with_capacity(36);
        for (index, byte) in bytes.iter().enumerate() {
            if matches!(index, 4 | 6 | 8 | 10) {
                text.push('-');
            }
            text.push_str(&format!("{byte:02x}"));
        }
        Ok(Self(text))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

/// The runtime still owes itself input it has not consumed. Signal only: it
/// carries no message body, no ordinal and no count, because a stale answer must
/// not become a side channel for content the caller has not been delivered.
#[derive(Clone, Debug, Eq, PartialEq, thiserror::Error)]
#[error("this runtime has undelivered input it must consume before sending")]
pub struct StaleRefusal {
    pub stale_event_id: StaleEventId,
    pub target_conversation_id: ConversationId,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::messaging::{ConversationId, EnvironmentUnavailable, UserId};

    /// Entropy with no randomness in it, so the identity can be asserted exactly.
    struct FixedEntropy(&'static [u8; 16]);

    impl SendEntropy for FixedEntropy {
        fn fill(&self, buffer: &mut [u8]) -> Result<(), EnvironmentUnavailable> {
            buffer.copy_from_slice(self.0);
            Ok(())
        }
    }

    fn agent() -> AgentId {
        AgentId::parse("agent-1").unwrap()
    }

    #[test]
    fn a_human_send_never_meets_the_guard() {
        let actor = SendActor::User(UserId::parse("user-1").unwrap());

        assert_eq!(freshness_gate(&actor, false), FreshnessGate::NotApplicable);
        // Even asked for, a bypass is meaningless where the guard does not apply.
        assert_eq!(freshness_gate(&actor, true), FreshnessGate::NotApplicable);
    }

    #[test]
    fn an_agent_send_is_checked_unless_it_asked_to_send_anyway() {
        let actor = SendActor::Agent(agent());

        assert_eq!(freshness_gate(&actor, false), FreshnessGate::Check(agent()));
        assert_eq!(freshness_gate(&actor, true), FreshnessGate::Bypassed);
    }

    #[test]
    fn only_the_two_declared_session_scopes_are_understood() {
        assert_eq!(
            RuntimeScope::parse_session_scope("conversation"),
            Some(RuntimeScope::Conversation)
        );
        assert_eq!(
            RuntimeScope::parse_session_scope("agent"),
            Some(RuntimeScope::Agent)
        );
        assert_eq!(RuntimeScope::parse_session_scope("workspace"), None);
        assert_eq!(RuntimeScope::parse_session_scope(""), None);
    }

    #[test]
    fn a_stale_event_id_stamps_the_version_and_variant_consumers_parse() {
        let ascending = StaleEventId::mint(&FixedEntropy(&[
            0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0a, 0x0b, 0x0c, 0x0d,
            0x0e, 0x0f,
        ]))
        .unwrap();
        let ones = StaleEventId::mint(&FixedEntropy(&[0xff; 16])).unwrap();

        // Byte 6 keeps its low nibble under a forced version 4; byte 8 keeps its
        // low six bits under a forced variant 1.
        assert_eq!(ascending.as_str(), "00010203-0405-4607-8809-0a0b0c0d0e0f");
        assert_eq!(ones.as_str(), "ffffffff-ffff-4fff-bfff-ffffffffffff");
    }

    #[test]
    fn a_stale_refusal_carries_signal_metadata_only() {
        let refusal = StaleRefusal {
            stale_event_id: StaleEventId::mint(&FixedEntropy(&[0u8; 16])).unwrap(),
            target_conversation_id: ConversationId::parse("conv-1").unwrap(),
        };

        assert_eq!(
            refusal.target_conversation_id,
            ConversationId::parse("conv-1").unwrap()
        );
        assert!(refusal.to_string().contains("undelivered input"));
    }
}
