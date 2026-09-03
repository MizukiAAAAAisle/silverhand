//! Production-only adapters for the three reviewed migration leaves.
//!
//! This module is deliberately composition-owned: it binds consumer-shaped ports
//! to the process's one event hub, unread/attention authorities, participant reads,
//! and daemon runtime.  No permissive or no-op implementation exists here.

use std::{error::Error, fmt, time::Duration};

use serde_json::{Value, json};
use silverhand_backend_core::conversation_messaging::messaging::collaboration::RuntimeControlSeatPort;
use silverhand_backend_core::conversation_messaging::messaging::{
    AddressRefusal, ChannelAccess, DeliveryIntent, DirectPairAllocation, MessageId, TargetAddress,
    task::{
        ExistingSourceTask, SourceMessageId, TaskConversationBoardRead, TaskCreateAdmissionReads,
        TaskCreateConversationState, TaskCreateSourceRef, TaskParticipationReads,
    },
};
use silverhand_backend_core::foundation::persistence::PersistenceFailure;
use silverhand_backend_core::{
    conversation_messaging::messaging::{
        collaboration::{
            activity::observe::{
                CommittedObservation, ObservationAftermath, ObservationEffectFailure,
                ObservedConversation,
            },
            attention_preference::{
                AttentionPreferenceAftermath, AttentionPreferenceEffectFailure,
                ChannelAttentionCommit, WorkspaceAttentionCommit,
            },
            attention_projection::AttentionProjectionPort,
            channel_directory::{
                BoundHumanChannelCreation, ChannelCreationPublicationFailure,
                HumanChannelCreateAftermath,
            },
            channel_lifecycle::{
                BoundChannelArchive, BoundChannelRename, BoundChannelVisibility,
                ChannelArchiveAftermath, ChannelMutationEffectFailure, ChannelRenameAftermath,
                ChannelVisibilityAftermath,
            },
            membership::{
                CommittedMembershipNotice, ConversationMembershipAftermath,
                ConversationMembershipChanged, MembershipRuntimeStop,
            },
            workspace_rename_messaging::ConversationAgentsReadPort,
        },
        post_commit::UnreadPublication,
        task::{BoardKey, TaskEventKind},
        unread::{UnreadAudience, UnreadReadModel},
    },
    foundation::identity::{AgentId, ConversationId, UserId, WorkspaceId},
    host_runtime::{
        runtime_credential::RuntimeScope,
        scope_runtime_stop::{ScopeRuntimeStopPort, ScopeRuntimeStopTarget},
    },
    identity_access::access::{
        WorkspaceMembershipAftermath, WorkspaceMembershipChanged,
        WorkspaceViewerMembershipChangeKind, WorkspaceViewerMembershipChanged,
    },
};
use silverhand_backend_server::{
    conversation_messaging::messaging::{
        collaboration::conversation_log_debug::{
            ConversationLogDebugAdmissionFact, ConversationLogDebugAdmissionPort,
            ConversationLogDebugAdmissionRefusal,
        },
        task::{
            HumanConversationPost, ResolvedPlacement, ResolvedTaskTarget, TaskCreatePairAllocation,
            TaskCreateTargetIntent, TaskCreateTargetResolver, TaskTargetRefusal,
        },
    },
    conversation_messaging::{
        LiveConversationRuntimeDelivery, SealedConversationRuntimeDelivery,
        messaging::task::{TaskAftermathTrigger, TaskEffectExecute},
    },
    foundation::scope_event_transport::ScopeEventHub,
    scheduling::schedule_create::ports::{
        ResolvedScheduleTarget, ScheduleCapabilityDenied, ScheduleManageCapability,
        ScheduleTargetAllocation, ScheduleTargetIntent, ScheduleTargetRefusal,
        ScheduleTargetResolver,
    },
};
use silverhand_backend_sqlite::conversation_messaging::messaging::schedule::{
    CommittedScheduleWake, ProductionCronEvaluator, ScheduleWakePlacement, ScheduleWakeWriteError,
    SqliteScheduleStore, SqliteScheduleWakeWrite, SystemClock as ScheduleSystemClock,
};
use silverhand_backend_sqlite::conversation_messaging::messaging::{
    MessagingStore,
    collaboration::conversation_participation::{
        ConversationParticipationRefusal, SqliteConversationParticipationRead,
    },
};

#[derive(Debug)]
pub(super) struct LaneEffectError(String);

impl LaneEffectError {
    fn from_source(source: impl fmt::Display) -> Self {
        Self(source.to_string())
    }
}

impl fmt::Display for LaneEffectError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.0)
    }
}

impl Error for LaneEffectError {}

#[derive(Clone)]
pub(super) struct ProductionScheduleWake<E, U, D> {
    writer: SqliteScheduleWakeWrite<E>,
    hub: ScopeEventHub,
    unread: U,
    delivery: D,
}

impl<E, U, D> ProductionScheduleWake<E, U, D> {
    pub(super) fn new(
        writer: SqliteScheduleWakeWrite<E>,
        hub: ScopeEventHub,
        unread: U,
        delivery: D,
    ) -> Self {
        Self {
            writer,
            hub,
            unread,
            delivery,
        }
    }
}

impl<E, U, D> ProductionScheduleWake<E, U, D>
where
    U: UnreadReadModel + Clone + Send + Sync + 'static,
    D: SealedConversationRuntimeDelivery,
{
    async fn announce(&self, wake: &CommittedScheduleWake) -> Vec<String> {
        let mut failures = Vec::new();
        if let Err(error) = self
            .hub
            .publish_system_message(&wake.conversation, wake.message.clone())
        {
            failures.push(error.to_string());
        }
        match wake.placement {
            ScheduleWakePlacement::Workspace => {
                if let Err(error) = self
                    .hub
                    .unread_publisher(self.unread.clone())
                    .publish_unread(&wake.conversation)
                    .await
                {
                    failures.push(error.to_string());
                }
            }
            ScheduleWakePlacement::DirectPair => {
                match self.unread.unread_audience(&wake.conversation).await {
                    Ok(Some(UnreadAudience::DirectPair { viewers })) => {
                        for viewer in viewers {
                            if let Err(error) = self
                                .hub
                                .publish_direct_pairs_changed(&viewer, &wake.conversation)
                            {
                                failures.push(error.to_string());
                            }
                        }
                    }
                    Ok(_) => {}
                    Err(error) => failures.push(error.to_string()),
                }
            }
        }
        if let Err(error) = self
            .delivery
            .deliver_to_sealed_recipient(&wake.conversation, &wake.owner, &wake.message_id)
            .await
        {
            failures.push(error.to_string());
        }
        failures
    }
}

