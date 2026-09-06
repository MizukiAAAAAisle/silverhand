//! One create-message request, from validated content to the port that writes it.
//!
//! Everything here is what a boundary holds BEFORE any transaction: content that
//! has satisfied its own invariant, a destination, the grants an authority answered
//! for, and the derived record of what the body addressed. Preparing is where those
//! stop being independent — a body and the people it addresses are derived together,
//! so they cannot disagree.

use std::{collections::HashSet, future::Future};

use crate::foundation::persistence::PersistenceFailure;

use super::{
    ActorRefusal, AddressedPrincipals, AgentId, ConversationId, ConversationRefusal,
    EnvironmentUnavailable, FromKind, MessageId, ReferencePositions, ReplyTargetRefusal,
    SendMessageOutcome, ThreadRootId, ThreadRootRefusal, UserId, attachments,
    attachments::AttachmentRefusal, freshness, freshness::StaleRefusal,
};

/// The content bound is a UTF-8 byte count. Rust's `str::len()` is already a byte
/// count, so the "bytes, not UTF-16 code units" distinction cannot be lost here.
pub const MAX_MESSAGE_CONTENT_BYTES: usize = 64 * 1024;

/// Message content that has been shown to satisfy the size invariant.
///
/// The invariant travels with the value rather than with a caller's discipline:
/// the only way to obtain one is to pass the check, so no adapter — including a
/// future one — can hand oversized content to the write unit.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MessageContent(String);

impl MessageContent {
    pub fn parse(raw: impl Into<String>) -> Result<Self, ContentTooLong> {
        let raw = raw.into();
        if raw.len() > MAX_MESSAGE_CONTENT_BYTES {
            return Err(ContentTooLong {
                actual_bytes: raw.len(),
                max_bytes: MAX_MESSAGE_CONTENT_BYTES,
            });
        }
        Ok(Self(raw))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }

    pub fn byte_length(&self) -> usize {
        self.0.len()
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, thiserror::Error)]
#[error("message content is {actual_bytes} bytes, above the limit of {max_bytes}")]
pub struct ContentTooLong {
    pub actual_bytes: usize,
    pub max_bytes: usize,
}

/// A logical human send identity. UUID v4 is case-normalized before comparison.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ClientMessageId(String);
impl ClientMessageId {
    pub fn parse(raw: String) -> Result<Self, &'static str> {
        let b = raw.as_bytes();
        if b.len() != 36
            || b[14] != b'4'
            || !matches!(b[19], b'8' | b'9' | b'a' | b'A' | b'b' | b'B')
            || !b.iter().enumerate().all(|(i, c)| {
                if [8, 13, 18, 23].contains(&i) {
                    *c == b'-'
                } else {
                    c.is_ascii_hexdigit()
                }
            })
        {
            return Err("invalid client_message_id");
        }
        Ok(Self(raw.to_ascii_lowercase()))
    }
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

/// Who is asking to write. Identity is resolved at the boundary; this layer only
/// receives the resolved principal.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum SendActor {
    User(UserId),
    Agent(AgentId),
}

impl SendActor {
    pub fn from_kind(&self) -> FromKind {
        match self {
            Self::User(_) => FromKind::User,
            Self::Agent(_) => FromKind::Agent,
        }
    }
}

