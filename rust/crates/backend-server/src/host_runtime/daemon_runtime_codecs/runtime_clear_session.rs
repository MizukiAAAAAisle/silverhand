//! Transport-owned codec for `runtime_clear_session`.

use std::{error::Error, fmt};

use serde_json::{Value, json};
use silverhand_backend_core::{
    foundation::wire_number::JsSafeInteger,
    host_runtime::runtime_credential::{RuntimeGeneration, RuntimeScope},
};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) struct RuntimeClearSessionCodecError;

impl fmt::Display for RuntimeClearSessionCodecError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("runtime_clear_session generation must be positive and JavaScript-safe")
    }
}

impl Error for RuntimeClearSessionCodecError {}

pub(crate) fn encode(
    scope: &RuntimeScope,
    generation: RuntimeGeneration,
) -> Result<Value, RuntimeClearSessionCodecError> {
    let generation =
        JsSafeInteger::new(generation.as_i64()).map_err(|_| RuntimeClearSessionCodecError)?;
    if generation.get() <= 0 {
        return Err(RuntimeClearSessionCodecError);
    }
    Ok(json!({
        "runtime_scope": super::scope_wire(scope),
        "runtime_generation": generation.get(),
    }))
}

pub(crate) fn decode_result(value: &Value) -> Option<bool> {
    let object = value.as_object()?;
    (object.len() == 1)
        .then(|| object.get("cleared").and_then(Value::as_bool))
        .flatten()
}

#[cfg(test)]
mod tests {
    use super::*;
    use silverhand_backend_core::identity::{AgentId, ConversationId};

    #[test]
    fn both_exact_scope_arms_and_result_are_closed() {
        let conversation = RuntimeScope::ConversationSlot {
            agent: AgentId::parse("agent-a").unwrap(),
            source: ConversationId::parse("conversation-a").unwrap(),
        };
        assert_eq!(
            encode(&conversation, RuntimeGeneration::new(1).unwrap()).unwrap(),
            json!({
                "runtime_scope": {"kind":"conversation","conversation_id":"conversation-a","agent_id":"agent-a"},
                "runtime_generation": 1,
            })
        );
        let agent = RuntimeScope::AgentSlot {
            agent: AgentId::parse("agent-a").unwrap(),
        };
        assert_eq!(
            encode(&agent, RuntimeGeneration::new(1).unwrap()).unwrap()["runtime_scope"],
            json!({"kind":"agent","agent_id":"agent-a"})
        );
        assert_eq!(decode_result(&json!({"cleared":true})), Some(true));
        assert_eq!(decode_result(&json!({"cleared":true,"extra":0})), None);
    }

    #[test]
    fn generation_admission_precedes_transport() {
        for invalid in [0, JsSafeInteger::MAX + 1] {
            assert!(
                encode(
                    &RuntimeScope::AgentSlot {
                        agent: AgentId::parse("agent-a").unwrap(),
                    },
                    RuntimeGeneration::new(invalid).unwrap(),
                )
                .is_err()
            );
        }
    }
}