impl<E, U, D> silverhand_backend_core::conversation_messaging::messaging::schedule::ScheduleWake
    for ProductionScheduleWake<E, U, D>
where
    E: silverhand_backend_core::conversation_messaging::messaging::environment::SendEntropy
        + silverhand_backend_core::conversation_messaging::messaging::environment::SendClock
        + Clone
        + Send
        + Sync
        + 'static,
    U: UnreadReadModel + Clone + Send + Sync + 'static,
    D: SealedConversationRuntimeDelivery,
{
    async fn deliver(
        &self,
        ctx: silverhand_backend_core::conversation_messaging::messaging::schedule::WakeContext<'_>,
    ) -> Result<(), silverhand_backend_core::conversation_messaging::messaging::schedule::WakeFailed>
    {
        use silverhand_backend_core::conversation_messaging::messaging::schedule::WakeFailed;
        let wake = match self.writer.write(ctx).await {
            Ok(wake) => wake,
            Err(ScheduleWakeWriteError::TargetUnavailable(reason)) => {
                match self.writer.write_dead_target_notice(ctx, &reason).await {
                    Ok(Some(notice)) => {
                        for failure in self.announce(&notice).await {
                            tracing::warn!(
                                failure = silverhand_backend_server::foundation::safe_log_field::safe_display(&failure),
                                "schedule dead-target owner notice effect failed"
                            );
                        }
                    }
                    Ok(None) => {}
                    Err(error) => {
                        tracing::warn!(
                            error =
                                silverhand_backend_server::foundation::safe_log_field::safe_display(
                                    &error
                                ),
                            "schedule dead-target owner notice write failed"
                        )
                    }
                }
                return Err(WakeFailed {
                    reason: reason.to_string(),
                });
            }
            Err(error) => {
                return Err(WakeFailed {
                    reason: error.to_string(),
                });
            }
        };
        let mut failures = self.announce(&wake).await.into_iter();
        if let Some(reason) = failures.next() {
            return Err(WakeFailed { reason });
        }
        Ok(())
    }
}

/// Owned schedule driver.  Its watch sender is also the create route's
/// committed-effect input: a create tightens the next sleep immediately, while
/// the sixty-second branch remains the durable missed-wake backstop.
#[derive(Clone)]
pub(super) struct ScheduleDriverHandle {
    rearm: tokio::sync::watch::Sender<u64>,
}

impl silverhand_backend_core::conversation_messaging::messaging::schedule::ScheduleCreateCommittedEffect
    for ScheduleDriverHandle
{
    async fn rearm_near_timer(&self) -> Result<(), PersistenceFailure> {
        self.rearm.send_modify(|generation| *generation = generation.wrapping_add(1));
        Ok(())
    }
}

impl ScheduleDriverHandle {
    pub(super) async fn start<E, U, D>(
        store: SqliteScheduleStore<ScheduleSystemClock>,
        wake: ProductionScheduleWake<E, U, D>,
    ) -> Result<Self, PersistenceFailure>
    where
        E: silverhand_backend_core::conversation_messaging::messaging::environment::SendEntropy
            + silverhand_backend_core::conversation_messaging::messaging::environment::SendClock
            + Clone
            + Send
            + Sync
            + 'static,
        U: UnreadReadModel + Clone + Send + Sync + 'static,
        D: SealedConversationRuntimeDelivery,
    {
        use silverhand_backend_core::conversation_messaging::messaging::schedule::{
            Clock, process_one,
        };
        let recovered = store.reset_stale_firing().await?;
        if recovered > 0 {
            tracing::warn!(count = recovered, "reset stale schedule fires at startup");
        }
        let (sender, mut receiver) = tokio::sync::watch::channel(0_u64);
        tokio::spawn(async move {
            loop {
                let now = ScheduleSystemClock.now();
                match store.due_candidates(now, 200).await {
                    Ok(candidates) => {
                        for candidate in candidates {
                            if let Err(error) = process_one(
                                &store,
                                &wake,
                                &ScheduleSystemClock,
                                &ProductionCronEvaluator,
                                &candidate,
                            )
                            .await
                            {
                                tracing::error!(
                                    error = silverhand_backend_server::foundation::safe_log_field::safe_display(&error),
                                    schedule_id = candidate.id.as_str(),
                                    "schedule fire failed before settlement"
                                );
                            }
                        }
                    }
                    Err(error) => tracing::error!(
                        error = silverhand_backend_server::foundation::safe_log_field::safe_display(
                            &error
                        ),
                        "schedule due-row sweep failed"
                    ),
                }
                let now = ScheduleSystemClock.now();
                let delay = match store.next_pending_fire_at().await {
                    Ok(Some(next)) => {
                        Duration::from_millis(next.saturating_sub(now).clamp(0, 60_000) as u64)
                    }
                    Ok(None) => Duration::from_secs(60),
                    Err(error) => {
                        tracing::error!(
                            error =
                                silverhand_backend_server::foundation::safe_log_field::safe_display(
                                    &error
                                ),
                            "schedule next-fire read failed"
                        );
                        Duration::from_secs(60)
                    }
                };
                tokio::select! {
                    () = tokio::time::sleep(delay) => {},
                    changed = receiver.changed() => {
                        if changed.is_err() {
                            break;
                        }
                    }
                }
            }
        });
        Ok(Self { rearm: sender })
    }
}

#[derive(Clone)]
pub(super) struct CanonicalTaskTarget<R, B> {
    resolver: R,
    boards: B,
}

impl<R, B> CanonicalTaskTarget<R, B> {
    pub(super) fn new(resolver: R, boards: B) -> Self {
        Self { resolver, boards }
    }
}

