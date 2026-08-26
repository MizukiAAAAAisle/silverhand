//! Read-side attachment facts and ports.
//!
//! Persistence rows retain their source coordinates until they have been bound
//! to the authenticated viewer and requested conversation/object. A store cannot
//! splice a foreign attachment row or message reference into a successful fact:
//! every public constructor checks the complete coordinate before a wire adapter
//! can observe the payload.

use std::{error::Error, future::Future};

use crate::{
    blob_store::StoredBlob,
    identity::{AgentId, ConversationId, UserId},
    messaging::{AttachmentId, MessageAuthor, MessageId, MessageSeq, ThreadRootId},
};

const MAX_FILENAME_BYTES: usize = 255;
const MAX_CONTENT_TYPE_BYTES: usize = 255;
const MAX_LIST_LIMIT: u16 = 100;
/// Largest integer whose exact value survives a JSON round trip through an
/// ECMAScript `number` consumer.
pub const ATTACHMENT_WIRE_MAX_SAFE_INTEGER: i64 = 9_007_199_254_740_991;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AttachmentFilename(String);

impl AttachmentFilename {
    pub fn parse(raw: impl Into<String>) -> Result<Self, InvalidAttachmentFilename> {
        let raw = raw.into();
        if raw.is_empty()
            || raw.len() > MAX_FILENAME_BYTES
            || raw.contains('/')
            || raw.contains('\\')
            || raw.chars().any(char::is_control)
        {
            return Err(InvalidAttachmentFilename);
        }
        Ok(Self(raw))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, thiserror::Error)]
#[error("stored attachment filename is outside the canonical grammar")]
pub struct InvalidAttachmentFilename;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AttachmentContentType(String);

impl AttachmentContentType {
    pub fn parse(raw: impl Into<String>) -> Result<Self, InvalidAttachmentContentType> {
        let raw = raw.into();
        if raw.is_empty()
            || raw.len() > MAX_CONTENT_TYPE_BYTES
            || raw.bytes().any(|byte| byte.is_ascii_uppercase())
            || raw.contains(';')
        {
            return Err(InvalidAttachmentContentType);
        }
        let Some((kind, subtype)) = raw.split_once('/') else {
            return Err(InvalidAttachmentContentType);
        };
        if kind.is_empty()
            || subtype.is_empty()
            || raw.matches('/').count() != 1
            || !kind.bytes().all(mime_token)
            || !subtype.bytes().all(mime_token)
        {
            return Err(InvalidAttachmentContentType);
        }
        Ok(Self(raw))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

fn mime_token(byte: u8) -> bool {
    byte.is_ascii_lowercase() || byte.is_ascii_digit() || b".+-".contains(&byte)
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, thiserror::Error)]
#[error("stored attachment content type is outside the normalized MIME grammar")]
pub struct InvalidAttachmentContentType;

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum AttachmentCreator {
    Human(UserId),
    Agent(AgentId),
}

impl AttachmentCreator {
    pub const fn kind(&self) -> &'static str {
        match self {
            Self::Human(_) => "user",
            Self::Agent(_) => "agent",
        }
    }

