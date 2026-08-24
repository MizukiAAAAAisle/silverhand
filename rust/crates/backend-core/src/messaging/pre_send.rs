//! Request-layer authorities consulted before a message write begins.
//!
//! These reads shape a refusal; they never grant the later transaction permission
//! to write. The write unit rechecks every mutable participation and lifecycle fact.

use std::{error::Error, future::Future};

use crate::identity::{AgentId, ConversationId, UserId};

use super::ThreadRootId;

#[derive(Clone, Copy, Debug, Eq, PartialEq, thiserror::Error)]
pub enum ChannelAccessRefusal {
    #[error("channel not found")]
    NotFound,
    #[error("caller may not post to this channel")]
    Forbidden,
}

pub trait ChannelAccess {
    type Error: Error + Send + Sync + 'static;

    fn may_post(
        &self,
        channel: &ConversationId,
        author: &UserId,
    ) -> impl Future<Output = Result<Result<(), ChannelAccessRefusal>, Self::Error>> + Send;
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, thiserror::Error)]
pub enum AddressRefusal {
    #[error("target is not an address")]
    Malformed,
    #[error("a direct message needs another participant")]
    SelfPair,
    #[error("target names no stream the caller may use")]
    Unresolved,
    #[error("target names no reply cluster of that conversation")]
    ThreadNotInTarget,
}

/// The private branch behind an actor-facing target refusal.
///
/// These values belong to the operator record, never to the HTTP response. Keeping
/// them on the required observation port rather than on [`AddressRefusal`] makes
/// unknown and unauthorized targets indistinguishable to the caller by type.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum TargetAddressOperatorReason {
    Grammar,
    ConversationNotFound,
    WorkspaceNotFound,
    WorkspaceAmbiguous,
    TitleNotFound,
    NotParticipant,
    UnknownHandle,
    DirectPairNotFound,
    SelfPair,
    ThreadRootNotFound,
    ThreadRootNotARoot,
}

impl TargetAddressOperatorReason {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Grammar => "grammar",
            Self::ConversationNotFound => "conversation_not_found",
            Self::WorkspaceNotFound => "workspace_not_found",
            Self::WorkspaceAmbiguous => "workspace_ambiguous",
            Self::TitleNotFound => "title_not_found",
            Self::NotParticipant => "not_participant",
            Self::UnknownHandle => "unknown_handle",
            Self::DirectPairNotFound => "direct_pair_not_found",
            Self::SelfPair => "self_pair",
            Self::ThreadRootNotFound => "thread_root_not_found",
            Self::ThreadRootNotARoot => "thread_root_not_a_root",
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum DeliveryIntent {
    Write,
}

/// One operator-only account of a refused target resolution.
///
/// Deliberately not `Debug`: the raw address is needed by the observation
/// capability but must not become printable by accident. A production observer
/// can hash it before logging, while a deterministic test observer can inspect it.
pub struct TargetAddressRefusalReport {
    refusal: AddressRefusal,
    reason: TargetAddressOperatorReason,
    address: String,
    principal: AgentId,
    intent: DeliveryIntent,
}

impl TargetAddressRefusalReport {
    pub fn new(
        refusal: AddressRefusal,
        reason: TargetAddressOperatorReason,
        address: impl Into<String>,
        principal: AgentId,
        intent: DeliveryIntent,
    ) -> Self {
        Self {
            refusal,
            reason,
            address: address.into(),
            principal,
            intent,
        }
    }

    pub fn refusal(&self) -> AddressRefusal {
        self.refusal
    }

    pub fn reason(&self) -> TargetAddressOperatorReason {
        self.reason
    }

    pub fn address(&self) -> &str {
        &self.address
    }

    pub fn principal(&self) -> &AgentId {
        &self.principal
    }

    pub fn intent(&self) -> DeliveryIntent {
        self.intent
    }
}

/// Required operator-only exit for target refusals.
///
/// A sink failure is an authority failure: silently returning the collapsed
/// actor answer would discard the only record explaining which branch fired.
pub trait TargetAddressRefusalPort {
    type Error: Error + Send + Sync + 'static;

    fn refused(
        &self,
        report: &TargetAddressRefusalReport,
    ) -> impl Future<Output = Result<(), Self::Error>> + Send;
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ResolvedStream {
    pub conversation: ConversationId,
    pub thread_root: Option<ThreadRootId>,
}

/// A conversation-scoped runtime may resolve an existing line but may not create
/// a new one that its credential could not reach.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum DirectPairAllocation {
    Permitted,
    Forbidden,
}

pub trait TargetAddress {
    type Error: Error + Send + Sync + 'static;

    fn resolve(
        &self,
        agent: &AgentId,
        target: &str,
        allocation: DirectPairAllocation,
    ) -> impl Future<Output = Result<Result<ResolvedStream, AddressRefusal>, Self::Error>> + Send;
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, thiserror::Error)]
#[error("credential lacks the send_messages grant")]
pub struct CapabilityDenied;

pub trait SendCapability {
    type Error: Error + Send + Sync + 'static;

    fn may_send_messages(
        &self,
        agent: &AgentId,
        conversation: &ConversationId,
    ) -> impl Future<Output = Result<Result<(), CapabilityDenied>, Self::Error>> + Send;
}
