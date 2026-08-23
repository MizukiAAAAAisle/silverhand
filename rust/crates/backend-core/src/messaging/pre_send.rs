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
