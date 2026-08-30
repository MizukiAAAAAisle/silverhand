//! The composed owner-audit floor verdict.
//!
//! Both the route (verdict → wire status) and the SQLite adapter (verdict → read or
//! skip) decide against this ONE ladder, so the fresh-snapshot data gate and the wire
//! mapping cannot drift. The order is fixed and total: source-bind, then active-stage
//! visibility, then the audit capability — the SAME three gates, in the SAME order, the
//! route's floor renders.
//!
//! Why it lives beside the read model rather than in `capability`: it composes the
//! `agent_view` and `agent_audit` capabilities AGAINST the read model's own
//! [`AuditSubjectFacts`] projection, so it is the read model's admission policy, not a
//! new capability. It adds no rule of its own — every arm delegates to the existing
//! capability functions.

use crate::{
    capability::{
        agent_audit::{AuditedConversation, can_audit_agent_chats, can_audit_agent_conversation},
        agent_view::{VisibleStages, can_view_agent},
    },
    identity::{AgentId, Principal},
};

use super::AuditSubjectFacts;

/// The owner-audit floor verdict against ONE freshly-read subject-fact snapshot.
///
/// Every non-`Allow` arm names the FIRST gate that refused, in ladder order, so the
/// route can map it to the one wire status that gate owns. The adapter reads the
/// sensitive data only for [`Allow`](Self::Allow); a corrupt data row can therefore
/// never rewrite a refusal into a read `500`.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum AuditFloorVerdict {
    /// Source-bind, visibility, and the audit capability all admit — the data may be read.
    Allow,
    /// The resolved subject is not the requested agent: a resolver defect (safe `500`),
    /// never a product refusal.
    SourceMismatch,
    /// The agent is not visible in its active stage to this principal — the anti-enum
    /// `404` an absent agent also gets.
    NotVisible,
    /// Source-bind and visibility both admit, but the audit capability refuses. For the
    /// chat-list face that is exactly "not the owner"; for the per-conversation faces the
    /// SAME arm also folds "conversation absent" and "agent not a party" — the capability
    /// hides all three behind one `403`, so this names the refusal, NOT a single cause.
    AuditDenied,
}

impl AuditFloorVerdict {
    /// Whether every gate admitted, so the sensitive data may be read.
    pub const fn is_allowed(self) -> bool {
        matches!(self, Self::Allow)
    }
}

/// The source-bind then active-stage-visibility prefix shared by both faces. Returns the
/// refusing verdict, or `None` when both admit and the caller should run its own audit
/// capability arm.
fn floor_prefix(
    principal: &Principal,
    agent: &AgentId,
    subject: &AuditSubjectFacts,
) -> Option<AuditFloorVerdict> {
    if subject.source() != agent {
        return Some(AuditFloorVerdict::SourceMismatch);
    }
    if !can_view_agent(
        principal,
        agent,
        Some(subject.visibility()),
        &VisibleStages::active_only(),
    )
    .is_allowed()
    {
        return Some(AuditFloorVerdict::NotVisible);
    }
    None
}

/// The floor for the chat-list face: source-bind, active-stage visibility, then
/// `can_audit_agent_chats`.
pub fn audit_chats_floor(
    principal: &Principal,
    agent: &AgentId,
    subject: &AuditSubjectFacts,
) -> AuditFloorVerdict {
    if let Some(refusal) = floor_prefix(principal, agent, subject) {
        return refusal;
    }
    if can_audit_agent_chats(principal, Some(&subject.audit_subject())).is_allowed() {
        AuditFloorVerdict::Allow
    } else {
        AuditFloorVerdict::AuditDenied
    }
}

/// The floor for the two per-conversation faces: source-bind, active-stage visibility,
/// then `can_audit_agent_conversation` (which itself folds "conversation absent" and
/// "agent not a party" into one owner refusal).
pub fn audit_conversation_floor(
    principal: &Principal,
    agent: &AgentId,
    subject: &AuditSubjectFacts,
    audited: AuditedConversation,
) -> AuditFloorVerdict {
    if let Some(refusal) = floor_prefix(principal, agent, subject) {
        return refusal;
    }
    if can_audit_agent_conversation(principal, Some(&subject.audit_subject()), audited).is_allowed()
    {
        AuditFloorVerdict::Allow
    } else {
        AuditFloorVerdict::AuditDenied
    }
}
