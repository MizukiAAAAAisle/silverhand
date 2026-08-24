//! Consumer-side conversation runtime control.
//!
//! This module owns the product admission order and the command/result vocabulary.
//! It deliberately does not own daemon transport, runtime custody, clear-session
//! coordination, HTTP status codes, or wire bodies. A provider implemented by the
//! host/runtime lane supplies those effects without exposing its state machine here.

use std::{error::Error, fmt, future::Future};

use crate::identity::{AgentId, ConversationId, UserId};

/// A persisted CLI session coordinate returned to the user after a successful clear.
#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub struct CliSessionId(String);

impl CliSessionId {
    pub fn parse(value: impl Into<String>) -> Result<Self, EmptyCliSessionId> {
        let value = value.into();
        if value.is_empty() {
            return Err(EmptyCliSessionId);
        }
        Ok(Self(value))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, thiserror::Error)]
#[error("CLI session id must not be empty")]
pub struct EmptyCliSessionId;

/// The only runtime operations the conversation collaboration surface exposes.
///
/// A legacy soft-stop/directive request cannot be represented. The server wire
/// adapter rejects it before constructing this value.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum RuntimeControlOperation {
    Start,
    HardStop,
    ClearSession,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RuntimeControlCommand {
    actor: UserId,
    conversation: ConversationId,
    agent: AgentId,
    operation: RuntimeControlOperation,
}

impl RuntimeControlCommand {
    pub fn new(
        actor: UserId,
        conversation: ConversationId,
        agent: AgentId,
        operation: RuntimeControlOperation,
    ) -> Self {
        Self {
            actor,
            conversation,
            agent,
            operation,
        }
    }

    pub fn actor(&self) -> &UserId {
        &self.actor
    }

    pub fn conversation(&self) -> &ConversationId {
        &self.conversation
    }

    pub fn agent(&self) -> &AgentId {
        &self.agent
    }

    pub fn operation(&self) -> RuntimeControlOperation {
        self.operation
    }
}

/// Product facts checked before host/runtime work is observable.
///
/// One capability-specific port is intentional: the implementation can answer all
/// five questions from one authoritative read seam without turning any answer into
/// a reusable capability token. The use case still fixes their observable order.
pub trait RuntimeControlAdmission {
    type Error: Error + Send + Sync + 'static;

    fn conversation_exists(
        &self,
        conversation: &ConversationId,
    ) -> impl Future<Output = Result<bool, Self::Error>> + Send;

    fn agent_exists(
        &self,
        agent: &AgentId,
    ) -> impl Future<Output = Result<bool, Self::Error>> + Send;

    fn agent_is_member(
        &self,
        conversation: &ConversationId,
        agent: &AgentId,
    ) -> impl Future<Output = Result<bool, Self::Error>> + Send;

    fn actor_may_post(
        &self,
        conversation: &ConversationId,
        actor: &UserId,
    ) -> impl Future<Output = Result<bool, Self::Error>> + Send;

    fn actor_may_edit_agent(
        &self,
        actor: &UserId,
        agent: &AgentId,
    ) -> impl Future<Output = Result<bool, Self::Error>> + Send;
}

/// Caller-actionable provider outcomes. Anything else is [`RuntimeControlFailure`]
/// and must be reported once as an internal failure by the server adapter.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum RuntimeControlProviderRefusal {
    HostAttachPending,
    WorkspaceNotProvisioned,
    WorkspaceBundleMissing,
    RegistryUnavailable,
    ShuttingDown,
    ClearSessionTimeout,
    ClearSessionInProgress,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ClearSessionOutcome {
    previous_cli_session: Option<CliSessionId>,
    was_running: bool,
}

impl ClearSessionOutcome {
    pub fn committed(previous_cli_session: Option<CliSessionId>, was_running: bool) -> Self {
        Self {
            previous_cli_session,
            was_running,
        }
    }

    pub fn previous_cli_session(&self) -> Option<&CliSessionId> {
        self.previous_cli_session.as_ref()
    }

    pub fn was_running(&self) -> bool {
        self.was_running
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum RuntimeControlOutcome {
    StartedOrAlreadyRunning,
    StoppedOrAlreadyExited,
    SessionCleared(ClearSessionOutcome),
}

/// The provider consumes one typed command and owns the full host/runtime protocol.
///
/// The inner result is a named caller-actionable refusal. The outer error keeps a
/// real source chain for driver/protocol/corruption failures; collapsing those into
/// a refusal would leak internals or mislabel an outage as a product denial.
pub trait RuntimeControlPort {
    type Error: Error + Send + Sync + 'static;

    fn control(
        &self,
        command: &RuntimeControlCommand,
    ) -> impl Future<
        Output = Result<Result<RuntimeControlOutcome, RuntimeControlProviderRefusal>, Self::Error>,
    > + Send;
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum RuntimeControlRefusal {
    ConversationNotFound,
    AgentNotFound,
    AgentNotMember,
    Forbidden,
    Provider(RuntimeControlProviderRefusal),
}

#[derive(Debug)]
pub enum RuntimeControlFailure<A, P>
where
    A: Error + Send + Sync + 'static,
    P: Error + Send + Sync + 'static,
{
    Admission(A),
    Provider(P),
}

impl<A, P> fmt::Display for RuntimeControlFailure<A, P>
where
    A: Error + Send + Sync + 'static,
    P: Error + Send + Sync + 'static,
{
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Admission(_) => formatter.write_str("runtime-control admission failed"),
            Self::Provider(_) => formatter.write_str("runtime-control provider failed"),
        }
    }
}

impl<A, P> Error for RuntimeControlFailure<A, P>
where
    A: Error + Send + Sync + 'static,
    P: Error + Send + Sync + 'static,
{
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match self {
            Self::Admission(source) => Some(source),
            Self::Provider(source) => Some(source),
        }
    }
}

