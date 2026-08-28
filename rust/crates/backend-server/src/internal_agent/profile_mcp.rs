//! The internal agent-profile MCP routes: read/replace an agent's MCP server
//! configuration and run a one-shot live probe against one of its servers.
//!
//! ## Three self-pinned routes, no DB
//!
//! `GET`/`POST /internal/agents/{aid}/profile/mcp` and
//! `POST /internal/agents/{aid}/profile/mcp/probe` never touch the database: they
//! dispatch to the agent's owning host over a correlated RPC data-plane
//! ([`AgentProfileMcpDataPlane`]). Like every route in this module they sit behind
//! the runtime-credential layer, which pins `{aid}` to the token's own agent — so
//! the product's `aid required` (400), `agent not found` (404) and `canEditAgent`
//! (403) pre-checks all collapse into the layer's indistinguishable `401`, and the
//! handler trusts `credential.agent()` and takes no path param.
//!
//! ## What this lane owns, and what it defers
//!
//! This checkpoint owns the MCP-specific consumer surface: the wire admission (the
//! POST config validation via [`parse_mcp_config`], the probe request schema), the
//! wire projection of a probe outcome, and the mapping of a data-plane fault code
//! to an HTTP status. It does NOT own the transport: the production
//! [`AgentProfileMcpDataPlane`] adapter is #2224's correlated-RPC data-plane, wired
//! at convergence. Deterministic fakes prove the handler orchestration; they do NOT
//! make it mounted or effect-complete, and this lane copies none of #2224's
//! dispatch machinery.
//!
//! ## A probe failure is a 200, not an HTTP error
//!
//! A probe that reaches the host but fails to connect/handshake/list tools is a
//! DOMAIN fact: it rides the `200` body as `{ ok: false, phase }`. Only a
//! host-transport fault (the RPC itself could not complete) becomes an HTTP error
//! carrying `{ error, code }` at the mapped status.

use axum::{
    Json, Router,
    body::Bytes,
    extract::{Extension, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::{get, post},
};
use serde::{Deserialize, Serialize};
use silverhand_backend_core::{
    agent_profile_mcp::{
        AgentProfileMcpDataPlane, McpDataPlaneFault, McpDataPlaneFaultCode, McpProbeCommand,
        McpProbeOutcome, McpProbePhase, McpProbeServerInfo, McpProbeTool,
    },
    mcp_config::parse_mcp_config,
    runtime_credential::RuntimePrincipal,
};

/// The product route template for reading/replacing the config. `{aid}` is consumed
/// by the credential layer, which self-pins it.
pub const PROFILE_MCP_PATH: &str = "/internal/agents/{aid}/profile/mcp";

/// The product route template for the live probe.
pub const PROFILE_MCP_PROBE_PATH: &str = "/internal/agents/{aid}/profile/mcp/probe";

/// The unmapped-error body: a bare `text/plain` `500`, never a JSON envelope.
const INTERNAL_ERROR_BODY: &str = "Internal Server Error";

/// Mount the three MCP routes generic over the data-plane port, so tests drive them
/// with a driver-free fake and the composition root wires the #2224 adapter AND the
/// runtime-credential layer that self-pins `{aid}`. This builder yields the bare
/// routes; route registration and that layer are a separate integration seam.
pub fn profile_mcp_router<D>(data_plane: D) -> Router
where
    D: AgentProfileMcpDataPlane + Clone + Send + Sync + 'static,
{
    Router::new()
        .route(
            PROFILE_MCP_PATH,
            get(read_config::<D>).post(write_config::<D>),
        )
        .route(PROFILE_MCP_PROBE_PATH, post(probe::<D>))
        .with_state(data_plane)
}

// ===========================================================================
// Shared response helpers.
// ===========================================================================

/// The composition-fault `500`: a route reached without its credential layer must
/// not dispatch. Never a `401` — that verdict is the layer's alone.
fn missing_credential(route: &str) -> Response {
    tracing::error!(
        route,
        "internal MCP route reached without its runtime credential"
    );
    (StatusCode::INTERNAL_SERVER_ERROR, INTERNAL_ERROR_BODY).into_response()
}

/// Render a data-plane fault as the product's `{ error, code }` envelope at the
/// status its code maps to. `code` is a CLOSED taxonomy (#2224's adapter already
/// folded any unclassified upstream error into `DaemonInternalError`), so both
/// the status and the stable wire token are exhaustive matches — nothing an
/// adapter produces can widen the CLI's `code` union or leak a raw upstream string.
fn data_plane_error(fault: McpDataPlaneFault) -> Response {
    (
        data_plane_status(fault.code),
        Json(serde_json::json!({
            "error": fault.message,
            "code": data_plane_wire_code(fault.code),
        })),
    )
        .into_response()
}

/// The HTTP status for each closed fault code, matching the product's
/// `mapDataPlaneError` result statuses (`workspace-data-plane.ts`). Exhaustive by
/// construction: a new code forces a new arm here, so the code→status tail can
/// never silently fall through.
fn data_plane_status(code: McpDataPlaneFaultCode) -> StatusCode {
    match code {
        McpDataPlaneFaultCode::InvalidConfig => StatusCode::BAD_REQUEST,
        McpDataPlaneFaultCode::AgentDeleting => StatusCode::CONFLICT,
        McpDataPlaneFaultCode::HostAttachPending | McpDataPlaneFaultCode::FsUnavailable => {
            StatusCode::SERVICE_UNAVAILABLE
        }
        McpDataPlaneFaultCode::DaemonTimeout => StatusCode::GATEWAY_TIMEOUT,
        McpDataPlaneFaultCode::DaemonInternalError => StatusCode::BAD_GATEWAY,
    }
}

/// The stable wire token echoed in the CLI's `{ error, code }`, matching the TS
/// data-plane code strings. Exhaustive: the token union is the contract.
fn data_plane_wire_code(code: McpDataPlaneFaultCode) -> &'static str {
    match code {
        McpDataPlaneFaultCode::HostAttachPending => "host_attach_pending",
        McpDataPlaneFaultCode::DaemonTimeout => "daemon_timeout",
        McpDataPlaneFaultCode::DaemonInternalError => "daemon_internal_error",
        McpDataPlaneFaultCode::FsUnavailable => "fs_unavailable",
        McpDataPlaneFaultCode::InvalidConfig => "invalid_config",
        McpDataPlaneFaultCode::AgentDeleting => "agent_deleting",
    }
}

