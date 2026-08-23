//! The single business fact of one committed send, and the views that read it.
//!
//! Both the acknowledgement and the published event project from the value here,
//! which is why they cannot disagree. The two typed views are what make "announce a
//! reply as if it were a main-line send" something nobody can write: each path has
//! its own type, and the only source of either is the fact itself.

use super::{
    AgentId, ConversationId, MessageAuthor, MessageContent, MessageId, MessageSeq, ThreadRootId,
    UserId, attachments, mention_cc, post_commit,
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

/// What a reply changed about its cluster, projected inside the atomic unit that
/// committed it: the cluster's list entry, computed from the rows this reply just
/// wrote so it already includes itself.
///
/// This is the one committed reply projection, and it carries [`ThreadListEntry`] by
/// value rather than pointing at a query to run later. The publication frame and the
/// acknowledgement both borrow this same value (see [`CommittedMessageView`]), and a
/// cold read-side projection re-derives an equal entry from the same authoritative
/// rows — but none of them re-reads to build *this* reply's frame, so a later rename,
/// a newer reply, or a read failure cannot change or withhold what was published.
///
/// Private fields with a public [`committed`](ThreadReplyFact::committed) seam and
/// read-only accessors: the unit of work that computed the projection inside the
/// atomic unit is the only thing that assembles one, and nothing downstream can
/// fabricate or mutate it. `reply_count` is not stored twice — it is read straight off
/// the carried entry, so the ACK's count and the placed entry's count are one value.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ThreadReplyFact {
    thread_root_id: ThreadRootId,
    list_entry: ThreadListEntry,
}

impl ThreadReplyFact {
    /// Assembled by the unit of work that committed the reply, from the facts it
    /// read inside the same atomic unit — including the [`ThreadListEntry`] it
    /// projected there, so the entry the frame carries is the committed one.
    ///
    /// A caller outside this crate cannot assemble one field by field:
    ///
    /// ```compile_fail
    /// use silverhand_backend_core::messaging::ThreadReplyFact;
    ///
    /// let fact = ThreadReplyFact {
    ///     thread_root_id: todo!(),
    ///     list_entry: todo!(),
    /// };
    /// ```
    ///
    /// nor mutate one that already exists:
    ///
    /// ```compile_fail
    /// use silverhand_backend_core::messaging::ThreadReplyFact;
    ///
    /// fn tamper(fact: &mut ThreadReplyFact) {
    ///     fact.list_entry = todo!();
    /// }
    /// ```
    pub fn committed(thread_root_id: ThreadRootId, list_entry: ThreadListEntry) -> Self {
        Self {
            thread_root_id,
            list_entry,
        }
    }

    pub fn thread_root_id(&self) -> &ThreadRootId {
        &self.thread_root_id
    }

    /// The absolute count of participant replies in the cluster, already including
    /// this reply. Read off the carried entry, so it can never disagree with the
    /// placed entry's own count.
    pub fn reply_count(&self) -> i64 {
        self.list_entry.reply_count()
    }

    /// The cluster's list entry as projected inside this reply's atomic unit — the
    /// value the publication frame and the acknowledgement both carry.
    pub fn list_entry(&self) -> &ThreadListEntry {
        &self.list_entry
    }
}

/// The largest a thread's root preview may be, counted in UTF-16 code units.
///
/// This is the wire contract's unit, not Rust's: the published preview is measured
/// the way the client that renders it measures a string, so a value that fits here
/// fits there. See [`thread_root_preview`] for the one boundary case where the two
/// string models cannot agree.
pub const THREAD_PREVIEW_MAX_UTF16: usize = 160;

