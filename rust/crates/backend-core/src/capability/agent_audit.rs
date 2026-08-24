//! Whether an agent's owner may read a conversation the agent took part in.
//!
//! One reason to change: the domain of the owner audit face. It is deliberately
//! neither visibility nor authority-to-act: an owner reads third-party
//! transcripts here, so widening either of those rules must not widen this one.
//!
//! Owner-only by construction. A workspace admin who did not create the agent
//! does not audit it, and a peer agent never does.

use crate::{
    capability::{decision::Decision, principal::Principal},
    identity::UserId,
};

/// The facts the list face reads.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AgentAuditSubject {
    pub created_by_user_id: Option<UserId>,
}

/// The facts one conversation adds. Both are read for the same conversation the
/// request names, so a caller cannot pair one conversation's existence with
/// another's participation.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct AuditedConversation {
    /// Whether the conversation exists at all.
    pub exists: bool,
    /// Whether the agent is a subject participant of it — the full participation
    /// arc, with no narrowing to "currently running in".
    pub agent_participates: bool,
}

/// Why an audit was refused.
///
/// `ConversationAbsent` and `AgentNotAParticipant` are distinct here and collapse
/// to ONE answer on the wire on purpose: the surface runs the visibility ladder
/// first, so a non-owner never reaches this decision, and an owner must not be
/// able to probe which conversation ids exist. The distinction is kept for the
/// operator, not for the caller.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum AuditRefused {
    /// The agent row is absent. A fact, not a failed read.
    AgentAbsent,
    /// An agent or any non-human principal. Auditing is a human owner's act.
    NotAHuman,
    /// A human who did not create this agent.
    NotTheCreator,
    ConversationAbsent,
    AgentNotAParticipant,
}

/// May this principal audit this agent's chats at all?
pub fn can_audit_agent_chats(
    principal: &Principal,
    agent: Option<&AgentAuditSubject>,
) -> Decision<AuditRefused> {
    match principal {
        // System bypasses, so the ladder stays consistent for internal callers.
        Principal::System => Decision::Allow,
        Principal::Agent { .. } => Decision::Denied(AuditRefused::NotAHuman),
        Principal::Human { user_id } => match agent {
            None => Decision::Denied(AuditRefused::AgentAbsent),
            Some(agent) if agent.created_by_user_id.as_ref() == Some(user_id) => Decision::Allow,
            Some(_) => Decision::Denied(AuditRefused::NotTheCreator),
        },
    }
}

/// May this principal audit THIS conversation as one of the agent's chats?
///
/// Two conjuncts on top of the owner rule, each load-bearing: the conversation
/// exists, and the agent is actually a party to it. The second is what keeps an
/// owner from reading an unrelated conversation through a guessed id.
pub fn can_audit_agent_conversation(
    principal: &Principal,
    agent: Option<&AgentAuditSubject>,
    conversation: AuditedConversation,
) -> Decision<AuditRefused> {
    let chats = can_audit_agent_chats(principal, agent);
    if let Decision::Denied(reason) = chats {
        return Decision::Denied(reason);
    }
    if !conversation.exists {
        return Decision::Denied(AuditRefused::ConversationAbsent);
    }
    if !conversation.agent_participates {
        return Decision::Denied(AuditRefused::AgentNotAParticipant);
    }
    Decision::Allow
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::identity::AgentId;

    fn user(id: &str) -> UserId {
        UserId::parse(id).expect("user id")
    }

    fn agent_id(id: &str) -> AgentId {
        AgentId::parse(id).expect("agent id")
    }

    fn created_by(creator: &str) -> AgentAuditSubject {
        AgentAuditSubject {
            created_by_user_id: Some(user(creator)),
        }
    }

    const PARTY: AuditedConversation = AuditedConversation {
        exists: true,
        agent_participates: true,
    };

    #[test]
    fn the_system_audits_without_reading_the_row() {
        assert!(can_audit_agent_chats(&Principal::System, None).is_allowed());
        assert!(can_audit_agent_conversation(&Principal::System, None, PARTY).is_allowed());
    }

    #[test]
    fn only_the_creator_audits() {
        let agent = created_by("owner");
        assert!(can_audit_agent_chats(&Principal::human(user("owner")), Some(&agent)).is_allowed());
        assert_eq!(
            can_audit_agent_chats(&Principal::human(user("admin")), Some(&agent)),
            Decision::Denied(AuditRefused::NotTheCreator)
        );
    }

    #[test]
    fn an_agent_never_audits_even_itself() {
        let agent = created_by("owner");
        assert_eq!(
            can_audit_agent_chats(&Principal::agent(agent_id("a1")), Some(&agent)),
            Decision::Denied(AuditRefused::NotAHuman)
        );
    }

    #[test]
    fn an_absent_agent_row_refuses_a_human() {
        assert_eq!(
            can_audit_agent_chats(&Principal::human(user("owner")), None),
            Decision::Denied(AuditRefused::AgentAbsent)
        );
    }

    #[test]
    fn the_owner_rule_gates_the_per_conversation_face_first() {
        // A non-owner is refused for the OWNER reason even when the conversation
        // is missing, so the per-conversation arms never leak to a stranger.
        let agent = created_by("owner");
        let missing = AuditedConversation {
            exists: false,
            agent_participates: false,
        };
        assert_eq!(
            can_audit_agent_conversation(
                &Principal::human(user("stranger")),
                Some(&agent),
                missing
            ),
            Decision::Denied(AuditRefused::NotTheCreator)
        );
    }

    #[test]
    fn the_owner_still_needs_the_conversation_to_exist_and_to_involve_the_agent() {
        let agent = created_by("owner");
        let owner = Principal::human(user("owner"));
        assert!(can_audit_agent_conversation(&owner, Some(&agent), PARTY).is_allowed());
        assert_eq!(
            can_audit_agent_conversation(
                &owner,
                Some(&agent),
                AuditedConversation {
                    exists: false,
                    agent_participates: true,
                }
            ),
            Decision::Denied(AuditRefused::ConversationAbsent)
        );
        assert_eq!(
            can_audit_agent_conversation(
                &owner,
                Some(&agent),
                AuditedConversation {
                    exists: true,
                    agent_participates: false,
                }
            ),
            Decision::Denied(AuditRefused::AgentNotAParticipant)
        );
    }
}
