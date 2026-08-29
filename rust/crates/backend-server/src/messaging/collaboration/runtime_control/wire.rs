use axum::{
    Json,
    http::StatusCode,
    response::{IntoResponse, Response},
};
use serde_json::{Value, json};
use silverhand_backend_core::identity::{AgentId, ConversationId};
use silverhand_backend_core::messaging::collaboration::{
    ClearSessionOutcome, ClearSessionProviderRefusal, HardStopRuntimeProviderRefusal,
    RuntimeControlAdmissionRefusal, RuntimePlacementRefusal, StartRuntimeProviderRefusal,
};

const INTERNAL_ERROR_BODY: &str = "Internal Server Error";

pub(super) fn invalid_target() -> Response {
    json_response(
        StatusCode::BAD_REQUEST,
        json!({ "error": "channel id and agent id required" }),
    )
}

pub(super) fn operation_success() -> Response {
    Json(json!({ "ok": true })).into_response()
}

pub(super) fn clear_session_success(outcome: &ClearSessionOutcome) -> Response {
    Json(json!({
        "ok": true,
        "prev_cli_session_id": outcome.previous_cli_session().map(|id| id.as_str()),
        "was_running": outcome.was_running(),
    }))
    .into_response()
}

pub(super) fn admission_refusal(refusal: RuntimeControlAdmissionRefusal) -> Response {
    match refusal {
        RuntimeControlAdmissionRefusal::ConversationNotFound => json_response(
            StatusCode::NOT_FOUND,
            json!({ "error": "channel not found" }),
        ),
        RuntimeControlAdmissionRefusal::AgentNotFound => {
            json_response(StatusCode::NOT_FOUND, json!({ "error": "agent not found" }))
        }
        RuntimeControlAdmissionRefusal::AgentNotMember => json_response(
            StatusCode::BAD_REQUEST,
            json!({ "error": "agent is not a member of this conversation" }),
        ),
        RuntimeControlAdmissionRefusal::Forbidden => {
            json_response(StatusCode::FORBIDDEN, json!({ "error": "forbidden" }))
        }
        RuntimeControlAdmissionRefusal::RuntimeScopeMismatch => coded(
            StatusCode::CONFLICT,
            "runtime_scope_mismatch",
            "agent-scoped runtime operation targeted a conversation-scoped agent",
        ),
    }
}

pub(super) fn start_refusal(refusal: StartRuntimeProviderRefusal) -> Response {
    match refusal {
        StartRuntimeProviderRefusal::Placement(refusal) => placement_refusal(refusal),
        StartRuntimeProviderRefusal::WorkspaceNotProvisioned => coded(
            StatusCode::BAD_GATEWAY,
            "workspace_not_provisioned",
            "workspace is not provisioned on the daemon host",
        ),
        StartRuntimeProviderRefusal::WorkspaceBundleMissing => coded(
            StatusCode::CONFLICT,
            "workspace_bundle_missing",
            "workspace bundle is missing on the daemon host",
        ),
        StartRuntimeProviderRefusal::RegistryUnavailable => coded(
            StatusCode::BAD_GATEWAY,
            "registry_unavailable",
            "daemon runtime registry is unavailable",
        ),
        StartRuntimeProviderRefusal::ShuttingDown => coded(
            StatusCode::SERVICE_UNAVAILABLE,
            "shutting_down",
            "daemon host is shutting down",
        ),
    }
}

pub(super) fn hard_stop_refusal(refusal: HardStopRuntimeProviderRefusal) -> Response {
    match refusal {
        HardStopRuntimeProviderRefusal::Placement(refusal) => placement_refusal(refusal),
    }
}

pub(super) fn clear_session_refusal(
    refusal: ClearSessionProviderRefusal,
    conversation: &ConversationId,
    agent: &AgentId,
) -> Response {
    match refusal {
        ClearSessionProviderRefusal::Placement(refusal) => placement_refusal(refusal),
        ClearSessionProviderRefusal::Timeout => coded(
            StatusCode::SERVICE_UNAVAILABLE,
            "clear_session_timeout",
            format!(
                "clear-session for {}/{} timed out waiting for runtime_exit projection landed",
                conversation.as_str(),
                agent.as_str()
            ),
        ),
        ClearSessionProviderRefusal::InProgress => coded(
            StatusCode::CONFLICT,
            "clear_session_in_progress",
            format!(
                "clear-session is already in progress for {}/{}",
                conversation.as_str(),
                agent.as_str()
            ),
        ),
    }
}

pub(super) fn legacy_stop_refusal() -> Response {
    json_response(
        StatusCode::BAD_REQUEST,
        json!({ "error": "soft stop was removed; only hard stop is supported" }),
    )
}

pub(super) fn internal_error() -> Response {
    (StatusCode::INTERNAL_SERVER_ERROR, INTERNAL_ERROR_BODY).into_response()
}

