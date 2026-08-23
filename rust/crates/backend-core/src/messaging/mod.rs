//! Messaging application boundary: the real create-message contract.
//!
//! Driver-free. Wire projection and persistence live in sibling crates and both
//! project from the facts defined here.

pub mod attachments;
pub mod freshness;

use std::future::Future;

use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};

use crate::persistence::PersistenceFailure;

/// UTF-8 bytes. Rust's `str::len()` is already a byte count, so the "bytes, not
/// UTF-16 code units" distinction cannot be lost here.
pub const MAX_MESSAGE_CONTENT_BYTES: usize = 64 * 1024;
pub const MAX_MESSAGE_CONTENT_LABEL: &str = "64KiB";
/// Envelope bound for a send request: worst-case JSON escaping of a full-size
/// body plus headroom. Distinct from the content cap and reported separately.
pub const MESSAGE_SEND_MAX_BODY_BYTES: usize = 6 * 64 * 1024 + 128 * 1024;
pub const MAX_MESSAGE_ATTACHMENTS: usize = 20;

pub fn content_byte_length(content: &str) -> usize {
    content.len()
}

pub fn content_exceeds_limit(content: &str) -> bool {
    content.len() > MAX_MESSAGE_CONTENT_BYTES
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
            /// Rejects only emptiness. An identity also arrives from the wire,
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

#[derive(Debug, thiserror::Error)]
#[error("system entropy is unavailable")]
pub struct EntropyUnavailable;

/// Bytes of entropy behind a minted message id. Twelve encode to exactly sixteen
/// base64url characters with no padding, which is the identity clients already
/// hold.
const MESSAGE_ID_ENTROPY_BYTES: usize = 12;

impl MessageId {
    /// Mints a new identity. The format is part of what this system publishes, so
    /// it is owned here rather than by whichever store happens to write the row.
    pub fn mint() -> Result<Self, EntropyUnavailable> {
        let mut bytes = [0u8; MESSAGE_ID_ENTROPY_BYTES];
        getrandom::fill(&mut bytes).map_err(|_| EntropyUnavailable)?;
        Ok(Self(URL_SAFE_NO_PAD.encode(bytes)))
    }
}

impl MessageSeq {
    /// The store is the only origin: it advances the conversation's counter and
    /// hands back what it reserved.
    pub fn reserved(value: i64) -> Self {
        Self(value)
    }

    /// The wire carries a JSON number, so decoding validates rather than casts.
    pub fn decode(value: i64) -> Result<Self, InvalidSeq> {
        if value < 0 {
            return Err(InvalidSeq);
        }
        Ok(Self(value))
    }

    pub fn get(self) -> i64 {
        self.0
    }
}

#[derive(Debug, thiserror::Error)]
#[error("message seq must be a non-negative integer")]
pub struct InvalidSeq;

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
    /// about them: a store that answered "read-only" would be a second authority
    /// free to drift from this one.
    pub direct_pair: Option<DirectPairEndpoints>,
}

/// Why a write was refused. Each refusal carries the wire code it is identified
/// by; choosing a status from it is the transport adapter's business.
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

impl ConversationRefusal {
    pub fn code(&self) -> &'static str {
        match self {
            Self::NotFound => "conversation_not_found",
            Self::Closed => "conversation_closed",
            Self::Archived => "conversation_archived",
            Self::EndpointGone => "conversation_endpoint_gone",
        }
    }
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

impl ActorRefusal {
    pub fn code(&self) -> &'static str {
        match self {
            Self::AgentNotFound => "agent_not_found",
            Self::AgentNotParticipant => "agent_not_participant_of_conversation",
            Self::UserNotParticipant => "user_not_participant_of_conversation",
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq, thiserror::Error)]
#[error("target message not found in target conversation")]
pub struct ReplyTargetRefusal;

