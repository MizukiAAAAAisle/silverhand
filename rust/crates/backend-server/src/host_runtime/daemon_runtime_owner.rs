//! Runtime-context ownership behind the daemon transport's narrow ports.

use std::{
    collections::HashSet,
    error::Error,
    fmt,
    future::Future,
    pin::Pin,
    time::{Duration, SystemTime},
};

use serde::Deserialize;
use serde_json::{Value, json};
use silverhand_backend_core::{
    conversation_messaging::runtime_delivery::{
        DeliveryLeaseOwner, InboxDeliveryId, RuntimeDeliveryFailureReason, RuntimeDispatchReadPort,
        RuntimeDispatchTarget, RuntimeInboxCustodyPort,
    },
    foundation::identity::{AgentId, ConversationId, DaemonInstanceId},
    foundation::persistence::PersistenceFailure,
    host_runtime::runtime_credential::{
        RuntimeCustody, RuntimeEventTime, RuntimeFinalStatus, RuntimeGeneration, RuntimePrincipal,
        RuntimeScope,
    },
    host_runtime::runtime_event::{
        CommitRuntimeConsumed, DaemonEventDurablePort, RuntimeEventAdmission,
    },
};

use crate::{
    daemon_events::{
        AgentRunStateWire, ConversationAgentRunStateSnapshot, DaemonRuntimeEventError,
        DaemonRuntimeEventOwner, HostRuntimeActivitySource, HydratedRuntime, RuntimeEventDirective,
        RuntimeProductEvent, decode_product_event,
    },
    foundation::error,
    foundation::{
        daemon_command as command,
        daemon_transport::{
            AttachedHostDataPlane, DaemonOwnerFailure, DaemonRuntimeEventDisposition,
            DaemonRuntimeEventEffects, DaemonRuntimeHydration, OwningHostDataPlane,
        },
    },
    host_runtime::daemon_runtime_transport::{
        DeliveryTransport, DeliveryTransportError, StartTransport, StopTransport,
    },
    host_runtime::scope_event_publishers::HubHostRuntimeEvents,
    runtime_control::RuntimeClearSessionWaiters,
    runtime_credential::{RuntimeCredentialAuthority, RuntimeStartFailure, RuntimeStopTransport},
};

enum DecodedRuntimeInboundEvent {
    DeliveryConsumed(DeliveryEvent),
    DeliveryFailed(FailedDeliveryEvent),
    RuntimeExit(RuntimeExitEvent),
    Product(RuntimeProductEvent),
}

fn decode_runtime_inbound_event(
    kind: &str,
    value: &Value,
) -> Result<DecodedRuntimeInboundEvent, RuntimeInboundDecodeError> {
    match kind {
        "runtime_delivery_consumed" => {
            decode_delivery_event(value).map(DecodedRuntimeInboundEvent::DeliveryConsumed)
        }
        "runtime_delivery_failed" => {
            decode_failed_delivery_event(value).map(DecodedRuntimeInboundEvent::DeliveryFailed)
        }
        "runtime_exit" => {
            decode_runtime_exit_event(value).map(DecodedRuntimeInboundEvent::RuntimeExit)
        }
        _ => decode_product_event(kind, value)
            .map(DecodedRuntimeInboundEvent::Product)
            .map_err(|_| RuntimeInboundDecodeError),
    }
}

#[cfg(test)]
pub(crate) fn runtime_inbound_is_valid_for_test(kind: &str, value: &Value) -> bool {
    decode_runtime_inbound_event(kind, value).is_ok()
}

fn decode_delivery_event(value: &Value) -> Result<DeliveryEvent, RuntimeInboundDecodeError> {
    if !exact_keys(
        value,
        &[
            "direction",
            "type",
            "kind",
            "runtime_scope",
            "conversation_id",
            "agent_id",
            "runtime_generation",
            "delivery_ids",
            "ts",
        ],
    ) || !valid_runtime_coordinate(value)
        || !valid_delivery_ids(value)
    {
        return Err(RuntimeInboundDecodeError);
    }
    serde_json::from_value(value.clone()).map_err(|_| RuntimeInboundDecodeError)
}

fn decode_failed_delivery_event(
    value: &Value,
) -> Result<FailedDeliveryEvent, RuntimeInboundDecodeError> {
    if !exact_keys(
        value,
        &[
            "direction",
            "type",
            "kind",
            "runtime_scope",
            "conversation_id",
            "agent_id",
            "runtime_generation",
            "delivery_ids",
            "reason",
            "ts",
        ],
    ) || !valid_runtime_coordinate(value)
        || !valid_delivery_ids(value)
    {
        return Err(RuntimeInboundDecodeError);
    }
    serde_json::from_value(value.clone()).map_err(|_| RuntimeInboundDecodeError)
}

