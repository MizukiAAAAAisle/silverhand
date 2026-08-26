//! Narrow messaging prerequisites consumed by workspace rename.
//!
//! This module does not own workspace mutation, runtime delivery, publication or
//! viewer events. It owns only the two messaging facts that #2193 consumes:
//! which open-roster workspace channels are not closed, and one committed
//! system rename message in each selected conversation.

use std::{error::Error, future::Future};

use crate::{
    identity::{ConversationId, WorkspaceId},
    messaging::{MessageId, MessageSeq, markdown::inline_code},
};

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct WorkspaceRenameChannel {
    workspace: WorkspaceId,
    conversation: ConversationId,
}

impl WorkspaceRenameChannel {
    pub fn selected(workspace: WorkspaceId, conversation: ConversationId) -> Self {
        Self {
            workspace,
            conversation,
        }
    }

    pub fn conversation(&self) -> &ConversationId {
        &self.conversation
    }
}

/// All non-closed open-roster channels selected for one workspace rename.
///
/// Archive state is intentionally absent: the existing product announces into
/// archived channels too. Agent-home/fixed-roster conversations are not members
/// of this population.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct WorkspaceRenameChannels {
    workspace: WorkspaceId,
    channels: Vec<WorkspaceRenameChannel>,
}

impl WorkspaceRenameChannels {
    pub fn selected(
        workspace: WorkspaceId,
        mut channels: Vec<WorkspaceRenameChannel>,
    ) -> Result<Self, WorkspaceRenameChannelProjectionError> {
        if channels.iter().any(|row| row.workspace != workspace) {
            return Err(WorkspaceRenameChannelProjectionError::ForeignWorkspace);
        }
        channels.sort_unstable_by(|left, right| {
            left.conversation.as_str().cmp(right.conversation.as_str())
        });
        if channels
            .windows(2)
            .any(|pair| pair[0].conversation == pair[1].conversation)
        {
            return Err(WorkspaceRenameChannelProjectionError::DuplicateConversation);
        }
        Ok(Self {
            workspace,
            channels,
        })
    }

    pub fn bind(
        self,
        requested: &WorkspaceId,
    ) -> Result<BoundWorkspaceRenameChannels, WorkspaceRenameChannelIdentityMismatch> {
        if &self.workspace != requested
            || self.channels.iter().any(|row| &row.workspace != requested)
        {
            return Err(WorkspaceRenameChannelIdentityMismatch);
        }
        Ok(BoundWorkspaceRenameChannels(self))
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct BoundWorkspaceRenameChannels(WorkspaceRenameChannels);

impl BoundWorkspaceRenameChannels {
    pub fn channels(&self) -> &[WorkspaceRenameChannel] {
        &self.0.channels
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, thiserror::Error)]
pub enum WorkspaceRenameChannelProjectionError {
    #[error("workspace rename channel came from another workspace")]
    ForeignWorkspace,
    #[error("workspace rename channel population contains a duplicate conversation")]
    DuplicateConversation,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, thiserror::Error)]
#[error("workspace rename channel population differs from the requested workspace")]
pub struct WorkspaceRenameChannelIdentityMismatch;

pub trait WorkspaceRenameChannelsReadPort {
    type Error: Error + Send + Sync + 'static;

