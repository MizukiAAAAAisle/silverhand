//! Viewer-private saved-message capability.
//!
//! The cold projection and the mutation unit share the same placement-aware human
//! participation authority.  The event is only an invalidation hint for that viewer;
//! the saved list remains the value authority.

mod model;
mod mutation;
mod read;

pub use model::{
    InvalidSavedAt, InvalidSavedEntryId, InvalidTaskNumber, SavedAt, SavedEntry, SavedEntryId,
    SavedLinkedTask, SavedMessage, SavedMessageProjection, SavedPlace, SavedTaskAssignee,
    SavedTaskNumber, SavedTaskStatus,
};
pub use mutation::{
    CommittedSave, CommittedUnsave, SaveExecution, SavedAction, SavedAftermath, SavedChangeFact,
    SavedMutationPort, SavedMutationRefusal, SavedPublicationFailure, UnsaveExecution,
    save_message, unsave_message,
};
pub use read::{SavedListQuery, SavedReadPort, SavedReadRefusal, SavedSender, SavedSince};
