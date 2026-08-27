//! Authenticated `DELETE /api/hosts/{id}`: an owner hard-deletes a user-managed
//! computer together with everything rooted on it.
//!
//! This is deliberately NOT the revoke lifecycle — it removes the control-plane rows.
//! All policy, atomicity and consent live in the [`DeleteComputer`] domain; this route
//! only decodes the request and renders the outcome:
//!
//!  1. ADMIT / LEGALITY — the domain resolves whether the computer is this requester's
//!     and whether its lifecycle is theirs to end. An absent computer, someone else's,
//!     and one that vanished under the request collapse to ONE byte-identical `404`
//!     ([`DeleteComputerRefusal::NotTheirs`]), so the surface is never an existence
//!     oracle. A platform-owned computer is a `409 provisioning_source_not_supported`.
//!  2. CASCADE — the in-lock dependency set decides the rest: an in-flight
//!     materialization is `409 has_pending_agents`, an in-flight deletion is
//!     `409 agent_deletion_in_progress`, and an unconfirmed cascade is
//!     `409 has_dependents` carrying the very set it would have destroyed.
//!  3. AFTERMATH — the disconnect, the runtime stops, the host-local purge and the blob
//!     sweep are all best-effort and unrollbackable; the domain performs them after the
//!     commit and hands back what it could not finish ([`DeletedComputer::residue`] and
//!     `daemon_disconnect_failure`). This route logs that residue and still answers
//!     `200`, exactly as the TypeScript route swallows its disconnect failure.
//!
//! `cascade_dependents` is ONE boolean of consent, decoded here from a lenient body
//! (`HostDeleteInputSchema`: an object whose only field is optional, unknown keys
//! stripped, a missing or malformed body defaulting to no cascade). It is not
//! authorization — the domain re-decides legality under the lock regardless.
//!
//! The four teardown ports are REQUIREMENT SEAMS threaded through the generics and left
//! UNMOUNTED; the composition root binds the real read model, write mechanism, cascade
//! effects and websocket controller (#task:2197). The human principal's ABSENCE is a
//! composition fault, so it takes a fail-closed `500` having read nothing.

use std::sync::Arc;

use axum::{
    Json, Router,
    body::Bytes,
    extract::{Extension, Path, State},
    http::StatusCode,
    response::{IntoResponse, Response},
};
use serde::Serialize;
use silverhand_backend_core::{
    host_runtime::aftermath::DaemonConnectionControl,
    identity::{HostId, UserId},
    teardown::{
        cascade::{CascadeConsent, CascadeRefused},
        computer_delete::{
            ComputerCascadeEffects, DeleteComputer, DeleteComputerError, DeleteComputerRefusal,
        },
        facts::AgentTeardownFacts,
        read::AgentTeardownReadPort,
        write::AgentTeardownUnitOfWork,
    },
};

use crate::error;

use super::{ErrorBody, ZodIssue, host_not_found, internal_error, invalid_input};

/// The product route template, in axum's `{id}` capture syntax.
pub const HOST_DELETE_PATH: &str = "/api/hosts/{id}";

/// The kind refusal, pinned to the TypeScript handler
/// (`{ error: 'delete is only supported for user-managed computers',
/// error_code: 'provisioning_source_not_supported' }`).
const DELETE_UNSUPPORTED: &str = "delete is only supported for user-managed computers";
const PROVISIONING_SOURCE_NOT_SUPPORTED_CODE: &str = "provisioning_source_not_supported";

/// The in-flight-materialization refusal.
const HAS_PENDING_AGENTS: &str =
    "computer has agents whose creation is still in progress; try again after creation finishes";
const HAS_PENDING_AGENTS_CODE: &str = "has_pending_agents";

/// The in-flight-deletion refusal.
const DELETION_IN_PROGRESS: &str =
    "computer has agents whose deletion is already in progress; retry after deletion finishes";
