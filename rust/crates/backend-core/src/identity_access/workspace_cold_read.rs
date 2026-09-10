//! Authenticated workspace listing. Sidebar ordering has its own read authority.
use crate::{
    foundation::{identity::UserId, persistence::PersistenceFailure},
    identity_access::workspace_face::{WorkspaceFace, WorkspaceFaceReadPort},
};
use std::future::Future;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct WorkspaceColdRead {
    pub workspaces: Vec<WorkspaceFace>,
}

pub async fn compose_workspace_cold_read<S>(
    snapshot: &mut S,
    viewer: &UserId,
) -> Result<WorkspaceColdRead, PersistenceFailure>
where
    S: WorkspaceFaceReadPort + Send,
{
    Ok(WorkspaceColdRead {
        workspaces: snapshot.visible_workspaces(viewer).await?,
    })
}

pub trait WorkspaceColdReadUnitOfWork {
    fn load_workspace_cold_read(
        &self,
        viewer: &UserId,
    ) -> impl Future<Output = Result<WorkspaceColdRead, PersistenceFailure>> + Send;
}
