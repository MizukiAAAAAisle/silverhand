//! `PATCH /api/hosts/{id}` — rename and first-attach finalization.

use std::{error::Error, fmt, future::Future};

use axum::{
    Json, Router,
    extract::{Extension, Path, Request, State},
    response::{IntoResponse, Response},
    routing::patch,
};
use serde::{Deserialize, Serialize};
use silverhand_backend_core::{
    host_runtime::{
        agent_roster::ComputerAgentsReadPort,
        computer::{ComputerDisplayLabel, DisplayLabelRefusal},
        update::{
            UpdateComputer, UpdateComputerCommand, UpdateComputerInput, UpdateComputerOutcome,
            UpdateComputerRefusal, UpdateComputerUnitOfWork,
        },
    },
    identity::{HostId, UserId},
};

use crate::{
    clock::ProcessClock,
    error,
    host_runtime::host_wire::{HostDto, host_wire},
    scope_events::ScopeEventHub,
};

use super::{computer_times_are_js_safe, internal_error, read_body};

pub const HOST_UPDATE_PATH: &str = "/api/hosts/{id}";

pub trait HostLabelChangeEffect: Clone + Send + Sync + 'static {
    fn agents_changed(
        &self,
        computer: &HostId,
    ) -> impl Future<Output = Result<(), HostLabelChangeEffectFailure>> + Send;
}

#[derive(Debug)]
pub struct HostLabelChangeEffectFailure(Box<dyn Error + Send + Sync>);

impl HostLabelChangeEffectFailure {
    fn from_source(source: impl Error + Send + Sync + 'static) -> Self {
        Self(Box::new(source))
    }
}

impl fmt::Display for HostLabelChangeEffectFailure {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("host label change announcement failed")
    }
}

impl Error for HostLabelChangeEffectFailure {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        Some(self.0.as_ref())
    }
}

/// Production post-commit effect: enumerate the computer's real agent roster and
/// publish the existing app-scope `agent_changed` invalidation for each one.
#[derive(Clone)]
pub struct ScopeEventHostLabelChange<R> {
    agents: R,
    hub: ScopeEventHub,
}

impl<R> ScopeEventHostLabelChange<R> {
    pub fn new(agents: R, hub: ScopeEventHub) -> Self {
        Self { agents, hub }
    }
}

impl<R> HostLabelChangeEffect for ScopeEventHostLabelChange<R>
where
    R: ComputerAgentsReadPort,
{
    async fn agents_changed(&self, computer: &HostId) -> Result<(), HostLabelChangeEffectFailure> {
        let agents = self
            .agents
            .agent_ids_on_computer(computer)
            .await
            .map_err(HostLabelChangeEffectFailure::from_source)?;
        for agent in agents {
            self.hub
                .publish_agent_changed(&agent)
                .map_err(HostLabelChangeEffectFailure::from_source)?;
        }
        Ok(())
    }
}

#[derive(Clone)]
struct UpdateState<U, E, C> {
    operation: UpdateComputer<U>,
    label_change: E,
    clock: C,
}

pub fn router<U, E, C>(operation: UpdateComputer<U>, label_change: E, clock: C) -> Router
where
    U: UpdateComputerUnitOfWork,
    E: HostLabelChangeEffect,
    C: ProcessClock,
{
    Router::new()
        .route(HOST_UPDATE_PATH, patch(update::<U, E, C>))
        .with_state(UpdateState {
            operation,
            label_change,
            clock,
        })
}