const AGENT_DELETION_IN_PROGRESS_CODE: &str = "agent_deletion_in_progress";

/// The unconfirmed-cascade refusal, carrying what it would have destroyed.
const HAS_DEPENDENTS: &str = "computer has dependent resources";
const HAS_DEPENDENTS_CODE: &str = "has_dependents";

struct DeleteState<R, U, E, D> {
    delete: Arc<DeleteComputer<R, U, E, D>>,
}

impl<R, U, E, D> Clone for DeleteState<R, U, E, D> {
    fn clone(&self) -> Self {
        Self {
            delete: Arc::clone(&self.delete),
        }
    }
}

pub fn router<R, U, E, D>(delete: DeleteComputer<R, U, E, D>) -> Router
where
    R: AgentTeardownReadPort,
    U: AgentTeardownUnitOfWork,
    E: ComputerCascadeEffects,
    D: DaemonConnectionControl,
{
    Router::new()
        .route(
            HOST_DELETE_PATH,
            axum::routing::delete(handle_delete::<R, U, E, D>),
        )
        .with_state(DeleteState {
            delete: Arc::new(delete),
        })
}

async fn handle_delete<R, U, E, D>(
    Path(host_id): Path<String>,
    requester: Option<Extension<UserId>>,
    State(state): State<DeleteState<R, U, E, D>>,
    body: Bytes,
) -> Response
where
    R: AgentTeardownReadPort,
    U: AgentTeardownUnitOfWork,
    E: ComputerCascadeEffects,
    D: DaemonConnectionControl,
{
    let Some(Extension(requester)) = requester else {
        tracing::error!("host-delete route reached without its human principal fact");
        return internal_error();
    };

    // A malformed id names no computer — the same 404 an absent row gets, so the surface
    // never distinguishes "unparseable" from "not there".
    let Ok(computer) = HostId::parse(host_id) else {
        return host_not_found();
    };

    let consent = match parse_consent(&body) {
        Ok(consent) => consent,
        Err(issues) => return invalid_input(issues),
    };

    let host_id_echo = computer.as_str().to_owned();
    match state.delete.execute(&requester, computer, consent).await {
        Ok(deleted) => {
            // Best-effort aftermath: residue and a socket that would not close are
            // operator signal, not a product answer. The rows are already gone, so this
            // can only report what was left behind and still succeed.
            for residue in &deleted.residue {
                tracing::warn!(
                    effect = ?residue.effect,
                    agent = %residue.agent.as_str(),
                    error_chain = %error::describe(&residue.failure),
                    "delete-computer cascade left residue (continuing)"
                );
            }
            if let Some(failure) = &deleted.daemon_disconnect_failure {
                tracing::warn!(
                    error_chain = %error::describe(failure),
                    "delete-computer daemon disconnect failed (non-blocking)"
                );
            }
            tracing::info!(
                host_id = %host_id_echo,
                cascaded_agents = deleted.cascade.deleted_agents().count(),
                residue = deleted.residue.len(),
                "user-managed computer deleted with its dependents"
            );
            Json(DeleteResponse {
                host_id: host_id_echo,
                deleted: true,
            })
            .into_response()
        }
        Err(error) => delete_error_response(error),
    }
}

/// Decode the one boolean of consent from the request body.
///
/// Mirrors `HostDeleteInputSchema.safeParse(await c.req.json().catch(() => ({})))`: a
/// malformed or empty body becomes an empty object (no cascade), unknown keys are
/// stripped, and only a present-but-non-boolean `cascade_dependents` or a non-object
/// top level is a `400`.
fn parse_consent(body: &[u8]) -> Result<CascadeConsent, Vec<ZodIssue>> {
    let value = serde_json::from_slice::<serde_json::Value>(body)
        .unwrap_or_else(|_| serde_json::Value::Object(serde_json::Map::new()));
    match value {
        serde_json::Value::Object(map) => match map.get("cascade_dependents") {
            None => Ok(CascadeConsent::Absent),
            Some(serde_json::Value::Bool(confirmed)) => Ok(if *confirmed {
                CascadeConsent::Confirmed
            } else {
                CascadeConsent::Absent
            }),
            Some(other) => Err(vec![ZodIssue::InvalidType {
                code: "invalid_type",
                expected: "boolean",
                received: json_type(other),
                path: vec!["cascade_dependents".to_owned()],
                message: format!("Expected boolean, received {}", json_type(other)),
            }]),
        },
        other => Err(vec![ZodIssue::InvalidType {
            code: "invalid_type",
            expected: "object",
            received: json_type(&other),
            path: Vec::new(),
            message: format!("Expected object, received {}", json_type(&other)),
        }]),
    }
}