fn decode_runtime_exit_event(value: &Value) -> Result<RuntimeExitEvent, RuntimeInboundDecodeError> {
    if !exact_keys(
        value,
        &[
            "direction",
            "type",
            "kind",
            "runtime_scope",
            "conversation_id",
            "agent_id",
            "runtime_generation",
            "code",
            "intentional",
            "ts",
        ],
    ) || !valid_runtime_coordinate(value)
        || !value
            .get("code")
            .is_some_and(|code| code.is_null() || code.as_i64().is_some())
        || value.get("intentional").and_then(Value::as_bool).is_none()
    {
        return Err(RuntimeInboundDecodeError);
    }
    serde_json::from_value(value.clone()).map_err(|_| RuntimeInboundDecodeError)
}

fn exact_keys(value: &Value, expected: &[&str]) -> bool {
    let Some(object) = value.as_object() else {
        return false;
    };
    object.len() == expected.len() && expected.iter().all(|key| object.contains_key(*key))
}

fn valid_runtime_coordinate(value: &Value) -> bool {
    let conversation = value
        .get("conversation_id")
        .and_then(Value::as_str)
        .is_some_and(|id| !id.is_empty());
    let agent = value
        .get("agent_id")
        .and_then(Value::as_str)
        .is_some_and(|id| !id.is_empty());
    let generation = value
        .get("runtime_generation")
        .and_then(Value::as_i64)
        .is_some_and(|generation| generation > 0);
    let timestamp = value.get("ts").and_then(Value::as_i64).is_some();
    let scope = value.get("runtime_scope");
    conversation
        && agent
        && generation
        && timestamp
        && scope.is_some_and(|scope| match scope.get("kind").and_then(Value::as_str) {
            Some("conversation") => {
                exact_keys(scope, &["kind", "conversation_id", "agent_id"])
                    && scope
                        .get("conversation_id")
                        .and_then(Value::as_str)
                        .is_some_and(|id| !id.is_empty())
                    && scope
                        .get("agent_id")
                        .and_then(Value::as_str)
                        .is_some_and(|id| !id.is_empty())
            }
            Some("agent") => {
                exact_keys(scope, &["kind", "agent_id"])
                    && scope
                        .get("agent_id")
                        .and_then(Value::as_str)
                        .is_some_and(|id| !id.is_empty())
            }
            _ => false,
        })
}

fn valid_delivery_ids(value: &Value) -> bool {
    value
        .get("delivery_ids")
        .and_then(Value::as_array)
        .is_some_and(|ids| !ids.is_empty() && ids.iter().all(|id| id.as_i64().is_some()))
}

#[derive(Debug)]
struct RuntimeInboundDecodeError;

#[derive(Deserialize)]
struct DeliveryEvent {
    runtime_scope: RuntimeScopeWire,
    conversation_id: String,
    agent_id: String,
    runtime_generation: i64,
    delivery_ids: Vec<i64>,
    ts: i64,
}

impl DeliveryEvent {
    fn principal(&self, daemon: DaemonInstanceId) -> Result<RuntimePrincipal, EventIdentityError> {
        principal_from_wire(
            &self.runtime_scope,
            &self.conversation_id,
            &self.agent_id,
            self.runtime_generation,
            daemon,
        )
    }

    fn conversation(&self) -> Result<ConversationId, EventIdentityError> {
        ConversationId::parse(self.conversation_id.clone()).map_err(|_| EventIdentityError)
    }
}

#[derive(Deserialize)]
struct RuntimeExitEvent {
    runtime_scope: RuntimeScopeWire,
    conversation_id: String,
    agent_id: String,
    runtime_generation: i64,
    code: Option<i64>,
    intentional: bool,
    ts: i64,
}

impl RuntimeExitEvent {
    fn principal(&self, daemon: DaemonInstanceId) -> Result<RuntimePrincipal, EventIdentityError> {
        principal_from_wire(
            &self.runtime_scope,
            &self.conversation_id,
            &self.agent_id,
            self.runtime_generation,
            daemon,
        )
    }

    fn conversation(&self) -> Result<ConversationId, EventIdentityError> {
        ConversationId::parse(self.conversation_id.clone()).map_err(|_| EventIdentityError)
    }
}