impl<R, B> TaskCreateTargetResolver for CanonicalTaskTarget<R, B>
where
    R: TargetAddress + Send + Sync,
    B: TaskConversationBoardRead + Clone + Send + Sync,
{
    type Error = LaneEffectError;

    async fn resolve(
        &self,
        agent: &AgentId,
        address: &str,
        allocation: TaskCreatePairAllocation,
        intent: TaskCreateTargetIntent,
    ) -> Result<Result<ResolvedTaskTarget, TaskTargetRefusal>, Self::Error> {
        let TaskCreatePairAllocation::Permitted = allocation;
        let TaskCreateTargetIntent::Write = intent;
        let resolved = self
            .resolver
            .resolve(
                agent,
                address,
                DirectPairAllocation::Permitted,
                DeliveryIntent::Write,
            )
            .await
            .map_err(LaneEffectError::from_source)?;
        let resolved = match resolved {
            Ok(value) => value,
            Err(refusal) => {
                return Ok(Err(match refusal {
                    AddressRefusal::Malformed => TaskTargetRefusal::Malformed,
                    AddressRefusal::SelfPair => TaskTargetRefusal::SelfPairNotAddressable,
                    AddressRefusal::Unresolved => TaskTargetRefusal::Unresolved,
                    AddressRefusal::ThreadNotInTarget => TaskTargetRefusal::ThreadNotInTarget,
                }));
            }
        };
        let board = self
            .boards
            .conversation_board(&resolved.conversation)
            .await
            .map_err(LaneEffectError::from_source)?
            .ok_or_else(|| LaneEffectError("resolved task target disappeared".into()))?;
        let placement = match board {
            BoardKey::Workspace(workspace) => ResolvedPlacement::Workspace { workspace },
            BoardKey::Pair(_) => ResolvedPlacement::DirectPair,
        };
        Ok(Ok(ResolvedTaskTarget {
            conversation: resolved.conversation,
            thread_root: resolved
                .thread_root
                .map(|root| {
                    silverhand_backend_core::conversation_messaging::messaging::task::ThreadRootId::parse(
                        root.as_str().to_owned(),
                    )
                    .expect("canonical target resolver never returns an empty thread root")
                }),
            placement,
        }))
    }
}

#[derive(Clone)]
pub(super) struct CanonicalScheduleTarget<R>(pub(super) R);

impl<R> ScheduleTargetResolver for CanonicalScheduleTarget<R>
where
    R: TargetAddress + Send + Sync,
{
    type Error = LaneEffectError;

    async fn resolve(
        &self,
        agent: &AgentId,
        address: &str,
        allocation: ScheduleTargetAllocation,
        intent: ScheduleTargetIntent,
    ) -> Result<Result<ResolvedScheduleTarget, ScheduleTargetRefusal>, Self::Error> {
        let ScheduleTargetAllocation::Permitted = allocation;
        let ScheduleTargetIntent::Write = intent;
        let resolved = self
            .0
            .resolve(
                agent,
                address,
                DirectPairAllocation::Permitted,
                DeliveryIntent::Write,
            )
            .await
            .map_err(LaneEffectError::from_source)?;
        Ok(match resolved {
            Ok(value) if value.thread_root.is_some() => {
                Err(ScheduleTargetRefusal::ThreadSuffixUnsupported)
            }
            Ok(value) => Ok(ResolvedScheduleTarget {
                conversation: value.conversation,
            }),
            Err(AddressRefusal::Malformed) => Err(ScheduleTargetRefusal::Malformed),
            Err(AddressRefusal::SelfPair) => Err(ScheduleTargetRefusal::SelfPairNotAddressable),
            Err(AddressRefusal::Unresolved) => Err(ScheduleTargetRefusal::Unresolved),
            Err(AddressRefusal::ThreadNotInTarget) => Err(ScheduleTargetRefusal::ThreadNotInTarget),
        })
    }
}

#[derive(Clone)]
pub(super) struct ScheduleCapability(pub(super) MessagingStore);

impl ScheduleManageCapability for ScheduleCapability {
    type Error = LaneEffectError;

    async fn may_manage_schedules(
        &self,
        agent: &AgentId,
        destination: &ConversationId,
    ) -> Result<Result<(), ScheduleCapabilityDenied>, Self::Error> {
        self.0
            .may_manage_schedules(agent, destination)
            .await
            .map_err(LaneEffectError::from_source)
            .map(|granted| granted.then_some(()).ok_or(ScheduleCapabilityDenied))
    }
}

#[derive(Clone)]
pub(super) struct HumanPost(pub(super) MessagingStore);

impl HumanConversationPost for HumanPost {
    async fn can_post(
        &self,
        viewer: &UserId,
        conversation: &ConversationId,
    ) -> Result<bool, PersistenceFailure> {
        Ok(self.0.may_post(conversation, viewer).await?.is_ok())
    }
}

/// Shared-pool task-create admission/board adapter. Each trait method delegates
/// to the canonical `MessagingStore` implementation rather than copying SQL.
#[derive(Clone)]
pub(super) struct TaskBoards(pub(super) MessagingStore);

impl TaskConversationBoardRead for TaskBoards {
    async fn conversation_board(
        &self,
        conversation: &ConversationId,
    ) -> Result<Option<BoardKey>, PersistenceFailure> {
        use silverhand_backend_core::conversation_messaging::messaging::task::TaskWriteDoorReads;
        let mut store = self.0.clone();
        store.conversation_board(conversation).await
    }
}

impl TaskCreateAdmissionReads for TaskBoards {
    async fn agent_exists(&self, agent: &AgentId) -> Result<bool, PersistenceFailure> {
        self.0.agent_exists(agent).await
    }
    async fn conversation_state(
        &self,
        conversation: &ConversationId,
    ) -> Result<Option<TaskCreateConversationState>, PersistenceFailure> {
        self.0.conversation_state(conversation).await
    }
    async fn source_message(
        &self,
        source: &SourceMessageId,
    ) -> Result<Option<TaskCreateSourceRef>, PersistenceFailure> {
        self.0.source_message(source).await
    }
    async fn task_for_source(
        &self,
        source: &SourceMessageId,
    ) -> Result<Option<ExistingSourceTask>, PersistenceFailure> {
        self.0.task_for_source(source).await
    }
}

