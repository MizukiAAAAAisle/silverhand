//! Persisted activity page for one conversation-agent coordinate.
//!
//! This is not live runtime state. The page is an ordered projection of
//! `conversation_events`, authorized independently by viewer visibility and by
//! the target agent's current placement participation.

use std::{error::Error, future::Future};

use crate::foundation::identity::{AgentId, ConversationId, UserId};

/// Activity records expire by their original creation instant, never by refinement.
pub const ACTIVITY_RETENTION_MS: i64 = 7 * 24 * 60 * 60 * 1_000;

#[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd)]
pub struct ActivityEventId(i64);

impl ActivityEventId {
    pub fn new(value: i64) -> Result<Self, InvalidActivityEventId> {
        (value >= 1)
            .then_some(Self(value))
            .ok_or(InvalidActivityEventId)
    }

    pub const fn get(self) -> i64 {
        self.0
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, thiserror::Error)]
#[error("conversation activity event id must be positive")]
pub struct InvalidActivityEventId;

#[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd)]
pub struct ActivityCreatedAt(i64);

impl ActivityCreatedAt {
    const MAX_JAVASCRIPT_INTEGER: i64 = 9_007_199_254_740_991;

    pub fn new(value: i64) -> Result<Self, InvalidActivityCreatedAt> {
        (0..=Self::MAX_JAVASCRIPT_INTEGER)
            .contains(&value)
            .then_some(Self(value))
            .ok_or(InvalidActivityCreatedAt)
    }

    pub const fn get(self) -> i64 {
        self.0
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, thiserror::Error)]
#[error("conversation activity created_at must be nonnegative and exact on the JavaScript wire")]
pub struct InvalidActivityCreatedAt;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ConversationActivityKind {
    SessionInit,
    Thinking,
    Text,
    ToolCall,
    ToolOutput,
    FileChange,
    Shell,
    Stderr,
    CompactionStarted,
    CompactionFinished,
    TurnEnd,
    ApiResponse,
    Error,
    Unknown,
    ParsedEventDropped,
    MessageStale,
    MessageReceived,
}

impl ConversationActivityKind {
    pub fn parse(raw: &str) -> Result<Self, UnknownConversationActivityKind> {
        match raw {
            "session_init" => Ok(Self::SessionInit),
            "thinking" => Ok(Self::Thinking),
            "text" => Ok(Self::Text),
            "tool_call" => Ok(Self::ToolCall),
            "tool_output" => Ok(Self::ToolOutput),
            "file_change" => Ok(Self::FileChange),
            "shell" => Ok(Self::Shell),
            "stderr" => Ok(Self::Stderr),
            "compaction_started" => Ok(Self::CompactionStarted),
            "compaction_finished" => Ok(Self::CompactionFinished),
            "turn_end" => Ok(Self::TurnEnd),
            "api_response" => Ok(Self::ApiResponse),
            "error" => Ok(Self::Error),
            "unknown" => Ok(Self::Unknown),
            "parsed_event_dropped" => Ok(Self::ParsedEventDropped),
            "message_stale" => Ok(Self::MessageStale),
            "message_received" => Ok(Self::MessageReceived),
            _ => Err(UnknownConversationActivityKind),
        }
    }

    pub const fn as_str(self) -> &'static str {
        match self {
            Self::SessionInit => "session_init",
            Self::Thinking => "thinking",
            Self::Text => "text",
            Self::ToolCall => "tool_call",
            Self::ToolOutput => "tool_output",
            Self::FileChange => "file_change",
            Self::Shell => "shell",
            Self::Stderr => "stderr",
            Self::CompactionStarted => "compaction_started",
            Self::CompactionFinished => "compaction_finished",
            Self::TurnEnd => "turn_end",
            Self::ApiResponse => "api_response",
            Self::Error => "error",
            Self::Unknown => "unknown",
            Self::ParsedEventDropped => "parsed_event_dropped",
            Self::MessageStale => "message_stale",
            Self::MessageReceived => "message_received",
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, thiserror::Error)]
#[error("unknown conversation activity kind")]
pub struct UnknownConversationActivityKind;

/// The TS read maps SQL NULL and any valid non-object JSON value to wire null.
/// Object text has already been parsed by the persistence adapter. The HTTP
/// adapter parses it again before projection so a faulty public port cannot put
/// invalid JSON on the wire.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ActivityPayload {
    Null,
    ObjectJson(String),
}

