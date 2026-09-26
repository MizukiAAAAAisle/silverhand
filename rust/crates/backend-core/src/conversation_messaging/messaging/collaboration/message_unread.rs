//! Viewer-scoped roll-up unread facts for the three legacy message-unread reads.
//!
//! This is deliberately not the per-stream unread capability.  It represents the
//! product roll-up: mainline unread plus followed-thread unread, excluding archived
//! conversations.  Counts, latest pointers and totals leave the read model as one
//! sealed fact so adapters cannot publish mutually contradictory maps.

use std::{error::Error, future::Future};

use crate::{
    conversation_messaging::messaging::{MessageId, MessageSeq, ThreadRootId},
    foundation::identity::{ConversationId, UserId, WorkspaceId},
};

#[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd)]
pub struct UnreadCount(i64);

impl UnreadCount {
    pub fn new(value: i64) -> Result<Self, InvalidUnreadCount> {
        if value < 0 {
            return Err(InvalidUnreadCount);
        }
        Ok(Self(value))
    }

    pub const fn get(self) -> i64 {
        self.0
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, thiserror::Error)]
#[error("stored unread count is negative")]
pub struct InvalidUnreadCount;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LatestUnreadPointer {
    conversation: ConversationId,
    message: MessageId,
    seq: MessageSeq,
    thread_root: Option<ThreadRootId>,
}

impl LatestUnreadPointer {
    pub fn projected(
        conversation: ConversationId,
        message: MessageId,
        seq: MessageSeq,
        thread_root: Option<ThreadRootId>,
    ) -> Self {
        Self {
            conversation,
            message,
            seq,
            thread_root,
        }
    }

    pub fn conversation(&self) -> &ConversationId {
        &self.conversation
    }

    pub fn message(&self) -> &MessageId {
        &self.message
    }

    pub const fn seq(&self) -> MessageSeq {
        self.seq
    }

    pub fn thread_root(&self) -> Option<&ThreadRootId> {
        self.thread_root.as_ref()
    }
}

/// A roll-up cannot have a latest pointer at zero, or omit one when positive.
/// The unread payload is opaque, so external adapters cannot manufacture either
/// contradiction by directly constructing enum fields.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum UnreadRollup {
    CaughtUp,
    Unread(NonEmptyUnreadRollup),
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct NonEmptyUnreadRollup {
    count: UnreadCount,
    latest: LatestUnreadPointer,
}

impl UnreadRollup {
    pub fn projected(
        count: UnreadCount,
        latest: Option<LatestUnreadPointer>,
    ) -> Result<Self, InconsistentUnreadRollup> {
        match (count.get(), latest) {
            (0, None) => Ok(Self::CaughtUp),
            (0, Some(_)) | (_, None) => Err(InconsistentUnreadRollup),
            (_, Some(latest)) => Ok(Self::Unread(NonEmptyUnreadRollup { count, latest })),
        }
    }

    pub const fn count(&self) -> i64 {
        match self {
            Self::CaughtUp => 0,
            Self::Unread(value) => value.count.get(),
        }
    }

    pub const fn latest(&self) -> Option<&LatestUnreadPointer> {
        match self {
            Self::CaughtUp => None,
            Self::Unread(value) => Some(&value.latest),
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, thiserror::Error)]
#[error("unread count and latest pointer disagree")]
pub struct InconsistentUnreadRollup;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ConversationMessageUnread {
    conversation: ConversationId,
    unread: UnreadRollup,
}

impl ConversationMessageUnread {
    pub fn projected(
        conversation: ConversationId,
        unread: UnreadRollup,
    ) -> Result<Self, MessageUnreadIdentityMismatch> {
        if unread
            .latest()
            .is_some_and(|latest| latest.conversation() != &conversation)
        {
            return Err(MessageUnreadIdentityMismatch);
        }
        Ok(Self {
            conversation,
            unread,
        })
    }