// ===========================================================================
// GET — read the config.
// ===========================================================================

/// `{ raw: string | null }` — the verbatim `mcp.json` text, or `null` when the file
/// does not exist (the normal empty state, never a `404`).
#[derive(Serialize)]
struct ReadConfigResponse {
    raw: Option<String>,
}

async fn read_config<D>(
    credential: Option<Extension<RuntimePrincipal>>,
    State(data_plane): State<D>,
) -> Response
where
    D: AgentProfileMcpDataPlane,
{
    let Some(Extension(credential)) = credential else {
        return missing_credential(PROFILE_MCP_PATH);
    };
    match data_plane.read_config(credential.agent()).await {
        Ok(raw) => Json(ReadConfigResponse { raw }).into_response(),
        Err(fault) => data_plane_error(fault),
    }
}

// ===========================================================================
// POST — replace the config.
// ===========================================================================

/// `{ ok: true, bytes_written: number }` — the daemon's byte count for the written
/// `mcp.json`.
#[derive(Serialize)]
struct WriteConfigResponse {
    ok: bool,
    bytes_written: u64,
}

async fn write_config<D>(
    credential: Option<Extension<RuntimePrincipal>>,
    State(data_plane): State<D>,
    body: Bytes,
) -> Response
where
    D: AgentProfileMcpDataPlane,
{
    let Some(Extension(credential)) = credential else {
        return missing_credential(PROFILE_MCP_PATH);
    };

    // The body is read as verbatim text (as the product's `c.req.text()` does): the
    // user's own formatting is what gets persisted. A non-UTF-8 body decodes lossily
    // and simply fails the parse below as invalid config, never a transport error.
    let raw = String::from_utf8_lossy(&body).into_owned();

    // The backend is the PRIMARY validation authority: a reject never crosses the
    // wire to the host. The error string is the product-authored envelope.
    if let Err(message) = parse_mcp_config(&raw) {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "error": message, "code": "invalid_config" })),
        )
            .into_response();
    }

    // The VERBATIM raw is persisted (not a re-serialization of the parsed config).
    match data_plane.write_config(credential.agent(), &raw).await {
        Ok(bytes_written) => Json(WriteConfigResponse {
            ok: true,
            bytes_written,
        })
        .into_response(),
        Err(fault) => data_plane_error(fault),
    }
}

