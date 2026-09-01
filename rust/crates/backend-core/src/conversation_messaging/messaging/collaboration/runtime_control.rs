//! Consumer-side conversation runtime control.
//!
//! This module owns the product admission order and three operation-specific
//! contracts. It deliberately does not own daemon transport, runtime custody,
//! clear-session coordination, HTTP status codes, or wire bodies.

use std::{error::Error, fmt, future::Future};

use crate::{
    foundation::identity::{AgentId, ConversationId, DaemonInstanceId, HostId, UserId},
    host_runtime::runtime_credential::{RuntimeGeneration, RuntimeScope},
    identity_access::agents::session_scope::AgentSessionScope,
};

/// A runtime *start* intent. It deliberately carries **no** `RuntimeScope`: the
/// scope arm (conversation- vs agent-scoped) is owned by the immutable persisted
/// `agents.session_scope` row, never by the caller. `presentation_origin` is a
/// *candidate* conversation; the dispatch resolver validates the agent's real
/// participation in it and re-derives the origin from the hit row before any wire.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RuntimeStartTarget {
    actor: UserId,
    agent: AgentId,
    presentation_origin: ConversationId,
}

impl RuntimeStartTarget {
    pub fn new(actor: UserId, agent: AgentId, presentation_origin: ConversationId) -> Self {
        Self {
            actor,
            agent,
            presentation_origin,
        }
    }

    pub fn actor(&self) -> &UserId {
        &self.actor
    }

    pub fn agent(&self) -> &AgentId {
        &self.agent
    }

    pub fn presentation_origin(&self) -> &ConversationId {
        &self.presentation_origin
    }
}

/// A seat-operation target (clear-session / hard-stop). It carries the acting
/// human plus the row-owned [`RuntimeScope`], which is always minted from a fact
/// (route admission reading the persisted session scope, or a seat read fact for
/// runtime-switch) — never selected by the caller. Exact scope equality binds it
/// to the durable seat, so an agent-scoped seat can never match a conversation.
///
/// This is the **sealed admission artifact** and the sole authorization the
/// persistence write path trusts: [`RuntimeControlSeatPort::settle_clear`] consumes
/// it (a downstream crate can read its accessors but cannot construct it), so no
/// caller can drive a durable clear/audit without having passed admission. The
/// read path ([`RuntimeControlSeatPort::snapshot`]) needs no authorization and takes
/// a bare [`RuntimeScope`] instead.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RuntimeSeatTarget {
    actor: UserId,
    scope: RuntimeScope,
}

impl RuntimeSeatTarget {
    /// Mint a seat target from a row-owned [`RuntimeScope`]. Module-private with no test
    /// escape hatch: a `RuntimeScope` is authoritative only when derived from a fact, so the
    /// only mint sites are the route-admission use cases in this module (reading the immutable
    /// persisted session scope) and the transition ctor below (consuming an unforgeable sealed
    /// seat candidate). A public — or even crate-visible — raw constructor would let another
    /// core module hand-pick an arm and re-open the caller-selected-scope hole this type exists
    /// to close.
    fn new(actor: UserId, scope: RuntimeScope) -> Self {
        Self { actor, scope }
    }

    /// Mint a clear target for a runtime-transition seat. The [`TransitionClearCandidate`] can
    /// only be produced by iterating a sealed [`crate::host_runtime::runtime_transition::RuntimeTransitionSeatSnapshot`]
    /// under the exact held lock, and its inner row is private, so the scope here is provably a
    /// seat that snapshot enumerated — never a caller-picked arm. This is the sole cross-module
    /// mint site, and it takes the sealed candidate rather than a bare scope so the transition
    /// module never needs to depend on this target type or `UserId`.
    pub(crate) fn for_transition_clear(
        actor: UserId,
        candidate: &crate::host_runtime::runtime_transition::TransitionClearCandidate<'_>,
    ) -> Self {
        Self::new(actor, candidate.scope().clone())
    }

    pub fn actor(&self) -> &UserId {
        &self.actor
    }

    pub fn scope(&self) -> &RuntimeScope {
        &self.scope
    }

    pub fn agent(&self) -> &AgentId {
        self.scope.agent()
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum RuntimeControlObservedStatus {
    Idle,
    Starting,
    Active,
    Crashed,
}

impl RuntimeControlObservedStatus {
    pub const fn was_running(self) -> bool {
        matches!(self, Self::Starting | Self::Active)
    }
}

/// Durable pre-state for one semantic runtime seat. This is a fact-source value;
/// callers must bind it to the request with [`Self::bind`] before any effect.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RuntimeControlSeatSnapshot {
    agent: AgentId,
    host: HostId,
    scope: RuntimeScope,
    generation: RuntimeGeneration,
    daemon_instance: Option<DaemonInstanceId>,
    previous_cli_session: Option<CliSessionId>,
    observed_status: RuntimeControlObservedStatus,
    agent_name: String,
}

impl RuntimeControlSeatSnapshot {
    #[allow(clippy::too_many_arguments)]
    pub fn decoded(
        agent: AgentId,
        host: HostId,
        scope: RuntimeScope,
        generation: RuntimeGeneration,
        daemon_instance: Option<DaemonInstanceId>,
        previous_cli_session: Option<CliSessionId>,
        observed_status: RuntimeControlObservedStatus,
        agent_name: String,
    ) -> Self {
        Self {
            agent,
            host,
            scope,
            generation,
            daemon_instance,
            previous_cli_session,
            observed_status,
            agent_name,
        }
    }