/// Everything that can stop a send, concrete per family so a caller can act on the
/// distinction. The last three are this system's own failures rather than answers
/// about the request.
#[derive(Debug, thiserror::Error)]
pub enum SendMessageError {
    #[error("client_message_id was already used for a different request")]
    ClientMessageConflict,
    #[error(transparent)]
    Conversation(#[from] ConversationRefusal),
    #[error(transparent)]
    Actor(#[from] ActorRefusal),
    #[error(transparent)]
    ReplyTarget(#[from] ReplyTargetRefusal),
    #[error(transparent)]
    ThreadRoot(#[from] ThreadRootRefusal),
    #[error(transparent)]
    Attachment(#[from] AttachmentRefusal),
    #[error(transparent)]
    Stale(#[from] StaleRefusal),
    #[error(transparent)]
    Invariant(#[from] freshness::FreshnessGuardInvariant),
    #[error(transparent)]
    Environment(#[from] EnvironmentUnavailable),
    #[error(transparent)]
    Persistence(#[from] PersistenceFailure),
}

/// Where a send lands within its conversation.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum SendDestination {
    MainLine,
    /// A reply cluster named by its root. The name is checked inside the atomic
    /// unit: a resolved address is a coordinate, not a capability, so carrying it
    /// here grants nothing.
    Thread(ThreadRootId),
    /// A reply to one message. The cluster follows from that message.
    Reply(MessageId),
}

/// What a boundary holds once it has validated a request: everything a send needs
/// except what can only be derived from the body.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SendMessageDraft {
    /// The conversation the sender is bound to. It keys freshness — the sender's
    /// own field of view — and is not necessarily where the message lands.
    pub source_conversation: ConversationId,
    pub target_conversation: ConversationId,
    pub actor: SendActor,
    pub content: MessageContent,
    pub destination: SendDestination,
    pub attachment_refs: Vec<attachments::AttachmentRef>,
    pub freshness_bypass: bool,
}

/// Which addressed agents this author may open a direct line to.
///
/// Sealed for the same reason the addressed set is: it is a VERDICT, and a caller
/// that could assemble one would be granting itself the right to open a line and
/// deliver a copy through it. The only way to obtain one is [`SendMessage::prepare`],
/// which asks a named authority about this author and these handles.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DirectLineGrants(HashSet<AgentId>);

impl DirectLineGrants {
    pub fn contains(&self, agent: &AgentId) -> bool {
        self.0.contains(agent)
    }

    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }
}

/// Who may open a direct line to whom. A capability boundary owned elsewhere: the
/// question is about a person and the agents their message named, and answering it
/// reads authorization state, which the send's own transaction deliberately cannot
/// do.
pub trait DirectLineAuthority {
    /// The addressed agents this author may open a direct line to, as ids the
    /// authority has itself gated. Asked once per send, before any transaction.
    fn direct_lines(
        &self,
        author: &UserId,
        addressed: &AddressedPrincipals,
    ) -> impl Future<Output = Result<Vec<AgentId>, PersistenceFailure>> + Send;
}

/// One create-message request, prepared: every field has satisfied its own
/// invariant, and what the body addresses has been derived FROM that body.
///
/// The fields are sealed together on purpose. A struct whose content and whose
/// addressed set could be set independently would let the two disagree — a body
/// saying one thing while the send delivers to someone else — so the only way to
/// obtain this value is [`SendMessage::prepare`], which derives one from the
/// other. Deriving happens here, before any transaction: a 64KiB body must not be
/// parsed while the writer is held, and authorization must not be asked from
/// inside it.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SendMessage {
    client_message_id: Option<ClientMessageId>,
    source_conversation: ConversationId,
    target_conversation: ConversationId,
    actor: SendActor,
    content: MessageContent,
    destination: SendDestination,
    attachment_refs: Vec<attachments::AttachmentRef>,
    addressed: AddressedPrincipals,
    direct_lines: DirectLineGrants,
    freshness_bypass: bool,
}

impl SendMessage {
    pub fn with_client_message_id(mut self, id: Option<ClientMessageId>) -> Self {
        self.client_message_id = id;
        self
    }
    pub fn client_message_id(&self) -> Option<&ClientMessageId> {
        self.client_message_id.as_ref()
    }
    /// Derives what the body addresses, then asks the authority which of those the
    /// author may open a line to. An agent author asks nothing: a direct line is a
    /// person's to open, so the grants are empty by construction rather than by a
    /// caller's say-so.
    pub async fn prepare(
        draft: SendMessageDraft,
        positions: &impl ReferencePositions,
        authority: &impl DirectLineAuthority,
    ) -> Result<Self, PersistenceFailure> {
        let addressed = AddressedPrincipals::derive(&draft.content, positions);
        let direct_lines = match &draft.actor {
            SendActor::User(author) => DirectLineGrants(
                authority
                    .direct_lines(author, &addressed)
                    .await?
                    .into_iter()
                    .collect(),
            ),
            SendActor::Agent(_) => DirectLineGrants(HashSet::new()),
        };

        Ok(Self {
            client_message_id: None,
            source_conversation: draft.source_conversation,
            target_conversation: draft.target_conversation,
            actor: draft.actor,
            content: draft.content,
            destination: draft.destination,
            attachment_refs: draft.attachment_refs,
            addressed,
            direct_lines,
            freshness_bypass: draft.freshness_bypass,
        })
    }

    pub fn source_conversation(&self) -> &ConversationId {
        &self.source_conversation
    }

    pub fn target_conversation(&self) -> &ConversationId {
        &self.target_conversation
    }

    pub fn actor(&self) -> &SendActor {
        &self.actor
    }

    pub fn content(&self) -> &MessageContent {
        &self.content
    }

    pub fn destination(&self) -> &SendDestination {
        &self.destination
    }

    pub fn attachment_refs(&self) -> &[attachments::AttachmentRef] {
        &self.attachment_refs
    }

    pub fn addressed(&self) -> &AddressedPrincipals {
        &self.addressed
    }

    pub fn direct_lines(&self) -> &DirectLineGrants {
        &self.direct_lines
    }

    pub fn freshness_bypass(&self) -> bool {
        self.freshness_bypass
    }
}

/// The write unit. One call is one atomic outcome: either the fact below exists
/// and is durable, or nothing was written.
pub trait SendMessageUnitOfWork {
    fn send_message(
        &self,
        command: SendMessage,
    ) -> impl Future<Output = Result<SendMessageOutcome, SendMessageError>> + Send;
}

#[cfg(test)]
mod tests {
    use std::{
        ops::Range,
        sync::atomic::{AtomicUsize, Ordering},
    };

    use super::*;
    use crate::conversation_messaging::messaging::PrincipalKind;

    /// An authority that grants every agent the body addressed, so tests that are
    /// not about authorization do not have to model it.
    struct GrantsEveryAddressedAgent;

    impl DirectLineAuthority for GrantsEveryAddressedAgent {
        async fn direct_lines(
            &self,
            _author: &UserId,
            addressed: &AddressedPrincipals,
        ) -> Result<Vec<AgentId>, PersistenceFailure> {
            Ok(addressed
                .iter()
                .filter(|reference| reference.kind() == PrincipalKind::Agent)
                .map(|reference| AgentId::parse(reference.handle().as_str()).unwrap())
                .collect())
        }
    }

    /// A stand-in position rule: every `<…>` run, wherever it sits. The product
    /// rule is Markdown structure — an autolink in prose, never quoted syntax —
    /// and lives outside this crate.
    struct EveryBracketedRun;

    impl ReferencePositions for EveryBracketedRun {
        fn autolink_spans(&self, content: &MessageContent) -> Vec<Range<usize>> {
            let body = content.as_str();
            let mut spans = Vec::new();
            let mut cursor = 0;
            while let Some(open) = body[cursor..].find('<') {
                let open = cursor + open;
                let Some(close) = body[open..].find('>') else {
                    break;
                };
                let close = open + close;
                spans.push(open..close + 1);
                cursor = close + 1;
            }
            spans
        }
    }

    fn conversation() -> ConversationId {
        ConversationId::parse("conv-1").unwrap()
    }

    fn draft(content: MessageContent) -> SendMessageDraft {
        SendMessageDraft {
            source_conversation: conversation(),
            target_conversation: conversation(),
            actor: SendActor::Agent(AgentId::parse("agent-1").unwrap()),
            content,
            destination: SendDestination::MainLine,
            attachment_refs: Vec::new(),
            freshness_bypass: false,
        }
    }

    /// A unit of work that records whether it was ever asked to write.
    #[derive(Default)]
    struct CountingUnitOfWork {
        calls: AtomicUsize,
    }

    impl SendMessageUnitOfWork for CountingUnitOfWork {
        async fn send_message(
            &self,
            _command: SendMessage,
        ) -> Result<SendMessageOutcome, SendMessageError> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            Err(ConversationRefusal::NotFound.into())
        }
    }

    #[test]
    fn the_content_bound_counts_utf8_bytes() {
        let full = "汉".repeat(MAX_MESSAGE_CONTENT_BYTES / 3);

        assert_eq!(MessageContent::parse("汉").unwrap().byte_length(), 3);
        assert!(MessageContent::parse(&full).is_ok());
        assert!(MessageContent::parse("a".repeat(MAX_MESSAGE_CONTENT_BYTES)).is_ok());
        // Three bytes per character but one UTF-16 code unit: counting the wrong
        // unit would admit three times the intended size.
        let over = MessageContent::parse("汉".repeat(MAX_MESSAGE_CONTENT_BYTES)).unwrap_err();
        assert_eq!(over.actual_bytes, MAX_MESSAGE_CONTENT_BYTES * 3);
        assert_eq!(over.max_bytes, MAX_MESSAGE_CONTENT_BYTES);
        assert!(MessageContent::parse("a".repeat(MAX_MESSAGE_CONTENT_BYTES + 1)).is_err());
    }

    /// The counter-example for the size invariant: an oversized send cannot be
    /// expressed, so no caller can carry one to the write unit.
    #[tokio::test]
    async fn oversized_content_never_reaches_the_write_unit() {
        let unit = CountingUnitOfWork::default();
        let oversized = "a".repeat(MAX_MESSAGE_CONTENT_BYTES + 1);

        if let Ok(content) = MessageContent::parse(&oversized) {
            let _ = unit
                .send_message(
                    SendMessage::prepare(
                        draft(content),
                        &EveryBracketedRun,
                        &GrantsEveryAddressedAgent,
                    )
                    .await
                    .unwrap(),
                )
                .await;
        }

        assert_eq!(unit.calls.load(Ordering::SeqCst), 0);
    }
}
