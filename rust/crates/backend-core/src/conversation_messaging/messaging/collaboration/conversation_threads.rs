//! Read contract for one conversation's reply-cluster list.
//!
//! [`ThreadListEntry`] is a viewer-invariant write projection. It deliberately
//! does not claim that a persisted read row was well formed or came from the
//! requested conversation. This module adds that operation-specific boundary:
//! every selected row is sealed before aggregation, and the page retains the
//! viewer, conversation, and exact query until the HTTP consumer binds them.

use std::{collections::HashSet, error::Error, future::Future};

use crate::{
    conversation_messaging::messaging::{
        MessageAuthor, MessageId, MessageSeq, PrincipalIdentity, ThreadListEntry, ThreadRootId,
    },
    foundation::identity::{ConversationId, UserId},
};

const MAX_JAVASCRIPT_INTEGER: i64 = 9_007_199_254_740_991;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ThreadListFilter {
    All,
    FollowedUnread,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ThreadListCursor {
    last_reply_at: i64,
    root_seq: MessageSeq,
}

impl ThreadListCursor {
    pub fn new(last_reply_at: i64, root_seq: MessageSeq) -> Result<Self, InvalidThreadListCursor> {
        if !(0..=MAX_JAVASCRIPT_INTEGER).contains(&last_reply_at)
            || !(0..=MAX_JAVASCRIPT_INTEGER).contains(&root_seq.get())
        {
            return Err(InvalidThreadListCursor);
        }
        Ok(Self {
            last_reply_at,
            root_seq,
        })
    }

    pub const fn last_reply_at(self) -> i64 {
        self.last_reply_at
    }

    pub const fn root_seq(self) -> MessageSeq {
        self.root_seq
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ThreadListQuery {
    limit: u8,
    before: Option<ThreadListCursor>,
    filter: ThreadListFilter,
}

impl ThreadListQuery {
    pub fn new(
        limit: u16,
        before: Option<ThreadListCursor>,
        filter: ThreadListFilter,
    ) -> Result<Self, InvalidThreadListLimit> {
        let limit = u8::try_from(limit).map_err(|_| InvalidThreadListLimit)?;
        (1..=50)
            .contains(&limit)
            .then_some(Self {
                limit,
                before,
                filter,
            })
            .ok_or(InvalidThreadListLimit)
    }

    pub const fn limit(self) -> u8 {
        self.limit
    }

    pub const fn before(self) -> Option<ThreadListCursor> {
        self.before
    }

    pub const fn filter(self) -> ThreadListFilter {
        self.filter
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, thiserror::Error)]
#[error("conversation thread-list limit must be between 1 and 50")]
pub struct InvalidThreadListLimit;

#[derive(Clone, Copy, Debug, Eq, PartialEq, thiserror::Error)]
#[error("conversation thread cursor must contain exact nonnegative JavaScript integers")]
pub struct InvalidThreadListCursor;

/// One fully decoded selected row. Its source conversation remains present
/// until the page is bound; SQL request parameters are never copied in as that
/// source coordinate.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SelectedConversationThread {
    conversation: ConversationId,
    entry: ThreadListEntry,
    viewer_following: bool,
}

impl SelectedConversationThread {
    #[allow(clippy::too_many_arguments)]
    pub fn seal(
        conversation: ConversationId,
        root_conversation: ConversationId,
        root_id: ThreadRootId,
        root_author: Option<MessageAuthor>,
        root_content: &str,
        root_created_at: i64,
        root_seq: MessageSeq,
        reply_count: i64,
        last_reply_at: i64,
        last_reply_seq: MessageSeq,
        last_reply_conversation: ConversationId,
        last_reply_thread_root: ThreadRootId,
        last_reply_message_id: MessageId,
        repliers: Vec<MessageAuthor>,
        replier_total: i64,
        viewer_following: bool,
    ) -> Result<Self, ThreadReadCorruption> {
        exact_nonnegative("messages.root_created_at", root_created_at)?;
        exact_nonnegative("messages.root_seq", root_seq.get())?;
        exact_positive("messages.reply_count", reply_count)?;
        exact_nonnegative("messages.last_reply_at", last_reply_at)?;
        exact_nonnegative("messages.last_reply_seq", last_reply_seq.get())?;
        exact_nonnegative("messages.replier_total", replier_total)?;

        if root_conversation != conversation
            || last_reply_conversation != conversation
            || last_reply_thread_root != root_id
        {
            return Err(ThreadReadCorruption::ReplyCoordinate);
        }
        if last_reply_seq <= root_seq || last_reply_message_id.as_str() == root_id.as_str() {
            return Err(ThreadReadCorruption::ReplyRelation);
        }
        if replier_total > reply_count
            || repliers.len() != usize::try_from(replier_total.min(3)).unwrap_or_default()
        {
            return Err(ThreadReadCorruption::ReplierCardinality);
        }
        let mut identities = HashSet::<PrincipalIdentity>::with_capacity(repliers.len());
        for replier in &repliers {
            let identity = replier
                .stable_identity()
                .ok_or(ThreadReadCorruption::UnresolvedReplier)?;
            if !identities.insert(identity) {
                return Err(ThreadReadCorruption::DuplicateReplier);
            }
        }

        Ok(Self {
            conversation,
            entry: ThreadListEntry::committed(
                root_id,
                root_author,
                root_content,
                root_created_at,
                root_seq,
                reply_count,
                last_reply_at,
                last_reply_message_id,
                repliers,
                replier_total,
            ),
            viewer_following,
        })
    }

    pub fn conversation(&self) -> &ConversationId {
        &self.conversation
    }

    pub fn entry(&self) -> &ThreadListEntry {
        &self.entry
    }

    pub const fn viewer_following(&self) -> bool {
        self.viewer_following
    }

    fn cursor(&self) -> ThreadListCursor {
        ThreadListCursor {
            last_reply_at: self.entry.last_reply_at_ms(),
            root_seq: self.entry.root_seq(),
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ConversationThreadsPage {
    viewer: UserId,
    conversation: ConversationId,
    query: ThreadListQuery,
    threads: Vec<SelectedConversationThread>,
    next: Option<ThreadListCursor>,
}

impl ConversationThreadsPage {
    /// Seals rows plus the adapter's look-ahead fact. There is intentionally no
    /// cursor argument: continuation is derived from `has_more` and the tail.
    /// A consumer cannot replace it afterwards either:
    ///
    /// ```compile_fail
    /// use silverhand_backend_core::conversation_messaging::messaging::collaboration::conversation_threads::{
    ///     ConversationThreadsPage, ThreadListCursor,
    /// };
    ///
    /// fn forge(page: &mut ConversationThreadsPage, cursor: ThreadListCursor) {
    ///     page.next = Some(cursor);
    /// }
    /// ```
    pub fn sealed(
        viewer: UserId,
        conversation: ConversationId,
        query: ThreadListQuery,
        threads: Vec<SelectedConversationThread>,
        has_more: bool,
    ) -> Result<Self, ThreadReadCorruption> {
        if threads.len() > usize::from(query.limit)
            || (has_more && threads.len() != usize::from(query.limit))
        {
            return Err(ThreadReadCorruption::PageCardinality);
        }
        if threads
            .iter()
            .any(|thread| thread.conversation != conversation)
        {
            return Err(ThreadReadCorruption::ForeignConversation);
        }
        if threads
            .windows(2)
            .any(|pair| !strictly_before(pair[0].cursor(), pair[1].cursor()))
        {
            return Err(ThreadReadCorruption::PageOrder);
        }
        let mut roots = HashSet::with_capacity(threads.len());
        if threads
            .iter()
            .any(|thread| !roots.insert(thread.entry.root_id().as_str()))
        {
            return Err(ThreadReadCorruption::DuplicateRoot);
        }
        if let Some(before) = query.before
            && threads
                .iter()
                .any(|thread| !strictly_before(before, thread.cursor()))
        {
            return Err(ThreadReadCorruption::OutsideCursor);
        }
        if query.filter == ThreadListFilter::FollowedUnread
            && threads.iter().any(|thread| !thread.viewer_following)
        {
            return Err(ThreadReadCorruption::FollowedUnreadRow);
        }
        let next = if has_more {
            Some(
                threads
                    .last()
                    .ok_or(ThreadReadCorruption::PageCardinality)?
                    .cursor(),
            )
        } else {
            None
        };
        Ok(Self {
            viewer,
            conversation,
            query,
            threads,
            next,
        })
    }

    pub fn bind(
        self,
        requested_viewer: &UserId,
        requested_conversation: &ConversationId,
        requested_query: ThreadListQuery,
    ) -> Result<BoundConversationThreadsPage, ConversationThreadsIdentityMismatch> {
        if &self.viewer != requested_viewer
            || &self.conversation != requested_conversation
            || self.query != requested_query
            || self
                .threads
                .iter()
                .any(|thread| thread.conversation != *requested_conversation)
        {
            return Err(ConversationThreadsIdentityMismatch);
        }
        Ok(BoundConversationThreadsPage(self))
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct BoundConversationThreadsPage(ConversationThreadsPage);

impl BoundConversationThreadsPage {
    pub fn threads(&self) -> &[SelectedConversationThread] {
        &self.0.threads
    }

    pub const fn next_cursor(&self) -> Option<ThreadListCursor> {
        self.0.next
    }
}

fn exact_nonnegative(field: &'static str, value: i64) -> Result<(), ThreadReadCorruption> {
    if (0..=MAX_JAVASCRIPT_INTEGER).contains(&value) {
        Ok(())
    } else {
        Err(ThreadReadCorruption::UnsafeNumber { field })
    }
}

fn exact_positive(field: &'static str, value: i64) -> Result<(), ThreadReadCorruption> {
    exact_nonnegative(field, value)?;
    if value == 0 {
        Err(ThreadReadCorruption::UnsafeNumber { field })
    } else {
        Ok(())
    }
}

/// Whether `row` is strictly later in the descending query than `anchor`.
fn strictly_before(anchor: ThreadListCursor, row: ThreadListCursor) -> bool {
    row.last_reply_at < anchor.last_reply_at
        || (row.last_reply_at == anchor.last_reply_at && row.root_seq < anchor.root_seq)
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, thiserror::Error)]
pub enum ThreadReadCorruption {
    #[error("conversation thread field {field} is not an exact nonnegative JavaScript integer")]
    UnsafeNumber { field: &'static str },
    #[error("conversation thread root and last reply do not form a reply relation")]
    ReplyRelation,
    #[error("conversation thread root and last reply coordinates do not match")]
    ReplyCoordinate,
    #[error("conversation thread replier total does not match its bounded projection")]
    ReplierCardinality,
    #[error("conversation thread replier has no stable identity")]
    UnresolvedReplier,
    #[error("conversation thread repeats a replier identity")]
    DuplicateReplier,
    #[error("conversation thread page contains a foreign conversation row")]
    ForeignConversation,
    #[error("conversation thread page cardinality contradicts its limit or look-ahead fact")]
    PageCardinality,
    #[error("conversation thread page is not in strict descending activity order")]
    PageOrder,
    #[error("conversation thread page repeats a root identity")]
    DuplicateRoot,
    #[error("conversation thread page contains a row outside its keyset cursor")]
    OutsideCursor,
    #[error("followed-unread thread page contains a row not followed by the viewer")]
    FollowedUnreadRow,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, thiserror::Error)]
#[error(
    "conversation thread page identity differs from the requested viewer, conversation, or query"
)]
pub struct ConversationThreadsIdentityMismatch;

#[derive(Clone, Copy, Debug, Eq, PartialEq, thiserror::Error)]
pub enum ConversationThreadsRefusal {
    #[error("conversation not found")]
    NotFound,
    #[error("viewer does not participate in the conversation")]
    Forbidden,
}

pub trait ConversationThreadsReadPort {
    type Error: Error + Send + Sync + 'static;

    /// Rejection-only preflight for authority-before-query ordering. Success is
    /// not a token: `read` re-evaluates participation in its own snapshot.
    fn admit(
        &self,
        viewer: &UserId,
        conversation: &ConversationId,
    ) -> impl Future<Output = Result<Result<(), ConversationThreadsRefusal>, Self::Error>> + Send;

    fn read(
        &self,
        viewer: &UserId,
        conversation: &ConversationId,
        query: ThreadListQuery,
    ) -> impl Future<
        Output = Result<Result<ConversationThreadsPage, ConversationThreadsRefusal>, Self::Error>,
    > + Send;
}

#[cfg(test)]
mod tests {
    use super::*;

    fn human(id: &str) -> MessageAuthor {
        MessageAuthor::active_human(
            UserId::parse(id).unwrap(),
            id.to_owned(),
            id.to_owned(),
            None,
        )
    }

    #[allow(clippy::too_many_arguments)]
    fn thread(
        conversation: &str,
        root: &str,
        root_seq: i64,
        last_at: i64,
        last_seq: i64,
        repliers: Vec<MessageAuthor>,
        replier_total: i64,
        following: bool,
    ) -> Result<SelectedConversationThread, ThreadReadCorruption> {
        thread_with_sources(
            conversation,
            conversation,
            root,
            conversation,
            root,
            root_seq,
            last_at,
            last_seq,
            repliers,
            replier_total,
            following,
        )
    }

    #[allow(clippy::too_many_arguments)]
    fn thread_with_sources(
        conversation: &str,
        root_conversation: &str,
        root: &str,
        last_reply_conversation: &str,
        last_reply_thread_root: &str,
        root_seq: i64,
        last_at: i64,
        last_seq: i64,
        repliers: Vec<MessageAuthor>,
        replier_total: i64,
        following: bool,
    ) -> Result<SelectedConversationThread, ThreadReadCorruption> {
        SelectedConversationThread::seal(
            ConversationId::parse(conversation).unwrap(),
            ConversationId::parse(root_conversation).unwrap(),
            ThreadRootId::parse(root).unwrap(),
            Some(human("root-author")),
            "root content",
            10,
            MessageSeq::try_from(root_seq).unwrap(),
            4,
            last_at,
            MessageSeq::try_from(last_seq).unwrap(),
            ConversationId::parse(last_reply_conversation).unwrap(),
            ThreadRootId::parse(last_reply_thread_root).unwrap(),
            MessageId::parse(format!("reply-{root}")).unwrap(),
            repliers,
            replier_total,
            following,
        )
    }

    #[test]
    fn selected_row_seals_numeric_reply_and_replier_algebra() {
        let valid = thread(
            "c",
            "root",
            1,
            30,
            4,
            vec![human("u1"), human("u2")],
            2,
            true,
        );
        assert!(valid.is_ok());

        assert_eq!(
            thread("c", "root", 4, 30, 4, vec![human("u1")], 1, true),
            Err(ThreadReadCorruption::ReplyRelation)
        );
        assert_eq!(
            thread(
                "c",
                "root",
                1,
                MAX_JAVASCRIPT_INTEGER + 1,
                4,
                vec![human("u1")],
                1,
                true,
            ),
            Err(ThreadReadCorruption::UnsafeNumber {
                field: "messages.last_reply_at"
            })
        );
        assert_eq!(
            thread("c", "root", 1, 30, 4, vec![human("u1")], 2, true),
            Err(ThreadReadCorruption::ReplierCardinality)
        );
        assert_eq!(
            thread(
                "c",
                "root",
                1,
                30,
                4,
                vec![human("u1"), human("u1")],
                2,
                true,
            ),
            Err(ThreadReadCorruption::DuplicateReplier)
        );
    }

    #[test]
    fn selected_row_binds_actual_root_and_last_reply_coordinates() {
        assert!(
            thread_with_sources(
                "conversation-a",
                "conversation-a",
                "root-a",
                "conversation-a",
                "root-a",
                1,
                30,
                2,
                vec![human("u1")],
                1,
                true,
            )
            .is_ok()
        );
        assert_eq!(
            thread_with_sources(
                "conversation-a",
                "conversation-a",
                "root-a",
                "conversation-a",
                "root-b",
                1,
                30,
                2,
                vec![human("u1")],
                1,
                true,
            ),
            Err(ThreadReadCorruption::ReplyCoordinate)
        );
        assert_eq!(
            thread_with_sources(
                "conversation-a",
                "conversation-a",
                "root-a",
                "conversation-b",
                "root-a",
                1,
                30,
                2,
                vec![human("u1")],
                1,
                true,
            ),
            Err(ThreadReadCorruption::ReplyCoordinate)
        );
    }

    #[test]
    fn page_derives_cursor_and_binds_viewer_conversation_and_query() {
        let viewer = UserId::parse("viewer-a").unwrap();
        let conversation = ConversationId::parse("conversation-a").unwrap();
        let query = ThreadListQuery::new(2, None, ThreadListFilter::All).unwrap();
        let page = ConversationThreadsPage::sealed(
            viewer.clone(),
            conversation.clone(),
            query,
            vec![
                thread(
                    "conversation-a",
                    "root-2",
                    2,
                    30,
                    4,
                    vec![human("u1")],
                    1,
                    false,
                )
                .unwrap(),
                thread(
                    "conversation-a",
                    "root-1",
                    1,
                    30,
                    3,
                    vec![human("u2")],
                    1,
                    true,
                )
                .unwrap(),
            ],
            true,
        )
        .unwrap();
        assert_eq!(
            page.clone()
                .bind(&viewer, &conversation, query)
                .unwrap()
                .next_cursor(),
            Some(ThreadListCursor::new(30, MessageSeq::try_from(1).unwrap()).unwrap())
        );
        assert_eq!(
            page.clone()
                .bind(&UserId::parse("viewer-b").unwrap(), &conversation, query,),
            Err(ConversationThreadsIdentityMismatch)
        );
        assert_eq!(
            page.bind(
                &viewer,
                &ConversationId::parse("conversation-b").unwrap(),
                query,
            ),
            Err(ConversationThreadsIdentityMismatch)
        );

        let no_more = ConversationThreadsPage::sealed(
            viewer.clone(),
            conversation.clone(),
            query,
            vec![
                thread(
                    "conversation-a",
                    "root-2",
                    2,
                    30,
                    4,
                    vec![human("u1")],
                    1,
                    false,
                )
                .unwrap(),
            ],
            false,
        )
        .unwrap()
        .bind(&viewer, &conversation, query)
        .unwrap();
        assert_eq!(no_more.next_cursor(), None);

        let empty = ConversationThreadsPage::sealed(viewer, conversation, query, Vec::new(), true);
        assert_eq!(empty, Err(ThreadReadCorruption::PageCardinality));
    }

    #[test]
    fn page_rejects_foreign_rows_order_drift_and_query_drift() {
        let viewer = UserId::parse("viewer").unwrap();
        let conversation = ConversationId::parse("conversation-a").unwrap();
        let query = ThreadListQuery::new(2, None, ThreadListFilter::All).unwrap();
        assert_eq!(
            ConversationThreadsPage::sealed(
                viewer.clone(),
                conversation.clone(),
                query,
                vec![
                    thread(
                        "conversation-b",
                        "foreign-root",
                        1,
                        30,
                        2,
                        vec![human("u1")],
                        1,
                        false,
                    )
                    .unwrap(),
                ],
                false,
            ),
            Err(ThreadReadCorruption::ForeignConversation)
        );
        assert_eq!(
            ConversationThreadsPage::sealed(
                viewer.clone(),
                conversation.clone(),
                query,
                vec![
                    thread(
                        "conversation-a",
                        "root-1",
                        1,
                        30,
                        2,
                        vec![human("u1")],
                        1,
                        false,
                    )
                    .unwrap(),
                    thread(
                        "conversation-a",
                        "root-2",
                        2,
                        30,
                        3,
                        vec![human("u2")],
                        1,
                        false,
                    )
                    .unwrap(),
                ],
                false,
            ),
            Err(ThreadReadCorruption::PageOrder)
        );

        let page = ConversationThreadsPage::sealed(
            viewer.clone(),
            conversation.clone(),
            query,
            vec![],
            false,
        )
        .unwrap();
        let other_query = ThreadListQuery::new(1, None, ThreadListFilter::All).unwrap();
        assert_eq!(
            page.bind(&viewer, &conversation, other_query),
            Err(ConversationThreadsIdentityMismatch)
        );
    }

    #[test]
    fn followed_unread_page_requires_followed_rows() {
        let viewer = UserId::parse("viewer").unwrap();
        let conversation = ConversationId::parse("conversation").unwrap();
        let query = ThreadListQuery::new(1, None, ThreadListFilter::FollowedUnread).unwrap();
        assert_eq!(
            ConversationThreadsPage::sealed(
                viewer,
                conversation,
                query,
                vec![
                    thread(
                        "conversation",
                        "root",
                        1,
                        30,
                        2,
                        vec![human("u1")],
                        1,
                        false,
                    )
                    .unwrap(),
                ],
                false,
            ),
            Err(ThreadReadCorruption::FollowedUnreadRow)
        );
    }

    #[test]
    fn page_rejects_a_duplicate_root_even_when_its_keys_are_distinct() {
        let viewer = UserId::parse("viewer").unwrap();
        let conversation = ConversationId::parse("conversation").unwrap();
        let query = ThreadListQuery::new(2, None, ThreadListFilter::All).unwrap();
        assert_eq!(
            ConversationThreadsPage::sealed(
                viewer.clone(),
                conversation.clone(),
                query,
                vec![
                    thread(
                        "conversation",
                        "root",
                        2,
                        40,
                        4,
                        vec![human("u1")],
                        1,
                        false,
                    )
                    .unwrap(),
                    thread(
                        "conversation",
                        "root",
                        1,
                        30,
                        3,
                        vec![human("u2")],
                        1,
                        false,
                    )
                    .unwrap(),
                ],
                false,
            ),
            Err(ThreadReadCorruption::DuplicateRoot)
        );

        assert!(
            ConversationThreadsPage::sealed(
                viewer,
                conversation,
                query,
                vec![
                    thread(
                        "conversation",
                        "root-a",
                        2,
                        40,
                        4,
                        vec![human("u1")],
                        1,
                        false,
                    )
                    .unwrap(),
                    thread(
                        "conversation",
                        "root-b",
                        1,
                        30,
                        3,
                        vec![human("u2")],
                        1,
                        false,
                    )
                    .unwrap(),
                ],
                false,
            )
            .is_ok()
        );
    }
}