    pub fn bind(
        self,
        scope: &RuntimeScope,
    ) -> Result<BoundRuntimeControlSeat, RuntimeControlSeatMismatch> {
        // Exact scope equality: `RuntimeScope` distinguishes the two arms by
        // construction, so an `AgentSlot` seat can never satisfy a
        // `ConversationSlot` request (and vice versa), and a conversation-scoped
        // seat is pinned to its exact source conversation. This closes the old
        // `is_none_or` hole where an agent-scoped seat accepted any conversation.
        let scope_matches = self.scope == *scope && &self.agent == self.scope.agent();
        if !scope_matches || self.agent_name.is_empty() {
            return Err(RuntimeControlSeatMismatch);
        }
        Ok(BoundRuntimeControlSeat(self))
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct BoundRuntimeControlSeat(RuntimeControlSeatSnapshot);

impl BoundRuntimeControlSeat {
    pub fn host(&self) -> &HostId {
        &self.0.host
    }

    pub fn scope(&self) -> &RuntimeScope {
        &self.0.scope
    }

    pub const fn generation(&self) -> RuntimeGeneration {
        self.0.generation
    }

    pub fn daemon_instance(&self) -> Option<&DaemonInstanceId> {
        self.0.daemon_instance.as_ref()
    }

    pub fn previous_cli_session(&self) -> Option<&CliSessionId> {
        self.0.previous_cli_session.as_ref()
    }

    pub const fn was_running(&self) -> bool {
        self.0.observed_status.was_running()
    }

    pub fn agent(&self) -> &AgentId {
        &self.0.agent
    }

    pub fn agent_name(&self) -> &str {
        &self.0.agent_name
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, thiserror::Error)]
#[error("runtime-control seat facts do not match the requested coordinate")]
pub struct RuntimeControlSeatMismatch;

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ClearSessionAuditWitness {
    None,
    Conversation(ConversationId),
    Agent(AgentId),
}

/// The database adapter's before/committed witness. It does not mint the
/// application outcome; [`seal_clear_session_commit`] validates every field.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ClearSessionCommitReceipt {
    scope: RuntimeScope,
    generation: RuntimeGeneration,
    previous_cli_session: Option<CliSessionId>,
    was_running: bool,
    committed_cli_session: Option<CliSessionId>,
    audit: ClearSessionAuditWitness,
}

impl ClearSessionCommitReceipt {
    pub fn decoded(
        scope: RuntimeScope,
        generation: RuntimeGeneration,
        previous_cli_session: Option<CliSessionId>,
        was_running: bool,
        committed_cli_session: Option<CliSessionId>,
        audit: ClearSessionAuditWitness,
    ) -> Self {
        Self {
            scope,
            generation,
            previous_cli_session,
            was_running,
            committed_cli_session,
            audit,
        }
    }
}

pub fn seal_clear_session_commit(
    before: &BoundRuntimeControlSeat,
    committed: ClearSessionCommitReceipt,
) -> Result<ClearSessionOutcome, ClearSessionCommitMismatch> {
    let should_audit = before.was_running() || before.previous_cli_session().is_some();
    let expected_audit = if !should_audit {
        ClearSessionAuditWitness::None
    } else {
        match before.scope() {
            RuntimeScope::ConversationSlot { source, .. } => {
                ClearSessionAuditWitness::Conversation(source.clone())
            }
            RuntimeScope::AgentSlot { agent } => ClearSessionAuditWitness::Agent(agent.clone()),
        }
    };
    if committed.scope != *before.scope()
        || committed.generation != before.generation()
        || committed.previous_cli_session.as_ref() != before.previous_cli_session()
        || committed.was_running != before.was_running()
        || committed.committed_cli_session.is_some()
        || committed.audit != expected_audit
    {
        return Err(ClearSessionCommitMismatch);
    }
    Ok(ClearSessionOutcome::committed(
        committed.previous_cli_session,
        committed.was_running,
    ))
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, thiserror::Error)]
#[error("clear-session committed witness does not match the captured seat")]
pub struct ClearSessionCommitMismatch;

pub trait RuntimeControlSeatPort: Clone + Send + Sync + 'static {
    type Error: Error + Send + Sync + 'static;

    /// Read the durable seat for a row-owned scope. This is an unauthorized read,
    /// so it takes a bare [`RuntimeScope`] (a repository key), not the sealed
    /// target.
    fn snapshot(
        &self,
        scope: &RuntimeScope,
    ) -> impl Future<Output = Result<Option<RuntimeControlSeatSnapshot>, Self::Error>> + Send;

    /// Settle a durable clear against a captured seat. This is the sole durable
    /// mutation face, so it consumes the sealed [`RuntimeSeatTarget`]: a downstream
    /// crate can receive and read this type but cannot construct it, so it cannot
    /// reach a durable clear/audit without having passed admission. The adapter must
    /// exact-bind `target.scope() == before.scope()` (zero write on mismatch) and
    /// take the audit actor only from `target.actor()`.
    fn settle_clear(
        &self,
        target: &RuntimeSeatTarget,
        before: &BoundRuntimeControlSeat,
    ) -> impl Future<Output = Result<Option<ClearSessionCommitReceipt>, Self::Error>> + Send;
}

