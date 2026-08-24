//! Typed production owners for daemon runtime status, activity and diagnostics.

use std::{
    collections::{HashMap, HashSet},
    error::Error,
    fmt,
    sync::{Arc, Mutex},
    time::{SystemTime, UNIX_EPOCH},
};

use serde::{
    Deserialize, Serialize,
    de::{DeserializeOwned, Error as _},
};
use serde_json::{Value, json};
use silverhand_backend_core::{
    identity::{AgentId, ConversationId, DaemonInstanceId},
    persistence::PersistenceFailure,
    runtime_credential::{
        RuntimeCustody, RuntimeEventTime, RuntimeGeneration, RuntimePrincipal, RuntimeScope,
    },
    runtime_event::{
        CommitRuntimeExit, DaemonEventDurablePort, ProjectRuntimeStatus,
        RefineRuntimeToolCallInput, RuntimeActivityFact, RuntimeActivityKind,
        RuntimeActivityPayload, RuntimeExitCommitResult, RuntimeExitDisposition,
        RuntimeObservedStatus, StampRuntimePresence, UpsertRuntimeTextActivity,
    },
};

use crate::scope_events::{DaemonSideEvent, ScopeEventHub, ScopeEventHubError};

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum RuntimeEventDirective {
    None,
    Drain {
        conversation: ConversationId,
        agent: AgentId,
    },
}

#[derive(Clone, Debug)]
pub(crate) struct RuntimeExitPostCommit {
    conversation: ConversationId,
    agent: AgentId,
    status: &'static str,
    code: Option<i64>,
    intentional: bool,
    run_state: Option<AgentRunStateWire>,
    respawn: bool,
}

impl RuntimeExitPostCommit {
    pub(crate) fn should_respawn(&self) -> bool {
        self.respawn
    }
    pub(crate) fn conversation(&self) -> &ConversationId {
        &self.conversation
    }
    pub(crate) fn agent(&self) -> &AgentId {
        &self.agent
    }
}

#[derive(Clone)]
pub(crate) struct DaemonRuntimeEventOwner<P> {
    durable: P,
    hub: ScopeEventHub,
    state: Arc<Mutex<RuntimeOwnerState>>,
}

#[derive(Default)]
struct RuntimeOwnerState {
    runs: HashMap<RuntimePrincipal, AgentRunStateWire>,
    pending_text: HashMap<RuntimePrincipal, PendingTextActivity>,
    timeout_reasons: HashMap<RuntimePrincipal, InitTimeoutReason>,
    init_failed: HashSet<RuntimePrincipal>,
    fatal: HashSet<RuntimePrincipal>,
}

#[derive(Clone)]
struct PendingTextActivity {
    conversation: ConversationId,
    agent: AgentId,
    kind: RuntimeActivityKind,
    text: String,
    omitted_chars: usize,
    created_at: RuntimeEventTime,
    event_id: Option<i64>,
}

const TEXT_ACTIVITY_MAX_CHARS: usize = 16 * 1024;

