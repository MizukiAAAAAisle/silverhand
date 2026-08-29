//! Turning persisted tokens into the closed vocabularies a teardown reads.
//!
//! Two kinds live here. The domain tokens — materialization stage, observed
//! status — own their inverse in `backend-core`, so this leaf only forwards to
//! that authority and never re-states the mapping. The schema-only enums —
//! `hosts.kind`, `hosts.provisioning_source` — carry no rule beyond "which token
//! is which", so their decode is this adapter's and is written against the exact
//! CHECK-constrained strings the current schema stores.
//!
//! Every failure is `sqlx::Error::Decode`: a token outside its set is corrupt
//! storage, surfaced as a read failure and never folded into a default that would
//! turn bad data into a decision input.

use silverhand_backend_core::{
    agent_lifecycle::MaterializationStatus,
    agents::{runtime::RuntimeKind, session_scope::AgentSessionScope},
    host_runtime::computer::{HostKind, ProvisioningSource},
    identity::{AgentId, ConversationId, HostId, UserId},
    runtime_credential::RuntimeGeneration,
    runtime_event::RuntimeObservedStatus,
};
use thiserror::Error;

/// A token or coordinate outside its set is corrupt storage: it reaches the caller
/// as a read failure, never as a default that would turn bad data into a decision.
pub(super) fn decode_error<E>(error: E) -> sqlx::Error
where
    E: std::error::Error + Send + Sync + 'static,
{
    sqlx::Error::Decode(Box::new(error))
}

pub(super) fn agent_id(raw: String) -> Result<AgentId, sqlx::Error> {
    AgentId::parse(raw).map_err(decode_error)
}

pub(super) fn host_id(raw: String) -> Result<HostId, sqlx::Error> {
    HostId::parse(raw).map_err(decode_error)
}

pub(super) fn conversation_id(raw: String) -> Result<ConversationId, sqlx::Error> {
    ConversationId::parse(raw).map_err(decode_error)
}

pub(super) fn user_id(raw: String) -> Result<UserId, sqlx::Error> {
    UserId::parse(raw).map_err(decode_error)
}

pub(super) fn generation(raw: i64) -> Result<RuntimeGeneration, sqlx::Error> {
    RuntimeGeneration::new(raw).map_err(decode_error)
}

pub(super) fn materialization_status(raw: &str) -> Result<MaterializationStatus, sqlx::Error> {
    MaterializationStatus::parse(raw).map_err(decode_error)
}

pub(super) fn observed_status(raw: &str) -> Result<RuntimeObservedStatus, sqlx::Error> {
    RuntimeObservedStatus::parse(raw).map_err(decode_error)
}

pub(super) fn runtime(raw: &str) -> Result<RuntimeKind, sqlx::Error> {
    RuntimeKind::parse(raw).ok_or_else(|| decode_error(InvalidRuntimeKind))
}

pub(super) fn session_scope(raw: &str) -> Result<AgentSessionScope, sqlx::Error> {
    AgentSessionScope::parse(raw).ok_or_else(|| decode_error(InvalidSessionScope))
}

pub(super) fn host_kind(raw: &str) -> Result<HostKind, sqlx::Error> {
    match raw {
        "local" => Ok(HostKind::Local),
        "remote" => Ok(HostKind::Remote),
        _ => Err(decode_error(InvalidHostKind)),
    }
}

pub(super) fn provisioning_source(raw: &str) -> Result<ProvisioningSource, sqlx::Error> {
    match raw {
        "app_install" => Ok(ProvisioningSource::AppInstall),
        "user_invite" => Ok(ProvisioningSource::UserInvite),
        "system" => Ok(ProvisioningSource::System),
        _ => Err(decode_error(InvalidProvisioningSource)),
    }
}

#[derive(Debug, Error)]
#[error("persisted host kind is outside the closed set")]
struct InvalidHostKind;

#[derive(Debug, Error)]
#[error("persisted provisioning source is outside the closed set")]
struct InvalidProvisioningSource;

#[derive(Debug, Error)]
#[error("persisted runtime is outside the closed set")]
struct InvalidRuntimeKind;

#[derive(Debug, Error)]
#[error("persisted session scope is outside the closed set")]
struct InvalidSessionScope;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn host_kind_decodes_exactly_the_stored_tokens() {
        assert_eq!(host_kind("local").unwrap(), HostKind::Local);
        assert_eq!(host_kind("remote").unwrap(), HostKind::Remote);
        assert!(matches!(
            host_kind("orbital").unwrap_err(),
            sqlx::Error::Decode(_)
        ));
    }

    #[test]
    fn provisioning_source_decodes_exactly_the_stored_tokens() {
        assert_eq!(
            provisioning_source("app_install").unwrap(),
            ProvisioningSource::AppInstall
        );
        assert_eq!(
            provisioning_source("user_invite").unwrap(),
            ProvisioningSource::UserInvite
        );
        assert_eq!(
            provisioning_source("system").unwrap(),
            ProvisioningSource::System
        );
        assert!(matches!(
            provisioning_source("smuggled").unwrap_err(),
            sqlx::Error::Decode(_)
        ));
    }

    #[test]
    fn domain_tokens_forward_to_the_core_authority() {
        assert_eq!(
            materialization_status("active").unwrap(),
            MaterializationStatus::Active
        );
        assert!(matches!(
            materialization_status("archived").unwrap_err(),
            sqlx::Error::Decode(_)
        ));
        assert_eq!(
            observed_status("crashed").unwrap(),
            RuntimeObservedStatus::Crashed
        );
        assert!(matches!(
            observed_status("terminated").unwrap_err(),
            sqlx::Error::Decode(_)
        ));
    }
}