/// The canonical placement-refusal → HTTP `{error, code}` mapper. Made
/// `pub(crate)` so the agent-scoped bulk stop maps its own placement refusals
/// through the ONE authority rather than re-minting the status/code vocabulary.
pub(crate) fn placement_refusal(refusal: RuntimePlacementRefusal) -> Response {
    let (status, code, message) = match refusal {
        RuntimePlacementRefusal::HostMissing => (
            StatusCode::NOT_FOUND,
            "host_missing",
            "daemon host was not found",
        ),
        RuntimePlacementRefusal::HostNotOwned => (
            StatusCode::FORBIDDEN,
            "host_not_owned",
            "daemon host is not owned by this user",
        ),
        RuntimePlacementRefusal::HostPendingAttach => (
            StatusCode::CONFLICT,
            "host_pending_attach",
            "daemon host is pending attachment",
        ),
        RuntimePlacementRefusal::HostRuntimeDisabled => (
            StatusCode::CONFLICT,
            "host_runtime_disabled",
            "daemon-host runtime is disabled",
        ),
        RuntimePlacementRefusal::HostRevoked => (
            StatusCode::CONFLICT,
            "host_revoked",
            "daemon host has been revoked",
        ),
        RuntimePlacementRefusal::LocalHostUnbound => (
            StatusCode::CONFLICT,
            "local_host_unbound",
            "no local daemon host is bound",
        ),
        RuntimePlacementRefusal::LocalHostAmbiguous => (
            StatusCode::CONFLICT,
            "local_host_ambiguous",
            "multiple local daemon hosts are available",
        ),
        RuntimePlacementRefusal::HostAttachPending => (
            StatusCode::SERVICE_UNAVAILABLE,
            "host_attach_pending",
            "daemon host is not currently attached; retry in a moment",
        ),
    };
    coded(status, code, message)
}

fn coded(status: StatusCode, code: &'static str, message: impl Into<String>) -> Response {
    let message = message.into();
    json_response(status, json!({ "error": message, "code": code }))
}

fn json_response(status: StatusCode, body: Value) -> Response {
    (status, Json(body)).into_response()
}

#[cfg(test)]
mod tests {
    use axum::body::to_bytes;
    use silverhand_backend_core::identity::{AgentId, ConversationId};

    use super::*;

    async fn status_and_json(response: Response) -> (StatusCode, Value) {
        let status = response.status();
        let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        (status, serde_json::from_slice(&body).unwrap())
    }

    #[tokio::test]
    async fn every_typed_provider_refusal_has_a_named_status_and_code() {
        let conversation = ConversationId::parse("conversation-1").unwrap();
        let agent = AgentId::parse("agent-1").unwrap();
        let placement = [
            (
                RuntimePlacementRefusal::HostMissing,
                StatusCode::NOT_FOUND,
                "host_missing",
            ),
            (
                RuntimePlacementRefusal::HostNotOwned,
                StatusCode::FORBIDDEN,
                "host_not_owned",
            ),
            (
                RuntimePlacementRefusal::HostPendingAttach,
                StatusCode::CONFLICT,
                "host_pending_attach",
            ),
            (
                RuntimePlacementRefusal::HostRuntimeDisabled,
                StatusCode::CONFLICT,
                "host_runtime_disabled",
            ),
            (
                RuntimePlacementRefusal::HostRevoked,
                StatusCode::CONFLICT,
                "host_revoked",
            ),
            (
                RuntimePlacementRefusal::LocalHostUnbound,
                StatusCode::CONFLICT,
                "local_host_unbound",
            ),
            (
                RuntimePlacementRefusal::LocalHostAmbiguous,
                StatusCode::CONFLICT,
                "local_host_ambiguous",
            ),
            (
                RuntimePlacementRefusal::HostAttachPending,
                StatusCode::SERVICE_UNAVAILABLE,
                "host_attach_pending",
            ),
        ];
        for (refusal, expected_status, expected_code) in placement {
            let (status, body) = status_and_json(placement_refusal(refusal)).await;
            assert_eq!(status, expected_status);
            assert_eq!(body["code"], expected_code);
        }

        let starts = [
            (
                StartRuntimeProviderRefusal::WorkspaceNotProvisioned,
                StatusCode::BAD_GATEWAY,
                "workspace_not_provisioned",
            ),
            (
                StartRuntimeProviderRefusal::WorkspaceBundleMissing,
                StatusCode::CONFLICT,
                "workspace_bundle_missing",
            ),
            (
                StartRuntimeProviderRefusal::RegistryUnavailable,
                StatusCode::BAD_GATEWAY,
                "registry_unavailable",
            ),
            (
                StartRuntimeProviderRefusal::ShuttingDown,
                StatusCode::SERVICE_UNAVAILABLE,
                "shutting_down",
            ),
        ];
        for (refusal, expected_status, expected_code) in starts {
            let (status, body) = status_and_json(start_refusal(refusal)).await;
            assert_eq!(status, expected_status);
            assert_eq!(body["code"], expected_code);
        }

        let clears = [
            (
                ClearSessionProviderRefusal::Timeout,
                StatusCode::SERVICE_UNAVAILABLE,
                "clear_session_timeout",
            ),
            (
                ClearSessionProviderRefusal::InProgress,
                StatusCode::CONFLICT,
                "clear_session_in_progress",
            ),
        ];
        for (refusal, expected_status, expected_code) in clears {
            let (status, body) =
                status_and_json(clear_session_refusal(refusal, &conversation, &agent)).await;
            assert_eq!(status, expected_status);
            assert_eq!(body["code"], expected_code);
        }
    }
}
