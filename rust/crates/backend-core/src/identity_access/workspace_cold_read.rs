//! The authenticated workspace cold read: the whole `GET /api/workspaces`
//! envelope, composed from two bounded contexts over ONE database snapshot.
//!
//! The workspace list ([`crate::identity_access::workspace_face`]) and the viewer's sort
//! preferences ([`crate::viewer_workspace_sort`]) are separate contexts with
//! separate ports; this module is the thin application seam that composes them.
//! The composition is deliberate and explicit rather than a single fused query:
//! the sort read is filtered to the set derived FROM the workspace read (the
//! visible, non-archived workspaces), so the two halves can never disagree about
//! which workspaces exist. Because both reads run against the one snapshot the
//! caller holds, that derived set is also drift-free — a membership change
//! landing mid-read cannot make the workspace set and the sort-visible set
//! reflect two different instants.
//!
//! `viewer_workspaces_changed` is only an invalidation hint elsewhere in the
//! system; THIS value is the complete cold authority the client re-reads, so the
//! envelope is never completed from a transport event or a replayed sequence.

use std::future::Future;

use crate::{
    identity::{UserId, WorkspaceId},
    identity_access::workspace_face::{WorkspaceFace, WorkspaceFaceReadPort},
    persistence::PersistenceFailure,
    viewer_workspace_sort::{ViewerSortState, ViewerWorkspaceSortReadPort},
};

/// The whole cold-read envelope for one authenticated viewer.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct WorkspaceColdRead {
    pub workspaces: Vec<WorkspaceFace>,
    pub viewer_sort: ViewerSortState,
}

/// Composes the two contexts over one caller-held snapshot.
///
/// Order matters: the workspace faces are read first, the live sortable set is
/// derived from them (visible AND not archived), and only then is the sort state
/// read against that set. `&mut snapshot` is the single read transaction both
/// ports borrow, which is what makes the two halves one consistent snapshot.
pub async fn compose_workspace_cold_read<S>(
    snapshot: &mut S,
    viewer: &UserId,
) -> Result<WorkspaceColdRead, PersistenceFailure>
where
    S: WorkspaceFaceReadPort + ViewerWorkspaceSortReadPort + Send,
{
    let workspaces = snapshot.visible_workspaces(viewer).await?;
    // Archived workspaces stay in the list (their own rail group) but are not
    // sortable, so a stale sort entry for one must not leak — the sortable set
    // is the visible, non-archived ids and nothing else.
    let sortable: Vec<WorkspaceId> = workspaces
        .iter()
        .filter(|workspace| workspace.archived_at.is_none())
        .map(|workspace| workspace.id.clone())
        .collect();
    let viewer_sort = snapshot.workspace_sort_state(viewer, &sortable).await?;
    Ok(WorkspaceColdRead {
        workspaces,
        viewer_sort,
    })
}

/// The unit of work the HTTP boundary depends on. Its one implementation opens a
/// single deferred-read snapshot and runs `load_workspace_cold_read` over it,
/// so the boundary stays generic over this port and is driven by a driver-free
/// fake in tests.
pub trait WorkspaceColdReadUnitOfWork {
    fn load_workspace_cold_read(
        &self,
        viewer: &UserId,
    ) -> impl Future<Output = Result<WorkspaceColdRead, PersistenceFailure>> + Send;
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;

    use super::*;
    use crate::{
        identity::WorkspaceId,
        viewer_workspace_sort::{SortMode, ViewerSortEntry, WorkspaceSortScope},
    };

    /// A driver-free snapshot double implementing both context ports. It records
    /// the sortable set the sort port was actually handed, so the composition's
    /// derivation is observable without a database.
    struct FakeSnapshot {
        faces: Vec<WorkspaceFace>,
        sort: ViewerSortState,
        observed_sortable: Option<Vec<WorkspaceId>>,
    }

    fn empty_sort() -> ViewerSortState {
        ViewerSortState {
            modes: BTreeMap::new(),
            entries: Vec::new(),
        }
    }

    impl WorkspaceFaceReadPort for FakeSnapshot {
        async fn visible_workspaces(
            &mut self,
            _viewer: &UserId,
        ) -> Result<Vec<WorkspaceFace>, PersistenceFailure> {
            Ok(self.faces.clone())
        }
    }

    impl ViewerWorkspaceSortReadPort for FakeSnapshot {
        async fn workspace_sort_state(
            &mut self,
            _viewer: &UserId,
            sortable: &[WorkspaceId],
        ) -> Result<ViewerSortState, PersistenceFailure> {
            self.observed_sortable = Some(sortable.to_vec());
            Ok(self.sort.clone())
        }
    }

    fn face(id: &str, archived_at: Option<i64>) -> WorkspaceFace {
        WorkspaceFace {
            id: WorkspaceId::parse(id).unwrap(),
            name: id.to_owned(),
            description: None,
            owner_agent_id: None,
            owner_user_id: None,
            dm_channel_id: None,
            dm_channel_ids: Vec::new(),
            archived_at,
            created_at: 1,
            updated_at: 1,
        }
    }

    #[tokio::test]
    async fn sort_read_is_scoped_to_the_visible_non_archived_workspaces() {
        let mut snapshot = FakeSnapshot {
            faces: vec![face("ws-live", None), face("ws-archived", Some(42))],
            sort: empty_sort(),
            observed_sortable: None,
        };
        let viewer = UserId::parse("user-1").unwrap();

        let read = compose_workspace_cold_read(&mut snapshot, &viewer)
            .await
            .unwrap();

        // The whole list, including the archived workspace, rides the envelope.
        assert_eq!(read.workspaces.len(), 2);
        // But the sort read only ever saw the live, non-archived id.
        assert_eq!(
            snapshot.observed_sortable,
            Some(vec![WorkspaceId::parse("ws-live").unwrap()])
        );
    }

    #[tokio::test]
    async fn envelope_carries_both_halves_verbatim() {
        let mut modes = BTreeMap::new();
        modes.insert(WorkspaceSortScope::Regular, SortMode::Manual);
        let sort = ViewerSortState {
            modes,
            entries: vec![ViewerSortEntry {
                entity_id: WorkspaceId::parse("ws-live").unwrap(),
                rank: Some(0),
                last_accessed_at: None,
                starred_at: None,
            }],
        };
        let mut snapshot = FakeSnapshot {
            faces: vec![face("ws-live", None)],
            sort: sort.clone(),
            observed_sortable: None,
        };
        let viewer = UserId::parse("user-1").unwrap();

        let read = compose_workspace_cold_read(&mut snapshot, &viewer)
            .await
            .unwrap();

        assert_eq!(read.viewer_sort, sort);
        assert_eq!(read.workspaces, vec![face("ws-live", None)]);
    }
}
