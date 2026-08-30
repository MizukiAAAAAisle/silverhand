//! The attachment bundle: at most one stored attachment row, bound to the ONE
//! conversation the request named, read on the SAME snapshot as the subject and
//! participation facts that gate it.
//!
//! The row reuses [`AttachmentRecord`] — the same sealed row the membership-gated
//! download projects — but this face NEVER reuses that face's admission: the record
//! is bound here by `channel == conversation`, and the blob is read only after the
//! owner gate allows.
//!
//! [`attachment`](AuditAttachmentBundle::attachment) is `None` when no row has that
//! id in that conversation. "Row absent" and "row in another conversation" are one
//! answer, so a guessed attachment id is not an existence oracle. That `None` is
//! consulted only after the gate allows, and maps to a post-gate 404 with the blob
//! store never touched.

use crate::{
    capability::agent_audit::AuditedConversation, identity::ConversationId,
    messaging::collaboration::attachment::AttachmentRecord,
};

use super::subject::AuditSubjectFacts;

/// The attachment read, sealed to the subject and the conversation row it resolved.
///
/// The gate is decided on [`subject`](Self::subject) and [`audited`](Self::audited)
/// INSIDE the read's transaction, and the attachment row is loaded only when it allows,
/// so a denied caller reaches neither the row coordinate nor the blob store.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AuditAttachmentBundle {
    subject: AuditSubjectFacts,
    conversation: Option<ConversationId>,
    audited: AuditedConversation,
    attachment: Option<AttachmentRecord>,
}

impl AuditAttachmentBundle {
    pub fn from_source(
        subject: AuditSubjectFacts,
        conversation: Option<ConversationId>,
        audited: AuditedConversation,
        attachment: Option<AttachmentRecord>,
    ) -> Self {
        Self {
            subject,
            conversation,
            audited,
            attachment,
        }
    }

    pub fn subject(&self) -> &AuditSubjectFacts {
        &self.subject
    }

    /// The decoded conversation id this bundle describes, or `None` when the
    /// conversation row is absent — never the request echo.
    pub fn conversation(&self) -> Option<&ConversationId> {
        self.conversation.as_ref()
    }

    /// The existence/participation facts the owner gate is re-decided against.
    pub const fn audited(&self) -> AuditedConversation {
        self.audited
    }

    /// The stored row bound to this conversation, or `None` when there is no such row
    /// (absent, or belonging to another conversation).
    pub fn attachment(&self) -> Option<&AttachmentRecord> {
        self.attachment.as_ref()
    }
}