impl ActivityPayload {
    pub fn object_json(validated: String) -> Self {
        Self::ObjectJson(validated)
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ConversationActivityEvent {
    id: ActivityEventId,
    conversation: ConversationId,
    agent: Option<AgentId>,
    kind: ConversationActivityKind,
    payload: ActivityPayload,
    created_at: ActivityCreatedAt,
}

impl ConversationActivityEvent {
    pub fn projected(
        id: ActivityEventId,
        conversation: ConversationId,
        agent: Option<AgentId>,
        kind: ConversationActivityKind,
        payload: ActivityPayload,
        created_at: ActivityCreatedAt,
    ) -> Self {
        Self {
            id,
            conversation,
            agent,
            kind,
            payload,
            created_at,
        }
    }

    pub const fn id(&self) -> ActivityEventId {
        self.id
    }

    pub fn conversation(&self) -> &ConversationId {
        &self.conversation
    }

    pub fn agent(&self) -> Option<&AgentId> {
        self.agent.as_ref()
    }

    pub const fn kind(&self) -> ConversationActivityKind {
        self.kind
    }

    pub fn payload(&self) -> &ActivityPayload {
        &self.payload
    }

    pub const fn created_at(&self) -> ActivityCreatedAt {
        self.created_at
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ActivityPageRequest {
    limit: u16,
    before: Option<ActivityBefore>,
}

impl ActivityPageRequest {
    pub fn new(limit: u16, before: Option<ActivityBefore>) -> Result<Self, InvalidActivityLimit> {
        (1..=200)
            .contains(&limit)
            .then_some(Self { limit, before })
            .ok_or(InvalidActivityLimit)
    }

    pub const fn limit(self) -> u16 {
        self.limit
    }

    pub const fn before(self) -> Option<ActivityBefore> {
        self.before
    }
}

/// An admitted ECMAScript integer cursor. Values above SQLite's signed range
/// are valid JavaScript input and mean "before an id larger than every durable
/// row", not invalid input or saturation.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ActivityBefore {
    Persisted(ActivityEventId),
    BeyondPersistedRange,
}

impl ActivityBefore {
    pub const fn persisted_value(self) -> Option<i64> {
        match self {
            Self::Persisted(value) => Some(value.get()),
            Self::BeyondPersistedRange => None,
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, thiserror::Error)]
#[error("conversation activity page limit must be between 1 and 200")]
pub struct InvalidActivityLimit;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ConversationAgentActivityPage {
    viewer: UserId,
    conversation: ConversationId,
    agent: AgentId,
    events: Vec<ConversationActivityEvent>,
    next_before: Option<ActivityEventId>,
}

impl ConversationAgentActivityPage {
    pub fn projected(
        viewer: UserId,
        conversation: ConversationId,
        agent: AgentId,
        events: Vec<ConversationActivityEvent>,
        has_more: bool,
    ) -> Result<Self, MalformedConversationAgentActivityPage> {
        let ordered = events.windows(2).all(|pair| pair[0].id < pair[1].id);
        let coordinates_match = events.iter().all(|event| {
            event.conversation == conversation && event.agent.as_ref() == Some(&agent)
        });
        if !ordered || !coordinates_match || (has_more && events.is_empty()) {
            return Err(MalformedConversationAgentActivityPage);
        }
        let next_before = has_more.then(|| {
            events
                .first()
                .expect("a nonempty page was checked before cursor derivation")
                .id
        });
        Ok(Self {
            viewer,
            conversation,
            agent,
            events,
            next_before,
        })
    }

    pub fn bind(
        self,
        requested_viewer: &UserId,
        requested_conversation: &ConversationId,
        requested_agent: &AgentId,
    ) -> Result<BoundConversationAgentActivityPage, ConversationAgentActivityIdentityMismatch> {
        if &self.viewer != requested_viewer
            || &self.conversation != requested_conversation
            || &self.agent != requested_agent
            || self.events.iter().any(|event| {
                &event.conversation != requested_conversation
                    || event.agent.as_ref() != Some(requested_agent)
            })
        {
            return Err(ConversationAgentActivityIdentityMismatch);
        }
        Ok(BoundConversationAgentActivityPage(self))
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct BoundConversationAgentActivityPage(ConversationAgentActivityPage);

impl BoundConversationAgentActivityPage {
    pub fn viewer(&self) -> &UserId {
        &self.0.viewer
    }

    pub fn events(&self) -> &[ConversationActivityEvent] {
        &self.0.events
    }

    pub const fn next_before(&self) -> Option<ActivityEventId> {
        self.0.next_before
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, thiserror::Error)]
#[error("conversation activity page is not an ordered, coordinate-closed projection")]
pub struct MalformedConversationAgentActivityPage;

#[derive(Clone, Copy, Debug, Eq, PartialEq, thiserror::Error)]
#[error("conversation activity page identity differs from the requested coordinate")]
pub struct ConversationAgentActivityIdentityMismatch;

#[derive(Clone, Copy, Debug, Eq, PartialEq, thiserror::Error)]
pub enum ConversationAgentActivityRefusal {
    #[error("conversation not found")]
    NotFound,
    #[error("viewer cannot read conversation activity")]
    Forbidden,
    #[error("target agent does not participate in the conversation")]
    TargetNotParticipant,
}

pub trait ConversationAgentActivityReadPort {
    type Error: Error + Send + Sync + 'static;

    /// Rejection-only preflight used to preserve the TS authority-before-query
    /// order. Success is never a token: `read` re-evaluates the same authorities
    /// in its own snapshot before selecting rows.
    fn admit(
        &self,
        viewer: &UserId,
        conversation: &ConversationId,
        agent: &AgentId,
    ) -> impl Future<Output = Result<Result<(), ConversationAgentActivityRefusal>, Self::Error>> + Send;

    fn read(
        &self,
        viewer: &UserId,
        conversation: &ConversationId,
        agent: &AgentId,
        page: ActivityPageRequest,
    ) -> impl Future<
        Output = Result<
            Result<ConversationAgentActivityPage, ConversationAgentActivityRefusal>,
            Self::Error,
        >,
    > + Send;
}

#[cfg(test)]
mod tests {
    use super::*;

    fn event(id: i64, conversation: &str, agent: Option<&str>) -> ConversationActivityEvent {
        ConversationActivityEvent::projected(
            ActivityEventId::new(id).unwrap(),
            ConversationId::parse(conversation).unwrap(),
            agent.map(|value| AgentId::parse(value).unwrap()),
            ConversationActivityKind::Text,
            ActivityPayload::object_json("{\"text\":\"x\"}".to_owned()),
            ActivityCreatedAt::new(id).unwrap(),
        )
    }

    #[test]
    fn page_is_ordered_cursor_closed_and_identity_bound() {
        let page = ConversationAgentActivityPage::projected(
            UserId::parse("viewer").unwrap(),
            ConversationId::parse("c").unwrap(),
            AgentId::parse("a").unwrap(),
            vec![event(2, "c", Some("a")), event(3, "c", Some("a"))],
            true,
        )
        .unwrap();
        assert!(
            page.clone()
                .bind(
                    &UserId::parse("viewer").unwrap(),
                    &ConversationId::parse("other").unwrap(),
                    &AgentId::parse("a").unwrap()
                )
                .is_err()
        );
        assert!(
            page.clone()
                .bind(
                    &UserId::parse("viewer").unwrap(),
                    &ConversationId::parse("c").unwrap(),
                    &AgentId::parse("other").unwrap()
                )
                .is_err()
        );
        let bound = page
            .bind(
                &UserId::parse("viewer").unwrap(),
                &ConversationId::parse("c").unwrap(),
                &AgentId::parse("a").unwrap(),
            )
            .unwrap();
        assert_eq!(bound.events().len(), 2);
        assert_eq!(bound.next_before().unwrap().get(), 2);
        assert_eq!(bound.viewer().as_str(), "viewer");

        let page = ConversationAgentActivityPage::projected(
            UserId::parse("viewer").unwrap(),
            ConversationId::parse("c").unwrap(),
            AgentId::parse("a").unwrap(),
            vec![event(2, "c", Some("a"))],
            false,
        )
        .unwrap();
        let no_more = page
            .clone()
            .bind(
                &UserId::parse("viewer").unwrap(),
                &ConversationId::parse("c").unwrap(),
                &AgentId::parse("a").unwrap(),
            )
            .unwrap();
        assert!(no_more.next_before().is_none());
        assert!(
            page.bind(
                &UserId::parse("foreign").unwrap(),
                &ConversationId::parse("c").unwrap(),
                &AgentId::parse("a").unwrap(),
            )
            .is_err()
        );

        assert!(
            ConversationAgentActivityPage::projected(
                UserId::parse("viewer").unwrap(),
                ConversationId::parse("c").unwrap(),
                AgentId::parse("a").unwrap(),
                vec![event(3, "c", Some("a")), event(2, "c", Some("a"))],
                false,
            )
            .is_err()
        );
        assert!(
            ConversationAgentActivityPage::projected(
                UserId::parse("viewer").unwrap(),
                ConversationId::parse("c").unwrap(),
                AgentId::parse("a").unwrap(),
                vec![],
                true,
            )
            .is_err()
        );
        assert!(
            ConversationAgentActivityPage::projected(
                UserId::parse("viewer").unwrap(),
                ConversationId::parse("c").unwrap(),
                AgentId::parse("a").unwrap(),
                vec![event(2, "other", Some("a"))],
                false,
            )
            .is_err()
        );
        assert!(
            ConversationAgentActivityPage::projected(
                UserId::parse("viewer").unwrap(),
                ConversationId::parse("c").unwrap(),
                AgentId::parse("a").unwrap(),
                vec![event(2, "c", None)],
                false,
            )
            .is_err()
        );
    }

    #[test]
    fn scalar_boundaries_and_kind_tokens_are_closed() {
        assert!(ActivityEventId::new(0).is_err());
        assert!(ActivityEventId::new(1).is_ok());
        assert!(ActivityCreatedAt::new(-1).is_err());
        assert!(ActivityCreatedAt::new(0).is_ok());
        assert!(ActivityPageRequest::new(0, None).is_err());
        assert!(ActivityPageRequest::new(1, None).is_ok());
        assert!(ActivityPageRequest::new(200, None).is_ok());
        assert!(ActivityPageRequest::new(201, None).is_err());
        for token in [
            "session_init",
            "thinking",
            "text",
            "tool_call",
            "tool_output",
            "file_change",
            "shell",
            "stderr",
            "compaction_started",
            "compaction_finished",
            "turn_end",
            "api_response",
            "error",
            "unknown",
            "parsed_event_dropped",
            "message_stale",
            "message_received",
        ] {
            let kind = ConversationActivityKind::parse(token).unwrap();
            assert_eq!(kind.as_str(), token);
        }
        assert!(ConversationActivityKind::parse("future_kind").is_err());
    }
}

/// One ordered agent-owned stream. Conversation ids remain provenance, not ACL keys.
#[derive(Clone, Debug)]
pub struct AgentActivityPage {
    viewer: UserId,
    agent: AgentId,
    events: Vec<ConversationActivityEvent>,
    next_before: Option<ActivityEventId>,
}
impl AgentActivityPage {
    pub fn projected(
        viewer: UserId,
        agent: AgentId,
        events: Vec<ConversationActivityEvent>,
        has_more: bool,
    ) -> Result<Self, MalformedConversationAgentActivityPage> {
        if !events.windows(2).all(|p| p[0].id < p[1].id)
            || events.iter().any(|e| e.agent.as_ref() != Some(&agent))
            || (has_more && events.is_empty())
        {
            return Err(MalformedConversationAgentActivityPage);
        }
        let next_before = if has_more {
            events.first().map(|e| e.id)
        } else {
            None
        };
        Ok(Self {
            viewer,
            agent,
            events,
            next_before,
        })
    }
    pub fn bind(
        &self,
        viewer: &UserId,
        agent: &AgentId,
    ) -> Result<(), ConversationAgentActivityIdentityMismatch> {
        if &self.viewer == viewer && &self.agent == agent {
            Ok(())
        } else {
            Err(ConversationAgentActivityIdentityMismatch)
        }
    }
    pub fn events(&self) -> &[ConversationActivityEvent] {
        &self.events
    }
    pub fn next_before(&self) -> Option<ActivityEventId> {
        self.next_before
    }
}
pub trait AgentActivityReadPort: Send + Sync {
    fn read_agent_activity(
        &self,
        viewer: &UserId,
        agent: &AgentId,
        page: ActivityPageRequest,
    ) -> impl Future<
        Output = Result<
            Option<AgentActivityPage>,
            crate::foundation::persistence::PersistenceFailure,
        >,
    > + Send;
}
