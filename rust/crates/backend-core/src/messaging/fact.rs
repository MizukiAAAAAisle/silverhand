//! The single business fact of one committed send, and the views that read it.
//!
//! Both the acknowledgement and the published event project from the value here,
//! which is why they cannot disagree. The two typed views are what make "announce a
//! reply as if it were a main-line send" something nobody can write: each path has
//! its own type, and the only source of either is the fact itself.

use super::{
    AgentId, ConversationId, MessageContent, MessageId, MessageSeq, ThreadRootId, UserId,
    attachments, mention_cc, post_commit,
};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum FromKind {
    User,
    Agent,
    System,
}

/// Why a principal follows a reply cluster. Recorded because the reason outlives
/// the event: a follower added by a mention is not the same fact as one who
/// replied.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ThreadFollowerSource {
    Reply,
    TargetAuthor,
    Mention,
}

/// The single business fact of one committed send. Both the acknowledgement and
/// the published event are projections of this value, which is why they cannot
/// disagree.
///
/// `pub(super)` on the fields, not `pub`: when this type was declared in `messaging`
/// itself its private fields were already readable by every module in that subtree,
/// so this is the visibility it always had rather than a widening of it. What stays
/// out of reach is anything outside the crate, which is what the `compile_fail`
/// proofs on [`MessageCreatedFact::main_line`] depend on.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MessageCreatedFact {
    pub(super) message: CreatedMessage,
    pub(super) thread: Option<ThreadReplyFact>,
    pub(super) post_commit: post_commit::PostCommitPlan,
    pub(super) freshness_bypassed: bool,
    pub(super) mention_copies: Vec<mention_cc::MentionCopyOutcome>,
}

impl MessageCreatedFact {
    /// Assembled by the unit of work that committed the send.
    ///
    /// A trust seam, stated rather than pretended away: this factory is public, so
    /// every crate that can call it is inside the same trusted boundary — a fact can
    /// be fabricated by anyone with that reach. What is ruled out is different and
    /// narrower: a fact that has been returned cannot be replaced or modified, because
    /// every field is read-only from here on.
    pub fn committed(
        message: CreatedMessage,
        thread: Option<ThreadReplyFact>,
        post_commit: post_commit::PostCommitPlan,
        freshness_bypassed: bool,
        mention_copies: Vec<mention_cc::MentionCopyOutcome>,
    ) -> Self {
        Self {
            message,
            thread,
            post_commit,
            freshness_bypassed,
            mention_copies,
        }
    }

    pub fn message(&self) -> &CreatedMessage {
        &self.message
    }

    /// Present only for a reply.
    pub fn thread(&self) -> Option<&ThreadReplyFact> {
        self.thread.as_ref()
    }

    /// The guard was skipped at the sender's request. Carried for the post-commit
    /// record, not for the reply to the caller.
    pub fn freshness_bypassed(&self) -> bool {
        self.freshness_bypassed
    }

    /// What became of each agent this message addressed that could not read it.
    /// Empty when the send addressed nobody outside its own conversation.
    pub fn mention_copies(&self) -> &[mention_cc::MentionCopyOutcome] {
        &self.mention_copies
    }
}

/// The author as the message will always report them, even after the principal is
/// gone. A snapshot, deliberately not a reference.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MessageAuthor {
    pub id: String,
    pub name: String,
    pub display_name: Option<String>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CreatedMessage {
    pub id: MessageId,
    pub conversation_id: ConversationId,
    pub from_kind: FromKind,
    pub from_agent_id: Option<AgentId>,
    pub from_user_id: Option<UserId>,
    pub author: Option<MessageAuthor>,
    pub content: MessageContent,
    pub attachments: Vec<attachments::AttachmentSnapshot>,
    pub seq: MessageSeq,
    pub created_at_ms: i64,
    pub thread_root_id: Option<ThreadRootId>,
}

/// What a reply changed about its cluster: the absolute count of what participants
/// said there, computed inside the atomic unit so it already includes this reply.
///
/// Private fields with a public [`committed`](ThreadReplyFact::committed) seam and
/// read-only accessors: the unit of work that computed the projection inside the
/// atomic unit is the only thing that assembles one, and nothing downstream can
/// fabricate or mutate it. The cluster's list entry is a second projection of this
/// same fact; it is not modelled here yet, pending the shared author contract it
/// depends on.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ThreadReplyFact {
    thread_root_id: ThreadRootId,
    reply_count: i64,
}

impl ThreadReplyFact {
    /// Assembled by the unit of work that committed the reply, from the facts it
    /// read inside the same atomic unit.
    ///
    /// A caller outside this crate cannot assemble one field by field:
    ///
    /// ```compile_fail
    /// use silverhand_backend_core::messaging::ThreadReplyFact;
    ///
    /// let fact = ThreadReplyFact {
    ///     thread_root_id: todo!(),
    ///     reply_count: 1,
    /// };
    /// ```
    ///
    /// nor mutate one that already exists:
    ///
    /// ```compile_fail
    /// use silverhand_backend_core::messaging::ThreadReplyFact;
    ///
    /// fn tamper(fact: &mut ThreadReplyFact) {
    ///     fact.reply_count = 0;
    /// }
    /// ```
    pub fn committed(thread_root_id: ThreadRootId, reply_count: i64) -> Self {
        Self {
            thread_root_id,
            reply_count,
        }
    }

    pub fn thread_root_id(&self) -> &ThreadRootId {
        &self.thread_root_id
    }

    pub fn reply_count(&self) -> i64 {
        self.reply_count
    }
}