/// The Zod-facing name of a JSON value's type, for the invalid-input message.
fn json_type(value: &serde_json::Value) -> &'static str {
    match value {
        serde_json::Value::Null => "null",
        serde_json::Value::Bool(_) => "boolean",
        serde_json::Value::Number(_) => "number",
        serde_json::Value::String(_) => "string",
        serde_json::Value::Array(_) => "array",
        serde_json::Value::Object(_) => "object",
    }
}

/// Map a domain failure to its HTTP answer. A product refusal renders as-is; everything
/// else is a fail-closed `500`, logged with its cause chain.
fn delete_error_response(error: DeleteComputerError) -> Response {
    match error {
        DeleteComputerError::Refused(refusal) => refusal_response(&refusal),
        other => {
            tracing::error!(
                error_chain = %error::describe(&other),
                "host-delete failed"
            );
            internal_error()
        }
    }
}

fn refusal_response(refusal: &DeleteComputerRefusal) -> Response {
    match refusal {
        DeleteComputerRefusal::NotTheirs => host_not_found(),
        DeleteComputerRefusal::NotUserManaged => {
            conflict(DELETE_UNSUPPORTED, PROVISIONING_SOURCE_NOT_SUPPORTED_CODE)
        }
        DeleteComputerRefusal::Cascade(cascade) => cascade_refusal_response(cascade),
    }
}

fn cascade_refusal_response(refused: &CascadeRefused) -> Response {
    match refused {
        CascadeRefused::MaterializationInFlight { agents } => (
            StatusCode::CONFLICT,
            Json(PendingAgentsBody {
                error: HAS_PENDING_AGENTS,
                error_code: HAS_PENDING_AGENTS_CODE,
                pending_agents: *agents,
            }),
        )
            .into_response(),
        CascadeRefused::DeletionInFlight { agents } => (
            StatusCode::CONFLICT,
            Json(DeletionInProgressBody {
                error: DELETION_IN_PROGRESS,
                error_code: AGENT_DELETION_IN_PROGRESS_CODE,
                deleting_agents: *agents,
            }),
        )
            .into_response(),
        CascadeRefused::ConsentRequired { dependents } => (
            StatusCode::CONFLICT,
            Json(HasDependentsBody {
                error: HAS_DEPENDENTS,
                error_code: HAS_DEPENDENTS_CODE,
                dependents: DependentsCount {
                    agents: dependents.len(),
                },
                agents: dependents.iter().map(agent_resource_dto).collect(),
            }),
        )
            .into_response(),
    }
}

/// The wire projection of one dependent agent — field-for-field the TypeScript
/// `HostAgentResource`, kept next to the refusal it serves so it cannot drift from the
/// `GET /api/hosts/{id}/resources` list the dialog compares it against.
fn agent_resource_dto(agent: &AgentTeardownFacts) -> AgentResourceDto {
    AgentResourceDto {
        id: agent.id.as_str().to_owned(),
        name: agent.name.clone(),
        display_name: agent.display_name.clone(),
        runtime: agent.runtime.clone(),
    }
}

fn conflict(error: &'static str, error_code: &'static str) -> Response {
    (StatusCode::CONFLICT, Json(ErrorBody { error, error_code })).into_response()
}

