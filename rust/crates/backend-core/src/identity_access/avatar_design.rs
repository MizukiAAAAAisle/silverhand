//! The editable source of an avatar image produced by the avatar maker.
//!
//! Display authority stays the avatar image pointer; a design only lets the editor
//! reopen what produced the current image. It is written in the same row write as
//! that image and cleared by every other avatar write.

use std::future::Future;

use serde_json::{Map, Value};

use crate::{
    foundation::identity::{AgentId, UserId},
    foundation::persistence::PersistenceFailure,
};

/// Upper bound for the serialized `config` object.
pub const AVATAR_DESIGN_CONFIG_MAX_BYTES: usize = 4096;
/// Upper bound for the raw multipart `design` field, enforced before JSON parsing.
pub const AVATAR_DESIGN_FIELD_MAX_BYTES: usize = 8192;

/// A validated design: a positive part-library version and an opaque JSON object.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AvatarDesign {
    parts_version: u32,
    config: String,
}

/// The single refusal for a malformed `design` field.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct AvatarDesignRejection;

impl AvatarDesignRejection {
    pub const fn code(self) -> &'static str {
        "avatar_design_invalid"
    }

    pub const fn message(self) -> &'static str {
        "Avatar design is invalid."
    }
}

impl AvatarDesign {
    /// Parse the wire form `{"parts_version": N, "config": {...}}`; no other keys.
    pub fn parse_wire(raw: &[u8]) -> Result<Self, AvatarDesignRejection> {
        if raw.len() > AVATAR_DESIGN_FIELD_MAX_BYTES {
            return Err(AvatarDesignRejection);
        }
        let Ok(Value::Object(mut fields)) = serde_json::from_slice::<Value>(raw) else {
            return Err(AvatarDesignRejection);
        };
        let parts_version = fields
            .remove("parts_version")
            .and_then(|value| value.as_u64())
            .and_then(|value| u32::try_from(value).ok())
            .ok_or(AvatarDesignRejection)?;
        let Some(Value::Object(config)) = fields.remove("config") else {
            return Err(AvatarDesignRejection);
        };
        if !fields.is_empty() {
            return Err(AvatarDesignRejection);
        }
        Self::new(parts_version, &config)
    }

    /// Rebuild a stored design. Stored rows passed the same checks on write.
    pub fn from_stored(parts_version: i64, config: &str) -> Result<Self, AvatarDesignRejection> {
        let parts_version = u32::try_from(parts_version).map_err(|_| AvatarDesignRejection)?;
        let Ok(Value::Object(config)) = serde_json::from_str::<Value>(config) else {
            return Err(AvatarDesignRejection);
        };
        Self::new(parts_version, &config)
    }

    fn new(parts_version: u32, config: &Map<String, Value>) -> Result<Self, AvatarDesignRejection> {
        if parts_version == 0 {
            return Err(AvatarDesignRejection);
        }
        let config = serde_json::to_string(config).map_err(|_| AvatarDesignRejection)?;
        if config.len() > AVATAR_DESIGN_CONFIG_MAX_BYTES {
            return Err(AvatarDesignRejection);
        }
        Ok(Self {
            parts_version,
            config,
        })
    }

    pub fn parts_version(&self) -> u32 {
        self.parts_version
    }

    /// The canonical JSON object text, as stored.
    pub fn config_json(&self) -> &str {
        &self.config
    }

    /// The config as a JSON value for the wire.
    pub fn config_value(&self) -> Value {
        serde_json::from_str(&self.config).unwrap_or(Value::Object(Map::new()))
    }
}

/// Read the design behind a human's current avatar. `None` = no row, or the current
/// avatar is not a design (uploaded photo or no avatar).
pub trait UserAvatarDesignRead: Clone + Send + Sync + 'static {
    fn user_avatar_design(
        &self,
        user_id: &UserId,
    ) -> impl Future<Output = Result<Option<AvatarDesign>, PersistenceFailure>> + Send;
}

/// Read the design behind an agent's current avatar; same `None` meaning.
pub trait AgentAvatarDesignRead: Clone + Send + Sync + 'static {
    fn agent_avatar_design(
        &self,
        agent_id: &AgentId,
    ) -> impl Future<Output = Result<Option<AvatarDesign>, PersistenceFailure>> + Send;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wire_form_round_trips_canonical_config() {
        let design = AvatarDesign::parse_wire(
            br#"{"config":{"parts":{"hair":3,"hat":-1},"bg":2},"parts_version":4}"#,
        )
        .unwrap();
        assert_eq!(design.parts_version(), 4);
        assert_eq!(
            design.config_json(),
            r#"{"bg":2,"parts":{"hair":3,"hat":-1}}"#
        );
        assert_eq!(
            AvatarDesign::from_stored(4, design.config_json()).unwrap(),
            design
        );
    }

    #[test]
    fn refuses_every_malformed_shape() {
        for raw in [
            &b"not json"[..],
            br#"[]"#,
            br#"{"parts_version":1}"#,
            br#"{"config":{}}"#,
            br#"{"parts_version":0,"config":{}}"#,
            br#"{"parts_version":-1,"config":{}}"#,
            br#"{"parts_version":1.5,"config":{}}"#,
            br#"{"parts_version":4294967296,"config":{}}"#,
            br#"{"parts_version":"1","config":{}}"#,
            br#"{"parts_version":1,"config":[]}"#,
            br#"{"parts_version":1,"config":{},"extra":true}"#,
        ] {
            assert_eq!(
                AvatarDesign::parse_wire(raw),
                Err(AvatarDesignRejection),
                "{}",
                String::from_utf8_lossy(raw)
            );
        }
    }

    #[test]
    fn enforces_the_config_and_field_caps() {
        let fits = format!(
            r#"{{"parts_version":1,"config":{{"k":"{}"}}}}"#,
            "x".repeat(AVATAR_DESIGN_CONFIG_MAX_BYTES - 8)
        );
        assert!(AvatarDesign::parse_wire(fits.as_bytes()).is_ok());
        let over = format!(
            r#"{{"parts_version":1,"config":{{"k":"{}"}}}}"#,
            "x".repeat(AVATAR_DESIGN_CONFIG_MAX_BYTES - 7)
        );
        assert!(AvatarDesign::parse_wire(over.as_bytes()).is_err());
        let field = vec![b' '; AVATAR_DESIGN_FIELD_MAX_BYTES + 1];
        assert!(AvatarDesign::parse_wire(&field).is_err());
    }
}
