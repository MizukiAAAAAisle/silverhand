//! Typed request and result contract for the `host_runtime_catalog` command.
//!
//! The transport correlates, refuses a mismatched daemon instance before it sends
//! anything, and decodes the daemon's refusal code as a closed set. This leaf owns
//! only what this one command sends, what its answer means, and how a refusal code
//! maps to this operation's outcome — an unknown code is protocol corruption and
//! never a refusal this operation can report. Sharing the transport primitive with
//! the status seed must not merge the two payload or result vocabularies.
//!
//! Every fact this leaf produces is bound to the `(host, daemon instance)` it was
//! answered on, and its rows can only be read by naming that coordinate.
//!
//! `detected_at` is an `i64` where the TS contract says `z.number()`. That is a
//! producer-domain refinement, not exact schema parity: the daemon stamps epoch
//! milliseconds and every consumer stores and compares them as integers, so a
//! fractional value is refused rather than truncated. A route signing this leaf
//! must not describe it as schema-exact.

use std::time::Duration;

use serde::Deserialize;
use serde_json::{Value, json};
use silverhand_backend_core::{
    agents::runtime::RuntimeKind,
    identity::{DaemonInstanceId, HostId},
};

use crate::daemon_delivery::{
    HostCommand, HostCommandDispatch, HostCommandFailure, HostCommandKind,
};

/// This operation's own budget: one probe may shell out to every runtime binary
/// on the machine, so it is far longer than a control-plane round trip.
const PROBE_TIMEOUT: Duration = Duration::from_secs(45);

pub struct RuntimeCatalogRequest {
    pub host: HostId,
    pub daemon_instance: DaemonInstanceId,
    pub force: bool,
}

pub enum RuntimeCatalogOutcome {
    Detected(RuntimeCatalog),
    /// The custody the caller observed is not the one serving the host now, so
    /// there is nothing to answer for it yet.
    AttachPending,
    Timeout,
    DaemonInternalError,
    /// The transport answered about a coordinate this request never asked about.
    /// No daemon caused it and no operator can act on it: it is a defect in this
    /// crate, kept out of the refusal arms so it can never be reported as one.
    TransportContractViolation,
}

/// A catalog together with the coordinate that produced it. Private fields with no
/// constructor, and rows readable only through [`Self::rows_for`], so a projector
/// cannot pair one host's rows with another host's key — including when two
/// machines spell their daemon instance identically.
///
/// ```compile_fail
/// use silverhand_backend_core::identity::{DaemonInstanceId, HostId};
/// use silverhand_backend_server::host_control::runtime_catalog::RuntimeCatalog;
///
/// fn forge() -> RuntimeCatalog {
///     RuntimeCatalog {
///         host: HostId::parse("host-2").unwrap(),
///         instance: DaemonInstanceId::parse("instance-1").unwrap(),
///         runtimes: Vec::new(),
///         detected_at: 1,
///     }
/// }
/// ```
///
/// ```
/// use silverhand_backend_core::identity::{DaemonInstanceId, HostId};
/// use silverhand_backend_server::host_control::runtime_catalog::{
///     CatalogCoordinateMismatch, CatalogView, RuntimeCatalog,
/// };
///
/// fn read<'a>(
///     catalog: &'a RuntimeCatalog,
///     host: &HostId,
///     instance: &DaemonInstanceId,
/// ) -> Result<CatalogView<'a>, CatalogCoordinateMismatch> {
///     catalog.rows_for(host, instance)
/// }
/// ```
pub struct RuntimeCatalog {
    host: HostId,
    instance: DaemonInstanceId,
    runtimes: Vec<DetectedRuntime>,
    detected_at: i64,
}

impl RuntimeCatalog {
    pub fn rows_for(
        &self,
        host: &HostId,
        instance: &DaemonInstanceId,
    ) -> Result<CatalogView<'_>, CatalogCoordinateMismatch> {
        if &self.host != host {
            return Err(CatalogCoordinateMismatch::Host);
        }
        if &self.instance != instance {
            return Err(CatalogCoordinateMismatch::DaemonInstance);
        }
        Ok(CatalogView {
            runtimes: &self.runtimes,
            detected_at: self.detected_at,
        })
    }
}

/// What a reader gets once it has named the coordinate it is filing under. Carries
/// no coordinate of its own, so there is nothing here to misattribute.
pub struct CatalogView<'a> {
    pub runtimes: &'a [DetectedRuntime],
    pub detected_at: i64,
}

/// Which coordinate a reader named that the catalog is not about.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum CatalogCoordinateMismatch {
    Host,
    DaemonInstance,
}