/// Success body: `{ "host_id": ..., "deleted": true }`.
#[derive(Serialize)]
struct DeleteResponse {
    host_id: String,
    deleted: bool,
}

#[derive(Serialize)]
struct PendingAgentsBody {
    error: &'static str,
    error_code: &'static str,
    pending_agents: usize,
}

#[derive(Serialize)]
struct DeletionInProgressBody {
    error: &'static str,
    error_code: &'static str,
    deleting_agents: usize,
}

#[derive(Serialize)]
struct HasDependentsBody {
    error: &'static str,
    error_code: &'static str,
    dependents: DependentsCount,
    agents: Vec<AgentResourceDto>,
}

#[derive(Serialize)]
struct DependentsCount {
    agents: usize,
}

#[derive(Serialize)]
struct AgentResourceDto {
    id: String,
    name: String,
    display_name: String,
    runtime: String,
}

#[cfg(test)]
mod tests {
    use std::{
        io,
        sync::{Arc, Mutex},
    };

    use axum::{
        body::{Body, to_bytes},
        http::Request,
    };
    use serde_json::{Value, json};
    use silverhand_backend_core::{
        agent_lifecycle::MaterializationStatus,
        capability::computer_access::{
            ComputerAccess, ComputerOwnershipFacts, can_access_computer,
        },
        host_runtime::{
            aftermath::CustodyEffectFailure,
            computer::{HostKind, ProvisioningSource},
        },
        identity::AgentId,
        persistence::PersistenceFailure,
        teardown::{
            cascade::{
                CascadeAdmission, ComputerLifecycle, admit_cascade, hold_computer_lifecycle,
            },
            contract::TeardownFailure,
            eligibility::AgentTeardownEligibility,
            facts::{AgentRuntimeSessionFacts, ComputerTeardownFacts, StoredBlobRef},
            write::{
                AgentTeardownCommit, AgentTeardownKey, ComputerCascade, ComputerCascadeCommit,
                ComputerTeardownKey,
            },
        },
    };
    use tower::ServiceExt;

    use super::*;

    const REQUESTER: &str = "u-requester";
    const COMPUTER: &str = "h1";

    fn user(id: &str) -> UserId {
        UserId::parse(id).expect("user id")
    }

    fn host(id: &str) -> HostId {
        HostId::parse(id).expect("host id")
    }

    fn agent(id: &str) -> AgentId {
        AgentId::parse(id).expect("agent id")
    }

    fn agent_facts(id: &str, status: MaterializationStatus) -> AgentTeardownFacts {
        AgentTeardownFacts {
            id: agent(id),
            name: format!("{id}-name"),
            display_name: format!("{id} display"),
            runtime: "claude".into(),
            host_id: host(COMPUTER),
            materialization_status: status,
            failed_code: None,
            deletion_started_at: None,
        }
    }

    fn user_managed() -> ComputerTeardownFacts {
        ComputerTeardownFacts {
            id: host(COMPUTER),
            kind: HostKind::Remote,
            provisioning_source: ProvisioningSource::UserInvite,
        }
    }

    fn platform_owned() -> ComputerTeardownFacts {
        ComputerTeardownFacts {
            id: host(COMPUTER),
            kind: HostKind::Local,
            provisioning_source: ProvisioningSource::AppInstall,
        }
    }

