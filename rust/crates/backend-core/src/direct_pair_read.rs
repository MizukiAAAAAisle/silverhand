//! The authenticated viewer's complete Direct Messages cold read.
//!
//! A direct pair has no workspace coordinate, so it cannot appear in a workspace
//! channel list. This port is the one complete cold authority for the pairs a human
//! viewer is an endpoint of. It is deliberately unpaginated: absence is a product
//! fact (not an omitted page), and the live `direct_pairs_changed` event is only a
//! hint to re-read this value.

use std::future::Future;

use crate::{
    agents::runtime::RuntimeKind,
    identity::{ConversationId, UserId},
    messaging::{ActiveAuthor, AvatarRevision, MessageAuthor, PrincipalIdentity},
    persistence::PersistenceFailure,
};

/// The full list, already ordered oldest-first by the read authority.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DirectPairList {
    items: Vec<DirectPairListItem>,
}

impl DirectPairList {
    pub fn complete(items: Vec<DirectPairListItem>) -> Self {
        Self { items }
    }

    pub fn items(&self) -> &[DirectPairListItem] {
        &self.items
    }
}

/// One existing pair on the viewer's cold face.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DirectPairListItem {
    conversation: ConversationId,
    counterpart: DirectPairCounterpart,
    unread_count: DirectPairUnreadCount,
    read_only: bool,
    created_at_ms: i64,
}

impl DirectPairListItem {
    pub fn projected(
        conversation: ConversationId,
        counterpart: DirectPairCounterpart,
        unread_count: DirectPairUnreadCount,
        read_only: bool,
        created_at_ms: i64,
    ) -> Self {
        Self {
            conversation,
            counterpart,
            unread_count,
            read_only,
            created_at_ms,
        }
    }

    pub fn conversation(&self) -> &ConversationId {
        &self.conversation
    }

    pub fn counterpart(&self) -> &DirectPairCounterpart {
        &self.counterpart
    }

    pub fn unread_count(&self) -> DirectPairUnreadCount {
        self.unread_count
    }

    pub fn is_read_only(&self) -> bool {
        self.read_only
    }

    pub fn created_at_ms(&self) -> i64 {
        self.created_at_ms
    }
}

/// The other endpoint. Active profiles reuse the same typed current-principal value
/// used by message authors; deleted endpoints retain only their typed coordinate,
/// because a direct-pair row stores no display snapshot.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum DirectPairCounterpart {
    Active(ActiveAuthor),
    Deleted(PrincipalIdentity),
}

impl DirectPairCounterpart {
    pub fn active_agent(
        id: crate::identity::AgentId,
        name: String,
        display_name: String,
        avatar: Option<AvatarRevision>,
        runtime: RuntimeKind,
    ) -> Self {
        let MessageAuthor::Active(active) =
            MessageAuthor::active_agent(id, name, display_name, avatar, runtime)
        else {
            unreachable!("the active-agent constructor always produces its active arm")
        };
        Self::Active(active)
    }

    pub fn active_human(
        id: UserId,
        name: String,
        display_name: String,
        avatar: Option<AvatarRevision>,
    ) -> Self {
        let MessageAuthor::Active(active) =
            MessageAuthor::active_human(id, name, display_name, avatar)
        else {
            unreachable!("the active-human constructor always produces its active arm")
        };
        Self::Active(active)
    }

    pub fn deleted(identity: PrincipalIdentity) -> Self {
        Self::Deleted(identity)
    }
}

/// The non-negative unread roll-up for one pair.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct DirectPairUnreadCount(i64);

impl DirectPairUnreadCount {
    pub fn get(self) -> i64 {
        self.0
    }
}

impl TryFrom<i64> for DirectPairUnreadCount {
    type Error = NegativeUnreadCount;

    fn try_from(value: i64) -> Result<Self, Self::Error> {
        if value < 0 {
            return Err(NegativeUnreadCount);
        }
        Ok(Self(value))
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, thiserror::Error)]
#[error("direct-pair unread count must not be negative")]
pub struct NegativeUnreadCount;

/// Reads the complete set for one already-authenticated human principal.
pub trait DirectPairReadModel {
    fn list_direct_pairs(
        &self,
        viewer: &UserId,
    ) -> impl Future<Output = Result<DirectPairList, PersistenceFailure>> + Send;
}
