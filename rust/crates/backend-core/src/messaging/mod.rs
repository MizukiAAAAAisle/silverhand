//! Messaging application boundary: the real create-message contract.
//!
//! Driver-free. Wire projection and persistence live in sibling crates and both
//! project from the facts defined here.

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

/// A message identity as the application handles it: opaque, minted by the
/// store, never parsed for meaning.
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
            /// Rejects only emptiness. The shape of an id is the minting store's
            /// business, and treating it as parseable here would invent meaning
            /// the wire does not carry.
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

/// Lifecycle and shape facts a write gate needs about its target, read inside
/// the atomic unit so a concurrent change cannot slip between check and write.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ConversationFacts {
    pub id: ConversationId,
    pub is_closed: bool,
    pub is_archived: bool,
    /// Present for a direct pair; a pair whose counterpart principal is gone
    /// refuses writes even though the row still exists.
    pub direct_pair_counterpart_present: Option<bool>,
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
    pub stale_event_id: String,
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
    Persistence(#[from] PersistenceFailure),
}

impl SendMessageError {
    /// The wire code identifying this refusal, or `None` for an infrastructure
    /// failure, which has no domain identity to publish.
    pub fn code(&self) -> Option<&'static str> {
        match self {
            Self::Conversation(refusal) => Some(refusal.code()),
            Self::Actor(refusal) => Some(refusal.code()),
            Self::ReplyTarget(refusal) => Some(refusal.code()),
            Self::Attachment(refusal) => Some(refusal.code()),
            Self::Stale(refusal) => Some(refusal.code()),
            Self::Persistence(_) => None,
        }
    }
}