impl TaskParticipationReads for TaskBoards {
    async fn is_agent_participant(
        &mut self,
        conversation: &ConversationId,
        agent: &AgentId,
    ) -> Result<bool, PersistenceFailure> {
        self.0.is_agent_participant(conversation, agent).await
    }
    async fn is_user_participant(
        &mut self,
        conversation: &ConversationId,
        user: &UserId,
    ) -> Result<bool, PersistenceFailure> {
        self.0.is_user_participant(conversation, user).await
    }
    async fn agent_participating_conversations(
        &mut self,
        agent: &AgentId,
        conversations: &[ConversationId],
    ) -> Result<std::collections::HashSet<ConversationId>, PersistenceFailure> {
        self.0
            .agent_participating_conversations(agent, conversations)
            .await
    }
}

#[derive(Clone)]
pub(super) struct LogDebugAdmission(pub(super) SqliteConversationParticipationRead);

impl ConversationLogDebugAdmissionPort for LogDebugAdmission {
    type Error = LaneEffectError;

    async fn admit(
        &self,
        viewer: &UserId,
        conversation: &ConversationId,
    ) -> Result<
        Result<ConversationLogDebugAdmissionFact, ConversationLogDebugAdmissionRefusal>,
        Self::Error,
    > {
        match self
            .0
            .read(viewer, conversation)
            .await
            .map_err(LaneEffectError::from_source)?
        {
            Ok(_) => Ok(Ok(ConversationLogDebugAdmissionFact::selected(
                viewer.clone(),
                conversation.clone(),
            ))),
            Err(ConversationParticipationRefusal::NotFound) => {
                Ok(Err(ConversationLogDebugAdmissionRefusal::NotFound))
            }
            Err(ConversationParticipationRefusal::Forbidden) => {
                Ok(Err(ConversationLogDebugAdmissionRefusal::Forbidden))
            }
        }
    }
}

/// Resolves the current conversation-scoped seat immediately before dispatching
/// the daemon hard-stop. Missing/stale seats are already stopped; an exact live
/// `(host, scope, generation)` is the only value allowed onto the transport.
#[derive(Clone)]
pub(super) struct ProductionMembershipRuntimeStop<P, S> {
    seats: P,
    stop: S,
}

impl<P, S> ProductionMembershipRuntimeStop<P, S> {
    pub(super) fn new(seats: P, stop: S) -> Self {
        Self { seats, stop }
    }
}

impl<P, S> MembershipRuntimeStop for ProductionMembershipRuntimeStop<P, S>
where
    P: RuntimeControlSeatPort,
    S: ScopeRuntimeStopPort,
{
    type Error = LaneEffectError;

    async fn stop(
        &self,
        conversation: &ConversationId,
        agent: &AgentId,
    ) -> Result<(), Self::Error> {
        let scope = RuntimeScope::ConversationSlot {
            agent: agent.clone(),
            source: conversation.clone(),
        };
        let Some(snapshot) = self
            .seats
            .snapshot(&scope)
            .await
            .map_err(LaneEffectError::from_source)?
        else {
            return Ok(());
        };
        let bound = snapshot
            .bind(&scope)
            .map_err(LaneEffectError::from_source)?;
        let target = ScopeRuntimeStopTarget::new(
            bound.host().clone(),
            bound.scope().clone(),
            bound.generation(),
        );
        match self
            .stop
            .hard_stop(&target)
            .await
            .map_err(LaneEffectError::from_source)?
        {
            Ok(_) => Ok(()),
            Err(refusal) => Err(LaneEffectError(format!(
                "runtime stop refused: {refusal:?}"
            ))),
        }
    }
}

/// One real effect owner shared by the conversation-control, membership, and task
/// routers.  Its clones retain the same hub and shared-pool read authorities.
#[derive(Clone)]
pub(super) struct LaneEffects<U, A, G, D, S> {
    hub: ScopeEventHub,
    unread: U,
    attention: A,
    agents: G,
    delivery: D,
    runtime_stop: S,
}

impl<U, A, G, D, S> LaneEffects<U, A, G, D, S> {
    pub(super) fn new(
        hub: ScopeEventHub,
        unread: U,
        attention: A,
        agents: G,
        delivery: D,
        runtime_stop: S,
    ) -> Self {
        Self {
            hub,
            unread,
            attention,
            agents,
            delivery,
            runtime_stop,
        }
    }
}

impl<U, A, G, D, S> MembershipRuntimeStop for LaneEffects<U, A, G, D, S>
where
    U: Clone + Send + Sync + 'static,
    A: Clone + Send + Sync + 'static,
    G: Clone + Send + Sync + 'static,
    D: Clone + Send + Sync + 'static,
    S: MembershipRuntimeStop + Clone + Send + Sync + 'static,
{
    type Error = LaneEffectError;

    async fn stop(
        &self,
        conversation: &ConversationId,
        agent: &AgentId,
    ) -> Result<(), Self::Error> {
        self.runtime_stop
            .stop(conversation, agent)
            .await
            .map_err(LaneEffectError::from_source)
    }
}

impl<U, A, G, D, S> LaneEffects<U, A, G, D, S>
where
    U: UnreadReadModel + Clone + Send + Sync,
    A: AttentionProjectionPort + Clone + Send + Sync,
    G: Sync,
    D: Sync,
    S: Sync,
{
    async fn publish_badge(
        &self,
        viewer: &UserId,
        workspace: &WorkspaceId,
    ) -> Result<(), LaneEffectError> {
        let rollup = self
            .attention
            .badges(viewer)
            .await
            .map_err(LaneEffectError::from_source)?;
        let count = rollup
            .by_workspace()
            .iter()
            .find(|row| row.workspace() == workspace)
            .map_or(0, |row| row.count().get());
        self.hub
            .publish_attention_badge(viewer, workspace, count)
            .map_err(LaneEffectError::from_source)
    }

    async fn publish_unread(&self, conversation: &ConversationId) -> Result<(), LaneEffectError> {
        self.hub
            .unread_publisher(self.unread.clone())
            .publish_unread(conversation)
            .await
            .map_err(LaneEffectError::from_source)
    }
}