    /// Build a committed cascade the way production mints it, through every rule.
    fn committed(dependents: Vec<AgentTeardownFacts>) -> ComputerCascadeCommit {
        let ComputerAccess::Held(access) = can_access_computer(
            &user(REQUESTER),
            Some(&ComputerOwnershipFacts {
                id: host(COMPUTER),
                owner: Some(user(REQUESTER)),
            }),
        ) else {
            panic!("expected the owner to be admitted");
        };
        let ComputerLifecycle::Held(lifecycle) =
            hold_computer_lifecycle(access, user_managed()).expect("one computer")
        else {
            panic!("expected a user-managed computer");
        };
        let CascadeAdmission::Admitted(admitted) =
            admit_cascade(lifecycle, dependents, CascadeConsent::Confirmed).expect("one computer")
        else {
            panic!("expected the cascade to be admitted");
        };
        // Only failed rows are row-only, and they owe no torn-down entry, so a cascade
        // built from failed dependents needs none. That is all these route tests drive.
        ComputerCascadeCommit::Committed(
            ComputerCascade::seal(
                &ComputerTeardownKey {
                    host_id: host(COMPUTER),
                    user_id: user(REQUESTER),
                },
                admitted,
                Vec::new(),
            )
            .expect("one cascade"),
        )
    }

    enum Ownership {
        Owned,
        Foreign,
        Absent,
        Fails,
    }

    struct WorldState {
        ownership: Ownership,
        lifecycle: Option<ComputerTeardownFacts>,
        commit: Option<ComputerCascadeCommit>,
        effects_fail: bool,
        disconnect_fails: bool,
        consent_seen: Option<CascadeConsent>,
        cascade_calls: usize,
    }

    #[derive(Clone)]
    struct World(Arc<Mutex<WorldState>>);

    impl World {
        /// The admitting bundle: an owned, user-managed computer whose write returns
        /// `commit`.
        fn admitting(commit: Option<ComputerCascadeCommit>) -> Self {
            Self(Arc::new(Mutex::new(WorldState {
                ownership: Ownership::Owned,
                lifecycle: Some(user_managed()),
                commit,
                effects_fail: false,
                disconnect_fails: false,
                consent_seen: None,
                cascade_calls: 0,
            })))
        }

        fn consent_seen(&self) -> Option<CascadeConsent> {
            self.0.lock().expect("state").consent_seen
        }

        fn cascade_calls(&self) -> usize {
            self.0.lock().expect("state").cascade_calls
        }
    }

    #[derive(Debug, thiserror::Error)]
    #[error("the double was told to fail")]
    struct Refused;

    impl AgentTeardownReadPort for World {
        async fn read_agent_facts(
            &self,
            _agent_id: &AgentId,
        ) -> Result<Option<AgentTeardownFacts>, PersistenceFailure> {
            unreachable!("the delete route never reads one agent's facts")
        }

        async fn is_deletion_pending(
            &self,
            _agent_id: &AgentId,
        ) -> Result<bool, PersistenceFailure> {
            unreachable!("the delete route never asks about one agent's intent")
        }

        async fn list_runtime_sessions(
            &self,
            _agent_id: &AgentId,
        ) -> Result<Vec<AgentRuntimeSessionFacts>, PersistenceFailure> {
            unreachable!("the delete route stops from the capture, never from a hint")
        }

        async fn read_computer_ownership(
            &self,
            _host_id: &HostId,
        ) -> Result<Option<ComputerOwnershipFacts>, PersistenceFailure> {
            let state = self.0.lock().expect("state");
            match state.ownership {
                Ownership::Owned => Ok(Some(ComputerOwnershipFacts {
                    id: host(COMPUTER),
                    owner: Some(user(REQUESTER)),
                })),
                Ownership::Foreign => Ok(Some(ComputerOwnershipFacts {
                    id: host(COMPUTER),
                    owner: Some(user("u-someone-else")),
                })),
                Ownership::Absent => Ok(None),
                Ownership::Fails => Err(PersistenceFailure::from_source(io::Error::other(
                    "ownership gone",
                ))),
            }
        }

        async fn read_computer_lifecycle(
            &self,
            _host_id: &HostId,
        ) -> Result<Option<ComputerTeardownFacts>, PersistenceFailure> {
            Ok(self.0.lock().expect("state").lifecycle.clone())
        }
    }

    impl AgentTeardownUnitOfWork for World {
        async fn tear_down_agent(
            &self,
            _key: AgentTeardownKey,
            _expected: AgentTeardownEligibility,
        ) -> Result<AgentTeardownCommit, TeardownFailure> {
            unreachable!("the delete route never tears down one agent")
        }

