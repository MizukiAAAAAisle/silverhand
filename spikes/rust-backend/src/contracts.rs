use serde::{Deserialize, Serialize};
use ts_rs::TS;

pub const CREATE_MESSAGE_PATH: &str = "/api/messages";
pub const EVENT_WEBSOCKET_PATH: &str = "/api/ws/events";
pub const WIRE_CONTRACT_VERSION: u32 = 1;

#[derive(Debug, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct CreateMessageRequest {
    pub body: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq, TS)]
#[serde(rename_all = "camelCase")]
pub struct MessageDto {
    // Application integers stay internal; integer wire values are decimal
    // strings so JSON never loses precision or claims to carry a `bigint`.
    pub id: String,
    pub body: String,
    pub created_at_ms: String,
}

#[derive(Debug, Serialize, Deserialize, PartialEq, Eq, TS)]
#[serde(rename_all = "camelCase")]
pub struct CreateMessageResponse {
    pub message: MessageDto,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq, TS)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ServerEvent {
    MessageCreated { message: MessageDto },
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Serialize, TS)]
    struct TsRsShapeProbe {
        nullable: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        maybe_omitted: Option<String>,
        #[ts(optional)]
        optional_non_null: Option<String>,
        integer: i64,
    }

    #[test]
    fn tagged_enum_and_integer_wire_shape_are_explicit() {
        let config = ts_rs::Config::default();
        let event = ServerEvent::inline(&config);
        assert!(event.contains("\"type\": \"message_created\""));

        let message = MessageDto::inline(&config);
        assert!(message.contains("id: string"));
        assert!(message.contains("createdAtMs: string"));
        assert!(!message.contains(": bigint"));
    }

    #[test]
    fn ts_rs_nullable_optional_and_i64_mappings_are_audited() {
        let probe = TsRsShapeProbe::inline(&ts_rs::Config::default());
        assert!(probe.contains("nullable: string | null"));
        assert!(probe.contains("maybe_omitted?: string | null"));
        assert!(probe.contains("optional_non_null?: string"));
        assert!(probe.contains("integer: bigint"));
    }
}