/// The root preview a thread-list entry publishes: the root's content truncated to
/// at most [`THREAD_PREVIEW_MAX_UTF16`] UTF-16 code units, with no trimming,
/// normalization, or ellipsis — the raw prefix, exactly as the reader will measure
/// it.
///
/// The one place the two string models diverge, stated rather than hidden: the wire
/// counts UTF-16 code units and a client is free to cut an astral scalar in half,
/// keeping a lone surrogate as its 160th unit. A Rust `String` is UTF-8 and cannot
/// hold a lone surrogate, so when the limit would fall inside an astral scalar this
/// stops at the scalar boundary before it (159 units) rather than emitting one that
/// cannot be a `str`. Every boundary that lands between scalars is identical to a
/// UTF-16 slice; only an astral scalar straddling the exact limit differs, by the
/// one unit that has no UTF-8 spelling.
pub fn thread_root_preview(content: &str) -> String {
    let mut units = 0usize;
    let mut end = content.len();
    for (offset, ch) in content.char_indices() {
        let width = ch.len_utf16();
        if units + width > THREAD_PREVIEW_MAX_UTF16 {
            end = offset;
            break;
        }
        units += width;
    }
    content[..end].to_owned()
}

/// The value [`ThreadReplyFact`] carries: the cluster as it is placed and previewed,
/// without the per-viewer follow bit.
///
/// Projected inside the reply's atomic unit from the authoritative
/// `(reply_count, last_reply_*)` rows, so the entry a reply produces already counts
/// itself and can never show a future-seq value. `root_author` and every replier are the one shared
/// [`MessageAuthor`] contract, so a deleted actor keeps its send-time snapshot here
/// exactly as it does on a message byline. The per-viewer `viewer_following` bit is
/// deliberately absent: it is not a property of the cluster, and this value is the
/// viewer-invariant subset every recipient of the broadcast frame shares.
///
/// Private fields with a public [`committed`](ThreadListEntry::committed) seam and
/// read-only accessors, for the same reason [`ThreadReplyFact`] has them: the adapter
/// that read the projection inside the atomic unit is the only thing that assembles
/// one, and the preview rule is enforced here — the seam takes raw content and
/// applies [`thread_root_preview`], so no caller can publish an over-long or
/// arbitrarily-truncated preview.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ThreadListEntry {
    root_message_id: MessageId,
    root_author: Option<MessageAuthor>,
    root_preview: String,
    root_created_at_ms: i64,
    root_seq: MessageSeq,
    reply_count: i64,
    last_reply_at_ms: i64,
    last_reply_message_id: MessageId,
    repliers: Vec<MessageAuthor>,
    replier_total: i64,
}

impl ThreadListEntry {
    /// Assembled by the adapter that projected the cluster inside the same atomic
    /// unit as the reply. The preview is derived here from the raw root content, so
    /// the [`THREAD_PREVIEW_MAX_UTF16`] rule cannot be bypassed or duplicated.
    ///
    /// A caller outside this crate cannot assemble one field by field:
    ///
    /// ```compile_fail
    /// use silverhand_backend_core::messaging::ThreadListEntry;
    ///
    /// let entry = ThreadListEntry {
    ///     root_message_id: todo!(),
    ///     replier_total: 0,
    /// };
    /// ```
    ///
    /// nor mutate one that already exists:
    ///
    /// ```compile_fail
    /// use silverhand_backend_core::messaging::ThreadListEntry;
    ///
    /// fn tamper(entry: &mut ThreadListEntry) {
    ///     entry.replier_total = 0;
    /// }
    /// ```
    #[allow(clippy::too_many_arguments)]
    pub fn committed(
        root_message_id: MessageId,
        root_author: Option<MessageAuthor>,
        root_content: &str,
        root_created_at_ms: i64,
        root_seq: MessageSeq,
        reply_count: i64,
        last_reply_at_ms: i64,
        last_reply_message_id: MessageId,
        repliers: Vec<MessageAuthor>,
        replier_total: i64,
    ) -> Self {
        Self {
            root_message_id,
            root_author,
            root_preview: thread_root_preview(root_content),
            root_created_at_ms,
            root_seq,
            reply_count,
            last_reply_at_ms,
            last_reply_message_id,
            repliers,
            replier_total,
        }
    }

    pub fn root_message_id(&self) -> &MessageId {
        &self.root_message_id
    }

    pub fn root_author(&self) -> Option<&MessageAuthor> {
        self.root_author.as_ref()
    }

    pub fn root_preview(&self) -> &str {
        &self.root_preview
    }

