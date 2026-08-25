//! Viewer-scoped per-stream unread projection for one conversation.
//!
//! The sparse thread collection and the header-dot boolean are different
//! products: the former is follow-agnostic, while the latter is specifically
//! followed-thread unread.  Keeping them as separate facts prevents a client or
//! adapter from deriving one from the other.

use std::{error::Error, future::Future};

use crate::{
    identity::{ConversationId, UserId},
    messaging::{MessageId, MessageSeq, ThreadRootId},
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

/// A single stream's unread fact.  The non-zero variant carries an opaque
/// payload, so external ports cannot bypass the factory and fabricate
/// `count == 0` with non-null first-unread coordinates.
///
/// ```compile_fail
/// use silverhand_backend_core::messaging::collaboration::conversation_unread::{
///     StreamUnread, UnreadCount,
/// };
/// use silverhand_backend_core::messaging::{MessageId, MessageSeq};
///
/// let mut payload = match StreamUnread::unread(
///     UnreadCount::new(1).unwrap(),
///     MessageId::parse("m").unwrap(),
///     MessageSeq::try_from(1).unwrap(),
/// ).unwrap() {
///     StreamUnread::Unread(payload) => payload,
///     StreamUnread::CaughtUp => unreachable!(),
/// };
/// payload.count = UnreadCount::new(0).unwrap();
/// ```
///
/// The supported construction path remains public:
///
/// ```
/// use silverhand_backend_core::messaging::collaboration::conversation_unread::{
///     StreamUnread, UnreadCount,
/// };
/// use silverhand_backend_core::messaging::{MessageId, MessageSeq};
///
/// let unread = StreamUnread::unread(
///     UnreadCount::new(1).unwrap(),
///     MessageId::parse("m").unwrap(),
///     MessageSeq::try_from(1).unwrap(),
/// ).unwrap();
/// assert_eq!(unread.count(), 1);
/// ```
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum StreamUnread {
    CaughtUp,
    Unread(NonEmptyStreamUnread),
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct NonEmptyStreamUnread {
    count: UnreadCount,
    first_message: MessageId,
    first_seq: MessageSeq,
}

impl StreamUnread {
    pub const fn caught_up() -> Self {
        Self::CaughtUp
    }

    pub fn unread(
        count: UnreadCount,
        first_message: MessageId,
        first_seq: MessageSeq,
    ) -> Result<Self, EmptyUnreadStream> {
        if count.get() == 0 {
            return Err(EmptyUnreadStream);
        }
        Ok(Self::Unread(NonEmptyStreamUnread {
            count,
            first_message,
            first_seq,
        }))
    }

    pub const fn count(&self) -> i64 {
        match self {
            Self::CaughtUp => 0,
            Self::Unread(value) => value.count.get(),
        }
    }

    pub fn first_message(&self) -> Option<&MessageId> {
        match self {
            Self::CaughtUp => None,
            Self::Unread(value) => Some(&value.first_message),
        }
    }

    pub const fn first_seq(&self) -> Option<MessageSeq> {
        match self {
            Self::CaughtUp => None,
            Self::Unread(value) => Some(value.first_seq),
        }
    }

    const fn is_caught_up(&self) -> bool {
        matches!(self, Self::CaughtUp)
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, thiserror::Error)]
#[error("a non-zero unread stream must contain at least one unread message")]
pub struct EmptyUnreadStream;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ThreadUnread {
    root: ThreadRootId,
    unread: StreamUnread,
}

impl ThreadUnread {
    pub fn projected(root: ThreadRootId, unread: StreamUnread) -> Result<Self, EmptyThreadUnread> {
        if unread.is_caught_up() {
            return Err(EmptyThreadUnread);
        }
        Ok(Self { root, unread })
    }

    pub fn root(&self) -> &ThreadRootId {
        &self.root
    }

    pub const fn unread(&self) -> &StreamUnread {
        &self.unread
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, thiserror::Error)]
#[error("the sparse thread-unread projection cannot contain a caught-up stream")]
pub struct EmptyThreadUnread;

/// Raw projection returned by the read port.  It carries the coordinate that
/// selected it so the consumer can detect an A-request/B-fact splice.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ConversationUnread {
    conversation: ConversationId,
    mainline: StreamUnread,
    threads: Vec<ThreadUnread>,
    followed_thread_unread: bool,
}

impl ConversationUnread {
    pub fn projected(
        conversation: ConversationId,
        mainline: StreamUnread,
        mut threads: Vec<ThreadUnread>,
        followed_thread_unread: bool,
    ) -> Result<Self, DuplicateThreadUnread> {
        threads.sort_by(|a, b| a.root.as_str().cmp(b.root.as_str()));
        if threads.windows(2).any(|pair| pair[0].root == pair[1].root) {
            return Err(DuplicateThreadUnread);
        }
        Ok(Self {
            conversation,
            mainline,
            threads,
            followed_thread_unread,
        })
    }

    pub fn bind(
        self,
        requested: &ConversationId,
    ) -> Result<BoundConversationUnread, ConversationUnreadIdentityMismatch> {
        if &self.conversation != requested {
            return Err(ConversationUnreadIdentityMismatch);
        }
        Ok(BoundConversationUnread(self))
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct BoundConversationUnread(ConversationUnread);

impl BoundConversationUnread {
    pub const fn mainline(&self) -> &StreamUnread {
        &self.0.mainline
    }

    pub fn threads(&self) -> &[ThreadUnread] {
        &self.0.threads
    }

    pub const fn followed_thread_unread(&self) -> bool {
        self.0.followed_thread_unread
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, thiserror::Error)]
#[error("thread-unread projection contains the same root more than once")]
pub struct DuplicateThreadUnread;

#[derive(Clone, Copy, Debug, Eq, PartialEq, thiserror::Error)]
#[error("conversation-unread projection identity differs from the requested conversation")]
pub struct ConversationUnreadIdentityMismatch;

#[derive(Clone, Copy, Debug, Eq, PartialEq, thiserror::Error)]
pub enum ConversationUnreadRefusal {
    #[error("conversation not found")]
    NotFound,
    #[error("viewer cannot read conversation")]
    Forbidden,
}

pub trait ConversationUnreadReadPort {
    type Error: Error + Send + Sync + 'static;

    fn read(
        &self,
        viewer: &UserId,
        conversation: &ConversationId,
    ) -> impl Future<
        Output = Result<Result<ConversationUnread, ConversationUnreadRefusal>, Self::Error>,
    > + Send;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stream_and_sparse_thread_algebras_reject_impossible_shapes() {
        let zero = UnreadCount::new(0).unwrap();
        assert!(
            StreamUnread::unread(
                zero,
                MessageId::parse("m").unwrap(),
                MessageSeq::try_from(1).unwrap(),
            )
            .is_err()
        );
        assert!(
            ThreadUnread::projected(
                ThreadRootId::parse("root").unwrap(),
                StreamUnread::caught_up(),
            )
            .is_err()
        );
    }

    #[test]
    fn projection_sorts_roots_rejects_duplicates_and_binds_identity() {
        let stream = |root: &str| {
            ThreadUnread::projected(
                ThreadRootId::parse(root).unwrap(),
                StreamUnread::unread(
                    UnreadCount::new(1).unwrap(),
                    MessageId::parse(format!("m-{root}")).unwrap(),
                    MessageSeq::try_from(1).unwrap(),
                )
                .unwrap(),
            )
            .unwrap()
        };
        let value = ConversationUnread::projected(
            ConversationId::parse("c").unwrap(),
            StreamUnread::caught_up(),
            vec![stream("z"), stream("a")],
            true,
        )
        .unwrap();
        let bound = value
            .clone()
            .bind(&ConversationId::parse("c").unwrap())
            .unwrap();
        assert_eq!(bound.threads()[0].root().as_str(), "a");
        assert!(
            value
                .bind(&ConversationId::parse("other").unwrap())
                .is_err()
        );
        assert!(
            ConversationUnread::projected(
                ConversationId::parse("c").unwrap(),
                StreamUnread::caught_up(),
                vec![stream("a"), stream("a")],
                false,
            )
            .is_err()
        );
    }
}
