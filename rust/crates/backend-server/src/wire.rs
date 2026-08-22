use serde::{Deserialize, Deserializer, Serialize, Serializer, de::Error as _};
use silverhand_backend_core::foundation_message::{Message, MessagePageFact};
use ts_rs::{Config, TS};

pub const HEALTH_PATH: &str = "/healthz";
pub const FOUNDATION_MESSAGE_PATH: &str = "/_foundation/messages";
pub const FOUNDATION_EVENT_WEBSOCKET_PATH: &str = "/_foundation/ws/events";
pub const EVENT_LAG_CLOSE_CODE: u16 = 1013;
pub const EVENT_LAG_CLOSE_REASON: &str = "event consumer lagged; reconnect and resync";
pub const WIRE_CONTRACT_VERSION: u32 = 1;

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "snake_case")]
pub enum HealthStatus {
    Ok,
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct WireContractVersion;

impl Serialize for WireContractVersion {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        serializer.serialize_u32(WIRE_CONTRACT_VERSION)
    }
}

impl<'de> Deserialize<'de> for WireContractVersion {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let version = u32::deserialize(deserializer)?;
        if version == WIRE_CONTRACT_VERSION {
            Ok(Self)
        } else {
            Err(D::Error::custom(format_args!(
                "expected wire contract version {WIRE_CONTRACT_VERSION}, got {version}"
            )))
        }
    }
}

impl TS for WireContractVersion {
    type WithoutGenerics = Self;
    type OptionInnerType = Self;

    fn name(_config: &Config) -> String {
        WIRE_CONTRACT_VERSION.to_string()
    }

    fn inline(config: &Config) -> String {
        Self::name(config)
    }
}

/// @strict
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HealthResponse {
    pub status: HealthStatus,
    pub wire_contract_version: WireContractVersion,
}

/// @strict
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CreateFoundationMessageRequest {
    pub body: String,
}

/// @strict
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MessageDto {
    pub id: String,
    pub body: String,
    pub created_at_ms: String,
}

impl From<Message> for MessageDto {
    fn from(message: Message) -> Self {
        Self {
            id: message.id.to_string(),
            body: message.body,
            created_at_ms: message.created_at_ms.to_string(),
        }
    }
}

/// @strict
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CreateFoundationMessageResponse {
    pub wire_contract_version: WireContractVersion,
    pub message: MessageDto,
}

/// @strict
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FoundationMessagePageResponse {
    pub wire_contract_version: WireContractVersion,
    pub total: String,
    pub latest: Option<MessageDto>,
}

impl From<MessagePageFact> for FoundationMessagePageResponse {
    fn from(page: MessagePageFact) -> Self {
        Self {
            wire_contract_version: WireContractVersion,
            total: page.total.to_string(),
            latest: page.latest.map(Into::into),
        }
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "snake_case")]
pub enum ApiErrorCode {
    InvalidRequest,
    Internal,
}

/// @strict
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ApiError {
    pub code: ApiErrorCode,
    pub message: String,
}

/// @strict
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ApiErrorResponse {
    pub wire_contract_version: WireContractVersion,
    pub error: ApiError,
}

/// @strict
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(
    tag = "type",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum ServerEvent {
    MessageCreated {
        wire_contract_version: WireContractVersion,
        message: MessageDto,
    },
}

pub fn aggregate_typescript_manifest() -> String {
    let config = Config::default();
    let declarations = [
        exported_decl::<HealthStatus>(&config),
        exported_decl::<HealthResponse>(&config),
        exported_decl::<CreateFoundationMessageRequest>(&config),
        exported_decl::<MessageDto>(&config),
        exported_decl::<CreateFoundationMessageResponse>(&config),
        exported_decl::<FoundationMessagePageResponse>(&config),
        exported_decl::<ApiErrorCode>(&config),
        exported_decl::<ApiError>(&config),
        exported_decl::<ApiErrorResponse>(&config),
        exported_decl::<ServerEvent>(&config),
    ];
    format!(
        "// @generated by silverhand-backend-server; DO NOT EDIT.\n\n{}\n",
        declarations.join("\n\n")
    )
}

fn exported_decl<T: TS>(config: &Config) -> String {
    let docs = T::docs()
        .map(|docs| format!("{docs}\n"))
        .unwrap_or_default();
    format!("{docs}export {}", T::decl(config))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn aggregate_manifest_contains_the_public_contract_without_escape_hatches() {
        let manifest = aggregate_typescript_manifest();
        for declaration in [
            "export type HealthResponse",
            "export type CreateFoundationMessageRequest",
            "export type CreateFoundationMessageResponse",
            "export type FoundationMessagePageResponse",
            "export type ApiErrorResponse",
            "export type ServerEvent",
        ] {
            assert!(manifest.contains(declaration));
        }
        assert!(manifest.contains("wireContractVersion: 1"));
        assert!(manifest.contains("\"type\": \"message_created\""));
        assert!(!manifest.contains(": any"));
        assert!(!manifest.contains("unknown"));
        assert!(!manifest.contains("bigint"));
        assert!(!manifest.contains("import "));
    }

    #[test]
    fn wire_contract_version_serializes_and_deserializes_as_the_exact_literal() {
        let response = HealthResponse {
            status: HealthStatus::Ok,
            wire_contract_version: WireContractVersion,
        };
        assert_eq!(
            serde_json::to_value(response).unwrap(),
            serde_json::json!({ "status": "ok", "wireContractVersion": 1 })
        );

        for version in [
            serde_json::json!(2),
            serde_json::json!(-1),
            serde_json::json!(1.5),
        ] {
            let value = serde_json::json!({ "status": "ok", "wireContractVersion": version });
            assert!(serde_json::from_value::<HealthResponse>(value).is_err());
        }
    }

    #[test]
    fn core_values_project_to_json_safe_wire_values() {
        let page = FoundationMessagePageResponse::from(MessagePageFact {
            total: i64::MAX,
            latest: Some(Message {
                id: i64::MAX,
                body: "projected".into(),
                created_at_ms: i64::MIN,
            }),
        });

        assert_eq!(page.total, i64::MAX.to_string());
        let message = page.latest.unwrap();
        assert_eq!(message.id, i64::MAX.to_string());
        assert_eq!(message.created_at_ms, i64::MIN.to_string());
    }
}