impl<P> DaemonRuntimeEventOwner<P>
where
    P: DaemonEventDurablePort,
{
    pub(crate) fn new(durable: P, hub: ScopeEventHub) -> Self {
        Self {
            durable,
            hub,
            state: Arc::new(Mutex::new(RuntimeOwnerState::default())),
        }
    }

    pub(crate) fn durable(&self) -> &P {
        &self.durable
    }

    pub(crate) async fn hydrate(
        &self,
        runtimes: Vec<HydratedRuntime>,
    ) -> Result<(), DaemonRuntimeEventError> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| DaemonRuntimeEventError::StatePoisoned)?;
        let hydrated_daemons = runtimes
            .iter()
            .map(|runtime| runtime.principal.custody().daemon_instance().clone())
            .collect::<HashSet<_>>();
        state.runs.retain(|principal, _| {
            !hydrated_daemons.contains(principal.custody().daemon_instance())
        });
        state.pending_text.retain(|principal, _| {
            !hydrated_daemons.contains(principal.custody().daemon_instance())
        });
        state.timeout_reasons.retain(|principal, _| {
            !hydrated_daemons.contains(principal.custody().daemon_instance())
        });
        state
            .init_failed
            .retain(|principal| !hydrated_daemons.contains(principal.custody().daemon_instance()));
        state
            .fatal
            .retain(|principal| !hydrated_daemons.contains(principal.custody().daemon_instance()));
        for runtime in runtimes {
            if let Some(run_state) = runtime.run_state {
                state.runs.insert(runtime.principal, run_state);
            }
        }
        Ok(())
    }

    pub(crate) fn detach_daemon(
        &self,
        daemon: &DaemonInstanceId,
    ) -> Result<(), DaemonRuntimeEventError> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| DaemonRuntimeEventError::StatePoisoned)?;
        state
            .runs
            .retain(|principal, _| principal.custody().daemon_instance() != daemon);
        state
            .pending_text
            .retain(|principal, _| principal.custody().daemon_instance() != daemon);
        state
            .timeout_reasons
            .retain(|principal, _| principal.custody().daemon_instance() != daemon);
        state
            .init_failed
            .retain(|principal| principal.custody().daemon_instance() != daemon);
        state
            .fatal
            .retain(|principal| principal.custody().daemon_instance() != daemon);
        Ok(())
    }

    pub(crate) async fn handle(
        &self,
        daemon: &DaemonInstanceId,
        event: RuntimeProductEvent,
    ) -> Result<RuntimeEventDirective, DaemonRuntimeEventError> {
        match event {
            RuntimeProductEvent::State(event) => {
                let principal = self
                    .current_principal(daemon, event.coordinate.scope()?)
                    .await?;
                if principal.custody().generation().as_i64() != event.runtime_generation {
                    return Ok(RuntimeEventDirective::None);
                }
                {
                    let mut state = self
                        .state
                        .lock()
                        .map_err(|_| DaemonRuntimeEventError::StatePoisoned)?;
                    if event.state.terminal_reason.is_none() {
                        state.timeout_reasons.remove(&principal);
                        state.init_failed.remove(&principal);
                        state.fatal.remove(&principal);
                    }
                    state.runs.insert(principal, event.state.clone());
                }
                self.publish(
                    event.coordinate.conversation()?,
                    DaemonSideEvent::AgentActivity(serde_json::to_value(event.state)?),
                )?;
                Ok(RuntimeEventDirective::None)
            }
            RuntimeProductEvent::Output(event) => {
                let _principal = self
                    .current_principal(daemon, event.coordinate.scope()?)
                    .await?;
                tracing::info!(
                    runtime_event = "runtime_output",
                    conversation_id = %event.coordinate.conversation_id,
                    agent_id = %event.coordinate.agent_id,
                    stream = %event.stream,
                    chunk_bytes = event.chunk.len(),
                    observed_at = event.ts,
                    "daemon runtime output"
                );
                Ok(RuntimeEventDirective::None)
            }
            RuntimeProductEvent::ReadyForDrain(event) => {
                let principal = self
                    .principal_for_generation(daemon, &event.coordinate, event.runtime_generation)
                    .await?;
                if !self
                    .durable
                    .project_status(ProjectRuntimeStatus::new(
                        principal,
                        RuntimeObservedStatus::Active,
                        None,
                        RuntimeEventTime::from_unix_millis(event.ts),
                    ))
                    .await?
                {
                    return Ok(RuntimeEventDirective::None);
                }
                if let Err(cause) =
                    self.publish_status(&event.coordinate, json!({ "status": "active" }))
                {
                    tracing::error!(
                        error_chain = %crate::error::describe(&cause),
                        "runtime-ready live projection failed after durable commit"
                    );
                }
                Ok(RuntimeEventDirective::Drain {
                    conversation: event.coordinate.conversation()?,
                    agent: event.coordinate.agent()?,
                })
            }
            RuntimeProductEvent::InitTimeout(event) => {
                let principal = self
                    .principal_for_generation(daemon, &event.coordinate, event.runtime_generation)
                    .await?;
                {
                    let mut state = self
                        .state
                        .lock()
                        .map_err(|_| DaemonRuntimeEventError::StatePoisoned)?;
                    state
                        .timeout_reasons
                        .insert(principal.clone(), event.timeout_reason);
                    if !event.retrying {
                        state.init_failed.insert(principal);
                    }
                }
                self.publish(
                    event.coordinate.conversation()?,
                    DaemonSideEvent::AgentInitTimeout(json!({
                        "agent_id": event.coordinate.agent_id,
                        "reason": event.timeout_reason.as_str(),
                        "elapsed_ms": event.elapsed_ms,
                        "timeout_ms": event.timeout_ms,
                        "retrying": event.retrying,
                        "retry_attempt": event.retry_attempt,
                        "max_retries": event.max_retries,
                        "cooldown_until": event.cooldown_until,
                    })),
                )?;
                Ok(RuntimeEventDirective::None)
            }
            RuntimeProductEvent::InitRetrying(event) => {
                let principal = self
                    .principal_for_generation(daemon, &event.coordinate, event.runtime_generation)
                    .await?;
                let timeout = self
                    .state
                    .lock()
                    .map_err(|_| DaemonRuntimeEventError::StatePoisoned)?
                    .timeout_reasons
                    .get(&principal)
                    .copied();
                if self
                    .durable
                    .project_status(ProjectRuntimeStatus::new(
                        principal,
                        RuntimeObservedStatus::Starting,
                        None,
                        RuntimeEventTime::from_unix_millis(event.ts),
                    ))
                    .await?
                {
                    self.publish_status(
                        &event.coordinate,
                        json!({
                            "status": "starting",
                            "reason": "init_timeout_retrying",
                            "retry_attempt": event.retry_attempt,
                            "max_retries": event.max_retries,
                            "timeout_reason": timeout.map(InitTimeoutReason::as_str),
                        }),
                    )?;
                }
                Ok(RuntimeEventDirective::None)
            }
            RuntimeProductEvent::InitCooldown(event) => {
                let principal = self
                    .principal_for_generation(daemon, &event.coordinate, event.runtime_generation)
                    .await?;
                {
                    let mut state = self
                        .state
                        .lock()
                        .map_err(|_| DaemonRuntimeEventError::StatePoisoned)?;
                    state.timeout_reasons.remove(&principal);
                    state.init_failed.insert(principal.clone());
                }
                if self
                    .durable
                    .project_status(ProjectRuntimeStatus::new(
                        principal,
                        RuntimeObservedStatus::Crashed,
                        None,
                        RuntimeEventTime::from_unix_millis(event.ts),
                    ))
                    .await?
                {
                    self.publish_status(
                        &event.coordinate,
                        json!({
                            "status": "crashed",
                            "reason": "init_cooldown",
                            "cooldown_until": event.cooldown_until,
                            "attempts_exhausted": event.attempts_exhausted,
                        }),
                    )?;
                }
                Ok(RuntimeEventDirective::None)
            }
            RuntimeProductEvent::CompactionStale(event) => {
                let _principal = self
                    .current_principal(daemon, event.coordinate.scope()?)
                    .await?;
                self.publish(
                    event.coordinate.conversation()?,
                    DaemonSideEvent::CompactionStale(json!({
                        "agent_id": event.coordinate.agent_id,
                        "elapsed_ms": event.elapsed_ms,
                    })),
                )?;
                Ok(RuntimeEventDirective::None)
            }
            RuntimeProductEvent::OutputDropped(event) => {
                let _principal = self
                    .current_principal(daemon, event.coordinate.scope()?)
                    .await?;
                tracing::warn!(runtime_event = "runtime_output_dropped", conversation_id = %event.coordinate.conversation_id, agent_id = %event.coordinate.agent_id, dropped_count = event.dropped_count, bytes_dropped = event.bytes_dropped, since_ts = event.since_ts, "daemon runtime output dropped");
                Ok(RuntimeEventDirective::None)
            }
            RuntimeProductEvent::OutputPaused(event) => {
                let _principal = self
                    .current_principal(daemon, event.coordinate.scope()?)
                    .await?;
                tracing::info!(runtime_event = "runtime_output_paused", conversation_id = %event.coordinate.conversation_id, agent_id = %event.coordinate.agent_id, "daemon runtime output paused");
                Ok(RuntimeEventDirective::None)
            }
            RuntimeProductEvent::OutputResumed(event) => {
                let _principal = self
                    .current_principal(daemon, event.coordinate.scope()?)
                    .await?;
                tracing::info!(runtime_event = "runtime_output_resumed", conversation_id = %event.coordinate.conversation_id, agent_id = %event.coordinate.agent_id, "daemon runtime output resumed");
                Ok(RuntimeEventDirective::None)
            }
            RuntimeProductEvent::Parsed(event) => self.handle_parsed(daemon, event).await,
            RuntimeProductEvent::ParsedDropped(event) => {
                let principal = self
                    .current_principal(daemon, event.coordinate.scope()?)
                    .await?;
                let fact = RuntimeActivityFact::new(
                    event.coordinate.conversation()?,
                    event.coordinate.agent()?,
                    RuntimeActivityKind::ParsedEventDropped,
                    RuntimeActivityPayload::ParsedEventDropped {
                        parsed_kind: event.parsed_kind,
                        encoded_bytes: event.encoded_bytes,
                        reason: event.reason,
                    },
                    RuntimeEventTime::from_unix_millis(event.ts),
                );
                self.record_and_publish(principal, fact, None).await?;
                Ok(RuntimeEventDirective::None)
            }
            RuntimeProductEvent::MessageStale(event) => {
                let principal = self
                    .principal_for_generation(daemon, &event.coordinate, event.runtime_generation)
                    .await?;
                let fact = RuntimeActivityFact::new(
                    event.coordinate.conversation()?,
                    event.coordinate.agent()?,
                    RuntimeActivityKind::MessageStale,
                    RuntimeActivityPayload::None,
                    RuntimeEventTime::from_unix_millis(event.ts),
                );
                self.record_and_publish(principal, fact, None).await?;
                Ok(RuntimeEventDirective::None)
            }
        }
    }

    pub(crate) fn prepare_exit(
        &self,
        principal: RuntimePrincipal,
        code: Option<i64>,
        intentional: bool,
        observed_at: i64,
    ) -> Result<CommitRuntimeExit, DaemonRuntimeEventError> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| DaemonRuntimeEventError::StatePoisoned)?;
        state.pending_text.remove(&principal);
        let failed = state.init_failed.contains(&principal) || state.fatal.contains(&principal);
        let status = runtime_exit_status(failed, false, intentional, code);
        Ok(CommitRuntimeExit::new(
            principal,
            status,
            RuntimeEventTime::from_unix_millis(observed_at),
            None,
        ))
    }

    pub(crate) fn complete_consumed(
        &self,
        conversation: &ConversationId,
        agent: &AgentId,
        presence_viewers: &[silverhand_backend_core::identity::UserId],
        observed_at: i64,
        count: usize,
        activity_id: i64,
    ) -> Result<(), DaemonRuntimeEventError> {
        let presence = self.publish_presence(presence_viewers, agent);
        let activity = self.publish(
            conversation.clone(),
            DaemonSideEvent::ConversationActivity(json!({
                "id": activity_id,
                "conversation_id": conversation.as_str(),
                "agent_id": agent.as_str(),
                "kind": "message_received",
                "payload": { "count": count },
                "created_at": observed_at,
            })),
        );
        finish_live_effects([presence, activity])
    }

    pub(crate) fn complete_exit_state(
        &self,
        principal: &RuntimePrincipal,
        result: &RuntimeExitCommitResult,
        conversation: ConversationId,
        code: Option<i64>,
        intentional: bool,
    ) -> Result<Option<RuntimeExitPostCommit>, DaemonRuntimeEventError> {
        if result.disposition() != RuntimeExitDisposition::Applied {
            return Ok(None);
        }
        let (init_failed, fatal, run_state) = {
            let mut state = self
                .state
                .lock()
                .map_err(|_| DaemonRuntimeEventError::StatePoisoned)?;
            let init_failed = state.init_failed.remove(principal);
            let fatal = state.fatal.remove(principal);
            state.timeout_reasons.remove(principal);
            let run_state = state.runs.remove(principal);
            (init_failed, fatal, run_state)
        };
        let status = runtime_exit_status(init_failed, fatal, intentional, code).as_str();
        Ok(Some(RuntimeExitPostCommit {
            conversation,
            agent: principal.agent().clone(),
            status,
            code,
            intentional,
            run_state,
            respawn: runtime_exit_should_respawn(init_failed, fatal, intentional),
        }))
    }

    pub(crate) fn publish_exit(
        &self,
        effect: &RuntimeExitPostCommit,
    ) -> Result<(), DaemonRuntimeEventError> {
        self.publish(
            effect.conversation.clone(),
            DaemonSideEvent::AgentStatus(json!({
                "agent_id": effect.agent.as_str(),
                "status": effect.status,
                "exit_code": effect.code,
                "intentional": effect.intentional,
                "run_state": effect.run_state,
            })),
        )
    }

    async fn handle_parsed(
        &self,
        daemon: &DaemonInstanceId,
        event: RuntimeParsedEvent,
    ) -> Result<RuntimeEventDirective, DaemonRuntimeEventError> {
        let principal = self
            .principal_for_generation(daemon, &event.coordinate, event.runtime_generation)
            .await?;
        if let ParsedEventWire::InputLifecycle {
            command_uuid,
            state,
        } = &event.parsed
        {
            tracing::info!(runtime_event = "runtime_parsed_event", parsed_kind = "input_lifecycle", command_uuid, state = ?state, "runtime input lifecycle");
            return Ok(RuntimeEventDirective::None);
        }
        let sanitized = event.parsed.sanitized();
        let agent_event = DaemonSideEvent::AgentEvent(json!({
            "agent_id": event.coordinate.agent_id,
            "event": sanitized,
        }));
        if let ParsedEventWire::Error {
            fatal: Some(true), ..
        } = &event.parsed
        {
            self.state
                .lock()
                .map_err(|_| DaemonRuntimeEventError::StatePoisoned)?
                .fatal
                .insert(principal.clone());
        }
        let (directive, status_payload) =
            if let ParsedEventWire::SessionInit { session_id } = &event.parsed {
                let projected = self
                    .durable
                    .project_status(ProjectRuntimeStatus::new(
                        principal.clone(),
                        RuntimeObservedStatus::Active,
                        Some(session_id.clone()),
                        RuntimeEventTime::from_unix_millis(event.ts),
                    ))
                    .await?;
                (
                    RuntimeEventDirective::Drain {
                        conversation: event.coordinate.conversation()?,
                        agent: event.coordinate.agent()?,
                    },
                    projected.then(|| {
                        json!({
                            "status": "active", "cli_session_id": session_id,
                        })
                    }),
                )
            } else {
                (RuntimeEventDirective::None, None)
            };
        let activity_projection = match &event.parsed {
            ParsedEventWire::Thinking { text } => {
                self.upsert_text_and_publish(
                    principal,
                    &event.coordinate,
                    RuntimeActivityKind::Thinking,
                    text,
                    event.ts,
                    agent_event.clone(),
                )
                .await
            }
            ParsedEventWire::Text { text } => {
                self.upsert_text_and_publish(
                    principal,
                    &event.coordinate,
                    RuntimeActivityKind::Text,
                    text,
                    event.ts,
                    agent_event.clone(),
                )
                .await
            }
            ParsedEventWire::ToolCallInput {
                tool_call_id,
                input,
            } => {
                self.clear_pending_text(&principal)?;
                let input = sanitize_json_value(input, 0);
                let Some(committed) = self
                    .durable
                    .refine_tool_call_input(RefineRuntimeToolCallInput::new(
                        principal,
                        event.coordinate.conversation()?,
                        event.coordinate.agent()?,
                        tool_call_id.clone(),
                        serde_json::to_string(&input)?,
                        RuntimeEventTime::from_unix_millis(presence_now()),
                    ))
                    .await?
                else {
                    return Err(DaemonRuntimeEventError::StaleRuntime);
                };
                let agent = event.coordinate.agent()?;
                let presence = self.publish_presence(committed.presence_viewers(), &agent);
                let agent_projection =
                    self.publish(event.coordinate.conversation()?, agent_event.clone());
                let activity = if let Some(refined) = committed.refined() {
                    let conversation = event.coordinate.conversation()?;
                    self.publish(
                        conversation,
                        DaemonSideEvent::ConversationActivity(json!({
                            "id": refined.id(),
                            "conversation_id": event.coordinate.conversation_id,
                            "agent_id": event.coordinate.agent_id,
                            "kind": "tool_call",
                            "payload": serde_json::from_str::<Value>(refined.payload_json())?,
                            "created_at": refined.created_at().as_unix_millis(),
                        })),
                    )
                } else {
                    Ok(())
                };
                finish_live_effects([presence, agent_projection, activity])
            }
            _ => {
                self.clear_pending_text(&principal)?;
                if let Some(fact) = event.parsed.activity(&event.coordinate, event.ts)? {
                    self.record_and_publish(principal, fact, Some(agent_event.clone()))
                        .await
                } else {
                    let viewers = self
                        .durable
                        .stamp_presence(StampRuntimePresence::new(
                            principal,
                            event.coordinate.agent()?,
                            RuntimeEventTime::from_unix_millis(presence_now()),
                        ))
                        .await?
                        .ok_or(DaemonRuntimeEventError::StaleRuntime)?;
                    let presence = self.publish_presence(&viewers, &event.coordinate.agent()?);
                    let agent_projection =
                        self.publish(event.coordinate.conversation()?, agent_event.clone());
                    finish_live_effects([presence, agent_projection])
                }
            }
        };
        let live_failure = match activity_projection {
            Ok(()) => None,
            Err(DaemonRuntimeEventError::Hub(cause)) => Some(DaemonRuntimeEventError::Hub(cause)),
            Err(cause) => return Err(cause),
        };
        let status_event = status_payload
            .map(|payload| self.publish_status(&event.coordinate, payload))
            .unwrap_or(Ok(()));
        finish_live_effects([live_failure.map_or(Ok(()), Err), status_event])?;
        Ok(directive)
    }

    fn clear_pending_text(
        &self,
        principal: &RuntimePrincipal,
    ) -> Result<(), DaemonRuntimeEventError> {
        self.state
            .lock()
            .map_err(|_| DaemonRuntimeEventError::StatePoisoned)?
            .pending_text
            .remove(principal);
        Ok(())
    }

    async fn upsert_text_and_publish(
        &self,
        principal: RuntimePrincipal,
        coordinate: &RuntimeCoordinate,
        kind: RuntimeActivityKind,
        fragment: &str,
        observed_at: i64,
        agent_event: DaemonSideEvent,
    ) -> Result<(), DaemonRuntimeEventError> {
        if fragment.is_empty() {
            let viewers = self
                .durable
                .stamp_presence(StampRuntimePresence::new(
                    principal,
                    coordinate.agent()?,
                    RuntimeEventTime::from_unix_millis(presence_now()),
                ))
                .await?
                .ok_or(DaemonRuntimeEventError::StaleRuntime)?;
            let presence = self.publish_presence(&viewers, &coordinate.agent()?);
            let agent_projection = self.publish(coordinate.conversation()?, agent_event);
            return finish_live_effects([presence, agent_projection]);
        }
        let (fact, previous_event_id) = {
            let mut state = self
                .state
                .lock()
                .map_err(|_| DaemonRuntimeEventError::StatePoisoned)?;
            if state
                .pending_text
                .get(&principal)
                .is_some_and(|pending| pending.kind != kind)
            {
                state.pending_text.remove(&principal);
            }
            let pending =
                state
                    .pending_text
                    .entry(principal.clone())
                    .or_insert(PendingTextActivity {
                        conversation: coordinate.conversation()?,
                        agent: coordinate.agent()?,
                        kind,
                        text: String::new(),
                        omitted_chars: 0,
                        created_at: RuntimeEventTime::from_unix_millis(observed_at),
                        event_id: None,
                    });
            append_capped_text(pending, fragment);
            let rendered = if pending.omitted_chars == 0 {
                pending.text.clone()
            } else {
                format!(
                    "{}...<truncated {} chars>",
                    pending.text, pending.omitted_chars
                )
            };
            (
                RuntimeActivityFact::new(
                    pending.conversation.clone(),
                    pending.agent.clone(),
                    pending.kind,
                    RuntimeActivityPayload::Text { text: rendered },
                    pending.created_at,
                ),
                pending.event_id,
            )
        };
        let id = self
            .durable
            .upsert_text_activity(UpsertRuntimeTextActivity::new(
                principal.clone(),
                fact.clone(),
                previous_event_id,
                RuntimeEventTime::from_unix_millis(presence_now()),
            ))
            .await?
            .ok_or(DaemonRuntimeEventError::StaleRuntime)?;
        {
            let mut state = self
                .state
                .lock()
                .map_err(|_| DaemonRuntimeEventError::StatePoisoned)?;
            if let Some(pending) = state.pending_text.get_mut(&principal)
                && pending.kind == kind
            {
                pending.event_id = Some(id.id());
            }
        }
        let presence = self.publish_presence(id.presence_viewers(), fact.agent());
        let agent_projection = self.publish(fact.conversation().clone(), agent_event);
        let payload = activity_payload_value(fact.payload())?;
        let activity = self.publish(
            fact.conversation().clone(),
            DaemonSideEvent::ConversationActivity(json!({
                "id": id.id(),
                "conversation_id": fact.conversation().as_str(),
                "agent_id": fact.agent().as_str(),
                "kind": fact.kind().as_str(),
                "payload": payload,
                "created_at": fact.created_at().as_unix_millis(),
            })),
        );
        finish_live_effects([presence, agent_projection, activity])
    }

    async fn record_and_publish(
        &self,
        principal: RuntimePrincipal,
        fact: RuntimeActivityFact,
        agent_event: Option<DaemonSideEvent>,
    ) -> Result<(), DaemonRuntimeEventError> {
        let id = self
            .durable
            .record_activity(
                principal,
                fact.clone(),
                RuntimeEventTime::from_unix_millis(presence_now()),
            )
            .await?
            .ok_or(DaemonRuntimeEventError::StaleRuntime)?;
        let presence = self.publish_presence(id.presence_viewers(), fact.agent());
        let agent_projection = agent_event
            .map(|event| self.publish(fact.conversation().clone(), event))
            .unwrap_or(Ok(()));
        let payload = activity_payload_value(fact.payload())?;
        let activity = self.publish(
            fact.conversation().clone(),
            DaemonSideEvent::ConversationActivity(json!({
                "id": id.id(),
                "conversation_id": fact.conversation().as_str(),
                "agent_id": fact.agent().as_str(),
                "kind": fact.kind().as_str(),
                "payload": payload,
                "created_at": fact.created_at().as_unix_millis(),
            })),
        );
        finish_live_effects([presence, agent_projection, activity])
    }

    async fn current_principal(
        &self,
        daemon: &DaemonInstanceId,
        scope: RuntimeScope,
    ) -> Result<RuntimePrincipal, DaemonRuntimeEventError> {
        let principal = self
            .durable
            .current_principal(scope)
            .await?
            .ok_or(DaemonRuntimeEventError::StaleRuntime)?;
        if principal.custody().daemon_instance() != daemon {
            return Err(DaemonRuntimeEventError::StaleRuntime);
        }
        Ok(principal)
    }

    async fn principal_for_generation(
        &self,
        daemon: &DaemonInstanceId,
        coordinate: &RuntimeCoordinate,
        generation: i64,
    ) -> Result<RuntimePrincipal, DaemonRuntimeEventError> {
        let principal = RuntimePrincipal::for_scope(
            coordinate.scope()?,
            RuntimeCustody::new(
                RuntimeGeneration::new(generation).map_err(DaemonRuntimeEventError::source)?,
                daemon.clone(),
            ),
        );
        let current = self.durable.current_principal(principal.scope()).await?;
        if current.as_ref() != Some(&principal) {
            return Err(DaemonRuntimeEventError::StaleRuntime);
        }
        Ok(principal)
    }

    fn publish_status(
        &self,
        coordinate: &RuntimeCoordinate,
        payload: Value,
    ) -> Result<(), DaemonRuntimeEventError> {
        let mut object = payload
            .as_object()
            .cloned()
            .ok_or(DaemonRuntimeEventError::InvalidPayload)?;
        object.insert(
            "agent_id".into(),
            Value::String(coordinate.agent_id.clone()),
        );
        self.publish(
            coordinate.conversation()?,
            DaemonSideEvent::AgentStatus(Value::Object(object)),
        )
    }

    fn publish(
        &self,
        conversation: ConversationId,
        event: DaemonSideEvent,
    ) -> Result<(), DaemonRuntimeEventError> {
        self.hub
            .publish_daemon_side(&conversation, event)
            .map_err(Into::into)
    }

    fn publish_presence(
        &self,
        viewers: &[silverhand_backend_core::identity::UserId],
        agent: &AgentId,
    ) -> Result<(), DaemonRuntimeEventError> {
        for viewer in viewers {
            self.hub.publish_agent_presence_changed(viewer, agent)?;
        }
        Ok(())
    }
}

