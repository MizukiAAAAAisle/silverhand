//! Messaging application boundary: the real create-message contract.
//!
//! Driver-free and transport-free. Persistence and wire projection live in
//! sibling crates; both project from the facts defined here, and neither's
//! vocabulary — statement text, status codes, wire codes, operator instructions —
//! appears in this module.
//!
//! One send reads left to right through these modules:
//!
//! - [`identity`] — the identities and ordinals the system mints and publishes,
//!   and the host capabilities a mint depends on.
//! - [`addressing`] — who a body addressed, and the grammar that decides it.
//! - [`command`] — a request with every invariant satisfied, prepared before any
//!   transaction opens.
//! - [`authority`] — what the write is authorized against, read inside the atomic
//!   unit.
//! - [`fact`] — the single business fact of a committed send, and the typed views
//!   each delivery path reads it through.
//!
//! Alongside them sit the concerns that own a rule of their own end to end:
//! [`attachments`], [`freshness`], [`mention_cc`] and [`post_commit`]. A refusal
//! lives with the authority that answers it, which is why `AttachmentRefusal` is in
//! `attachments` and `StaleRefusal` is in `freshness` rather than here.
//!
//! This file is a façade and nothing else. Everything below is a re-export, so
//! `messaging::X` names the same item it always did and no consumer depends on
//! which of these modules a type happens to live in.

pub mod addressing;
pub mod attachments;
pub mod authority;
pub mod command;
pub mod environment;
pub mod fact;
pub mod freshness;
pub mod identity;
pub mod mention_cc;
pub mod post_commit;

pub use addressing::{
    AddressedPrincipals, InvalidHandle, MessageReference, ParticipantHandle, PrincipalKind,
    ReferencePositions,
};
pub use attachments::AttachmentRefusal;
pub use authority::{
    ActorRefusal, ConversationEndpoint, ConversationFacts, ConversationRefusal,
    DirectPairEndpoints, EndpointPrincipalReads, PostAuthorityReads, ReplyTargetRefusal,
    ThreadRootRefusal, assert_post_authority, direct_pair_is_read_only_for_survivor,
};
pub use command::{
    ContentTooLong, DirectLineAuthority, DirectLineGrants, MAX_MESSAGE_CONTENT_BYTES,
    MessageContent, SendActor, SendDestination, SendMessage, SendMessageDraft, SendMessageError,
    SendMessageUnitOfWork,
};
pub use fact::{
    CreatedMessage, FromKind, MainCommittedSend, MessageAuthor, MessageCreatedFact,
    ReplyCommittedSend, ThreadFollowerSource, ThreadReplyFact,
};
pub use freshness::StaleRefusal;
pub use identity::{
    AgentId, AttachmentId, ConversationId, EmptyIdentifier, EnvironmentUnavailable, InvalidSeq,
    MessageId, MessageSeq, NotificationId, SendClock, SendEntropy, ThreadRootId, UserId,
    WorkspaceId,
};
