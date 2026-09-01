//! The viewer-sort bounded context, scoped to the workspace rail.
//!
//! This is the second context the authenticated workspace cold read composes.
//! It owns only the viewer's sort PREFERENCES for the `workspaces` list — mode
//! per hard group, and per-entity manual rank / recent-opened / star stamps. It
//! orders nothing: the renderer composes the final order from these preferences.
//!
//! Every value read here is a trust seam. The persisted `scope` and `mode` are
//! decoded against their closed sets, and a value outside them is corruption of
//! a committed row (a safe `500`), never coerced to a default — the same rule
//! the enrollment adapter applies to a `workspace_users.role` token. A sparse
//! read (a group with no stored mode row) is legal absence and means the
//! renderer's default, `recent`; that is distinct from a stored-but-illegal
//! value, which must not be filtered away to that same default.

use std::{collections::BTreeMap, future::Future};

use crate::{
    foundation::persistence::PersistenceFailure,
    identity::{UserId, WorkspaceId},
};

/// The persisted `list_key` for the workspace rail. The whole context is scoped
/// to this one list, so it is a constant rather than a stored field.
pub const WORKSPACE_SORT_LIST_KEY: &str = "workspaces";

/// A viewer's chosen ordering for one scope. The closed set mirrors the schema's
/// `user_list_sort_mode.mode` CHECK; a stored token outside it is corruption.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SortMode {
    Recent,
    Manual,
}

impl SortMode {
    pub fn parse(raw: &str) -> Option<Self> {
        match raw {
            "recent" => Some(Self::Recent),
            "manual" => Some(Self::Manual),
            _ => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Recent => "recent",
            Self::Manual => "manual",
        }
    }
}

/// The mode axis a workspace-rail preference belongs to. The rail is partitioned
/// into two hard groups, so its ONLY legal scopes are these two — never the `''`
/// list-wide sentinel that a flat list (a channel sidebar) stores. A row under
/// `list_key = 'workspaces'` whose scope is anything else is unreachable through
/// the write path and therefore corruption of a committed row.
#[derive(Clone, Copy, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub enum WorkspaceSortScope {
    AgentSpace,
    Regular,
}

impl WorkspaceSortScope {
    pub fn parse(raw: &str) -> Option<Self> {
        match raw {
            "agent_space" => Some(Self::AgentSpace),
            "regular" => Some(Self::Regular),
            _ => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::AgentSpace => "agent_space",
            Self::Regular => "regular",
        }
    }
}

/// One viewer-sort entry for a workspace the viewer can sort. `entity_id` is a
/// typed workspace id: it is parsed BEFORE the entry is tested against the live
/// sortable set, so an empty/malformed stored id is corruption (a safe `500`),
/// never silently dropped by the "not currently visible" filter.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ViewerSortEntry {
    pub entity_id: WorkspaceId,
    pub rank: Option<i64>,
    pub last_accessed_at: Option<i64>,
    pub starred_at: Option<i64>,
}

/// The viewer's sort state for the workspace rail. `modes` is keyed by the hard
/// group; a group absent from the map is the renderer's `recent` default.
/// `entries` are already filtered to the live sortable set handed to the read.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ViewerSortState {
    pub modes: BTreeMap<WorkspaceSortScope, SortMode>,
    pub entries: Vec<ViewerSortEntry>,
}

/// Reads the viewer's sort state for the workspace rail, filtered to `sortable`.
///
/// `sortable` is the live set an entry may survive against — the workspaces the
/// viewer can currently see AND that are not archived (archived workspaces show
/// in their own rail group, never sorted). A stored entry outside that set is a
/// legal orphan the storage keeps and this read hides. Like the workspace-face
/// port, it takes `&mut self`: it reads through the caller's single snapshot so
/// its entity set cannot drift from the workspace set read alongside it.
pub trait ViewerWorkspaceSortReadPort {
    fn workspace_sort_state(
        &mut self,
        viewer: &UserId,
        sortable: &[WorkspaceId],
    ) -> impl Future<Output = Result<ViewerSortState, PersistenceFailure>> + Send;
}
