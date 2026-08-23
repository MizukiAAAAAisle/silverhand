//! Messaging application boundary: the real create-message contract.
//!
//! Driver-free and transport-free. Persistence and wire projection live in
//! sibling crates; both project from the facts defined here, and neither's
//! vocabulary — statement text, status codes, wire codes, operator instructions —
//! appears in this module.

pub mod attachments;
pub mod environment;
pub mod freshness;

use std::{error::Error, future::Future};

use crate::persistence::PersistenceFailure;

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

/// A message identity as the application handles it: opaque, and never parsed for
/// meaning once minted.
#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub struct MessageId(String);

/// A conversation-global ordinal. It counts messages in a conversation, not in a
/// stream: a reply and a main-line message draw from the same sequence.
#[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd)]
pub struct MessageSeq(i64);

#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub struct ConversationId(String);

/// The root of a reply cluster. Its only roles are the message row's own column
/// and the stream-head key; it takes no part in ordinal assignment.
#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub struct ThreadRootId(String);

#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub struct AgentId(String);

#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub struct UserId(String);

#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub struct AttachmentId(String);

macro_rules! opaque_id {
    ($name:ident) => {
        impl $name {
            /// Rejects only emptiness. An identity also arrives from outside,
            /// where it is a coordinate rather than a claim, so validating its
            /// shape here would refuse ids this system itself once minted.
            pub fn parse(raw: impl Into<String>) -> Result<Self, EmptyIdentifier> {
                let raw = raw.into();
                if raw.is_empty() {
                    return Err(EmptyIdentifier);
                }
                Ok(Self(raw))
            }

            pub fn as_str(&self) -> &str {
                &self.0
            }

            pub fn into_inner(self) -> String {
                self.0
            }
        }
    };
}

opaque_id!(MessageId);
opaque_id!(ConversationId);
opaque_id!(ThreadRootId);
opaque_id!(AgentId);
opaque_id!(UserId);
opaque_id!(AttachmentId);

#[derive(Debug, thiserror::Error)]
#[error("identifier must not be empty")]
pub struct EmptyIdentifier;

/// Bytes of entropy behind a minted message id. Twelve encode to exactly sixteen
/// base64url characters with no padding, which is the identity clients already
/// hold.
const MESSAGE_ID_ENTROPY_BYTES: usize = 12;

impl MessageId {
    /// Mints a new identity from supplied entropy. The format is part of what this
    /// system publishes, so it is owned here rather than by whichever store writes
    /// the row; the entropy is a capability the caller provides, because reaching
    /// for it implicitly would hide a failure that has to stay reportable.
    pub fn mint(entropy: &impl SendEntropy) -> Result<Self, EnvironmentUnavailable> {
        let mut bytes = [0u8; MESSAGE_ID_ENTROPY_BYTES];
        entropy.fill(&mut bytes)?;
        Ok(Self(environment::base64url(&bytes)))
    }
}

impl MessageSeq {
    pub fn get(self) -> i64 {
        self.0
    }
}

/// The only way to obtain an ordinal, whichever direction it came from. A negative
/// ordinal has no meaning in either, so there is no unchecked constructor for a
/// caller — including a store reading its own column — to prefer.
impl TryFrom<i64> for MessageSeq {
    type Error = InvalidSeq;

