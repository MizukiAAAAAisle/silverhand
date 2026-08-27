//! Authenticated single-workspace detail read: `GET /api/workspaces/:id`.
//!
//! A VISIBILITY read. For a human principal the product's `canViewWorkspace`
//! reduces to `isWorkspaceMember`, so a plain member sees a workspace's published
//! face; the governance role that decides who may rename or archive it never gates
//! this read. Existence is resolved BEFORE visibility, so an absent workspace is
//! `404` for everyone and only a present one is graded — a non-member then gets
//! `403`, observably distinct from `404`.
//!
//! ## The `200` path is identity-sealed at the wire
//!
//! The wire projector accepts NOTHING but an
//! [`AuthorizedWorkspaceFace`](silverhand_backend_core::workspace_detail_read::AuthorizedWorkspaceFace),
//! whose sole minter is
//! [`classify_workspace_view`](silverhand_backend_core::workspace_detail_read::classify_workspace_view).
//! The handler cannot fabricate a `200` from a raw read fact: it hands the read
//! fact to the classifier with the request's OWN `(viewer, workspace_id)`, and only
//! a [`WorkspaceView::Visible`] yields the sealed face the response constructor
//! ([`WorkspaceDetailResponse::from_authorized`]) will take. A read fact whose
//! identity does not match the authenticated request is neither `403` nor `404`: it
//! is a corrupt or misdirected read and takes the lane's safe `500`, alongside a
//! missing principal and a persistence failure.