impl<U, A, G, D, S> ObservationAftermath for LaneEffects<U, A, G, D, S>
where
    U: UnreadReadModel + Clone + Send + Sync,
    A: AttentionProjectionPort + Clone + Send + Sync,
    G: Sync,
    D: Sync,
    S: Sync,
{
    async fn conversation_changed(
        &self,
        _fact: &CommittedObservation,
        conversation: &ObservedConversation,
    ) -> Result<(), ObservationEffectFailure> {
        self.publish_unread(conversation.conversation())
            .await
            .map_err(ObservationEffectFailure::from_source)
    }

    async fn badge_changed(
        &self,
        fact: &CommittedObservation,
        workspace: &WorkspaceId,
    ) -> Result<(), ObservationEffectFailure> {
        self.publish_badge(fact.viewer(), workspace)
            .await
            .map_err(ObservationEffectFailure::from_source)
    }

    async fn notifications_dismissed(
        &self,
        fact: &CommittedObservation,
    ) -> Result<(), ObservationEffectFailure> {
        self.hub
            .publish_notification_dismissals(
                fact.viewer(),
                fact.dismissed_notifications()
                    .iter()
                    .map(|id| id.as_str().to_owned())
                    .collect(),
            )
            .map_err(ObservationEffectFailure::from_source)
    }
}

impl<U, A, G, D, S> AttentionPreferenceAftermath for LaneEffects<U, A, G, D, S>
where
    U: UnreadReadModel + Clone + Send + Sync,
    A: AttentionProjectionPort + Clone + Send + Sync,
    G: Sync,
    D: Sync,
    S: Sync,
{
    async fn channel_preference_changed(
        &self,
        fact: &impl ChannelAttentionCommit,
    ) -> Result<(), AttentionPreferenceEffectFailure> {
        self.hub
            .publish_attention_preference_changed(
                fact.viewer(),
                fact.workspace(),
                Some(fact.conversation()),
            )
            .map_err(AttentionPreferenceEffectFailure::from_source)
    }

    async fn channel_badge_changed(
        &self,
        fact: &impl ChannelAttentionCommit,
    ) -> Result<(), AttentionPreferenceEffectFailure> {
        self.publish_badge(fact.viewer(), fact.workspace())
            .await
            .map_err(AttentionPreferenceEffectFailure::from_source)
    }

    async fn workspace_preference_changed(
        &self,
        fact: &impl WorkspaceAttentionCommit,
    ) -> Result<(), AttentionPreferenceEffectFailure> {
        self.hub
            .publish_attention_preference_changed(fact.viewer(), fact.workspace(), None)
            .map_err(AttentionPreferenceEffectFailure::from_source)
    }

    async fn workspace_badge_changed(
        &self,
        fact: &impl WorkspaceAttentionCommit,
    ) -> Result<(), AttentionPreferenceEffectFailure> {
        self.publish_badge(fact.viewer(), fact.workspace())
            .await
            .map_err(AttentionPreferenceEffectFailure::from_source)
    }
}

impl<U, A, G, D, S> HumanChannelCreateAftermath for LaneEffects<U, A, G, D, S>
where
    U: Sync,
    A: Sync,
    G: Sync,
    D: Sync,
    S: Sync,
{
    async fn workspace_channels_changed(
        &self,
        fact: &BoundHumanChannelCreation,
    ) -> Result<(), ChannelCreationPublicationFailure> {
        self.hub
            .publish_workspace_channels_changed(fact.workspace(), fact.channel().conversation())
            .map_err(ChannelCreationPublicationFailure::from_source)
    }

    fn title_address_taken(&self, fact: &BoundHumanChannelCreation) {
        tracing::warn!(
            workspace_id = fact.workspace().as_str(),
            conversation_id = fact.channel().conversation().as_str(),
            title_key = fact.address().key(),
            "channel title address committed"
        );
    }
}

impl<U, A, G, D, S> ChannelVisibilityAftermath for LaneEffects<U, A, G, D, S>
where
    U: Sync,
    A: Sync,
    G: Sync,
    D: Sync,
    S: Sync,
{
    async fn workspace_channels_changed(
        &self,
        fact: &BoundChannelVisibility,
    ) -> Result<(), ChannelMutationEffectFailure> {
        self.hub
            .publish_workspace_channels_changed(fact.workspace(), fact.row().conversation())
            .map_err(ChannelMutationEffectFailure::from_source)
    }
}

impl<U, A, G, D, S> ChannelArchiveAftermath for LaneEffects<U, A, G, D, S>
where
    U: UnreadReadModel + Clone + Send + Sync + 'static,
    A: AttentionProjectionPort + Clone + Send + Sync + 'static,
    G: ConversationAgentsReadPort + Clone + Send + Sync + 'static,
    D: Clone + Send + Sync + 'static,
    S: MembershipRuntimeStop + Clone + Send + Sync + 'static,
{
    fn start_runtime_cleanup(&self, fact: &BoundChannelArchive) {
        let conversation = fact.row().conversation().clone();
        let agents = self.agents.clone();
        let stop = self.runtime_stop.clone();
        tokio::spawn(async move {
            match agents.agent_ids(&conversation).await {
                Ok(recipients) => {
                    for agent in recipients {
                        if let Err(error) = stop.stop(&conversation, &agent).await {
                            tracing::warn!(
                                error = silverhand_backend_server::foundation::safe_log_field::safe_display(&error),
                                conversation_id = conversation.as_str(),
                                agent_id = agent.as_str(),
                                "archived-channel runtime stop failed"
                            );
                        }
                    }
                }
                Err(error) => {
                    tracing::warn!(
                        error = silverhand_backend_server::foundation::safe_log_field::safe_display(
                            &error
                        ),
                        conversation_id = conversation.as_str(),
                        "archived-channel runtime audience read failed"
                    )
                }
            }
        });
    }

    async fn workspace_channels_changed(
        &self,
        fact: &BoundChannelArchive,
    ) -> Result<(), ChannelMutationEffectFailure> {
        self.hub
            .publish_workspace_channels_changed(fact.workspace(), fact.row().conversation())
            .map_err(ChannelMutationEffectFailure::from_source)
    }

    async fn unread_updated(
        &self,
        fact: &BoundChannelArchive,
    ) -> Result<(), ChannelMutationEffectFailure> {
        self.publish_unread(fact.row().conversation())
            .await
            .map_err(ChannelMutationEffectFailure::from_source)
    }
}

