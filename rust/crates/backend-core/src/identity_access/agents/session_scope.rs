//! An agent's declared session scope — the base vocabulary of how broadly a
//! runtime's field of view is judged.
//!
//! It is a property of the agent itself, persisted as `agents.session_scope`, and
//! read alike by freshness judging, the undelivered-input query and create-time
//! materialization. Those readers are peers, so the scope belongs to the agent's
//! own vocabulary rather than to any one reader's namespace — this is not the
//! `runtime_credential::RuntimeScope` seat coordinate, which names where a runtime
//! is seated, not how broadly one agent's session spans.

/// The scope an agent's runtime session spans, persisted as `agents.session_scope`.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum AgentSessionScope {
    /// The runtime is bound to a single conversation, judged against that
    /// conversation alone.
    Conversation,
    /// The runtime spans the agent, judged against every conversation the agent
    /// has undelivered input in.
    Agent,
}

impl AgentSessionScope {
    /// Parse the persisted `session_scope` token. An unknown token is rejected
    /// rather than defaulted: widening it to the broader arm would latch a runtime
    /// into an undrainable state and narrowing it would let a stale send through,
    /// so neither direction is safe and the caller must treat `None` as a fault.
    pub fn parse(raw: &str) -> Option<Self> {
        match raw {
            "conversation" => Some(Self::Conversation),
            "agent" => Some(Self::Agent),
            _ => None,
        }
    }

    /// The persisted `session_scope` token — the inverse of [`Self::parse`], so a
    /// writer binding this and a reader parsing it round-trip through one authority.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Conversation => "conversation",
            Self::Agent => "agent",
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_the_two_declared_session_scopes_are_understood() {
        for (scope, token) in [
            (AgentSessionScope::Conversation, "conversation"),
            (AgentSessionScope::Agent, "agent"),
        ] {
            assert_eq!(AgentSessionScope::parse(token), Some(scope));
            assert_eq!(scope.as_str(), token);
        }
        assert_eq!(AgentSessionScope::parse("workspace"), None);
        assert_eq!(AgentSessionScope::parse(""), None);
    }
}
