//! Internal agent schedule LIST — `POST /internal/agents/{aid}/schedules/list`.
//!
//! The agent-owned list: a union over every conversation the owner has scheduled
//! into, filtered by the closed status family and capped at `1..=200`. It takes no
//! address — schedules are owned by the AGENT, so there is no single stream to name
//! (`ScheduleListInputSchema` carries only `status?`/`limit?`).
//!
//! Authentication is the internal runtime credential; the acting owner is bound to
//! the path `{aid}` by the shared shared runtime-actor binding
//! gate BEFORE the read — the SAME identity gate the create and cancel faces use,
//! scoped to internal agent-owned scheduling. The list read reuses the existing
//! [`ScheduleListReadModel`] authority (the mounted public list's port); this face
//! only differs in its door (POST body + runtime credential vs GET + human viewer).

use std::sync::Arc;

use axum::{
    Json, Router,
    extract::{Path, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::post,
};
use garde::Validate;
use serde::{Deserialize, Serialize};
use silverhand_backend_core::conversation_messaging::messaging::schedule::{
    ScheduleListLimit, ScheduleListQuery, ScheduleListReadModel, ScheduleStatusFilter,
};
use silverhand_backend_core::host_runtime::runtime_credential::RuntimePrincipal;

use crate::foundation::wire_admission::{ValidatedJson, ValidatedJsonRejection};
use crate::foundation::wire_patch::RequiredPatchField;
use crate::scheduling::wire::ScheduleDto;

/// The list face's mounted path.
pub const SCHEDULE_LIST_PATH: &str = "/internal/agents/{aid}/schedules/list";

/// The list request body (`ScheduleListInputSchema`): an optional status filter and
/// an optional limit. Serde strips unknown keys (Zod `z.object`); the status family
/// and the `1..=200` range are validated in [`TryFrom`] via the existing domain
/// value objects, so a bad token/limit is one minimal `422 {"error":"invalid input"}`.
#[derive(Debug, Deserialize, Validate)]
pub(crate) struct ScheduleListBody {
    #[garde(skip)]
    #[serde(default)]
    status: RequiredPatchField<String>,
    #[garde(skip)]
    #[serde(default)]
    limit: RequiredPatchField<i64>,
}

/// The validated list query filter + limit, in domain vocabulary.
struct ValidatedListInput {
    filter: ScheduleStatusFilter,
    limit: ScheduleListLimit,
}

impl TryFrom<ScheduleListBody> for ValidatedListInput {
    type Error = ();

    fn try_from(body: ScheduleListBody) -> Result<Self, Self::Error> {
        // Absent status → `all` (the `status ?? 'all'` default); a present token
        // must be in the closed family.
        let filter = match body.status.into_option() {
            None => ScheduleStatusFilter::All,
            Some(token) => ScheduleStatusFilter::parse(&token).map_err(|_| ())?,
        };
        let limit = match body.limit.into_option() {
            None => ScheduleListLimit::DEFAULT,
            Some(value) => ScheduleListLimit::parse(value).map_err(|_| ())?,
        };
        Ok(ValidatedListInput { filter, limit })
    }
}

/// Everything the list door needs.
pub struct ScheduleListState<R> {
    pub list_reads: R,
}

type Shared<R> = State<Arc<ScheduleListState<R>>>;

/// The internal list router. Backend-app applies the runtime credential authority
/// and mounts it; this returns it unmounted.
pub fn schedule_list_router<R>(state: ScheduleListState<R>) -> Router
where
    R: ScheduleListReadModel + Send + Sync + 'static,
{
    Router::new()
        .route(SCHEDULE_LIST_PATH, post(list_route::<R>))
        .with_state(Arc::new(state))
}

async fn list_route<R>(
    State(state): Shared<R>,
    Path(aid): Path<String>,
    principal: Option<axum::extract::Extension<RuntimePrincipal>>,
    body: Result<ValidatedJson<ScheduleListBody>, ValidatedJsonRejection>,
) -> Response
where
    R: ScheduleListReadModel + Send + Sync + 'static,
{
    // IDENTITY GATE FIRST — the shared owner binding; a credential for another
    // agent is refused before the read is ever issued.
    let owner = match crate::host_runtime::runtime_credential::bind_runtime_actor(
        principal.as_ref().map(|extension| &extension.0),
        &aid,
    ) {
        Ok(principal) => principal.agent().clone(),
        Err(refusal) => return refusal.into_response(),
    };

    let body = match body {
        Ok(ValidatedJson(body)) => body,
        Err(rejection) => return rejection.into_response(),
    };
    let Ok(input) = ValidatedListInput::try_from(body) else {
        return invalid_input();
    };

    let query = ScheduleListQuery {
        owner_agent_id: owner,
        statuses: input.filter.expand(),
        limit: input.limit,
    };
    match state.list_reads.list_owned_schedules(&query).await {
        Ok(views) => {
            let schedules: Vec<ScheduleDto> = views.into_iter().map(ScheduleDto::from).collect();
            (StatusCode::OK, Json(ListBody { schedules })).into_response()
        }
        Err(cause) => {
            tracing::error!(
                error_chain = crate::foundation::safe_log_field::safe_display(
                    &(crate::foundation::error::describe(&cause))
                ),
                "internal agent-schedules-list read failed"
            );
            (StatusCode::INTERNAL_SERVER_ERROR, "Internal Server Error").into_response()
        }
    }
}

/// `{ schedules: [ScheduleDto] }` — `ScheduleListOutputSchema`.
#[derive(Serialize)]
struct ListBody {
    schedules: Vec<ScheduleDto>,
}

fn invalid_input() -> Response {
    (
        StatusCode::UNPROCESSABLE_ENTITY,
        Json(InvalidInputBody {
            error: "invalid input",
        }),
    )
        .into_response()
}

#[derive(Serialize)]
struct InvalidInputBody {
    error: &'static str,
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::{Body, to_bytes};
    use axum::extract::Extension;
    use axum::http::Request;
    use serde_json::Value;
    use silverhand_backend_core::conversation_messaging::messaging::schedule::ScheduleView;
    use silverhand_backend_core::foundation::identity::{AgentId, DaemonInstanceId};
    use silverhand_backend_core::foundation::persistence::PersistenceFailure;
    use silverhand_backend_core::host_runtime::runtime_credential::{
        RuntimeCustody, RuntimeGeneration, RuntimePrincipal, RuntimeScope,
    };
    use std::sync::Arc;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use tower::ServiceExt;

    type SeenQuery = Arc<std::sync::Mutex<Option<ScheduleListQuery>>>;

    fn agent_slot(agent: &str) -> RuntimePrincipal {
        RuntimePrincipal::for_scope(
            RuntimeScope::AgentSlot {
                agent: AgentId::parse(agent).unwrap(),
            },
            RuntimeCustody::new(
                RuntimeGeneration::new(1).unwrap(),
                DaemonInstanceId::parse("daemon-1").unwrap(),
            ),
        )
    }

    /// A list read that records the query it received and returns nothing.
    struct Reads {
        calls: Arc<AtomicUsize>,
        seen_query: SeenQuery,
    }
    impl ScheduleListReadModel for Reads {
        async fn list_owned_schedules(
            &self,
            query: &ScheduleListQuery,
        ) -> Result<Vec<ScheduleView>, PersistenceFailure> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            *self.seen_query.lock().unwrap() = Some(query.clone());
            Ok(Vec::new())
        }
    }

    fn app() -> (Router, Arc<AtomicUsize>, SeenQuery) {
        let calls = Arc::new(AtomicUsize::new(0));
        let seen = Arc::new(std::sync::Mutex::new(None));
        let router = schedule_list_router(ScheduleListState {
            list_reads: Reads {
                calls: Arc::clone(&calls),
                seen_query: Arc::clone(&seen),
            },
        })
        .layer(Extension(agent_slot("agent-1")));
        (router, calls, seen)
    }

    async fn call_at(app: Router, path_aid: &str, body: &str) -> (StatusCode, Value) {
        let response = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri(format!("/internal/agents/{path_aid}/schedules/list"))
                    .header("content-type", "application/json")
                    .body(Body::from(body.to_owned()))
                    .unwrap(),
            )
            .await
            .unwrap();
        let status = response.status();
        let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        let value: Value = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
        (status, value)
    }

    #[tokio::test]
    async fn an_empty_body_lists_all_with_the_default_limit() {
        let (app, calls, seen) = app();
        let (status, body) = call_at(app, "agent-1", r#"{}"#).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["schedules"], serde_json::json!([]));
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        // `all` -> no status constraint.
        let query = seen.lock().unwrap().clone().unwrap();
        assert_eq!(query.statuses, None);
        assert_eq!(query.limit.get(), 100);
        assert_eq!(query.owner_agent_id.as_str(), "agent-1");
    }

    #[tokio::test]
    async fn the_active_alias_expands_to_pending_and_firing() {
        let (app, _calls, seen) = app();
        let (status, _body) = call_at(app, "agent-1", r#"{"status":"active","limit":1}"#).await;
        assert_eq!(status, StatusCode::OK);
        let query = seen.lock().unwrap().clone().unwrap();
        assert_eq!(
            query.statuses,
            Some(vec![
                silverhand_backend_core::conversation_messaging::messaging::schedule::ScheduleStatus::Pending,
                silverhand_backend_core::conversation_messaging::messaging::schedule::ScheduleStatus::Firing,
            ])
        );
        assert_eq!(query.limit.get(), 1);
    }

    #[tokio::test]
    async fn an_out_of_family_status_is_invalid_input_without_reaching_the_read() {
        let (app, calls, _seen) = app();
        let (status, body) = call_at(app, "agent-1", r#"{"status":"nonsense"}"#).await;
        assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
        assert_eq!(body["error"], "invalid input");
        assert_eq!(calls.load(Ordering::SeqCst), 0, "read zero-reach");
    }

    #[tokio::test]
    async fn optional_list_fields_reject_null_and_empty_status_zero_reach() {
        for body in [r#"{"status":null}"#, r#"{"limit":null}"#] {
            let (app, calls, _seen) = app();
            let (status, _body) = call_at(app, "agent-1", body).await;
            assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
            assert_eq!(calls.load(Ordering::SeqCst), 0, "read zero-reach");
        }
        let (app, calls, _seen) = app();
        let (status, body) = call_at(app, "agent-1", r#"{"status":""}"#).await;
        assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
        assert_eq!(body, serde_json::json!({"error":"invalid input"}));
        assert_eq!(calls.load(Ordering::SeqCst), 0, "read zero-reach");
    }

    #[tokio::test]
    async fn an_out_of_range_limit_is_invalid_input() {
        let (app, calls, _seen) = app();
        let (status, _body) = call_at(app, "agent-1", r#"{"limit":9999}"#).await;
        assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
        assert_eq!(calls.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn a_credential_for_another_agent_is_unauthorized_with_read_zero_reach() {
        // The SHARED identity gate again: agent-1 credential on agent-2 path -> 401
        // before the list read.
        let (app, calls, _seen) = app();
        let (status, body) = call_at(app, "agent-2", r#"{}"#).await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);
        assert_eq!(body["error"], "unauthorized");
        assert_eq!(calls.load(Ordering::SeqCst), 0, "list read zero-reach");
    }
}
