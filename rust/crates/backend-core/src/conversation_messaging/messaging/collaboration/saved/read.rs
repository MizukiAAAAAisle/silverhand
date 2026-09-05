use std::{error::Error, future::Future};

use crate::foundation::identity::{AgentId, UserId, WorkspaceId};

use super::{BoundSavedEntry, SavedAt, SavedEntry, SavedIdentityMismatch};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SavedSince {
    Persisted(SavedAt),
    BeyondPersistedRange,
}

impl SavedSince {
    pub fn new(value: i64) -> Option<Self> {
        SavedAt::new(value).ok().map(Self::Persisted)
    }

    pub fn beyond_persisted_range() -> Self {
        Self::BeyondPersistedRange
    }

    pub fn persisted_value(self) -> Option<i64> {
        match self {
            Self::Persisted(value) => Some(value.get()),
            Self::BeyondPersistedRange => None,
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum SavedSender {
    Human(UserId),
    Agent(AgentId),
}

impl SavedSender {
    pub fn kind(&self) -> &'static str {
        match self {
            Self::Human(_) => "user",
            Self::Agent(_) => "agent",
        }
    }

    pub fn id(&self) -> &str {
        match self {
            Self::Human(id) => id.as_str(),
            Self::Agent(id) => id.as_str(),
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Default)]
pub struct SavedListQuery {
    pub workspace: Option<WorkspaceId>,
    pub since: Option<SavedSince>,
    pub sender: Option<SavedSender>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, thiserror::Error)]
pub enum SavedReadRefusal {
    #[error("workspace not found")]
    WorkspaceNotFound,
    #[error("viewer cannot read this workspace")]
    Forbidden,
}

pub trait SavedReadPort {
    type Error: Error + Send + Sync + 'static;

    fn list(
        &self,
        viewer: &UserId,
        query: SavedListQuery,
    ) -> impl Future<Output = Result<Result<Vec<SavedEntry>, SavedReadRefusal>, Self::Error>> + Send;
}

#[derive(Debug, thiserror::Error)]
pub enum SavedReadExecutionError<E: Error + 'static> {
    #[error("saved-message persistence failed")]
    Persistence(#[source] E),
    #[error(transparent)]
    Identity(#[from] SavedIdentityMismatch),
}

pub async fn list_saved<P: SavedReadPort>(
    port: &P,
    viewer: &UserId,
    query: SavedListQuery,
) -> Result<Result<Vec<BoundSavedEntry>, SavedReadRefusal>, SavedReadExecutionError<P::Error>> {
    let entries = match port
        .list(viewer, query)
        .await
        .map_err(SavedReadExecutionError::Persistence)?
    {
        Ok(entries) => entries,
        Err(refusal) => return Ok(Err(refusal)),
    };
    entries
        .into_iter()
        .map(|entry| entry.bind(viewer).map_err(Into::into))
        .collect::<Result<Vec<_>, _>>()
        .map(Ok)
}

#[cfg(test)]
mod tests {
    use std::convert::Infallible;

    use crate::{
        conversation_messaging::messaging::{
            FromKind, MessageId, MessageSeq, collaboration::saved::*,
        },
        foundation::identity::{ConversationId, UserId},
    };

    struct Port(&'static str);

    impl SavedReadPort for Port {
        type Error = Infallible;

        async fn list(
            &self,
            _: &UserId,
            _: SavedListQuery,
        ) -> Result<Result<Vec<SavedEntry>, SavedReadRefusal>, Self::Error> {
            Ok(Ok(vec![entry(self.0, "message")]))
        }
    }

    fn entry(viewer: &str, message: &str) -> SavedEntry {
        let conversation = ConversationId::parse("conversation").unwrap();
        SavedEntry::projected(
            UserId::parse(viewer).unwrap(),
            SavedEntryId::parse("saved").unwrap(),
            SavedMessage::projected(SavedMessageProjection {
                id: MessageId::parse(message).unwrap(),
                conversation: conversation.clone(),
                from_kind: FromKind::System,
                from_agent: None,
                from_user: None,
                author: None,
                content: String::new(),
                metadata_json: None,
                attachments: Vec::new(),
                seq: MessageSeq::try_from(1).unwrap(),
                created_at_ms: 0,
                thread_root: None,
                linked_task: None,
            }),
            SavedPlace::DirectPair { conversation },
            SavedAt::new(0).unwrap(),
        )
        .unwrap()
    }

    #[tokio::test]
    async fn every_saved_row_binds_its_actual_source_viewer_before_projection() {
        let viewer = UserId::parse("viewer-a").unwrap();
        assert!(
            list_saved(&Port("viewer-b"), &viewer, SavedListQuery::default())
                .await
                .is_err()
        );
        let page = list_saved(&Port("viewer-a"), &viewer, SavedListQuery::default())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(page.len(), 1);
        assert_eq!(
            page[0].entry().message().projection().id.as_str(),
            "message"
        );
    }
}