fn principal_from_wire(
    runtime_scope: &RuntimeScopeWire,
    conversation_id: &str,
    agent_id: &str,
    runtime_generation: i64,
    daemon: DaemonInstanceId,
) -> Result<RuntimePrincipal, EventIdentityError> {
    let agent = AgentId::parse(agent_id).map_err(|_| EventIdentityError)?;
    let conversation = ConversationId::parse(conversation_id).map_err(|_| EventIdentityError)?;
    let generation = RuntimeGeneration::new(runtime_generation).map_err(|_| EventIdentityError)?;
    let scope = match runtime_scope {
        RuntimeScopeWire::Conversation {
            conversation_id: source,
            agent_id: scope_agent,
        } => {
            if source != conversation_id || scope_agent != agent_id {
                return Err(EventIdentityError);
            }
            RuntimeScope::ConversationSlot {
                agent,
                source: conversation,
            }
        }
        RuntimeScopeWire::Agent {
            agent_id: scope_agent,
        } => {
            if scope_agent != agent_id {
                return Err(EventIdentityError);
            }
            RuntimeScope::AgentSlot { agent }
        }
    };
    Ok(RuntimePrincipal::for_scope(
        scope,
        RuntimeCustody::new(generation, daemon),
    ))
}

#[derive(Deserialize)]
struct FailedDeliveryEvent {
    #[serde(flatten)]
    base: DeliveryEvent,
    reason: RuntimeDeliveryFailureReasonWire,
}

impl FailedDeliveryEvent {
    fn into_parts(self) -> (DeliveryEvent, RuntimeDeliveryFailureReason) {
        (self.base, self.reason.into())
    }
}

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "snake_case")]
enum RuntimeDeliveryFailureReasonWire {
    ChildExit,
    InitWatchdog,
    WriteFailed,
    DriverRefused,
}

impl From<RuntimeDeliveryFailureReasonWire> for RuntimeDeliveryFailureReason {
    fn from(value: RuntimeDeliveryFailureReasonWire) -> Self {
        match value {
            RuntimeDeliveryFailureReasonWire::ChildExit => Self::ChildExit,
            RuntimeDeliveryFailureReasonWire::InitWatchdog => Self::InitWatchdog,
            RuntimeDeliveryFailureReasonWire::WriteFailed => Self::WriteFailed,
            RuntimeDeliveryFailureReasonWire::DriverRefused => Self::DriverRefused,
        }
    }
}

#[derive(Clone, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
enum RuntimeScopeWire {
    Conversation {
        conversation_id: String,
        agent_id: String,
    },
    Agent {
        agent_id: String,
    },
}

#[derive(Debug)]
struct EventIdentityError;

impl fmt::Display for EventIdentityError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("daemon delivery event identity is invalid")
    }
}

impl Error for EventIdentityError {}

#[derive(Clone)]
pub(crate) struct DaemonRuntimeOwner<C, D> {
    credentials: RuntimeCredentialAuthority<C>,
    data: D,
    events: DaemonRuntimeEventOwner<D>,
    clear_session_waiters: RuntimeClearSessionWaiters,
    data_plane: OwningHostDataPlane,
    command_timeout: Duration,
    lease_ttl_ms: i64,
}

impl<C, D> DaemonRuntimeOwner<C, D> {
    pub(crate) fn credentials(&self) -> RuntimeCredentialAuthority<C>
    where
        C: Clone,
    {
        self.credentials.clone()
    }

    pub(crate) fn data(&self) -> D
    where
        D: Clone,
    {
        self.data.clone()
    }

    pub(crate) fn clear_session_waiters(&self) -> RuntimeClearSessionWaiters {
        self.clear_session_waiters.clone()
    }

    pub(crate) fn host_runtime_activity(&self) -> HostRuntimeActivitySource {
        self.events.host_runtime_activity()
    }

    pub(crate) fn publish_host_connection_changed(
        &self,
        owner: &silverhand_backend_core::foundation::identity::UserId,
        host: &silverhand_backend_core::foundation::identity::HostId,
    ) -> Result<(), DaemonRuntimeEventError> {
        self.events.publish_host_connection_changed(owner, host)
    }

    pub(crate) fn conversation_run_states(
        &self,
        conversation: &ConversationId,
    ) -> Result<Vec<ConversationAgentRunStateSnapshot>, DaemonRuntimeEventError> {
        self.events.conversation_run_states(conversation)
    }

    #[cfg(test)]
    pub(crate) async fn hydrate_run_states_for_test(
        &self,
        host: &str,
        daemon: &DaemonInstanceId,
        connection_id: &str,
        active_agents: HashSet<AgentId>,
        runtimes: Vec<HydratedRuntime>,
    ) -> Result<(), DaemonRuntimeEventError>
    where
        D: DaemonEventDurablePort,
    {
        self.events
            .hydrate(host, daemon, connection_id, active_agents, runtimes)
            .await
    }
}

