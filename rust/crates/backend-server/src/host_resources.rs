//! Authenticated cold face for `GET /api/hosts/{id}/resources`: the agents
//! registered on one computer, for the requester that computer belongs to.
//!
//! The order the two authorities run in is the whole shape of this route:
//!
//!  1. ACCESS — is this computer this requester's? An absent computer and someone
//!     else's collapse to ONE byte-identical
//!     `404 {"error":"host not found","error_code":"host_not_found"}`, so the
//!     surface can never become an existence oracle for computer ids.
//!  2. PROJECTION — build the list ONLY once the requester is admitted. A refused
//!     requester never learns whether the computer has agents, let alone which.
//!
//! Both steps are one call ([`visible_host_resources`]): the agents are unreachable
//! without it, so this route cannot project a list it did not gate, and cannot gate
//! one computer while rendering another's rows.
//!
//! The human principal is proof the authenticating perimeter ran; its ABSENCE is a
//! composition fault, not a product request, so it takes a fail-closed `500` having
//! read nothing. Mounting the real bearer perimeter is the composition root's job
//! (#task:2197), not this factory's.

use axum::{
    Json, Router,
    extract::{Extension, Path, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::get,
};
use serde::Serialize;
use silverhand_backend_core::{
    host_resources_read::{HostAgentResourceFact, HostResourcesReadModel, visible_host_resources},
    identity::{HostId, UserId},
};

use crate::error;

/// The product route template, in axum's `{id}` capture syntax.
pub const HOST_RESOURCES_PATH: &str = "/api/hosts/{id}/resources";

/// The anti-enumeration refusal, pinned to the TypeScript handler
/// (`c.json({ error: 'host not found', error_code: 'host_not_found' }, 404)`) so a
/// fixture drift shows here.
const HOST_NOT_FOUND: &str = "host not found";
const HOST_NOT_FOUND_CODE: &str = "host_not_found";

/// The unmapped-error body: the product route registers no `onError`, so an
/// unexpected failure falls to the framework default — a `500` with a bare
/// `text/plain` `Internal Server Error`, never a JSON envelope.
const INTERNAL_ERROR_BODY: &str = "Internal Server Error";

#[derive(Clone)]
struct ResourcesState<R> {
    cold_read: R,
}

pub fn router<R>(cold_read: R) -> Router
where
    R: HostResourcesReadModel + Clone + Send + Sync + 'static,
{
    Router::new()
        .route(HOST_RESOURCES_PATH, get(host_resources::<R>))
        .with_state(ResourcesState { cold_read })
}

async fn host_resources<R>(
    Path(host_id): Path<String>,
    requester: Option<Extension<UserId>>,
    State(state): State<ResourcesState<R>>,
) -> Response
where
    R: HostResourcesReadModel,
{
    let Some(Extension(requester)) = requester else {
        tracing::error!("host-resources route reached without its human principal fact");
        return internal_error();
    };

    // A malformed id names no computer — the same 404 an absent row gets, so the
    // surface never distinguishes "unparseable" from "not there".
    let Ok(computer) = HostId::parse(host_id) else {
        return not_found();
    };

    let facts = match state.cold_read.read_host_resources(&computer).await {
        Ok(facts) => facts,
        Err(cause) => {
            tracing::error!(
                error_chain = %error::describe(&cause),
                "host-resources read failed"
            );
            return internal_error();
        }
    };

    let visible = match visible_host_resources(&requester, &computer, facts.as_ref()) {
        Ok(visible) => visible,
        // The resolver answered about another computer, or listed a row filed under
        // one: a defect the requester cannot cause and cannot act on, so it takes the
        // lane's safe 500 rather than a plausible 404.
        Err(mismatch) => {
            tracing::error!(
                error_chain = %error::describe(&mismatch),
                "host-resources facts did not describe the requested computer"
            );
            return internal_error();
        }
    };
    let Some(agents) = visible else {
        return not_found();
    };

    Json(HostResourcesResponse {
        agents: agents.iter().map(resource_dto).collect(),
    })
    .into_response()
}

/// Success body: `{ "agents": [HostAgentResource] }`.
#[derive(Serialize)]
struct HostResourcesResponse {
    agents: Vec<HostAgentResourceDto>,
}

/// The wire projection of one registered agent — field-for-field the TypeScript
/// `HostAgentResource`, which is deliberately four columns copied off the row. The
/// full agent DTO is a different face; widening this one would leak a computer's
/// agents' profiles into a resource inventory.
#[derive(Serialize)]
struct HostAgentResourceDto {
    id: String,
    name: String,
    display_name: String,
    /// Rendered from the closed set's own spelling, so this route has no way to put a
    /// token the schema does not name on the wire.
    runtime: &'static str,
}

fn resource_dto(agent: &HostAgentResourceFact) -> HostAgentResourceDto {
    HostAgentResourceDto {
        id: agent.id.as_str().to_string(),
        name: agent.name.clone(),
        display_name: agent.display_name.clone(),
        runtime: agent.runtime.as_str(),
    }
}

/// The refusal body: this face carries a machine-readable `error_code` beside the
/// message, so both are pinned.
#[derive(Serialize)]
struct ErrorBody {
    error: &'static str,
    error_code: &'static str,
}

fn not_found() -> Response {
    (
        StatusCode::NOT_FOUND,
        Json(ErrorBody {
            error: HOST_NOT_FOUND,
            error_code: HOST_NOT_FOUND_CODE,
        }),
    )
        .into_response()
}

fn internal_error() -> Response {
    (StatusCode::INTERNAL_SERVER_ERROR, INTERNAL_ERROR_BODY).into_response()
}

#[cfg(test)]
mod tests {
    use std::{
        io,
        sync::{
            Arc,
            atomic::{AtomicUsize, Ordering::SeqCst},
        },
    };

    use axum::{
        body::{Body, to_bytes},
        http::{Request, StatusCode},
    };
    use serde_json::{Value, json};
    use silverhand_backend_core::{
        agents::runtime::RuntimeKind,
        host_resources_read::{HostAgentResourceFact, HostResourcesFacts},
        identity::AgentId,
        identity_access::capability::computer_access::ComputerOwnershipFacts,
        persistence::PersistenceFailure,
    };
    use tower::ServiceExt;

    use super::*;

    const REQUESTER: &str = "u-requester";

    fn user(id: &str) -> UserId {
        UserId::parse(id).expect("user id")
    }

    fn host(id: &str) -> HostId {
        HostId::parse(id).expect("host id")
    }

    fn agent_on(id: &str, computer: &str) -> HostAgentResourceFact {
        HostAgentResourceFact {
            id: AgentId::parse(id).expect("agent id"),
            computer: host(computer),
            name: format!("{id}-name"),
            display_name: format!("{id} display"),
            runtime: RuntimeKind::Qoder,
        }
    }

    /// Facts for computer `id`, owned by `owner`, listing `agents`.
    fn facts(id: &str, owner: Option<&str>, agents: Vec<HostAgentResourceFact>) -> ReadOutcome {
        ReadOutcome::Present(HostResourcesFacts::from_ownership(
            ComputerOwnershipFacts {
                id: host(id),
                owner: owner.map(user),
            },
            agents,
        ))
    }

    /// The ordinary admitting bundle: computer `h1`, owned by the requester.
    fn admitting() -> ReadOutcome {
        facts("h1", Some(REQUESTER), vec![agent_on("a1", "h1")])
    }

    #[derive(Clone)]
    enum ReadOutcome {
        Present(HostResourcesFacts),
        Absent,
        Fails,
    }

    #[derive(Clone)]
    struct FakeResources {
        outcome: ReadOutcome,
        calls: Arc<AtomicUsize>,
    }

    impl HostResourcesReadModel for FakeResources {
        async fn read_host_resources(
            &self,
            _computer: &HostId,
        ) -> Result<Option<HostResourcesFacts>, PersistenceFailure> {
            self.calls.fetch_add(1, SeqCst);
            match &self.outcome {
                ReadOutcome::Present(facts) => Ok(Some(facts.clone())),
                ReadOutcome::Absent => Ok(None),
                ReadOutcome::Fails => Err(PersistenceFailure::from_source(io::Error::other(
                    "resources gone",
                ))),
            }
        }
    }

    struct Reply {
        status: StatusCode,
        body: String,
        calls: usize,
    }

    async fn get(outcome: ReadOutcome) -> Reply {
        get_for(outcome, "h1", true).await
    }

    /// Drive the route for `/api/hosts/{path_id}/resources`; `path_id` lets a test
    /// ask about a different computer than the resolver answers about.
    async fn get_for(outcome: ReadOutcome, path_id: &str, with_principal: bool) -> Reply {
        let calls = Arc::new(AtomicUsize::new(0));
        let reads = FakeResources {
            outcome,
            calls: calls.clone(),
        };
        let mut request = Request::get(format!("/api/hosts/{path_id}/resources"));
        if with_principal {
            request = request.extension(user(REQUESTER));
        }
        let response = router(reads)
            .oneshot(request.body(Body::empty()).unwrap())
            .await
            .unwrap();
        let status = response.status();
        let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        Reply {
            status,
            body: String::from_utf8(body.to_vec()).unwrap(),
            calls: calls.load(SeqCst),
        }
    }

    fn parsed(body: &str) -> Value {
        serde_json::from_str::<Value>(body).unwrap()
    }

    #[tokio::test]
    async fn the_owner_gets_the_resource_list_in_the_order_it_was_read() {
        let reply = get(facts(
            "h1",
            Some(REQUESTER),
            vec![agent_on("a1", "h1"), agent_on("a2", "h1")],
        ))
        .await;
        assert_eq!(reply.status, StatusCode::OK);
        assert_eq!(
            parsed(&reply.body),
            json!({
                "agents": [
                    {
                        "id": "a1",
                        "name": "a1-name",
                        "display_name": "a1 display",
                        "runtime": "qoder"
                    },
                    {
                        "id": "a2",
                        "name": "a2-name",
                        "display_name": "a2 display",
                        "runtime": "qoder"
                    }
                ]
            })
        );
        assert_eq!(reply.calls, 1);
    }

    /// An owned computer with no agents is a `200` empty list — the answer that
    /// tells "yours, and idle" apart from "not yours".
    #[tokio::test]
    async fn an_owned_computer_with_no_agents_is_an_empty_list() {
        let reply = get(facts("h1", Some(REQUESTER), vec![])).await;
        assert_eq!(reply.status, StatusCode::OK);
        assert_eq!(parsed(&reply.body), json!({ "agents": [] }));
    }

    /// Every way a requester may see nothing renders the SAME bytes, so the surface
    /// is not an existence oracle: an absent computer, someone else's, one no user
    /// owns, and an id that is not an id at all.
    #[tokio::test]
    async fn every_refusal_is_one_byte_identical_anti_enumeration_404() {
        let refused = json!({ "error": "host not found", "error_code": "host_not_found" });
        for outcome in [
            ReadOutcome::Absent,
            facts("h1", Some("u-someone-else"), vec![agent_on("a1", "h1")]),
            facts("h1", None, vec![agent_on("a1", "h1")]),
        ] {
            let reply = get(outcome).await;
            assert_eq!(reply.status, StatusCode::NOT_FOUND);
            assert_eq!(parsed(&reply.body), refused);
            assert_eq!(reply.calls, 1);
        }

        // An unparseable id is refused before any read: there is no computer to read.
        // The empty segment is not an arbitrary choice — the empty string is the ONLY
        // input `HostId::parse` rejects, so a more exotic-looking bad id would parse
        // fine and quietly make this a duplicate of the absent-row case above.
        let reply = get_for(admitting(), "", true).await;
        assert_eq!(reply.status, StatusCode::NOT_FOUND);
        assert_eq!(parsed(&reply.body), refused);
        assert_eq!(reply.calls, 0);
    }

    /// The principal is the perimeter's contribution; without it the route reads
    /// NOTHING and fails closed, rather than guessing a requester.
    #[tokio::test]
    async fn a_missing_principal_reads_nothing_and_fails_closed() {
        let reply = get_for(admitting(), "h1", false).await;
        assert_eq!(reply.status, StatusCode::INTERNAL_SERVER_ERROR);
        assert_eq!(reply.body, "Internal Server Error");
        assert_eq!(reply.calls, 0);
    }

    #[tokio::test]
    async fn a_failed_read_is_the_frameworks_plain_500() {
        let reply = get(ReadOutcome::Fails).await;
        assert_eq!(reply.status, StatusCode::INTERNAL_SERVER_ERROR);
        assert_eq!(reply.body, "Internal Server Error");
    }

    /// Facts about another computer — owned by the asker, so the ownership rule
    /// would ADMIT them — are a resolver defect, and must not render as `h2`'s list
    /// under `h1`'s id, nor hide as a `404`.
    #[tokio::test]
    async fn facts_about_another_computer_are_a_500_not_a_404_and_not_a_list() {
        let reply = get_for(
            facts("h1", Some(REQUESTER), vec![agent_on("a1", "h1")]),
            "h2",
            true,
        )
        .await;
        assert_eq!(reply.status, StatusCode::INTERNAL_SERVER_ERROR);
        assert_eq!(reply.body, "Internal Server Error");
    }

    /// The splice inside an otherwise legitimate answer: the requester's own
    /// computer, carrying a row filed under a different one.
    #[tokio::test]
    async fn an_agent_filed_under_another_computer_is_a_500() {
        let reply = get(facts(
            "h1",
            Some(REQUESTER),
            vec![agent_on("a1", "h1"), agent_on("a2", "h2")],
        ))
        .await;
        assert_eq!(reply.status, StatusCode::INTERNAL_SERVER_ERROR);
        assert_eq!(reply.body, "Internal Server Error");
    }
}