fn finish_live_effects<const N: usize>(
    effects: [Result<(), DaemonRuntimeEventError>; N],
) -> Result<(), DaemonRuntimeEventError> {
    for effect in effects {
        effect?;
    }
    Ok(())
}

fn presence_now() -> i64 {
    match SystemTime::now().duration_since(UNIX_EPOCH) {
        Ok(duration) => i64::try_from(duration.as_millis()).unwrap_or(i64::MAX),
        Err(error) => -i64::try_from(error.duration().as_millis()).unwrap_or(i64::MAX),
    }
}

fn runtime_exit_status(
    init_failed: bool,
    fatal: bool,
    intentional: bool,
    code: Option<i64>,
) -> RuntimeObservedStatus {
    if init_failed || fatal || (!intentional && code != Some(0)) {
        RuntimeObservedStatus::Crashed
    } else {
        RuntimeObservedStatus::Idle
    }
}

fn runtime_exit_should_respawn(init_failed: bool, fatal: bool, intentional: bool) -> bool {
    !intentional && !init_failed && !fatal
}

fn activity_payload_value(
    payload: &RuntimeActivityPayload,
) -> Result<Value, DaemonRuntimeEventError> {
    Ok(match payload {
        RuntimeActivityPayload::None => Value::Null,
        RuntimeActivityPayload::Text { text } => json!({ "text": text }),
        RuntimeActivityPayload::ToolCall {
            name,
            input_json,
            tool_call_id,
        } => json!({
            "name": name,
            "input": serde_json::from_str::<Value>(input_json)?,
            "tool_call_id": tool_call_id,
        }),
        RuntimeActivityPayload::ToolOutput {
            name,
            tool_call_id,
            outcome,
        } => json!({
            "name": name, "tool_call_id": tool_call_id, "outcome": outcome,
        }),
        RuntimeActivityPayload::ApiResponse { status, message } => {
            json!({ "status": status, "message": message })
        }
        RuntimeActivityPayload::Error {
            message,
            code,
            fatal,
        } => json!({ "message": message, "code": code, "fatal": fatal }),
        RuntimeActivityPayload::ParsedEventDropped {
            parsed_kind,
            encoded_bytes,
            reason,
        } => json!({
            "parsed_kind": parsed_kind, "encoded_bytes": encoded_bytes, "reason": reason,
        }),
        RuntimeActivityPayload::MessageReceived { count } => json!({ "count": count }),
    })
}

