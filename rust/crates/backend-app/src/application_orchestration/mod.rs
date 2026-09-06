pub(crate) mod activity_retention;
mod audit;
mod bind;
mod bootstrap;
mod composition;
pub(crate) mod conversation_debug_layer;
// #task:2288 — the create-aftermath post-commit effect, relocated under this dual-role
// application-orchestration context. Its `CreateAftermath` type is consumed by the crate root,
// so it is `pub(crate)`; colocation adds no facade and does not merge it into the composition
// internals above.
pub(crate) mod create_aftermath;
mod finalize;
mod lane_mounts;
mod resources;
// #task:2343 — the out-of-process Desktop-launcher startup handoff frame (bound
// address + echoed generation on stdout). `pub(crate)` so the crate root's `serve`
// emits it; a narrow, self-contained protocol seam.
pub(crate) mod startup_protocol;

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
        silverhand_backend_filesystem::foundation::audit_sink::CliPreflightFileSink<
            silverhand_backend_server::foundation::clock::SystemProcessClock,
        >,
        silverhand_backend_filesystem::foundation::audit_sink::AgentAuditFileSink<
            silverhand_backend_server::foundation::clock::SystemProcessClock,
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
        silverhand_backend_filesystem::foundation::audit_sink::CliPreflightFileSink<
            silverhand_backend_server::foundation::clock::SystemProcessClock,
        >,
        silverhand_backend_filesystem::foundation::audit_sink::AgentAuditFileSink<
            silverhand_backend_server::foundation::clock::SystemProcessClock,
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
        silverhand_backend_filesystem::foundation::audit_sink::CliPreflightFileSink<
            silverhand_backend_server::foundation::clock::SystemProcessClock,
        >,
        silverhand_backend_filesystem::foundation::audit_sink::AgentAuditFileSink<
            silverhand_backend_server::foundation::clock::SystemProcessClock,
        >,
    ),
{
    let resources = PassiveResources::open(config).await?;
    let audit = AuditWriters::open(config, observe_audit_sinks).await?;
    match composition::compose_after_audit(config, bound.address(), resources, audit.facades())
        .await
    {
        Ok(assembly) => Ok(finalize::commit(
            bound,
            assembly,
            audit,
            config.startup_generation().map(str::to_owned),
        )),
        Err(original) => Err(audit.rollback(original).await),
    }
}

#[cfg(test)]
mod tests;
