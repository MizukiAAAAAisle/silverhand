//! Authorization coordinates for the authenticated product-event transport.

use std::future::Future;

use crate::{
    foundation::identity::{AgentId, ConversationId, UserId, WorkspaceId},
    foundation::persistence::PersistenceFailure,
};

/// A scope a human viewer asks the event transport to read.
///
/// The transport parses wire strings into this enum once. Authorization and
/// persistence never receive a prefix plus an unchecked id.
#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub enum EventScope {
    App,
    Agent(AgentId),
    Workspace(WorkspaceId),
    Conversation(ConversationId),
    ConversationSide(ConversationId),
    Viewer(UserId),
}

/// Current authorization for one event scope.
///
/// A subscription records interest, not authority. Callers must ask this port
/// both when registering and immediately before delivering a product frame.
pub trait AuthorizeEventScope: Clone + Send + Sync + 'static {
    fn authorize_event_scope(
        &self,
        viewer: &UserId,
        scope: &EventScope,
    ) -> impl Future<Output = Result<bool, PersistenceFailure>> + Send;
}
