//! Per-conversation latest human/agent message summary, for list surfaces that show
//! "who said what last". System messages never count.

use std::{error::Error, future::Future};

use crate::{
    conversation_messaging::messaging::{
        CreatedMessage, FromKind, MessageAuthor, MessageId, MessageSeq, ThreadRootId,
        collaboration::activity::ActivityPreview,
    },
    foundation::identity::{ConversationId, UserId},
};

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ConversationLatest {
    pub conversation: ConversationId,
    pub message: MessageId,
    pub seq: MessageSeq,
    pub created_at_ms: i64,
    pub thread_root: Option<ThreadRootId>,
    pub sender: MessageAuthor,
    pub preview: Option<ActivityPreview>,
    pub attachment_count: usize,
}

impl ConversationLatest {
    /// The summary a committed send produces, or `None` when it cannot be the latest.
    pub fn from_created(message: &CreatedMessage) -> Option<Self> {
        if message.from_kind == FromKind::System {
            return None;
        }
        Some(Self {
            conversation: message.conversation_id.clone(),
            message: message.id.clone(),
            seq: message.seq,
            created_at_ms: message.created_at_ms,
            thread_root: message.thread_root_id.clone(),
            sender: message.author.clone()?,
            preview: ActivityPreview::from_source(Some(message.content.as_str())),
            attachment_count: message.attachments.len(),
        })
    }
}

/// Every conversation the viewer participates in that has a latest message.
pub trait ConversationLatestReadPort {
    type Error: Error + Send + Sync + 'static;

    fn list_latest(
        &self,
        viewer: &UserId,
    ) -> impl Future<Output = Result<Vec<ConversationLatest>, Self::Error>> + Send;
}