use axum::{
    Json, Router,
    extract::{Extension, Path, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::get,
};
use serde::Serialize;
use silverhand_backend_core::{
    identity::{UserId, WorkspaceId},
    workspace_detail_read::{
        AuthorizedWorkspaceFace, WorkspaceDetailReadUnitOfWork, WorkspaceView,
        classify_workspace_view,
    },
    workspace_face::WorkspaceFace,
};

use crate::error;

/// The product route template, in axum's `{id}` capture syntax. A request to
/// `/api/workspaces/` (empty segment) does not match, so the TypeScript route's
/// `if (!id) 400` branch is structurally unreachable here; a non-empty but
/// unresolvable id is `404`, exactly as `workspaces.get(id)` returning undefined.
pub const WORKSPACE_DETAIL_PATH: &str = "/api/workspaces/{id}";

/// The not-found refusal string, pinned to the TypeScript handler
/// (`c.json({ error: 'workspace not found' }, 404)`) so a fixture drift shows here.
const WORKSPACE_NOT_FOUND: &str = "workspace not found";

/// The forbidden refusal string, pinned to `c.json({ error: 'forbidden' }, 403)`.
const FORBIDDEN: &str = "forbidden";

/// The unmapped-error body: an unexpected failure falls to the framework default —
/// a `500` with a bare `text/plain` `Internal Server Error`, never a JSON envelope.
const INTERNAL_ERROR_BODY: &str = "Internal Server Error";

/// Mounts the detail route generic over the unit of work, so tests drive it with a
/// driver-free fake and the composition root wires the SQLite adapter. Route
/// registration into the served application is a separate integration seam.
pub fn router<U>(unit_of_work: U) -> Router
where
    U: WorkspaceDetailReadUnitOfWork + Clone + Send + Sync + 'static,
{
    Router::new()
        .route(WORKSPACE_DETAIL_PATH, get(detail::<U>))
        .with_state(unit_of_work)
}

async fn detail<U>(
    Path(id): Path<String>,
    viewer: Option<Extension<UserId>>,
    State(unit_of_work): State<U>,
) -> Response
where
    U: WorkspaceDetailReadUnitOfWork,
{
    let Some(Extension(viewer)) = viewer else {
        tracing::error!("workspace-detail route reached without its human principal fact");
        return internal_error();
    };

    // A non-empty but unparseable id names no workspace — the same 404 an absent
    // row gets, so the surface never distinguishes "unusable id" from "not there".
    let Ok(workspace_id) = WorkspaceId::parse(id) else {
        return not_found();
    };

    let detail = match unit_of_work
        .load_workspace_detail(&viewer, &workspace_id)
        .await
    {
        Ok(detail) => detail,
        Err(cause) => {
            tracing::error!(
                error_chain = %error::describe(&cause),
                "workspace-detail read failed"
            );
            return internal_error();
        }
    };

    // The classifier binds the raw read fact to the request's own coordinates and
    // is the ONLY minter of the sealed face the projector will accept. An identity
    // mismatch is corruption, not a product code.
    match classify_workspace_view(&workspace_id, &viewer, detail) {
        Ok(WorkspaceView::NotFound) => not_found(),
        Ok(WorkspaceView::Forbidden) => forbidden(),
        Ok(WorkspaceView::Visible(authorized)) => {
            Json(WorkspaceDetailResponse::from_authorized(&authorized)).into_response()
        }
        Err(cause) => {
            tracing::error!(
                error_chain = %error::describe(&cause),
                "workspace-detail read fact did not match the authenticated request"
            );
            internal_error()
        }
    }
}

/// Success body: `{ "workspace": {ViewerWorkspaceDto} }`, mirroring the TypeScript
/// `c.json({ workspace: toViewerWorkspace(workspace) })`.
///
/// It is constructible ONLY from an [`AuthorizedWorkspaceFace`]: there is no
/// `From<&WorkspaceFace>` and no public field, so a `200` detail body cannot be
/// built from a raw face that never passed the classifier. This is the wire half
/// of the identity seal — the projector eats the sealed type and nothing wider.
#[derive(Serialize)]
struct WorkspaceDetailResponse {
    workspace: ViewerWorkspaceDto,
}

impl WorkspaceDetailResponse {
    fn from_authorized(authorized: &AuthorizedWorkspaceFace) -> Self {
        Self {
            workspace: ViewerWorkspaceDto::from(authorized.face()),
        }
    }
}

/// One workspace on the published face. snake_case, field-by-field in the contract
/// order, mirroring `ViewerWorkspaceDtoSchema` / `toViewerWorkspace`: nullable
/// strings/number serialize as JSON `null`, `dm_channel_ids` as an array,
/// `name_key` never reaches the wire. This is the SAME published wire shape the
/// list route emits; the cross-language parity gate against
/// `ViewerWorkspaceDtoSchema` is what keeps the two projections from drifting.
#[derive(Serialize)]
struct ViewerWorkspaceDto {
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

/// The flat refusal body, mirroring the product `{ "error": ... }`.
#[derive(Serialize)]
struct ErrorBody {
    error: &'static str,
}

fn not_found() -> Response {
    (
        StatusCode::NOT_FOUND,
        Json(ErrorBody {
            error: WORKSPACE_NOT_FOUND,
        }),
    )
        .into_response()
}

fn forbidden() -> Response {
    (StatusCode::FORBIDDEN, Json(ErrorBody { error: FORBIDDEN })).into_response()
}

fn internal_error() -> Response {
    (StatusCode::INTERNAL_SERVER_ERROR, INTERNAL_ERROR_BODY).into_response()
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{
        body::{Body, to_bytes},
        http::Request,
    };
    use serde_json::{Value, json};
    use silverhand_backend_core::{
        persistence::PersistenceFailure,
        workspace_detail_read::WorkspaceDetailForViewer,
    };
    use tower::ServiceExt;

    #[derive(Clone)]
    enum FakeUnitOfWork {
        // The read fact is boxed so the enum's present-arm does not dwarf its
        // unit `Fails` arm (clippy::large_enum_variant); `None` still models the
        // absent workspace the classifier turns into a 404.
        Reads(Option<Box<WorkspaceDetailForViewer>>),
        Fails,
    }

    impl WorkspaceDetailReadUnitOfWork for FakeUnitOfWork {
        async fn load_workspace_detail(
            &self,
            _viewer: &UserId,
            _id: &WorkspaceId,
        ) -> Result<Option<WorkspaceDetailForViewer>, PersistenceFailure> {
            match self {
                FakeUnitOfWork::Reads(detail) => Ok(detail.as_deref().cloned()),
                FakeUnitOfWork::Fails => {
                    #[derive(Debug, thiserror::Error)]
                    #[error("stored row could not be decoded")]
                    struct Corruption;
                    Err(PersistenceFailure::from_source(Corruption))
                }
            }
        }
    }

    fn regular_face(id: &str) -> WorkspaceFace {
        WorkspaceFace {
            id: WorkspaceId::parse(id).unwrap(),
            name: "Regular".to_owned(),
            description: Some("desc".to_owned()),
            owner_agent_id: None,
            owner_user_id: Some(UserId::parse("user-1").unwrap()),
            dm_channel_id: None,
            dm_channel_ids: Vec::new(),
            archived_at: None,
            created_at: 1,
            updated_at: 300,
        }
    }

    async fn get_detail(
        unit_of_work: FakeUnitOfWork,
        id: &str,
        with_principal: bool,
    ) -> (StatusCode, Value) {
        let mut request = Request::builder().uri(format!("/api/workspaces/{id}"));
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
    async fn a_member_sees_the_face_at_200() {
        let detail = WorkspaceDetailForViewer {
            face: regular_face("ws-1"),
            membership_subject: Some(UserId::parse("user-1").unwrap()),
        };
        let (status, body) = get_detail(FakeUnitOfWork::Reads(Some(Box::new(detail))), "ws-1", true).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(
            body,
            json!({
                "workspace": {
                    "id": "ws-1",
                    "name": "Regular",
                    "description": "desc",
                    "owner_agent_id": null,
                    "owner_user_id": "user-1",
                    "dm_channel_id": null,
                    "dm_channel_ids": [],
                    "archived_at": null,
                    "created_at": 1,
                    "updated_at": 300
                }
            })
        );
    }

    #[tokio::test]
    async fn a_non_member_of_a_present_workspace_is_forbidden() {
        let detail = WorkspaceDetailForViewer {
            face: regular_face("ws-1"),
            membership_subject: None,
        };
        let (status, body) = get_detail(FakeUnitOfWork::Reads(Some(Box::new(detail))), "ws-1", true).await;
        assert_eq!(status, StatusCode::FORBIDDEN);
        assert_eq!(body, json!({ "error": "forbidden" }));
    }

    #[tokio::test]
    async fn an_absent_workspace_is_not_found() {
        let (status, body) = get_detail(FakeUnitOfWork::Reads(None), "ws-missing", true).await;
        assert_eq!(status, StatusCode::NOT_FOUND);
        assert_eq!(body, json!({ "error": "workspace not found" }));
    }

    #[tokio::test]
    async fn a_read_fact_for_another_workspace_is_a_safe_500_not_a_product_answer() {
        // The fake answers the request for `ws-1` with the face of `ws-2`: the
        // classifier's coordinate bind fails, so it is corruption, not 403/404.
        let detail = WorkspaceDetailForViewer {
            face: regular_face("ws-2"),
            membership_subject: Some(UserId::parse("user-1").unwrap()),
        };
        let (status, _) = get_detail(FakeUnitOfWork::Reads(Some(Box::new(detail))), "ws-1", true).await;
        assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR);
    }

    #[tokio::test]
    async fn a_membership_matched_to_another_subject_is_a_safe_500() {
        let detail = WorkspaceDetailForViewer {
            face: regular_face("ws-1"),
            membership_subject: Some(UserId::parse("user-2").unwrap()),
        };
        let (status, _) = get_detail(FakeUnitOfWork::Reads(Some(Box::new(detail))), "ws-1", true).await;
        assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR);
    }

    #[tokio::test]
    async fn a_missing_principal_is_a_safe_500() {
        let detail = WorkspaceDetailForViewer {
            face: regular_face("ws-1"),
            membership_subject: Some(UserId::parse("user-1").unwrap()),
        };
        let (status, _) = get_detail(FakeUnitOfWork::Reads(Some(Box::new(detail))), "ws-1", false).await;
        assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR);
    }

    #[tokio::test]
    async fn a_persistence_failure_is_a_safe_500_with_no_driver_detail() {
        let response = router(FakeUnitOfWork::Fails)
            .oneshot(
                Request::builder()
                    .uri("/api/workspaces/ws-1")
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

    /// The static name-availability route and this dynamic `/{id}` route coexist
    /// under `/api/workspaces`. When merged into one application, a request to the
    /// static `name-availability` path must reach the PROBE, not this detail
    /// handler with `id = "name-availability"`. axum prioritizes the static
    /// segment; this pins that it is not shadowed regardless of merge order.
    #[tokio::test]
    async fn the_static_name_availability_path_is_not_shadowed_by_the_id_route() {
        use crate::workspace_name_availability::{
            self as name_availability, WORKSPACE_NAME_AVAILABILITY_PATH,
        };
        use silverhand_backend_core::workspace_name::CanonicalWorkspaceName;
        use silverhand_backend_core::workspace_name_availability::{
            HeldName, RegularWorkspaceNamespace,
        };

        #[derive(Clone)]
        struct EmptyNamespace;
        impl RegularWorkspaceNamespace for EmptyNamespace {
            async fn holder_of_name(
                &self,
                _name: &CanonicalWorkspaceName,
            ) -> Result<Option<HeldName>, PersistenceFailure> {
                Ok(None)
            }
        }

        // The detail unit of work would 404 any id; if the merge shadowed the
        // static path, the probe request would land here and 404 instead of 200.
        let app = router(FakeUnitOfWork::Reads(None))
            .merge(name_availability::router(EmptyNamespace));

        let response = app
            .oneshot(
                Request::builder()
                    .uri(format!("{WORKSPACE_NAME_AVAILABILITY_PATH}?name=Design%20Team"))
                    .extension(UserId::parse("user-1").unwrap())
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::OK);
        let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        let body: Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(body, json!({ "available": true, "reason": "available" }));
    }
}