// ===========================================================================
// POST probe — a one-shot live probe.
// ===========================================================================

/// The probe request: `{ server_name, include_tools? }`, strict. `server_name` is
/// the RAW user-visible name (never the `silverhand_<scope>__` runtime spelling).
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ProbeRequest {
    server_name: String,
    #[serde(default)]
    include_tools: Option<bool>,
}

async fn probe<D>(
    credential: Option<Extension<RuntimePrincipal>>,
    State(data_plane): State<D>,
    body: Bytes,
) -> Response
where
    D: AgentProfileMcpDataPlane,
{
    let Some(Extension(credential)) = credential else {
        return missing_credential(PROFILE_MCP_PROBE_PATH);
    };

    // Mirror the product's `c.req.json().catch(() => ({}))` then strict parse: bad
    // JSON, a missing/empty `server_name`, an unknown key, or a wrong type all land
    // as one `invalid_input` 400 before any dispatch. This lane emits the stable
    // `{ error, code }` envelope WITHOUT the Zod `issues[]` array — the same
    // deliberate simplification the sibling internal routes adopted; the `code`
    // discriminator is preserved.
    //
    // We parse to `serde_json::Value` FIRST, then strict-decode: the product's
    // `JSON.parse` is last-wins on a duplicate key, and `Value` decoding matches it
    // (a later key overwrites the earlier in its object map). Decoding the struct
    // directly from the bytes would instead REJECT a duplicate field, so
    // `{"server_name":"a","server_name":"b"}` — admitted as `b` by TS — would be a
    // spurious 400. `deny_unknown_fields` and the non-empty check still apply on the
    // second decode.
    let request = match serde_json::from_slice::<serde_json::Value>(&body)
        .ok()
        .and_then(|value| serde_json::from_value::<ProbeRequest>(value).ok())
    {
        Some(request) if !request.server_name.is_empty() => request,
        _ => {
            return (
                StatusCode::BAD_REQUEST,
                Json(serde_json::json!({ "error": "invalid input", "code": "invalid_input" })),
            )
                .into_response();
        }
    };

    let command = McpProbeCommand {
        server_name: request.server_name,
        include_tools: request.include_tools.unwrap_or(false),
    };

    match data_plane.probe(credential.agent(), &command).await {
        // A connect/handshake/tools failure is NOT an HTTP error — it rides the 200
        // body as `{ ok: false, phase }`. Only a transport fault (the `Err` arm) is.
        Ok(outcome) => Json(probe_outcome_wire(&outcome)).into_response(),
        Err(fault) => data_plane_error(fault),
    }
}

/// `{ ok, phase, message?, server_info?, tools? }` — the `McpProbeResult` the CLI
/// reads. Absent optional fields are OMITTED (never explicit `null`), mirroring the
/// product's `.strict()` optionals. `message` is already redacted upstream.
#[derive(Serialize)]
struct ProbeOutcomeWire {
    ok: bool,
    phase: ProbePhaseWire,
    #[serde(skip_serializing_if = "Option::is_none")]
    message: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    server_info: Option<ProbeServerInfoWire>,
    #[serde(skip_serializing_if = "Option::is_none")]
    tools: Option<Vec<ProbeToolWire>>,
}

/// The probe phase, serialized to the product's snake_case tokens
/// (`parse`/`not_found`/`connect`/`initialize`/`tools`).
#[derive(Serialize)]
#[serde(rename_all = "snake_case")]
enum ProbePhaseWire {
    Parse,
    NotFound,
    Connect,
    Initialize,
    Tools,
}

#[derive(Serialize)]
struct ProbeServerInfoWire {
    #[serde(skip_serializing_if = "Option::is_none")]
    name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    version: Option<String>,
}

#[derive(Serialize)]
struct ProbeToolWire {
    name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    description: Option<String>,
}

fn probe_phase_wire(phase: McpProbePhase) -> ProbePhaseWire {
    match phase {
        McpProbePhase::Parse => ProbePhaseWire::Parse,
        McpProbePhase::NotFound => ProbePhaseWire::NotFound,
        McpProbePhase::Connect => ProbePhaseWire::Connect,
        McpProbePhase::Initialize => ProbePhaseWire::Initialize,
        McpProbePhase::Tools => ProbePhaseWire::Tools,
    }
}

