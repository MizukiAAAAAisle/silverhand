//! The one transport codec for the existing `runtime_stop` command.
//!
//! Every production sender goes through this owner before it can touch a command
//! FIFO. That keeps the daemon's positive JavaScript-number generation contract,
//! the exact runtime-scope shape, and the response schema in one place.

use std::{error::Error, fmt};

use serde_json::{Value, json};
use silverhand_backend_core::{
    foundation::wire_number::JsSafeInteger,
    host_runtime::runtime_credential::{RuntimeGeneration, RuntimeScope},
};

/// A complete, admitted `runtime_stop` params object. Its payload is private so a
/// sender can move it to the transport but cannot edit one coordinate after the
/// generation admission has passed.
#[derive(Debug)]
pub(crate) struct RuntimeStopCommand {
    params: Value,
}

impl RuntimeStopCommand {
    pub(crate) fn encode(
        scope: &RuntimeScope,
        generation: RuntimeGeneration,
    ) -> Result<Self, RuntimeStopCodecError> {
        let generation = generation.as_i64();
        let generation =
            JsSafeInteger::new(generation).map_err(|_| RuntimeStopCodecError { generation })?;
        if generation.get() <= 0 {
            return Err(RuntimeStopCodecError {
                generation: generation.get(),
            });
        }
        Ok(Self {
            params: json!({
                "runtime_scope": super::scope_wire(scope),
                "runtime_generation": generation.get(),
                "mode": "hard",
            }),
        })
    }

    pub(crate) fn into_params(self) -> Value {
        self.params
    }
}

/// A typed runtime generation that cannot be represented by the daemon's
/// `positive()` JavaScript-number schema without rejection or precision loss.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) struct RuntimeStopCodecError {
    generation: i64,
}

impl RuntimeStopCodecError {
    pub(crate) fn generation(self) -> i64 {
        self.generation
    }
}

impl fmt::Display for RuntimeStopCodecError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(
            "runtime_stop generation must be positive and at most Number.MAX_SAFE_INTEGER",
        )
    }
}

impl Error for RuntimeStopCodecError {}

pub(crate) fn valid_result(result: &Value) -> bool {
    let Some(object) = result.as_object() else {
        return false;
    };
    object.len() == 3
        && object.get("mode").and_then(Value::as_str) == Some("hard")
        && object.get("stopped").and_then(Value::as_bool).is_some()
        && object
            .get("exit_code")
            .is_some_and(|value| value.is_null() || value.as_i64().is_some())
}

#[cfg(test)]
mod tests {
    use super::*;
    use silverhand_backend_core::foundation::identity::{AgentId, ConversationId};

    #[test]
    fn generation_admission_is_positive_and_javascript_exact() {
        let scope = RuntimeScope::AgentSlot {
            agent: AgentId::parse("agent-a").unwrap(),
        };
        for invalid in [0, JsSafeInteger::MAX + 1, i64::MAX] {
            assert_eq!(
                RuntimeStopCommand::encode(&scope, RuntimeGeneration::new(invalid).unwrap())
                    .unwrap_err(),
                RuntimeStopCodecError {
                    generation: invalid
                }
            );
        }
        let params =
            RuntimeStopCommand::encode(&scope, RuntimeGeneration::new(JsSafeInteger::MAX).unwrap())
                .unwrap()
                .into_params();
        assert_eq!(
            params["runtime_generation"].as_i64(),
            Some(JsSafeInteger::MAX)
        );
    }

    #[test]
    fn both_scope_arms_and_the_result_schema_are_exact() {
        let command = RuntimeStopCommand::encode(
            &RuntimeScope::ConversationSlot {
                agent: AgentId::parse("agent-a").unwrap(),
                source: ConversationId::parse("conversation-a").unwrap(),
            },
            RuntimeGeneration::new(1).unwrap(),
        )
        .unwrap()
        .into_params();
        assert_eq!(
            command,
            json!({
                "runtime_scope": {
                    "kind": "conversation",
                    "conversation_id": "conversation-a",
                    "agent_id": "agent-a",
                },
                "runtime_generation": 1,
                "mode": "hard",
            })
        );
        assert!(valid_result(
            &json!({ "mode": "hard", "stopped": true, "exit_code": null })
        ));
        assert!(!valid_result(&json!({
            "mode": "hard", "stopped": true, "exit_code": null, "extra": true
        })));
    }
}
