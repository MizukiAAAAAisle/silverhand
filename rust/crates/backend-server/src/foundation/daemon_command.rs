//! Closed Rust-issued daemon command vocabulary and sealed wire erasure.
//!
//! Business owners encode their own payloads and refusal vocabularies, then choose
//! one fixed-kind constructor here. No caller can combine an editable kind with an
//! arbitrary JSON value, and the connection owner is the only code allowed to open
//! the sealed value for serialization.

use serde_json::Value;

/// A stateless capability-refusal admission function owned by the command's
/// business context. Function pointers cannot capture an owner, store, `Arc`, or
/// lifecycle state, so pending correlation cannot become a context aggregator.
pub(crate) type CapabilityRefusalAdmission = fn(&str) -> bool;

pub(super) fn rejects_every_capability_refusal(_code: &str) -> bool {
    false
}

/// The complete set of command words this Rust server can issue.
#[derive(Clone, Copy, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub(crate) enum IssuedDaemonCommandKind {
    AgentFilesPurge,
    AgentMaterialize,
    AgentProfileMcpRead,
    AgentProfileMcpWrite,
    AgentWorkspaceFileRead,
    AgentWorkspaceIndex,
    AgentWorkspaceTree,
    HostStatus,
    McpProbe,
    ProxyConfigGet,
    ProxyConfigSet,
    RotateToken,
    RuntimeCatalog,
    RuntimeClearSession,
    RuntimeDeliver,
    RuntimeStart,
    RuntimeStatus,
    RuntimeStop,
}

impl IssuedDaemonCommandKind {
    pub(crate) const ALL: [Self; 18] = [
        Self::AgentFilesPurge,
        Self::AgentMaterialize,
        Self::AgentProfileMcpRead,
        Self::AgentProfileMcpWrite,
        Self::AgentWorkspaceFileRead,
        Self::AgentWorkspaceIndex,
        Self::AgentWorkspaceTree,
        Self::HostStatus,
        Self::McpProbe,
        Self::ProxyConfigGet,
        Self::ProxyConfigSet,
        Self::RotateToken,
        Self::RuntimeCatalog,
        Self::RuntimeClearSession,
        Self::RuntimeDeliver,
        Self::RuntimeStart,
        Self::RuntimeStatus,
        Self::RuntimeStop,
    ];

    pub(crate) const fn as_wire(self) -> &'static str {
        match self {
            Self::AgentFilesPurge => "agent_files_purge",
            Self::AgentMaterialize => "agent_materialize",
            Self::AgentProfileMcpRead => "agent_profile_mcp_read",
            Self::AgentProfileMcpWrite => "agent_profile_mcp_write",
            Self::AgentWorkspaceFileRead => "agent_workspace_file_read",
            Self::AgentWorkspaceIndex => "agent_workspace_index",
            Self::AgentWorkspaceTree => "agent_workspace_tree",
            Self::HostStatus => "host_status",
            Self::McpProbe => "mcp_probe",
            Self::ProxyConfigGet => "host_proxy_config_get",
            Self::ProxyConfigSet => "host_proxy_config_set",
            Self::RotateToken => "rotate_token",
            Self::RuntimeCatalog => "host_runtime_catalog",
            Self::RuntimeClearSession => "runtime_clear_session",
            Self::RuntimeDeliver => "runtime_deliver",
            Self::RuntimeStart => "runtime_start",
            Self::RuntimeStatus => "runtime_status",
            Self::RuntimeStop => "runtime_stop",
        }
    }

    pub(crate) fn from_wire(raw: &str) -> Option<Self> {
        Self::ALL
            .iter()
            .copied()
            .find(|candidate| candidate.as_wire() == raw)
    }
}

/// An encoded command whose kind, payload and capability refusal admission cannot
/// be reopened or recombined outside the connection owner.
pub(crate) struct EncodedDaemonCommand {
    kind: IssuedDaemonCommandKind,
    params: Value,
    capability_refusal: CapabilityRefusalAdmission,
}

impl EncodedDaemonCommand {
    /// Read-only identity for observations before custody admission. Payload and
    /// refusal admission remain sealed until the transport consumes the command.
    pub(super) fn kind(&self) -> IssuedDaemonCommandKind {
        self.kind
    }

    fn with_capabilities(
        kind: IssuedDaemonCommandKind,
        params: Value,
        capability_refusal: CapabilityRefusalAdmission,
    ) -> Self {
        Self {
            kind,
            params,
            capability_refusal,
        }
    }

    fn generic_only(kind: IssuedDaemonCommandKind, params: Value) -> Self {
        Self::with_capabilities(kind, params, rejects_every_capability_refusal)
    }

    pub(super) fn into_wire_parts(
        self,
    ) -> (IssuedDaemonCommandKind, Value, CapabilityRefusalAdmission) {
        (self.kind, self.params, self.capability_refusal)
    }
}

macro_rules! generic_command {
    ($name:ident, $kind:ident) => {
        pub(crate) fn $name(params: Value) -> EncodedDaemonCommand {
            EncodedDaemonCommand::generic_only(IssuedDaemonCommandKind::$kind, params)
        }
    };
}

macro_rules! capability_command {
    ($name:ident, $kind:ident) => {
        pub(crate) fn $name(
            params: Value,
            admission: CapabilityRefusalAdmission,
        ) -> EncodedDaemonCommand {
            EncodedDaemonCommand::with_capabilities(
                IssuedDaemonCommandKind::$kind,
                params,
                admission,
            )
        }
    };
}

capability_command!(agent_files_purge, AgentFilesPurge);
capability_command!(agent_materialize, AgentMaterialize);
capability_command!(agent_profile_mcp_read, AgentProfileMcpRead);
capability_command!(agent_profile_mcp_write, AgentProfileMcpWrite);
capability_command!(agent_workspace_file_read, AgentWorkspaceFileRead);
capability_command!(agent_workspace_index, AgentWorkspaceIndex);
capability_command!(agent_workspace_tree, AgentWorkspaceTree);
generic_command!(host_status, HostStatus);
capability_command!(mcp_probe, McpProbe);
generic_command!(proxy_config_get, ProxyConfigGet);
generic_command!(proxy_config_set, ProxyConfigSet);
generic_command!(rotate_token, RotateToken);
generic_command!(runtime_catalog, RuntimeCatalog);
generic_command!(runtime_clear_session, RuntimeClearSession);
capability_command!(runtime_deliver, RuntimeDeliver);
capability_command!(runtime_start, RuntimeStart);
generic_command!(runtime_status, RuntimeStatus);
generic_command!(runtime_stop, RuntimeStop);

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    #[test]
    fn issued_words_are_unique_and_round_trip() {
        let words: HashSet<_> = IssuedDaemonCommandKind::ALL
            .iter()
            .map(|kind| kind.as_wire())
            .collect();
        assert_eq!(words.len(), IssuedDaemonCommandKind::ALL.len());
        for kind in IssuedDaemonCommandKind::ALL {
            assert_eq!(
                IssuedDaemonCommandKind::from_wire(kind.as_wire()),
                Some(kind)
            );
        }
        assert_eq!(IssuedDaemonCommandKind::from_wire("daemon_restart"), None);
    }
}
