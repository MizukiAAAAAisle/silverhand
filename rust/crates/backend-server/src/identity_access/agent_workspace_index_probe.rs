//! The production `agent_workspace_index` probe for `GET
//! /internal/agents/{aid}/list-workspaces` — Cindy #1/#33.
//!
//! Reuses the ONE `OwningHostDataPlane` correlated RPC transport (no second client,
//! no copied registry/timeout authority): resolve the agent's host, dispatch the
//! narrow `agent_workspace_index` command, and either return the resolved
//! `workspace_id → agent_dir` map or a whole-call typed [`AgentDirFailure`]. An id the
//! daemon leaves unresolved is simply absent from the map → the route's per-entry
//! `agent_dir: null` (#1). Transport/host/malformed faults are whole-response typed
//! failures with the reference statuses (#33), never a silent all-`null`.

use std::collections::HashMap;
use std::time::Duration;

use axum::http::StatusCode;
use silverhand_backend_core::{
    foundation::identity::{AgentId, HostId, WorkspaceId},
    identity_access::agent_profile_mcp::AgentProfileMcpPlacementRead,
};

use crate::application_orchestration::daemon_delivery::{
    CommandRefusal, HostDataPlaneCustody, HostDataPlaneFailure, HostDataPlaneRequest,
    OwningHostDataPlane, command,
};
use crate::identity_access::agent_list_workspaces::{AgentDirFailure, AgentDirProbe};

// The daemon `agent_workspace_index` deadline, matching TS `INDEX_TIMEOUT_MS` = 30s
// (Cindy #5) — NOT 10s.
const AGENT_WORKSPACE_INDEX_TIMEOUT: Duration = Duration::from_secs(30);

/// The daemon capability-refusal codes this command admits (#7). A daemon
/// `registry_unavailable` is a LEGITIMATE product refusal (the agent registry could
/// not be consulted) — it must reach `map_failure` as a typed `Refused`, not be
/// rejected by the transport as a foreign code (protocol corruption). Any OTHER code
/// stays foreign and fails closed.
pub(crate) const AGENT_WORKSPACE_INDEX_CAPABILITY_CODES: [&str; 1] = ["registry_unavailable"];

pub(crate) fn admits_agent_workspace_index_refusal(code: &str) -> bool {
    AGENT_WORKSPACE_INDEX_CAPABILITY_CODES.contains(&code)
}

/// The production probe: an agent→host placement read + the ONE data plane.
#[derive(Clone)]
pub struct ProductionAgentDirProbe<P> {
    placements: P,
    data_plane: OwningHostDataPlane,
    timeout: Duration,
}

impl<C, D, H> crate::application_orchestration::daemon_delivery::DaemonDeliveryRuntime<C, D, H> {
    pub fn agent_dir_probe<P>(&self, placements: P) -> ProductionAgentDirProbe<P>
    where
        P: AgentProfileMcpPlacementRead,
    {
        ProductionAgentDirProbe {
            placements,
            data_plane: self.owning_host_data_plane(),
            timeout: AGENT_WORKSPACE_INDEX_TIMEOUT,
        }
    }
}

impl<P> ProductionAgentDirProbe<P>
where
    P: AgentProfileMcpPlacementRead,
{
    /// Resolve the agent's host custody (the same axis the reference resolves — the
    /// agent's own daemon). A missing placement / unreadable registry is a `500`
    /// (`daemon_internal_error`); an offline host is `503 host_attach_pending`.
    async fn capture(&self, agent: &AgentId) -> Result<HostDataPlaneCustody, AgentDirFailure> {
        let placement = self
            .placements
            .read_mcp_placement(agent)
            .await
            .map_err(|_| internal_error())?
            .ok_or_else(|| agent_not_found(agent))?;
        self.resolve_host(placement.host())
    }

    fn resolve_host(&self, host: &HostId) -> Result<HostDataPlaneCustody, AgentDirFailure> {
        self.data_plane
            .resolve(host)
            .map_err(|_| internal_error())?
            .ok_or_else(host_attach_pending)
    }
}

impl<P> AgentDirProbe for ProductionAgentDirProbe<P>
where
    P: AgentProfileMcpPlacementRead,
{
    async fn agent_dirs(
        &self,
        agent: &AgentId,
        workspaces: &[WorkspaceId],
    ) -> Result<HashMap<WorkspaceId, String>, AgentDirFailure> {
        let custody = self.capture(agent).await?;
        let params = serde_json::json!({
            "agent_id": agent.as_str(),
            "workspace_ids": workspaces.iter().map(WorkspaceId::as_str).collect::<Vec<_>>(),
        });
        let expected = custody.clone();
        let answer = self
            .data_plane
            .dispatch(HostDataPlaneRequest {
                custody,
                command: command::agent_workspace_index(
                    params,
                    admits_agent_workspace_index_refusal,
                ),
                timeout: self.timeout,
            })
            .await
            .map_err(map_failure)?;
        let result = answer
            .into_result_for(&expected)
            .map_err(|_| internal_error())?;
        decode_index_result(&result)
    }
}