pub struct DetectedRuntime {
    pub kind: RuntimeKind,
    pub state: RuntimeAvailability,
    pub reason: RuntimeDetectionReason,
    pub installed: bool,
    pub binary: Option<String>,
    pub version: Option<String>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum RuntimeAvailability {
    Present,
    PresentUnverified,
    Absent,
    Unknown,
}

impl RuntimeAvailability {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Present => "present",
            Self::PresentUnverified => "present_unverified",
            Self::Absent => "absent",
            Self::Unknown => "unknown",
        }
    }

    fn parse(raw: &str) -> Option<Self> {
        match raw {
            "present" => Some(Self::Present),
            "present_unverified" => Some(Self::PresentUnverified),
            "absent" => Some(Self::Absent),
            "unknown" => Some(Self::Unknown),
            _ => None,
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum RuntimeDetectionReason {
    Resolved,
    VersionUnavailable,
    NotFound,
    ProbeFailed,
}

impl RuntimeDetectionReason {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Resolved => "resolved",
            Self::VersionUnavailable => "version_unavailable",
            Self::NotFound => "not_found",
            Self::ProbeFailed => "probe_failed",
        }
    }

    fn parse(raw: &str) -> Option<Self> {
        match raw {
            "resolved" => Some(Self::Resolved),
            "version_unavailable" => Some(Self::VersionUnavailable),
            "not_found" => Some(Self::NotFound),
            "probe_failed" => Some(Self::ProbeFailed),
            _ => None,
        }
    }
}

pub async fn probe(
    dispatch: &HostCommandDispatch,
    request: RuntimeCatalogRequest,
) -> RuntimeCatalogOutcome {
    let answer = match dispatch
        .dispatch(HostCommand {
            host: request.host.clone(),
            expected_instance: request.daemon_instance.clone(),
            kind: HostCommandKind::RuntimeCatalog,
            params: json!({ "force": request.force }),
            timeout: PROBE_TIMEOUT,
        })
        .await
    {
        Ok(answer) => answer,
        Err(failure) => return outcome_for(failure),
    };
    // The coordinate is bound before the payload is looked at, so an answer about
    // another machine or another custody cannot hide behind a decode failure.
    let Ok(result) = answer.into_result_for(&request.host, &request.daemon_instance) else {
        return RuntimeCatalogOutcome::TransportContractViolation;
    };
    let Some((runtimes, detected_at)) = CatalogWire::decode(result) else {
        return RuntimeCatalogOutcome::DaemonInternalError;
    };
    RuntimeCatalogOutcome::Detected(RuntimeCatalog {
        host: request.host,
        instance: request.daemon_instance,
        runtimes,
        detected_at,
    })
}

