//! #task:2343 — the Desktop embedded launcher's startup handoff protocol.
//!
//! The Rust backend runs OUT OF PROCESS under the Desktop launcher. When the
//! launcher spawns it on an ephemeral loopback port (`127.0.0.1:0`) it cannot know
//! the real bound port until the child reports it, and it must NOT scrape stderr or
//! predict the port. This module is the child's single authority for that handoff: a
//! ONE-shot, versioned, length-bounded, single-line NDJSON frame written to STDOUT the
//! instant the listener is bound and the production app is composed.
//!
//! Contract (ratified shiki+Cindy):
//! - `stdout` carries ONLY this protocol; all logs go to stderr.
//! - The frame is emitted at the bound + composition-complete point, BEFORE the serve
//!   accept-loop can answer requests, so its `kind` is `"bound"` (not `"ready"`); the
//!   launcher must still poll `/readyz=200` on the reported URL before publishing.
//! - `generation` is the launcher-minted spawn-correlation token, echoed VERBATIM; the
//!   launcher accepts only its own spawn's value.
//! - NO token / path / secret / product-version is in the frame — only `v`, `kind`,
//!   `generation`, `url`, `port`. (There is no version-equality gate: wire compat is the
//!   independent `api_epoch`, artifact identity is the sidecar manifest, and process
//!   correlation is this `generation`.)
//! - The frame is length-bounded; a launcher-side parser rejects anything oversize,
//!   malformed, unknown, or a second frame, failing startup with no fallback.

use std::net::SocketAddr;

/// The startup-protocol version. Bumped only on an incompatible frame-shape change; the
/// launcher rejects a frame whose `v` it does not understand.
pub const STARTUP_PROTOCOL_VERSION: u32 = 1;

/// The frame `kind` the backend emits: the listener is BOUND and the app composed, but
/// the serve accept-loop has not necessarily begun answering — the launcher still gates
/// on `/readyz`. There is deliberately no `"ready"` kind emitted from here.
pub const BOUND_FRAME_KIND: &str = "bound";

/// A conservative upper bound on the serialized single-line frame, mirrored by the
/// launcher parser. The real frame is a small fixed shape (a URL, a port, a short
/// opaque token); this bounds a hostile/oversized line cheaply. Chosen well above the
/// realistic maximum (a long generation token + a loopback URL) yet small enough that a
/// runaway line is rejected rather than buffered.
pub const BOUND_FRAME_MAX_BYTES: usize = 4096;

/// The single stdout handoff frame. Serialized as ONE line of compact JSON with a
/// trailing newline. Field order is fixed for readability; the launcher parses by key.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BoundFrame {
    /// Protocol version (`STARTUP_PROTOCOL_VERSION`).
    pub v: u32,
    /// Always `BOUND_FRAME_KIND` — bound, not yet `/readyz`-confirmed.
    pub kind: &'static str,
    /// The launcher-minted spawn-correlation token, echoed verbatim.
    pub generation: String,
    /// The effective loopback base URL the launcher should target (scheme + authority).
    pub url: String,
    /// The actual bound TCP port (the resolved ephemeral port when spawned with `:0`).
    pub port: u16,
}

impl BoundFrame {
    /// Build the frame for a freshly bound listener and the launcher's echoed
    /// generation. `bound_addr` is the listener's real `local_addr()` (so a `:0` spawn
    /// carries the resolved port, never a predicted one).
    pub fn new(generation: impl Into<String>, bound_addr: SocketAddr) -> Self {
        Self {
            v: STARTUP_PROTOCOL_VERSION,
            kind: BOUND_FRAME_KIND,
            generation: generation.into(),
            url: url_for_bound_addr(bound_addr),
            port: bound_addr.port(),
        }
    }

    /// The compact JSON object for this frame — ONLY the contract fields.
    fn to_json(&self) -> serde_json::Value {
        serde_json::json!({
            "v": self.v,
            "kind": self.kind,
            "generation": self.generation,
            "url": self.url,
            "port": self.port,
        })
    }