/// STRICT typed decode mirroring `AgentWorkspaceIndexResultSchema` (Cindy #5):
/// `{ ok: true, entries: [{ workspace_id: min(1), agent_dir: min(1) }.strict()],
/// unresolved: [string.min(1)] }.strict()`. A malformed response (missing `ok`,
/// extra top-level key, an entry missing/empty a field or carrying extra keys, a
/// non-string `unresolved`, an unparsable `workspace_id`) is a WHOLE-CALL fail-closed
/// 502 — never a silent partial map. Only the resolved `entries` populate the dir
/// map; a workspace in `unresolved` (or simply not reported) is absent → the route
/// projects null.
fn decode_index_result(
    result: &serde_json::Value,
) -> Result<HashMap<WorkspaceId, String>, AgentDirFailure> {
    let object = result.as_object().ok_or_else(internal_error)?;
    // Strict: exactly the three known keys.
    if object.len() != 3
        || !object.contains_key("ok")
        || !object.contains_key("entries")
        || !object.contains_key("unresolved")
    {
        return Err(internal_error());
    }
    if object.get("ok") != Some(&serde_json::Value::Bool(true)) {
        return Err(internal_error());
    }
    // `unresolved`: an array of non-empty strings (validated, not projected).
    let unresolved = object
        .get("unresolved")
        .and_then(serde_json::Value::as_array)
        .ok_or_else(internal_error)?;
    for id in unresolved {
        let s = id.as_str().ok_or_else(internal_error)?;
        if s.is_empty() {
            return Err(internal_error());
        }
    }
    let entries = object
        .get("entries")
        .and_then(serde_json::Value::as_array)
        .ok_or_else(internal_error)?;
    let mut dirs = HashMap::new();
    for entry in entries {
        let entry = entry.as_object().ok_or_else(internal_error)?;
        // Strict entry: exactly workspace_id + agent_dir, both non-empty strings.
        if entry.len() != 2
            || !entry.contains_key("workspace_id")
            || !entry.contains_key("agent_dir")
        {
            return Err(internal_error());
        }
        let ws = entry
            .get("workspace_id")
            .and_then(serde_json::Value::as_str)
            .filter(|s| !s.is_empty())
            .ok_or_else(internal_error)?;
        let dir = entry
            .get("agent_dir")
            .and_then(serde_json::Value::as_str)
            .filter(|s| !s.is_empty())
            .ok_or_else(internal_error)?;
        // A workspace_id that cannot parse is a malformed response, NOT a silent drop.
        let ws = WorkspaceId::parse(ws.to_owned()).map_err(|_| internal_error())?;
        dirs.insert(ws, dir.to_owned());
    }
    Ok(dirs)
}

/// Map the transport failure to the reference `DataPlaneFailure` statuses (#33/#7).
fn map_failure(failure: HostDataPlaneFailure) -> AgentDirFailure {
    match failure {
        HostDataPlaneFailure::NoCurrentDaemon
        | HostDataPlaneFailure::ConnectionGenerationMismatch
        | HostDataPlaneFailure::DaemonInstanceMismatch => host_attach_pending(),
        HostDataPlaneFailure::TimedOut => AgentDirFailure {
            status: StatusCode::GATEWAY_TIMEOUT,
            code: "daemon_timeout",
            message: "daemon request timed out".to_owned(),
        },
        // A LEGITIMATE daemon capability refusal (#7): `registry_unavailable` is the
        // agent registry being unreachable — 503. Mirroring TS `mapDataPlaneError`,
        // the daemon's OWN message is preserved (Cindy #5), not replaced with a canned
        // string. Any OTHER admitted-then-unrecognized capability code fails closed 502.
        HostDataPlaneFailure::Refused(CommandRefusal::Capability(refusal)) => {
            if refusal.code() == "registry_unavailable" {
                AgentDirFailure {
                    status: StatusCode::SERVICE_UNAVAILABLE,
                    code: "registry_unavailable",
                    message: refusal.message().to_owned(),
                }
            } else {
                internal_error()
            }
        }
        _ => internal_error(),
    }
}