    pub fn root_created_at_ms(&self) -> i64 {
        self.root_created_at_ms
    }

    pub fn root_seq(&self) -> MessageSeq {
        self.root_seq
    }

    pub fn reply_count(&self) -> i64 {
        self.reply_count
    }

    pub fn last_reply_at_ms(&self) -> i64 {
        self.last_reply_at_ms
    }

    pub fn last_reply_message_id(&self) -> &MessageId {
        &self.last_reply_message_id
    }

    pub fn repliers(&self) -> &[MessageAuthor] {
        &self.repliers
    }

    pub fn replier_total(&self) -> i64 {
        self.replier_total
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

#[cfg(test)]
mod tests {
    use super::{THREAD_PREVIEW_MAX_UTF16, thread_root_preview};

    /// UTF-16 length, the unit the wire contract measures a preview in.
    fn utf16_len(s: &str) -> usize {
        s.chars().map(char::len_utf16).sum()
    }

    #[test]
    fn a_preview_shorter_than_the_limit_is_returned_whole() {
        let content = "a".repeat(THREAD_PREVIEW_MAX_UTF16 - 1);
        let preview = thread_root_preview(&content);
        assert_eq!(preview, content);
        assert_eq!(utf16_len(&preview), THREAD_PREVIEW_MAX_UTF16 - 1);
    }

    #[test]
    fn a_preview_exactly_at_the_limit_is_returned_whole() {
        let content = "a".repeat(THREAD_PREVIEW_MAX_UTF16);
        let preview = thread_root_preview(&content);
        assert_eq!(preview, content);
        assert_eq!(utf16_len(&preview), THREAD_PREVIEW_MAX_UTF16);
    }

    #[test]
    fn a_preview_one_past_the_limit_keeps_the_first_limit_units() {
        let content = "a".repeat(THREAD_PREVIEW_MAX_UTF16 + 1);
        let preview = thread_root_preview(&content);
        assert_eq!(preview, "a".repeat(THREAD_PREVIEW_MAX_UTF16));
        assert_eq!(utf16_len(&preview), THREAD_PREVIEW_MAX_UTF16);
    }

    #[test]
    fn a_bmp_char_on_the_limit_boundary_is_kept_whole() {
        // 159 ASCII + one 3-byte BMP scalar (1 UTF-16 unit) == exactly 160 units.
        let mut content = "a".repeat(THREAD_PREVIEW_MAX_UTF16 - 1);
        content.push('世');
        let preview = thread_root_preview(&content);
        assert_eq!(preview, content);
        assert_eq!(utf16_len(&preview), THREAD_PREVIEW_MAX_UTF16);
    }

    #[test]
    fn an_astral_scalar_straddling_the_limit_stops_before_it() {
        // 159 ASCII fills to unit 159; the next scalar '😀' is 2 UTF-16 units, so a
        // UTF-16 slice(0,160) would cut it in half and keep a lone high surrogate.
        // UTF-8 cannot spell that, so this stops at the scalar boundary: 159 units,
        // the astral scalar dropped whole rather than split.
        let mut content = "a".repeat(THREAD_PREVIEW_MAX_UTF16 - 1);
        content.push('😀');
        let preview = thread_root_preview(&content);
        assert_eq!(preview, "a".repeat(THREAD_PREVIEW_MAX_UTF16 - 1));
        assert_eq!(utf16_len(&preview), THREAD_PREVIEW_MAX_UTF16 - 1);
    }

    #[test]
    fn an_astral_scalar_fully_inside_the_limit_is_kept_whole() {
        // 158 ASCII + '😀' (2 units) == exactly 160 units: fits, kept whole.
        let mut content = "a".repeat(THREAD_PREVIEW_MAX_UTF16 - 2);
        content.push('😀');
        let preview = thread_root_preview(&content);
        assert_eq!(preview, content);
        assert_eq!(utf16_len(&preview), THREAD_PREVIEW_MAX_UTF16);
    }

    #[test]
    fn the_preview_never_trims_or_normalizes_leading_whitespace() {
        let content = "   spaced".to_owned();
        assert_eq!(thread_root_preview(&content), content);
    }
}