impl<C, D> DaemonRuntimeOwner<C, D>
where
    C: silverhand_backend_core::host_runtime::runtime_credential::RuntimeCustodyPort,
    D: RuntimeDispatchReadPort + RuntimeInboxCustodyPort + DaemonEventDurablePort,
{
    pub(crate) fn new(
        credentials: RuntimeCredentialAuthority<C>,
        data: D,
        event_hub: HubHostRuntimeEvents,
        data_plane: OwningHostDataPlane,
        command_timeout: Duration,
        lease_ttl_ms: i64,
    ) -> Self {
        Self {
            credentials,
            events: DaemonRuntimeEventOwner::new(data.clone(), event_hub),
            clear_session_waiters: RuntimeClearSessionWaiters::default(),
            data,
            data_plane,
            command_timeout,
            lease_ttl_ms,
        }
    }

    async fn resolve_target(
        &self,
        conversation: &ConversationId,
        agent: &AgentId,
    ) -> Result<RuntimeDispatchTarget, DaemonDeliveryError> {
        self.data
            .resolve_dispatch_target(conversation.clone(), agent.clone())
            .await?
            .ok_or(DaemonDeliveryError::TargetMissing)
    }

    pub(crate) async fn start(
        &self,
        conversation: &ConversationId,
        agent: &AgentId,
    ) -> Result<(), DaemonDeliveryError> {
        let target = self.resolve_target(conversation, agent).await?;
        let custody = self
            .data_plane
            .capture_attached(&target.host_id)?
            .ok_or(DaemonDeliveryError::HostNotAttached)?;
        let daemon_instance = custody.daemon_instance().clone();
        let transport = StartTransport::new(custody, target.clone(), self.command_timeout);
        self.credentials
            .dispatch_start(
                target.plan.scope.clone(),
                daemon_instance,
                target.conversation.clone(),
                &transport,
            )
            .await
            .map(|_| ())
            .map_err(DaemonDeliveryError::start)
    }

    pub(crate) async fn start_if_idle(
        &self,
        conversation: &ConversationId,
        agent: &AgentId,
    ) -> Result<(), DaemonDeliveryError> {
        let target = self.resolve_target(conversation, agent).await?;
        if self
            .credentials
            .current(target.plan.scope.clone())
            .await?
            .is_some()
        {
            return Ok(());
        }
        self.start(conversation, agent).await
    }

    pub(crate) async fn deliver(
        &self,
        conversation: &ConversationId,
        agent: &AgentId,
    ) -> Result<(), DaemonDeliveryError> {
        let target = self.resolve_target(conversation, agent).await?;
        let custody = self
            .data_plane
            .capture_attached(&target.host_id)?
            .ok_or(DaemonDeliveryError::HostNotAttached)?;
        let daemon_instance = custody.daemon_instance().clone();
        let transport = DeliveryTransport::new(
            custody,
            target.clone(),
            self.data.clone(),
            self.command_timeout,
            self.lease_ttl_ms,
        );
        match self
            .credentials
            .dispatch_start(
                target.plan.scope.clone(),
                daemon_instance,
                target.conversation.clone(),
                &transport,
            )
            .await
        {
            Ok(_) => Ok(()),
            Err(RuntimeStartFailure::ProvenNotDispatched(DeliveryTransportError::NoPending)) => {
                Ok(())
            }
            Err(error) => Err(DaemonDeliveryError::delivery(error)),
        }
    }

    async fn hydrate_captured(
        &self,
        plane: AttachedHostDataPlane,
    ) -> Result<(), DaemonDeliveryError> {
        let result = plane
            .dispatch(command::runtime_status(json!({})), self.command_timeout)
            .await
            .map_err(|source| DaemonDeliveryError::Hydration(Box::new(source)))?;
        let status = RuntimeStatusResult::decode(result)
            .map_err(|source| DaemonDeliveryError::Hydration(Box::new(source)))?;
        let hydrated = status
            .hydrated(plane.daemon_instance().clone())
            .map_err(|source| DaemonDeliveryError::Hydration(Box::new(source)))?;
        let persisted = self
            .data
            .current_custodies_for_host(plane.host_id().to_owned())
            .await?;
        let active = status
            .active_principals(plane.daemon_instance().clone())
            .map_err(|source| DaemonDeliveryError::Hydration(Box::new(source)))?;
        let active_set = active.iter().cloned().collect::<HashSet<_>>();
        self.events
            .hydrate(
                plane.host_id(),
                plane.daemon_instance(),
                plane.connection_id(),
                active_set
                    .iter()
                    .map(|principal| principal.agent().clone())
                    .collect(),
                hydrated,
            )
            .await
            .map_err(|source| DaemonDeliveryError::Hydration(Box::new(source)))?;
        let persisted_set = persisted.iter().cloned().collect::<HashSet<_>>();
        let stop = StopTransport::new(plane, self.command_timeout);
        for principal in active {
            if persisted_set.contains(&principal) {
                self.credentials
                    .reconcile_hydrated(principal, &stop)
                    .await
                    .map_err(|source| DaemonDeliveryError::Hydration(Box::new(source)))?;
            } else {
                stop.stop_exact(&principal)
                    .await
                    .map_err(|source| DaemonDeliveryError::Hydration(Box::new(source)))?;
            }
        }
        for principal in persisted {
            if !active_set.contains(&principal) {
                self.credentials
                    .finalize(principal, RuntimeFinalStatus::Crashed)
                    .await?;
            }
        }
        Ok(())
    }

    async fn settle_event(
        &self,
        host_id: &str,
        connection_id: &str,
        daemon: &DaemonInstanceId,
        event: DeliveryEvent,
        failure: Option<RuntimeDeliveryFailureReason>,
    ) {
        let principal = match event.principal(daemon.clone()) {
            Ok(principal) => principal,
            Err(cause) => {
                tracing::error!(error_chain = %error::describe(&cause), "daemon delivery event identity decode failed");
                return;
            }
        };
        let owner = match DeliveryLeaseOwner::parse(connection_id.to_owned()) {
            Ok(owner) => owner,
            Err(cause) => {
                tracing::error!(error_chain = %error::describe(&cause), "daemon delivery owner decode failed");
                return;
            }
        };
        let conversation = match event.conversation() {
            Ok(conversation) => conversation,
            Err(cause) => {
                tracing::error!(error_chain = %error::describe(&cause), "daemon delivery conversation decode failed");
                return;
            }
        };
        let ids = match event
            .delivery_ids
            .into_iter()
            .map(InboxDeliveryId::parse)
            .collect::<Result<Vec<_>, _>>()
        {
            Ok(ids) => ids,
            Err(cause) => {
                tracing::error!(error_chain = %error::describe(&cause), "daemon delivery ids decode failed");
                return;
            }
        };
        let result = if let Some(reason) = failure {
            self.data
                .settle_failed(
                    host_id.to_owned(),
                    principal,
                    conversation,
                    owner,
                    ids,
                    reason,
                    event.ts,
                )
                .await
        } else {
            self.data
                .settle_consumed(
                    host_id.to_owned(),
                    principal,
                    conversation,
                    owner,
                    ids,
                    event.ts,
                )
                .await
        };
        if let Err(cause) = result {
            tracing::error!(error_chain = %error::describe(&cause), "daemon delivery settlement failed");
        }
    }

    async fn commit_consumed_event(
        &self,
        host_id: &str,
        connection_id: &str,
        daemon: &DaemonInstanceId,
        event: DeliveryEvent,
    ) {
        let principal = match event.principal(daemon.clone()) {
            Ok(principal) => principal,
            Err(cause) => {
                tracing::error!(error_chain = %error::describe(&cause), "daemon consumed event identity decode failed");
                return;
            }
        };
        let owner = match DeliveryLeaseOwner::parse(connection_id.to_owned()) {
            Ok(owner) => owner,
            Err(cause) => {
                tracing::error!(error_chain = %error::describe(&cause), "daemon consumed event owner decode failed");
                return;
            }
        };
        let conversation = match event.conversation() {
            Ok(conversation) => conversation,
            Err(cause) => {
                tracing::error!(error_chain = %error::describe(&cause), "daemon consumed event conversation decode failed");
                return;
            }
        };
        let delivery_count = event.delivery_ids.len();
        let delivery_ids = match event
            .delivery_ids
            .into_iter()
            .map(InboxDeliveryId::parse)
            .collect::<Result<Vec<_>, _>>()
        {
            Ok(ids) => ids,
            Err(cause) => {
                tracing::error!(error_chain = %error::describe(&cause), "daemon consumed event ids decode failed");
                return;
            }
        };
        let agent = principal.agent().clone();
        let observed_at = event.ts;
        let result = self
            .events
            .durable()
            .commit_consumed(CommitRuntimeConsumed::new(
                RuntimeEventAdmission::new(host_id.to_owned(), principal),
                conversation.clone(),
                owner,
                delivery_ids,
                RuntimeEventTime::from_unix_millis(observed_at),
                RuntimeEventTime::from_unix_millis(signed_unix_millis(SystemTime::now())),
            ))
            .await;
        match result {
            Ok(result)
                if result.disposition()
                    == silverhand_backend_core::conversation_messaging::runtime_delivery::InboxSettlementDisposition::Applied =>
            {
                if let Some(activity_id) = result.activity_id()
                    && let Err(cause) = self.events.complete_consumed(
                        &conversation,
                        &agent,
                        result.presence_viewers(),
                        observed_at,
                        delivery_count,
                        activity_id,
                    )
                {
                    tracing::error!(error_chain = %error::describe(&cause), "daemon consumed live projection failed after durable commit");
                }
            }
            Ok(_) => {}
            Err(cause) => tracing::error!(error_chain = %error::describe(&cause), "daemon consumed durable commit failed"),
        }
    }

    async fn finalize_runtime_event(
        &self,
        host_id: &str,
        connection_id: &str,
        daemon: &DaemonInstanceId,
        event: RuntimeExitEvent,
    ) {
        let principal = match event.principal(daemon.clone()) {
            Ok(principal) => principal,
            Err(cause) => {
                tracing::error!(error_chain = %error::describe(&cause), "daemon runtime exit identity decode failed");
                return;
            }
        };
        let conversation = match event.conversation() {
            Ok(conversation) => conversation,
            Err(cause) => {
                tracing::error!(error_chain = %error::describe(&cause), "daemon runtime exit coordinate decode failed");
                return;
            }
        };
        let commit = match self.events.prepare_exit(
            host_id,
            principal.clone(),
            conversation.clone(),
            event.code,
            event.intentional,
            event.ts,
        ) {
            Ok(commit) => commit,
            Err(cause) => {
                tracing::error!(error_chain = %error::describe(&cause), observed_at = event.ts, "daemon runtime exit preparation failed");
                return;
            }
        };
        let admission = commit.admission().clone();
        match self
            .credentials
            .commit_daemon_exit(self.events.durable(), commit)
            .await
        {
            Ok(result) => {
                if result.disposition()
                    == silverhand_backend_core::host_runtime::runtime_event::RuntimeExitDisposition::Applied
                {
                    self.clear_session_waiters.notify_exit(&principal);
                }
                match self.events.complete_exit_state(
                    &admission,
                    connection_id,
                    &result,
                    conversation,
                    event.code,
                    event.intentional,
                ) {
                    Ok(Some(effect)) => {
                        if let Err(cause) = self.events.publish_exit(&effect) {
                            tracing::error!(error_chain = %error::describe(&cause), observed_at = event.ts, "daemon runtime exit live projection failed after durable commit");
                        }
                        if effect.should_respawn() {
                            let owner = self.clone();
                            let conversation = effect.conversation().clone();
                            let agent = effect.agent().clone();
                            let observed_at = event.ts;
                            tokio::spawn(async move {
                                if let Err(cause) = owner.deliver(&conversation, &agent).await {
                                    tracing::error!(error_chain = %error::describe(&cause), observed_at, "daemon runtime exit pending-inbox respawn failed");
                                }
                            });
                        }
                    }
                    Ok(None) => {}
                    Err(cause) => {
                        tracing::error!(error_chain = %error::describe(&cause), observed_at = event.ts, "daemon runtime exit process-state cleanup failed after durable commit")
                    }
                }
            }
            Err(cause) => {
                tracing::error!(error_chain = %error::describe(&cause), observed_at = event.ts, "daemon runtime exit durable commit failed")
            }
        }
    }

    async fn handle_product(
        &self,
        host_id: &str,
        connection_id: &str,
        daemon: &DaemonInstanceId,
        event: RuntimeProductEvent,
    ) -> DaemonRuntimeEventDisposition {
        match self
            .events
            .handle(host_id, daemon, connection_id, event)
            .await
        {
            Ok(RuntimeEventDirective::None) => DaemonRuntimeEventDisposition::Continue,
            Ok(RuntimeEventDirective::Drain {
                conversation,
                agent,
                post_commit_failure,
            }) => {
                let owner = self.clone();
                tokio::spawn(async move {
                    if let Err(cause) = owner.deliver(&conversation, &agent).await {
                        tracing::error!(error_chain = %error::describe(&cause), "daemon runtime drain effect failed");
                    }
                    if let Some(cause) = post_commit_failure {
                        tracing::error!(error_chain = %error::describe(&cause), "daemon runtime live projection failed after durable commit");
                    }
                });
                DaemonRuntimeEventDisposition::Continue
            }
            Err(DaemonRuntimeEventError::StaleRuntime) => {
                tracing::warn!("dropped stale daemon runtime event");
                DaemonRuntimeEventDisposition::Continue
            }
            Err(cause) => {
                tracing::error!(error_chain = %error::describe(&cause), "daemon runtime event owner failed");
                DaemonRuntimeEventDisposition::Close {
                    code: 1011,
                    reason: "runtime_event_owner_failed",
                }
            }
        }
    }
}

