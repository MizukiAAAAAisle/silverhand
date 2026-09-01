use std::{error::Error, future::Future};

use crate::{foundation::identity::UserId, messaging::MessageId};

use super::{BoundSavedEntry, SavedEntry, SavedIdentityMismatch};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SavedAction {
    Save,
    Unsave,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, thiserror::Error)]
#[error("message not found")]
pub struct SavedMutationRefusal;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SavedChangeFact {
    viewer: UserId,
    message: MessageId,
    action: SavedAction,
}

impl SavedChangeFact {
    fn committed(viewer: UserId, message: MessageId, action: SavedAction) -> Self {
        Self {
            viewer,
            message,
            action,
        }
    }

    pub fn viewer(&self) -> &UserId {
        &self.viewer
    }
    pub fn message(&self) -> &MessageId {
        &self.message
    }
    pub fn action(&self) -> SavedAction {
        self.action
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CommittedSave {
    viewer: UserId,
    message: MessageId,
    entry: SavedEntry,
    changed: bool,
}

impl CommittedSave {
    pub fn committed(viewer: UserId, message: MessageId, entry: SavedEntry, changed: bool) -> Self {
        Self {
            viewer,
            message,
            entry,
            changed,
        }
    }

    pub fn bind(
        self,
        viewer: &UserId,
        message: &MessageId,
    ) -> Result<BoundCommittedSave, SavedIdentityMismatch> {
        if &self.viewer != viewer
            || &self.message != message
            || self.entry.message().projection().id != *message
        {
            return Err(SavedIdentityMismatch);
        }
        let entry = self.entry.bind(viewer)?;
        Ok(BoundCommittedSave {
            viewer: self.viewer,
            message: self.message,
            entry,
            changed: self.changed,
        })
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct BoundCommittedSave {
    viewer: UserId,
    message: MessageId,
    entry: BoundSavedEntry,
    changed: bool,
}

impl BoundCommittedSave {
    pub fn entry(&self) -> &BoundSavedEntry {
        &self.entry
    }
    pub const fn changed(&self) -> bool {
        self.changed
    }
    fn fact(&self) -> Option<SavedChangeFact> {
        self.changed.then(|| {
            SavedChangeFact::committed(self.viewer.clone(), self.message.clone(), SavedAction::Save)
        })
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CommittedUnsave {
    viewer: UserId,
    message: MessageId,
    changed: bool,
}

impl CommittedUnsave {
    pub fn committed(viewer: UserId, message: MessageId, changed: bool) -> Self {
        Self {
            viewer,
            message,
            changed,
        }
    }

    pub fn bind(
        self,
        viewer: &UserId,
        message: &MessageId,
    ) -> Result<BoundCommittedUnsave, SavedIdentityMismatch> {
        if &self.viewer != viewer || &self.message != message {
            return Err(SavedIdentityMismatch);
        }
        Ok(BoundCommittedUnsave {
            viewer: self.viewer,
            message: self.message,
            changed: self.changed,
        })
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct BoundCommittedUnsave {
    viewer: UserId,
    message: MessageId,
    changed: bool,
}

impl BoundCommittedUnsave {
    pub const fn changed(&self) -> bool {
        self.changed
    }
    fn fact(&self) -> Option<SavedChangeFact> {
        self.changed.then(|| {
            SavedChangeFact::committed(
                self.viewer.clone(),
                self.message.clone(),
                SavedAction::Unsave,
            )
        })
    }
}

#[derive(Debug, thiserror::Error)]
pub enum SavedExecutionError<E: Error + 'static> {
    #[error("saved-message persistence failed")]
    Persistence(#[source] E),
    #[error(transparent)]
    Identity(#[from] SavedIdentityMismatch),
}

/// A port cannot bypass the request/source bind and publish an arbitrary fact.
///
/// ```compile_fail
/// # use silverhand_backend_core::messaging::collaboration::saved::SavedChangeFact;
/// fn forge() {
///     let _ = SavedChangeFact { viewer: todo!(), message: todo!(), action: todo!() };
/// }
/// ```
const _: () = ();

pub trait SavedMutationPort {
    type Error: Error + Send + Sync + 'static;

    fn save(
        &self,
        viewer: UserId,
        message: MessageId,
    ) -> impl Future<Output = Result<Result<CommittedSave, SavedMutationRefusal>, Self::Error>> + Send;

    fn unsave(
        &self,
        viewer: UserId,
        message: MessageId,
    ) -> impl Future<Output = Result<Result<CommittedUnsave, SavedMutationRefusal>, Self::Error>> + Send;
}

pub trait SavedAftermath {
    fn announce(
        &self,
        fact: &SavedChangeFact,
    ) -> impl Future<Output = Result<(), SavedPublicationFailure>> + Send;
}

#[derive(Debug, thiserror::Error)]
#[error("the committed saved-message change could not be published")]
pub struct SavedPublicationFailure {
    #[source]
    source: Box<dyn Error + Send + Sync + 'static>,
}

impl SavedPublicationFailure {
    pub fn from_source(source: impl Error + Send + Sync + 'static) -> Self {
        Self {
            source: Box::new(source),
        }
    }
}

#[derive(Debug)]
pub struct SaveExecution {
    committed: BoundCommittedSave,
    publication_failure: Option<SavedPublicationFailure>,
}

impl SaveExecution {
    pub fn committed(&self) -> &BoundCommittedSave {
        &self.committed
    }
    pub fn publication_failure(&self) -> Option<&SavedPublicationFailure> {
        self.publication_failure.as_ref()
    }
}

#[derive(Debug)]
pub struct UnsaveExecution {
    committed: BoundCommittedUnsave,
    publication_failure: Option<SavedPublicationFailure>,
}

impl UnsaveExecution {
    pub fn committed(&self) -> &BoundCommittedUnsave {
        &self.committed
    }
    pub fn publication_failure(&self) -> Option<&SavedPublicationFailure> {
        self.publication_failure.as_ref()
    }
}

async fn announce(
    aftermath: &impl SavedAftermath,
    fact: Option<SavedChangeFact>,
) -> Option<SavedPublicationFailure> {
    match fact {
        Some(fact) => aftermath.announce(&fact).await.err(),
        None => None,
    }
}

pub async fn save_message<P: SavedMutationPort>(
    port: &P,
    aftermath: &impl SavedAftermath,
    viewer: UserId,
    message: MessageId,
) -> Result<Result<SaveExecution, SavedMutationRefusal>, SavedExecutionError<P::Error>> {
    let committed = match port
        .save(viewer.clone(), message.clone())
        .await
        .map_err(SavedExecutionError::Persistence)?
    {
        Ok(committed) => committed,
        Err(refusal) => return Ok(Err(refusal)),
    };
    let committed = committed.bind(&viewer, &message)?;
    let publication_failure = announce(aftermath, committed.fact()).await;
    Ok(Ok(SaveExecution {
        committed,
        publication_failure,
    }))
}

pub async fn unsave_message<P: SavedMutationPort>(
    port: &P,
    aftermath: &impl SavedAftermath,
    viewer: UserId,
    message: MessageId,
) -> Result<Result<UnsaveExecution, SavedMutationRefusal>, SavedExecutionError<P::Error>> {
    let committed = match port
        .unsave(viewer.clone(), message.clone())
        .await
        .map_err(SavedExecutionError::Persistence)?
    {
        Ok(committed) => committed,
        Err(refusal) => return Ok(Err(refusal)),
    };
    let committed = committed.bind(&viewer, &message)?;
    let publication_failure = announce(aftermath, committed.fact()).await;
    Ok(Ok(UnsaveExecution {
        committed,
        publication_failure,
    }))
}

#[cfg(test)]
mod tests {
    use std::{
        convert::Infallible,
        sync::atomic::{AtomicUsize, Ordering},
    };

    use crate::{
        foundation::identity::{ConversationId, UserId},
        messaging::{FromKind, MessageId, MessageSeq, collaboration::saved::*},
    };

    struct Port {
        viewer: &'static str,
        message: &'static str,
    }

    impl SavedMutationPort for Port {
        type Error = Infallible;

        async fn save(
            &self,
            _: UserId,
            _: MessageId,
        ) -> Result<Result<CommittedSave, SavedMutationRefusal>, Self::Error> {
            let viewer = UserId::parse(self.viewer).unwrap();
            let message = MessageId::parse(self.message).unwrap();
            Ok(Ok(CommittedSave::committed(
                viewer.clone(),
                message.clone(),
                entry(viewer, message),
                true,
            )))
        }

        async fn unsave(
            &self,
            _: UserId,
            _: MessageId,
        ) -> Result<Result<CommittedUnsave, SavedMutationRefusal>, Self::Error> {
            Ok(Ok(CommittedUnsave::committed(
                UserId::parse(self.viewer).unwrap(),
                MessageId::parse(self.message).unwrap(),
                true,
            )))
        }
    }

    #[derive(Default)]
    struct Events(AtomicUsize);

    impl SavedAftermath for Events {
        async fn announce(&self, _: &SavedChangeFact) -> Result<(), SavedPublicationFailure> {
            self.0.fetch_add(1, Ordering::SeqCst);
            Ok(())
        }
    }

    fn entry(viewer: UserId, message: MessageId) -> SavedEntry {
        let conversation = ConversationId::parse("conversation").unwrap();
        SavedEntry::projected(
            viewer,
            SavedEntryId::parse("saved").unwrap(),
            SavedMessage::projected(SavedMessageProjection {
                id: message,
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
    async fn mutation_source_splices_fail_before_the_viewer_effect() {
        let viewer = UserId::parse("viewer-a").unwrap();
        let message = MessageId::parse("message-a").unwrap();
        for port in [
            Port {
                viewer: "viewer-b",
                message: "message-a",
            },
            Port {
                viewer: "viewer-a",
                message: "message-b",
            },
        ] {
            let events = Events::default();
            assert!(
                save_message(&port, &events, viewer.clone(), message.clone())
                    .await
                    .is_err()
            );
            assert!(
                unsave_message(&port, &events, viewer.clone(), message.clone())
                    .await
                    .is_err()
            );
            assert_eq!(events.0.load(Ordering::SeqCst), 0);
        }
        let events = Events::default();
        let execution = save_message(
            &Port {
                viewer: "viewer-a",
                message: "message-a",
            },
            &events,
            viewer,
            message,
        )
        .await
        .unwrap()
        .unwrap();
        assert!(execution.committed().changed());
        assert_eq!(events.0.load(Ordering::SeqCst), 1);
    }
}