/// The published payload of one committed send: the message itself, and — only for
/// a reply — the cluster projections that ride the same frame.
///
/// Path-neutral by construction. A main-line send carries no projections, a reply
/// carries its own, and both can obtain a view only from the fact ([`MainCommittedSend::published`]
/// / [`ReplyCommittedSend::published`]): the fields are private and there is no
/// public constructor, so nobody outside can fabricate one or fake a main-line send
/// that carries reply projections. The acknowledgement projects from this same
/// value, which is why the published frame and the ACK cannot disagree.
#[derive(Clone, Copy, Debug)]
pub struct CommittedMessageView<'fact> {
    message: &'fact CreatedMessage,
    reply_projection: Option<&'fact ThreadReplyFact>,
}

impl<'fact> CommittedMessageView<'fact> {
    pub fn message(&self) -> &'fact CreatedMessage {
        self.message
    }

    /// The cluster projections carried on a reply's frame; absent on the main line.
    pub fn reply_projection(&self) -> Option<&'fact ThreadReplyFact> {
        self.reply_projection
    }
}

/// One committed main-line send and the plan that belongs to it.
///
/// A borrowed view, and the only way to hold a main-line plan: its fields are
/// private and it has no constructor, so a caller cannot assemble one, and the only
/// source is [`MessageCreatedFact::main_line`] — which answers `None` for a reply.
/// That is what makes "announce a reply as if it were a main-line send" something
/// nobody can write rather than something a runtime check has to catch.
#[derive(Clone, Copy, Debug)]
pub struct MainCommittedSend<'fact> {
    message: &'fact CreatedMessage,
    mentions: Option<&'fact post_commit::MentionIntent>,
    delivery: &'fact post_commit::MainDeliveryPlan,
}

impl<'fact> MainCommittedSend<'fact> {
    pub fn message(&self) -> &'fact CreatedMessage {
        self.message
    }

    /// What this send said about naming people. Path-independent: a person is named
    /// by the body, not by where the message landed.
    pub fn mentions(&self) -> Option<&'fact post_commit::MentionIntent> {
        self.mentions
    }

    pub fn delivery(&self) -> &'fact post_commit::MainDeliveryPlan {
        self.delivery
    }

    /// The published payload: the message alone — a main-line send carries no
    /// cluster projections.
    pub fn published(&self) -> CommittedMessageView<'fact> {
        CommittedMessageView {
            message: self.message,
            reply_projection: None,
        }
    }
}

/// The same shape for a reply, carrying the cluster's own plan. Distinct from
/// [`MainCommittedSend`] by type, so neither path's announcer accepts the other's.
#[derive(Clone, Copy, Debug)]
pub struct ReplyCommittedSend<'fact> {
    message: &'fact CreatedMessage,
    projection: &'fact ThreadReplyFact,
    mentions: Option<&'fact post_commit::MentionIntent>,
    audience: &'fact post_commit::ReplyAudience,
}

impl<'fact> ReplyCommittedSend<'fact> {
    pub fn message(&self) -> &'fact CreatedMessage {
        self.message
    }

    pub fn projection(&self) -> &'fact ThreadReplyFact {
        self.projection
    }

    /// The same path-independent fact the main line carries: naming someone does not
    /// depend on whether the message was a reply.
    pub fn mentions(&self) -> Option<&'fact post_commit::MentionIntent> {
        self.mentions
    }

    pub fn audience(&self) -> &'fact post_commit::ReplyAudience {
        self.audience
    }

    /// The published payload: the message together with the cluster projections that
    /// ride the same frame.
    pub fn published(&self) -> CommittedMessageView<'fact> {
        CommittedMessageView {
            message: self.message,
            reply_projection: Some(self.projection),
        }
    }
}

impl MessageCreatedFact {
    /// This send as a main-line one, or nothing if it was a reply.
    ///
    /// `None` is a question's answer, not an outcome: there is no announcer that
    /// takes a fact, so a caller holding `None` has nothing to call rather than
    /// something to skip.
    ///
    /// A view cannot be assembled by hand:
    ///
    /// ```compile_fail
    /// use silverhand_backend_core::messaging::MainCommittedSend;
    ///
    /// let view = MainCommittedSend {
    ///     message: todo!(),
    ///     mentions: todo!(),
    ///     delivery: todo!(),
    /// };
    /// ```
    ///
    /// Nor can a fact that already exists be given a different plan:
    ///
    /// ```compile_fail
    /// use silverhand_backend_core::messaging::{MessageCreatedFact, post_commit::PostCommitPlan};
    ///
    /// fn replace(fact: &mut MessageCreatedFact, plan: PostCommitPlan) {
    ///     fact.post_commit = plan;
    /// }
    /// ```
    pub fn main_line(&self) -> Option<MainCommittedSend<'_>> {
        match self.post_commit.delivery() {
            post_commit::DeliveryPlan::MainLine(delivery) => Some(MainCommittedSend {
                message: &self.message,
                mentions: self.post_commit.mentions(),
                delivery,
            }),
            post_commit::DeliveryPlan::ReplyCluster(_) => None,
        }
    }

    /// This send as a reply, or nothing if it was a main-line one.
    pub fn reply_cluster(&self) -> Option<ReplyCommittedSend<'_>> {
        match (self.post_commit.delivery(), &self.thread) {
            (post_commit::DeliveryPlan::ReplyCluster(audience), Some(projection)) => {
                Some(ReplyCommittedSend {
                    message: &self.message,
                    projection,
                    mentions: self.post_commit.mentions(),
                    audience,
                })
            }
            _ => None,
        }
    }
}
