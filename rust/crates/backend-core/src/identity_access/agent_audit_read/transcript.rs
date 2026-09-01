//! The transcript bundle: one conversation's messages in creation order, read on the
//! SAME snapshot as the subject and participation facts that gate them.
//!
//! The window reuses [`SelectedWindowMessage`] — the one authority for a decoded,
//! sealed message projection — so the audit transcript and the authenticated channel
//! window cannot drift on what a message row means. This face is viewer-neutral: it
//! seals every message with EMPTY reactions, so the wire renders `reactions: null`
//! for every row without a per-viewer read.

use crate::{
    foundation::identity::ConversationId,
    identity_access::capability::agent_audit::AuditedConversation,
    messaging::collaboration::conversation_message_window::SelectedWindowMessage,
};

use super::subject::AuditSubjectFacts;

/// The projected window once the owner gate has passed: the selected messages and
/// the two boundary flags. `mode=all` — mainline and thread replies interleave in one
/// keyset — and no reply summaries, previews or stream head, because the audit
/// envelope carries none of those.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AuditTranscriptWindow {
    messages: Vec<SelectedWindowMessage>,
    has_more_before: bool,
    has_more_after: bool,
}

impl AuditTranscriptWindow {
    pub fn projected(
        messages: Vec<SelectedWindowMessage>,
        has_more_before: bool,
        has_more_after: bool,
    ) -> Self {
        Self {
            messages,
            has_more_before,
            has_more_after,
        }
    }

    pub fn messages(&self) -> &[SelectedWindowMessage] {
        &self.messages
    }

    pub const fn has_more_before(&self) -> bool {
        self.has_more_before
    }

    pub const fn has_more_after(&self) -> bool {
        self.has_more_after
    }
}

/// The transcript read, sealed to the subject and the conversation row it resolved.
///
/// The gate is decided on [`subject`](Self::subject) and [`audited`](Self::audited) —
/// both read on this read's snapshot — INSIDE the read's transaction, and
/// [`window`](Self::window) is read only when it allows, so a denied caller reaches no
/// message row. The route re-runs `can_audit_agent_conversation` on the same facts to
/// MAP the verdict to the wire: one 403 that never distinguishes "conversation absent"
/// from "agent not a party", so a guessed conversation id is not an existence oracle.
///
/// [`conversation`](Self::conversation) is the DECODED `conversations.id` of the row the
/// facts were read from — `Some` iff that row exists — never the request echo, so the
/// route's source-bind guard witnesses a real stored coordinate. It is `None` exactly
/// when the conversation is absent (in which case the gate denies before it is read).
///
/// [`window`](Self::window) is `None` either because the gate denied (the window was
/// never read) or because an `around_message_id` anchor is not in the conversation. The
/// route disambiguates by mapping the verdict FIRST: a denied gate is a 403/404 that
/// never inspects the window, and only an allowed gate reads the window's `None` as the
/// post-gate 404 `message_not_found`.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AuditTranscriptBundle {
    subject: AuditSubjectFacts,
    conversation: Option<ConversationId>,
    audited: AuditedConversation,
    window: Option<AuditTranscriptWindow>,
}

impl AuditTranscriptBundle {
    pub fn from_source(
        subject: AuditSubjectFacts,
        conversation: Option<ConversationId>,
        audited: AuditedConversation,
        window: Option<AuditTranscriptWindow>,
    ) -> Self {
        Self {
            subject,
            conversation,
            audited,
            window,
        }
    }

    pub fn subject(&self) -> &AuditSubjectFacts {
        &self.subject
    }

    /// The decoded conversation id this bundle describes, or `None` when the
    /// conversation row is absent. When present, the route binds it to the requested id
    /// before it renders anything.
    pub fn conversation(&self) -> Option<&ConversationId> {
        self.conversation.as_ref()
    }

    /// The existence/participation facts the owner gate is re-decided against.
    pub const fn audited(&self) -> AuditedConversation {
        self.audited
    }

    /// The projected window, or `None` for a gate that denied (unread) or an anchor
    /// that is not in the conversation.
    pub fn window(&self) -> Option<&AuditTranscriptWindow> {
        self.window.as_ref()
    }
}