fn probe_outcome_wire(outcome: &McpProbeOutcome) -> ProbeOutcomeWire {
    ProbeOutcomeWire {
        ok: outcome.ok,
        phase: probe_phase_wire(outcome.phase),
        message: outcome.message.clone(),
        server_info: outcome.server_info.as_ref().map(probe_server_info_wire),
        tools: outcome
            .tools
            .as_ref()
            .map(|tools| tools.iter().map(probe_tool_wire).collect()),
    }
}

fn probe_server_info_wire(info: &McpProbeServerInfo) -> ProbeServerInfoWire {
    ProbeServerInfoWire {
        name: info.name.clone(),
        version: info.version.clone(),
    }
}

fn probe_tool_wire(tool: &McpProbeTool) -> ProbeToolWire {
    ProbeToolWire {
        name: tool.name.clone(),
        description: tool.description.clone(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{
        body::{Body, to_bytes},
        http::{Request, header::AUTHORIZATION},
    };
    use serde_json::{Value, json};
    use silverhand_backend_core::{
        identity::{AgentId, DaemonInstanceId},
        persistence::PersistenceFailure,
        runtime_credential::{RuntimeCustody, RuntimeGeneration, RuntimePrincipal, RuntimeScope},
    };
    use std::sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    };
    use tower::ServiceExt;

    use crate::runtime_credential::{
        AuthenticateRuntimeCredential, RuntimeBearer, require_runtime_credential,
    };

    /// The scripted outcome each data-plane method returns, plus a record of whether
    /// — and for which agent — it was consulted, so a test can prove the handler
    /// dispatches for the pinned self and only after admission.
    #[derive(Clone)]
    struct FakeDataPlane {
        inner: Arc<FakeInner>,
    }

    struct FakeInner {
        read: Mutex<Result<Option<String>, McpDataPlaneFault>>,
        write: Mutex<Result<u64, McpDataPlaneFault>>,
        probe: Mutex<Result<McpProbeOutcome, McpDataPlaneFault>>,
        consulted: AtomicBool,
        asked_for: Mutex<Vec<String>>,
        wrote_raw: Mutex<Option<String>>,
        probed_command: Mutex<Option<(String, bool)>>,
    }

    impl FakeDataPlane {
        fn new() -> Self {
            Self {
                inner: Arc::new(FakeInner {
                    read: Mutex::new(Ok(None)),
                    write: Mutex::new(Ok(0)),
                    probe: Mutex::new(Ok(outcome(true, McpProbePhase::Tools))),
                    consulted: AtomicBool::new(false),
                    asked_for: Mutex::new(Vec::new()),
                    wrote_raw: Mutex::new(None),
                    probed_command: Mutex::new(None),
                }),
            }
        }

        fn on_read(self, result: Result<Option<String>, McpDataPlaneFault>) -> Self {
            *self.inner.read.lock().unwrap() = result;
            self
        }

        fn on_write(self, result: Result<u64, McpDataPlaneFault>) -> Self {
            *self.inner.write.lock().unwrap() = result;
            self
        }

        fn on_probe(self, result: Result<McpProbeOutcome, McpDataPlaneFault>) -> Self {
            *self.inner.probe.lock().unwrap() = result;
            self
        }

        fn consulted(&self) -> bool {
            self.inner.consulted.load(Ordering::SeqCst)
        }

        fn asked_for(&self) -> Vec<String> {
            self.inner.asked_for.lock().unwrap().clone()
        }

        fn wrote_raw(&self) -> Option<String> {
            self.inner.wrote_raw.lock().unwrap().clone()
        }

        fn probed_command(&self) -> Option<(String, bool)> {
            self.inner.probed_command.lock().unwrap().clone()
        }

        fn record(&self, agent: &AgentId) {
            self.inner.consulted.store(true, Ordering::SeqCst);
            self.inner
                .asked_for
                .lock()
                .unwrap()
                .push(agent.as_str().to_string());
        }
    }

    impl AgentProfileMcpDataPlane for FakeDataPlane {
        async fn read_config(&self, agent: &AgentId) -> Result<Option<String>, McpDataPlaneFault> {
            self.record(agent);
            clone_result(&self.inner.read.lock().unwrap())
        }

        async fn write_config(&self, agent: &AgentId, raw: &str) -> Result<u64, McpDataPlaneFault> {
            self.record(agent);
            *self.inner.wrote_raw.lock().unwrap() = Some(raw.to_string());
            match &*self.inner.write.lock().unwrap() {
                Ok(bytes) => Ok(*bytes),
                Err(fault) => Err(clone_fault(fault)),
            }
        }

        async fn probe(
            &self,
            agent: &AgentId,
            command: &McpProbeCommand,
        ) -> Result<McpProbeOutcome, McpDataPlaneFault> {
            self.record(agent);
            *self.inner.probed_command.lock().unwrap() =
                Some((command.server_name.clone(), command.include_tools));
            match &*self.inner.probe.lock().unwrap() {
                Ok(outcome) => Ok(clone_outcome(outcome)),
                Err(fault) => Err(clone_fault(fault)),
            }
        }
    }

    fn clone_result(
        result: &Result<Option<String>, McpDataPlaneFault>,
    ) -> Result<Option<String>, McpDataPlaneFault> {
        match result {
            Ok(value) => Ok(value.clone()),
            Err(fault) => Err(clone_fault(fault)),
        }
    }

    fn clone_fault(fault: &McpDataPlaneFault) -> McpDataPlaneFault {
        McpDataPlaneFault {
            code: fault.code,
            message: fault.message.clone(),
        }
    }

    fn clone_outcome(outcome: &McpProbeOutcome) -> McpProbeOutcome {
        McpProbeOutcome {
            ok: outcome.ok,
            phase: outcome.phase,
            message: outcome.message.clone(),
            server_info: outcome.server_info.as_ref().map(|info| McpProbeServerInfo {
                name: info.name.clone(),
                version: info.version.clone(),
            }),
            tools: outcome.tools.as_ref().map(|tools| {
                tools
                    .iter()
                    .map(|tool| McpProbeTool {
                        name: tool.name.clone(),
                        description: tool.description.clone(),
                    })
                    .collect()
            }),
        }
    }

    fn outcome(ok: bool, phase: McpProbePhase) -> McpProbeOutcome {
        McpProbeOutcome {
            ok,
            phase,
            message: None,
            server_info: None,
            tools: None,
        }
    }

    fn fault(code: McpDataPlaneFaultCode) -> McpDataPlaneFault {
        McpDataPlaneFault {
            code,
            message: format!("{code:?} happened"),
        }
    }

    fn agent(id: &str) -> AgentId {
        AgentId::parse(id).expect("agent id")
    }

    fn principal(id: &str) -> RuntimePrincipal {
        RuntimePrincipal::for_scope(
            RuntimeScope::AgentSlot { agent: agent(id) },
            RuntimeCustody::new(
                RuntimeGeneration::new(1).unwrap(),
                DaemonInstanceId::parse("daemon-1").unwrap(),
            ),
        )
    }

    /// Drive a request against the bare router with the principal already injected
    /// (as the layer would), isolating the handler from the credential layer.
    async fn injected(
        data_plane: FakeDataPlane,
        method: &str,
        path: &str,
        credential: Option<RuntimePrincipal>,
        body: Body,
    ) -> Response {
        let mut request = Request::builder().method(method).uri(path);
        if let Some(credential) = credential {
            request = request.extension(credential);
        }
        profile_mcp_router(data_plane)
            .oneshot(request.body(body).unwrap())
            .await
            .unwrap()
    }

    async fn body_json(response: Response) -> Value {
        let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        serde_json::from_slice(&bytes).unwrap_or(Value::Null)
    }

    // ---- GET read ----

    #[tokio::test]
    async fn a_present_config_is_returned_and_the_pinned_self_is_read() {
        let data_plane = FakeDataPlane::new().on_read(Ok(Some("{\"mcpServers\":{}}".to_string())));
        let response = injected(
            data_plane.clone(),
            "GET",
            "/internal/agents/a1/profile/mcp",
            Some(principal("a1")),
            Body::empty(),
        )
        .await;
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(
            body_json(response).await,
            json!({ "raw": "{\"mcpServers\":{}}" })
        );
        assert_eq!(data_plane.asked_for(), vec!["a1".to_string()]);
    }

    #[tokio::test]
    async fn an_absent_config_is_null_not_a_404() {
        let data_plane = FakeDataPlane::new().on_read(Ok(None));
        let response = injected(
            data_plane,
            "GET",
            "/internal/agents/a1/profile/mcp",
            Some(principal("a1")),
            Body::empty(),
        )
        .await;
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(body_json(response).await, json!({ "raw": Value::Null }));
    }

    #[tokio::test]
    async fn a_read_transport_fault_is_the_mapped_status_and_envelope() {
        let data_plane =
            FakeDataPlane::new().on_read(Err(fault(McpDataPlaneFaultCode::HostAttachPending)));
        let response = injected(
            data_plane,
            "GET",
            "/internal/agents/a1/profile/mcp",
            Some(principal("a1")),
            Body::empty(),
        )
        .await;
        assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
        assert_eq!(
            body_json(response).await,
            json!({ "error": "HostAttachPending happened", "code": "host_attach_pending" })
        );
    }

    // ---- POST write ----

    #[tokio::test]
    async fn a_valid_config_is_written_verbatim() {
        let data_plane = FakeDataPlane::new().on_write(Ok(42));
        // Deliberately idiosyncratic whitespace: it must be persisted verbatim.
        let raw = "{\n  \"mcpServers\": {\n    \"a\": { \"command\": \"x\" }\n  }\n}";
        let response = injected(
            data_plane.clone(),
            "POST",
            "/internal/agents/a1/profile/mcp",
            Some(principal("a1")),
            Body::from(raw),
        )
        .await;
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(
            body_json(response).await,
            json!({ "ok": true, "bytes_written": 42 })
        );
        assert_eq!(data_plane.wrote_raw().as_deref(), Some(raw));
        assert_eq!(data_plane.asked_for(), vec!["a1".to_string()]);
    }

    #[tokio::test]
    async fn an_invalid_config_is_a_400_before_any_dispatch() {
        let data_plane = FakeDataPlane::new();
        let response = injected(
            data_plane.clone(),
            "POST",
            "/internal/agents/a1/profile/mcp",
            Some(principal("a1")),
            Body::from("{ not json"),
        )
        .await;
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        let body = body_json(response).await;
        assert_eq!(body["code"], "invalid_config");
        assert!(body["error"].as_str().unwrap().starts_with("invalid JSON"));
        // Validation precedes dispatch: the data-plane was never consulted.
        assert!(!data_plane.consulted());
    }

    #[tokio::test]
    async fn an_empty_body_is_the_empty_config_and_is_written() {
        // parse_mcp_config admits an empty/whitespace body as the empty config, so a
        // blank POST is a valid clear-to-empty, dispatched verbatim.
        let data_plane = FakeDataPlane::new().on_write(Ok(0));
        let response = injected(
            data_plane.clone(),
            "POST",
            "/internal/agents/a1/profile/mcp",
            Some(principal("a1")),
            Body::from("   "),
        )
        .await;
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(data_plane.wrote_raw().as_deref(), Some("   "));
    }

    #[tokio::test]
    async fn a_write_daemon_fault_is_the_mapped_status() {
        let data_plane =
            FakeDataPlane::new().on_write(Err(fault(McpDataPlaneFaultCode::AgentDeleting)));
        let response = injected(
            data_plane,
            "POST",
            "/internal/agents/a1/profile/mcp",
            Some(principal("a1")),
            Body::from("{\"mcpServers\":{}}"),
        )
        .await;
        assert_eq!(response.status(), StatusCode::CONFLICT);
        assert_eq!(body_json(response).await["code"], "agent_deleting");
    }

    // ---- POST probe ----

    #[tokio::test]
    async fn a_valid_probe_defaults_include_tools_false_and_projects_the_outcome() {
        let data_plane = FakeDataPlane::new().on_probe(Ok(McpProbeOutcome {
            ok: true,
            phase: McpProbePhase::Initialize,
            message: None,
            server_info: Some(McpProbeServerInfo {
                name: Some("srv".to_string()),
                version: None,
            }),
            tools: None,
        }));
        let response = injected(
            data_plane.clone(),
            "POST",
            "/internal/agents/a1/profile/mcp/probe",
            Some(principal("a1")),
            Body::from(json!({ "server_name": "srv" }).to_string()),
        )
        .await;
        assert_eq!(response.status(), StatusCode::OK);
        // include_tools defaulted to false; absent optionals are omitted, and
        // server_info emits only its present field.
        assert_eq!(
            body_json(response).await,
            json!({ "ok": true, "phase": "initialize", "server_info": { "name": "srv" } })
        );
        assert_eq!(
            data_plane.probed_command(),
            Some(("srv".to_string(), false))
        );
    }

    #[tokio::test]
    async fn a_probe_with_tools_projects_the_tool_list_and_snake_case_phase() {
        let data_plane = FakeDataPlane::new().on_probe(Ok(McpProbeOutcome {
            ok: true,
            phase: McpProbePhase::Tools,
            message: None,
            server_info: None,
            tools: Some(vec![
                McpProbeTool {
                    name: "t1".to_string(),
                    description: Some("does a thing".to_string()),
                },
                McpProbeTool {
                    name: "t2".to_string(),
                    description: None,
                },
            ]),
        }));
        let response = injected(
            data_plane.clone(),
            "POST",
            "/internal/agents/a1/profile/mcp/probe",
            Some(principal("a1")),
            Body::from(json!({ "server_name": "srv", "include_tools": true }).to_string()),
        )
        .await;
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(
            body_json(response).await,
            json!({
                "ok": true,
                "phase": "tools",
                "tools": [
                    { "name": "t1", "description": "does a thing" },
                    { "name": "t2" }
                ]
            })
        );
        assert_eq!(data_plane.probed_command(), Some(("srv".to_string(), true)));
    }

    #[tokio::test]
    async fn a_handshake_failure_is_a_200_body_not_an_http_error() {
        let data_plane = FakeDataPlane::new().on_probe(Ok(McpProbeOutcome {
            ok: false,
            phase: McpProbePhase::Connect,
            message: Some("could not connect".to_string()),
            server_info: None,
            tools: None,
        }));
        let response = injected(
            data_plane,
            "POST",
            "/internal/agents/a1/profile/mcp/probe",
            Some(principal("a1")),
            Body::from(json!({ "server_name": "srv" }).to_string()),
        )
        .await;
        // A reached-but-failed probe is a domain fact on the 200, never an HTTP error.
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(
            body_json(response).await,
            json!({ "ok": false, "phase": "connect", "message": "could not connect" })
        );
    }

    #[tokio::test]
    async fn a_probe_transport_fault_is_the_mapped_status() {
        let data_plane =
            FakeDataPlane::new().on_probe(Err(fault(McpDataPlaneFaultCode::DaemonTimeout)));
        let response = injected(
            data_plane,
            "POST",
            "/internal/agents/a1/profile/mcp/probe",
            Some(principal("a1")),
            Body::from(json!({ "server_name": "srv" }).to_string()),
        )
        .await;
        assert_eq!(response.status(), StatusCode::GATEWAY_TIMEOUT);
        assert_eq!(body_json(response).await["code"], "daemon_timeout");
    }

    #[tokio::test]
    async fn a_duplicate_server_name_is_last_wins_matching_js() {
        // The product's JSON.parse is last-wins on a duplicate key, so a body with
        // two `server_name`s admits the LAST. Decoding the struct directly would
        // reject the duplicate as a 400; parsing to Value first reproduces JS. The
        // raw JSON is hand-written because `json!` cannot express a duplicate key.
        let data_plane = FakeDataPlane::new();
        let response = injected(
            data_plane.clone(),
            "POST",
            "/internal/agents/a1/profile/mcp/probe",
            Some(principal("a1")),
            Body::from(r#"{"server_name":"first","server_name":"second"}"#),
        )
        .await;
        assert_eq!(response.status(), StatusCode::OK);
        // The LAST value is what reached the port.
        assert_eq!(
            data_plane.probed_command(),
            Some(("second".to_string(), false))
        );
    }

    #[tokio::test]
    async fn a_malformed_probe_request_is_invalid_input_before_dispatch() {
        // Missing server_name, empty server_name, an unknown key, and non-JSON all
        // collapse to one invalid_input 400 and never dispatch.
        for body in [
            json!({}).to_string(),
            json!({ "server_name": "" }).to_string(),
            json!({ "server_name": "srv", "extra": 1 }).to_string(),
            "not json".to_string(),
        ] {
            let data_plane = FakeDataPlane::new();
            let response = injected(
                data_plane.clone(),
                "POST",
                "/internal/agents/a1/profile/mcp/probe",
                Some(principal("a1")),
                Body::from(body.clone()),
            )
            .await;
            assert_eq!(
                response.status(),
                StatusCode::BAD_REQUEST,
                "body {body:?} must be a 400"
            );
            assert_eq!(
                body_json(response).await,
                json!({ "error": "invalid input", "code": "invalid_input" }),
                "body {body:?} keeps the stable envelope without issues[]"
            );
            assert!(!data_plane.consulted(), "invalid input never dispatches");
        }
    }

    // ---- composition + self-pin ----

    #[tokio::test]
    async fn an_absent_credential_is_a_safe_500_and_never_dispatches() {
        for (method, path, body) in [
            ("GET", "/internal/agents/a1/profile/mcp", Body::empty()),
            (
                "POST",
                "/internal/agents/a1/profile/mcp",
                Body::from("{\"mcpServers\":{}}"),
            ),
            (
                "POST",
                "/internal/agents/a1/profile/mcp/probe",
                Body::from(json!({ "server_name": "srv" }).to_string()),
            ),
        ] {
            let data_plane = FakeDataPlane::new();
            let response = injected(data_plane.clone(), method, path, None, body).await;
            assert_eq!(
                response.status(),
                StatusCode::INTERNAL_SERVER_ERROR,
                "{method} {path} without a credential is a safe 500"
            );
            assert!(
                !data_plane.consulted(),
                "{method} {path} must not dispatch without a credential"
            );
        }
    }

    /// A faithful stand-in for the runtime-credential authority: it self-pins,
    /// admitting a request ONLY when the route's `{aid}` equals its one enrolled
    /// agent. Proves the WIRING — the layer is in front of the routes and runs
    /// before the handler.
    #[derive(Clone)]
    struct PinnedAuthority {
        enrolled: AgentId,
    }

    impl AuthenticateRuntimeCredential for PinnedAuthority {
        async fn authenticate_runtime(
            &self,
            _bearer: RuntimeBearer,
            route_agent: AgentId,
        ) -> Result<Option<RuntimePrincipal>, PersistenceFailure> {
            if route_agent == self.enrolled {
                Ok(Some(principal(self.enrolled.as_str())))
            } else {
                Ok(None)
            }
        }
    }

    async fn behind_layer(data_plane: FakeDataPlane, path_aid: &str) -> Response {
        let authority = PinnedAuthority {
            enrolled: agent("a1"),
        };
        let router = require_runtime_credential(profile_mcp_router(data_plane), authority);
        let request = Request::builder()
            .method("GET")
            .uri(format!("/internal/agents/{path_aid}/profile/mcp"))
            .header(AUTHORIZATION, "Bearer test-secret")
            .body(Body::empty())
            .unwrap();
        router.oneshot(request).await.unwrap()
    }

    #[tokio::test]
    async fn a_non_self_aid_is_401_before_the_data_plane() {
        let data_plane = FakeDataPlane::new().on_read(Ok(None));
        let response = behind_layer(data_plane.clone(), "someone-else").await;
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
        assert!(
            !data_plane.consulted(),
            "a non-self caller must never reach the data-plane"
        );
    }

    #[tokio::test]
    async fn the_pinned_self_reaches_the_data_plane() {
        let data_plane = FakeDataPlane::new().on_read(Ok(None));
        let response = behind_layer(data_plane.clone(), "a1").await;
        assert_eq!(response.status(), StatusCode::OK);
        assert!(data_plane.consulted());
        assert_eq!(data_plane.asked_for(), vec!["a1".to_string()]);
    }

    // ---- status + wire mapping ----

    /// Every closed fault code maps to its product HTTP status AND its stable wire
    /// token. Exhaustive over the enum: a new variant forces a new row here, so a
    /// code can never fall through to a wildcard or leak a raw upstream string.
    #[test]
    fn every_fault_code_maps_to_its_status_and_wire_token() {
        use McpDataPlaneFaultCode::*;
        let table = [
            (InvalidConfig, StatusCode::BAD_REQUEST, "invalid_config"),
            (AgentDeleting, StatusCode::CONFLICT, "agent_deleting"),
            (
                HostAttachPending,
                StatusCode::SERVICE_UNAVAILABLE,
                "host_attach_pending",
            ),
            (
                FsUnavailable,
                StatusCode::SERVICE_UNAVAILABLE,
                "fs_unavailable",
            ),
            (DaemonTimeout, StatusCode::GATEWAY_TIMEOUT, "daemon_timeout"),
            (
                DaemonInternalError,
                StatusCode::BAD_GATEWAY,
                "daemon_internal_error",
            ),
        ];
        for (code, status, wire) in table {
            assert_eq!(data_plane_status(code), status, "status for {code:?}");
            assert_eq!(data_plane_wire_code(code), wire, "wire token for {code:?}");
        }
    }
}
