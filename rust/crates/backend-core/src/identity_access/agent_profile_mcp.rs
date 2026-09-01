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

use crate::foundation::wire_number::JsSafeInteger;
use crate::{
    foundation::identity::{AgentId, HostId},
    foundation::persistence::PersistenceFailure,
};

/// The persisted routing and deletion fact for one profile-MCP operation.
///
/// `source` is the id decoded from the returned row, not a restatement of the
/// lookup key. The production adapter binds it to the requested agent before it
/// may inspect deletion state or resolve a live host attachment. That makes a
/// dishonest/corrupt reader a closed internal fault with zero transport effects.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AgentProfileMcpPlacement {
    source: AgentId,
    host: HostId,
    deletion_pending: bool,
}

impl AgentProfileMcpPlacement {
    pub fn new(source: AgentId, host: HostId, deletion_pending: bool) -> Self {
        Self {
            source,
            host,
            deletion_pending,
        }
    }

    pub fn source(&self) -> &AgentId {
        &self.source
    }

    pub fn host(&self) -> &HostId {
        &self.host
    }

    pub fn deletion_pending(&self) -> bool {
        self.deletion_pending
    }
}

/// The narrow persisted authority the production MCP data-plane adapter needs.
///
/// This is deliberately not the profile row reader: profile bytes are host-local
/// truth, while this single DB read answers only where that truth lives and
/// whether deletion has already begun.
pub trait AgentProfileMcpPlacementRead: Clone + Send + Sync + 'static {
    fn read_mcp_placement(
        &self,
        agent: &AgentId,
    ) -> impl Future<Output = Result<Option<AgentProfileMcpPlacement>, PersistenceFailure>> + Send;
}

/// The byte count returned by a successful MCP config write.
///
/// A written-file size is nonnegative AND must round-trip through a JavaScript
/// JSON consumer exactly, so this newtype admits only `0..=JsSafeInteger::MAX`
/// and reuses [`JsSafeInteger`] for the binary64 precision boundary — it adds
/// only the nonnegative semantics on top. A raw `u64` never crosses the port:
/// the #2231 production decoder rejects a negative / `MAX + 1` / non-integer
/// daemon result as protocol-invalid (folded into
/// [`McpDataPlaneFaultCode::DaemonInternalError`]), so an unrepresentable count
/// can never reach the wire.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct McpBytesWritten(JsSafeInteger);

impl McpBytesWritten {
    /// Admit a nonnegative byte count, rejecting anything a JavaScript number
    /// cannot preserve exactly (`> JsSafeInteger::MAX`).
    pub fn new(value: u64) -> Result<Self, McpBytesWrittenOutOfRange> {
        if value <= JsSafeInteger::MAX as u64 {
            // Bounded above by MAX and nonnegative, so the cast and inner
            // construction are always in range.
            Ok(Self(
                JsSafeInteger::new(value as i64).expect("0..=MAX is within JsSafeInteger range"),
            ))
        } else {
            Err(McpBytesWrittenOutOfRange(value))
        }
    }

    /// The count as a JS-safe integer, ready to serialize.
    pub fn get(self) -> i64 {
        self.0.get()
    }
}

/// A byte count larger than a JavaScript number can preserve exactly.
#[derive(Clone, Copy, Debug, Eq, PartialEq, thiserror::Error)]
#[error("MCP config byte count is outside JavaScript's exact binary64 range")]
pub struct McpBytesWrittenOutOfRange(u64);

impl McpBytesWrittenOutOfRange {
    pub fn value(self) -> u64 {
        self.0
    }
}

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
/// The `code` is a CLOSED taxonomy: the CLI's `{error, code}` union is a stable
/// contract, so the port can never leak an arbitrary upstream string — every
/// unknown/transport/protocol error the #2231 adapter cannot classify collapses
/// to [`McpDataPlaneFaultCode::DaemonInternalError`] (mirroring TS
/// `mapDataPlaneError`, which rewrites any unrecognized failure to
/// `daemon_internal_error`). The `backend-server` adapter maps each variant
/// exhaustively to an HTTP status and its stable wire token. This is a
/// CROSS-LANE interface: the #2231 adapter produces it directly, no wrapper.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct McpDataPlaneFault {
    pub code: McpDataPlaneFaultCode,
    pub message: String,
}

/// The closed set of MCP data-plane fault codes actually reachable on these
/// three routes. A code outside this set does not exist on the wire: the #2231
/// adapter folds any raw/transport/protocol error it cannot classify into
/// [`Self::DaemonInternalError`], so the CLI's stable `code` union stays closed
/// and no adapter can widen it.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum McpDataPlaneFaultCode {
    /// The owning host is not (yet) attached — a retriable transport gap.
    HostAttachPending,
    /// The RPC to the daemon timed out.
    DaemonTimeout,
    /// An unclassified daemon/transport/protocol failure — the closed default
    /// for anything the adapter cannot map to a more specific code.
    DaemonInternalError,
    /// The daemon could not reach the agent's config filesystem.
    FsUnavailable,
    /// The daemon re-validated the config and rejected it (the backend is the
    /// primary validator, but the daemon is authoritative on its own store).
    InvalidConfig,
    /// The agent is being deleted; its data plane is quiescing.
    AgentDeleting,
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
    /// [`crate::identity_access::mcp_config::parse_mcp_config`]. The count is a
    /// [`McpBytesWritten`], so a value a JavaScript consumer cannot represent
    /// exactly is rejected at this port boundary, never serialized.
    fn write_config(
        &self,
        agent: &AgentId,
        raw: &str,
    ) -> impl Future<Output = Result<McpBytesWritten, McpDataPlaneFault>> + Send;

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
        async fn read_config(&self, agent: &AgentId) -> Result<Option<String>, McpDataPlaneFault> {
            Ok(self.files.get(agent.as_str()).cloned())
        }

        async fn write_config(
            &self,
            _agent: &AgentId,
            raw: &str,
        ) -> Result<McpBytesWritten, McpDataPlaneFault> {
            Ok(McpBytesWritten::new(raw.len() as u64).expect("test byte counts are small"))
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

    #[test]
    fn bytes_written_admits_the_js_safe_max_and_rejects_one_past_it() {
        let max = McpBytesWritten::new(JsSafeInteger::MAX as u64).expect("MAX is representable");
        assert_eq!(max.get(), JsSafeInteger::MAX);

        assert_eq!(
            McpBytesWritten::new(JsSafeInteger::MAX as u64 + 1),
            Err(McpBytesWrittenOutOfRange(JsSafeInteger::MAX as u64 + 1))
        );
        assert_eq!(McpBytesWritten::new(0).unwrap().get(), 0);
    }

    #[tokio::test]
    async fn read_returns_none_for_a_missing_file_and_bytes_for_a_write() {
        let mut plane = FakeDataPlane::default();
        assert_eq!(plane.read_config(&agent("a1")).await.unwrap(), None);
        assert_eq!(
            plane.write_config(&agent("a1"), "abc").await.unwrap().get(),
            3
        );

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
