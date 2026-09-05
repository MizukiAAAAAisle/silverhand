//! Viewer-private saved-message capability.
//!
//! The cold projection and the mutation unit share the same placement-aware human
//! participation authority.  The event is only an invalidation hint for that viewer;
//! the saved list remains the value authority.

mod model;
mod mutation;
mod read;

pub use model::{
    BoundSavedEntry, InvalidSavedAt, InvalidSavedEntryId, SavedAt, SavedCoordinateMismatch,
    SavedEntry, SavedEntryId, SavedIdentityMismatch, SavedLinkedTask, SavedMessage,
    SavedMessageProjection, SavedPlace, SavedTaskAssignee,
};
pub use mutation::{
    BoundCommittedSave, BoundCommittedUnsave, CommittedSave, CommittedUnsave, SaveExecution,
    SavedAction, SavedAftermath, SavedChangeFact, SavedExecutionError, SavedMutationPort,
    SavedMutationRefusal, SavedPublicationFailure, UnsaveExecution, save_message, unsave_message,
};
pub use read::{
    SavedListQuery, SavedReadExecutionError, SavedReadPort, SavedReadRefusal, SavedSender,
    SavedSince, list_saved,
};