    /// Serialize to the single stdout line (compact JSON + `\n`). Returns `Err` only if
    /// the serialized frame would exceed `BOUND_FRAME_MAX_BYTES` — a defensive bound the
    /// launcher parser mirrors; a real frame is far under it.
    pub fn to_stdout_line(&self) -> Result<String, BoundFrameTooLarge> {
        let mut line = serde_json::to_string(&self.to_json()).expect("BoundFrame serializes");
        if line.len() >= BOUND_FRAME_MAX_BYTES {
            return Err(BoundFrameTooLarge {
                len: line.len(),
                max: BOUND_FRAME_MAX_BYTES,
            });
        }
        line.push('\n');
        Ok(line)
    }
}

/// The serialized frame exceeded the shared length bound. Surfaced (not silently
/// truncated) so an absurd generation token fails startup rather than emitting a line
/// the launcher would reject anyway.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct BoundFrameTooLarge {
    pub len: usize,
    pub max: usize,
}

impl std::fmt::Display for BoundFrameTooLarge {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "startup bound-frame is {} bytes, exceeds the {}-byte protocol bound",
            self.len, self.max
        )
    }
}

impl std::error::Error for BoundFrameTooLarge {}

/// The loopback base URL for a bound address. An IPv6 address is bracketed. This is the
/// scheme + authority only (no path); the launcher composes request URLs from it.
fn url_for_bound_addr(addr: SocketAddr) -> String {
    match addr {
        SocketAddr::V4(v4) => format!("http://{}:{}", v4.ip(), v4.port()),
        SocketAddr::V6(v6) => format!("http://[{}]:{}", v6.ip(), v6.port()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::{Ipv4Addr, Ipv6Addr, SocketAddrV4, SocketAddrV6};

    #[test]
    fn the_bound_frame_is_a_single_versioned_line_with_only_the_contract_fields() {
        let frame = BoundFrame::new(
            "gen-abc-123",
            SocketAddr::V4(SocketAddrV4::new(Ipv4Addr::LOCALHOST, 51763)),
        );
        let line = frame.to_stdout_line().unwrap();
        // ONE line, newline-terminated.
        assert!(line.ends_with('\n'));
        assert_eq!(line.matches('\n').count(), 1, "exactly one line");
        let value: serde_json::Value = serde_json::from_str(line.trim_end()).unwrap();
        // EXACTLY the contract fields — no token/path/secret/version leaked in.
        let object = value.as_object().unwrap();
        let mut keys: Vec<&str> = object.keys().map(String::as_str).collect();
        keys.sort_unstable();
        assert_eq!(keys, vec!["generation", "kind", "port", "url", "v"]);
        assert_eq!(value["v"], STARTUP_PROTOCOL_VERSION);
        assert_eq!(value["kind"], BOUND_FRAME_KIND);
        assert_eq!(value["generation"], "gen-abc-123");
        assert_eq!(value["url"], "http://127.0.0.1:51763");
        assert_eq!(value["port"], 51763);
    }

    #[test]
    fn the_port_is_the_resolved_bound_port_and_generation_is_echoed_verbatim() {
        // A `:0` spawn resolves to a concrete port; the frame carries THAT, and echoes
        // the exact generation the launcher minted (including punctuation).
        let frame = BoundFrame::new(
            "spawn/2026-09-04T15:00:00Z#7",
            SocketAddr::V4(SocketAddrV4::new(Ipv4Addr::LOCALHOST, 40001)),
        );
        assert_eq!(frame.port, 40001);
        assert_eq!(frame.generation, "spawn/2026-09-04T15:00:00Z#7");
    }

    #[test]
    fn an_ipv6_loopback_bound_address_is_bracketed() {
        let frame = BoundFrame::new(
            "g",
            SocketAddr::V6(SocketAddrV6::new(Ipv6Addr::LOCALHOST, 8080, 0, 0)),
        );
        assert_eq!(frame.url, "http://[::1]:8080");
    }

    #[test]
    fn an_oversized_generation_fails_the_length_bound_rather_than_emitting() {
        let huge = "g".repeat(BOUND_FRAME_MAX_BYTES);
        let frame = BoundFrame::new(
            huge,
            SocketAddr::V4(SocketAddrV4::new(Ipv4Addr::LOCALHOST, 1)),
        );
        let error = frame.to_stdout_line().unwrap_err();
        assert!(error.len >= BOUND_FRAME_MAX_BYTES);
        assert_eq!(error.max, BOUND_FRAME_MAX_BYTES);
    }
}
