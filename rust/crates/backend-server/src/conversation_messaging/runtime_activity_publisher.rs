//! Conversation-scoped runtime activity projection onto the scope-event wire.

use serde_json::{Value, json};
use silverhand_backend_core::host_runtime::runtime_event::RuntimeActivityPayload;

use crate::{
    foundation::{scope_event_transport::ScopeEventHub, scope_event_wire::ProductEvent},
    host_runtime::runtime_event_settlement::{
        ConversationRuntimeProjectionFact, ConversationRuntimeProjectionPort, LiveProjectionFailure,
    },
};
use silverhand_backend_core::foundation::scope_event::EventScope;

#[derive(Clone)]
pub struct HubRuntimeActivityPublisher(ScopeEventHub);

impl ScopeEventHub {
    pub fn runtime_activity_publisher(&self) -> HubRuntimeActivityPublisher {
        HubRuntimeActivityPublisher(self.clone())
    }
}

impl ConversationRuntimeProjectionPort for HubRuntimeActivityPublisher {
    fn publish(
        &self,
        fact: ConversationRuntimeProjectionFact,
    ) -> Result<(), LiveProjectionFailure> {
        let (conversation, event) = match fact {
            ConversationRuntimeProjectionFact::AgentActivity {
                conversation,
                state,
            } => {
                let payload =
                    serde_json::to_value(state).map_err(LiveProjectionFailure::from_source)?;
                (conversation, ProductEvent::AgentActivity(payload))
            }
            ConversationRuntimeProjectionFact::AgentInitTimeout {
                conversation,
                agent,
                reason,
                elapsed_ms,
                timeout_ms,
                retrying,
                retry_attempt,
                max_retries,
                cooldown_until,
            } => (
                conversation,
                ProductEvent::AgentInitTimeout(json!({
                    "agent_id": agent.as_str(),
                    "reason": reason.as_str(),
                    "elapsed_ms": elapsed_ms,
                    "timeout_ms": timeout_ms,
                    "retrying": retrying,
                    "retry_attempt": retry_attempt,
                    "max_retries": max_retries,
                    "cooldown_until": cooldown_until,
                })),
            ),
            ConversationRuntimeProjectionFact::CompactionStale {
                conversation,
                agent,
                elapsed_ms,
            } => (
                conversation,
                ProductEvent::CompactionStale(json!({
                    "agent_id": agent.as_str(),
                    "elapsed_ms": elapsed_ms,
                })),
            ),
            ConversationRuntimeProjectionFact::AgentEvent {
                conversation,
                agent,
                event,
            } => (
                conversation,
                ProductEvent::AgentEvent(json!({
                    "agent_id": agent.as_str(),
                    "event": event,
                })),
            ),
            ConversationRuntimeProjectionFact::Activity { id, fact } => {
                let conversation = fact.conversation().clone();
                let payload = activity_payload_value(fact.payload())?;
                (
                    conversation,
                    ProductEvent::ConversationActivity(json!({
                        "id": id,
                        "conversation_id": fact.conversation().as_str(),
                        "agent_id": fact.agent().as_str(),
                        "kind": fact.kind().as_str(),
                        "payload": payload,
                        "created_at": fact.created_at().as_unix_millis(),
                    })),
                )
            }
            ConversationRuntimeProjectionFact::RefinedToolCall {
                conversation,
                agent,
                activity,
            } => {
                let payload = serde_json::from_str::<Value>(activity.payload_json())
                    .map_err(LiveProjectionFailure::from_source)?;
                (
                    conversation.clone(),
                    ProductEvent::ConversationActivity(json!({
                        "id": activity.id(),
                        "conversation_id": conversation.as_str(),
                        "agent_id": agent.as_str(),
                        "kind": "tool_call",
                        "payload": payload,
                        "created_at": activity.created_at().as_unix_millis(),
                    })),
                )
            }
        };
        self.0
            .publish(EventScope::ConversationSide(conversation), event)
            .map_err(LiveProjectionFailure::from_source)
    }
}

fn activity_payload_value(
    payload: &RuntimeActivityPayload,
) -> Result<Value, LiveProjectionFailure> {
    Ok(match payload {
        RuntimeActivityPayload::None => Value::Null,
        RuntimeActivityPayload::Text { text } => json!({ "text": text }),
        RuntimeActivityPayload::ToolCall {
            name,
            input_json,
            tool_call_id,
        } => json!({
            "name": name,
            "input": serde_json::from_str::<Value>(input_json)
                .map_err(LiveProjectionFailure::from_source)?,
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
