//! The owner/visibility facts every audit face is decided against, read back off
//! the ONE `agents.id` the adapter actually loaded.
//!
//! This is the audit analogue of [`crate::agent_detail_read`]'s creator-splice
//! guard. There is a single decoded `creator`, and [`AuditSubjectFacts::from_source`]
//! is the sole constructor: it seeds the visibility ACL creator arm from that id
//! AND is the sole origin of the [`AgentAuditSubject`] the owner gate reads, so the
//! human `can_view_agent` admits and the human `can_audit_agent_chats` treats as the
//! creator are the same value by construction — an adapter cannot admit one human
//! and authorize another.

use crate::{
    agent_lifecycle::MaterializationStatus,
    capability::{
        agent_audit::AgentAuditSubject,
        agent_view::{AgentViewerArms, AgentVisibility},
    },
    identity::{AgentId, UserId},
};

/// The stored subject facts one audit request is gated with.
///
/// Sealed to ONE decoded `source` (the `agents.id` read back, never the request
/// echo) and ONE decoded `creator`. The route binds [`source`](Self::source) to the
/// requested id BEFORE it consults either gate, and both gates read the same
/// `creator`, so a bundle resolved for another agent — or one that authorizes a
/// human other than the row's creator — cannot be built.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AuditSubjectFacts {
    source: AgentId,
    creator: UserId,
    visibility: AgentVisibility,
}

impl AuditSubjectFacts {
    /// Build the subject facts from the ONE source id the row was read back with and
    /// the ONE decoded `creator`. This is the only place the viewer arms are built:
    /// the creator arm is seeded from `creator`, and [`audit_subject`](Self::audit_subject)
    /// reports the same id, so the visibility gate and the owner gate never disagree
    /// about who the creator is.
    pub fn from_source(
        source: AgentId,
        creator: UserId,
        direct_pair_human_endpoints: impl IntoIterator<Item = UserId>,
        shared_workspace_members: impl IntoIterator<Item = UserId>,
        materialization_status: MaterializationStatus,
    ) -> Self {
        let visibility = AgentVisibility {
            viewers: AgentViewerArms::new(
                Some(creator.clone()),
                direct_pair_human_endpoints,
                shared_workspace_members,
            ),
            materialization_status,
        };
        Self {
            source,
            creator,
            visibility,
        }
    }

    /// The decoded `agents.id` this bundle describes — the coordinate the route binds
    /// to the requested id before it consults any gate.
    pub fn source(&self) -> &AgentId {
        &self.source
    }

    /// The visibility ACL the anti-enum `can_view_agent` floor is decided against.
    pub fn visibility(&self) -> &AgentVisibility {
        &self.visibility
    }

    /// The owner-gate view of this subject. Built from the same `creator` the
    /// visibility arm was seeded with, so the two gates agree by construction.
    pub fn audit_subject(&self) -> AgentAuditSubject {
        AgentAuditSubject {
            created_by_user_id: Some(self.creator.clone()),
        }
    }
}