/// Admit in product order, then invoke the provider exactly once.
pub async fn control_conversation_runtime<A, P>(
    admission: &A,
    provider: &P,
    command: RuntimeControlCommand,
) -> Result<
    Result<RuntimeControlOutcome, RuntimeControlRefusal>,
    RuntimeControlFailure<A::Error, P::Error>,
>
where
    A: RuntimeControlAdmission,
    P: RuntimeControlPort,
{
    if !admission
        .conversation_exists(command.conversation())
        .await
        .map_err(RuntimeControlFailure::Admission)?
    {
        return Ok(Err(RuntimeControlRefusal::ConversationNotFound));
    }
    if !admission
        .agent_exists(command.agent())
        .await
        .map_err(RuntimeControlFailure::Admission)?
    {
        return Ok(Err(RuntimeControlRefusal::AgentNotFound));
    }
    if !admission
        .agent_is_member(command.conversation(), command.agent())
        .await
        .map_err(RuntimeControlFailure::Admission)?
    {
        return Ok(Err(RuntimeControlRefusal::AgentNotMember));
    }
    if !admission
        .actor_may_post(command.conversation(), command.actor())
        .await
        .map_err(RuntimeControlFailure::Admission)?
    {
        return Ok(Err(RuntimeControlRefusal::Forbidden));
    }
    if !admission
        .actor_may_edit_agent(command.actor(), command.agent())
        .await
        .map_err(RuntimeControlFailure::Admission)?
    {
        return Ok(Err(RuntimeControlRefusal::Forbidden));
    }

    provider
        .control(&command)
        .await
        .map_err(RuntimeControlFailure::Provider)
        .map(|outcome| outcome.map_err(RuntimeControlRefusal::Provider))
}

#[cfg(test)]
mod tests {
    use std::{convert::Infallible, sync::Mutex};

    use super::*;

    #[derive(Default)]
    struct Admission {
        answers: [bool; 5],
        calls: Mutex<Vec<&'static str>>,
    }

    impl RuntimeControlAdmission for Admission {
        type Error = Infallible;

        async fn conversation_exists(
            &self,
            _conversation: &ConversationId,
        ) -> Result<bool, Self::Error> {
            self.calls.lock().unwrap().push("conversation");
            Ok(self.answers[0])
        }

        async fn agent_exists(&self, _agent: &AgentId) -> Result<bool, Self::Error> {
            self.calls.lock().unwrap().push("agent");
            Ok(self.answers[1])
        }

        async fn agent_is_member(
            &self,
            _conversation: &ConversationId,
            _agent: &AgentId,
        ) -> Result<bool, Self::Error> {
            self.calls.lock().unwrap().push("membership");
            Ok(self.answers[2])
        }

        async fn actor_may_post(
            &self,
            _conversation: &ConversationId,
            _actor: &UserId,
        ) -> Result<bool, Self::Error> {
            self.calls.lock().unwrap().push("post");
            Ok(self.answers[3])
        }

        async fn actor_may_edit_agent(
            &self,
            _actor: &UserId,
            _agent: &AgentId,
        ) -> Result<bool, Self::Error> {
            self.calls.lock().unwrap().push("edit");
            Ok(self.answers[4])
        }
    }

    #[derive(Default)]
    struct Provider(Mutex<Vec<RuntimeControlOperation>>);

    impl RuntimeControlPort for Provider {
        type Error = Infallible;

        async fn control(
            &self,
            command: &RuntimeControlCommand,
        ) -> Result<Result<RuntimeControlOutcome, RuntimeControlProviderRefusal>, Self::Error>
        {
            self.0.lock().unwrap().push(command.operation());
            Ok(Ok(RuntimeControlOutcome::StartedOrAlreadyRunning))
        }
    }

    fn command() -> RuntimeControlCommand {
        RuntimeControlCommand::new(
            UserId::parse("user-1").unwrap(),
            ConversationId::parse("conversation-1").unwrap(),
            AgentId::parse("agent-1").unwrap(),
            RuntimeControlOperation::Start,
        )
    }

    #[tokio::test]
    async fn admission_is_ordered_and_a_refusal_never_reaches_the_provider() {
        for refused_at in 0..5 {
            let mut answers = [true; 5];
            answers[refused_at] = false;
            let admission = Admission {
                answers,
                ..Admission::default()
            };
            let provider = Provider::default();
            let result = control_conversation_runtime(&admission, &provider, command())
                .await
                .unwrap();
            assert!(result.is_err());
            assert!(provider.0.lock().unwrap().is_empty());
            assert_eq!(admission.calls.lock().unwrap().len(), refused_at + 1);
        }
    }

    #[tokio::test]
    async fn an_admitted_command_reaches_the_provider_once() {
        let admission = Admission {
            answers: [true; 5],
            ..Admission::default()
        };
        let provider = Provider::default();
        assert_eq!(
            control_conversation_runtime(&admission, &provider, command())
                .await
                .unwrap(),
            Ok(RuntimeControlOutcome::StartedOrAlreadyRunning)
        );
        assert_eq!(
            admission.calls.lock().unwrap().as_slice(),
            ["conversation", "agent", "membership", "post", "edit"]
        );
        assert_eq!(
            provider.0.lock().unwrap().as_slice(),
            [RuntimeControlOperation::Start]
        );
    }
}