    fn list_non_closed(
        &self,
        workspace: &WorkspaceId,
    ) -> impl Future<Output = Result<WorkspaceRenameChannels, Self::Error>> + Send;
}

pub async fn read_workspace_rename_channels<P: WorkspaceRenameChannelsReadPort>(
    port: &P,
    workspace: WorkspaceId,
) -> Result<BoundWorkspaceRenameChannels, WorkspaceRenameChannelReadError<P::Error>> {
    let selected = port
        .list_non_closed(&workspace)
        .await
        .map_err(WorkspaceRenameChannelReadError::Persistence)?;
    selected.bind(&workspace).map_err(Into::into)
}

#[derive(Debug, thiserror::Error)]
pub enum WorkspaceRenameChannelReadError<E: Error + 'static> {
    #[error("workspace rename channel read failed")]
    Persistence(#[source] E),
    #[error(transparent)]
    Identity(#[from] WorkspaceRenameChannelIdentityMismatch),
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct WorkspaceRenameMessageDraft {
    workspace: WorkspaceId,
    conversation: ConversationId,
    old_name: String,
    new_name: String,
    content: String,
}

impl WorkspaceRenameMessageDraft {
    /// Constructs the deterministic system body and its structured rename
    /// metadata inputs. Name canonicality remains owned by #2193; this seam
    /// neither reparses nor refolds workspace names.
    pub fn for_names(
        workspace: WorkspaceId,
        conversation: ConversationId,
        old_name: impl Into<String>,
        new_name: impl Into<String>,
    ) -> Self {
        let old_name = old_name.into();
        let new_name = new_name.into();
        let content = format!(
            "This workspace was renamed from {} to {}. Update any references in your MEMORY.md when you next edit it.",
            inline_code(&old_name),
            inline_code(&new_name)
        );
        Self {
            workspace,
            conversation,
            old_name,
            new_name,
            content,
        }
    }

    pub fn workspace(&self) -> &WorkspaceId {
        &self.workspace
    }
    pub fn conversation(&self) -> &ConversationId {
        &self.conversation
    }
    pub fn old_name(&self) -> &str {
        &self.old_name
    }
    pub fn new_name(&self) -> &str {
        &self.new_name
    }
    pub fn content(&self) -> &str {
        &self.content
    }
    pub const fn subtype(&self) -> &'static str {
        "rename"
    }
    pub const fn scope(&self) -> &'static str {
        "workspace"
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct WorkspaceRenameMessageCreatedAt(i64);

impl WorkspaceRenameMessageCreatedAt {
    const MAX_JAVASCRIPT_INTEGER: i64 = 9_007_199_254_740_991;

    pub fn new(value: i64) -> Result<Self, InvalidWorkspaceRenameMessageCreatedAt> {
        (0..=Self::MAX_JAVASCRIPT_INTEGER)
            .contains(&value)
            .then_some(Self(value))
            .ok_or(InvalidWorkspaceRenameMessageCreatedAt)
    }

    pub const fn get(self) -> i64 {
        self.0
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, thiserror::Error)]
#[error("workspace rename message created_at is outside its wire domain")]
pub struct InvalidWorkspaceRenameMessageCreatedAt;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CommittedWorkspaceRenameMessage {
    draft: WorkspaceRenameMessageDraft,
    message: MessageId,
    seq: MessageSeq,
    created_at: WorkspaceRenameMessageCreatedAt,
}

impl CommittedWorkspaceRenameMessage {
    pub fn committed(
        draft: WorkspaceRenameMessageDraft,
        message: MessageId,
        seq: MessageSeq,
        created_at: WorkspaceRenameMessageCreatedAt,
    ) -> Self {
        Self {
            draft,
            message,
            seq,
            created_at,
        }
    }

    pub fn bind(
        self,
        requested: &WorkspaceRenameMessageDraft,
    ) -> Result<BoundWorkspaceRenameMessage, WorkspaceRenameMessageIdentityMismatch> {
        if &self.draft != requested {
            return Err(WorkspaceRenameMessageIdentityMismatch);
        }
        Ok(BoundWorkspaceRenameMessage(self))
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct BoundWorkspaceRenameMessage(CommittedWorkspaceRenameMessage);

impl BoundWorkspaceRenameMessage {
    pub fn draft(&self) -> &WorkspaceRenameMessageDraft {
        &self.0.draft
    }
    pub fn message(&self) -> &MessageId {
        &self.0.message
    }
    pub const fn seq(&self) -> MessageSeq {
        self.0.seq
    }
    pub const fn created_at(&self) -> WorkspaceRenameMessageCreatedAt {
        self.0.created_at
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, thiserror::Error)]
#[error("committed workspace rename message differs from its requested draft")]
pub struct WorkspaceRenameMessageIdentityMismatch;

pub trait WorkspaceRenameMessageAuthorPort {
    type Error: Error + Send + Sync + 'static;

    fn author(
        &self,
        draft: WorkspaceRenameMessageDraft,
    ) -> impl Future<Output = Result<CommittedWorkspaceRenameMessage, Self::Error>> + Send;
}

pub async fn author_workspace_rename_message<P: WorkspaceRenameMessageAuthorPort>(
    port: &P,
    draft: WorkspaceRenameMessageDraft,
) -> Result<BoundWorkspaceRenameMessage, WorkspaceRenameMessageAuthorError<P::Error>> {
    let committed = port
        .author(draft.clone())
        .await
        .map_err(WorkspaceRenameMessageAuthorError::Persistence)?;
    committed.bind(&draft).map_err(Into::into)
}

#[derive(Debug, thiserror::Error)]
pub enum WorkspaceRenameMessageAuthorError<E: Error + 'static> {
    #[error("workspace rename message persistence failed")]
    Persistence(#[source] E),
    #[error(transparent)]
    Identity(#[from] WorkspaceRenameMessageIdentityMismatch),
}

#[cfg(test)]
mod tests {
    use std::convert::Infallible;

    use super::*;

    fn workspace(value: &str) -> WorkspaceId {
        WorkspaceId::parse(value).unwrap()
    }

    fn conversation(value: &str) -> ConversationId {
        ConversationId::parse(value).unwrap()
    }

    #[test]
    fn channel_population_is_workspace_bound_unique_and_projector_ordered() {
        let rows = WorkspaceRenameChannels::selected(
            workspace("w"),
            vec![
                WorkspaceRenameChannel::selected(workspace("w"), conversation("z")),
                WorkspaceRenameChannel::selected(workspace("w"), conversation("a")),
            ],
        )
        .unwrap()
        .bind(&workspace("w"))
        .unwrap();
        assert_eq!(
            rows.channels()
                .iter()
                .map(|row| row.conversation().as_str())
                .collect::<Vec<_>>(),
            ["a", "z"]
        );
        assert!(
            WorkspaceRenameChannels::selected(
                workspace("w"),
                vec![WorkspaceRenameChannel::selected(
                    workspace("other"),
                    conversation("a")
                )]
            )
            .is_err()
        );
        assert!(
            WorkspaceRenameChannels::selected(
                workspace("w"),
                vec![
                    WorkspaceRenameChannel::selected(workspace("w"), conversation("a")),
                    WorkspaceRenameChannel::selected(workspace("w"), conversation("a")),
                ]
            )
            .is_err()
        );
    }

    #[derive(Clone)]
    struct SelectedChannels {
        workspace: &'static str,
    }

    impl WorkspaceRenameChannelsReadPort for SelectedChannels {
        type Error = Infallible;

        async fn list_non_closed(
            &self,
            _: &WorkspaceId,
        ) -> Result<WorkspaceRenameChannels, Self::Error> {
            Ok(WorkspaceRenameChannels::selected(
                workspace(self.workspace),
                vec![WorkspaceRenameChannel::selected(
                    workspace(self.workspace),
                    conversation("c"),
                )],
            )
            .unwrap())
        }
    }

    #[tokio::test]
    async fn read_use_case_binds_the_returned_workspace_before_consumption() {
        assert!(
            read_workspace_rename_channels(
                &SelectedChannels { workspace: "other" },
                workspace("w")
            )
            .await
            .is_err()
        );
        let bound =
            read_workspace_rename_channels(&SelectedChannels { workspace: "w" }, workspace("w"))
                .await
                .unwrap();
        assert_eq!(bound.channels()[0].conversation().as_str(), "c");
    }

    #[derive(Clone)]
    struct EchoPort {
        committed: WorkspaceRenameMessageDraft,
    }

    impl WorkspaceRenameMessageAuthorPort for EchoPort {
        type Error = Infallible;

        async fn author(
            &self,
            _: WorkspaceRenameMessageDraft,
        ) -> Result<CommittedWorkspaceRenameMessage, Self::Error> {
            Ok(CommittedWorkspaceRenameMessage::committed(
                self.committed.clone(),
                MessageId::parse("message").unwrap(),
                MessageSeq::try_from(2).unwrap(),
                WorkspaceRenameMessageCreatedAt::new(3).unwrap(),
            ))
        }
    }

    #[tokio::test]
    async fn deterministic_draft_and_committed_fact_bind_before_consumption() {
        let draft = WorkspaceRenameMessageDraft::for_names(
            workspace("w"),
            conversation("c"),
            "Old`Name",
            "New\nName",
        );
        assert_eq!(draft.subtype(), "rename");
        assert_eq!(draft.scope(), "workspace");
        assert_eq!(
            draft.content(),
            "This workspace was renamed from `` Old`Name `` to `New Name`. Update any references in your MEMORY.md when you next edit it."
        );
        let bound = author_workspace_rename_message(
            &EchoPort {
                committed: draft.clone(),
            },
            draft.clone(),
        )
        .await
        .unwrap();
        assert_eq!(bound.draft(), &draft);
        assert_eq!(bound.message().as_str(), "message");

        let foreign = WorkspaceRenameMessageDraft::for_names(
            workspace("other"),
            conversation("c"),
            "Old`Name",
            "New\nName",
        );
        assert!(
            author_workspace_rename_message(&EchoPort { committed: foreign }, draft)
                .await
                .is_err()
        );
    }

    #[test]
    fn created_at_is_wire_safe() {
        assert!(WorkspaceRenameMessageCreatedAt::new(-1).is_err());
        assert_eq!(WorkspaceRenameMessageCreatedAt::new(0).unwrap().get(), 0);
        assert!(
            WorkspaceRenameMessageCreatedAt::new(
                WorkspaceRenameMessageCreatedAt::MAX_JAVASCRIPT_INTEGER + 1
            )
            .is_err()
        );
    }
}
