use crate::{
    identity::{ConversationId, UserId, WorkspaceId},
    messaging::{
        FromKind, MessageAuthor, MessageId, MessageSeq, PrincipalIdentity, ThreadRootId,
        attachments::AttachmentSnapshot,
        environment::{EnvironmentUnavailable, SendEntropy, base64url},
        task::{TaskId, TaskNumber, TaskStatus, TaskTitle},
    },
};

const SAVED_ID_BYTES: usize = 12;

#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub struct SavedEntryId(String);

impl SavedEntryId {
    pub fn parse(raw: impl Into<String>) -> Result<Self, InvalidSavedEntryId> {
        let raw = raw.into();
        if raw.is_empty() {
            return Err(InvalidSavedEntryId);
        }
        Ok(Self(raw))
    }

    pub fn mint(entropy: &impl SendEntropy) -> Result<Self, EnvironmentUnavailable> {
        let mut bytes = [0_u8; SAVED_ID_BYTES];
        entropy.fill(&mut bytes)?;
        Ok(Self(base64url(&bytes)))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, thiserror::Error)]
#[error("saved entry id must not be empty")]
pub struct InvalidSavedEntryId;

#[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd)]
pub struct SavedAt(i64);

impl SavedAt {
    pub fn new(value: i64) -> Result<Self, InvalidSavedAt> {
        if value < 0 {
            return Err(InvalidSavedAt);
        }
        Ok(Self(value))
    }

    pub fn get(self) -> i64 {
        self.0
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, thiserror::Error)]
#[error("saved timestamp must be non-negative")]
pub struct InvalidSavedAt;

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum SavedPlace {
    WorkspaceChannel {
        conversation: ConversationId,
        workspace: WorkspaceId,
        channel_name: String,
    },
    DirectPair {
        conversation: ConversationId,
    },
}

impl SavedPlace {
    pub fn conversation(&self) -> &ConversationId {
        match self {
            Self::WorkspaceChannel { conversation, .. } | Self::DirectPair { conversation } => {
                conversation
            }
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SavedTaskAssignee {
    principal: PrincipalIdentity,
    name: String,
}

impl SavedTaskAssignee {
    pub fn projected(principal: PrincipalIdentity, name: String) -> Self {
        Self { principal, name }
    }

    pub fn principal(&self) -> &PrincipalIdentity {
        &self.principal
    }

    pub fn name(&self) -> &str {
        &self.name
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SavedLinkedTask {
    pub id: TaskId,
    pub number: TaskNumber,
    pub title: TaskTitle,
    pub status: TaskStatus,
    pub assignee: Option<SavedTaskAssignee>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SavedMessageProjection {
    pub id: MessageId,
    pub conversation: ConversationId,
    pub from_kind: FromKind,
    pub from_agent: Option<crate::identity::AgentId>,
    pub from_user: Option<crate::identity::UserId>,
    pub author: Option<MessageAuthor>,
    pub content: String,
    pub metadata_json: Option<String>,
    pub attachments: Vec<AttachmentSnapshot>,
    pub seq: MessageSeq,
    pub created_at_ms: i64,
    pub thread_root: Option<ThreadRootId>,
    pub linked_task: Option<SavedLinkedTask>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SavedMessage(SavedMessageProjection);

impl SavedMessage {
    pub fn projected(projection: SavedMessageProjection) -> Self {
        Self(projection)
    }

    pub fn projection(&self) -> &SavedMessageProjection {
        &self.0
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SavedEntry {
    source_viewer: UserId,
    id: SavedEntryId,
    message: SavedMessage,
    place: SavedPlace,
    saved_at: SavedAt,
}

impl SavedEntry {
    pub fn projected(
        source_viewer: UserId,
        id: SavedEntryId,
        message: SavedMessage,
        place: SavedPlace,
        saved_at: SavedAt,
    ) -> Result<Self, SavedCoordinateMismatch> {
        if message.projection().conversation != *place.conversation() {
            return Err(SavedCoordinateMismatch);
        }
        Ok(Self {
            source_viewer,
            id,
            message,
            place,
            saved_at,
        })
    }

    pub fn id(&self) -> &SavedEntryId {
        &self.id
    }

    pub fn message(&self) -> &SavedMessage {
        &self.message
    }

    pub fn place(&self) -> &SavedPlace {
        &self.place
    }

    pub fn saved_at(&self) -> SavedAt {
        self.saved_at
    }

    pub fn bind(self, viewer: &UserId) -> Result<BoundSavedEntry, SavedIdentityMismatch> {
        if &self.source_viewer != viewer {
            return Err(SavedIdentityMismatch);
        }
        Ok(BoundSavedEntry(self))
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct BoundSavedEntry(SavedEntry);

impl BoundSavedEntry {
    pub fn entry(&self) -> &SavedEntry {
        &self.0
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, thiserror::Error)]
#[error("saved row and message disagree on conversation")]
pub struct SavedCoordinateMismatch;

#[derive(Clone, Copy, Debug, Eq, PartialEq, thiserror::Error)]
#[error("saved-message fact identity differs from the authenticated request")]
pub struct SavedIdentityMismatch;
