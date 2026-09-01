//! The human audience of a workspace — the enumerated set of people whose
//! read models go stale when the workspace's own metadata (its display name)
//! moves.
//!
//! This is the audience source the post-commit
//! [`WorkspaceMetadataChangedSink`](crate::identity_access::workspace_metadata_write::WorkspaceMetadataChangedSink)
//! fans out over: that sink is handed one `workspace_id` and owes a per-viewer
//! `metadata_changed` hint to every human member, so SOMETHING has to turn the
//! id into the member set. That enumeration is an access-context fact — human
//! membership is the `workspace_users` roster this context owns
//! (agents live in the separate `workspace_members` table and are NOT part of
//! this audience; they learn of a rename through the in-channel system message,
//! not this viewer-scoped hint).
//!
//! It is a READ PORT, not a verdict: it reports the committed member ids for a
//! workspace and nothing else. A workspace with no human members (or one that no
//! longer exists) is simply an empty set — the hint is owed to nobody, which is a
//! true answer, not a refusal. Every failure is a [`PersistenceFailure`]; there is
//! no product `4xx` on this path because it runs post-commit off a sealed fact.

use std::future::Future;

use crate::{
    identity::{UserId, WorkspaceId},
    persistence::PersistenceFailure,
};

/// Enumerates the human members of a workspace for a post-commit fan-out.
///
/// Scoped to that job: it answers "who renders this workspace's label and must
/// refetch it", not a general membership directory or a governance read. The
/// order of the returned ids is not part of the contract — the fan-out publishes
/// one independent per-viewer frame and no reader observes a sequence — but a
/// deterministic order keeps the adapter's own tests legible.
pub trait WorkspaceHumanAudienceReadPort: Clone + Send + Sync + 'static {
    fn human_member_ids(
        &self,
        workspace_id: &WorkspaceId,
    ) -> impl Future<Output = Result<Vec<UserId>, PersistenceFailure>> + Send;
}