impl<C, D> DaemonRuntimeHydration for DaemonRuntimeOwner<C, D>
where
    C: silverhand_backend_core::host_runtime::runtime_credential::RuntimeCustodyPort,
    D: RuntimeDispatchReadPort + RuntimeInboxCustodyPort + DaemonEventDurablePort,
{
    fn hydrate<'a>(
        &'a self,
        plane: AttachedHostDataPlane,
    ) -> Pin<Box<dyn Future<Output = Result<(), DaemonOwnerFailure>> + Send + 'a>> {
        Box::pin(async move {
            self.hydrate_captured(plane)
                .await
                .map_err(|error| Box::new(error) as DaemonOwnerFailure)
        })
    }
}

impl<C, D> DaemonRuntimeEventEffects for DaemonRuntimeOwner<C, D>
where
    C: silverhand_backend_core::host_runtime::runtime_credential::RuntimeCustodyPort,
    D: RuntimeDispatchReadPort + RuntimeInboxCustodyPort + DaemonEventDurablePort,
{
    fn handle<'a>(
        &'a self,
        host_id: &'a str,
        connection_id: &'a str,
        daemon: &'a DaemonInstanceId,
        kind: String,
        value: Value,
    ) -> Pin<Box<dyn Future<Output = DaemonRuntimeEventDisposition> + Send + 'a>> {
        Box::pin(async move {
            let event = match decode_runtime_inbound_event(&kind, &value) {
                Ok(event) => event,
                Err(_) => {
                    return DaemonRuntimeEventDisposition::Close {
                        code: 1002,
                        reason: "invalid_daemon_frame",
                    };
                }
            };
            match event {
                DecodedRuntimeInboundEvent::DeliveryConsumed(event) => {
                    self.commit_consumed_event(host_id, connection_id, daemon, event)
                        .await;
                    DaemonRuntimeEventDisposition::Continue
                }
                DecodedRuntimeInboundEvent::DeliveryFailed(event) => {
                    let (event, reason) = event.into_parts();
                    self.settle_event(host_id, connection_id, daemon, event, Some(reason))
                        .await;
                    DaemonRuntimeEventDisposition::Continue
                }
                DecodedRuntimeInboundEvent::RuntimeExit(event) => {
                    self.finalize_runtime_event(host_id, connection_id, daemon, event)
                        .await;
                    DaemonRuntimeEventDisposition::Continue
                }
                DecodedRuntimeInboundEvent::Product(event) => {
                    self.handle_product(host_id, connection_id, daemon, event)
                        .await
                }
            }
        })
    }

    fn detached(&self, host_id: &str, daemon: &DaemonInstanceId, connection_id: &str) {
        if let Err(cause) = self.events.detach_daemon(host_id, daemon, connection_id) {
            tracing::error!(error_chain = %error::describe(&cause), "daemon disconnect runtime projection cleanup failed");
        }
    }

    fn release_connection<'a>(
        &'a self,
        connection_id: &'a str,
    ) -> Pin<Box<dyn Future<Output = ()> + Send + 'a>> {
        Box::pin(async move {
            if let Ok(owner) = DeliveryLeaseOwner::parse(connection_id.to_owned())
                && let Err(cause) = self.data.release_owner(owner).await
            {
                tracing::error!(error_chain = %error::describe(&cause), "daemon disconnect inbox lease release failed");
            }
        })
    }
}

