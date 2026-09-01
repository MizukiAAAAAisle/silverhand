//! The read side of unread publication: what a committed send makes true for the
//! people who can see the conversation it landed in.
//!
//! [`UnreadPublication`](super::post_commit::UnreadPublication) is the effect; this is
//! the query it runs first. The split is deliberate. The effect adapter routes frames
//! and MUST NOT re-decide who is owed one or what their state is: placement, audience,
//! and every count are decided HERE, against the committed database, and handed over as
//! typed facts. An adapter that received only a conversation id and computed its own
//! audience would be a second authority on who may see a conversation.
//!
//! Placement is returned as a VALUE, not left as a branch the adapter takes. A workspace
//! send yields the per-viewer unread state to co-emit with each viewer's badge; a direct
//! line yields the human endpoints whose line list is now stale — the distinct
//! invalidation axis a DM takes. There is no third shape, so the adapter's match is
//! total and cannot silently drop a placement.

use std::future::Future;

use crate::{
    conversation_messaging::messaging::identity::{MessageId, ThreadRootId},
    foundation::identity::{ConversationId, UserId, WorkspaceId},
    foundation::persistence::PersistenceFailure,
};

/// Everything the unread publisher needs about one committed send, already decided.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum UnreadAudience {
    /// A conversation that lives in a workspace: each viewer's unread state and tiered
    /// badge, to be co-emitted together.
    Workspace {
        workspace: WorkspaceId,
        viewers: Vec<ViewerUnread>,
    },
    /// A direct line, which has no workspace unread surface. The human endpoints whose
    /// direct-line list must be re-fetched.
    DirectPair { viewers: Vec<UserId> },
}

/// One viewer's unread state after the send, and their workspace badge — the two halves
/// of the co-emit. The badge is the WORKSPACE tier for this viewer, carried beside the
/// conversation-level unread because the two move together and a client cannot reconcile
/// one without the other.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ViewerUnread {
    pub viewer: UserId,
    pub conversation_unread_count: i64,
    pub workspace_unread_count: i64,
    pub latest_unread: Option<LatestUnread>,
    pub badge_count: i64,
}

/// The single most-recent unread message for a viewer: enough to jump to it, no body.
/// `None` when nothing is unread — never a stale anchor.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LatestUnread {
    pub conversation: ConversationId,
    pub message: MessageId,
    pub seq: i64,
    pub thread_root: Option<ThreadRootId>,
}

/// Computes, against the committed database, who is owed an unread update for a
/// conversation and what their state now is. A read-only port: it decides nothing about
/// the send, only reports what the send made true.
///
/// `None` means there is nothing to publish — the conversation is gone, the one state
/// the oracle guards with an early return. A conversation that exists but has no live
/// viewers is a present audience with an empty viewer list, not `None`: the difference
/// is "no conversation" versus "no one to tell", and only the first skips the publish.
pub trait UnreadReadModel {
    fn unread_audience(
        &self,
        conversation: &ConversationId,
    ) -> impl Future<Output = Result<Option<UnreadAudience>, PersistenceFailure>> + Send;
}