    fn try_from(value: i64) -> Result<Self, Self::Error> {
        if value < 0 {
            return Err(InvalidSeq { value });
        }
        Ok(Self(value))
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, thiserror::Error)]
#[error("message ordinal {value} is negative")]
pub struct InvalidSeq {
    pub value: i64,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum FromKind {
    User,
    Agent,
    System,
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

/// Randomness, as a capability rather than an ambient fact of the process. A
/// failure keeps its cause: "no identity could be minted" is only actionable with
/// the reason attached.
pub trait SendEntropy {
    fn fill(&self, buffer: &mut [u8]) -> Result<(), EnvironmentUnavailable>;
}

/// The moment a send happened, likewise a capability. The unit reads it once and
/// reports the same value it stored.
pub trait SendClock {
    fn now_unix_ms(&self) -> Result<i64, EnvironmentUnavailable>;
}

/// The environment could not answer. Not a refusal: the caller did nothing wrong,
/// and nothing about the request would change the outcome.
#[derive(Debug, thiserror::Error)]
#[error("the environment this send depends on could not answer")]
pub struct EnvironmentUnavailable {
    #[source]
    source: Box<dyn Error + Send + Sync + 'static>,
}

impl EnvironmentUnavailable {
    pub fn from_source<E>(source: E) -> Self
    where
        E: Error + Send + Sync + 'static,
    {
        Self {
            source: Box::new(source),
        }
    }
}

/// Which principal kind an endpoint of a direct pair names.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum EndpointKind {
    Human,
    Agent,
}

/// One side of a direct pair. `deleted_at_ms` is the pair's own record of a
/// departure, kept because a principal row can be gone without the pair knowing
/// when.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ConversationEndpoint {
    pub kind: EndpointKind,
    pub id: String,
    pub deleted_at_ms: Option<i64>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DirectPairEndpoints {
    pub a: ConversationEndpoint,
    pub b: ConversationEndpoint,
}

impl DirectPairEndpoints {
    fn both(&self) -> [&ConversationEndpoint; 2] {
        [&self.a, &self.b]
    }
}

/// Lifecycle and placement facts a write gate needs about its target, read inside
/// the atomic unit so a concurrent change cannot slip between check and write.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ConversationFacts {
    pub id: ConversationId,
    pub is_closed: bool,
    pub is_archived: bool,
    /// Present only for a direct pair. The endpoints themselves, not a verdict
    /// about them: a verdict from the store would be a second authority, free to
    /// drift from the one that answers the same question elsewhere.
    pub direct_pair: Option<DirectPairEndpoints>,
}

/// Why a write was refused, as the business reason and nothing else. How a reason
/// is reported — status, code, wording, what an operator should do next — belongs
/// to whichever boundary is speaking.
#[derive(Clone, Debug, Eq, PartialEq, thiserror::Error)]
pub enum ConversationRefusal {
    #[error("conversation not found")]
    NotFound,
    #[error("conversation is closed")]
    Closed,
    #[error("conversation is archived")]
    Archived,
    #[error("the other endpoint of this direct conversation no longer exists")]
    EndpointGone,
}

#[derive(Clone, Debug, Eq, PartialEq, thiserror::Error)]
pub enum ActorRefusal {
    #[error("agent not found")]
    AgentNotFound,
    #[error("agent is not a participant of this conversation")]
    AgentNotParticipant,
    #[error("user is not a participant of this conversation")]
    UserNotParticipant,
}

#[derive(Clone, Debug, Eq, PartialEq, thiserror::Error)]
#[error("target message not found in target conversation")]
pub struct ReplyTargetRefusal;

/// The named root is not a reply cluster of the target conversation. Unknown, from
/// another conversation, and "a reply, so not a root" are one answer: a sender
/// naming a cluster it cannot use learns nothing about what exists.
#[derive(Clone, Debug, Eq, PartialEq, thiserror::Error)]
#[error("no reply cluster of this conversation is named by that root")]
pub struct ThreadRootRefusal;

/// An attachment reference the store would not accept. "Unknown" and "belongs to
/// another conversation" are deliberately one answer, so a reference cannot be
/// used to probe for existence.
#[derive(Clone, Debug, Eq, PartialEq, thiserror::Error)]
pub enum AttachmentRefusal {
    #[error("attachment does not belong to this channel")]
    OutsideChannel { attachment_id: AttachmentId },
    #[error("attachment label kind does not match its content type")]
    LabelKindMismatch { attachment_id: AttachmentId },
}

impl AttachmentRefusal {
    pub fn attachment_id(&self) -> &AttachmentId {
        match self {
            Self::OutsideChannel { attachment_id } | Self::LabelKindMismatch { attachment_id } => {
                attachment_id
            }
        }
    }
}

/// The runtime still owes itself input it has not consumed. Signal only: it
/// carries no message body, no ordinal and no count, because a stale answer must
/// not become a side channel for content the caller has not been delivered.
#[derive(Clone, Debug, Eq, PartialEq, thiserror::Error)]
#[error("this runtime has undelivered input it must consume before sending")]
pub struct StaleRefusal {
    pub stale_event_id: freshness::StaleEventId,
    pub target_conversation_id: ConversationId,
}

