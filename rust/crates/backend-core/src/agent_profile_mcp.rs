//! Family B — the transport-neutral MCP data-plane requirement port.
//!
//! The three MCP routes (`GET`/`POST /internal/agents/{aid}/profile/mcp` and
//! `.../mcp/probe`) never touch the database: they dispatch to the owning
//! host's daemon over a correlated RPC (`agent_profile_mcp_read`,
//! `agent_profile_mcp_write`, `mcp_probe`). This lane does NOT own that
//! transport — the shared owning-host outbound data-plane production root is
//! #2224's — so this module states ONLY the narrow requirement the handlers
//! consume, in transport-neutral domain values: read the raw config, write it,
//! run one live probe.
//!
//! ## Layering
//!
//! The HTTP wire shapes stay in `backend-server`: the request framing (raw body
//! vs JSON), the `McpProbeResult` serde DTO, and the status-code mapping of a
//! [`McpDataPlaneFault`]. Nothing here derives `serde` or names a status. A
//! probe's own connect/handshake failure is a domain fact carried INSIDE
//! [`McpProbeOutcome`] (`ok = false` + the phase it failed at); only a
//! host-transport fault surfaces as `Err(McpDataPlaneFault)`, mirroring TS,
//! where a failed handshake rides the 200 body and only an unreachable host
//! becomes an HTTP error.

use std::future::Future;

use crate::identity::AgentId;

/// The stages a probe walks, deepest-reached first on success and the failing
/// stage on failure: parse the config → find the named server → connect the
/// transport → MCP `initialize` → (optional) `tools/list`.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum McpProbePhase {
    Parse,
    NotFound,
    Connect,
    Initialize,
    Tools,
}

/// One probe request, in validated domain values. The wire admission
/// (`server_name` non-empty, strict body) is a `backend-server` concern; by the
/// time a command exists the name is a real string and `include_tools` a real
/// flag.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct McpProbeCommand {
    /// The RAW (user-visible) server name to connect to — never the
    /// `silverhand_<scope>__` runtime name.
    pub server_name: String,
    /// Whether to walk the optional `tools/list` stage after `initialize`.
    pub include_tools: bool,
}

/// Server identity from a probe's `initialize` result. Not secret; header/env
/// values never appear here.
#[derive(Clone, Debug, Eq, PartialEq, Default)]
pub struct McpProbeServerInfo {
    pub name: Option<String>,
    pub version: Option<String>,
}

/// One tool from a server's `tools/list` — name plus optional description.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct McpProbeTool {
    pub name: String,
    pub description: Option<String>,
}

/// The outcome of one live probe — a transport-neutral fact, not a wire body.
///
/// `message` is REDACTED: it never carries header/env values, URL query
/// strings, or bearer tokens, only safe shape info (present on failure,
/// optional on success). `tools` is present only when the caller asked for them
/// and the probe reached the `Tools` phase.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct McpProbeOutcome {
    pub ok: bool,
    pub phase: McpProbePhase,
    pub message: Option<String>,
    pub server_info: Option<McpProbeServerInfo>,
    pub tools: Option<Vec<McpProbeTool>>,
}

/// A transport-neutral fault from the owning-host MCP data plane (the host is
/// not attached, or the RPC itself failed).
///
/// The concrete code taxonomy and its HTTP-status mapping are owned by #2224's
/// data-plane root and the `backend-server` adapter; this port carries only the
/// stable `code` and redacted `message` a handler echoes as `{error, code}`. It
/// is a CROSS-LANE interface: the #2224 adapter must be able to produce this
/// value directly, without a translation wrapper.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct McpDataPlaneFault {
    pub code: String,
    pub message: String,
}

/// The narrow requirement the MCP handlers consume. One agent's owning host is
/// resolved by the adapter from the `AgentId`; the handler names only the
/// subject and the operation, never a connection or a protocol frame.
pub trait AgentProfileMcpDataPlane {
    /// Read the agent's raw `mcp.json` text, or `None` when no file exists (the
    /// normal empty state, not a fault).
    fn read_config(
        &self,
        agent: &AgentId,
    ) -> impl Future<Output = Result<Option<String>, McpDataPlaneFault>> + Send;