#[derive(Debug)]
pub(crate) enum DaemonRuntimeEventError {
    Persistence(PersistenceFailure),
    Hub(ScopeEventHubError),
    Decode(Box<dyn Error + Send + Sync>),
    Json(serde_json::Error),
    StatePoisoned,
    StaleRuntime,
    InvalidPayload,
}

impl DaemonRuntimeEventError {
    fn source(error: impl Error + Send + Sync + 'static) -> Self {
        Self::Decode(Box::new(error))
    }
}

impl fmt::Display for DaemonRuntimeEventError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::Persistence(_) => "daemon runtime event persistence failed",
            Self::Hub(_) => "daemon runtime event live projection failed",
            Self::Decode(_) | Self::Json(_) | Self::InvalidPayload => {
                "daemon runtime event decode failed"
            }
            Self::StatePoisoned => "daemon runtime event state lock was poisoned",
            Self::StaleRuntime => "daemon runtime event custody is stale",
        })
    }
}

impl Error for DaemonRuntimeEventError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match self {
            Self::Persistence(source) => Some(source),
            Self::Hub(source) => Some(source),
            Self::Decode(source) => Some(source.as_ref()),
            Self::Json(source) => Some(source),
            Self::StatePoisoned | Self::StaleRuntime | Self::InvalidPayload => None,
        }
    }
}