/// Everything that can stop a send, concrete per family so a caller can act on the
/// distinction. The last three are this system's own failures rather than answers
/// about the request.
#[derive(Debug, thiserror::Error)]
pub enum SendMessageError {
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

/// One create-message request, as the application states it. Every field is a
/// value that has already satisfied its own invariant.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SendMessage {
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

/// The single business fact of one committed send. Both the acknowledgement and
/// the published event are projections of this value, which is why they cannot
/// disagree.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MessageCreatedFact {
    pub message: CreatedMessage,
    /// Present only for a reply.
    pub thread: Option<ThreadReplyFact>,
    /// The guard was skipped at the sender's request. Carried for the post-commit
    /// record, not for the reply to the caller.
    pub freshness_bypassed: bool,
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
/// Not the whole of what a reply publishes — the cluster's list entry is a second
/// projection and is not part of this fact yet.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ThreadReplyFact {
    pub thread_root_id: ThreadRootId,
    pub reply_count: i64,
}

/// The write unit. One call is one atomic outcome: either the fact below exists
/// and is durable, or nothing was written.
pub trait SendMessageUnitOfWork {
    fn send_message(
        &self,
        command: SendMessage,
    ) -> impl Future<Output = Result<MessageCreatedFact, SendMessageError>> + Send;
}

/// Whether a principal named by an endpoint still exists. The narrow half of the
/// facts the survivor rule needs, kept its own capability so a caller of the rule
/// does not have to hold the whole write gate's reads.
pub trait EndpointPrincipalReads {
    fn endpoint_principal_exists(
        &mut self,
        endpoint: &ConversationEndpoint,
    ) -> impl Future<Output = Result<bool, PersistenceFailure>> + Send;
}

/// Facts the write gate reads inside the atomic unit.
///
/// Reading participation outside the unit would let a concurrent revocation slip
/// between the check and the insert, so these are asked of the transaction's own
/// scope rather than passed in.
///
/// This capability is Messaging's own and stays narrow to the send gate's real
/// rule. The enrollment access port answers a different question — who may enrol
/// an agent — and must not be widened to carry participation facts.
pub trait PostAuthorityReads: EndpointPrincipalReads {
    fn conversation_facts(
        &mut self,
        conversation: &ConversationId,
    ) -> impl Future<Output = Result<Option<ConversationFacts>, PersistenceFailure>> + Send;

    fn agent_exists(
        &mut self,
        agent: &AgentId,
    ) -> impl Future<Output = Result<bool, PersistenceFailure>> + Send;

    /// Participation is placement-based: a workspace channel names its
    /// participants by roster row, a direct pair by its endpoints.
    fn is_agent_participant(
        &mut self,
        conversation: &ConversationId,
        agent: &AgentId,
    ) -> impl Future<Output = Result<bool, PersistenceFailure>> + Send;

    fn is_user_participant(
        &mut self,
        conversation: &ConversationId,
        user: &UserId,
    ) -> impl Future<Output = Result<bool, PersistenceFailure>> + Send;
}

/// A direct pair whose either side has departed accepts no further writes.
///
/// Asked of both endpoints rather than of "the other one": it is a property of
/// the conversation, so a survivor and a bystander are told the same thing. A
/// departure counts twice over — the pair's own tombstone, and the absence of the
/// principal row — because either can be the surviving record of it.
pub async fn direct_pair_is_read_only_for_survivor(
    endpoints: &DirectPairEndpoints,
    reads: &mut impl EndpointPrincipalReads,
) -> Result<bool, PersistenceFailure> {
    for endpoint in endpoints.both() {
        if endpoint.deleted_at_ms.is_some() || !reads.endpoint_principal_exists(endpoint).await? {
            return Ok(true);
        }
    }
    Ok(false)
}

/// The write gate: lifecycle first, then participation, then the direct-pair
/// narrowing. The order is load-bearing — a closed conversation answers with its
/// lifecycle rather than leaking whether the caller is a participant, and the
/// narrowing goes last so only a participant learns that a pair's peer is gone.
pub async fn assert_post_authority(
    reads: &mut impl PostAuthorityReads,
    conversation: &ConversationId,
    actor: &SendActor,
) -> Result<ConversationFacts, SendMessageError> {
    let facts = reads
        .conversation_facts(conversation)
        .await?
        .ok_or(ConversationRefusal::NotFound)?;

    if facts.is_closed {
        return Err(ConversationRefusal::Closed.into());
    }
    if facts.is_archived {
        return Err(ConversationRefusal::Archived.into());
    }

    match actor {
        SendActor::Agent(agent) => {
            if !reads.agent_exists(agent).await? {
                return Err(ActorRefusal::AgentNotFound.into());
            }
            if !reads.is_agent_participant(conversation, agent).await? {
                return Err(ActorRefusal::AgentNotParticipant.into());
            }
        }
        // No existence check mirroring the agent arm: participation is already
        // false for an id that names nobody, so a second lookup would add a
        // second refusal for a case this one covers.
        SendActor::User(user) => {
            if !reads.is_user_participant(conversation, user).await? {
                return Err(ActorRefusal::UserNotParticipant.into());
            }
        }
    }

    if let Some(endpoints) = &facts.direct_pair
        && direct_pair_is_read_only_for_survivor(endpoints, reads).await?
    {
        return Err(ConversationRefusal::EndpointGone.into());
    }

    Ok(facts)
}