        async fn cascade_computer(
            &self,
            _key: ComputerTeardownKey,
            consent: CascadeConsent,
        ) -> Result<ComputerCascadeCommit, TeardownFailure> {
            let mut state = self.0.lock().expect("state");
            state.consent_seen = Some(consent);
            state.cascade_calls += 1;
            Ok(state.commit.take().expect("one cascade per test"))
        }
    }

    impl ComputerCascadeEffects for World {
        async fn agent_deleted(&self, _agent: &AgentId) -> Result<(), CustodyEffectFailure> {
            self.answer()
        }

        async fn stop_runtime_seat(
            &self,
            _computer: &HostId,
            _seat: &AgentRuntimeSessionFacts,
        ) -> Result<(), CustodyEffectFailure> {
            self.answer()
        }

        async fn purge_host_local_files(
            &self,
            _computer: &HostId,
            _agent: &AgentId,
        ) -> Result<(), CustodyEffectFailure> {
            self.answer()
        }

        async fn forget_stored_blob(
            &self,
            _blob: &StoredBlobRef,
        ) -> Result<(), CustodyEffectFailure> {
            self.answer()
        }
    }

    impl World {
        fn answer(&self) -> Result<(), CustodyEffectFailure> {
            if self.0.lock().expect("state").effects_fail {
                Err(CustodyEffectFailure::from_source(Refused))
            } else {
                Ok(())
            }
        }
    }

    impl DaemonConnectionControl for World {
        async fn disconnect(&self, _computer: HostId) -> Result<(), CustodyEffectFailure> {
            if self.0.lock().expect("state").disconnect_fails {
                Err(CustodyEffectFailure::from_source(Refused))
            } else {
                Ok(())
            }
        }
    }

    struct Reply {
        status: StatusCode,
        body: String,
    }

    async fn delete_request(
        world: &World,
        path_id: &str,
        with_principal: bool,
        body: &str,
    ) -> Reply {
        let app = router(DeleteComputer::new(
            world.clone(),
            world.clone(),
            world.clone(),
            world.clone(),
        ));
        let mut request = Request::delete(format!("/api/hosts/{path_id}"))
            .header("content-type", "application/json");
        if with_principal {
            request = request.extension(user(REQUESTER));
        }
        let response = app
            .oneshot(request.body(Body::from(body.to_owned())).unwrap())
            .await
            .unwrap();
        let status = response.status();
        let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        Reply {
            status,
            body: String::from_utf8(body.to_vec()).unwrap(),
        }
    }

    /// The ordinary owned request: an owned user-managed computer, custody effects clean.
    async fn delete(world: &World, body: &str) -> Reply {
        delete_request(world, COMPUTER, true, body).await
    }

    fn parsed(body: &str) -> Value {
        serde_json::from_str::<Value>(body).unwrap()
    }

