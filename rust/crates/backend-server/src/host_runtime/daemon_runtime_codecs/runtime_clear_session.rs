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
    use silverhand_backend_core::foundation::identity::{AgentId, ConversationId};

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
        for (result, expected) in [
            (json!({"cleared":true}), Some(true)),
            (json!({"cleared":false}), Some(false)),
            (json!({"cleared":true,"extra":0}), None),
            (json!({}), None),
            (json!({"cleared":null}), None),
            (json!({"cleared":1}), None),
            (json!(null), None),
        ] {
            assert_eq!(decode_result(&result), expected, "{result}");
        }
    }

    #[test]
    fn generation_admission_is_positive_and_javascript_exact() {
        for invalid in [0, 9_007_199_254_740_992] {
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
        assert_eq!(
            encode(
                &RuntimeScope::AgentSlot {
                    agent: AgentId::parse("agent-a").unwrap()
                },
                RuntimeGeneration::new(9_007_199_254_740_991).unwrap(),
            )
            .unwrap()["runtime_generation"],
            json!(9_007_199_254_740_991_i64)
        );
    }
}