#[cfg(test)]
mod tests {
    use std::{
        collections::HashSet,
        sync::atomic::{AtomicUsize, Ordering},
    };

    use super::*;

    /// Entropy with no randomness in it, so an encoding can be asserted exactly.
    struct FixedEntropy(&'static [u8]);

    impl SendEntropy for FixedEntropy {
        fn fill(&self, buffer: &mut [u8]) -> Result<(), EnvironmentUnavailable> {
            buffer.copy_from_slice(&self.0[..buffer.len()]);
            Ok(())
        }
    }

    /// Chosen so the two characters that distinguish base64url from base64 both
    /// appear: a standard encoder would answer `+/+/ABCDEFGHIJKL` here.
    const URL_SAFE_PROBE: &[u8] = &[
        0xfb, 0xff, 0xbf, 0x00, 0x10, 0x83, 0x10, 0x51, 0x87, 0x20, 0x92, 0x8b,
    ];

    fn conversation() -> ConversationId {
        ConversationId::parse("conv-1").unwrap()
    }

    #[derive(Default)]
    struct FakeReads {
        facts: Option<ConversationFacts>,
        known_agents: HashSet<String>,
        known_users: HashSet<String>,
        agent_participants: HashSet<String>,
        user_participants: HashSet<String>,
    }

    impl EndpointPrincipalReads for FakeReads {
        async fn endpoint_principal_exists(
            &mut self,
            endpoint: &ConversationEndpoint,
        ) -> Result<bool, PersistenceFailure> {
            Ok(match endpoint.kind {
                EndpointKind::Agent => self.known_agents.contains(&endpoint.id),
                EndpointKind::Human => self.known_users.contains(&endpoint.id),
            })
        }
    }

    impl PostAuthorityReads for FakeReads {
        async fn conversation_facts(
            &mut self,
            _conversation: &ConversationId,
        ) -> Result<Option<ConversationFacts>, PersistenceFailure> {
            Ok(self.facts.clone())
        }

        async fn agent_exists(&mut self, agent: &AgentId) -> Result<bool, PersistenceFailure> {
            Ok(self.known_agents.contains(agent.as_str()))
        }

        async fn is_agent_participant(
            &mut self,
            _conversation: &ConversationId,
            agent: &AgentId,
        ) -> Result<bool, PersistenceFailure> {
            Ok(self.agent_participants.contains(agent.as_str()))
        }

        async fn is_user_participant(
            &mut self,
            _conversation: &ConversationId,
            user: &UserId,
        ) -> Result<bool, PersistenceFailure> {
            Ok(self.user_participants.contains(user.as_str()))
        }
    }

    fn open_conversation() -> ConversationFacts {
        ConversationFacts {
            id: conversation(),
            is_closed: false,
            is_archived: false,
            direct_pair: None,
        }
    }

    fn live_pair() -> DirectPairEndpoints {
        DirectPairEndpoints {
            a: ConversationEndpoint {
                kind: EndpointKind::Agent,
                id: "agent-1".to_owned(),
                deleted_at_ms: None,
            },
            b: ConversationEndpoint {
                kind: EndpointKind::Human,
                id: "user-1".to_owned(),
                deleted_at_ms: None,
            },
        }
    }

    fn agent_reads() -> FakeReads {
        FakeReads {
            facts: Some(open_conversation()),
            known_agents: HashSet::from(["agent-1".to_owned()]),
            known_users: HashSet::from(["user-1".to_owned()]),
            agent_participants: HashSet::from(["agent-1".to_owned()]),
            ..FakeReads::default()
        }
    }

    fn agent() -> SendActor {
        SendActor::Agent(AgentId::parse("agent-1").unwrap())
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
        ) -> Result<MessageCreatedFact, SendMessageError> {
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
                .send_message(SendMessage {
                    source_conversation: conversation(),
                    target_conversation: conversation(),
                    actor: agent(),
                    content,
                    destination: SendDestination::MainLine,
                    attachment_refs: Vec::new(),
                    freshness_bypass: false,
                })
                .await;
        }

        assert_eq!(unit.calls.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn an_ordinal_has_no_unchecked_constructor() {
        assert_eq!(MessageSeq::try_from(7).unwrap().get(), 7);
        assert_eq!(MessageSeq::try_from(0).unwrap().get(), 0);
        assert_eq!(MessageSeq::try_from(-1).unwrap_err().value, -1);
        assert!(MessageSeq::try_from(2).unwrap() > MessageSeq::try_from(1).unwrap());
    }

    #[test]
    fn identifiers_reject_only_emptiness() {
        assert!(MessageId::parse("").is_err());
        assert_eq!(
            MessageId::parse("Ab_1-cD2eF3gH4i").unwrap().as_str(),
            "Ab_1-cD2eF3gH4i"
        );
        assert_eq!(ConversationId::parse("x").unwrap().as_str(), "x");
    }

    /// The published identity: twelve bytes as sixteen base64url characters with
    /// no padding. Asserted against known entropy, so the encoding itself is
    /// pinned rather than sampled.
    #[test]
    fn a_minted_message_id_encodes_its_entropy_the_way_clients_read_it() {
        let from_probe = MessageId::mint(&FixedEntropy(URL_SAFE_PROBE)).unwrap();
        let from_ascending =
            MessageId::mint(&FixedEntropy(&[0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11])).unwrap();

        assert_eq!(from_probe.as_str(), "-_-_ABCDEFGHIJKL");
        assert_eq!(from_ascending.as_str(), "AAECAwQFBgcICQoL");
        assert_eq!(from_probe.as_str().len(), 16);
        assert!(!from_probe.as_str().contains('='));
    }

    /// Entropy is a capability, so its failure is reportable with the reason
    /// intact rather than collapsing into "could not mint".
    #[test]
    fn a_failing_entropy_source_keeps_its_cause() {
        #[derive(Debug, thiserror::Error)]
        #[error("entropy device is offline")]
        struct Offline;

        struct Broken;

        impl SendEntropy for Broken {
            fn fill(&self, _buffer: &mut [u8]) -> Result<(), EnvironmentUnavailable> {
                Err(EnvironmentUnavailable::from_source(Offline))
            }
        }

        let failure = MessageId::mint(&Broken).unwrap_err();

        assert_eq!(
            failure.source().unwrap().to_string(),
            "entropy device is offline"
        );
    }

    #[tokio::test]
    async fn lifecycle_answers_before_participation() {
        let mut reads = FakeReads {
            facts: Some(ConversationFacts {
                is_closed: true,
                ..open_conversation()
            }),
            ..FakeReads::default()
        };

        let error = assert_post_authority(&mut reads, &conversation(), &agent())
            .await
            .unwrap_err();

        // The actor is not a participant either; the lifecycle answer wins so a
        // closed conversation does not report who may write to it.
        assert!(matches!(
            error,
            SendMessageError::Conversation(ConversationRefusal::Closed)
        ));
    }

    #[tokio::test]
    async fn an_archived_conversation_refuses_before_participation() {
        let mut reads = FakeReads {
            facts: Some(ConversationFacts {
                is_archived: true,
                ..open_conversation()
            }),
            ..FakeReads::default()
        };

        let error = assert_post_authority(&mut reads, &conversation(), &agent())
            .await
            .unwrap_err();

        assert!(matches!(
            error,
            SendMessageError::Conversation(ConversationRefusal::Archived)
        ));
    }

    #[tokio::test]
    async fn a_missing_conversation_answers_not_found() {
        let mut reads = FakeReads::default();

        let error = assert_post_authority(&mut reads, &conversation(), &agent())
            .await
            .unwrap_err();

        assert!(matches!(
            error,
            SendMessageError::Conversation(ConversationRefusal::NotFound)
        ));
    }

    #[tokio::test]
    async fn an_unknown_agent_and_a_non_participant_are_distinct_answers() {
        let mut unknown = FakeReads {
            facts: Some(open_conversation()),
            ..FakeReads::default()
        };
        let mut known_but_outside = FakeReads {
            facts: Some(open_conversation()),
            known_agents: HashSet::from(["agent-1".to_owned()]),
            ..FakeReads::default()
        };

        assert!(matches!(
            assert_post_authority(&mut unknown, &conversation(), &agent())
                .await
                .unwrap_err(),
            SendMessageError::Actor(ActorRefusal::AgentNotFound)
        ));
        assert!(matches!(
            assert_post_authority(&mut known_but_outside, &conversation(), &agent())
                .await
                .unwrap_err(),
            SendMessageError::Actor(ActorRefusal::AgentNotParticipant)
        ));
    }

    #[tokio::test]
    async fn a_non_participant_user_is_named_as_a_user() {
        let mut reads = FakeReads {
            facts: Some(open_conversation()),
            ..FakeReads::default()
        };

        let error = assert_post_authority(
            &mut reads,
            &conversation(),
            &SendActor::User(UserId::parse("user-1").unwrap()),
        )
        .await
        .unwrap_err();

        assert!(matches!(
            error,
            SendMessageError::Actor(ActorRefusal::UserNotParticipant)
        ));
    }

    #[tokio::test]
    async fn a_pair_with_a_tombstoned_endpoint_refuses_its_surviving_participant() {
        let mut endpoints = live_pair();
        endpoints.b.deleted_at_ms = Some(1);
        let mut reads = FakeReads {
            facts: Some(ConversationFacts {
                direct_pair: Some(endpoints),
                ..open_conversation()
            }),
            ..agent_reads()
        };

        let error = assert_post_authority(&mut reads, &conversation(), &agent())
            .await
            .unwrap_err();

        assert!(matches!(
            error,
            SendMessageError::Conversation(ConversationRefusal::EndpointGone)
        ));
    }

    /// A pair can outlive its peer's row without ever being stamped, so absence
    /// of the principal is a departure in its own right.
    #[tokio::test]
    async fn a_pair_whose_peer_row_is_gone_refuses_without_a_tombstone() {
        let mut reads = FakeReads {
            facts: Some(ConversationFacts {
                direct_pair: Some(live_pair()),
                ..open_conversation()
            }),
            known_users: HashSet::new(),
            ..agent_reads()
        };

        let error = assert_post_authority(&mut reads, &conversation(), &agent())
            .await
            .unwrap_err();

        assert!(matches!(
            error,
            SendMessageError::Conversation(ConversationRefusal::EndpointGone)
        ));
    }

    #[tokio::test]
    async fn a_live_pair_accepts_its_participant() {
        let mut reads = FakeReads {
            facts: Some(ConversationFacts {
                direct_pair: Some(live_pair()),
                ..open_conversation()
            }),
            ..agent_reads()
        };

        let facts = assert_post_authority(&mut reads, &conversation(), &agent())
            .await
            .unwrap();

        assert_eq!(facts.id, conversation());
    }

    #[tokio::test]
    async fn an_open_conversation_with_a_participating_actor_passes() {
        let mut reads = agent_reads();

        let facts = assert_post_authority(&mut reads, &conversation(), &agent())
            .await
            .unwrap();

        assert_eq!(facts.id, conversation());
    }

    /// Infrastructure failure keeps its cause and stays distinguishable from a
    /// refusal: nothing about the request would have changed the outcome.
    #[test]
    fn an_infrastructure_failure_is_not_a_refusal() {
        #[derive(Debug, thiserror::Error)]
        #[error("driver refused the statement")]
        struct Driver;

        let error = SendMessageError::from(PersistenceFailure::from_source(Driver));

        assert!(matches!(error, SendMessageError::Persistence(_)));
    }

    #[test]
    fn a_stale_refusal_carries_signal_metadata_only() {
        let refusal = StaleRefusal {
            stale_event_id: freshness::StaleEventId::mint(&FixedEntropy(&[0u8; 16])).unwrap(),
            target_conversation_id: conversation(),
        };

        assert_eq!(refusal.target_conversation_id, conversation());
        assert!(refusal.to_string().contains("undelivered input"));
    }

    #[test]
    fn an_attachment_refusal_names_the_reference_it_rejected() {
        let refusal = AttachmentRefusal::OutsideChannel {
            attachment_id: AttachmentId::parse("att-1").unwrap(),
        };

        assert_eq!(refusal.attachment_id().as_str(), "att-1");
    }
}