    #[tokio::test]
    async fn an_owned_user_managed_computer_is_deleted_and_consent_is_confirmed() {
        let world = World::admitting(Some(committed(Vec::new())));
        let reply = delete(&world, r#"{"cascade_dependents":true}"#).await;
        assert_eq!(reply.status, StatusCode::OK);
        assert_eq!(
            parsed(&reply.body),
            json!({ "host_id": "h1", "deleted": true })
        );
        assert_eq!(world.consent_seen(), Some(CascadeConsent::Confirmed));
        assert_eq!(world.cascade_calls(), 1);
    }

    #[tokio::test]
    async fn a_missing_body_defaults_to_no_cascade() {
        let world = World::admitting(Some(committed(Vec::new())));
        let reply = delete(&world, "").await;
        assert_eq!(reply.status, StatusCode::OK);
        assert_eq!(world.consent_seen(), Some(CascadeConsent::Absent));
    }

    #[tokio::test]
    async fn cascade_dependents_false_is_absent_consent() {
        let world = World::admitting(Some(committed(Vec::new())));
        let reply = delete(&world, r#"{"cascade_dependents":false}"#).await;
        assert_eq!(reply.status, StatusCode::OK);
        assert_eq!(world.consent_seen(), Some(CascadeConsent::Absent));
    }

    #[tokio::test]
    async fn malformed_json_falls_back_to_no_cascade() {
        let world = World::admitting(Some(committed(Vec::new())));
        let reply = delete(&world, "not json").await;
        assert_eq!(reply.status, StatusCode::OK);
        assert_eq!(world.consent_seen(), Some(CascadeConsent::Absent));
    }

    #[tokio::test]
    async fn unknown_keys_are_stripped_not_refused() {
        let world = World::admitting(Some(committed(Vec::new())));
        let reply = delete(&world, r#"{"surprise":1}"#).await;
        assert_eq!(reply.status, StatusCode::OK);
        assert_eq!(world.consent_seen(), Some(CascadeConsent::Absent));
    }

    #[tokio::test]
    async fn a_missing_or_foreign_computer_is_one_byte_identical_404() {
        let refused = json!({ "error": "host not found", "error_code": "host_not_found" });
        for ownership in [Ownership::Absent, Ownership::Foreign] {
            let world = World(Arc::new(Mutex::new(WorldState {
                ownership,
                lifecycle: Some(user_managed()),
                commit: None,
                effects_fail: false,
                disconnect_fails: false,
                consent_seen: None,
                cascade_calls: 0,
            })));
            let reply = delete(&world, "{}").await;
            assert_eq!(reply.status, StatusCode::NOT_FOUND);
            assert_eq!(parsed(&reply.body), refused);
            assert_eq!(
                world.cascade_calls(),
                0,
                "a refused request never reaches the write"
            );
        }
    }

    #[tokio::test]
    async fn a_platform_owned_computer_is_409_provisioning_source_not_supported() {
        let world = World::admitting(None);
        world.0.lock().expect("state").lifecycle = Some(platform_owned());
        let reply = delete(&world, "{}").await;
        assert_eq!(reply.status, StatusCode::CONFLICT);
        assert_eq!(
            parsed(&reply.body),
            json!({
                "error": "delete is only supported for user-managed computers",
                "error_code": "provisioning_source_not_supported"
            })
        );
        assert_eq!(world.cascade_calls(), 0);
    }

    #[tokio::test]
    async fn an_in_flight_materialization_is_409_has_pending_agents() {
        let world = World::admitting(Some(ComputerCascadeCommit::Refused(
            CascadeRefused::MaterializationInFlight { agents: 2 },
        )));
        let reply = delete(&world, r#"{"cascade_dependents":true}"#).await;
        assert_eq!(reply.status, StatusCode::CONFLICT);
        assert_eq!(
            parsed(&reply.body),
            json!({
                "error": "computer has agents whose creation is still in progress; try again after creation finishes",
                "error_code": "has_pending_agents",
                "pending_agents": 2
            })
        );
    }

    #[tokio::test]
    async fn an_in_flight_deletion_is_409_agent_deletion_in_progress() {
        let world = World::admitting(Some(ComputerCascadeCommit::Refused(
            CascadeRefused::DeletionInFlight { agents: 3 },
        )));
        let reply = delete(&world, r#"{"cascade_dependents":true}"#).await;
        assert_eq!(reply.status, StatusCode::CONFLICT);
        assert_eq!(
            parsed(&reply.body),
            json!({
                "error": "computer has agents whose deletion is already in progress; retry after deletion finishes",
                "error_code": "agent_deletion_in_progress",
                "deleting_agents": 3
            })
        );
    }

    #[tokio::test]
    async fn an_unconfirmed_cascade_is_409_has_dependents_with_the_projected_payload() {
        let world = World::admitting(Some(ComputerCascadeCommit::Refused(
            CascadeRefused::ConsentRequired {
                dependents: vec![agent_facts("a1", MaterializationStatus::Active)],
            },
        )));
        let reply = delete(&world, "{}").await;
        assert_eq!(reply.status, StatusCode::CONFLICT);
        assert_eq!(
            parsed(&reply.body),
            json!({
                "error": "computer has dependent resources",
                "error_code": "has_dependents",
                "dependents": { "agents": 1 },
                "agents": [
                    {
                        "id": "a1",
                        "name": "a1-name",
                        "display_name": "a1 display",
                        "runtime": "claude"
                    }
                ]
            })
        );
    }

    #[tokio::test]
    async fn a_computer_gone_under_the_lock_is_a_404() {
        let world = World::admitting(Some(ComputerCascadeCommit::ComputerGone));
        let reply = delete(&world, r#"{"cascade_dependents":true}"#).await;
        assert_eq!(reply.status, StatusCode::NOT_FOUND);
        assert_eq!(
            parsed(&reply.body),
            json!({ "error": "host not found", "error_code": "host_not_found" })
        );
    }

    #[tokio::test]
    async fn a_non_boolean_cascade_dependents_is_a_400_before_the_write() {
        let world = World::admitting(None);
        let reply = delete(&world, r#"{"cascade_dependents":"yes"}"#).await;
        assert_eq!(reply.status, StatusCode::BAD_REQUEST);
        assert_eq!(
            parsed(&reply.body),
            json!({
                "error": "invalid input",
                "issues": [{
                    "code": "invalid_type",
                    "expected": "boolean",
                    "received": "string",
                    "path": ["cascade_dependents"],
                    "message": "Expected boolean, received string"
                }]
            })
        );
        assert_eq!(world.cascade_calls(), 0);
    }

    #[tokio::test]
    async fn a_non_object_body_is_a_400_before_the_write() {
        let world = World::admitting(None);
        let reply = delete(&world, "[1,2]").await;
        assert_eq!(reply.status, StatusCode::BAD_REQUEST);
        assert_eq!(
            parsed(&reply.body),
            json!({
                "error": "invalid input",
                "issues": [{
                    "code": "invalid_type",
                    "expected": "object",
                    "received": "array",
                    "path": [],
                    "message": "Expected object, received array"
                }]
            })
        );
        assert_eq!(world.cascade_calls(), 0);
    }

    #[tokio::test]
    async fn a_read_failure_is_the_frameworks_plain_500() {
        let world = World::admitting(None);
        world.0.lock().expect("state").ownership = Ownership::Fails;
        let reply = delete(&world, "{}").await;
        assert_eq!(reply.status, StatusCode::INTERNAL_SERVER_ERROR);
        assert_eq!(reply.body, "Internal Server Error");
    }

    #[tokio::test]
    async fn a_missing_principal_reads_nothing_and_fails_closed() {
        let world = World::admitting(None);
        let reply = delete_request(&world, COMPUTER, false, "{}").await;
        assert_eq!(reply.status, StatusCode::INTERNAL_SERVER_ERROR);
        assert_eq!(reply.body, "Internal Server Error");
        assert_eq!(world.cascade_calls(), 0);
    }

    /// Residue and a socket that will not close are best-effort: the rows are gone, so
    /// the delete still answers `200`.
    #[tokio::test]
    async fn residue_and_a_failing_disconnect_still_delete() {
        let world = World::admitting(Some(committed(vec![agent_facts(
            "a-failed",
            MaterializationStatus::Failed,
        )])));
        {
            let mut state = world.0.lock().expect("state");
            state.effects_fail = true;
            state.disconnect_fails = true;
        }
        let reply = delete(&world, r#"{"cascade_dependents":true}"#).await;
        assert_eq!(reply.status, StatusCode::OK);
        assert_eq!(
            parsed(&reply.body),
            json!({ "host_id": "h1", "deleted": true })
        );
    }
}
