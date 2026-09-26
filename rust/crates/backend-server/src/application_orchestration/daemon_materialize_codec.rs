//! Transport-owned codec for `agent_materialize`.

use std::{error::Error, fmt};

use serde_json::{Value, json};
use silverhand_backend_core::{
    foundation::wire_number::JsSafeInteger,
    host_runtime::agent_materialize::{AgentMaterializeReceipt, AgentMaterializeTarget},
};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) struct AgentMaterializeCodecError;

impl fmt::Display for AgentMaterializeCodecError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("agent_materialize value is outside the command schema")
    }
}

impl Error for AgentMaterializeCodecError {}

pub(crate) fn encode(target: &AgentMaterializeTarget) -> Result<Value, AgentMaterializeCodecError> {
    let utf16_len = target.name().encode_utf16().count();
    if !(1..=64).contains(&utf16_len) {
        return Err(AgentMaterializeCodecError);
    }
    Ok(json!({
        "agent_id": target.agent().as_str(),
        "agent_home_workspace_id": target.agent_home_workspace().as_str(),
        "name": target.name(),
        "runtime": target.runtime().as_str(),
        "model": target.model(),
        "description": target.description(),
        "template_choice": target.template().as_str(),
    }))
}

pub(crate) fn decode_result(value: &Value) -> Option<AgentMaterializeReceipt> {
    let object = value.as_object()?;
    if object.len() != 4 || object.get("ok").and_then(Value::as_bool) != Some(true) {
        return None;
    }
    let agent_dir = object.get("agent_dir")?.as_str()?;
    let home = object.get("agent_home_workspace_path")?.as_str()?;
    if agent_dir.is_empty() || agent_dir != home {
        return None;
    }
    let materialized_at = object.get("materialized_at")?.as_i64()?;
    let materialized_at = JsSafeInteger::new(materialized_at).ok()?.get();
    if materialized_at <= 0 {
        return None;
    }
    Some(AgentMaterializeReceipt::admitted(
        agent_dir.to_owned(),
        materialized_at,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use silverhand_backend_core::{
        foundation::identity::{AgentId, HostId, WorkspaceId},
        host_runtime::agent_materialize::AgentMaterializeTemplate,
        identity_access::agents::runtime::RuntimeKind,
    };

    fn target(name: String) -> AgentMaterializeTarget {
        AgentMaterializeTarget::reserved(
            HostId::parse("host-a").unwrap(),
            AgentId::parse("agent-a").unwrap(),
            WorkspaceId::parse("wsah_agent-a").unwrap(),
            name,
            RuntimeKind::Codex,
            None,
            Some("desc".to_owned()),
            AgentMaterializeTemplate::Default,
        )
    }

    #[test]
    fn exact_fixture_and_equal_paths_are_required() {
        assert_eq!(
            encode(&target("Agent A".to_owned())).unwrap(),
            json!({
                "agent_id":"agent-a","agent_home_workspace_id":"wsah_agent-a",
                "name":"Agent A","runtime":"codex","model":null,
                "description":"desc","template_choice":"default"
            })
        );
        for timestamp in [1, 9_007_199_254_740_991] {
            let receipt = decode_result(&json!({
                "ok":true,"agent_dir":"/opaque/agent-a",
                "agent_home_workspace_path":"/opaque/agent-a","materialized_at":timestamp
            }))
            .expect("a positive wire-safe acknowledgement");
            assert_eq!(receipt.agent_dir(), "/opaque/agent-a");
            assert_eq!(receipt.agent_home_workspace_path(), "/opaque/agent-a");
            assert_eq!(receipt.materialized_at(), timestamp);
        }
        for bad in [
            json!(null),
            json!({"ok":false,"agent_dir":"/a","agent_home_workspace_path":"/a","materialized_at":1}),
            json!({"ok":true,"agent_dir":"/a","agent_home_workspace_path":"/b","materialized_at":1}),
            json!({"ok":true,"agent_dir":"","agent_home_workspace_path":"","materialized_at":1}),
            json!({"ok":true,"agent_dir":"/a","agent_home_workspace_path":"/a","materialized_at":0}),
            json!({"ok":true,"agent_dir":"/a","agent_home_workspace_path":"/a","materialized_at":-1}),
            json!({"ok":true,"agent_dir":"/a","agent_home_workspace_path":"/a","materialized_at":1.5}),
            json!({"ok":true,"agent_dir":"/a","agent_home_workspace_path":"/a","materialized_at":9_007_199_254_740_992_i64}),
            json!({"ok":true,"agent_dir":"/a","agent_home_workspace_path":"/a","materialized_at":1,"extra":true}),
            json!({"ok":true,"agent_dir":"/a","materialized_at":1}),
        ] {
            assert!(
                decode_result(&bad).is_none(),
                "rejected acknowledgement: {bad}"
            );
        }
    }

    #[test]
    fn name_uses_javascript_utf16_length() {
        for (name, admitted) in [
            (String::new(), false),
            ("a".to_owned(), true),
            ("a".repeat(64), true),
            ("a".repeat(65), false),
            ("😀".repeat(32), true),
            ("😀".repeat(33), false),
        ] {
            assert_eq!(encode(&target(name)).is_ok(), admitted);
        }
    }
}