#[derive(Debug)]
pub enum DaemonDeliveryError {
    TargetMissing,
    HostNotAttached,
    Persistence(PersistenceFailure),
    Registry(crate::foundation::daemon_transport::DaemonRegistryError),
    Start(Box<dyn Error + Send + Sync>),
    Delivery(Box<dyn Error + Send + Sync>),
    Hydration(Box<dyn Error + Send + Sync>),
}

impl DaemonDeliveryError {
    fn start<E: Error + Send + Sync + 'static>(source: RuntimeStartFailure<E>) -> Self {
        Self::Start(Box::new(source))
    }

    fn delivery<E: Error + Send + Sync + 'static>(source: RuntimeStartFailure<E>) -> Self {
        Self::Delivery(Box::new(source))
    }
}

impl fmt::Display for DaemonDeliveryError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::TargetMissing => "runtime dispatch target does not exist",
            Self::HostNotAttached => "runtime host has no compatible daemon attachment",
            Self::Persistence(_) => "runtime delivery persistence failed",
            Self::Registry(_) => "daemon attachment registry failed",
            Self::Start(_) => "runtime start failed",
            Self::Delivery(_) => "runtime delivery failed",
            Self::Hydration(_) => "daemon runtime hydration failed",
        })
    }
}

impl Error for DaemonDeliveryError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match self {
            Self::Persistence(source) => Some(source),
            Self::Registry(source) => Some(source),
            Self::Start(source) | Self::Delivery(source) | Self::Hydration(source) => {
                Some(source.as_ref())
            }
            Self::TargetMissing | Self::HostNotAttached => None,
        }
    }
}