fn outcome_for(failure: HostCommandFailure) -> RuntimeCatalogOutcome {
    match failure {
        HostCommandFailure::NoCurrentDaemon
        | HostCommandFailure::DaemonInstanceMismatch
        | HostCommandFailure::NotDispatched => RuntimeCatalogOutcome::AttachPending,
        HostCommandFailure::TimedOut => RuntimeCatalogOutcome::Timeout,
        // The daemon was reachable and answered, but not with a catalog. TS folds
        // exactly this set into `daemon_internal_error` (502).
        HostCommandFailure::Refused
        | HostCommandFailure::Ambiguous
        | HostCommandFailure::ProtocolCorruption
        | HostCommandFailure::RegistryUnavailable => RuntimeCatalogOutcome::DaemonInternalError,
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct CatalogWire {
    runtimes: Vec<RuntimeRowWire>,
    detected_at: i64,
}

impl CatalogWire {
    fn decode(value: Value) -> Option<(Vec<DetectedRuntime>, i64)> {
        let wire = serde_json::from_value::<Self>(value).ok()?;
        let runtimes = wire
            .runtimes
            .into_iter()
            .map(RuntimeRowWire::decode)
            .collect::<Option<Vec<_>>>()?;
        Some((runtimes, wire.detected_at))
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RuntimeRowWire {
    kind: String,
    state: String,
    reason: String,
    installed: bool,
    binary: Value,
    version: Value,
}

impl RuntimeRowWire {
    fn decode(self) -> Option<DetectedRuntime> {
        Some(DetectedRuntime {
            kind: RuntimeKind::parse(&self.kind)?,
            state: RuntimeAvailability::parse(&self.state)?,
            reason: RuntimeDetectionReason::parse(&self.reason)?,
            installed: self.installed,
            binary: nullable_text(self.binary)?,
            version: nullable_text(self.version)?,
        })
    }
}

fn nullable_text(value: Value) -> Option<Option<String>> {
    match value {
        Value::Null => Some(None),
        Value::String(text) => Some(Some(text)),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_transport_failure_maps_to_one_outcome_of_this_operation() {
        // The transport tells "no daemon", "not the daemon you meant" and "provably
        // not sent" apart, and this operation deliberately does not: to a caller
        // waiting for a machine to be reachable they are one answer.
        for pending in [
            HostCommandFailure::NoCurrentDaemon,
            HostCommandFailure::DaemonInstanceMismatch,
            HostCommandFailure::NotDispatched,
        ] {
            assert!(matches!(
                outcome_for(pending),
                RuntimeCatalogOutcome::AttachPending
            ));
        }
        assert!(matches!(
            outcome_for(HostCommandFailure::TimedOut),
            RuntimeCatalogOutcome::Timeout
        ));
        // A refusal says the same thing about this one question as a round trip that
        // failed rather than being refused: the machine cannot say what it has
        // installed. TS folds the same set into `daemon_internal_error` (502).
        for unanswerable in [
            HostCommandFailure::Refused,
            HostCommandFailure::Ambiguous,
            HostCommandFailure::ProtocolCorruption,
            HostCommandFailure::RegistryUnavailable,
        ] {
            assert!(matches!(
                outcome_for(unanswerable),
                RuntimeCatalogOutcome::DaemonInternalError
            ));
        }
    }

    fn row(overrides: Value) -> Value {
        let mut row = json!({
            "kind": "claude",
            "state": "present",
            "reason": "resolved",
            "installed": true,
            "binary": "/usr/bin/claude",
            "version": "1.2.3",
        });
        for (key, value) in overrides.as_object().unwrap() {
            row[key] = value.clone();
        }
        row
    }

    fn catalog(rows: Value) -> Value {
        json!({ "runtimes": rows, "detected_at": 1_700_000_000_000_i64 })
    }

    #[test]
    fn a_well_formed_catalog_decodes_every_closed_token() {
        let (runtimes, detected_at) = CatalogWire::decode(catalog(json!([
            row(json!({})),
            row(json!({ "kind": "codex", "state": "present_unverified", "reason": "version_unavailable", "version": Value::Null })),
            row(json!({ "kind": "opencode", "state": "absent", "reason": "not_found", "installed": false, "binary": Value::Null })),
            row(json!({ "kind": "gemini", "state": "unknown", "reason": "probe_failed" })),
        ])))
        .expect("catalog decodes");
        assert_eq!(detected_at, 1_700_000_000_000);
        assert_eq!(
            runtimes
                .iter()
                .map(|runtime| (
                    runtime.kind.as_str(),
                    runtime.state.as_str(),
                    runtime.reason.as_str(),
                    runtime.installed,
                    runtime.binary.clone(),
                    runtime.version.clone(),
                ))
                .collect::<Vec<_>>(),
            vec![
                (
                    "claude",
                    "present",
                    "resolved",
                    true,
                    Some("/usr/bin/claude".to_owned()),
                    Some("1.2.3".to_owned())
                ),
                (
                    "codex",
                    "present_unverified",
                    "version_unavailable",
                    true,
                    Some("/usr/bin/claude".to_owned()),
                    None
                ),
                (
                    "opencode",
                    "absent",
                    "not_found",
                    false,
                    None,
                    Some("1.2.3".to_owned())
                ),
                (
                    "gemini",
                    "unknown",
                    "probe_failed",
                    true,
                    Some("/usr/bin/claude".to_owned()),
                    Some("1.2.3".to_owned())
                ),
            ]
        );
    }

    #[test]
    fn a_token_outside_a_closed_set_is_never_reported_as_a_catalog() {
        for override_value in [
            json!({ "kind": "banana" }),
            json!({ "state": "installed" }),
            json!({ "reason": "timeout" }),
        ] {
            assert!(
                CatalogWire::decode(catalog(json!([row(override_value.clone())]))).is_none(),
                "expected {override_value} to be refused"
            );
        }
    }

    #[test]
    fn a_widened_or_incomplete_row_is_refused_rather_than_defaulted() {
        let mut widened = row(json!({}));
        widened["unexpected"] = json!(true);
        assert!(CatalogWire::decode(catalog(json!([widened]))).is_none());

        let mut missing = row(json!({}));
        missing.as_object_mut().unwrap().remove("version");
        assert!(CatalogWire::decode(catalog(json!([missing]))).is_none());

        let mut wrong_type = row(json!({}));
        wrong_type["binary"] = json!(7);
        assert!(CatalogWire::decode(catalog(json!([wrong_type]))).is_none());

        let mut widened_catalog = catalog(json!([]));
        widened_catalog["unexpected"] = json!(true);
        assert!(CatalogWire::decode(widened_catalog).is_none());

        assert!(CatalogWire::decode(json!({ "runtimes": [] })).is_none());
        assert!(CatalogWire::decode(json!({ "runtimes": [], "detected_at": 1.5 })).is_none());
    }
}
