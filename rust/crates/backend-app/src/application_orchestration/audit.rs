use crate::{AppConfig, StartupError, open};
use silverhand_backend_core::identity_access::agent_audit_read::{AgentAuditEvent, AgentAuditSink};
use silverhand_backend_filesystem::foundation::audit_sink::{
    AgentAuditFileSink, AppTag, CliAuditFile, CliInvokeFileSink, CliPreflightFileSink, WriterState,
};
use silverhand_backend_server::{clock::SystemProcessClock, ops::deployment::DeploymentProfile};

#[derive(Clone)]
pub(super) struct AuditFacades {
    pub(super) cli_preflight: CliPreflightFileSink<SystemProcessClock>,
    pub(super) cli_invoke: CliInvokeFileSink<SystemProcessClock>,
    pub(super) agent_records: AgentAuditRecorder,
}

/// Recording-only facade. Its lifecycle-capable sink is private to this module, so router
/// state cannot close the writer owned by [`AuditWriters`].
#[derive(Clone)]
pub(super) struct AgentAuditRecorder(AgentAuditFileSink<SystemProcessClock>);

impl AgentAuditSink for AgentAuditRecorder {
    fn record(&self, event: AgentAuditEvent) {
        self.0.record(event);
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) struct AuditRollbackOutcome {
    pub(super) cli: WriterState,
    pub(super) agent: WriterState,
}

/// The only startup rollback owner. Router construction receives recording-only facades;
/// only this fixed pair can drain and close the two writer tasks.
pub(super) struct AuditWriters {
    cli: CliAuditFile<SystemProcessClock>,
    agent: AgentAuditFileSink<SystemProcessClock>,
}

impl AuditWriters {
    pub(super) async fn open<F>(config: &AppConfig, observe: F) -> Result<Self, StartupError>
    where
        F: FnOnce(CliPreflightFileSink<SystemProcessClock>, AgentAuditFileSink<SystemProcessClock>),
    {
        let app = match config.deployment_profile {
            DeploymentProfile::Embedded => AppTag::Desktop,
            DeploymentProfile::RemoteOnly => AppTag::Server,
        };
        let dir = config
            .log_dir
            .as_ref()
            .ok_or(StartupError::AuditLogDirectoryRequired)?;
        let cli = open(
            "CLI audit file",
            CliAuditFile::open(dir.clone(), app, SystemProcessClock),
        )
        .await?;
        let agent = match open(
            "agent audit sink",
            AgentAuditFileSink::open(dir.clone(), app, SystemProcessClock),
        )
        .await
        {
            Ok(agent) => agent,
            Err(original) => {
                cli.close().await;
                if cli.state() == WriterState::Failed {
                    tracing::warn!(
                        original = %crate::describe(&original),
                        cli = ?cli.state(),
                        "backend startup audit rollback observed a failed CLI writer"
                    );
                }
                return Err(original);
            }
        };
        observe(cli.preflight_sink(), agent.clone());
        Ok(Self { cli, agent })
    }

    pub(super) fn facades(&self) -> AuditFacades {
        AuditFacades {
            cli_preflight: self.cli.preflight_sink(),
            cli_invoke: self.cli.invoke_sink(),
            agent_records: AgentAuditRecorder(self.agent.clone()),
        }
    }

    pub(super) async fn rollback(self, original: StartupError) -> StartupError {
        self.cli.close().await;
        self.agent.close().await;
        let outcome = AuditRollbackOutcome {
            cli: self.cli.state(),
            agent: self.agent.state(),
        };
        if outcome.cli == WriterState::Failed || outcome.agent == WriterState::Failed {
            tracing::warn!(
                original = %crate::describe(&original),
                cli = ?outcome.cli,
                agent = ?outcome.agent,
                "backend startup audit rollback observed writer failure"
            );
        }
        original
    }

    pub(super) fn into_parts(
        self,
    ) -> (
        CliAuditFile<SystemProcessClock>,
        AgentAuditFileSink<SystemProcessClock>,
    ) {
        (self.cli, self.agent)
    }
}