    pub fn id(&self) -> &str {
        match self {
            Self::Human(value) => value.as_str(),
            Self::Agent(value) => value.as_str(),
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AttachmentRecord {
    id: AttachmentId,
    channel: ConversationId,
    source_conversation: Option<ConversationId>,
    filename: AttachmentFilename,
    size: i64,
    content_type: AttachmentContentType,
    blob: StoredBlob,
    content_revision: i64,
    creator: AttachmentCreator,
    created_at: i64,
}

impl AttachmentRecord {
    #[allow(clippy::too_many_arguments)]
    pub fn projected(
        id: AttachmentId,
        channel: ConversationId,
        source_conversation: Option<ConversationId>,
        filename: AttachmentFilename,
        size: i64,
        content_type: AttachmentContentType,
        blob: StoredBlob,
        content_revision: i64,
        creator: AttachmentCreator,
        created_at: i64,
    ) -> Result<Self, InvalidAttachmentRecord> {
        if !(0..=ATTACHMENT_WIRE_MAX_SAFE_INTEGER).contains(&size)
            || !(1..=ATTACHMENT_WIRE_MAX_SAFE_INTEGER).contains(&content_revision)
            || !(0..=ATTACHMENT_WIRE_MAX_SAFE_INTEGER).contains(&created_at)
        {
            return Err(InvalidAttachmentRecord);
        }
        Ok(Self {
            id,
            channel,
            source_conversation,
            filename,
            size,
            content_type,
            blob,
            content_revision,
            creator,
            created_at,
        })
    }

    pub fn id(&self) -> &AttachmentId {
        &self.id
    }

    pub fn channel(&self) -> &ConversationId {
        &self.channel
    }

    pub fn source_conversation(&self) -> Option<&ConversationId> {
        self.source_conversation.as_ref()
    }

    pub fn filename(&self) -> &AttachmentFilename {
        &self.filename
    }

    pub const fn size(&self) -> i64 {
        self.size
    }

    pub fn content_type(&self) -> &AttachmentContentType {
        &self.content_type
    }

    pub fn blob(&self) -> &StoredBlob {
        &self.blob
    }

    pub const fn content_revision(&self) -> i64 {
        self.content_revision
    }

    pub fn creator(&self) -> &AttachmentCreator {
        &self.creator
    }

    pub const fn created_at(&self) -> i64 {
        self.created_at
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, thiserror::Error)]
#[error("stored attachment row violates its scalar invariants")]
pub struct InvalidAttachmentRecord;

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum AttachmentSourceActor {
    Human(Option<UserId>),
    Agent(Option<AgentId>),
    System,
}

impl AttachmentSourceActor {
    pub const fn kind(&self) -> &'static str {
        match self {
            Self::Human(_) => "user",
            Self::Agent(_) => "agent",
            Self::System => "system",
        }
    }

    pub fn user_id(&self) -> Option<&UserId> {
        match self {
            Self::Human(value) => value.as_ref(),
            Self::Agent(_) | Self::System => None,
        }
    }

    pub fn agent_id(&self) -> Option<&AgentId> {
        match self {
            Self::Agent(value) => value.as_ref(),
            Self::Human(_) | Self::System => None,
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AttachmentListSource {
    message: MessageId,
    conversation: ConversationId,
    thread_root: Option<ThreadRootId>,
    message_seq: MessageSeq,
    author: Option<MessageAuthor>,
    actor: AttachmentSourceActor,
    appeared_at: i64,
}

impl AttachmentListSource {
    #[allow(clippy::too_many_arguments)]
    pub fn projected(
        message: MessageId,
        conversation: ConversationId,
        thread_root: Option<ThreadRootId>,
        message_seq: MessageSeq,
        author: Option<MessageAuthor>,
        actor: AttachmentSourceActor,
        appeared_at: i64,
    ) -> Result<Self, InvalidAttachmentListSource> {
        if !(0..=ATTACHMENT_WIRE_MAX_SAFE_INTEGER).contains(&appeared_at)
            || (matches!(&actor, AttachmentSourceActor::System) != author.is_none())
        {
            return Err(InvalidAttachmentListSource);
        }
        if let Some(author) = &author {
            let expected = match &actor {
                AttachmentSourceActor::Human(_) => crate::messaging::PrincipalKind::Human,
                AttachmentSourceActor::Agent(_) => crate::messaging::PrincipalKind::Agent,
                AttachmentSourceActor::System => return Err(InvalidAttachmentListSource),
            };
            if author.kind() != expected {
                return Err(InvalidAttachmentListSource);
            }
        }
        Ok(Self {
            message,
            conversation,
            thread_root,
            message_seq,
            author,
            actor,
            appeared_at,
        })
    }

    pub fn message(&self) -> &MessageId {
        &self.message
    }

    pub fn conversation(&self) -> &ConversationId {
        &self.conversation
    }

    pub fn thread_root(&self) -> Option<&ThreadRootId> {
        self.thread_root.as_ref()
    }

    pub const fn message_seq(&self) -> MessageSeq {
        self.message_seq
    }

    pub fn author(&self) -> Option<&MessageAuthor> {
        self.author.as_ref()
    }

    pub fn actor(&self) -> &AttachmentSourceActor {
        &self.actor
    }

    pub const fn appeared_at(&self) -> i64 {
        self.appeared_at
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, thiserror::Error)]
#[error("stored attachment source violates its author or timestamp invariants")]
pub struct InvalidAttachmentListSource;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AttachmentListItem {
    attachment: AttachmentRecord,
    source: AttachmentListSource,
}

impl AttachmentListItem {
    pub fn projected(
        referenced_attachment: AttachmentId,
        attachment: AttachmentRecord,
        source: AttachmentListSource,
        requested: &ConversationId,
    ) -> Result<Self, AttachmentReadIdentityMismatch> {
        if referenced_attachment != *attachment.id()
            || attachment.channel() != requested
            || source.conversation() != requested
        {
            return Err(AttachmentReadIdentityMismatch);
        }
        Ok(Self { attachment, source })
    }

    pub fn attachment(&self) -> &AttachmentRecord {
        &self.attachment
    }

    pub fn source(&self) -> &AttachmentListSource {
        &self.source
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AttachmentListCursor {
    appeared_at: i64,
    attachment: AttachmentId,
}

impl AttachmentListCursor {
    pub fn new(
        appeared_at: i64,
        attachment: AttachmentId,
    ) -> Result<Self, InvalidAttachmentListQuery> {
        if !(0..=ATTACHMENT_WIRE_MAX_SAFE_INTEGER).contains(&appeared_at) {
            return Err(InvalidAttachmentListQuery);
        }
        Ok(Self {
            appeared_at,
            attachment,
        })
    }

    pub const fn appeared_at(&self) -> i64 {
        self.appeared_at
    }

    pub fn attachment(&self) -> &AttachmentId {
        &self.attachment
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum AttachmentSenderFilter {
    Human(UserId),
    Agent(AgentId),
    System,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AttachmentListQuery {
    limit: u16,
    cursor: Option<AttachmentListCursor>,
    sender: Option<AttachmentSenderFilter>,
    since: Option<i64>,
    until: Option<i64>,
}

impl AttachmentListQuery {
    pub fn new(
        limit: u16,
        cursor: Option<AttachmentListCursor>,
        sender: Option<AttachmentSenderFilter>,
        since: Option<i64>,
        until: Option<i64>,
    ) -> Result<Self, InvalidAttachmentListQuery> {
        if limit == 0
            || limit > MAX_LIST_LIMIT
            || since.is_some_and(|value| !(0..=ATTACHMENT_WIRE_MAX_SAFE_INTEGER).contains(&value))
            || until.is_some_and(|value| !(0..=ATTACHMENT_WIRE_MAX_SAFE_INTEGER).contains(&value))
            || matches!((since, until), (Some(start), Some(end)) if start >= end)
        {
            return Err(InvalidAttachmentListQuery);
        }
        Ok(Self {
            limit,
            cursor,
            sender,
            since,
            until,
        })
    }

    pub const fn limit(&self) -> u16 {
        self.limit
    }

    pub fn cursor(&self) -> Option<&AttachmentListCursor> {
        self.cursor.as_ref()
    }

    pub fn sender(&self) -> Option<&AttachmentSenderFilter> {
        self.sender.as_ref()
    }

    pub const fn since(&self) -> Option<i64> {
        self.since
    }

    pub const fn until(&self) -> Option<i64> {
        self.until
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, thiserror::Error)]
#[error("attachment list query violates its bounded grammar")]
pub struct InvalidAttachmentListQuery;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AttachmentListPage {
    viewer: UserId,
    conversation: ConversationId,
    query: AttachmentListQuery,
    items: Vec<AttachmentListItem>,
    next_cursor: Option<AttachmentListCursor>,
}

impl AttachmentListPage {
    pub fn projected(
        viewer: UserId,
        conversation: ConversationId,
        query: AttachmentListQuery,
        items: Vec<AttachmentListItem>,
        next_cursor: Option<AttachmentListCursor>,
    ) -> Result<Self, AttachmentReadIdentityMismatch> {
        if items.iter().any(|item| {
            item.attachment().channel() != &conversation
                || item.source().conversation() != &conversation
        }) || items.len() > usize::from(query.limit())
        {
            return Err(AttachmentReadIdentityMismatch);
        }
        if let Some(cursor) = &next_cursor {
            let Some(tail) = items.last() else {
                return Err(AttachmentReadIdentityMismatch);
            };
            if items.len() != usize::from(query.limit())
                || cursor.appeared_at() != tail.source().appeared_at()
                || cursor.attachment() != tail.attachment().id()
            {
                return Err(AttachmentReadIdentityMismatch);
            }
        }
        Ok(Self {
            viewer,
            conversation,
            query,
            items,
            next_cursor,
        })
    }

    pub fn bind(
        self,
        viewer: &UserId,
        conversation: &ConversationId,
        query: &AttachmentListQuery,
    ) -> Result<BoundAttachmentListPage, AttachmentReadIdentityMismatch> {
        if &self.viewer != viewer || &self.conversation != conversation || &self.query != query {
            return Err(AttachmentReadIdentityMismatch);
        }
        Ok(BoundAttachmentListPage(self))
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct BoundAttachmentListPage(AttachmentListPage);

impl BoundAttachmentListPage {
    pub fn items(&self) -> &[AttachmentListItem] {
        &self.0.items
    }

    pub fn next_cursor(&self) -> Option<&AttachmentListCursor> {
        self.0.next_cursor.as_ref()
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum AttachmentSenderFacet {
    Human(UserId),
    Agent(AgentId),
    System,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AttachmentSenderFacets {
    viewer: UserId,
    conversation: ConversationId,
    senders: Vec<AttachmentSenderFacet>,
}

impl AttachmentSenderFacets {
    pub fn projected(
        viewer: UserId,
        conversation: ConversationId,
        senders: Vec<AttachmentSenderFacet>,
    ) -> Self {
        Self {
            viewer,
            conversation,
            senders,
        }
    }

    pub fn bind(
        self,
        viewer: &UserId,
        conversation: &ConversationId,
    ) -> Result<BoundAttachmentSenderFacets, AttachmentReadIdentityMismatch> {
        if &self.viewer != viewer || &self.conversation != conversation {
            return Err(AttachmentReadIdentityMismatch);
        }
        Ok(BoundAttachmentSenderFacets(self))
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct BoundAttachmentSenderFacets(AttachmentSenderFacets);

impl BoundAttachmentSenderFacets {
    pub fn senders(&self) -> &[AttachmentSenderFacet] {
        &self.0.senders
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum AttachmentDownloadAdmission {
    Member,
    PublicPersistedReference,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AttachmentDownloadFact {
    viewer: UserId,
    requested: AttachmentId,
    record: AttachmentRecord,
    admission: AttachmentDownloadAdmission,
}

impl AttachmentDownloadFact {
    pub fn member(
        viewer: UserId,
        requested: AttachmentId,
        record: AttachmentRecord,
    ) -> Result<Self, AttachmentReadIdentityMismatch> {
        Self::projected(
            viewer,
            requested,
            record,
            AttachmentDownloadAdmission::Member,
        )
    }

    pub fn public_persisted_reference(
        viewer: UserId,
        requested: AttachmentId,
        record: AttachmentRecord,
        referenced_attachment: &AttachmentId,
        referenced_conversation: &ConversationId,
    ) -> Result<Self, AttachmentReadIdentityMismatch> {
        if referenced_attachment != &requested || referenced_conversation != record.channel() {
            return Err(AttachmentReadIdentityMismatch);
        }
        Self::projected(
            viewer,
            requested,
            record,
            AttachmentDownloadAdmission::PublicPersistedReference,
        )
    }

    fn projected(
        viewer: UserId,
        requested: AttachmentId,
        record: AttachmentRecord,
        admission: AttachmentDownloadAdmission,
    ) -> Result<Self, AttachmentReadIdentityMismatch> {
        if record.id() != &requested {
            return Err(AttachmentReadIdentityMismatch);
        }
        Ok(Self {
            viewer,
            requested,
            record,
            admission,
        })
    }

    pub fn bind(
        self,
        viewer: &UserId,
        requested: &AttachmentId,
    ) -> Result<BoundAttachmentDownload, AttachmentReadIdentityMismatch> {
        if &self.viewer != viewer || &self.requested != requested || self.record.id() != requested {
            return Err(AttachmentReadIdentityMismatch);
        }
        Ok(BoundAttachmentDownload(self))
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct BoundAttachmentDownload(AttachmentDownloadFact);

impl BoundAttachmentDownload {
    pub fn record(&self) -> &AttachmentRecord {
        &self.0.record
    }

    pub const fn is_public_reference(&self) -> bool {
        matches!(
            self.0.admission,
            AttachmentDownloadAdmission::PublicPersistedReference
        )
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, thiserror::Error)]
#[error("attachment read fact differs from its requested coordinate")]
pub struct AttachmentReadIdentityMismatch;

#[derive(Clone, Copy, Debug, Eq, PartialEq, thiserror::Error)]
pub enum ChannelAttachmentReadRefusal {
    #[error("conversation not found")]
    NotFound,
    #[error("viewer cannot read the conversation attachment panel")]
    Forbidden,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, thiserror::Error)]
#[error("attachment not found")]
pub struct AttachmentDownloadRefusal;

pub trait AttachmentListReadPort {
    type Error: Error + Send + Sync + 'static;

    fn list(
        &self,
        viewer: &UserId,
        conversation: &ConversationId,
        query: &AttachmentListQuery,
    ) -> impl Future<
        Output = Result<Result<AttachmentListPage, ChannelAttachmentReadRefusal>, Self::Error>,
    > + Send;
}

pub trait AttachmentSenderFacetReadPort {
    type Error: Error + Send + Sync + 'static;

    fn sender_facets(
        &self,
        viewer: &UserId,
        conversation: &ConversationId,
    ) -> impl Future<
        Output = Result<Result<AttachmentSenderFacets, ChannelAttachmentReadRefusal>, Self::Error>,
    > + Send;
}

pub trait AttachmentDownloadReadPort {
    type Error: Error + Send + Sync + 'static;

    fn download(
        &self,
        viewer: &UserId,
        attachment: &AttachmentId,
    ) -> impl Future<
        Output = Result<Result<AttachmentDownloadFact, AttachmentDownloadRefusal>, Self::Error>,
    > + Send;
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::blob_store::{BlobStorageKey, StorageKind};

    fn record(id: &str, channel: &str) -> AttachmentRecord {
        AttachmentRecord::projected(
            AttachmentId::parse(id).unwrap(),
            ConversationId::parse(channel).unwrap(),
            None,
            AttachmentFilename::parse("note.txt").unwrap(),
            5,
            AttachmentContentType::parse("text/plain").unwrap(),
            StoredBlob::new(
                StorageKind::Local,
                BlobStorageKey::parse("attachments/c/blob-a.txt").unwrap(),
            ),
            1,
            AttachmentCreator::Human(UserId::parse("user-1").unwrap()),
            7,
        )
        .unwrap()
    }

    #[test]
    fn persisted_scalar_grammars_fail_closed() {
        for filename in ["", "../note.txt", "folder/note.txt", "note\n.txt"] {
            assert!(AttachmentFilename::parse(filename).is_err());
        }
        for content_type in [
            "",
            "Image/PNG",
            "image/png; charset=x",
            "image",
            "image//png",
        ] {
            assert!(AttachmentContentType::parse(content_type).is_err());
        }
        assert!(
            AttachmentRecord::projected(
                AttachmentId::parse("a").unwrap(),
                ConversationId::parse("c").unwrap(),
                None,
                AttachmentFilename::parse("a.bin").unwrap(),
                -1,
                AttachmentContentType::parse("application/octet-stream").unwrap(),
                StoredBlob::new(
                    StorageKind::Local,
                    BlobStorageKey::parse("a/b.bin").unwrap()
                ),
                0,
                AttachmentCreator::Human(UserId::parse("u").unwrap()),
                -1,
            )
            .is_err()
        );
    }

    #[test]
    fn list_item_seals_reference_row_and_requested_conversation() {
        let source = AttachmentListSource::projected(
            MessageId::parse("m").unwrap(),
            ConversationId::parse("c").unwrap(),
            None,
            MessageSeq::try_from(1).unwrap(),
            None,
            AttachmentSourceActor::System,
            8,
        )
        .unwrap();
        assert!(
            AttachmentListItem::projected(
                AttachmentId::parse("other").unwrap(),
                record("a", "c"),
                source.clone(),
                &ConversationId::parse("c").unwrap(),
            )
            .is_err()
        );
        assert!(
            AttachmentListItem::projected(
                AttachmentId::parse("a").unwrap(),
                record("a", "foreign"),
                source,
                &ConversationId::parse("c").unwrap(),
            )
            .is_err()
        );
    }

    #[test]
    fn download_public_proof_binds_request_row_and_reference() {
        let viewer = UserId::parse("u").unwrap();
        let requested = AttachmentId::parse("a").unwrap();
        assert!(
            AttachmentDownloadFact::public_persisted_reference(
                viewer.clone(),
                requested.clone(),
                record("a", "c"),
                &AttachmentId::parse("foreign").unwrap(),
                &ConversationId::parse("c").unwrap(),
            )
            .is_err()
        );
        assert!(
            AttachmentDownloadFact::public_persisted_reference(
                viewer,
                requested,
                record("a", "c"),
                &AttachmentId::parse("a").unwrap(),
                &ConversationId::parse("foreign").unwrap(),
            )
            .is_err()
        );
    }

    #[test]
    fn list_query_owns_bounds_and_half_open_time_window() {
        assert!(AttachmentListQuery::new(0, None, None, None, None).is_err());
        assert!(AttachmentListQuery::new(101, None, None, None, None).is_err());
        assert!(AttachmentListQuery::new(50, None, None, Some(5), Some(5)).is_err());
        assert!(AttachmentListQuery::new(50, None, None, Some(-1), None).is_err());
        assert!(
            AttachmentListQuery::new(
                50,
                None,
                None,
                Some(ATTACHMENT_WIRE_MAX_SAFE_INTEGER + 1),
                None,
            )
            .is_err()
        );
        assert!(
            AttachmentListCursor::new(
                ATTACHMENT_WIRE_MAX_SAFE_INTEGER + 1,
                AttachmentId::parse("a").unwrap(),
            )
            .is_err()
        );
        assert!(AttachmentListQuery::new(50, None, None, Some(4), Some(5)).is_ok());
    }

    #[test]
    fn attachment_wire_scalars_reject_values_above_ecmascript_safe_integer() {
        let max = ATTACHMENT_WIRE_MAX_SAFE_INTEGER;
        let projected = |size, revision, created_at| {
            AttachmentRecord::projected(
                AttachmentId::parse("a").unwrap(),
                ConversationId::parse("c").unwrap(),
                None,
                AttachmentFilename::parse("a.bin").unwrap(),
                size,
                AttachmentContentType::parse("application/octet-stream").unwrap(),
                StoredBlob::new(
                    StorageKind::Local,
                    BlobStorageKey::parse("a/b.bin").unwrap(),
                ),
                revision,
                AttachmentCreator::Human(UserId::parse("u").unwrap()),
                created_at,
            )
        };
        assert!(projected(max, max, max).is_ok());
        assert!(projected(max + 1, 1, 1).is_err());
        assert!(projected(1, max + 1, 1).is_err());
        assert!(projected(1, 1, max + 1).is_err());
    }

    #[test]
    fn page_cursor_must_name_the_exact_page_tail() {
        let viewer = UserId::parse("u").unwrap();
        let conversation = ConversationId::parse("c").unwrap();
        let query = AttachmentListQuery::new(1, None, None, None, None).unwrap();
        let source = AttachmentListSource::projected(
            MessageId::parse("m").unwrap(),
            conversation.clone(),
            None,
            MessageSeq::try_from(1).unwrap(),
            None,
            AttachmentSourceActor::System,
            8,
        )
        .unwrap();
        let item = AttachmentListItem::projected(
            AttachmentId::parse("a").unwrap(),
            record("a", "c"),
            source,
            &conversation,
        )
        .unwrap();
        assert!(
            AttachmentListPage::projected(
                viewer,
                conversation,
                query,
                vec![item],
                Some(
                    AttachmentListCursor::new(8, AttachmentId::parse("foreign").unwrap()).unwrap()
                ),
            )
            .is_err()
        );
    }
}
