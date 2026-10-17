use super::Notification;
use crate::{
    conversation_messaging::messaging::{MessageAuthor, MessageId, ThreadRootId},
    foundation::identity::{ConversationId, UserId, WorkspaceId},
};
use std::{error::Error, future::Future};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct NotificationListQuery {
    pub unread_only: bool,
    pub limit: u16,
}

/// One list row: the stored notification plus its anchor message's author, resolved
/// live at read time. `None` when the kind has no anchor author or the anchor
/// message no longer exists.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ListedNotification {
    pub notification: Notification,
    pub sender: Option<MessageAuthor>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct UnreadAnchor {
    pub conversation: ConversationId,
    pub message: MessageId,
    pub thread_root: Option<ThreadRootId>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct NotificationSummary {
    pub total: u64,
    pub by_workspace: Vec<(WorkspaceId, u64)>,
    pub latest_by_workspace: Vec<(WorkspaceId, UnreadAnchor)>,
}

pub trait NotificationReadPort {
    type Error: Error + Send + Sync + 'static;
    fn list(
        &self,
        viewer: &UserId,
        query: NotificationListQuery,
    ) -> impl Future<Output = Result<Vec<ListedNotification>, Self::Error>> + Send;
    /// All three projections are read from one consistent snapshot.
    fn unread_summary(
        &self,
        viewer: &UserId,
    ) -> impl Future<Output = Result<NotificationSummary, Self::Error>> + Send;
}
