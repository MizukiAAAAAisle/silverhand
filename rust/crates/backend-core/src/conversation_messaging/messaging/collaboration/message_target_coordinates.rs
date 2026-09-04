//! The full placement coordinates a message/target reference carries on the agent
//! read faces (`read-history`, `search`) — the Rust equivalent of the shared TS
//! `MessageRefSchema` / `ReadHistoryTargetRefSchema` coordinate set.
//!
//! A reference names WHERE a message lives. For a workspace-placed conversation that
//! is the workspace id + the channel; for a `direct_pair` (a DM) the honest answer is
//! "no workspace" — `workspace_id` is `None`, NOT a borrowed coordinate (echoing the
//! reading session's workspace would make a CC copy look like it lived on someone's
//! board, per agent-scoped-session-v1 §4.1). `channel_id` is always the conversation's
//! own id (TS `channel_id: conversation.id`).
//!
//! These coordinates MUST be produced inside the same authorized read snapshot that
//! selects the rows (never assembled by the route from request coordinates), so a
//! rename/placement change cannot make the ref and the row disagree.

use crate::foundation::identity::{ConversationId, WorkspaceId};

/// A conversation's placement kind — the discriminant the shared
/// `ConversationPlacementKindSchema` carries (`"workspace"` | `"direct_pair"`).
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ConversationPlacementKind {
    Workspace,
    DirectPair,
}

impl ConversationPlacementKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Workspace => "workspace",
            Self::DirectPair => "direct_pair",
        }
    }

    pub fn parse(raw: &str) -> Option<Self> {
        match raw {
            "workspace" => Some(Self::Workspace),
            "direct_pair" => Some(Self::DirectPair),
            _ => None,
        }
    }
}

/// A conversation's roster policy — `ConversationRosterPolicySchema` (`"open"` |
/// `"fixed"`).
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ConversationRosterPolicy {
    Open,
    Fixed,
}

impl ConversationRosterPolicy {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Open => "open",
            Self::Fixed => "fixed",
        }
    }

    pub fn parse(raw: &str) -> Option<Self> {
        match raw {
            "open" => Some(Self::Open),
            "fixed" => Some(Self::Fixed),
            _ => None,
        }
    }
}

/// The full coordinate set for a message/target reference: the conversation, its
/// placement kind + roster policy, the channel id (always the conversation id), and
/// the workspace id (`None` for a `direct_pair`). Bound in the authorized read
/// snapshot; the route projects it verbatim.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MessageTargetCoordinates {
    pub conversation: ConversationId,
    pub placement_kind: ConversationPlacementKind,
    pub roster_policy: ConversationRosterPolicy,
    /// TS `channel_id: conversation.id` — always the conversation's own id.
    pub channel_id: ConversationId,
    /// `None` for a `direct_pair` (workspace-less), else the placing workspace.
    pub workspace_id: Option<WorkspaceId>,
    /// The conversation's title (the read-history target ref carries it; a message
    /// ref does not).
    pub title: String,
}
