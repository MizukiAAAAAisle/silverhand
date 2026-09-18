//! The agent-scoped channel-list read: a workspace's conversations an agent can
//! see, for `GET /internal/agents/{aid}/list-channels`.
//!
//! The visible set is the member arm (conversations the agent joined — any
//! visibility, archived included) ∪ the discovery arm (open public non-archived
//! workspace channels). `is_member` is computed independently from the membership
//! relation, never inferred from which arm a row matched. Ordered `(archived_at IS
//! NOT NULL) ASC, updated_at DESC`, mirroring `listAgentVisibleChannels`.

use std::future::Future;

use crate::conversation_messaging::messaging::collaboration::channel_directory::{
    ChannelVisibility, DirectoryRoster,
};
use crate::foundation::identity::{AgentId, ConversationId, WorkspaceId};
use crate::foundation::persistence::PersistenceFailure;

/// One channel row in the agent's visible list. `is_member` is authoritative
/// (membership relation), distinct from `visibility` — `public` + `is_member:
/// false` is the discovery state.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AgentListedChannel {
    pub id: ConversationId,
    pub title: String,
    pub roster_policy: DirectoryRoster,
    pub visibility: ChannelVisibility,
    pub archived: bool,
    pub is_member: bool,
    pub updated_at: i64,
}

/// Reads the channels an agent can see in one workspace as ONE authorized
/// connection-bound snapshot: resolve the target workspace from the
/// caller's source (or the explicit selector), gate cross-workspace reach +
/// `read_messages`, and read the visible set (member ∪ discovery) — all on the same
/// transaction, so a revoke/membership race cannot leak an old set. The route
/// resolves nothing but the raw `workspace_id` selector; it projects the result.
pub trait AgentChannelListRead: Send + Sync + 'static {
    fn list_channels(
        &self,
        agent: &AgentId,
        source: Option<&ConversationId>,
        explicit_workspace: Option<&WorkspaceId>,
    ) -> impl Future<
        Output = Result<Result<ListChannelsResult, ListChannelsRefusal>, PersistenceFailure>,
    > + Send;
}

/// The committed list-channels read: the resolved target workspace (echoed) + the
/// visible channels.
#[derive(Clone, Debug)]
pub struct ListChannelsResult {
    pub workspace: WorkspaceId,
    pub channels: Vec<AgentListedChannel>,
}

/// Why a list-channels read refused, decided IN the authorized snapshot.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ListChannelsRefusal {
    /// The caller's bound source conversation no longer exists — `404 not found`.
    SourceNotFound,
    /// No workspace could be resolved (workspace-less source / AgentSlot, no explicit
    /// selector) — `400 workspace_scope_required`. Carries the source placement kind
    /// for the reference message, `None` when there is no source.
    WorkspaceScopeRequired {
        source_placement_kind: Option<super::message_target_coordinates::ConversationPlacementKind>,
    },
    /// A cross-workspace target the agent cannot reach — `403 forbidden`.
    WorkspaceForbidden,
    /// The agent lacks `read_messages` on the target workspace — `403
    /// capability_denied`.
    CapabilityDenied,
}
