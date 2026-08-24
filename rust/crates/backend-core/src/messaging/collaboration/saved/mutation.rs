use std::{error::Error, future::Future};

use crate::{identity::UserId, messaging::MessageId};

use super::SavedEntry;

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
    entry: SavedEntry,
    change: SaveChange,
}

#[derive(Clone, Debug, Eq, PartialEq)]
enum SaveChange {
    Changed(SavedChangeFact),
    Unchanged,
}

impl CommittedSave {
    /// A newly committed save. The event message is derived from the same entry
    /// returned in the ACK, so the two identities cannot be supplied separately.
    pub fn changed(viewer: UserId, entry: SavedEntry) -> Self {
        let message = entry.message().projection().id.clone();
        Self {
            entry,
            change: SaveChange::Changed(SavedChangeFact::committed(
                viewer,
                message,
                SavedAction::Save,
            )),
        }
    }

    pub fn unchanged(entry: SavedEntry) -> Self {
        Self {
            entry,
            change: SaveChange::Unchanged,
        }
    }
    pub fn entry(&self) -> &SavedEntry {
        &self.entry
    }
    pub fn fact(&self) -> Option<&SavedChangeFact> {
        match &self.change {
            SaveChange::Changed(fact) => Some(fact),
            SaveChange::Unchanged => None,
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CommittedUnsave {
    change: UnsaveChange,
}

#[derive(Clone, Debug, Eq, PartialEq)]
enum UnsaveChange {
    Changed(SavedChangeFact),
    Unchanged,
}

impl CommittedUnsave {
    pub fn changed(viewer: UserId, message: MessageId) -> Self {
        Self {
            change: UnsaveChange::Changed(SavedChangeFact::committed(
                viewer,
                message,
                SavedAction::Unsave,
            )),
        }
    }

    pub fn unchanged() -> Self {
        Self {
            change: UnsaveChange::Unchanged,
        }
    }
    pub fn fact(&self) -> Option<&SavedChangeFact> {
        match &self.change {
            UnsaveChange::Changed(fact) => Some(fact),
            UnsaveChange::Unchanged => None,
        }
    }
}

/// The old free-form constructors would make operation/identity mismatches
/// representable. The public API deliberately has no such constructor.
///
/// ```compile_fail
/// # use silverhand_backend_core::messaging::collaboration::saved::{CommittedSave, SavedChangeFact, SavedEntry};
/// fn forge(entry: SavedEntry, fact: SavedChangeFact) {
///     let _ = CommittedSave::committed(entry, Some(fact));
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
    committed: CommittedSave,
    publication_failure: Option<SavedPublicationFailure>,
}

impl SaveExecution {
    pub fn committed(&self) -> &CommittedSave {
        &self.committed
    }
    pub fn publication_failure(&self) -> Option<&SavedPublicationFailure> {
        self.publication_failure.as_ref()
    }
}

#[derive(Debug)]
pub struct UnsaveExecution {
    committed: CommittedUnsave,
    publication_failure: Option<SavedPublicationFailure>,
}

impl UnsaveExecution {
    pub fn committed(&self) -> &CommittedUnsave {
        &self.committed
    }
    pub fn publication_failure(&self) -> Option<&SavedPublicationFailure> {
        self.publication_failure.as_ref()
    }
}

async fn announce(
    aftermath: &impl SavedAftermath,
    fact: Option<&SavedChangeFact>,
) -> Option<SavedPublicationFailure> {
    match fact {
        Some(fact) => aftermath.announce(fact).await.err(),
        None => None,
    }
}

pub async fn save_message<P: SavedMutationPort>(
    port: &P,
    aftermath: &impl SavedAftermath,
    viewer: UserId,
    message: MessageId,
) -> Result<Result<SaveExecution, SavedMutationRefusal>, P::Error> {
    let committed = match port.save(viewer, message).await? {
        Ok(committed) => committed,
        Err(refusal) => return Ok(Err(refusal)),
    };
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
) -> Result<Result<UnsaveExecution, SavedMutationRefusal>, P::Error> {
    let committed = match port.unsave(viewer, message).await? {
        Ok(committed) => committed,
        Err(refusal) => return Ok(Err(refusal)),
    };
    let publication_failure = announce(aftermath, committed.fact()).await;
    Ok(Ok(UnsaveExecution {
        committed,
        publication_failure,
    }))
}
