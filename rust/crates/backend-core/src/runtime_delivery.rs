//! Durable inbox custody and daemon delivery facts.

use std::future::Future;

use thiserror::Error;

use crate::{
    identity::{AgentId, ConversationId, DaemonInstanceId, UserId, WorkspaceId},
    messaging::{AddressedPrincipals, FromKind, MessageContent, PrincipalKind, ReferencePositions},
    persistence::PersistenceFailure,
    runtime_credential::{RuntimePrincipal, RuntimeScope},
};

pub const MAX_DELIVERIES_PER_BATCH: usize = 20;
pub const MAX_ENCODED_DELIVERY_BYTES: usize = 256 * 1024;

#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub struct DeliveryLeaseOwner(String);

impl DeliveryLeaseOwner {
    pub fn parse(raw: impl Into<String>) -> Result<Self, EmptyDeliveryLeaseOwner> {
        let raw = raw.into();
        if raw.is_empty() {
            return Err(EmptyDeliveryLeaseOwner);
        }
        Ok(Self(raw))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

#[derive(Debug, Error)]
#[error("delivery lease owner must not be empty")]
pub struct EmptyDeliveryLeaseOwner;

#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub struct InboxDeliveryId(i64);

impl InboxDeliveryId {
    pub fn parse(raw: i64) -> Result<Self, InvalidInboxDeliveryId> {
        (raw > 0).then_some(Self(raw)).ok_or(InvalidInboxDeliveryId)
    }

    pub fn as_i64(self) -> i64 {
        self.0
    }
}

#[derive(Debug, Error)]
#[error("inbox delivery id must be positive")]
pub struct InvalidInboxDeliveryId;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum DeliveryInstruction {
    UserForRecipient,
    UserForOther,
    NonSystemMention,
    System,
    Other,
}

pub fn classify_delivery_instruction(
    from: FromKind,
    content: &MessageContent,
    recipient_agent_name: &str,
    positions: &impl ReferencePositions,
) -> DeliveryInstruction {
    let references = AddressedPrincipals::derive(content, positions);
    let addresses_recipient = references.iter().any(|reference| {
        reference.kind() == PrincipalKind::Agent
            && reference.handle().as_str() == recipient_agent_name
    });
    match from {
        FromKind::User if references.is_empty() || addresses_recipient => {
            DeliveryInstruction::UserForRecipient
        }
        FromKind::User => DeliveryInstruction::UserForOther,
        FromKind::Agent if addresses_recipient => DeliveryInstruction::NonSystemMention,
        FromKind::Agent => DeliveryInstruction::Other,
        FromKind::System => DeliveryInstruction::System,
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ClaimedInboxDelivery {
    id: InboxDeliveryId,
    seq: i64,
    presentation: String,
    instruction: DeliveryInstruction,
}

impl ClaimedInboxDelivery {
    pub fn decoded(
        id: InboxDeliveryId,
        seq: i64,
        presentation: String,
        instruction: DeliveryInstruction,
    ) -> Self {
        Self {
            id,
            seq,
            presentation,
            instruction,
        }
    }

    pub fn id(&self) -> InboxDeliveryId {
        self.id
    }

    pub fn seq(&self) -> i64 {
        self.seq
    }

    pub fn presentation(&self) -> &str {
        &self.presentation
    }

    pub fn instruction(&self) -> DeliveryInstruction {
        self.instruction
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ClaimedInboxBatch {
    principal: RuntimePrincipal,
    conversation: ConversationId,
    owner: DeliveryLeaseOwner,
    deliveries: Vec<ClaimedInboxDelivery>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ClaimPendingInbox {
    Empty,
    StaleCustody,
    Claimed(ClaimedInboxBatch),
}

impl ClaimedInboxBatch {
    pub fn claimed(
        principal: RuntimePrincipal,
        conversation: ConversationId,
        owner: DeliveryLeaseOwner,
        deliveries: Vec<ClaimedInboxDelivery>,
    ) -> Option<Self> {
        (!deliveries.is_empty()).then_some(Self {
            principal,
            conversation,
            owner,
            deliveries,
        })
    }

    pub fn principal(&self) -> &RuntimePrincipal {
        &self.principal
    }

    pub fn conversation(&self) -> &ConversationId {
        &self.conversation
    }

    pub fn owner(&self) -> &DeliveryLeaseOwner {
        &self.owner
    }

    pub fn deliveries(&self) -> &[ClaimedInboxDelivery] {
        &self.deliveries
    }

    pub fn delivery_ids(&self) -> Vec<InboxDeliveryId> {
        self.deliveries
            .iter()
            .map(ClaimedInboxDelivery::id)
            .collect()
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum RuntimeDeliveryFailureReason {
    ChildExit,
    InitWatchdog,
    WriteFailed,
    DriverRefused,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum InboxSettlementDisposition {
    Applied,
    Duplicate,
    Stale,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum RuntimeMember {
    Agent {
        id: AgentId,
        name: String,
        display_name: String,
        runtime: String,
    },
    Human {
        id: UserId,
        name: String,
        display_name: String,
    },
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum RuntimePlacement {
    Workspace,
    DirectPair,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum RuntimeRoster {
    Open,
    Fixed,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RuntimeWorkspaceRef {
    id: WorkspaceId,
    name: String,
}

impl RuntimeWorkspaceRef {
    pub fn decoded(id: WorkspaceId, name: String) -> Self {
        Self { id, name }
    }

    pub fn id(&self) -> &WorkspaceId {
        &self.id
    }

    pub fn name(&self) -> &str {
        &self.name
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RuntimeAgentSpec {
    pub id: AgentId,
    pub name: String,
    pub runtime: String,
    pub model: Option<String>,
    pub reasoning_effort: Option<String>,
    pub fast_mode: Option<bool>,
    pub cli_session_id: Option<String>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RuntimeSessionSpec {
    pub conversation: ConversationId,
    pub placement: RuntimePlacement,
    pub roster: RuntimeRoster,
    pub title: String,
    pub spawned_by_agent: Option<AgentId>,
    pub members: Vec<RuntimeMember>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RuntimeSpawnPlan {
    pub scope: RuntimeScope,
    pub agent: RuntimeAgentSpec,
    pub workspace: Option<RuntimeWorkspaceRef>,
    pub workspace_memory_index: Vec<RuntimeWorkspaceRef>,
    pub session: Option<RuntimeSessionSpec>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RuntimeDispatchTarget {
    pub host_id: String,
    pub conversation: ConversationId,
    pub plan: RuntimeSpawnPlan,
}

pub trait RuntimeDispatchReadPort: Clone + Send + Sync + 'static {
    fn resolve_dispatch_target(
        &self,
        conversation: ConversationId,
        agent: AgentId,
    ) -> impl Future<Output = Result<Option<RuntimeDispatchTarget>, PersistenceFailure>> + Send;

    /// Returns every currently claimed slot placed on one host. Hydration must
    /// see old daemon generations as well as the newly attached daemon so a
    /// process restart cannot strand custody behind the previous instance id.
    fn current_custodies_for_host(
        &self,
        host_id: String,
    ) -> impl Future<Output = Result<Vec<RuntimePrincipal>, PersistenceFailure>> + Send;
}

pub trait RuntimeInboxCustodyPort: Clone + Send + Sync + 'static {
    #[allow(clippy::too_many_arguments)]
    fn claim_pending<P: ReferencePositions + Sync>(
        &self,
        host_id: String,
        principal: RuntimePrincipal,
        conversation: ConversationId,
        owner: DeliveryLeaseOwner,
        now_ms: i64,
        lease_ttl_ms: i64,
        reference_positions: &P,
    ) -> impl Future<Output = Result<ClaimPendingInbox, PersistenceFailure>> + Send;

    fn settle_consumed(
        &self,
        host_id: String,
        principal: RuntimePrincipal,
        conversation: ConversationId,
        owner: DeliveryLeaseOwner,
        delivery_ids: Vec<InboxDeliveryId>,
        observed_at_ms: i64,
    ) -> impl Future<Output = Result<InboxSettlementDisposition, PersistenceFailure>> + Send;

    #[allow(clippy::too_many_arguments)]
    fn settle_failed(
        &self,
        host_id: String,
        principal: RuntimePrincipal,
        conversation: ConversationId,
        owner: DeliveryLeaseOwner,
        delivery_ids: Vec<InboxDeliveryId>,
        reason: RuntimeDeliveryFailureReason,
        observed_at_ms: i64,
    ) -> impl Future<Output = Result<InboxSettlementDisposition, PersistenceFailure>> + Send;

    fn release_owner(
        &self,
        owner: DeliveryLeaseOwner,
    ) -> impl Future<Output = Result<u64, PersistenceFailure>> + Send;
}

pub fn runtime_scope_for(
    agent: AgentId,
    conversation: ConversationId,
    session_scope: &str,
) -> Result<RuntimeScope, InvalidRuntimeSessionScope> {
    match session_scope {
        "conversation" => Ok(RuntimeScope::ConversationSlot {
            agent,
            source: conversation,
        }),
        "agent" => Ok(RuntimeScope::AgentSlot { agent }),
        _ => Err(InvalidRuntimeSessionScope),
    }
}

#[derive(Debug, Error)]
#[error("persisted runtime session scope is unsupported")]
pub struct InvalidRuntimeSessionScope;

pub fn daemon_instance_for_ready(
    daemon_pid: i64,
    started_at_ms: i64,
) -> Result<DaemonInstanceId, crate::identity::EmptyDaemonInstanceId> {
    DaemonInstanceId::parse(format!("{daemon_pid}:{started_at_ms}"))
}
