//! `GET /internal/agents/{aid}/tasks/detail`.

use std::{collections::HashMap, sync::Arc};

use axum::{
    Json, Router,
    extract::{Extension, Path, RawQuery, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::get,
};
use silverhand_backend_core::conversation_messaging::messaging::task::{
    AgentBoardResolver, AgentRead, BoardAuthorization, BoardScopeRequest, BoardScopeSource,
    ReadViewer, TaskAuthorizedPointRead, TaskParticipationReads, TaskReadActor, TaskReadAddress,
    TaskReadCapability, TaskReadRequest, TaskWriteDoorReads, authorize_agent_board,
    authorize_global_by_id,
};
use silverhand_backend_core::host_runtime::runtime_credential::RuntimePrincipal;

use super::internal_write::selector::{
    BoardResolveRefusal, ResolvedBoard, WorkspaceSelector, resolve_write_board,
};
use super::wire::project_detail;
use crate::host_runtime::runtime_credential::bind_runtime_actor;

pub struct TaskDetailState<B, R> {
    pub boards: B,
    pub read: R,
}

pub fn task_detail_router<B, R>(state: TaskDetailState<B, R>) -> Router
where
    B: TaskWriteDoorReads
        + AgentBoardResolver
        + TaskParticipationReads
        + TaskReadCapability
        + Clone
        + Send
        + Sync
        + 'static,
    R: TaskAuthorizedPointRead + Send + Sync + 'static,
{
    Router::new()
        .route("/internal/agents/{aid}/tasks/detail", get(detail::<B, R>))
        .with_state(Arc::new(state))
}

async fn detail<B, R>(
    State(state): State<Arc<TaskDetailState<B, R>>>,
    Path(aid): Path<String>,
    principal: Option<Extension<RuntimePrincipal>>,
    RawQuery(raw): RawQuery,
) -> Response
where
    B: TaskWriteDoorReads
        + AgentBoardResolver
        + TaskParticipationReads
        + TaskReadCapability
        + Clone
        + Send
        + Sync
        + 'static,
    R: TaskAuthorizedPointRead + Send + Sync + 'static,
{
    let principal = match bind_runtime_actor(principal.as_ref().map(|ext| &ext.0), &aid) {
        Ok(value) => value,
        Err(value) => return value.into_response(),
    };
    let values = match query_map(raw.as_deref()) {
        Ok(value) => value,
        Err(()) => return invalid(),
    };
    let id_raw = values.get("task_id");
    let number_raw = values.get("task_number");
    if (id_raw.is_some() as u8 + number_raw.is_some() as u8) != 1 {
        return invalid();
    }
    if id_raw.is_some()
        && (values.contains_key("workspace_id") || values.contains_key("workspace_name"))
    {
        return invalid();
    }

    let (address, actor) = if let Some(raw) = id_raw {
        let Ok(id) =
            silverhand_backend_core::conversation_messaging::messaging::task::TaskId::parse(raw)
        else {
            return invalid();
        };
        let address = TaskReadAddress::ById(id);
        let actor = if let Some(global) = authorize_global_by_id(principal, &address) {
            AgentRead::GlobalById(global)
        } else {
            let Some(source) = principal.source() else {
                return safe_500();
            };
            let mut boards = state.boards.clone();
            let authorization = authorize_agent_board(
                BoardScopeRequest {
                    agent: principal.agent().clone(),
                    source: BoardScopeSource::FrameConversation(source.clone()),
                },
                &mut boards,
            )
            .await;
            match authorization {
                Ok(BoardAuthorization::Authorized(board)) => AgentRead::BoardScoped(board),
                Ok(_) => return not_found(),
                Err(_) => return safe_500(),
            }
        };
        (address, actor)
    } else {
        let Some(number) =
            number_raw.and_then(|raw| super::wire_number::parse_canonical_task_number(raw))
        else {
            return invalid();
        };
        let selector = WorkspaceSelector {
            workspace_id: values.get("workspace_id").cloned(),
            workspace_name: values.get("workspace_name").cloned(),
        };
        let mut raw_boards = state.boards.clone();
        let resolved = match resolve_write_board(
            &mut raw_boards,
            principal.agent(),
            principal.source(),
            &selector,
        )
        .await
        {
            Ok(Ok(value)) => value,
            Ok(Err(refusal)) => return board_refusal(refusal),
            Err(_) => return safe_500(),
        };
        if let ResolvedBoard::Workspace { workspace, .. } = &resolved {
            match raw_boards
                .may_read_tasks(principal.agent(), workspace)
                .await
            {
                Ok(true) => {}
                Ok(false) => return capability_denied(),
                Err(_) => return safe_500(),
            }
        }
        let source = match &resolved {
            ResolvedBoard::Workspace { workspace, .. } => {
                BoardScopeSource::SelectedWorkspace(workspace.clone())
            }
            ResolvedBoard::DirectPair { .. } => BoardScopeSource::FrameConversation(
                principal
                    .source()
                    .expect("pair board comes from a frame")
                    .clone(),
            ),
        };
        let mut boards = state.boards.clone();
        let board = match authorize_agent_board(
            BoardScopeRequest {
                agent: principal.agent().clone(),
                source,
            },
            &mut boards,
        )
        .await
        {
            Ok(BoardAuthorization::Authorized(value)) => value,
            Ok(BoardAuthorization::NoSuchWorkspace) => {
                return board_refusal(BoardResolveRefusal::UnknownWorkspace {
                    reason: "current conversation workspace not found".to_owned(),
                });
            }
            Ok(BoardAuthorization::Unauthorized) => {
                return board_refusal(BoardResolveRefusal::WorkspaceMembershipRequired {
                    reason: "workspace membership required".to_owned(),
                });
            }
            Err(_) => return safe_500(),
        };
        let address = TaskReadAddress::ByNumber {
            board: board.coordinate().clone(),
            number,
        };
        (address, AgentRead::BoardScoped(board))
    };

    let request = TaskReadRequest {
        address,
        actor: TaskReadActor::Agent(actor),
    };
    let point = match state.read.read_authorized_point(request).await {
        Ok(Some(value)) => value,
        Ok(None) => return not_found(),
        Err(_) => return safe_500(),
    };
    let viewer = ReadViewer::Agent(principal.agent().clone());
    let Some(source) = point.for_viewer(&viewer) else {
        return safe_500();
    };
    match project_detail(source) {
        Ok(task) => (StatusCode::OK, Json(serde_json::json!({"task":task}))).into_response(),
        Err(_) => safe_500(),
    }
}

fn query_map(raw: Option<&str>) -> Result<HashMap<String, String>, ()> {
    let mut values = HashMap::new();
    for (key, value) in form_urlencoded::parse(raw.unwrap_or_default().as_bytes()) {
        if !matches!(
            key.as_ref(),
            "task_id" | "task_number" | "workspace_id" | "workspace_name"
        ) {
            continue;
        }
        if value.is_empty() && matches!(key.as_ref(), "workspace_id" | "workspace_name") {
            continue;
        }
        values
            .entry(key.into_owned())
            .or_insert_with(|| value.into_owned());
    }
    if values.contains_key("workspace_id") && values.contains_key("workspace_name") {
        return Err(());
    }
    Ok(values)
}

fn board_refusal(refusal: BoardResolveRefusal) -> Response {
    let status = match &refusal {
        BoardResolveRefusal::UnknownWorkspace { .. } => StatusCode::NOT_FOUND,
        BoardResolveRefusal::AmbiguousWorkspace { .. } => StatusCode::CONFLICT,
        BoardResolveRefusal::WorkspaceMembershipRequired { .. } => StatusCode::FORBIDDEN,
    };
    (
        status,
        Json(serde_json::json!({"error":refusal.reason(),"code":refusal.code()})),
    )
        .into_response()
}
fn invalid() -> Response {
    (
        StatusCode::BAD_REQUEST,
        Json(serde_json::json!({"error":"invalid input","code":"invalid_input"})),
    )
        .into_response()
}
fn capability_denied() -> Response {
    (
        StatusCode::FORBIDDEN,
        Json(serde_json::json!({
            "code":"capability_denied",
            "capability":"read_tasks",
            "message":"missing 'read_tasks' capability in this workspace",
            "details":{"capability":"read_tasks"}
        })),
    )
        .into_response()
}
fn not_found() -> Response {
    (
        StatusCode::NOT_FOUND,
        Json(serde_json::json!({"error":"task not found","code":"not_found"})),
    )
        .into_response()
}
fn safe_500() -> Response {
    (StatusCode::INTERNAL_SERVER_ERROR, "Internal Server Error").into_response()
}

#[cfg(test)]
mod tests {
    use std::{
        collections::HashSet,
        sync::{
            Arc,
            atomic::{AtomicUsize, Ordering},
        },
    };

    use super::*;
    use axum::{
        body::{Body, to_bytes},
        extract::Extension,
        http::Request,
    };
    use serde::Deserialize;
    use silverhand_backend_core::{
        conversation_messaging::messaging::task::{
            BoardKey, BoardResolution, PairKey, TaskByIdCapability, TaskWriteCapability,
            VisibleTaskPoint, WorkspaceMembership,
        },
        foundation::{
            identity::{AgentId, ConversationId, DaemonInstanceId, UserId, WorkspaceId},
            persistence::PersistenceFailure,
        },
        host_runtime::runtime_credential::{RuntimeCustody, RuntimeGeneration, RuntimeScope},
        identity_access::workspace_name::CanonicalWorkspaceName,
    };
    use tower::ServiceExt;

    #[derive(Deserialize)]
    struct Fixture {
        canonical_query: Vec<QueryCase>,
    }

    #[derive(Deserialize)]
    struct QueryCase {
        raw: String,
        accepted: bool,
    }

    #[derive(Clone)]
    struct CountingBoards;

    impl TaskWriteDoorReads for CountingBoards {
        async fn may_mutate_task_by_id(
            &mut self,
            _task: &silverhand_backend_core::conversation_messaging::messaging::task::TaskId,
            _agent: &AgentId,
            _required: TaskByIdCapability,
        ) -> Result<bool, PersistenceFailure> {
            Ok(false)
        }

        async fn workspaces_named(
            &mut self,
            _canonical: &CanonicalWorkspaceName,
        ) -> Result<Vec<WorkspaceId>, PersistenceFailure> {
            Ok(Vec::new())
        }

        async fn conversation_board(
            &mut self,
            _conversation: &ConversationId,
        ) -> Result<Option<BoardKey>, PersistenceFailure> {
            Ok(Some(BoardKey::Pair(PairKey::parse("a__b").unwrap())))
        }

        async fn workspace_membership(
            &mut self,
            _workspace: &WorkspaceId,
            _agent: &AgentId,
        ) -> Result<WorkspaceMembership, PersistenceFailure> {
            Ok(WorkspaceMembership::Member)
        }

        async fn has_capability(
            &mut self,
            _capability: TaskWriteCapability,
            _workspace: &WorkspaceId,
            _agent: &AgentId,
        ) -> Result<bool, PersistenceFailure> {
            Ok(true)
        }
    }

    impl AgentBoardResolver for CountingBoards {
        async fn resolve_board(
            &mut self,
            request: &BoardScopeRequest,
        ) -> Result<BoardResolution, PersistenceFailure> {
            Ok(BoardResolution::Resolved(
                silverhand_backend_core::conversation_messaging::messaging::task::ResolvedBoard {
                    agent: request.agent.clone(),
                    source: request.source.clone(),
                    board: BoardKey::Pair(PairKey::parse("a__b").unwrap()),
                },
            ))
        }
    }

    impl TaskParticipationReads for CountingBoards {
        async fn is_agent_participant(
            &mut self,
            _conversation: &ConversationId,
            _agent: &AgentId,
        ) -> Result<bool, PersistenceFailure> {
            Ok(true)
        }

        async fn is_user_participant(
            &mut self,
            _conversation: &ConversationId,
            _user: &UserId,
        ) -> Result<bool, PersistenceFailure> {
            Ok(true)
        }

        async fn agent_participating_conversations(
            &mut self,
            _agent: &AgentId,
            conversations: &[ConversationId],
        ) -> Result<HashSet<ConversationId>, PersistenceFailure> {
            Ok(conversations.iter().cloned().collect())
        }
    }

    impl TaskReadCapability for CountingBoards {
        async fn may_read_tasks(
            &mut self,
            _agent: &AgentId,
            _workspace: &WorkspaceId,
        ) -> Result<bool, PersistenceFailure> {
            Ok(true)
        }

        async fn readable_task_workspaces(
            &mut self,
            _agent: &AgentId,
            workspaces: &[WorkspaceId],
        ) -> Result<HashSet<WorkspaceId>, PersistenceFailure> {
            Ok(workspaces.iter().cloned().collect())
        }
    }

    #[derive(Clone)]
    struct CountingRead(Arc<AtomicUsize>);

    impl TaskAuthorizedPointRead for CountingRead {
        async fn read_authorized_point(
            &self,
            _request: TaskReadRequest,
        ) -> Result<Option<VisibleTaskPoint>, PersistenceFailure> {
            self.0.fetch_add(1, Ordering::SeqCst);
            Ok(None)
        }

        async fn read_authorized_point_by_conversation_number(
            &self,
            _viewer: UserId,
            _conversation: ConversationId,
            _number: silverhand_backend_core::conversation_messaging::messaging::task::TaskNumber,
        ) -> Result<Option<VisibleTaskPoint>, PersistenceFailure> {
            unreachable!("internal detail uses the address-bound method")
        }
    }

    fn principal() -> RuntimePrincipal {
        RuntimePrincipal::for_scope(
            RuntimeScope::ConversationSlot {
                agent: AgentId::parse("agent-1").unwrap(),
                source: ConversationId::parse("conv-1").unwrap(),
            },
            RuntimeCustody::new(
                RuntimeGeneration::new(1).unwrap(),
                DaemonInstanceId::parse("daemon-1").unwrap(),
            ),
        )
    }

    #[test]
    fn internal_query_strips_unknowns_uses_first_and_keeps_selector_xor() {
        let values = query_map(Some(
            "future=x&task_number=9&task_number=10&workspace_id=&workspace_name=alpha",
        ))
        .unwrap();
        assert_eq!(values.get("task_number").map(String::as_str), Some("9"));
        assert_eq!(
            values.get("workspace_name").map(String::as_str),
            Some("alpha")
        );
        assert!(!values.contains_key("workspace_id"));
        assert!(!values.contains_key("future"));
        assert!(query_map(Some("workspace_id=w&workspace_name=n")).is_err());
    }

    #[tokio::test]
    async fn detail_ambiguity_projects_no_candidate_coordinates() {
        let response = board_refusal(BoardResolveRefusal::AmbiguousWorkspace {
            reason: "2 workspaces named \"alpha\"; disambiguate with --workspace-id".to_owned(),
            candidates: vec![
                silverhand_backend_core::foundation::identity::WorkspaceId::parse("ws-secret-a")
                    .unwrap(),
                silverhand_backend_core::foundation::identity::WorkspaceId::parse("ws-secret-b")
                    .unwrap(),
            ],
        });
        assert_eq!(response.status(), StatusCode::CONFLICT);
        let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(
            json,
            serde_json::json!({
                "error":"2 workspaces named \"alpha\"; disambiguate with --workspace-id",
                "code":"ambiguous_workspace"
            })
        );
        assert!(json.get("candidates").is_none());
        assert!(json.get("workspace_candidates").is_none());
    }

    #[tokio::test]
    async fn detail_route_consumes_canonical_decimal_corpus_before_authorized_read() {
        let fixture: Fixture = serde_json::from_str(include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../../packages/shared/tests/fixtures/task-schedule-wire-canonicalization.json"
        )))
        .unwrap();
        for case in fixture.canonical_query {
            let encoded: String = form_urlencoded::byte_serialize(case.raw.as_bytes()).collect();
            let calls = Arc::new(AtomicUsize::new(0));
            let app = task_detail_router(TaskDetailState {
                boards: CountingBoards,
                read: CountingRead(Arc::clone(&calls)),
            })
            .layer(Extension(principal()));
            let response = app
                .oneshot(
                    Request::builder()
                        .uri(format!(
                            "/internal/agents/agent-1/tasks/detail?task_number={encoded}"
                        ))
                        .body(Body::empty())
                        .unwrap(),
                )
                .await
                .unwrap();
            assert_eq!(
                response.status(),
                if case.accepted {
                    StatusCode::NOT_FOUND
                } else {
                    StatusCode::BAD_REQUEST
                },
                "{:?}",
                case.raw
            );
            assert_eq!(
                calls.load(Ordering::SeqCst),
                usize::from(case.accepted),
                "{:?}",
                case.raw
            );
        }
    }
}