/// The single business fact of one committed send. Both the HTTP acknowledgement
/// and the published event are projections of this value, which is why they
/// cannot disagree.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MessageCreatedFact {
    pub message: CreatedMessage,
    /// Present only for a reply: absolute counts computed inside the atomic unit
    /// so they already include the message being reported.
    pub projections: Option<ThreadProjections>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CreatedMessage {
    pub id: MessageId,
    pub conversation_id: ConversationId,
    pub from_kind: FromKind,
    pub from_agent_id: Option<AgentId>,
    pub from_user_id: Option<UserId>,
    pub content: String,
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

/// Facts the write gate reads inside the atomic unit.
///
/// Reading participation outside the unit would let a concurrent revocation slip
/// between the check and the insert, so these are asked of the transaction's own
/// scope rather than passed in.
///
/// This capability is Messaging's own and stays narrow to the send gate's real
/// rule. The enrollment access port answers a different question — who may enrol
/// an agent — and must not be widened to carry participation facts.
pub trait PostAuthorityReads {
    fn conversation_facts(
        &mut self,
        conversation: &ConversationId,
    ) -> Result<Option<ConversationFacts>, PersistenceFailure>;

    fn agent_exists(&mut self, agent: &AgentId) -> Result<bool, PersistenceFailure>;

    fn is_agent_participant(
        &mut self,
        conversation: &ConversationId,
        agent: &AgentId,
    ) -> Result<bool, PersistenceFailure>;

    fn is_user_participant(
        &mut self,
        conversation: &ConversationId,
        user: &UserId,
    ) -> Result<bool, PersistenceFailure>;
}

/// The write gate: lifecycle first, then participation, then the direct-pair
/// counterpart. The order is load-bearing — a closed conversation answers with
/// its lifecycle rather than leaking whether the caller is a participant.
pub fn assert_post_authority(
    reads: &mut impl PostAuthorityReads,
    conversation: &ConversationId,
    actor: &SendActor,
) -> Result<ConversationFacts, SendMessageError> {
    let facts = reads
        .conversation_facts(conversation)?
        .ok_or(ConversationRefusal::NotFound)?;

    if facts.is_closed {
        return Err(ConversationRefusal::Closed.into());
    }
    if facts.is_archived {
        return Err(ConversationRefusal::Archived.into());
    }

    match actor {
        SendActor::Agent(agent) => {
            if !reads.agent_exists(agent)? {
                return Err(ActorRefusal::AgentNotFound.into());
            }
            if !reads.is_agent_participant(conversation, agent)? {
                return Err(ActorRefusal::AgentNotParticipant.into());
            }
        }
        SendActor::User(user) => {
            if !reads.is_user_participant(conversation, user)? {
                return Err(ActorRefusal::UserNotParticipant.into());
            }
        }
    }

    if facts.direct_pair_counterpart_present == Some(false) {
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
        agent_participants: HashSet<String>,
        user_participants: HashSet<String>,
    }

    impl PostAuthorityReads for FakeReads {
        fn conversation_facts(
            &mut self,
            _conversation: &ConversationId,
        ) -> Result<Option<ConversationFacts>, PersistenceFailure> {
            Ok(self.facts.clone())
        }

        fn agent_exists(&mut self, agent: &AgentId) -> Result<bool, PersistenceFailure> {
            Ok(self.known_agents.contains(agent.as_str()))
        }

        fn is_agent_participant(
            &mut self,
            _conversation: &ConversationId,
            agent: &AgentId,
        ) -> Result<bool, PersistenceFailure> {
            Ok(self.agent_participants.contains(agent.as_str()))
        }

        fn is_user_participant(
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
            direct_pair_counterpart_present: None,
        }
    }

    fn agent_reads() -> FakeReads {
        FakeReads {
            facts: Some(open_conversation()),
            known_agents: HashSet::from(["agent-1".to_owned()]),
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

    #[test]
    fn lifecycle_answers_before_participation() {
        let mut reads = FakeReads {
            facts: Some(ConversationFacts {
                is_closed: true,
                ..open_conversation()
            }),
            ..FakeReads::default()
        };

        let error = assert_post_authority(&mut reads, &conversation(), &agent()).unwrap_err();

        // The actor is not a participant either; the lifecycle answer wins so a
        // closed conversation does not report who may write to it.
        assert_eq!(error.code(), Some("conversation_closed"));
    }

    #[test]
    fn an_archived_conversation_refuses_before_participation() {
        let mut reads = FakeReads {
            facts: Some(ConversationFacts {
                is_archived: true,
                ..open_conversation()
            }),
            ..FakeReads::default()
        };

        let error = assert_post_authority(&mut reads, &conversation(), &agent()).unwrap_err();

        assert_eq!(error.code(), Some("conversation_archived"));
    }

    #[test]
    fn a_missing_conversation_answers_not_found() {
        let mut reads = FakeReads::default();

        let error = assert_post_authority(&mut reads, &conversation(), &agent()).unwrap_err();

        assert_eq!(error.code(), Some("conversation_not_found"));
    }

    #[test]
    fn an_unknown_agent_and_a_non_participant_are_distinct_answers() {
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
                .unwrap_err()
                .code(),
            Some("agent_not_found")
        );
        assert_eq!(
            assert_post_authority(&mut known_but_outside, &conversation(), &agent())
                .unwrap_err()
                .code(),
            Some("agent_not_participant_of_conversation")
        );
    }

    #[test]
    fn a_non_participant_user_is_named_as_a_user() {
        let mut reads = FakeReads {
            facts: Some(open_conversation()),
            ..FakeReads::default()
        };

        let error = assert_post_authority(
            &mut reads,
            &conversation(),
            &SendActor::User(UserId::parse("user-1").unwrap()),
        )
        .unwrap_err();

        assert_eq!(error.code(), Some("user_not_participant_of_conversation"));
    }

    #[test]
    fn a_half_dead_direct_pair_refuses_its_surviving_participant() {
        let mut reads = FakeReads {
            facts: Some(ConversationFacts {
                direct_pair_counterpart_present: Some(false),
                ..open_conversation()
            }),
            ..agent_reads()
        };

        let error = assert_post_authority(&mut reads, &conversation(), &agent()).unwrap_err();

        assert_eq!(error.code(), Some("conversation_endpoint_gone"));
    }

    #[test]
    fn an_open_conversation_with_a_participating_actor_passes() {
        let mut reads = agent_reads();

        let facts = assert_post_authority(&mut reads, &conversation(), &agent()).unwrap();

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

    #[test]
    fn a_stale_refusal_carries_signal_metadata_only() {
        let refusal = StaleRefusal {
            stale_event_id: "11111111-2222-3333-4444-555555555555".to_owned(),
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