impl From<PersistenceFailure> for DaemonDeliveryError {
    fn from(source: PersistenceFailure) -> Self {
        Self::Persistence(source)
    }
}

impl From<crate::foundation::daemon_transport::DaemonRegistryError> for DaemonDeliveryError {
    fn from(source: crate::foundation::daemon_transport::DaemonRegistryError) -> Self {
        Self::Registry(source)
    }
}

#[derive(Clone, Deserialize)]
struct RuntimeStatusResult {
    runtimes: Vec<RuntimeStatusRow>,
}

impl RuntimeStatusResult {
    fn decode(value: Value) -> Result<Self, EventIdentityError> {
        let object = value.as_object().ok_or(EventIdentityError)?;
        if object.len() != 1 || !object.contains_key("runtimes") {
            return Err(EventIdentityError);
        }
        serde_json::from_value(value).map_err(|_| EventIdentityError)
    }

    fn active_principals(
        &self,
        daemon: DaemonInstanceId,
    ) -> Result<Vec<RuntimePrincipal>, EventIdentityError> {
        self.runtimes
            .iter()
            .filter_map(|row| {
                if !row.has_valid_nullable_fields() {
                    return Some(Err(EventIdentityError));
                }
                match row.phase.as_str() {
                    "spawning" | "startup_pending" | "ready" | "draining" => {
                        Some(principal_from_wire(
                            &row.runtime_scope,
                            &row.conversation_id,
                            &row.agent_id,
                            row.runtime_generation,
                            daemon.clone(),
                        ))
                    }
                    "idle" | "exited" => None,
                    _ => Some(Err(EventIdentityError)),
                }
            })
            .collect()
    }