impl<U, A, G, D, S> ChannelRenameAftermath for LaneEffects<U, A, G, D, S>
where
    U: Sync,
    A: Sync,
    G: Sync,
    D: SealedConversationRuntimeDelivery,
    S: Sync,
{
    fn title_address_moved(&self, fact: &BoundChannelRename) {
        tracing::warn!(
            workspace_id = fact.workspace().as_str(),
            conversation_id = fact.row().conversation().as_str(),
            from_key = fact.old().map(|title| title.key()),
            to_key = fact.requested().key(),
            "channel title address moved"
        );
    }

    async fn deliver(
        &self,
        fact: &BoundChannelRename,
        recipient: &AgentId,
    ) -> Result<(), ChannelMutationEffectFailure> {
        self.delivery
            .deliver_to_sealed_recipient(
                fact.row().conversation(),
                recipient,
                fact.notice()
                    .expect("changed rename owns a notice")
                    .message(),
            )
            .await
            .map_err(ChannelMutationEffectFailure::from_source)
    }

    async fn publish_message(
        &self,
        fact: &BoundChannelRename,
    ) -> Result<(), ChannelMutationEffectFailure> {
        let notice = fact.notice().expect("changed rename owns a notice");
        self.hub
            .publish_system_message(
                notice.conversation(),
                json!({
                    "id": notice.message().as_str(),
                    "conversation_id": notice.conversation().as_str(),
                    "from_kind": "system",
                    "from_agent_id": Value::Null,
                    "from_user_id": Value::Null,
                    "author": Value::Null,
                    "content": notice.content(),
                    "metadata": {"subtype":"rename","old_name":notice.old().title(),"new_name":notice.new_title().title(),"scope":"conversation"},
                    "attachments": Value::Null,
                    "reactions": Value::Null,
                    "seq": notice.seq().get(),
                    "created_at": notice.created_at(),
                    "thread_root_id": Value::Null,
                    "linked_task": Value::Null,
                }),
            )
            .map_err(ChannelMutationEffectFailure::from_source)
    }

    async fn workspace_channels_changed(
        &self,
        fact: &BoundChannelRename,
    ) -> Result<(), ChannelMutationEffectFailure> {
        self.hub
            .publish_workspace_channels_changed(fact.workspace(), fact.row().conversation())
            .map_err(ChannelMutationEffectFailure::from_source)
    }
}

fn membership_message(notice: &CommittedMembershipNotice) -> Result<Value, serde_json::Error> {
    let metadata = serde_json::from_str::<serde_json::Map<String, Value>>(&notice.metadata)?;
    Ok(json!({
        "id": notice.message_id.as_str(),
        "conversation_id": notice.conversation_id.as_str(),
        "from_kind": "system",
        "from_agent_id": Value::Null,
        "from_user_id": Value::Null,
        "author": Value::Null,
        "content": notice.content,
        "metadata": Value::Object(metadata),
        "attachments": Value::Null,
        "reactions": Value::Null,
        "seq": notice.seq,
        "created_at": notice.created_at,
        "thread_root_id": Value::Null,
        "linked_task": Value::Null,
    }))
}

impl<U, A, G, D, S> LaneEffects<U, A, G, D, S>
where
    G: ConversationAgentsReadPort + Clone + Send + Sync,
    D: LiveConversationRuntimeDelivery,
{
    async fn announce_membership_notice(
        &self,
        notice: &CommittedMembershipNotice,
    ) -> Result<(), LaneEffectError> {
        let mut first = match membership_message(notice) {
            Ok(message) => self
                .hub
                .publish_system_message(&notice.conversation_id, message)
                .err()
                .map(LaneEffectError::from_source),
            Err(error) => Some(LaneEffectError::from_source(error)),
        };
        match self.agents.agent_ids(&notice.conversation_id).await {
            Ok(recipients) => {
                for agent in recipients {
                    if let Err(error) = self
                        .delivery
                        .deliver_to_live_recipient(
                            &notice.conversation_id,
                            &agent,
                            &notice.message_id,
                        )
                        .await
                        && first.is_none()
                    {
                        first = Some(LaneEffectError::from_source(error));
                    }
                }
            }
            Err(error) if first.is_none() => first = Some(LaneEffectError::from_source(error)),
            Err(_) => {}
        }
        if let Some(error) = first {
            return Err(error);
        }
        Ok(())
    }
}

impl<U, A, G, D, S> ConversationMembershipAftermath for LaneEffects<U, A, G, D, S>
where
    U: Clone + Send + Sync + 'static,
    A: Clone + Send + Sync + 'static,
    G: ConversationAgentsReadPort + Clone + Send + Sync + 'static,
    D: LiveConversationRuntimeDelivery,
    S: Clone + Send + Sync + 'static,
{
    type Error = LaneEffectError;

    async fn announce(&self, changed: &ConversationMembershipChanged) -> Result<(), Self::Error> {
        let mut first = None;
        if let Some(notice) = &changed.notice
            && let Err(error) = self.announce_membership_notice(notice).await
        {
            first = Some(error);
        }
        if let Err(error) = self
            .hub
            .publish_conversation_members_changed(&changed.conversation_id, &changed.workspace_id)
            && first.is_none()
        {
            first = Some(LaneEffectError::from_source(error));
        }
        if let Err(error) = self
            .hub
            .publish_workspace_channels_changed(&changed.workspace_id, &changed.conversation_id)
            && first.is_none()
        {
            first = Some(LaneEffectError::from_source(error));
        }
        if let Some(viewer) = &changed.workspace_enrolled_human
            && let Err(error) = self.hub.publish_viewer_workspace_membership_changed(
                viewer,
                &changed.workspace_id,
                "added",
                Some("member"),
            )
            && first.is_none()
        {
            first = Some(LaneEffectError::from_source(error));
        }
        first.map_or(Ok(()), Err)
    }
}

