//! Authenticated cold face for the viewer's complete workspace list
//! (`GET /api/workspaces`), product parity.
//!
//! The whole envelope — the visible workspaces AND the viewer's sort state for
//! the workspace rail — is one value read from a single database snapshot behind
//! [`WorkspaceColdReadUnitOfWork`]. The two halves are separate bounded contexts
//! joined only here at the wire, and `viewer_sort` is delivered on this same
//! response rather than a second endpoint: the client re-reads this one authority
//! after a `viewer_workspaces_changed` hint, so splitting the halves across
//! responses would reintroduce the very membership/sort skew the single snapshot
//! removes.
//!
//! There is exactly one authentication perimeter in front of this route — the
//! human-session layer that injects the sole [`UserId`]. Its absence is a
//! composition fault, not a request error, so it takes the lane's safe `500`
//! rather than a product refusal that would hide the misconfiguration. A
//! persistence failure (including a committed row the domain refuses to decode)
//! is likewise never rendered as product detail: it is logged once here with its
//! full source chain and answered with the same safe `500`.

use std::collections::BTreeMap;

use axum::{
    Json, Router,
    extract::{Extension, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::get,
};
use serde::Serialize;
use silverhand_backend_core::{
    identity::UserId,
    identity_access::workspace_cold_read::{WorkspaceColdRead, WorkspaceColdReadUnitOfWork},
    identity_access::workspace_face::WorkspaceFace,
    viewer_read_model::viewer_workspace_sort::{ViewerSortState, WORKSPACE_SORT_LIST_KEY},
};

use crate::error;

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
                error_chain = %error::describe(&cause),
                "workspaces cold read failed"
            );
            (StatusCode::INTERNAL_SERVER_ERROR, INTERNAL_ERROR_BODY).into_response()
        }
    }
}

/// The whole envelope: `{ workspaces, viewer_sort }`.
#[derive(Serialize)]
struct WorkspaceColdReadResponse {
    workspaces: Vec<ViewerWorkspaceDto>,
    viewer_sort: ViewerSortStateDto,
}