    fn hydrated(
        &self,
        daemon: DaemonInstanceId,
    ) -> Result<Vec<HydratedRuntime>, EventIdentityError> {
        self.runtimes
            .iter()
            .map(|row| {
                if !row.has_valid_nullable_fields() {
                    return Err(EventIdentityError);
                }
                let principal = principal_from_wire(
                    &row.runtime_scope,
                    &row.conversation_id,
                    &row.agent_id,
                    row.runtime_generation,
                    daemon.clone(),
                )?;
                let run_state = if row.run_state.is_null() {
                    None
                } else {
                    let state = serde_json::from_value::<AgentRunStateWire>(row.run_state.clone())
                        .map_err(|_| EventIdentityError)?;
                    if !state.matches_coordinate(&row.agent_id, &row.conversation_id) {
                        return Err(EventIdentityError);
                    }
                    Some(state)
                };
                Ok(HydratedRuntime {
                    principal,
                    run_state,
                })
            })
            .collect()
    }
}

#[derive(Clone, Deserialize)]
struct RuntimeStatusRow {
    runtime_scope: RuntimeScopeWire,
    conversation_id: String,
    agent_id: String,
    runtime_generation: i64,
    pid: Value,
    phase: String,
    run_state: Value,
    started_at: Value,
}

impl RuntimeStatusRow {
    fn has_valid_nullable_fields(&self) -> bool {
        (self.pid.is_null() || self.pid.as_i64().is_some())
            && (self.run_state.is_null() || self.run_state.is_object())
            && (self.started_at.is_null() || self.started_at.as_i64().is_some())
    }
}

fn signed_unix_millis(time: SystemTime) -> i64 {
    match time.duration_since(SystemTime::UNIX_EPOCH) {
        Ok(duration) => i64::try_from(duration.as_millis()).unwrap_or(i64::MAX),
        Err(error) => -i64::try_from(error.duration().as_millis()).unwrap_or(i64::MAX),
    }
}