impl<U, A, G, D, S> WorkspaceMembershipAftermath for LaneEffects<U, A, G, D, S>
where
    U: Clone + Send + Sync + 'static,
    A: Clone + Send + Sync + 'static,
    G: ConversationAgentsReadPort + Clone + Send + Sync + 'static,
    D: LiveConversationRuntimeDelivery,
    S: Clone + Send + Sync + 'static,
{
    type Error = LaneEffectError;

    async fn announce(&self, changed: &WorkspaceMembershipChanged) -> Result<(), Self::Error> {
        let mut first = None;
        for notice in &changed.notices {
            if let Err(error) = self.announce_membership_notice(notice).await
                && first.is_none()
            {
                first = Some(error);
            }
            if let Err(error) = self
                .hub
                .publish_conversation_members_changed(&notice.conversation_id, &notice.workspace_id)
                && first.is_none()
            {
                first = Some(LaneEffectError::from_source(error));
            }
            if let Err(error) = self
                .hub
                .publish_workspace_channels_changed(&notice.workspace_id, &notice.conversation_id)
                && first.is_none()
            {
                first = Some(LaneEffectError::from_source(error));
            }
        }
        if let Some(viewer) = &changed.viewer
            && let Err(error) = self.announce_viewer(viewer).await
            && first.is_none()
        {
            first = Some(error);
        }
        first.map_or(Ok(()), Err)
    }

    async fn announce_viewer(
        &self,
        changed: &WorkspaceViewerMembershipChanged,
    ) -> Result<(), Self::Error> {
        let (change, role) = match changed.kind {
            WorkspaceViewerMembershipChangeKind::RoleChanged => {
                ("role_changed", changed.role.map(|role| role.as_str()))
            }
            WorkspaceViewerMembershipChangeKind::Removed => ("removed", None),
        };
        self.hub
            .publish_viewer_workspace_membership_changed(
                &changed.user_id,
                &changed.workspace_id,
                change,
                role,
            )
            .map_err(LaneEffectError::from_source)
    }
}

fn task_changed_payload(trigger: &TaskAftermathTrigger) -> Value {
    let task = trigger.committed();
    let kind = match task.kind {
        TaskEventKind::Create => "create",
        TaskEventKind::Claim => "claim",
        TaskEventKind::Unclaim => "unclaim",
        TaskEventKind::Status => "status",
        TaskEventKind::Edit => "edit",
    };
    json!({
        "kind": kind,
        "workspace_id": task.board.workspace_id().map(|id| id.as_str()),
        "thread_root_id": task.thread_root_id.as_ref().map(|id| id.as_str()),
        "conversation_id": task.conversation_id.as_str(),
        "task_number": task.task_number.get(),
        "task_id": task.task_id.as_str(),
        "source_message_id": task.source_message_id.as_ref().map(|id| id.as_str()),
        "status": task.status.as_str(),
        "assignee": task.assignee.as_ref().map(|value| value.to_json()),
        "title": task.title.as_str(),
        "closed_at": task.closed_at,
    })
}

fn task_message(trigger: &TaskAftermathTrigger) -> Result<Value, serde_json::Error> {
    let event = &trigger.committed().event_message;
    let metadata = serde_json::from_str::<serde_json::Map<String, Value>>(&event.message.metadata)?;
    Ok(json!({
        "id": event.id.as_str(),
        "conversation_id": event.conversation_id.as_str(),
        "from_kind": "system",
        "from_agent_id": Value::Null,
        "from_user_id": Value::Null,
        "author": Value::Null,
        "content": event.message.content,
        "metadata": Value::Object(metadata),
        "attachments": Value::Null,
        "reactions": Value::Null,
        "seq": event.seq,
        "created_at": event.created_at,
        "thread_root_id": event.thread_root_id.as_ref().map(|id| id.as_str()),
        "linked_task": Value::Null,
    }))
}

impl<U, A, G, D, S> TaskEffectExecute for LaneEffects<U, A, G, D, S>
where
    U: UnreadReadModel + Clone + Send + Sync + 'static,
    A: Clone + Send + Sync + 'static,
    G: ConversationAgentsReadPort + Clone + Send + Sync + 'static,
    D: LiveConversationRuntimeDelivery,
    S: Clone + Send + Sync + 'static,
{
    async fn execute_task_effects(&self, trigger: &TaskAftermathTrigger) -> Vec<String> {
        let mut failures = Vec::new();
        let task = trigger.committed();
        if trigger.plan().publish_event() {
            match task_message(trigger) {
                Ok(message) => {
                    if let Err(error) = self
                        .hub
                        .publish_system_message(&task.conversation_id, message)
                    {
                        failures.push(error.to_string());
                    }
                }
                Err(error) => failures.push(error.to_string()),
            }
        }
        let payload = task_changed_payload(trigger);
        if trigger.plan().patch_conversation_board()
            && let Err(error) = self
                .hub
                .publish_task_changed_to_conversation(&task.conversation_id, payload.clone())
        {
            failures.push(error.to_string());
        }
        if trigger.plan().patch_viewer_boards() {
            match self.unread.unread_audience(&task.conversation_id).await {
                Ok(Some(UnreadAudience::Workspace { viewers, .. })) => {
                    for viewer in viewers {
                        if let Err(error) = self
                            .hub
                            .publish_task_changed_to_viewer(&viewer.viewer, payload.clone())
                        {
                            failures.push(error.to_string());
                        }
                    }
                }
                Ok(Some(UnreadAudience::DirectPair { viewers })) => {
                    for viewer in viewers {
                        if let Err(error) = self
                            .hub
                            .publish_task_changed_to_viewer(&viewer, payload.clone())
                        {
                            failures.push(error.to_string());
                        }
                    }
                }
                Ok(None) => {}
                Err(error) => failures.push(error.to_string()),
            }
        }
        if trigger.plan().wake_participants() {
            let committed_message_id = MessageId::parse(task.event_message.id.as_str())
                .expect("committed task event id is a message identity");
            match self.agents.agent_ids(&task.conversation_id).await {
                Ok(agents) => {
                    for agent in agents {
                        if trigger.plan().excluded_wake_agent() == Some(&agent) {
                            continue;
                        }
                        if let Err(error) = self
                            .delivery
                            .deliver_to_live_recipient(
                                &task.conversation_id,
                                &agent,
                                &committed_message_id,
                            )
                            .await
                        {
                            failures.push(error.to_string());
                        }
                    }
                }
                Err(error) => failures.push(error.to_string()),
            }
        }
        if trigger.plan().cross_operation_audit()
            && let Some(audit) = trigger.cross_operation_audit()
        {
            tracing::warn!(
                op = "task_cross_op",
                source_conversation_id = audit.source().conversation_id().as_str(),
                source_workspace_id = audit.source().workspace_id().map(|id| id.as_str()),
                owner_conversation_id = audit.owner_conversation_id().as_str(),
                owner_workspace_id = audit.owner_workspace_id().map(|id| id.as_str()),
                task_number = task.task_number.get(),
                "task cross-conversation operation"
            );
        }
        failures
    }
}