impl From<&WorkspaceColdRead> for WorkspaceColdReadResponse {
    fn from(cold_read: &WorkspaceColdRead) -> Self {
        Self {
            workspaces: cold_read
                .workspaces
                .iter()
                .map(ViewerWorkspaceDto::from)
                .collect(),
            viewer_sort: ViewerSortStateDto::from(&cold_read.viewer_sort),
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
/// ([`crate::workspace_detail`]), and the metadata-write route
/// ([`crate::workspace_metadata_write`]) all serve this exact shape, so it is
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

/// The viewer's sort state for the workspace rail: `{ list_key, modes, entries }`.
/// `list_key` is the constant `"workspaces"`; `modes` is the per-scope mode map
/// (scope string → mode string); `entries` carries each preference with its
/// nullable numeric stamps as explicit `null`s, exactly as the product schema.
#[derive(Serialize)]
struct ViewerSortStateDto {
    list_key: &'static str,
    modes: BTreeMap<&'static str, &'static str>,
    entries: Vec<ViewerSortEntryDto>,
}

impl From<&ViewerSortState> for ViewerSortStateDto {
    fn from(state: &ViewerSortState) -> Self {
        Self {
            list_key: WORKSPACE_SORT_LIST_KEY,
            modes: state
                .modes
                .iter()
                .map(|(scope, mode)| (scope.as_str(), mode.as_str()))
                .collect(),
            entries: state.entries.iter().map(ViewerSortEntryDto::from).collect(),
        }
    }
}

#[derive(Serialize)]
struct ViewerSortEntryDto {
    entity_id: String,
    rank: Option<i64>,
    last_accessed_at: Option<i64>,
    starred_at: Option<i64>,
}

impl From<&silverhand_backend_core::viewer_read_model::viewer_workspace_sort::ViewerSortEntry>
    for ViewerSortEntryDto
{
    fn from(
        entry: &silverhand_backend_core::viewer_read_model::viewer_workspace_sort::ViewerSortEntry,
    ) -> Self {
        Self {
            entity_id: entry.entity_id.as_str().to_owned(),
            rank: entry.rank,
            last_accessed_at: entry.last_accessed_at,
            starred_at: entry.starred_at,
        }
    }
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;

    use axum::{
        body::{Body, to_bytes},
        http::{Request, StatusCode},
    };
    use serde_json::{Value, json};
    use silverhand_backend_core::{
        foundation::persistence::PersistenceFailure,
        identity::{UserId, WorkspaceId},
        identity_access::workspace_cold_read::{WorkspaceColdRead, WorkspaceColdReadUnitOfWork},
        identity_access::workspace_face::WorkspaceFace,
        viewer_read_model::viewer_workspace_sort::{
            SortMode, ViewerSortEntry, ViewerSortState, WorkspaceSortScope,
        },
    };
    use tower::ServiceExt;

    use super::{WORKSPACES_PATH, router};

    #[derive(Clone)]
    enum FakeUnitOfWork {
        Reads(WorkspaceColdRead),
        Fails,
    }

    impl WorkspaceColdReadUnitOfWork for FakeUnitOfWork {
        async fn load_workspace_cold_read(
            &self,
            _viewer: &UserId,
        ) -> Result<WorkspaceColdRead, PersistenceFailure> {
            match self {
                FakeUnitOfWork::Reads(read) => Ok(read.clone()),
                FakeUnitOfWork::Fails => {
                    #[derive(Debug, thiserror::Error)]
                    #[error("stored row could not be decoded")]
                    struct Corruption;
                    Err(PersistenceFailure::from_source(Corruption))
                }
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

    fn regular(id: &str) -> WorkspaceFace {
        WorkspaceFace {
            id: WorkspaceId::parse(id).unwrap(),
            name: "Regular".to_owned(),
            description: None,
            owner_agent_id: None,
            owner_user_id: Some(UserId::parse("user-1").unwrap()),
            dm_channel_id: None,
            dm_channel_ids: Vec::new(),
            archived_at: None,
            created_at: 1,
            updated_at: 300,
        }
    }

    #[tokio::test]
    async fn the_envelope_carries_both_halves_with_the_published_field_shape() {
        let mut modes = BTreeMap::new();
        modes.insert(WorkspaceSortScope::Regular, SortMode::Manual);
        let cold_read = WorkspaceColdRead {
            workspaces: vec![WorkspaceFace {
                id: WorkspaceId::parse("ws-agent").unwrap(),
                name: "Agent Home".to_owned(),
                description: Some("home".to_owned()),
                owner_agent_id: Some(
                    silverhand_backend_core::identity::AgentId::parse("agent-1").unwrap(),
                ),
                owner_user_id: None,
                dm_channel_id: Some(
                    silverhand_backend_core::identity::ConversationId::parse("conv-1").unwrap(),
                ),
                dm_channel_ids: vec![
                    silverhand_backend_core::identity::ConversationId::parse("conv-1").unwrap(),
                ],
                archived_at: Some(999),
                created_at: 1,
                updated_at: 200,
            }],
            viewer_sort: ViewerSortState {
                modes,
                entries: vec![ViewerSortEntry {
                    entity_id: WorkspaceId::parse("ws-agent").unwrap(),
                    rank: Some(0),
                    last_accessed_at: None,
                    starred_at: None,
                }],
            },
        };

        let (status, body) = get_workspaces(FakeUnitOfWork::Reads(cold_read), true).await;

        assert_eq!(status, StatusCode::OK);
        assert_eq!(
            body,
            json!({
                "workspaces": [{
                    "id": "ws-agent",
                    "name": "Agent Home",
                    "description": "home",
                    "owner_agent_id": "agent-1",
                    "owner_user_id": null,
                    "dm_channel_id": "conv-1",
                    "dm_channel_ids": ["conv-1"],
                    "archived_at": 999,
                    "created_at": 1,
                    "updated_at": 200
                }],
                "viewer_sort": {
                    "list_key": "workspaces",
                    "modes": { "regular": "manual" },
                    "entries": [{
                        "entity_id": "ws-agent",
                        "rank": 0,
                        "last_accessed_at": null,
                        "starred_at": null
                    }]
                }
            })
        );
    }

    #[tokio::test]
    async fn an_empty_face_is_the_empty_envelope_not_a_missing_field() {
        let cold_read = WorkspaceColdRead {
            workspaces: Vec::new(),
            viewer_sort: ViewerSortState {
                modes: BTreeMap::new(),
                entries: Vec::new(),
            },
        };

        let (status, body) = get_workspaces(FakeUnitOfWork::Reads(cold_read), true).await;

        assert_eq!(status, StatusCode::OK);
        assert_eq!(
            body,
            json!({
                "workspaces": [],
                "viewer_sort": { "list_key": "workspaces", "modes": {}, "entries": [] }
            })
        );
    }

    #[tokio::test]
    async fn a_regular_workspace_publishes_its_nulls_verbatim() {
        let cold_read = WorkspaceColdRead {
            workspaces: vec![regular("ws-1")],
            viewer_sort: ViewerSortState {
                modes: BTreeMap::new(),
                entries: Vec::new(),
            },
        };

        let (status, body) = get_workspaces(FakeUnitOfWork::Reads(cold_read), true).await;

        assert_eq!(status, StatusCode::OK);
        let workspace = &body["workspaces"][0];
        assert_eq!(workspace["owner_agent_id"], Value::Null);
        assert_eq!(workspace["dm_channel_id"], Value::Null);
        assert_eq!(workspace["dm_channel_ids"], json!([]));
        assert_eq!(workspace["owner_user_id"], "user-1");
    }

    #[tokio::test]
    async fn a_missing_principal_is_a_safe_500_not_a_product_answer() {
        let cold_read = WorkspaceColdRead {
            workspaces: Vec::new(),
            viewer_sort: ViewerSortState {
                modes: BTreeMap::new(),
                entries: Vec::new(),
            },
        };
        let (status, _) = get_workspaces(FakeUnitOfWork::Reads(cold_read), false).await;
        assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR);
    }

    #[tokio::test]
    async fn a_persistence_failure_is_a_safe_500_with_no_driver_detail() {
        let response = router(FakeUnitOfWork::Fails)
            .oneshot(
                Request::builder()
                    .uri(WORKSPACES_PATH)
                    .extension(UserId::parse("user-1").unwrap())
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::INTERNAL_SERVER_ERROR);
        let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        assert_eq!(&bytes[..], b"Internal Server Error");
    }
}
