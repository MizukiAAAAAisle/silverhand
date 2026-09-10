//! The workspace list bounded context: a human viewer's published face of the
//! workspaces they are a member of.
//!
//! Workspace identity is independent of sidebar ordering and viewer preferences.
//!
//! [`WorkspaceFace`] is the projected fact, not a storage row: every
//! identity-bearing coordinate is already a typed identity, so a reader that
//! decoded a committed row into this type has already refused an unusable
//! identifier at the persistence boundary rather than carrying an empty or
//! malformed id onto the wire. `name` is the one non-identity string and is
//! carried verbatim — the schema places no non-empty invariant on it, so an
//! empty display name is legal data, not corruption.

use std::future::Future;

use crate::{
    foundation::identity::{AgentId, ConversationId, UserId, WorkspaceId},
    foundation::persistence::PersistenceFailure,
};

/// One workspace on the authenticated viewer's published face.
///
/// The field set and the order below are the published wire contract, reverse
/// derived from the real TypeScript projector (`toViewerWorkspace`) and its
/// `ViewerWorkspaceDtoSchema`, not from any single consumer's read subset:
/// a published-but-currently-unread field (e.g. `owner_user_id`) stays on the
/// face. `name_key` is deliberately absent — it never reaches the wire.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct WorkspaceFace {
    pub id: WorkspaceId,
    pub name: String,
    pub description: Option<String>,
    /// The home agent, or `None` for a regular workspace. It is the relation the
    /// old stored container word restated, published so the renderer can ask
    /// `isAgentHomeWorkspace` without a locally decoded kind.
    pub owner_agent_id: Option<AgentId>,
    pub owner_user_id: Option<UserId>,
    /// The workspace's primary DM channel, present only for an agent-home
    /// workspace; `None` for a regular one.
    pub dm_channel_id: Option<ConversationId>,
    /// Every fixed-roster DM channel of an agent-home workspace, in the same
    /// priority order the primary is chosen by; empty for a regular workspace.
    pub dm_channel_ids: Vec<ConversationId>,
    pub archived_at: Option<i64>,
    pub created_at: i64,
    pub updated_at: i64,
}

/// Reads the faces of exactly the workspaces the authenticated viewer may see.
///
/// Membership IS visibility for a human principal (the TypeScript
/// `canViewWorkspace` reduces to `isWorkspaceMember`), so the returned set is
/// the viewer's `workspace_users` membership, already ordered by the published
/// key `(owner_agent_id IS NULL first), updated_at DESC`. The port takes
/// `&mut self` because it reads through a caller-held snapshot: the workspace
/// set and the viewer's sort state must be sampled from ONE database snapshot,
/// so neither context opens a transaction of its own.
pub trait WorkspaceFaceReadPort {
    fn visible_workspaces(
        &mut self,
        viewer: &UserId,
    ) -> impl Future<Output = Result<Vec<WorkspaceFace>, PersistenceFailure>> + Send;
}