    pub fn bind(
        self,
        requested: &ConversationId,
    ) -> Result<BoundConversationMessageUnread, MessageUnreadIdentityMismatch> {
        if &self.conversation != requested {
            return Err(MessageUnreadIdentityMismatch);
        }
        Ok(BoundConversationMessageUnread(self))
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct BoundConversationMessageUnread(ConversationMessageUnread);

impl BoundConversationMessageUnread {
    pub fn conversation(&self) -> &ConversationId {
        &self.0.conversation
    }

    pub const fn unread(&self) -> &UnreadRollup {
        &self.0.unread
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct WorkspaceConversationUnread {
    workspace: WorkspaceId,
    conversation: ConversationId,
    unread: NonEmptyUnreadRollup,
}

impl WorkspaceConversationUnread {
    pub fn projected(
        workspace: WorkspaceId,
        conversation: ConversationId,
        unread: NonEmptyUnreadRollup,
    ) -> Result<Self, MessageUnreadIdentityMismatch> {
        if unread.latest.conversation() != &conversation {
            return Err(MessageUnreadIdentityMismatch);
        }
        Ok(Self {
            workspace,
            conversation,
            unread,
        })
    }

    pub fn conversation(&self) -> &ConversationId {
        &self.conversation
    }

    pub const fn count(&self) -> i64 {
        self.unread.count.get()
    }

    pub const fn latest(&self) -> &LatestUnreadPointer {
        &self.unread.latest
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct WorkspaceMessageUnread {
    workspace: WorkspaceId,
    rows: Vec<WorkspaceConversationUnread>,
}

impl WorkspaceMessageUnread {
    pub fn projected(
        workspace: WorkspaceId,
        mut rows: Vec<WorkspaceConversationUnread>,
    ) -> Result<Self, InvalidWorkspaceUnreadProjection> {
        rows.sort_by(|left, right| left.conversation.as_str().cmp(right.conversation.as_str()));
        if rows.windows(2).any(|pair| {
            pair[0].conversation == pair[1].conversation
                || pair[0].workspace != workspace
                || pair[1].workspace != workspace
        }) || rows.first().is_some_and(|row| row.workspace != workspace)
        {
            return Err(InvalidWorkspaceUnreadProjection);
        }
        Ok(Self { workspace, rows })
    }

    pub fn bind(
        self,
        requested: &WorkspaceId,
    ) -> Result<BoundWorkspaceMessageUnread, MessageUnreadIdentityMismatch> {
        if &self.workspace != requested || self.rows.iter().any(|row| &row.workspace != requested) {
            return Err(MessageUnreadIdentityMismatch);
        }
        Ok(BoundWorkspaceMessageUnread(self))
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct BoundWorkspaceMessageUnread(WorkspaceMessageUnread);

impl BoundWorkspaceMessageUnread {
    pub fn workspace(&self) -> &WorkspaceId {
        &self.0.workspace
    }

    pub fn rows(&self) -> &[WorkspaceConversationUnread] {
        &self.0.rows
    }

    pub fn total(&self) -> Result<i64, UnreadTotalOverflow> {
        self.0
            .rows
            .iter()
            .try_fold(0_i64, |total, row| total.checked_add(row.count()))
            .ok_or(UnreadTotalOverflow)
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, thiserror::Error)]
#[error("workspace unread projection contains duplicate or foreign coordinates")]
pub struct InvalidWorkspaceUnreadProjection;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct WorkspaceUnreadTotal {
    viewer: UserId,
    workspace: WorkspaceId,
    count: NonZeroUnreadCount,
}

impl WorkspaceUnreadTotal {
    pub fn projected(viewer: UserId, workspace: WorkspaceId, count: NonZeroUnreadCount) -> Self {
        Self {
            viewer,
            workspace,
            count,
        }
    }

    pub fn workspace(&self) -> &WorkspaceId {
        &self.workspace
    }

    pub const fn count(&self) -> i64 {
        self.count.0.get()
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct NonZeroUnreadCount(UnreadCount);

impl NonZeroUnreadCount {
    pub fn new(count: UnreadCount) -> Result<Self, EmptyUnreadCount> {
        if count.get() == 0 {
            return Err(EmptyUnreadCount);
        }
        Ok(Self(count))
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, thiserror::Error)]
#[error("sparse unread map cannot contain a zero count")]
pub struct EmptyUnreadCount;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ViewerMessageUnreadSummary {
    viewer: UserId,
    rows: Vec<WorkspaceUnreadTotal>,
}

impl ViewerMessageUnreadSummary {
    pub fn projected(
        viewer: UserId,
        mut rows: Vec<WorkspaceUnreadTotal>,
    ) -> Result<Self, InvalidViewerUnreadSummary> {
        rows.sort_by(|left, right| left.workspace.as_str().cmp(right.workspace.as_str()));
        if rows.iter().any(|row| row.viewer != viewer)
            || rows
                .windows(2)
                .any(|pair| pair[0].workspace == pair[1].workspace)
        {
            return Err(InvalidViewerUnreadSummary);
        }
        Ok(Self { viewer, rows })
    }

    pub fn bind(
        self,
        requested: &UserId,
    ) -> Result<BoundViewerMessageUnreadSummary, MessageUnreadIdentityMismatch> {
        if &self.viewer != requested || self.rows.iter().any(|row| &row.viewer != requested) {
            return Err(MessageUnreadIdentityMismatch);
        }
        Ok(BoundViewerMessageUnreadSummary(self))
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct BoundViewerMessageUnreadSummary(ViewerMessageUnreadSummary);

impl BoundViewerMessageUnreadSummary {
    pub fn rows(&self) -> &[WorkspaceUnreadTotal] {
        &self.0.rows
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, thiserror::Error)]
#[error("viewer unread summary contains a foreign viewer or duplicate workspace")]
pub struct InvalidViewerUnreadSummary;

#[derive(Clone, Copy, Debug, Eq, PartialEq, thiserror::Error)]
#[error("unread projection identity differs from the requested coordinate")]
pub struct MessageUnreadIdentityMismatch;

#[derive(Clone, Copy, Debug, Eq, PartialEq, thiserror::Error)]
#[error("workspace unread total overflows its persisted integer domain")]
pub struct UnreadTotalOverflow;

#[derive(Clone, Copy, Debug, Eq, PartialEq, thiserror::Error)]
pub enum WorkspaceMessageUnreadRefusal {
    #[error("workspace not found")]
    NotFound,
    #[error("viewer cannot read workspace")]
    Forbidden,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, thiserror::Error)]
pub enum ConversationMessageUnreadRefusal {
    #[error("conversation not found")]
    NotFound,
    #[error("viewer cannot read conversation")]
    Forbidden,
}

pub trait WorkspaceMessageUnreadReadPort {
    type Error: Error + Send + Sync + 'static;

    fn read_workspace(
        &self,
        viewer: &UserId,
        workspace: &WorkspaceId,
    ) -> impl Future<
        Output = Result<Result<WorkspaceMessageUnread, WorkspaceMessageUnreadRefusal>, Self::Error>,
    > + Send;
}

pub trait ViewerMessageUnreadSummaryReadPort {
    type Error: Error + Send + Sync + 'static;

    fn read_summary(
        &self,
        viewer: &UserId,
    ) -> impl Future<Output = Result<ViewerMessageUnreadSummary, Self::Error>> + Send;
}

pub trait ConversationMessageUnreadReadPort {
    type Error: Error + Send + Sync + 'static;

    fn read_conversation(
        &self,
        viewer: &UserId,
        conversation: &ConversationId,
    ) -> impl Future<
        Output = Result<
            Result<ConversationMessageUnread, ConversationMessageUnreadRefusal>,
            Self::Error,
        >,
    > + Send;
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pointer(conversation: &str) -> LatestUnreadPointer {
        LatestUnreadPointer::projected(
            ConversationId::parse(conversation).unwrap(),
            MessageId::parse("m").unwrap(),
            MessageSeq::try_from(1).unwrap(),
            None,
        )
    }

    #[test]
    fn rollup_seals_count_pointer_and_identity() {
        let zero = UnreadCount::new(0).unwrap();
        assert!(UnreadRollup::projected(zero, Some(pointer("c"))).is_err());
        assert!(UnreadRollup::projected(UnreadCount::new(1).unwrap(), None).is_err());
        let unread =
            UnreadRollup::projected(UnreadCount::new(1).unwrap(), Some(pointer("other"))).unwrap();
        assert!(
            ConversationMessageUnread::projected(ConversationId::parse("c").unwrap(), unread)
                .is_err()
        );
    }

    #[test]
    fn workspace_and_summary_are_sparse_sorted_closed_sets() {
        let workspace = WorkspaceId::parse("w").unwrap();
        let row = |conversation: &str| {
            let unread = match UnreadRollup::projected(
                UnreadCount::new(1).unwrap(),
                Some(pointer(conversation)),
            )
            .unwrap()
            {
                UnreadRollup::Unread(value) => value,
                UnreadRollup::CaughtUp => unreachable!(),
            };
            WorkspaceConversationUnread::projected(
                workspace.clone(),
                ConversationId::parse(conversation).unwrap(),
                unread,
            )
            .unwrap()
        };
        assert!(
            WorkspaceMessageUnread::projected(workspace.clone(), vec![row("c"), row("c")],)
                .is_err()
        );
        let bound = WorkspaceMessageUnread::projected(workspace.clone(), vec![row("z"), row("a")])
            .unwrap()
            .bind(&workspace)
            .unwrap();
        assert_eq!(
            bound
                .rows()
                .iter()
                .map(|row| row.conversation().as_str())
                .collect::<Vec<_>>(),
            ["a", "z"]
        );
        assert_eq!(bound.total().unwrap(), 2);

        let count = NonZeroUnreadCount::new(UnreadCount::new(1).unwrap()).unwrap();
        let viewer = UserId::parse("viewer").unwrap();
        assert!(
            ViewerMessageUnreadSummary::projected(
                viewer.clone(),
                vec![
                    WorkspaceUnreadTotal::projected(viewer.clone(), workspace.clone(), count,),
                    WorkspaceUnreadTotal::projected(viewer.clone(), workspace, count),
                ],
            )
            .is_err()
        );
        assert!(
            ViewerMessageUnreadSummary::projected(
                viewer,
                vec![WorkspaceUnreadTotal::projected(
                    UserId::parse("other").unwrap(),
                    WorkspaceId::parse("other-workspace").unwrap(),
                    count,
                )],
            )
            .is_err()
        );
    }
}