#[cfg(test)]
mod tests {
    use std::{
        convert::Infallible,
        sync::{
            Arc,
            atomic::{AtomicUsize, Ordering},
        },
    };

    use silverhand_backend_core::conversation_messaging::messaging::{
        MessageId,
        collaboration::workspace_rename_messaging::ConversationAgentsReadPort,
        post_commit::EffectFailure,
        task::{
            CreatedEventMessageId, TaskCommittedEventMessage, TaskEventMessage, TaskId,
            TaskMutationWitness, TaskNumber, TaskStatus, TaskTitle,
        },
    };

    use super::*;

    #[derive(Clone)]
    struct Agents(AgentId);

    impl ConversationAgentsReadPort for Agents {
        type Error = Infallible;

        async fn agent_ids(&self, _: &ConversationId) -> Result<Vec<AgentId>, Self::Error> {
            Ok(vec![self.0.clone()])
        }
    }

    #[derive(Clone, Default)]
    struct Delivery(Arc<AtomicUsize>);

    impl LiveConversationRuntimeDelivery for Delivery {
        async fn deliver_to_live_recipient(
            &self,
            _: &ConversationId,
            _: &AgentId,
            _: &MessageId,
        ) -> Result<(), EffectFailure> {
            self.0.fetch_add(1, Ordering::SeqCst);
            Ok(())
        }
    }

    impl SealedConversationRuntimeDelivery for Delivery {
        async fn deliver_to_sealed_recipient(
            &self,
            _: &ConversationId,
            _: &AgentId,
            _: &MessageId,
        ) -> Result<(), EffectFailure> {
            self.0.fetch_add(1, Ordering::SeqCst);
            Ok(())
        }
    }

    #[derive(Clone)]
    struct Unread;

    impl UnreadReadModel for Unread {
        async fn unread_audience(
            &self,
            _: &ConversationId,
        ) -> Result<Option<UnreadAudience>, PersistenceFailure> {
            Ok(None)
        }
    }

    #[tokio::test]
    async fn malformed_membership_metadata_is_observable_and_does_not_skip_delivery() {
        let delivery = Delivery::default();
        let effects = LaneEffects::new(
            ScopeEventHub::production().unwrap(),
            (),
            (),
            Agents(AgentId::parse("recipient").unwrap()),
            delivery.clone(),
            (),
        );
        for (index, metadata) in ["{not-json", "null", "[]", "\"scalar\""]
            .into_iter()
            .enumerate()
        {
            let notice = CommittedMembershipNotice {
                conversation_id: ConversationId::parse("conversation").unwrap(),
                workspace_id: WorkspaceId::parse("workspace").unwrap(),
                message_id: MessageId::parse(format!("message-{index}")).unwrap(),
                content: "committed".to_owned(),
                metadata: metadata.to_owned(),
                seq: 1,
                created_at: 1,
            };

            assert!(effects.announce_membership_notice(&notice).await.is_err());
            assert!(membership_message(&notice).is_err());
        }
        assert_eq!(delivery.0.load(Ordering::SeqCst), 4);
    }

    #[tokio::test]
    async fn malformed_task_metadata_is_observable_and_does_not_skip_live_wake() {
        let delivery = Delivery::default();
        let effects = LaneEffects::new(
            ScopeEventHub::production().unwrap(),
            Unread,
            (),
            Agents(AgentId::parse("recipient").unwrap()),
            delivery.clone(),
            (),
        );
        let conversation = ConversationId::parse("conversation").unwrap();
        for (index, metadata) in ["{not-json", "null", "[]", "\"scalar\""]
            .into_iter()
            .enumerate()
        {
            let witness = TaskMutationWitness {
                kind: TaskEventKind::Create,
                task_id: TaskId::parse(format!("task-{index}")).unwrap(),
                task_number: TaskNumber::new(index as i64 + 1).unwrap(),
                event_message: TaskCommittedEventMessage::new(
                    CreatedEventMessageId::parse(format!("message-{index}")).unwrap(),
                    conversation.clone(),
                    None,
                    TaskEventMessage {
                        content: "committed".to_owned(),
                        metadata: metadata.to_owned(),
                    },
                    1,
                    1,
                ),
                conversation_id: conversation.clone(),
                board: BoardKey::Workspace(WorkspaceId::parse("workspace").unwrap()),
                thread_root_id: None,
                title: TaskTitle::parse("task").unwrap(),
                status: TaskStatus::Todo,
                assignee: None,
                closed_at: None,
                source_message_id: None,
            };
            let trigger =
                TaskAftermathTrigger::for_human(witness, UserId::parse("viewer").unwrap());

            let failures = effects.execute_task_effects(&trigger).await;
            assert!(!failures.is_empty());
            assert!(task_message(&trigger).is_err());
        }
        assert_eq!(delivery.0.load(Ordering::SeqCst), 4);
    }
}
