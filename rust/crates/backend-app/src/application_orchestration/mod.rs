mod audit;
mod bind;
mod bootstrap;
mod composition;
mod finalize;
mod resources;

use audit::AuditWriters;
use bind::BoundListener;
use resources::PassiveResources;

pub(super) async fn bind_and_prepare(
    config: &crate::AppConfig,
) -> Result<(tokio::net::TcpListener, crate::PreparedApp), crate::StartupError> {
    let bound = BoundListener::acquire_bound_listener(config).await?;
    prepare_bound_listener(config, bound).await
}

async fn prepare_bound_listener(
    config: &crate::AppConfig,
    bound: BoundListener,
) -> Result<(tokio::net::TcpListener, crate::PreparedApp), crate::StartupError> {
    prepare_bound_listener_observed(config, bound, |_, _| {}).await
}

#[cfg(test)]
pub(super) async fn prepare_existing_listener_observed<F>(
    config: &crate::AppConfig,
    listener: tokio::net::TcpListener,
    observe_audit_sinks: F,
) -> Result<(tokio::net::TcpListener, crate::PreparedApp), crate::StartupError>
where
    F: FnOnce(
        silverhand_backend_filesystem::audit_sink::CliPreflightFileSink<
            silverhand_backend_server::clock::SystemProcessClock,
        >,
        silverhand_backend_filesystem::audit_sink::AgentAuditFileSink<
            silverhand_backend_server::clock::SystemProcessClock,
        >,
    ),
{
    let bound = BoundListener::from_existing(listener)?;
    prepare_bound_listener_observed(config, bound, observe_audit_sinks).await
}

async fn prepare_bound_listener_observed<F>(
    config: &crate::AppConfig,
    bound: BoundListener,
    observe_audit_sinks: F,
) -> Result<(tokio::net::TcpListener, crate::PreparedApp), crate::StartupError>
where
    F: FnOnce(
        silverhand_backend_filesystem::audit_sink::CliPreflightFileSink<
            silverhand_backend_server::clock::SystemProcessClock,
        >,
        silverhand_backend_filesystem::audit_sink::AgentAuditFileSink<
            silverhand_backend_server::clock::SystemProcessClock,
        >,
    ),
{
    prepare_for_bound_listener_observed(config, bound, observe_audit_sinks).await
}

async fn prepare_for_bound_listener_observed<F>(
    config: &crate::AppConfig,
    bound: BoundListener,
    observe_audit_sinks: F,
) -> Result<(tokio::net::TcpListener, crate::PreparedApp), crate::StartupError>
where
    F: FnOnce(
        silverhand_backend_filesystem::audit_sink::CliPreflightFileSink<
            silverhand_backend_server::clock::SystemProcessClock,
        >,
        silverhand_backend_filesystem::audit_sink::AgentAuditFileSink<
            silverhand_backend_server::clock::SystemProcessClock,
        >,
    ),
{
    let resources = PassiveResources::open(config).await?;
    let audit = AuditWriters::open(config, observe_audit_sinks).await?;
    match composition::compose_after_audit(config, bound.address(), resources, audit.facades())
        .await
    {
        Ok(assembly) => Ok(finalize::commit(bound, assembly, audit)),
        Err(original) => Err(audit.rollback(original).await),
    }
}

#[cfg(test)]
mod tests;
