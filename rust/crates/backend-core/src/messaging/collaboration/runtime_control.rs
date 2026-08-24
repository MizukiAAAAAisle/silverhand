//! Consumer-side conversation runtime control.
//!
//! This module owns the product admission order and three operation-specific
//! contracts. It deliberately does not own daemon transport, runtime custody,
//! clear-session coordination, HTTP status codes, or wire bodies.

use std::{error::Error, fmt, future::Future};

use crate::identity::{AgentId, ConversationId, UserId};

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RuntimeControlTarget {
    actor: UserId,
    conversation: ConversationId,
    agent: AgentId,
}

impl RuntimeControlTarget {
    pub fn new(actor: UserId, conversation: ConversationId, agent: AgentId) -> Self {
        Self {
            actor,
            conversation,
            agent,
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
}

/// One request-scoped, consistent read snapshot.
///
/// The use case still asks each question separately and in published order, so
/// an early refusal does not touch later tables. A production SQLite adapter holds
/// one read transaction behind this scope; it is dropped before daemon work begins.
pub trait RuntimeControlAdmissionScope {
    type Error: Error + Send + Sync + 'static;

    fn conversation_exists(
        &mut self,
        conversation: &ConversationId,
    ) -> impl Future<Output = Result<bool, Self::Error>> + Send;

    fn agent_exists(
        &mut self,
        agent: &AgentId,
    ) -> impl Future<Output = Result<bool, Self::Error>> + Send;

    fn agent_is_member(
        &mut self,
        conversation: &ConversationId,
        agent: &AgentId,
    ) -> impl Future<Output = Result<bool, Self::Error>> + Send;

    fn actor_may_post(
        &mut self,
        conversation: &ConversationId,
        actor: &UserId,
    ) -> impl Future<Output = Result<bool, Self::Error>> + Send;

    fn actor_may_edit_agent(
        &mut self,
        actor: &UserId,
        agent: &AgentId,
    ) -> impl Future<Output = Result<bool, Self::Error>> + Send;
}

pub trait RuntimeControlAdmission {
    type Error: Error + Send + Sync + 'static;
    type Scope: RuntimeControlAdmissionScope<Error = Self::Error> + Send;

    fn begin_snapshot(&self) -> impl Future<Output = Result<Self::Scope, Self::Error>> + Send;
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum RuntimeControlAdmissionRefusal {
    ConversationNotFound,
    AgentNotFound,
    AgentNotMember,
    Forbidden,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum RuntimePlacementRefusal {
    HostMissing,
    HostNotOwned,
    HostPendingAttach,
    HostRuntimeDisabled,
    HostRevoked,
    LocalHostUnbound,
    LocalHostAmbiguous,
    HostAttachPending,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum StartRuntimeProviderRefusal {
    Placement(RuntimePlacementRefusal),
    WorkspaceNotProvisioned,
    WorkspaceBundleMissing,
    RegistryUnavailable,
    ShuttingDown,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum HardStopRuntimeProviderRefusal {
    Placement(RuntimePlacementRefusal),
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ClearSessionProviderRefusal {
    Placement(RuntimePlacementRefusal),
    Timeout,
    InProgress,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct StartRuntimeOutcome;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct HardStopRuntimeOutcome;

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

/// Operation-specific methods make illegal command/outcome/refusal combinations
/// unrepresentable.
pub trait RuntimeControlPort {
    type Error: Error + Send + Sync + 'static;

    fn start(
        &self,
        target: &RuntimeControlTarget,
    ) -> impl Future<
        Output = Result<Result<StartRuntimeOutcome, StartRuntimeProviderRefusal>, Self::Error>,
    > + Send;

    fn hard_stop(
        &self,
        target: &RuntimeControlTarget,
    ) -> impl Future<
        Output = Result<
            Result<HardStopRuntimeOutcome, HardStopRuntimeProviderRefusal>,
            Self::Error,
        >,
    > + Send;

    fn clear_session(
        &self,
        target: &RuntimeControlTarget,
    ) -> impl Future<
        Output = Result<Result<ClearSessionOutcome, ClearSessionProviderRefusal>, Self::Error>,
    > + Send;
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum StartRuntimeRefusal {
    Admission(RuntimeControlAdmissionRefusal),
    Provider(StartRuntimeProviderRefusal),
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum HardStopRuntimeRefusal {
    Admission(RuntimeControlAdmissionRefusal),
    Provider(HardStopRuntimeProviderRefusal),
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ClearSessionRefusal {
    Admission(RuntimeControlAdmissionRefusal),
    Provider(ClearSessionProviderRefusal),
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

async fn admit<A: RuntimeControlAdmission>(
    admission: &A,
    target: &RuntimeControlTarget,
) -> Result<Option<RuntimeControlAdmissionRefusal>, A::Error> {
    let mut snapshot = admission.begin_snapshot().await?;
    if !snapshot.conversation_exists(target.conversation()).await? {
        return Ok(Some(RuntimeControlAdmissionRefusal::ConversationNotFound));
    }
    if !snapshot.agent_exists(target.agent()).await? {
        return Ok(Some(RuntimeControlAdmissionRefusal::AgentNotFound));
    }
    if !snapshot
        .agent_is_member(target.conversation(), target.agent())
        .await?
    {
        return Ok(Some(RuntimeControlAdmissionRefusal::AgentNotMember));
    }
    if !snapshot
        .actor_may_post(target.conversation(), target.actor())
        .await?
    {
        return Ok(Some(RuntimeControlAdmissionRefusal::Forbidden));
    }
    if !snapshot
        .actor_may_edit_agent(target.actor(), target.agent())
        .await?
    {
        return Ok(Some(RuntimeControlAdmissionRefusal::Forbidden));
    }
    drop(snapshot);
    Ok(None)
}

pub async fn start_conversation_runtime<A, P>(
    admission: &A,
    provider: &P,
    target: RuntimeControlTarget,
) -> Result<
    Result<StartRuntimeOutcome, StartRuntimeRefusal>,
    RuntimeControlFailure<A::Error, P::Error>,
>
where
    A: RuntimeControlAdmission,
    P: RuntimeControlPort,
{
    if let Some(refusal) = admit(admission, &target)
        .await
        .map_err(RuntimeControlFailure::Admission)?
    {
        return Ok(Err(StartRuntimeRefusal::Admission(refusal)));
    }
    provider
        .start(&target)
        .await
        .map_err(RuntimeControlFailure::Provider)
        .map(|result| result.map_err(StartRuntimeRefusal::Provider))
}

pub async fn hard_stop_conversation_runtime<A, P>(
    admission: &A,
    provider: &P,
    target: RuntimeControlTarget,
) -> Result<
    Result<HardStopRuntimeOutcome, HardStopRuntimeRefusal>,
    RuntimeControlFailure<A::Error, P::Error>,
>
where
    A: RuntimeControlAdmission,
    P: RuntimeControlPort,
{
    if let Some(refusal) = admit(admission, &target)
        .await
        .map_err(RuntimeControlFailure::Admission)?
    {
        return Ok(Err(HardStopRuntimeRefusal::Admission(refusal)));
    }
    provider
        .hard_stop(&target)
        .await
        .map_err(RuntimeControlFailure::Provider)
        .map(|result| result.map_err(HardStopRuntimeRefusal::Provider))
}

pub async fn clear_conversation_runtime_session<A, P>(
    admission: &A,
    provider: &P,
    target: RuntimeControlTarget,
) -> Result<
    Result<ClearSessionOutcome, ClearSessionRefusal>,
    RuntimeControlFailure<A::Error, P::Error>,
>
where
    A: RuntimeControlAdmission,
    P: RuntimeControlPort,
{
    if let Some(refusal) = admit(admission, &target)
        .await
        .map_err(RuntimeControlFailure::Admission)?
    {
        return Ok(Err(ClearSessionRefusal::Admission(refusal)));
    }
    provider
        .clear_session(&target)
        .await
        .map_err(RuntimeControlFailure::Provider)
        .map(|result| result.map_err(ClearSessionRefusal::Provider))
}

#[cfg(test)]
mod tests {
    use std::sync::{Arc, Mutex};

    use super::*;

    #[derive(Clone, Copy, Debug, Eq, PartialEq, thiserror::Error)]
    #[error("{0}")]
    struct Failure(&'static str);

    struct Admission {
        answers: [bool; 5],
        begin_error: Option<Failure>,
        calls: Arc<Mutex<Vec<&'static str>>>,
    }

    struct Snapshot {
        answers: [bool; 5],
        calls: Arc<Mutex<Vec<&'static str>>>,
    }

    impl RuntimeControlAdmission for Admission {
        type Error = Failure;
        type Scope = Snapshot;

        async fn begin_snapshot(&self) -> Result<Self::Scope, Self::Error> {
            self.begin_error.map_or_else(
                || {
                    Ok(Snapshot {
                        answers: self.answers,
                        calls: Arc::clone(&self.calls),
                    })
                },
                Err,
            )
        }
    }

    impl RuntimeControlAdmissionScope for Snapshot {
        type Error = Failure;

        async fn conversation_exists(
            &mut self,
            _conversation: &ConversationId,
        ) -> Result<bool, Self::Error> {
            self.calls.lock().unwrap().push("conversation");
            Ok(self.answers[0])
        }

        async fn agent_exists(&mut self, _agent: &AgentId) -> Result<bool, Self::Error> {
            self.calls.lock().unwrap().push("agent");
            Ok(self.answers[1])
        }

        async fn agent_is_member(
            &mut self,
            _conversation: &ConversationId,
            _agent: &AgentId,
        ) -> Result<bool, Self::Error> {
            self.calls.lock().unwrap().push("membership");
            Ok(self.answers[2])
        }

        async fn actor_may_post(
            &mut self,
            _conversation: &ConversationId,
            _actor: &UserId,
        ) -> Result<bool, Self::Error> {
            self.calls.lock().unwrap().push("post");
            Ok(self.answers[3])
        }

        async fn actor_may_edit_agent(
            &mut self,
            _actor: &UserId,
            _agent: &AgentId,
        ) -> Result<bool, Self::Error> {
            self.calls.lock().unwrap().push("edit");
            Ok(self.answers[4])
        }
    }

    struct Provider {
        calls: Mutex<Vec<&'static str>>,
        fail: bool,
    }

    impl RuntimeControlPort for Provider {
        type Error = Failure;

        async fn start(
            &self,
            _target: &RuntimeControlTarget,
        ) -> Result<Result<StartRuntimeOutcome, StartRuntimeProviderRefusal>, Self::Error> {
            self.calls.lock().unwrap().push("start");
            if self.fail {
                Err(Failure("provider"))
            } else {
                Ok(Ok(StartRuntimeOutcome))
            }
        }

        async fn hard_stop(
            &self,
            _target: &RuntimeControlTarget,
        ) -> Result<Result<HardStopRuntimeOutcome, HardStopRuntimeProviderRefusal>, Self::Error>
        {
            self.calls.lock().unwrap().push("hard_stop");
            if self.fail {
                Err(Failure("provider"))
            } else {
                Ok(Ok(HardStopRuntimeOutcome))
            }
        }

        async fn clear_session(
            &self,
            _target: &RuntimeControlTarget,
        ) -> Result<Result<ClearSessionOutcome, ClearSessionProviderRefusal>, Self::Error> {
            self.calls.lock().unwrap().push("clear_session");
            if self.fail {
                Err(Failure("provider"))
            } else {
                Ok(Ok(ClearSessionOutcome::committed(None, false)))
            }
        }
    }

    fn admission(answers: [bool; 5]) -> Admission {
        Admission {
            answers,
            begin_error: None,
            calls: Arc::new(Mutex::new(Vec::new())),
        }
    }

    fn provider(fail: bool) -> Provider {
        Provider {
            calls: Mutex::new(Vec::new()),
            fail,
        }
    }

    fn target() -> RuntimeControlTarget {
        RuntimeControlTarget::new(
            UserId::parse("user-1").unwrap(),
            ConversationId::parse("conversation-1").unwrap(),
            AgentId::parse("agent-1").unwrap(),
        )
    }

    #[tokio::test]
    async fn exact_admission_refusals_stop_at_the_first_failed_question() {
        let cases = [
            RuntimeControlAdmissionRefusal::ConversationNotFound,
            RuntimeControlAdmissionRefusal::AgentNotFound,
            RuntimeControlAdmissionRefusal::AgentNotMember,
            RuntimeControlAdmissionRefusal::Forbidden,
            RuntimeControlAdmissionRefusal::Forbidden,
        ];
        for (refused_at, expected) in cases.into_iter().enumerate() {
            let mut answers = [true; 5];
            answers[refused_at] = false;
            let admission = admission(answers);
            let provider = provider(false);
            assert_eq!(
                start_conversation_runtime(&admission, &provider, target())
                    .await
                    .unwrap(),
                Err(StartRuntimeRefusal::Admission(expected))
            );
            assert!(provider.calls.lock().unwrap().is_empty());
            assert_eq!(admission.calls.lock().unwrap().len(), refused_at + 1);
        }
    }

    #[tokio::test]
    async fn each_operation_has_its_own_success_type() {
        let admission = admission([true; 5]);
        let provider = provider(false);
        assert_eq!(
            start_conversation_runtime(&admission, &provider, target())
                .await
                .unwrap(),
            Ok(StartRuntimeOutcome)
        );
        assert_eq!(
            hard_stop_conversation_runtime(&admission, &provider, target())
                .await
                .unwrap(),
            Ok(HardStopRuntimeOutcome)
        );
        assert_eq!(
            clear_conversation_runtime_session(&admission, &provider, target())
                .await
                .unwrap(),
            Ok(ClearSessionOutcome::committed(None, false))
        );
        assert_eq!(
            provider.calls.lock().unwrap().as_slice(),
            ["start", "hard_stop", "clear_session"]
        );
    }

    #[tokio::test]
    async fn operation_specific_provider_refusals_pass_through_exactly() {
        struct Refusing;
        impl RuntimeControlPort for Refusing {
            type Error = Failure;

            async fn start(
                &self,
                _: &RuntimeControlTarget,
            ) -> Result<Result<StartRuntimeOutcome, StartRuntimeProviderRefusal>, Self::Error>
            {
                Ok(Err(StartRuntimeProviderRefusal::ShuttingDown))
            }

            async fn hard_stop(
                &self,
                _: &RuntimeControlTarget,
            ) -> Result<Result<HardStopRuntimeOutcome, HardStopRuntimeProviderRefusal>, Self::Error>
            {
                Ok(Err(HardStopRuntimeProviderRefusal::Placement(
                    RuntimePlacementRefusal::HostAttachPending,
                )))
            }

            async fn clear_session(
                &self,
                _: &RuntimeControlTarget,
            ) -> Result<Result<ClearSessionOutcome, ClearSessionProviderRefusal>, Self::Error>
            {
                Ok(Err(ClearSessionProviderRefusal::Timeout))
            }
        }

        let admission = admission([true; 5]);
        assert_eq!(
            start_conversation_runtime(&admission, &Refusing, target())
                .await
                .unwrap(),
            Err(StartRuntimeRefusal::Provider(
                StartRuntimeProviderRefusal::ShuttingDown
            ))
        );
        assert_eq!(
            hard_stop_conversation_runtime(&admission, &Refusing, target())
                .await
                .unwrap(),
            Err(HardStopRuntimeRefusal::Provider(
                HardStopRuntimeProviderRefusal::Placement(
                    RuntimePlacementRefusal::HostAttachPending
                )
            ))
        );
        assert_eq!(
            clear_conversation_runtime_session(&admission, &Refusing, target())
                .await
                .unwrap(),
            Err(ClearSessionRefusal::Provider(
                ClearSessionProviderRefusal::Timeout
            ))
        );
    }

    #[tokio::test]
    async fn admission_and_provider_failures_preserve_their_sources() {
        let admission = Admission {
            answers: [true; 5],
            begin_error: Some(Failure("admission")),
            calls: Arc::new(Mutex::new(Vec::new())),
        };
        let error = start_conversation_runtime(&admission, &provider(false), target())
            .await
            .unwrap_err();
        assert_eq!(error.source().unwrap().to_string(), "admission");

        let error =
            start_conversation_runtime(&self::admission([true; 5]), &provider(true), target())
                .await
                .unwrap_err();
        assert_eq!(error.source().unwrap().to_string(), "provider");
    }
}
