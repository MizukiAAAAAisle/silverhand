//! Authenticated cold face for the viewer's complete workspace list
//! (`GET /api/workspaces`), product parity.
//!
//! Workspace identity is read from one snapshot; sidebar order is a separate endpoint.
//!
//! There is exactly one authentication perimeter in front of this route — the
//! human-session layer that injects the sole [`UserId`]. Its absence is a
//! composition fault, not a request error, so it takes the lane's safe `500`
//! rather than a product refusal that would hide the misconfiguration. A
//! persistence failure (including a committed row the domain refuses to decode)
//! is likewise never rendered as product detail: it is logged once here with its
//! full source chain and answered with the same safe `500`.

use axum::{
    Json, Router,
    extract::{Extension, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::get,
};
use serde::Serialize;
use silverhand_backend_core::{
    foundation::identity::UserId,
    identity_access::workspace_cold_read::{WorkspaceColdRead, WorkspaceColdReadUnitOfWork},
    identity_access::workspace_face::WorkspaceFace,
};

use crate::foundation::error;

pub const WORKSPACES_PATH: &str = "/api/workspaces";

/// The unmapped-error body: the product route registers no `onError`, so an
/// unexpected failure falls to the framework default — a `500` with a bare
/// `text/plain` `Internal Server Error`, never a JSON envelope.
const INTERNAL_ERROR_BODY: &str = "Internal Server Error";

/// Mounts the cold-read route generic over the unit of work, so tests drive it
/// with a driver-free fake and the composition root wires the SQLite adapter.
/// Route registration into the served application is a separate integration seam.
pub fn router<U>(unit_of_work: U) -> Router
where
    U: WorkspaceColdReadUnitOfWork + Clone + Send + Sync + 'static,
{
    Router::new()
        .route(WORKSPACES_PATH, get(list::<U>))
        .with_state(unit_of_work)
}

async fn list<U>(State(unit_of_work): State<U>, viewer: Option<Extension<UserId>>) -> Response
where
    U: WorkspaceColdReadUnitOfWork,
{
    let Some(Extension(viewer)) = viewer else {
        tracing::error!("workspaces route reached without its human principal fact");
        return (StatusCode::INTERNAL_SERVER_ERROR, INTERNAL_ERROR_BODY).into_response();
    };
    match unit_of_work.load_workspace_cold_read(&viewer).await {
        Ok(cold_read) => Json(WorkspaceColdReadResponse::from(&cold_read)).into_response(),
        Err(cause) => {
            tracing::error!(
                error_chain =
                    crate::foundation::safe_log_field::safe_display(&(error::describe(&cause))),
                "workspaces cold read failed"
            );
            (StatusCode::INTERNAL_SERVER_ERROR, INTERNAL_ERROR_BODY).into_response()
        }
    }
}

/// The whole envelope: `{ workspaces }`.
#[derive(Serialize)]
struct WorkspaceColdReadResponse {
    workspaces: Vec<ViewerWorkspaceDto>,
}

impl From<&WorkspaceColdRead> for WorkspaceColdReadResponse {
    fn from(cold_read: &WorkspaceColdRead) -> Self {
        Self {
            workspaces: cold_read
                .workspaces
                .iter()
                .map(ViewerWorkspaceDto::from)
                .collect(),
        }
    }
}

/// One workspace on the published face. snake_case, field-by-field in the
/// contract order, mirroring `ViewerWorkspaceDtoSchema` / `toViewerWorkspace`:
/// nullable strings/number serialize as JSON `null`, `dm_channel_ids` as an
/// array. `name_key` never reaches the wire.
///
/// This is the ONE canonical published-workspace wire projection for the crate:
/// the workspace-list route here, the detail route
/// ([`crate::identity_access::workspace_detail`]), and the metadata-write route
/// ([`crate::identity_access::workspace_metadata_write`]) all serve this exact shape, so it is
/// defined once and imported rather than re-declared per route. The `From<&
/// WorkspaceFace>` is the projection; a route that must gate WHICH faces may reach
/// the wire (the detail route, which admits only an `AuthorizedWorkspaceFace`)
/// carries that gate on its own response type, not by withholding this DTO.
#[derive(Serialize)]
pub(crate) struct ViewerWorkspaceDto {
    id: String,
    name: String,
    description: Option<String>,
    owner_agent_id: Option<String>,
    owner_user_id: Option<String>,
    dm_channel_id: Option<String>,
    dm_channel_ids: Vec<String>,
    archived_at: Option<i64>,
    created_at: i64,
    updated_at: i64,
}

impl From<&WorkspaceFace> for ViewerWorkspaceDto {
    fn from(face: &WorkspaceFace) -> Self {
        Self {
            id: face.id.as_str().to_owned(),
            name: face.name.clone(),
            description: face.description.clone(),
            owner_agent_id: face
                .owner_agent_id
                .as_ref()
                .map(|id| id.as_str().to_owned()),
            owner_user_id: face.owner_user_id.as_ref().map(|id| id.as_str().to_owned()),
            dm_channel_id: face.dm_channel_id.as_ref().map(|id| id.as_str().to_owned()),
            dm_channel_ids: face
                .dm_channel_ids
                .iter()
                .map(|id| id.as_str().to_owned())
                .collect(),
            archived_at: face.archived_at,
            created_at: face.created_at,
            updated_at: face.updated_at,
        }
    }
}

#[cfg(test)]
mod tests {

    use axum::{
        body::{Body, to_bytes},
        http::{Request, StatusCode},
    };
    use serde_json::{Value, json};
    use silverhand_backend_core::{
        foundation::identity::UserId,
        foundation::persistence::PersistenceFailure,
        identity_access::workspace_cold_read::{WorkspaceColdRead, WorkspaceColdReadUnitOfWork},
    };
    use tower::ServiceExt;

    use super::{WORKSPACES_PATH, router};

    #[derive(Clone)]
    enum FakeUnitOfWork {
        Reads(WorkspaceColdRead),
    }

    impl WorkspaceColdReadUnitOfWork for FakeUnitOfWork {
        async fn load_workspace_cold_read(
            &self,
            _viewer: &UserId,
        ) -> Result<WorkspaceColdRead, PersistenceFailure> {
            match self {
                FakeUnitOfWork::Reads(read) => Ok(read.clone()),
            }
        }
    }

    async fn get_workspaces(
        unit_of_work: FakeUnitOfWork,
        with_principal: bool,
    ) -> (StatusCode, Value) {
        let mut request = Request::builder().uri(WORKSPACES_PATH);
        if with_principal {
            request = request.extension(UserId::parse("user-1").unwrap());
        }
        let response = router(unit_of_work)
            .oneshot(request.body(Body::empty()).unwrap())
            .await
            .unwrap();
        let status = response.status();
        let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        let value = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
        (status, value)
    }

    #[tokio::test]
    async fn an_empty_face_is_the_empty_envelope_not_a_missing_field() {
        let cold_read = WorkspaceColdRead {
            workspaces: Vec::new(),
        };

        let (status, body) = get_workspaces(FakeUnitOfWork::Reads(cold_read), true).await;

        assert_eq!(status, StatusCode::OK);
        assert_eq!(
            body,
            json!({
                "workspaces": [],

            })
        );
    }

    #[tokio::test]
    async fn a_missing_principal_is_a_safe_500_not_a_product_answer() {
        let cold_read = WorkspaceColdRead {
            workspaces: Vec::new(),
        };
        let (status, _) = get_workspaces(FakeUnitOfWork::Reads(cold_read), false).await;
        assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR);
    }
}