fn host_attach_pending() -> AgentDirFailure {
    AgentDirFailure {
        status: StatusCode::SERVICE_UNAVAILABLE,
        code: "host_attach_pending",
        message: "host runtime is not currently attached".to_owned(),
    }
}
fn internal_error() -> AgentDirFailure {
    AgentDirFailure {
        status: StatusCode::BAD_GATEWAY,
        code: "daemon_internal_error",
        message: "daemon request failed".to_owned(),
    }
}
fn agent_not_found(agent: &AgentId) -> AgentDirFailure {
    AgentDirFailure {
        status: StatusCode::NOT_FOUND,
        code: "agent_not_found",
        message: format!("agent {} not found", agent.as_str()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::application_orchestration::daemon_delivery::CommandRefusal;

    #[test]
    fn admission_admits_only_registry_unavailable() {
        assert!(admits_agent_workspace_index_refusal("registry_unavailable"));
        // A foreign code stays foreign (the transport will fail it closed as protocol
        // corruption, never surface it as a typed capability refusal).
        assert!(!admits_agent_workspace_index_refusal("some_other_code"));
        assert!(!admits_agent_workspace_index_refusal("forbidden_path"));
    }

    #[test]
    fn registry_unavailable_maps_to_503_preserving_the_daemon_message() {
        // #7/#5: a legitimate daemon `registry_unavailable` capability refusal is 503
        // (not collapsed to 502), and the daemon's OWN message is preserved (mirroring
        // TS mapDataPlaneError), not replaced with a canned product string.
        let failure = map_failure(HostDataPlaneFailure::Refused(
            CommandRefusal::capability_with_message(
                "registry_unavailable",
                "registry is warming up on host-7",
            ),
        ));
        assert_eq!(failure.status, StatusCode::SERVICE_UNAVAILABLE);
        assert_eq!(failure.code, "registry_unavailable");
        assert_eq!(failure.message, "registry is warming up on host-7");
    }

    #[test]
    fn an_unrecognized_capability_code_fails_closed_to_502() {
        // Defense in depth: even if some other code were admitted, an unrecognized one
        // fails closed to 502 rather than a wrong product status.
        let failure = map_failure(HostDataPlaneFailure::Refused(CommandRefusal::capability(
            "unexpected",
        )));
        assert_eq!(failure.status, StatusCode::BAD_GATEWAY);
        assert_eq!(failure.code, "daemon_internal_error");
    }

    #[test]
    fn strict_decode_accepts_a_well_formed_result_and_projects_only_entries() {
        // #5: a well-formed { ok, entries, unresolved } result — entries populate the
        // dir map; `unresolved` ids are simply absent (the route projects them null).
        let result = serde_json::json!({
            "ok": true,
            "entries": [{ "workspace_id": "ws-1", "agent_dir": "/home/a/ws-1" }],
            "unresolved": ["ws-2"],
        });
        let dirs = decode_index_result(&result).unwrap();
        assert_eq!(dirs.len(), 1);
        assert_eq!(
            dirs.get(&WorkspaceId::parse("ws-1").unwrap())
                .map(String::as_str),
            Some("/home/a/ws-1")
        );
        assert!(!dirs.contains_key(&WorkspaceId::parse("ws-2").unwrap()));
    }

    #[test]
    fn strict_decode_fails_closed_on_malformed_shapes() {
        // #5: each malformed shape is a WHOLE-CALL fail-closed 502, never a silent
        // partial/empty map.
        let cases = [
            // missing `ok`
            serde_json::json!({ "entries": [], "unresolved": [] }),
            // ok != true
            serde_json::json!({ "ok": false, "entries": [], "unresolved": [] }),
            // extra top-level key
            serde_json::json!({ "ok": true, "entries": [], "unresolved": [], "x": 1 }),
            // entry with empty agent_dir
            serde_json::json!({ "ok": true, "entries": [{ "workspace_id": "ws-1", "agent_dir": "" }], "unresolved": [] }),
            // entry missing agent_dir
            serde_json::json!({ "ok": true, "entries": [{ "workspace_id": "ws-1" }], "unresolved": [] }),
            // entry with an extra key
            serde_json::json!({ "ok": true, "entries": [{ "workspace_id": "ws-1", "agent_dir": "/d", "x": 1 }], "unresolved": [] }),
            // non-string unresolved element
            serde_json::json!({ "ok": true, "entries": [], "unresolved": [7] }),
            // empty unresolved element
            serde_json::json!({ "ok": true, "entries": [], "unresolved": [""] }),
        ];
        for case in cases {
            let failure = decode_index_result(&case).expect_err("malformed must fail closed");
            assert_eq!(failure.status, StatusCode::BAD_GATEWAY, "case {case}");
            assert_eq!(failure.code, "daemon_internal_error");
        }
    }
}