impl From<PersistenceFailure> for DaemonRuntimeEventError {
    fn from(value: PersistenceFailure) -> Self {
        Self::Persistence(value)
    }
}
impl From<ScopeEventHubError> for DaemonRuntimeEventError {
    fn from(value: ScopeEventHubError) -> Self {
        Self::Hub(value)
    }
}
impl From<serde_json::Error> for DaemonRuntimeEventError {
    fn from(value: serde_json::Error) -> Self {
        Self::Json(value)
    }
}

#[derive(Clone, Debug, Deserialize, Eq, Hash, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub(crate) enum RuntimeScopeWire {
    Agent {
        agent_id: String,
    },
    Conversation {
        conversation_id: String,
        agent_id: String,
    },
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct RuntimeCoordinate {
    pub runtime_scope: RuntimeScopeWire,
    pub conversation_id: String,
    pub agent_id: String,
}

impl RuntimeCoordinate {
    fn scope(&self) -> Result<RuntimeScope, DaemonRuntimeEventError> {
        let agent = self.agent()?;
        match &self.runtime_scope {
            RuntimeScopeWire::Agent { agent_id } if agent_id == &self.agent_id => {
                Ok(RuntimeScope::AgentSlot { agent })
            }
            RuntimeScopeWire::Conversation {
                conversation_id,
                agent_id,
            } if conversation_id == &self.conversation_id && agent_id == &self.agent_id => {
                Ok(RuntimeScope::ConversationSlot {
                    agent,
                    source: self.conversation()?,
                })
            }
            _ => Err(DaemonRuntimeEventError::InvalidPayload),
        }
    }
    fn agent(&self) -> Result<AgentId, DaemonRuntimeEventError> {
        AgentId::parse(self.agent_id.clone()).map_err(DaemonRuntimeEventError::source)
    }
    fn conversation(&self) -> Result<ConversationId, DaemonRuntimeEventError> {
        ConversationId::parse(self.conversation_id.clone()).map_err(DaemonRuntimeEventError::source)
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct AgentRunStateWire {
    pub run_id: String,
    pub agent_id: String,
    pub conversation_id: String,
    pub status: AgentRunStatus,
    pub started_at: serde_json::Number,
    pub updated_at: serde_json::Number,
    pub last_activity_at: serde_json::Number,
    #[serde(default)]
    pub terminal_reason: Option<AgentRunTerminalReason>,
    #[serde(default)]
    pub activity_snippet: Option<String>,
    #[serde(default)]
    pub activity_snippet_kind: Option<AgentActivitySnippetKind>,
    #[serde(default)]
    pub tool_call_counts: Option<std::collections::BTreeMap<String, serde_json::Number>>,
    #[serde(default)]
    pub compacting: Option<bool>,
    #[serde(default)]
    pub compacting_since: Option<serde_json::Number>,
    #[serde(default)]
    pub compaction_stale: Option<bool>,
    #[serde(default)]
    pub detail: Option<String>,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum AgentRunStatus {
    Starting,
    Thinking,
    ToolRunning,
    Waiting,
    Idle,
    Failed,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum AgentRunTerminalReason {
    Replied,
    TurnEnded,
    Replaced,
    Stopped,
    Crashed,
    Timeout,
    ConversationClosed,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum AgentActivitySnippetKind {
    Thinking,
    Text,
    ApiResponse,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum InitTimeoutReason {
    Silence,
    PreProtocolCap,
    PostProtocol,
}
impl InitTimeoutReason {
    fn as_str(self) -> &'static str {
        match self {
            Self::Silence => "silence",
            Self::PreProtocolCap => "pre_protocol_cap",
            Self::PostProtocol => "post_protocol",
        }
    }
}

macro_rules! coordinate_event {
    ($name:ident { $($field:ident : $ty:ty),* $(,)? }) => {
        #[derive(Clone, Debug, Deserialize, Eq, PartialEq)]
        #[serde(deny_unknown_fields)]
        pub(crate) struct $name {
            #[serde(flatten)] pub coordinate: RuntimeCoordinate,
            $(pub $field: $ty,)*
        }
    };
}

coordinate_event!(RuntimeStateEvent {
    runtime_generation: i64,
    state: AgentRunStateWire,
    ts: i64
});
coordinate_event!(RuntimeOutputEvent {
    stream: RuntimeOutputStream,
    chunk: String,
    ts: i64
});
coordinate_event!(RuntimeReadyEvent {
    runtime_generation: i64,
    ts: i64
});
coordinate_event!(RuntimeInitTimeoutEvent { runtime_generation: i64, timeout_reason: InitTimeoutReason, elapsed_ms: i64, timeout_ms: i64, retrying: bool, retry_attempt: i64, max_retries: i64, cooldown_until: Option<i64>, ts: i64 });
coordinate_event!(RuntimeInitRetryingEvent {
    runtime_generation: i64,
    retry_attempt: i64,
    max_retries: i64,
    delay_ms: i64,
    ts: i64
});
coordinate_event!(RuntimeInitCooldownEvent {
    runtime_generation: i64,
    cooldown_until: i64,
    attempts_exhausted: i64,
    ts: i64
});
coordinate_event!(RuntimeCompactionStaleEvent {
    elapsed_ms: i64,
    ts: i64
});
coordinate_event!(RuntimeOutputDroppedEvent {
    dropped_count: i64,
    bytes_dropped: i64,
    since_ts: i64
});
coordinate_event!(RuntimeOutputBoundaryEvent {});
coordinate_event!(RuntimeParsedEvent {
    runtime_generation: i64,
    parsed: ParsedEventWire,
    ts: i64
});
coordinate_event!(RuntimeParsedDroppedEvent {
    parsed_kind: String,
    encoded_bytes: i64,
    reason: String,
    ts: i64
});
coordinate_event!(RuntimeMessageStaleEvent {
    runtime_generation: i64,
    ts: i64
});

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub(crate) enum ParsedEventWire {
    SessionInit {
        #[serde(rename = "sessionId")]
        session_id: String,
    },
    Thinking {
        text: String,
    },
    Text {
        text: String,
    },
    ToolCall {
        name: String,
        input: Value,
        #[serde(rename = "toolCallId")]
        tool_call_id: Option<String>,
    },
    ToolCallInput {
        #[serde(rename = "toolCallId")]
        tool_call_id: String,
        input: Value,
    },
    ToolOutput {
        name: Option<String>,
        #[serde(rename = "toolCallId")]
        tool_call_id: Option<String>,
        #[serde(default)]
        outcome: ToolOutcome,
    },
    TurnEnd {
        #[serde(rename = "sessionId")]
        session_id: Option<String>,
    },
    CompactionStarted,
    CompactionFinished,
    InputLifecycle {
        #[serde(rename = "commandUuid")]
        command_uuid: String,
        state: InputLifecycleState,
    },
    ApiResponse {
        status: ApiResponseStatus,
        message: String,
    },
    Error {
        message: String,
        code: Option<String>,
        fatal: Option<bool>,
    },
    Unknown {
        raw: String,
    },
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum ToolOutcome {
    Success,
    Failed,
    Cancelled,
    #[default]
    Completed,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum InputLifecycleState {
    Queued,
    Started,
    Completed,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum ApiResponseStatus {
    Waiting,
    Ready,
    Notice,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum RuntimeOutputStream {
    Stdout,
    Stderr,
}

impl std::fmt::Display for RuntimeOutputStream {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(match self {
            Self::Stdout => "stdout",
            Self::Stderr => "stderr",
        })
    }
}

impl ParsedEventWire {
    fn sanitized(&self) -> Self {
        match self {
            Self::ToolCall {
                name,
                input,
                tool_call_id,
            } => Self::ToolCall {
                name: name.clone(),
                input: sanitize_json_value(input, 0),
                tool_call_id: tool_call_id.clone(),
            },
            Self::ToolCallInput {
                tool_call_id,
                input,
            } => Self::ToolCallInput {
                tool_call_id: tool_call_id.clone(),
                input: sanitize_json_value(input, 0),
            },
            other => other.clone(),
        }
    }

    fn activity(
        &self,
        coordinate: &RuntimeCoordinate,
        ts: i64,
    ) -> Result<Option<RuntimeActivityFact>, DaemonRuntimeEventError> {
        let (kind, payload) = match self {
            Self::SessionInit { session_id } => (
                RuntimeActivityKind::SessionInit,
                RuntimeActivityPayload::Text {
                    text: session_id.clone(),
                },
            ),
            Self::Thinking { text } => (
                RuntimeActivityKind::Thinking,
                RuntimeActivityPayload::Text { text: text.clone() },
            ),
            Self::Text { text } => (
                RuntimeActivityKind::Text,
                RuntimeActivityPayload::Text { text: text.clone() },
            ),
            Self::ToolCall {
                name,
                input,
                tool_call_id,
            } => (
                RuntimeActivityKind::ToolCall,
                RuntimeActivityPayload::ToolCall {
                    name: name.clone(),
                    input_json: serde_json::to_string(input)?,
                    tool_call_id: tool_call_id.clone(),
                },
            ),
            Self::ToolCallInput { .. } | Self::InputLifecycle { .. } | Self::Unknown { .. } => {
                return Ok(None);
            }
            Self::ToolOutput {
                name,
                tool_call_id,
                outcome,
            } => (
                RuntimeActivityKind::ToolOutput,
                RuntimeActivityPayload::ToolOutput {
                    name: name.clone(),
                    tool_call_id: tool_call_id.clone(),
                    outcome: serde_json::to_value(outcome)?
                        .as_str()
                        .unwrap_or("completed")
                        .to_owned(),
                },
            ),
            Self::TurnEnd { .. } => (RuntimeActivityKind::TurnEnd, RuntimeActivityPayload::None),
            Self::CompactionStarted => (
                RuntimeActivityKind::CompactionStarted,
                RuntimeActivityPayload::None,
            ),
            Self::CompactionFinished => (
                RuntimeActivityKind::CompactionFinished,
                RuntimeActivityPayload::None,
            ),
            Self::ApiResponse { status, message } => (
                RuntimeActivityKind::ApiResponse,
                RuntimeActivityPayload::ApiResponse {
                    status: serde_json::to_value(status)?
                        .as_str()
                        .unwrap_or("notice")
                        .to_owned(),
                    message: message.clone(),
                },
            ),
            Self::Error {
                message,
                code,
                fatal,
            } => (
                RuntimeActivityKind::Error,
                RuntimeActivityPayload::Error {
                    message: message.clone(),
                    code: code.clone(),
                    fatal: *fatal,
                },
            ),
        };
        Ok(Some(RuntimeActivityFact::new(
            coordinate.conversation()?,
            coordinate.agent()?,
            kind,
            payload,
            RuntimeEventTime::from_unix_millis(ts),
        )))
    }
}

fn append_capped_text(pending: &mut PendingTextActivity, fragment: &str) {
    let used = pending.text.chars().count();
    let available = TEXT_ACTIVITY_MAX_CHARS.saturating_sub(used);
    if available == 0 {
        pending.omitted_chars = pending
            .omitted_chars
            .saturating_add(fragment.chars().count());
        return;
    }
    let kept = fragment.chars().take(available).collect::<String>();
    let kept_count = kept.chars().count();
    pending.text.push_str(&kept);
    pending.omitted_chars = pending
        .omitted_chars
        .saturating_add(fragment.chars().count().saturating_sub(kept_count));
}

fn sanitize_json_value(value: &Value, depth: usize) -> Value {
    const STRING_MAX: usize = 500;
    const ARRAY_MAX: usize = 20;
    const OBJECT_MAX: usize = 40;
    const DEPTH_MAX: usize = 4;

    match value {
        Value::String(text) => {
            let length = text.encode_utf16().count();
            if length <= STRING_MAX {
                return value.clone();
            }
            let mut units = 0;
            let mut boundary = 0;
            for (index, character) in text.char_indices() {
                let next = units + character.len_utf16();
                if next > STRING_MAX {
                    break;
                }
                units = next;
                boundary = index + character.len_utf8();
            }
            Value::String(format!(
                "{}...<truncated {} chars>",
                &text[..boundary],
                length.saturating_sub(units)
            ))
        }
        Value::Array(items) if depth >= DEPTH_MAX => Value::String("[Truncated object]".to_owned()),
        Value::Array(items) => {
            let mut output = items
                .iter()
                .take(ARRAY_MAX)
                .map(|item| sanitize_json_value(item, depth + 1))
                .collect::<Vec<_>>();
            if items.len() > output.len() {
                output.push(json!({ "__truncatedItems": items.len() - output.len() }));
            }
            Value::Array(output)
        }
        Value::Object(object) if depth >= DEPTH_MAX => {
            Value::String("[Truncated object]".to_owned())
        }
        Value::Object(object) => {
            let mut output = serde_json::Map::new();
            for (key, value) in object.iter().take(OBJECT_MAX) {
                output.insert(key.clone(), sanitize_json_value(value, depth + 1));
            }
            if object.len() > output.len() {
                output.insert(
                    "__truncatedKeys".to_owned(),
                    Value::from(object.len() - output.len()),
                );
            }
            Value::Object(output)
        }
        _ => value.clone(),
    }
}

#[cfg(test)]
mod tests {
    use std::cell::Cell;

    use silverhand_backend_core::runtime_event::RuntimeObservedStatus;

    use super::{
        DaemonRuntimeEventError, finish_live_effects, runtime_exit_should_respawn,
        runtime_exit_status,
    };

    #[test]
    fn a_failed_post_commit_projection_does_not_short_circuit_the_next_effect() {
        let attempted = Cell::new(0_u8);
        let result = finish_live_effects([
            {
                attempted.set(attempted.get() + 1);
                Err(DaemonRuntimeEventError::StatePoisoned)
            },
            {
                attempted.set(attempted.get() + 1);
                Ok(())
            },
        ]);

        assert!(matches!(
            result,
            Err(DaemonRuntimeEventError::StatePoisoned)
        ));
        assert_eq!(attempted.get(), 2);
    }

    #[test]
    fn init_and_fatal_failures_close_the_respawn_gate_without_faking_idle() {
        for (init_failed, fatal) in [(true, false), (false, true)] {
            assert_eq!(
                runtime_exit_status(init_failed, fatal, false, Some(1)),
                RuntimeObservedStatus::Crashed
            );
            assert!(!runtime_exit_should_respawn(init_failed, fatal, false));
        }

        assert_eq!(
            runtime_exit_status(false, false, false, Some(1)),
            RuntimeObservedStatus::Crashed
        );
        assert!(runtime_exit_should_respawn(false, false, false));
        assert_eq!(
            runtime_exit_status(false, false, true, Some(0)),
            RuntimeObservedStatus::Idle
        );
        assert!(!runtime_exit_should_respawn(false, false, true));
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct HydratedRuntime {
    pub principal: RuntimePrincipal,
    pub run_state: Option<AgentRunStateWire>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum RuntimeProductEvent {
    State(RuntimeStateEvent),
    Output(RuntimeOutputEvent),
    ReadyForDrain(RuntimeReadyEvent),
    InitTimeout(RuntimeInitTimeoutEvent),
    InitRetrying(RuntimeInitRetryingEvent),
    InitCooldown(RuntimeInitCooldownEvent),
    CompactionStale(RuntimeCompactionStaleEvent),
    OutputDropped(RuntimeOutputDroppedEvent),
    OutputPaused(RuntimeOutputBoundaryEvent),
    OutputResumed(RuntimeOutputBoundaryEvent),
    Parsed(RuntimeParsedEvent),
    ParsedDropped(RuntimeParsedDroppedEvent),
    MessageStale(RuntimeMessageStaleEvent),
}

pub(crate) fn decode_product_event(
    kind: &str,
    value: &Value,
) -> Result<RuntimeProductEvent, serde_json::Error> {
    fn body<T: DeserializeOwned>(value: &Value) -> Result<T, serde_json::Error> {
        let mut body = value.as_object().cloned().unwrap_or_default();
        body.remove("direction");
        body.remove("type");
        body.remove("kind");
        serde_json::from_value(Value::Object(body))
    }
    let expected: &[&[&str]] = match kind {
        "runtime_state" => &[&[
            "direction",
            "type",
            "kind",
            "runtime_scope",
            "conversation_id",
            "agent_id",
            "runtime_generation",
            "state",
            "ts",
        ]],
        "runtime_output" => &[&[
            "direction",
            "type",
            "kind",
            "runtime_scope",
            "conversation_id",
            "agent_id",
            "stream",
            "chunk",
            "ts",
        ]],
        "runtime_ready_for_drain" => &[&[
            "direction",
            "type",
            "kind",
            "runtime_scope",
            "conversation_id",
            "agent_id",
            "runtime_generation",
            "ts",
        ]],
        "runtime_init_timeout" => &[
            &[
                "direction",
                "type",
                "kind",
                "runtime_scope",
                "conversation_id",
                "agent_id",
                "runtime_generation",
                "timeout_reason",
                "elapsed_ms",
                "timeout_ms",
                "retrying",
                "retry_attempt",
                "max_retries",
                "ts",
            ],
            &[
                "direction",
                "type",
                "kind",
                "runtime_scope",
                "conversation_id",
                "agent_id",
                "runtime_generation",
                "timeout_reason",
                "elapsed_ms",
                "timeout_ms",
                "retrying",
                "retry_attempt",
                "max_retries",
                "cooldown_until",
                "ts",
            ],
        ],
        "runtime_init_retrying" => &[&[
            "direction",
            "type",
            "kind",
            "runtime_scope",
            "conversation_id",
            "agent_id",
            "runtime_generation",
            "retry_attempt",
            "max_retries",
            "delay_ms",
            "ts",
        ]],
        "runtime_init_cooldown" => &[&[
            "direction",
            "type",
            "kind",
            "runtime_scope",
            "conversation_id",
            "agent_id",
            "runtime_generation",
            "cooldown_until",
            "attempts_exhausted",
            "ts",
        ]],
        "runtime_compaction_stale" => &[&[
            "direction",
            "type",
            "kind",
            "runtime_scope",
            "conversation_id",
            "agent_id",
            "elapsed_ms",
            "ts",
        ]],
        "runtime_output_dropped" => &[&[
            "direction",
            "type",
            "kind",
            "runtime_scope",
            "conversation_id",
            "agent_id",
            "dropped_count",
            "bytes_dropped",
            "since_ts",
        ]],
        "runtime_output_paused" | "runtime_output_resumed" => &[&[
            "direction",
            "type",
            "kind",
            "runtime_scope",
            "conversation_id",
            "agent_id",
        ]],
        "runtime_parsed_event" => &[&[
            "direction",
            "type",
            "kind",
            "runtime_scope",
            "conversation_id",
            "agent_id",
            "runtime_generation",
            "parsed",
            "ts",
        ]],
        "runtime_parsed_event_dropped" => &[&[
            "direction",
            "type",
            "kind",
            "runtime_scope",
            "conversation_id",
            "agent_id",
            "parsed_kind",
            "encoded_bytes",
            "reason",
            "ts",
        ]],
        "runtime_message_stale" => &[&[
            "direction",
            "type",
            "kind",
            "runtime_scope",
            "conversation_id",
            "agent_id",
            "runtime_generation",
            "ts",
        ]],
        _ => {
            return Err(serde_json::Error::custom(
                "unsupported daemon product event kind",
            ));
        }
    };
    let object = value
        .as_object()
        .ok_or_else(|| serde_json::Error::custom("daemon event must be an object"))?;
    if !expected
        .iter()
        .any(|keys| object.len() == keys.len() && keys.iter().all(|key| object.contains_key(*key)))
    {
        return Err(serde_json::Error::custom(
            "daemon event keys do not match the published arm",
        ));
    }
    let event = match kind {
        "runtime_state" => body(value).map(RuntimeProductEvent::State),
        "runtime_output" => body(value).map(RuntimeProductEvent::Output),
        "runtime_ready_for_drain" => body(value).map(RuntimeProductEvent::ReadyForDrain),
        "runtime_init_timeout" => body(value).map(RuntimeProductEvent::InitTimeout),
        "runtime_init_retrying" => body(value).map(RuntimeProductEvent::InitRetrying),
        "runtime_init_cooldown" => body(value).map(RuntimeProductEvent::InitCooldown),
        "runtime_compaction_stale" => body(value).map(RuntimeProductEvent::CompactionStale),
        "runtime_output_dropped" => body(value).map(RuntimeProductEvent::OutputDropped),
        "runtime_output_paused" => body(value).map(RuntimeProductEvent::OutputPaused),
        "runtime_output_resumed" => body(value).map(RuntimeProductEvent::OutputResumed),
        "runtime_parsed_event" => body(value).map(RuntimeProductEvent::Parsed),
        "runtime_parsed_event_dropped" => body(value).map(RuntimeProductEvent::ParsedDropped),
        "runtime_message_stale" => body(value).map(RuntimeProductEvent::MessageStale),
        _ => unreachable!("kind was checked above"),
    }?;
    event.validate()?;
    Ok(event)
}

impl RuntimeProductEvent {
    fn validate(&self) -> Result<(), serde_json::Error> {
        fn positive(value: i64, field: &str) -> Result<(), serde_json::Error> {
            if value > 0 {
                Ok(())
            } else {
                Err(serde_json::Error::custom(format!(
                    "{field} must be positive"
                )))
            }
        }
        fn nonnegative(value: i64, field: &str) -> Result<(), serde_json::Error> {
            if value >= 0 {
                Ok(())
            } else {
                Err(serde_json::Error::custom(format!(
                    "{field} must be nonnegative"
                )))
            }
        }
        fn nonempty(value: &str, field: &str) -> Result<(), serde_json::Error> {
            if value.is_empty() {
                Err(serde_json::Error::custom(format!(
                    "{field} must be non-empty"
                )))
            } else {
                Ok(())
            }
        }
        let coordinate = match self {
            Self::State(event) => {
                positive(event.runtime_generation, "runtime_generation")?;
                &event.coordinate
            }
            Self::Output(event) => &event.coordinate,
            Self::ReadyForDrain(event) => {
                positive(event.runtime_generation, "runtime_generation")?;
                &event.coordinate
            }
            Self::InitTimeout(event) => {
                positive(event.runtime_generation, "runtime_generation")?;
                nonnegative(event.elapsed_ms, "elapsed_ms")?;
                nonnegative(event.timeout_ms, "timeout_ms")?;
                nonnegative(event.retry_attempt, "retry_attempt")?;
                nonnegative(event.max_retries, "max_retries")?;
                if let Some(value) = event.cooldown_until {
                    positive(value, "cooldown_until")?;
                }
                &event.coordinate
            }
            Self::InitRetrying(event) => {
                positive(event.runtime_generation, "runtime_generation")?;
                positive(event.retry_attempt, "retry_attempt")?;
                nonnegative(event.max_retries, "max_retries")?;
                nonnegative(event.delay_ms, "delay_ms")?;
                &event.coordinate
            }
            Self::InitCooldown(event) => {
                positive(event.runtime_generation, "runtime_generation")?;
                positive(event.cooldown_until, "cooldown_until")?;
                nonnegative(event.attempts_exhausted, "attempts_exhausted")?;
                &event.coordinate
            }
            Self::CompactionStale(event) => {
                nonnegative(event.elapsed_ms, "elapsed_ms")?;
                &event.coordinate
            }
            Self::OutputDropped(event) => {
                nonnegative(event.dropped_count, "dropped_count")?;
                nonnegative(event.bytes_dropped, "bytes_dropped")?;
                &event.coordinate
            }
            Self::OutputPaused(event) | Self::OutputResumed(event) => &event.coordinate,
            Self::Parsed(event) => {
                positive(event.runtime_generation, "runtime_generation")?;
                &event.coordinate
            }
            Self::ParsedDropped(event) => {
                nonnegative(event.encoded_bytes, "encoded_bytes")?;
                if event.reason != "frame_too_large" {
                    return Err(serde_json::Error::custom(
                        "invalid parsed-event drop reason",
                    ));
                }
                if !PARSED_EVENT_KINDS.contains(&event.parsed_kind.as_str()) {
                    return Err(serde_json::Error::custom("invalid parsed-event kind"));
                }
                &event.coordinate
            }
            Self::MessageStale(event) => {
                positive(event.runtime_generation, "runtime_generation")?;
                &event.coordinate
            }
        };
        nonempty(&coordinate.conversation_id, "conversation_id")?;
        nonempty(&coordinate.agent_id, "agent_id")?;
        match &coordinate.runtime_scope {
            RuntimeScopeWire::Agent { agent_id } => nonempty(agent_id, "runtime_scope.agent_id")?,
            RuntimeScopeWire::Conversation {
                conversation_id,
                agent_id,
            } => {
                nonempty(conversation_id, "runtime_scope.conversation_id")?;
                nonempty(agent_id, "runtime_scope.agent_id")?;
            }
        }
        if let Self::State(event) = self {
            nonempty(&event.state.run_id, "state.runId")?;
        }
        if let Self::Parsed(event) = self {
            match &event.parsed {
                ParsedEventWire::SessionInit { session_id } => {
                    nonempty(session_id, "parsed.sessionId")?
                }
                ParsedEventWire::ToolCall {
                    name, tool_call_id, ..
                } => {
                    nonempty(name, "parsed.name")?;
                    if let Some(value) = tool_call_id {
                        nonempty(value, "parsed.toolCallId")?;
                    }
                }
                ParsedEventWire::ToolCallInput { tool_call_id, .. } => {
                    nonempty(tool_call_id, "parsed.toolCallId")?
                }
                ParsedEventWire::ToolOutput {
                    name, tool_call_id, ..
                } => {
                    if let Some(value) = name {
                        nonempty(value, "parsed.name")?;
                    }
                    if let Some(value) = tool_call_id {
                        nonempty(value, "parsed.toolCallId")?;
                    }
                }
                ParsedEventWire::TurnEnd { session_id } => {
                    if let Some(value) = session_id {
                        nonempty(value, "parsed.sessionId")?;
                    }
                }
                ParsedEventWire::InputLifecycle { command_uuid, .. } => {
                    nonempty(command_uuid, "parsed.commandUuid")?
                }
                ParsedEventWire::ApiResponse { message, .. } => {
                    nonempty(message, "parsed.message")?
                }
                ParsedEventWire::Thinking { .. }
                | ParsedEventWire::Text { .. }
                | ParsedEventWire::CompactionStarted
                | ParsedEventWire::CompactionFinished
                | ParsedEventWire::Error { .. }
                | ParsedEventWire::Unknown { .. } => {}
            }
        }
        Ok(())
    }
}

const PARSED_EVENT_KINDS: [&str; 13] = [
    "session_init",
    "thinking",
    "text",
    "tool_call",
    "tool_call_input",
    "tool_output",
    "turn_end",
    "compaction_started",
    "compaction_finished",
    "input_lifecycle",
    "api_response",
    "error",
    "unknown",
];