impl ReplyTargetRefusal {
    pub fn code(&self) -> &'static str {
        "reply_target_not_found"
    }
}

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
    pub fn code(&self) -> &'static str {
        match self {
            Self::OutsideChannel { .. } => "attachment_outside_channel",
            Self::LabelKindMismatch { .. } => "attachment_label_kind_mismatch",
        }
    }

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
#[error(
    "message is stale: this runtime has undelivered input it must consume before sending (drain it, or resend with --anyway)"
)]
pub struct StaleRefusal {
    pub stale_event_id: freshness::StaleEventId,
    pub target_conversation_id: ConversationId,
}

impl StaleRefusal {
    pub fn code(&self) -> &'static str {
        "message_stale"
    }
}

/// Everything that can stop a send. Concrete per family: a caller can act on the
/// distinction, and no status code appears at this layer.
#[derive(Debug, thiserror::Error)]
pub enum SendMessageError {
    #[error(transparent)]
    Conversation(#[from] ConversationRefusal),
    #[error(transparent)]
    Actor(#[from] ActorRefusal),
    #[error(transparent)]
    ReplyTarget(#[from] ReplyTargetRefusal),
    #[error(transparent)]
    Attachment(#[from] AttachmentRefusal),
    #[error(transparent)]
    Stale(#[from] StaleRefusal),
    #[error(transparent)]
    Invariant(#[from] freshness::FreshnessGuardInvariant),
    #[error(transparent)]
    Persistence(#[from] PersistenceFailure),
}

impl SendMessageError {
    /// The wire code identifying this refusal, or `None` when the send failed for
    /// a reason the domain has no answer for: an infrastructure failure and a
    /// violated invariant are both this system's fault, not a caller's, and
    /// naming them would invite a caller to handle them.
    pub fn code(&self) -> Option<&'static str> {
        match self {
            Self::Conversation(refusal) => Some(refusal.code()),
            Self::Actor(refusal) => Some(refusal.code()),
            Self::ReplyTarget(refusal) => Some(refusal.code()),
            Self::Attachment(refusal) => Some(refusal.code()),
            Self::Stale(refusal) => Some(refusal.code()),
            Self::Invariant(_) | Self::Persistence(_) => None,
        }
    }
}

/// Where a send lands within its conversation.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum SendDestination {
    MainLine,
    /// A reply cluster named directly, as an address already resolved against the
    /// target conversation.
    Thread(ThreadRootId),
    /// A reply to one message. The cluster follows from that message, so it is
    /// resolved inside the atomic unit.
    Reply(MessageId),
}

/// One create-message request, as the application states it.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SendMessage {
    /// The conversation the sender is bound to. It keys freshness — the sender's
    /// own field of view — and is not necessarily where the message lands.
    pub source_conversation: ConversationId,
    pub target_conversation: ConversationId,
    pub actor: SendActor,
    pub content: String,
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
    /// Present only for a reply: absolute counts computed inside the atomic unit
    /// so they already include the message being reported.
    pub projections: Option<ThreadProjections>,
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
    pub content: String,
    pub attachments: Vec<attachments::AttachmentSnapshot>,
    pub seq: MessageSeq,
    pub created_at_ms: i64,
    pub thread_root_id: Option<ThreadRootId>,
}

/// Reply-cluster absolutes. Viewer-invariant: they describe the cluster, not one
/// reader's view of it.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ThreadProjections {
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
    use std::collections::HashSet;

    use super::*;

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

    #[test]
    fn the_content_cap_counts_utf8_bytes() {
        let three_byte_chars = "汉".repeat(MAX_MESSAGE_CONTENT_BYTES / 3);

        assert_eq!(content_byte_length("汉"), 3);
        assert!(!content_exceeds_limit(&three_byte_chars));
        assert!(content_exceeds_limit(
            &"汉".repeat(MAX_MESSAGE_CONTENT_BYTES)
        ));
        assert!(!content_exceeds_limit(
            &"a".repeat(MAX_MESSAGE_CONTENT_BYTES)
        ));
        assert!(content_exceeds_limit(
            &"a".repeat(MAX_MESSAGE_CONTENT_BYTES + 1)
        ));
    }

    #[test]
    fn the_envelope_bound_is_separate_from_the_content_cap() {
        assert_eq!(MAX_MESSAGE_CONTENT_BYTES, 65_536);
        assert_eq!(MESSAGE_SEND_MAX_BODY_BYTES, 524_288);
    }

    #[test]
    fn an_ordinal_is_reserved_by_the_store_and_validated_from_the_wire() {
        assert_eq!(MessageSeq::reserved(7).get(), 7);
        assert_eq!(MessageSeq::decode(0).unwrap().get(), 0);
        assert!(MessageSeq::decode(-1).is_err());
        assert!(MessageSeq::reserved(2) > MessageSeq::reserved(1));
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

    /// The published identity: sixteen base64url characters, unpadded, distinct
    /// per mint.
    #[test]
    fn a_minted_message_id_has_the_shape_clients_already_hold() {
        let first = MessageId::mint().unwrap();
        let second = MessageId::mint().unwrap();

        assert_ne!(first, second);
        assert_eq!(first.as_str().len(), 16);
        assert!(
            first
                .as_str()
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_'),
            "minted id left the base64url alphabet: {}",
            first.as_str()
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
        assert_eq!(error.code(), Some("conversation_closed"));
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

        assert_eq!(error.code(), Some("conversation_archived"));
    }

    #[tokio::test]
    async fn a_missing_conversation_answers_not_found() {
        let mut reads = FakeReads::default();

        let error = assert_post_authority(&mut reads, &conversation(), &agent())
            .await
            .unwrap_err();

        assert_eq!(error.code(), Some("conversation_not_found"));
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

        assert_eq!(
            assert_post_authority(&mut unknown, &conversation(), &agent())
                .await
                .unwrap_err()
                .code(),
            Some("agent_not_found")
        );
        assert_eq!(
            assert_post_authority(&mut known_but_outside, &conversation(), &agent())
                .await
                .unwrap_err()
                .code(),
            Some("agent_not_participant_of_conversation")
        );
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

        assert_eq!(error.code(), Some("user_not_participant_of_conversation"));
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

        assert_eq!(error.code(), Some("conversation_endpoint_gone"));
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

        assert_eq!(error.code(), Some("conversation_endpoint_gone"));
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

    #[test]
    fn an_infrastructure_failure_publishes_no_domain_code() {
        #[derive(Debug, thiserror::Error)]
        #[error("driver refused the statement")]
        struct Driver;

        let error = SendMessageError::from(PersistenceFailure::from_source(Driver));

        assert_eq!(error.code(), None);
    }

    /// An undeterminable freshness scope is this system's fault, so it carries no
    /// code a caller could branch on.
    #[test]
    fn a_violated_invariant_publishes_no_domain_code() {
        let error = SendMessageError::from(freshness::FreshnessGuardInvariant::AgentAbsent {
            agent: AgentId::parse("agent-1").unwrap(),
        });

        assert_eq!(error.code(), None);
    }

    #[test]
    fn a_stale_refusal_carries_signal_metadata_only() {
        let refusal = StaleRefusal {
            stale_event_id: freshness::StaleEventId::mint().unwrap(),
            target_conversation_id: conversation(),
        };

        assert_eq!(refusal.code(), "message_stale");
        assert!(refusal.to_string().contains("undelivered input"));
    }

    #[test]
    fn an_attachment_refusal_names_the_reference_it_rejected() {
        let refusal = AttachmentRefusal::OutsideChannel {
            attachment_id: AttachmentId::parse("att-1").unwrap(),
        };

        assert_eq!(refusal.code(), "attachment_outside_channel");
        assert_eq!(refusal.attachment_id().as_str(), "att-1");
    }
}