async fn update<U, E, C>(
    Path(raw_host): Path<String>,
    principal: Option<Extension<UserId>>,
    State(state): State<UpdateState<U, E, C>>,
    request: Request,
) -> Response
where
    U: UpdateComputerUnitOfWork,
    E: HostLabelChangeEffect,
    C: ProcessClock,
{
    let Some(Extension(requester)) = principal else {
        tracing::error!("host-update route reached without its human principal fact");
        return internal_error();
    };
    let Ok(computer) = HostId::parse(raw_host) else {
        return refusal(UpdateComputerRefusal::NotFound);
    };
    let input = read_body(request.into_body())
        .await
        .ok()
        .and_then(|bytes| serde_json::from_slice::<UpdateBody>(&bytes).ok())
        .map(UpdateBody::into_input)
        .unwrap_or(UpdateComputerInput::Invalid);
    let command = UpdateComputerCommand {
        computer: computer.clone(),
        requester,
        input,
        at: state.clock.now_unix_millis(),
    };
    let outcome = match state.operation.execute(command).await {
        Ok(outcome) => outcome,
        Err(cause) => {
            tracing::error!(error_chain = %error::describe(&cause), "host update failed");
            return internal_error();
        }
    };
    match outcome {
        UpdateComputerOutcome::Refused(reason) => refusal(reason),
        UpdateComputerOutcome::Renamed(record) | UpdateComputerOutcome::Finalized(record) => {
            if let Err(cause) = state.label_change.agents_changed(&computer).await {
                // The database commit already happened. Returning a request failure
                // would invite a retry that duplicates the mutation; carry the residue
                // to operators and return the committed result.
                tracing::error!(error_chain = %error::describe(&cause), host_id = %computer.as_str(), "host label committed but agent refresh announcement failed");
            }
            if !computer_times_are_js_safe(&record) {
                tracing::error!(host_id = %computer.as_str(), "updated host timestamps are not JS-safe");
                return internal_error();
            }
            Json(UpdateResponse {
                host: host_wire(&record),
            })
            .into_response()
        }
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct UpdateBody {
    display_label: serde_json::Value,
}

impl UpdateBody {
    fn into_input(self) -> UpdateComputerInput {
        match self.display_label {
            serde_json::Value::Null => UpdateComputerInput::Valid {
                display_label: None,
            },
            serde_json::Value::String(raw) => match ComputerDisplayLabel::parse(&raw) {
                Ok(label) => UpdateComputerInput::Valid {
                    display_label: Some(label),
                },
                Err(DisplayLabelRefusal::Empty) => UpdateComputerInput::Valid {
                    display_label: None,
                },
                Err(DisplayLabelRefusal::TooLong { .. }) => UpdateComputerInput::Invalid,
            },
            _ => UpdateComputerInput::Invalid,
        }
    }
}

#[derive(Serialize)]
struct UpdateResponse {
    host: HostDto,
}

fn refusal(reason: UpdateComputerRefusal) -> Response {
    let (status, body) = match reason {
        UpdateComputerRefusal::NotFound => (
            404,
            serde_json::json!({ "error": "host not found", "error_code": "host_not_found" }),
        ),
        UpdateComputerRefusal::Revoked => (
            409,
            serde_json::json!({ "error": "host has been revoked", "error_code": "host_revoked" }),
        ),
        UpdateComputerRefusal::InvalidInput => {
            (400, serde_json::json!({ "error": "invalid input" }))
        }
        UpdateComputerRefusal::PendingAttach => (
            409,
            serde_json::json!({ "error": "host has not completed its first daemon attachment", "error_code": "host_pending_attach" }),
        ),
        UpdateComputerRefusal::LabelRequired => (
            400,
            serde_json::json!({ "error": "computer name is required", "error_code": "display_label_required" }),
        ),
    };
    (
        axum::http::StatusCode::from_u16(status).expect("static status"),
        Json(body),
    )
        .into_response()
}

#[cfg(test)]
mod tests {
    use std::sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    };

    use axum::{body::Body, http::Request};
    use silverhand_backend_core::host_runtime::{
        computer::{ComputerRecord, HostKind, ProvisioningSource},
        update::{UpdateComputerDecision, UpdateComputerTransaction},
    };
    use tower::ServiceExt;

    use super::*;

    #[derive(Clone)]
    struct WrongWitness;

    impl UpdateComputerUnitOfWork for WrongWitness {
        async fn update_computer<D>(
            &self,
            _computer: HostId,
            _decide: D,
        ) -> Result<
            UpdateComputerTransaction,
            silverhand_backend_core::persistence::PersistenceFailure,
        >
        where
            D: FnOnce(Option<ComputerRecord>) -> UpdateComputerDecision + Send,
        {
            let before = record("host-1", None, None);
            Ok(UpdateComputerTransaction::Committed {
                before,
                committed: record("host-2", Some("Studio"), Some(777)),
            })
        }
    }

    #[derive(Clone, Default)]
    struct RecordingEffect(Arc<AtomicUsize>);

    impl HostLabelChangeEffect for RecordingEffect {
        async fn agents_changed(
            &self,
            _computer: &HostId,
        ) -> Result<(), HostLabelChangeEffectFailure> {
            self.0.fetch_add(1, Ordering::SeqCst);
            Ok(())
        }
    }

    #[derive(Clone)]
    struct Clock;

    impl ProcessClock for Clock {
        fn now_unix_millis(&self) -> i64 {
            777
        }
    }

    fn record(id: &str, label: Option<&str>, finalized_at: Option<i64>) -> ComputerRecord {
        ComputerRecord {
            id: HostId::parse(id).unwrap(),
            name: "stable".to_owned(),
            kind: HostKind::Remote,
            created_at: 1,
            owner: Some(UserId::parse("owner").unwrap()),
            installation_id: None,
            last_seen_at: None,
            activated_at: Some(2),
            finalized_at,
            revoked_at: None,
            provisioning_source: ProvisioningSource::UserInvite,
            display_label: label.map(str::to_owned),
        }
    }

    #[tokio::test]
    async fn invalid_committed_witness_is_safe_500_and_never_publishes() {
        let effect = RecordingEffect::default();
        let mut request = Request::builder()
            .method("PATCH")
            .uri("/api/hosts/host-1")
            .header("content-type", "application/json")
            .body(Body::from(r#"{"display_label":"Studio"}"#))
            .unwrap();
        request
            .extensions_mut()
            .insert(UserId::parse("owner").unwrap());
        let response = router(UpdateComputer::new(WrongWitness), effect.clone(), Clock)
            .oneshot(request)
            .await
            .unwrap();
        assert_eq!(
            response.status(),
            axum::http::StatusCode::INTERNAL_SERVER_ERROR
        );
        assert_eq!(effect.0.load(Ordering::SeqCst), 0);
    }
}