/// One request-scoped, consistent read snapshot.
///
/// The use case still asks each question separately and in published order, so
/// an early refusal does not touch later tables. A production SQLite adapter holds
/// one read transaction behind this scope; [`Self::finish`] completes its
/// asynchronous release before daemon work begins.
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

    /// The agent's immutable persisted session scope, or `None` when the agent
    /// row is absent. This is the sole authority for the seat arm: seat
    /// operations resolve their [`RuntimeScope`] from this row, never from a
    /// caller-selected coordinate.
    fn agent_session_scope(
        &mut self,
        agent: &AgentId,
    ) -> impl Future<Output = Result<Option<AgentSessionScope>, Self::Error>> + Send;

    /// Finish the consistent read and release its resources.
    ///
    /// This is deliberately product language rather than transaction language:
    /// adapters may use a database transaction, a snapshot handle, or another
    /// consistency mechanism. Consuming `self` prevents further reads.
    fn finish(self) -> impl Future<Output = Result<(), Self::Error>> + Send;
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
    /// The persisted session scope does not match the endpoint that was used: an
    /// agent-scoped endpoint was invoked for a conversation-scoped agent. Produced
    /// only by [`admit_agent_seat`]; never by a conversation operation or start.
    RuntimeScopeMismatch,
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
        target: &RuntimeStartTarget,
    ) -> impl Future<
        Output = Result<Result<StartRuntimeOutcome, StartRuntimeProviderRefusal>, Self::Error>,
    > + Send;

    fn hard_stop(
        &self,
        target: &RuntimeSeatTarget,
    ) -> impl Future<
        Output = Result<
            Result<HardStopRuntimeOutcome, HardStopRuntimeProviderRefusal>,
            Self::Error,
        >,
    > + Send;

    fn clear_session(
        &self,
        target: &RuntimeSeatTarget,
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

/// The five-question conversation ladder, run inside one consistent snapshot.
/// Used for a start intent (against its presentation origin) and for a
/// conversation-scoped seat operation (against the seat's source conversation).
async fn run_conversation_ladder<S: RuntimeControlAdmissionScope>(
    snapshot: &mut S,
    actor: &UserId,
    agent: &AgentId,
    conversation: &ConversationId,
) -> Result<Option<RuntimeControlAdmissionRefusal>, S::Error> {
    if !snapshot.conversation_exists(conversation).await? {
        return Ok(Some(RuntimeControlAdmissionRefusal::ConversationNotFound));
    }
    if !snapshot.agent_exists(agent).await? {
        return Ok(Some(RuntimeControlAdmissionRefusal::AgentNotFound));
    }
    if !snapshot.agent_is_member(conversation, agent).await? {
        return Ok(Some(RuntimeControlAdmissionRefusal::AgentNotMember));
    }
    if !snapshot.actor_may_post(conversation, actor).await? {
        return Ok(Some(RuntimeControlAdmissionRefusal::Forbidden));
    }
    if !snapshot.actor_may_edit_agent(actor, agent).await? {
        return Ok(Some(RuntimeControlAdmissionRefusal::Forbidden));
    }
    Ok(None)
}

/// The agent-scoped ladder: existence and edit authority only. It performs **zero**
/// conversation reads — an agent-scoped seat is conversation-independent, so no
/// membership or post authority over any conversation is consulted.
async fn run_agent_ladder<S: RuntimeControlAdmissionScope>(
    snapshot: &mut S,
    actor: &UserId,
    agent: &AgentId,
) -> Result<Option<RuntimeControlAdmissionRefusal>, S::Error> {
    if !snapshot.agent_exists(agent).await? {
        return Ok(Some(RuntimeControlAdmissionRefusal::AgentNotFound));
    }
    if !snapshot.actor_may_edit_agent(actor, agent).await? {
        return Ok(Some(RuntimeControlAdmissionRefusal::Forbidden));
    }
    Ok(None)
}

/// Finish the snapshot exactly once, preserving a query failure as the
/// authoritative cause while still awaiting release before any side effect.
async fn finish_with<S: RuntimeControlAdmissionScope, T>(
    snapshot: S,
    decision: Result<T, S::Error>,
) -> Result<T, S::Error> {
    match decision {
        Ok(decision) => {
            snapshot.finish().await?;
            Ok(decision)
        }
        Err(query_error) => {
            let _finish_result = snapshot.finish().await;
            Err(query_error)
        }
    }
}

/// Admit a start intent against its presentation origin. The scope arm is *not*
/// decided here — it is owned by the persisted agent row and resolved by the
/// dispatch provider. Admission only proves the actor may start this agent in
/// this conversation.
async fn admit_start<A: RuntimeControlAdmission>(
    admission: &A,
    target: &RuntimeStartTarget,
) -> Result<Option<RuntimeControlAdmissionRefusal>, A::Error> {
    let mut snapshot = admission.begin_snapshot().await?;
    let decision = run_conversation_ladder(
        &mut snapshot,
        target.actor(),
        target.agent(),
        target.presentation_origin(),
    )
    .await;
    finish_with(snapshot, decision).await
}

/// Admit a **conversation** seat operation. The admission ladder is chosen by the
/// endpoint, not by the persisted arm: the full five-question conversation ladder
/// always runs against the request conversation, whatever the agent's session
/// scope. Only after it passes does the immutable persisted `session_scope` decide
/// which seat the operation lands on — `ConversationSlot` sourced at this
/// conversation, or the agent's single `AgentSlot`. The returned [`RuntimeScope`]
/// is therefore a fact, never a caller selection.
async fn admit_conversation_seat<A: RuntimeControlAdmission>(
    admission: &A,
    actor: &UserId,
    agent: &AgentId,
    conversation: &ConversationId,
) -> Result<Result<RuntimeScope, RuntimeControlAdmissionRefusal>, A::Error> {
    let mut snapshot = admission.begin_snapshot().await?;
    let decision = async {
        if let Some(refusal) =
            run_conversation_ladder(&mut snapshot, actor, agent, conversation).await?
        {
            return Ok(Err(refusal));
        }
        // The ladder proved the agent row exists; the arm is owned solely by its
        // persisted session scope. A conversation-scoped agent lands on its
        // ConversationSlot sourced at this admitted conversation; an agent-scoped
        // agent lands on its single conversation-independent AgentSlot.
        match snapshot.agent_session_scope(agent).await? {
            None => Ok(Err(RuntimeControlAdmissionRefusal::AgentNotFound)),
            Some(AgentSessionScope::Conversation) => Ok(Ok(RuntimeScope::ConversationSlot {
                agent: agent.clone(),
                source: conversation.clone(),
            })),
            Some(AgentSessionScope::Agent) => Ok(Ok(RuntimeScope::AgentSlot {
                agent: agent.clone(),
            })),
        }
    }
    .await;
    finish_with(snapshot, decision).await
}

/// Admit an **agent** seat operation. The endpoint carries no conversation, so the
/// agent ladder runs with **zero** conversation reads (existence + edit only), and
/// the persisted session scope must be agent-scoped: a conversation-scoped agent
/// reached through an agent endpoint is refused [`RuntimeScopeMismatch`] with no
/// provider effect. The returned [`RuntimeScope`] is always the agent's single
/// `AgentSlot`.
async fn admit_agent_seat<A: RuntimeControlAdmission>(
    admission: &A,
    actor: &UserId,
    agent: &AgentId,
) -> Result<Result<RuntimeScope, RuntimeControlAdmissionRefusal>, A::Error> {
    let mut snapshot = admission.begin_snapshot().await?;
    let decision = async {
        if let Some(refusal) = run_agent_ladder(&mut snapshot, actor, agent).await? {
            return Ok(Err(refusal));
        }
        match snapshot.agent_session_scope(agent).await? {
            None => Ok(Err(RuntimeControlAdmissionRefusal::AgentNotFound)),
            Some(AgentSessionScope::Conversation) => {
                Ok(Err(RuntimeControlAdmissionRefusal::RuntimeScopeMismatch))
            }
            Some(AgentSessionScope::Agent) => Ok(Ok(RuntimeScope::AgentSlot {
                agent: agent.clone(),
            })),
        }
    }
    .await;
    finish_with(snapshot, decision).await
}

/// Run the ordered conversation-seat admission without constructing a provider
/// command.
///
/// The stop wire uses this only for a legacy body it must reject *after* the
/// published product checks. It returns no reusable capability: an admitted
/// result is merely `None`, and a real operation still performs its own fresh
/// snapshot before invoking the provider.
pub async fn check_runtime_control_admission<A: RuntimeControlAdmission>(
    admission: &A,
    actor: &UserId,
    agent: &AgentId,
    conversation: &ConversationId,
) -> Result<Option<RuntimeControlAdmissionRefusal>, A::Error> {
    Ok(
        admit_conversation_seat(admission, actor, agent, conversation)
            .await?
            .err(),
    )
}

pub async fn start_runtime<A, P>(
    admission: &A,
    provider: &P,
    target: RuntimeStartTarget,
) -> Result<
    Result<StartRuntimeOutcome, StartRuntimeRefusal>,
    RuntimeControlFailure<A::Error, P::Error>,
>
where
    A: RuntimeControlAdmission,
    P: RuntimeControlPort,
{
    if let Some(refusal) = admit_start(admission, &target)
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

pub async fn hard_stop_runtime<A, P>(
    admission: &A,
    provider: &P,
    actor: UserId,
    agent: AgentId,
    conversation: ConversationId,
) -> Result<
    Result<HardStopRuntimeOutcome, HardStopRuntimeRefusal>,
    RuntimeControlFailure<A::Error, P::Error>,
>
where
    A: RuntimeControlAdmission,
    P: RuntimeControlPort,
{
    let scope = match admit_conversation_seat(admission, &actor, &agent, &conversation)
        .await
        .map_err(RuntimeControlFailure::Admission)?
    {
        Ok(scope) => scope,
        Err(refusal) => return Ok(Err(HardStopRuntimeRefusal::Admission(refusal))),
    };
    let target = RuntimeSeatTarget::new(actor, scope);
    provider
        .hard_stop(&target)
        .await
        .map_err(RuntimeControlFailure::Provider)
        .map(|result| result.map_err(HardStopRuntimeRefusal::Provider))
}

/// Clear a runtime session through a **conversation** endpoint. Runs the full
/// conversation ladder, then acts on the row-owned seat.
pub async fn clear_conversation_session<A, P>(
    admission: &A,
    provider: &P,
    actor: UserId,
    agent: AgentId,
    conversation: ConversationId,
) -> Result<
    Result<ClearSessionOutcome, ClearSessionRefusal>,
    RuntimeControlFailure<A::Error, P::Error>,
>
where
    A: RuntimeControlAdmission,
    P: RuntimeControlPort,
{
    let scope = match admit_conversation_seat(admission, &actor, &agent, &conversation)
        .await
        .map_err(RuntimeControlFailure::Admission)?
    {
        Ok(scope) => scope,
        Err(refusal) => return Ok(Err(ClearSessionRefusal::Admission(refusal))),
    };
    clear_session_with_scope(provider, actor, scope).await
}

/// Clear a runtime session through an **agent** endpoint. Carries no conversation:
/// runs the agent ladder with zero conversation reads and requires an agent-scoped
/// row, then acts on the agent's single seat.
pub async fn clear_agent_session<A, P>(
    admission: &A,
    provider: &P,
    actor: UserId,
    agent: AgentId,
) -> Result<
    Result<ClearSessionOutcome, ClearSessionRefusal>,
    RuntimeControlFailure<A::Error, P::Error>,
>
where
    A: RuntimeControlAdmission,
    P: RuntimeControlPort,
{
    let scope = match admit_agent_seat(admission, &actor, &agent)
        .await
        .map_err(RuntimeControlFailure::Admission)?
    {
        Ok(scope) => scope,
        Err(refusal) => return Ok(Err(ClearSessionRefusal::Admission(refusal))),
    };
    clear_session_with_scope(provider, actor, scope).await
}

async fn clear_session_with_scope<E, P>(
    provider: &P,
    actor: UserId,
    scope: RuntimeScope,
) -> Result<
    Result<ClearSessionOutcome, ClearSessionRefusal>,
    RuntimeControlFailure<E, <P as RuntimeControlPort>::Error>,
>
where
    E: Error + Send + Sync + 'static,
    P: RuntimeControlPort,
{
    let target = RuntimeSeatTarget::new(actor, scope);
    provider
        .clear_session(&target)
        .await
        .map_err(RuntimeControlFailure::Provider)
        .map(|result| result.map_err(ClearSessionRefusal::Provider))
}

#[cfg(test)]
mod tests {
    use std::sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    };

    use super::*;

    #[test]
    fn clear_commit_receipt_cannot_mint_a_verdict_from_wrong_witnesses() {
        let target = RuntimeSeatTarget::new(
            UserId::parse("user-1").unwrap(),
            RuntimeScope::ConversationSlot {
                agent: AgentId::parse("agent-1").unwrap(),
                source: ConversationId::parse("conversation-1").unwrap(),
            },
        );
        let before = RuntimeControlSeatSnapshot::decoded(
            AgentId::parse("agent-1").unwrap(),
            HostId::parse("host-1").unwrap(),
            RuntimeScope::ConversationSlot {
                agent: AgentId::parse("agent-1").unwrap(),
                source: ConversationId::parse("conversation-1").unwrap(),
            },
            RuntimeGeneration::new(7).unwrap(),
            Some(DaemonInstanceId::parse("daemon-1").unwrap()),
            Some(CliSessionId::parse("session-1").unwrap()),
            RuntimeControlObservedStatus::Active,
            "agent".to_owned(),
        )
        .bind(target.scope())
        .unwrap();
        let receipt = |scope, generation, previous, was_running, committed, audit| {
            ClearSessionCommitReceipt::decoded(
                scope,
                generation,
                previous,
                was_running,
                committed,
                audit,
            )
        };
        assert!(
            seal_clear_session_commit(
                &before,
                receipt(
                    before.scope().clone(),
                    before.generation(),
                    before.previous_cli_session().cloned(),
                    true,
                    None,
                    ClearSessionAuditWitness::Conversation(
                        ConversationId::parse("conversation-1").unwrap(),
                    ),
                ),
            )
            .is_ok()
        );
        for corrupt in [
            receipt(
                RuntimeScope::AgentSlot {
                    agent: AgentId::parse("agent-1").unwrap(),
                },
                before.generation(),
                before.previous_cli_session().cloned(),
                true,
                None,
                ClearSessionAuditWitness::Conversation(
                    ConversationId::parse("conversation-1").unwrap(),
                ),
            ),
            receipt(
                before.scope().clone(),
                RuntimeGeneration::new(8).unwrap(),
                before.previous_cli_session().cloned(),
                true,
                None,
                ClearSessionAuditWitness::Conversation(
                    ConversationId::parse("conversation-1").unwrap(),
                ),
            ),
            receipt(
                before.scope().clone(),
                before.generation(),
                None,
                true,
                None,
                ClearSessionAuditWitness::Conversation(
                    ConversationId::parse("conversation-1").unwrap(),
                ),
            ),
            receipt(
                before.scope().clone(),
                before.generation(),
                before.previous_cli_session().cloned(),
                false,
                None,
                ClearSessionAuditWitness::Conversation(
                    ConversationId::parse("conversation-1").unwrap(),
                ),
            ),
            receipt(
                before.scope().clone(),
                before.generation(),
                before.previous_cli_session().cloned(),
                true,
                Some(CliSessionId::parse("still-present").unwrap()),
                ClearSessionAuditWitness::Conversation(
                    ConversationId::parse("conversation-1").unwrap(),
                ),
            ),
            receipt(
                before.scope().clone(),
                before.generation(),
                before.previous_cli_session().cloned(),
                true,
                None,
                ClearSessionAuditWitness::None,
            ),
        ] {
            assert!(seal_clear_session_commit(&before, corrupt).is_err());
        }
    }

    #[derive(Clone, Copy, Debug, Eq, PartialEq, thiserror::Error)]
    #[error("{0}")]
    struct Failure(&'static str);

    struct Admission {
        answers: [bool; 5],
        session_scope: Option<AgentSessionScope>,
        begin_error: Option<Failure>,
        query_error_at: Option<usize>,
        finish_error: Option<Failure>,
        calls: Arc<Mutex<Vec<&'static str>>>,
        finished: Arc<AtomicBool>,
    }

    struct Snapshot {
        answers: [bool; 5],
        session_scope: Option<AgentSessionScope>,
        query_error_at: Option<usize>,
        finish_error: Option<Failure>,
        calls: Arc<Mutex<Vec<&'static str>>>,
        finished: Arc<AtomicBool>,
    }

    impl Snapshot {
        fn answer(&self, index: usize, name: &'static str) -> Result<bool, Failure> {
            self.calls.lock().unwrap().push(name);
            if self.query_error_at == Some(index) {
                Err(Failure("query"))
            } else {
                Ok(self.answers[index])
            }
        }
    }

    impl RuntimeControlAdmission for Admission {
        type Error = Failure;
        type Scope = Snapshot;

        async fn begin_snapshot(&self) -> Result<Self::Scope, Self::Error> {
            self.finished.store(false, Ordering::Release);
            self.begin_error.map_or_else(
                || {
                    Ok(Snapshot {
                        answers: self.answers,
                        session_scope: self.session_scope,
                        query_error_at: self.query_error_at,
                        finish_error: self.finish_error,
                        calls: Arc::clone(&self.calls),
                        finished: Arc::clone(&self.finished),
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
            self.answer(0, "conversation")
        }

        async fn agent_exists(&mut self, _agent: &AgentId) -> Result<bool, Self::Error> {
            self.answer(1, "agent")
        }

        async fn agent_is_member(
            &mut self,
            _conversation: &ConversationId,
            _agent: &AgentId,
        ) -> Result<bool, Self::Error> {
            self.answer(2, "membership")
        }

        async fn actor_may_post(
            &mut self,
            _conversation: &ConversationId,
            _actor: &UserId,
        ) -> Result<bool, Self::Error> {
            self.answer(3, "post")
        }

        async fn actor_may_edit_agent(
            &mut self,
            _actor: &UserId,
            _agent: &AgentId,
        ) -> Result<bool, Self::Error> {
            self.answer(4, "edit")
        }

        async fn agent_session_scope(
            &mut self,
            _agent: &AgentId,
        ) -> Result<Option<AgentSessionScope>, Self::Error> {
            self.calls.lock().unwrap().push("session_scope");
            if self.query_error_at == Some(5) {
                Err(Failure("query"))
            } else {
                Ok(self.session_scope)
            }
        }

        async fn finish(self) -> Result<(), Self::Error> {
            self.calls.lock().unwrap().push("finish");
            self.finished.store(true, Ordering::Release);
            self.finish_error.map_or(Ok(()), Err)
        }
    }

    struct Provider {
        calls: Mutex<Vec<&'static str>>,
        fail: bool,
        admission_finished: Arc<AtomicBool>,
    }

    impl RuntimeControlPort for Provider {
        type Error = Failure;

        async fn start(
            &self,
            _target: &RuntimeStartTarget,
        ) -> Result<Result<StartRuntimeOutcome, StartRuntimeProviderRefusal>, Self::Error> {
            assert!(self.admission_finished.load(Ordering::Acquire));
            self.calls.lock().unwrap().push("start");
            if self.fail {
                Err(Failure("provider"))
            } else {
                Ok(Ok(StartRuntimeOutcome))
            }
        }

        async fn hard_stop(
            &self,
            _target: &RuntimeSeatTarget,
        ) -> Result<Result<HardStopRuntimeOutcome, HardStopRuntimeProviderRefusal>, Self::Error>
        {
            assert!(self.admission_finished.load(Ordering::Acquire));
            self.calls.lock().unwrap().push("hard_stop");
            if self.fail {
                Err(Failure("provider"))
            } else {
                Ok(Ok(HardStopRuntimeOutcome))
            }
        }

        async fn clear_session(
            &self,
            _target: &RuntimeSeatTarget,
        ) -> Result<Result<ClearSessionOutcome, ClearSessionProviderRefusal>, Self::Error> {
            assert!(self.admission_finished.load(Ordering::Acquire));
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
            session_scope: Some(AgentSessionScope::Conversation),
            begin_error: None,
            query_error_at: None,
            finish_error: None,
            calls: Arc::new(Mutex::new(Vec::new())),
            finished: Arc::new(AtomicBool::new(false)),
        }
    }

    fn provider(admission: &Admission, fail: bool) -> Provider {
        Provider {
            calls: Mutex::new(Vec::new()),
            fail,
            admission_finished: Arc::clone(&admission.finished),
        }
    }

    fn actor() -> UserId {
        UserId::parse("user-1").unwrap()
    }

    fn agent() -> AgentId {
        AgentId::parse("agent-1").unwrap()
    }

    fn convo() -> ConversationId {
        ConversationId::parse("conversation-1").unwrap()
    }

    fn start_target() -> RuntimeStartTarget {
        RuntimeStartTarget::new(actor(), agent(), convo())
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
            let provider = provider(&admission, false);
            assert_eq!(
                start_runtime(&admission, &provider, start_target())
                    .await
                    .unwrap(),
                Err(StartRuntimeRefusal::Admission(expected))
            );
            assert!(provider.calls.lock().unwrap().is_empty());
            assert!(admission.finished.load(Ordering::Acquire));
            assert_eq!(admission.calls.lock().unwrap().len(), refused_at + 2);
            assert_eq!(admission.calls.lock().unwrap().last(), Some(&"finish"));
        }
    }

    #[tokio::test]
    async fn each_operation_has_its_own_success_type() {
        let admission = admission([true; 5]);
        let provider = provider(&admission, false);
        assert_eq!(
            start_runtime(&admission, &provider, start_target())
                .await
                .unwrap(),
            Ok(StartRuntimeOutcome)
        );
        assert_eq!(
            hard_stop_runtime(&admission, &provider, actor(), agent(), convo())
                .await
                .unwrap(),
            Ok(HardStopRuntimeOutcome)
        );
        assert_eq!(
            clear_conversation_session(&admission, &provider, actor(), agent(), convo())
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
        struct Refusing(Arc<AtomicBool>);
        impl RuntimeControlPort for Refusing {
            type Error = Failure;

            async fn start(
                &self,
                _: &RuntimeStartTarget,
            ) -> Result<Result<StartRuntimeOutcome, StartRuntimeProviderRefusal>, Self::Error>
            {
                assert!(self.0.load(Ordering::Acquire));
                Ok(Err(StartRuntimeProviderRefusal::ShuttingDown))
            }

            async fn hard_stop(
                &self,
                _: &RuntimeSeatTarget,
            ) -> Result<Result<HardStopRuntimeOutcome, HardStopRuntimeProviderRefusal>, Self::Error>
            {
                assert!(self.0.load(Ordering::Acquire));
                Ok(Err(HardStopRuntimeProviderRefusal::Placement(
                    RuntimePlacementRefusal::HostAttachPending,
                )))
            }

            async fn clear_session(
                &self,
                _: &RuntimeSeatTarget,
            ) -> Result<Result<ClearSessionOutcome, ClearSessionProviderRefusal>, Self::Error>
            {
                assert!(self.0.load(Ordering::Acquire));
                Ok(Err(ClearSessionProviderRefusal::Timeout))
            }
        }

        let admission = admission([true; 5]);
        let refusing = Refusing(Arc::clone(&admission.finished));
        assert_eq!(
            start_runtime(&admission, &refusing, start_target())
                .await
                .unwrap(),
            Err(StartRuntimeRefusal::Provider(
                StartRuntimeProviderRefusal::ShuttingDown
            ))
        );
        assert_eq!(
            hard_stop_runtime(&admission, &refusing, actor(), agent(), convo())
                .await
                .unwrap(),
            Err(HardStopRuntimeRefusal::Provider(
                HardStopRuntimeProviderRefusal::Placement(
                    RuntimePlacementRefusal::HostAttachPending
                )
            ))
        );
        assert_eq!(
            clear_conversation_session(&admission, &refusing, actor(), agent(), convo())
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
            session_scope: Some(AgentSessionScope::Conversation),
            begin_error: Some(Failure("admission")),
            query_error_at: None,
            finish_error: None,
            calls: Arc::new(Mutex::new(Vec::new())),
            finished: Arc::new(AtomicBool::new(false)),
        };
        let error = start_runtime(&admission, &provider(&admission, false), start_target())
            .await
            .unwrap_err();
        assert_eq!(error.source().unwrap().to_string(), "admission");

        let admission = self::admission([true; 5]);
        let error = start_runtime(&admission, &provider(&admission, true), start_target())
            .await
            .unwrap_err();
        assert_eq!(error.source().unwrap().to_string(), "provider");
    }

    #[tokio::test]
    async fn query_and_finish_failures_never_reach_the_provider() {
        let mut query_admission = admission([true; 5]);
        query_admission.query_error_at = Some(2);
        let query_provider = provider(&query_admission, false);
        let error = start_runtime(&query_admission, &query_provider, start_target())
            .await
            .unwrap_err();
        assert_eq!(error.source().unwrap().to_string(), "query");
        assert!(query_admission.finished.load(Ordering::Acquire));
        assert!(query_provider.calls.lock().unwrap().is_empty());

        let mut finish_admission = admission([true; 5]);
        finish_admission.finish_error = Some(Failure("finish"));
        let finish_provider = provider(&finish_admission, false);
        let error = start_runtime(&finish_admission, &finish_provider, start_target())
            .await
            .unwrap_err();
        assert_eq!(error.source().unwrap().to_string(), "finish");
        assert!(finish_admission.finished.load(Ordering::Acquire));
        assert!(finish_provider.calls.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn agent_endpoint_reads_the_row_arm_and_consults_no_conversation() {
        let mut admission = admission([true; 5]);
        admission.session_scope = Some(AgentSessionScope::Agent);
        let provider = provider(&admission, false);
        assert_eq!(
            clear_agent_session(&admission, &provider, actor(), agent())
                .await
                .unwrap(),
            Ok(ClearSessionOutcome::committed(None, false))
        );
        // The agent endpoint carries no conversation: the agent ladder runs the
        // existence and edit questions only, then the row arm is read — never a
        // conversation existence/membership/post read.
        assert_eq!(
            admission.calls.lock().unwrap().as_slice(),
            ["agent", "edit", "session_scope", "finish"]
        );
    }

    #[tokio::test]
    async fn agent_endpoint_refuses_a_conversation_scoped_agent_with_zero_provider() {
        // A conversation-scoped agent reached through the conversation-less agent
        // endpoint is a scope mismatch: refuse with no provider effect.
        let admission = admission([true; 5]); // default session_scope = Conversation
        let provider = provider(&admission, false);
        assert_eq!(
            clear_agent_session(&admission, &provider, actor(), agent())
                .await
                .unwrap(),
            Err(ClearSessionRefusal::Admission(
                RuntimeControlAdmissionRefusal::RuntimeScopeMismatch
            ))
        );
        assert!(provider.calls.lock().unwrap().is_empty());
        assert_eq!(
            admission.calls.lock().unwrap().as_slice(),
            ["agent", "edit", "session_scope", "finish"]
        );
    }

    #[tokio::test]
    async fn conversation_endpoint_runs_the_full_ladder_whatever_the_row_arm() {
        // The endpoint — not the persisted arm — chooses the ladder. A
        // conversation-scoped agent lands on its ConversationSlot; an agent-scoped
        // agent reached through the same conversation endpoint STILL runs the full
        // conversation ladder and then lands on its AgentSlot.
        struct CapturingProvider {
            scope: Mutex<Option<RuntimeScope>>,
            finished: Arc<AtomicBool>,
        }
        impl RuntimeControlPort for CapturingProvider {
            type Error = Failure;

            async fn start(
                &self,
                _: &RuntimeStartTarget,
            ) -> Result<Result<StartRuntimeOutcome, StartRuntimeProviderRefusal>, Self::Error>
            {
                unreachable!("this test only clears")
            }

            async fn hard_stop(
                &self,
                _: &RuntimeSeatTarget,
            ) -> Result<Result<HardStopRuntimeOutcome, HardStopRuntimeProviderRefusal>, Self::Error>
            {
                unreachable!("this test only clears")
            }

            async fn clear_session(
                &self,
                target: &RuntimeSeatTarget,
            ) -> Result<Result<ClearSessionOutcome, ClearSessionProviderRefusal>, Self::Error>
            {
                assert!(self.finished.load(Ordering::Acquire));
                *self.scope.lock().unwrap() = Some(target.scope().clone());
                Ok(Ok(ClearSessionOutcome::committed(None, false)))
            }
        }

        for (arm, expected_scope) in [
            (
                AgentSessionScope::Conversation,
                RuntimeScope::ConversationSlot {
                    agent: agent(),
                    source: convo(),
                },
            ),
            (
                AgentSessionScope::Agent,
                RuntimeScope::AgentSlot { agent: agent() },
            ),
        ] {
            let mut admission = admission([true; 5]);
            admission.session_scope = Some(arm);
            let provider = CapturingProvider {
                scope: Mutex::new(None),
                finished: Arc::clone(&admission.finished),
            };
            assert!(
                clear_conversation_session(&admission, &provider, actor(), agent(), convo())
                    .await
                    .unwrap()
                    .is_ok()
            );
            assert_eq!(
                admission.calls.lock().unwrap().as_slice(),
                [
                    "conversation",
                    "agent",
                    "membership",
                    "post",
                    "edit",
                    "session_scope",
                    "finish"
                ]
            );
            assert_eq!(
                provider.scope.lock().unwrap().as_ref(),
                Some(&expected_scope)
            );
        }
    }

    #[tokio::test]
    async fn a_conversation_operation_on_an_absent_agent_refuses_before_any_side_effect() {
        // The endpoint's own ladder owns existence: an absent agent fails the
        // ladder's agent-existence question, so the row arm is never consulted.
        let mut answers = [true; 5];
        answers[1] = false; // agent_exists
        let admission = admission(answers);
        let provider = provider(&admission, false);
        assert_eq!(
            hard_stop_runtime(&admission, &provider, actor(), agent(), convo())
                .await
                .unwrap(),
            Err(HardStopRuntimeRefusal::Admission(
                RuntimeControlAdmissionRefusal::AgentNotFound
            ))
        );
        assert!(provider.calls.lock().unwrap().is_empty());
        assert_eq!(
            admission.calls.lock().unwrap().as_slice(),
            ["conversation", "agent", "finish"]
        );
    }

    #[tokio::test]
    async fn seat_bind_rejects_a_mismatched_arm_without_a_none_source_hole() {
        // A live ConversationSlot seat must never bind to an AgentSlot target, even
        // though the agent id matches — the old `source().is_none_or` hole let any
        // conversation through. Exact scope equality closes it.
        let snapshot = || {
            RuntimeControlSeatSnapshot::decoded(
                AgentId::parse("agent-1").unwrap(),
                HostId::parse("host-1").unwrap(),
                RuntimeScope::ConversationSlot {
                    agent: AgentId::parse("agent-1").unwrap(),
                    source: ConversationId::parse("conversation-1").unwrap(),
                },
                RuntimeGeneration::new(1).unwrap(),
                None,
                None,
                RuntimeControlObservedStatus::Active,
                "agent".to_owned(),
            )
        };
        let agent_arm = RuntimeScope::AgentSlot {
            agent: AgentId::parse("agent-1").unwrap(),
        };
        assert_eq!(
            snapshot().bind(&agent_arm).unwrap_err(),
            RuntimeControlSeatMismatch
        );
        // The wrong conversation is likewise rejected.
        let other_conversation = RuntimeScope::ConversationSlot {
            agent: AgentId::parse("agent-1").unwrap(),
            source: ConversationId::parse("conversation-2").unwrap(),
        };
        assert_eq!(
            snapshot().bind(&other_conversation).unwrap_err(),
            RuntimeControlSeatMismatch
        );
        // The exact scope binds.
        let exact = RuntimeScope::ConversationSlot {
            agent: AgentId::parse("agent-1").unwrap(),
            source: ConversationId::parse("conversation-1").unwrap(),
        };
        assert!(snapshot().bind(&exact).is_ok());
    }
}