    /// Atomically replace the agent's raw config with `raw`, returning the byte
    /// count written. `raw` is the caller's verbatim text; the daemon
    /// re-validates, but this lane's handler is the primary validator via
    /// [`crate::mcp_config::parse_mcp_config`].
    fn write_config(
        &self,
        agent: &AgentId,
        raw: &str,
    ) -> impl Future<Output = Result<u64, McpDataPlaneFault>> + Send;

    /// Run one live probe against a named server and return its outcome. A
    /// connect/handshake failure is a successful call returning
    /// `Ok(McpProbeOutcome { ok: false, .. })`; only an unreachable host or a
    /// failed RPC is `Err`.
    fn probe(
        &self,
        agent: &AgentId,
        command: &McpProbeCommand,
    ) -> impl Future<Output = Result<McpProbeOutcome, McpDataPlaneFault>> + Send;
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    /// A deterministic in-memory data plane, proving the port is usable for
    /// orchestration without any transport. This is a TEST double only — the
    /// lane ships no production or no-op implementation.
    #[derive(Default)]
    struct FakeDataPlane {
        files: HashMap<String, String>,
    }

    impl AgentProfileMcpDataPlane for FakeDataPlane {
        async fn read_config(
            &self,
            agent: &AgentId,
        ) -> Result<Option<String>, McpDataPlaneFault> {
            Ok(self.files.get(agent.as_str()).cloned())
        }

        async fn write_config(
            &self,
            _agent: &AgentId,
            raw: &str,
        ) -> Result<u64, McpDataPlaneFault> {
            Ok(raw.len() as u64)
        }

        async fn probe(
            &self,
            _agent: &AgentId,
            command: &McpProbeCommand,
        ) -> Result<McpProbeOutcome, McpDataPlaneFault> {
            if command.server_name == "gone" {
                return Ok(McpProbeOutcome {
                    ok: false,
                    phase: McpProbePhase::NotFound,
                    message: Some("no such server".to_string()),
                    server_info: None,
                    tools: None,
                });
            }
            Ok(McpProbeOutcome {
                ok: true,
                phase: if command.include_tools {
                    McpProbePhase::Tools
                } else {
                    McpProbePhase::Initialize
                },
                message: None,
                server_info: Some(McpProbeServerInfo {
                    name: Some("srv".to_string()),
                    version: None,
                }),
                tools: command.include_tools.then(|| {
                    vec![McpProbeTool {
                        name: "t".to_string(),
                        description: None,
                    }]
                }),
            })
        }
    }

    fn agent(id: &str) -> AgentId {
        AgentId::parse(id).expect("agent id")
    }

    #[tokio::test]
    async fn read_returns_none_for_a_missing_file_and_bytes_for_a_write() {
        let mut plane = FakeDataPlane::default();
        assert_eq!(plane.read_config(&agent("a1")).await.unwrap(), None);
        assert_eq!(plane.write_config(&agent("a1"), "abc").await.unwrap(), 3);

        plane.files.insert("a1".to_string(), "x".to_string());
        assert_eq!(
            plane.read_config(&agent("a1")).await.unwrap(),
            Some("x".to_string())
        );
    }

    #[tokio::test]
    async fn a_handshake_failure_rides_the_outcome_not_an_error() {
        let plane = FakeDataPlane::default();
        let outcome = plane
            .probe(
                &agent("a1"),
                &McpProbeCommand {
                    server_name: "gone".to_string(),
                    include_tools: false,
                },
            )
            .await
            .expect("a failed handshake is still a successful call");
        assert!(!outcome.ok);
        assert_eq!(outcome.phase, McpProbePhase::NotFound);
    }

    #[tokio::test]
    async fn tools_are_present_only_when_requested() {
        let plane = FakeDataPlane::default();
        let without = plane
            .probe(
                &agent("a1"),
                &McpProbeCommand {
                    server_name: "srv".to_string(),
                    include_tools: false,
                },
            )
            .await
            .unwrap();
        assert!(without.ok);
        assert_eq!(without.phase, McpProbePhase::Initialize);
        assert!(without.tools.is_none());

        let with = plane
            .probe(
                &agent("a1"),
                &McpProbeCommand {
                    server_name: "srv".to_string(),
                    include_tools: true,
                },
            )
            .await
            .unwrap();
        assert_eq!(with.phase, McpProbePhase::Tools);
        assert_eq!(with.tools.as_deref().map(<[_]>::len), Some(1));
    }
}
