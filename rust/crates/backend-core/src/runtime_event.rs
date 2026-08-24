//! Durable daemon-event facts and the transaction boundary that admits them.
//!
//! Daemon frames are not replayable after a successful settlement/finalization.
//! The ports here therefore commit each durable fact as one root unit of work;
//! process-local cache, live projection and coordinator effects run only after
//! that commit and never compensate it.

use std::future::Future;

use crate::{
    identity::{AgentId, ConversationId, UserId},
    persistence::PersistenceFailure,
    runtime_credential::{RuntimeEventTime, RuntimePrincipal},
    runtime_delivery::{DeliveryLeaseOwner, InboxDeliveryId, InboxSettlementDisposition},
};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum RuntimeObservedStatus {
    Idle,
    Starting,
    Active,
    Crashed,
}

impl RuntimeObservedStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Idle => "idle",
            Self::Starting => "starting",
            Self::Active => "active",
            Self::Crashed => "crashed",
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum RuntimeActivityPayload {
    None,
    Text {
        text: String,
    },
    ToolCall {
        name: String,
        input_json: String,
        tool_call_id: Option<String>,
    },
    ToolOutput {
        name: Option<String>,
        tool_call_id: Option<String>,
        outcome: String,
    },
    ApiResponse {
        status: String,
        message: String,
    },
    Error {
        message: String,
        code: Option<String>,
        fatal: Option<bool>,
    },
    ParsedEventDropped {
        parsed_kind: String,
        encoded_bytes: i64,
        reason: String,
    },
    MessageReceived {
        count: usize,
    },
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum RuntimeActivityKind {
    SessionInit,
    Thinking,
    Text,
    ToolCall,
    ToolOutput,
    TurnEnd,
    CompactionStarted,
    CompactionFinished,
    ApiResponse,
    Error,
    ParsedEventDropped,
    MessageStale,
    MessageReceived,
}

impl RuntimeActivityKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::SessionInit => "session_init",
            Self::Thinking => "thinking",
            Self::Text => "text",
            Self::ToolCall => "tool_call",
            Self::ToolOutput => "tool_output",
            Self::TurnEnd => "turn_end",
            Self::CompactionStarted => "compaction_started",
            Self::CompactionFinished => "compaction_finished",
            Self::ApiResponse => "api_response",
            Self::Error => "error",
            Self::ParsedEventDropped => "parsed_event_dropped",
            Self::MessageStale => "message_stale",
            Self::MessageReceived => "message_received",
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RuntimeActivityFact {
    conversation: ConversationId,
    agent: AgentId,
    kind: RuntimeActivityKind,
    payload: RuntimeActivityPayload,
    created_at: RuntimeEventTime,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct UpsertRuntimeTextActivity {
    principal: RuntimePrincipal,
    event: RuntimeActivityFact,
    previous_event_id: Option<i64>,
    presence_at: RuntimeEventTime,
}

impl UpsertRuntimeTextActivity {
    pub fn new(
        principal: RuntimePrincipal,
        event: RuntimeActivityFact,
        previous_event_id: Option<i64>,
        presence_at: RuntimeEventTime,
    ) -> Self {
        Self {
            principal,
            event,
            previous_event_id,
            presence_at,
        }
    }

    pub fn principal(&self) -> &RuntimePrincipal {
        &self.principal
    }
    pub fn event(&self) -> &RuntimeActivityFact {
        &self.event
    }
    pub fn previous_event_id(&self) -> Option<i64> {
        self.previous_event_id
    }
    pub fn presence_at(&self) -> RuntimeEventTime {
        self.presence_at
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RuntimeActivityCommitResult {
    id: i64,
    presence_viewers: Vec<UserId>,
}

impl RuntimeActivityCommitResult {
    pub fn new(id: i64, presence_viewers: Vec<UserId>) -> Self {
        Self {
            id,
            presence_viewers,
        }
    }
    pub fn id(&self) -> i64 {
        self.id
    }
    pub fn presence_viewers(&self) -> &[UserId] {
        &self.presence_viewers
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RefineRuntimeToolCallInput {
    principal: RuntimePrincipal,
    conversation: ConversationId,
    agent: AgentId,
    tool_call_id: String,
    input_json: String,
    observed_at: RuntimeEventTime,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RefinedRuntimeActivity {
    id: i64,
    payload_json: String,
    created_at: RuntimeEventTime,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RuntimeToolCallInputCommitResult {
    refined: Option<RefinedRuntimeActivity>,
    presence_viewers: Vec<UserId>,
}

impl RuntimeToolCallInputCommitResult {
    pub fn new(refined: Option<RefinedRuntimeActivity>, presence_viewers: Vec<UserId>) -> Self {
        Self {
            refined,
            presence_viewers,
        }
    }

    pub fn refined(&self) -> Option<&RefinedRuntimeActivity> {
        self.refined.as_ref()
    }

    pub fn presence_viewers(&self) -> &[UserId] {
        &self.presence_viewers
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct StampRuntimePresence {
    principal: RuntimePrincipal,
    agent: AgentId,
    observed_at: RuntimeEventTime,
}

impl StampRuntimePresence {
    pub fn new(principal: RuntimePrincipal, agent: AgentId, observed_at: RuntimeEventTime) -> Self {
        Self {
            principal,
            agent,
            observed_at,
        }
    }

    pub fn principal(&self) -> &RuntimePrincipal {
        &self.principal
    }

    pub fn agent(&self) -> &AgentId {
        &self.agent
    }

    pub fn observed_at(&self) -> RuntimeEventTime {
        self.observed_at
    }
}

impl RefinedRuntimeActivity {
    pub fn new(id: i64, payload_json: String, created_at: RuntimeEventTime) -> Self {
        Self {
            id,
            payload_json,
            created_at,
        }
    }

    pub fn id(&self) -> i64 {
        self.id
    }
    pub fn payload_json(&self) -> &str {
        &self.payload_json
    }
    pub fn created_at(&self) -> RuntimeEventTime {
        self.created_at
    }
}

impl RefineRuntimeToolCallInput {
    pub fn new(
        principal: RuntimePrincipal,
        conversation: ConversationId,
        agent: AgentId,
        tool_call_id: String,
        input_json: String,
        observed_at: RuntimeEventTime,
    ) -> Self {
        Self {
            principal,
            conversation,
            agent,
            tool_call_id,
            input_json,
            observed_at,
        }
    }

    pub fn principal(&self) -> &RuntimePrincipal {
        &self.principal
    }
    pub fn conversation(&self) -> &ConversationId {
        &self.conversation
    }
    pub fn agent(&self) -> &AgentId {
        &self.agent
    }
    pub fn tool_call_id(&self) -> &str {
        &self.tool_call_id
    }
    pub fn input_json(&self) -> &str {
        &self.input_json
    }
    pub fn observed_at(&self) -> RuntimeEventTime {
        self.observed_at
    }
}

impl RuntimeActivityFact {
    pub fn new(
        conversation: ConversationId,
        agent: AgentId,
        kind: RuntimeActivityKind,
        payload: RuntimeActivityPayload,
        created_at: RuntimeEventTime,
    ) -> Self {
        Self {
            conversation,
            agent,
            kind,
            payload,
            created_at,
        }
    }

    pub fn conversation(&self) -> &ConversationId {
        &self.conversation
    }
    pub fn agent(&self) -> &AgentId {
        &self.agent
    }
    pub fn kind(&self) -> RuntimeActivityKind {
        self.kind
    }
    pub fn payload(&self) -> &RuntimeActivityPayload {
        &self.payload
    }
    pub fn created_at(&self) -> RuntimeEventTime {
        self.created_at
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CommitRuntimeExit {
    principal: RuntimePrincipal,
    status: RuntimeObservedStatus,
    observed_at: RuntimeEventTime,
    pending_activity: Option<RuntimeActivityFact>,
}

impl CommitRuntimeExit {
    pub fn new(
        principal: RuntimePrincipal,
        status: RuntimeObservedStatus,
        observed_at: RuntimeEventTime,
        pending_activity: Option<RuntimeActivityFact>,
    ) -> Self {
        Self {
            principal,
            status,
            observed_at,
            pending_activity,
        }
    }

    pub fn principal(&self) -> &RuntimePrincipal {
        &self.principal
    }
    pub fn status(&self) -> RuntimeObservedStatus {
        self.status
    }
    pub fn observed_at(&self) -> RuntimeEventTime {
        self.observed_at
    }
    pub fn pending_activity(&self) -> Option<&RuntimeActivityFact> {
        self.pending_activity.as_ref()
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum RuntimeExitDisposition {
    Applied,
    Stale,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RuntimeExitCommitResult {
    disposition: RuntimeExitDisposition,
    activity_id: Option<i64>,
}

impl RuntimeExitCommitResult {
    pub fn new(disposition: RuntimeExitDisposition, activity_id: Option<i64>) -> Self {
        Self {
            disposition,
            activity_id,
        }
    }

    pub fn disposition(&self) -> RuntimeExitDisposition {
        self.disposition
    }
    pub fn activity_id(&self) -> Option<i64> {
        self.activity_id
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RuntimeConsumedCommitResult {
    disposition: InboxSettlementDisposition,
    activity_id: Option<i64>,
    presence_viewers: Vec<UserId>,
}

impl RuntimeConsumedCommitResult {
    pub fn new(
        disposition: InboxSettlementDisposition,
        activity_id: Option<i64>,
        presence_viewers: Vec<UserId>,
    ) -> Self {
        Self {
            disposition,
            activity_id,
            presence_viewers,
        }
    }

    pub fn disposition(&self) -> InboxSettlementDisposition {
        self.disposition
    }
    pub fn activity_id(&self) -> Option<i64> {
        self.activity_id
    }
    pub fn presence_viewers(&self) -> &[UserId] {
        &self.presence_viewers
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CommitRuntimeConsumed {
    host_id: String,
    principal: RuntimePrincipal,
    conversation: ConversationId,
    owner: DeliveryLeaseOwner,
    delivery_ids: Vec<InboxDeliveryId>,
    observed_at: RuntimeEventTime,
    presence_at: RuntimeEventTime,
}

impl CommitRuntimeConsumed {
    pub fn new(
        host_id: String,
        principal: RuntimePrincipal,
        conversation: ConversationId,
        owner: DeliveryLeaseOwner,
        delivery_ids: Vec<InboxDeliveryId>,
        observed_at: RuntimeEventTime,
        presence_at: RuntimeEventTime,
    ) -> Self {
        Self {
            host_id,
            principal,
            conversation,
            owner,
            delivery_ids,
            observed_at,
            presence_at,
        }
    }

    pub fn host_id(&self) -> &str {
        &self.host_id
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
    pub fn delivery_ids(&self) -> &[InboxDeliveryId] {
        &self.delivery_ids
    }
    pub fn observed_at(&self) -> RuntimeEventTime {
        self.observed_at
    }
    pub fn presence_at(&self) -> RuntimeEventTime {
        self.presence_at
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProjectRuntimeStatus {
    principal: RuntimePrincipal,
    status: RuntimeObservedStatus,
    cli_session_id: Option<String>,
    observed_at: RuntimeEventTime,
}

impl ProjectRuntimeStatus {
    pub fn new(
        principal: RuntimePrincipal,
        status: RuntimeObservedStatus,
        cli_session_id: Option<String>,
        observed_at: RuntimeEventTime,
    ) -> Self {
        Self {
            principal,
            status,
            cli_session_id,
            observed_at,
        }
    }

    pub fn principal(&self) -> &RuntimePrincipal {
        &self.principal
    }
    pub fn status(&self) -> RuntimeObservedStatus {
        self.status
    }
    pub fn cli_session_id(&self) -> Option<&str> {
        self.cli_session_id.as_deref()
    }
    pub fn observed_at(&self) -> RuntimeEventTime {
        self.observed_at
    }
}

pub trait DaemonEventDurablePort: Clone + Send + Sync + 'static {
    fn current_principal(
        &self,
        scope: crate::runtime_credential::RuntimeScope,
    ) -> impl Future<Output = Result<Option<RuntimePrincipal>, PersistenceFailure>> + Send;

    fn commit_exit(
        &self,
        event: CommitRuntimeExit,
    ) -> impl Future<Output = Result<RuntimeExitCommitResult, PersistenceFailure>> + Send;

    fn commit_consumed(
        &self,
        event: CommitRuntimeConsumed,
    ) -> impl Future<Output = Result<RuntimeConsumedCommitResult, PersistenceFailure>> + Send;

    fn project_status(
        &self,
        event: ProjectRuntimeStatus,
    ) -> impl Future<Output = Result<bool, PersistenceFailure>> + Send;

    fn record_activity(
        &self,
        principal: RuntimePrincipal,
        event: RuntimeActivityFact,
        presence_at: RuntimeEventTime,
    ) -> impl Future<Output = Result<Option<RuntimeActivityCommitResult>, PersistenceFailure>> + Send;

    fn upsert_text_activity(
        &self,
        event: UpsertRuntimeTextActivity,
    ) -> impl Future<Output = Result<Option<RuntimeActivityCommitResult>, PersistenceFailure>> + Send;

    fn refine_tool_call_input(
        &self,
        event: RefineRuntimeToolCallInput,
    ) -> impl Future<Output = Result<Option<RuntimeToolCallInputCommitResult>, PersistenceFailure>> + Send;

    fn stamp_presence(
        &self,
        event: StampRuntimePresence,
    ) -> impl Future<Output = Result<Option<Vec<UserId>>, PersistenceFailure>> + Send;
}
