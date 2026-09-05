use super::{audit::AuditWriters, bind::BoundListener};
use crate::*;

/// The infallible output of post-audit composition. It contains only the served graph and
/// its runtime owners; the bound socket and audit lifecycle remain uniquely outside.
pub(super) struct FinalAssembly {
    pub(super) router: Router,
    pub(super) boot: BootProgress,
    pub(super) event_controller: EventWebSocketController,
    pub(super) daemon_controller: DaemonDeliveryController,
    pub(super) presence_timers: PresenceGraceTimers<SqliteLastSeenSink, HubPresencePublisher>,
    pub(super) deletion_resumer: ProductionAgentDeletionResumer,
    pub(super) create_aftermath: CreateAftermath,
    pub(super) embedded_bootstrap_token: embedded_bootstrap::EmbeddedBootstrapTokenAuthority,
    #[cfg(test)]
    pub(super) test_runtime_credentials: RuntimeCredentialAuthority<SqliteRuntimeCustodyStore>,
}

/// The one production finalize door. Consuming the witness, assembly and writer owner
/// together makes re-finalization and rollback-after-commit unrepresentable.
/// `startup_generation` is the launcher's echoed spawn token (#task:2343), carried onto
/// the served app so `serve` can emit the one stdout `bound` frame.
pub(super) fn commit(
    bound: BoundListener,
    assembly: FinalAssembly,
    audit: AuditWriters,
    startup_generation: Option<String>,
) -> (tokio::net::TcpListener, PreparedApp) {
    let FinalAssembly {
        router,
        boot,
        event_controller,
        daemon_controller,
        presence_timers,
        deletion_resumer,
        create_aftermath,
        embedded_bootstrap_token,
        #[cfg(test)]
        test_runtime_credentials,
    } = assembly;
    let (cli_audit_sink, agent_audit_sink) = audit.into_parts();
    let app = PreparedApp {
        router,
        boot,
        event_controller,
        daemon_controller,
        presence_timers,
        deletion_resumer,
        create_aftermath,
        cli_audit_sink,
        agent_audit_sink,
        embedded_bootstrap_token,
        startup_generation,
        #[cfg(test)]
        test_runtime_credentials,
    };
    (bound.into_listener(), app)
}
