//! Freshness: whether a runtime may speak before it has consumed what it was
//! sent.
//!
//! The property belongs to the runtime's field of view, not to a stream. A human
//! has no runtime and therefore no consumption position to be behind, so a human
//! send never meets this guard.

use super::{AgentId, EntropyUnavailable, SendActor};

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
    pub fn mint() -> Result<Self, EntropyUnavailable> {
        let mut bytes = [0u8; 16];
        getrandom::fill(&mut bytes).map_err(|_| EntropyUnavailable)?;
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::messaging::UserId;

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
    fn a_stale_event_id_is_a_distinct_version_4_identity() {
        let first = StaleEventId::mint().unwrap();
        let second = StaleEventId::mint().unwrap();

        assert_ne!(first, second);
        assert_eq!(first.as_str().len(), 36);
        let groups: Vec<usize> = first.as_str().split('-').map(str::len).collect();
        assert_eq!(groups, vec![8, 4, 4, 4, 12]);
        assert_eq!(first.as_str().as_bytes()[14], b'4');
        assert!(matches!(
            first.as_str().as_bytes()[19],
            b'8' | b'9' | b'a' | b'b'
        ));
    }
}
