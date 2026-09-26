//! Transport-owned codecs for the existing agent profile MCP command family.
//!
//! These functions are the sole production owners of the three params/result
//! schemas. The product adapter supplies typed domain coordinates and consumes
//! typed results; it never assembles or opens free-form command JSON itself.

use serde_json::{Map, Value, json};
use silverhand_backend_core::{
    foundation::identity::AgentId,
    identity_access::agent_profile_mcp::{
        McpBytesWritten, McpProbeCommand, McpProbeOutcome, McpProbePhase, McpProbeServerInfo,
        McpProbeTool,
    },
};

pub(crate) fn encode_read(agent: &AgentId) -> Value {
    json!({ "agent_id": agent.as_str() })
}

pub(crate) fn encode_write(agent: &AgentId, raw: &str) -> Value {
    json!({ "agent_id": agent.as_str(), "raw": raw })
}

pub(crate) fn encode_probe(agent: &AgentId, command: &McpProbeCommand) -> Value {
    json!({
        "source": { "kind": "profile", "agent_id": agent.as_str() },
        "server_name": command.server_name,
        "include_tools": command.include_tools,
    })
}

pub(crate) fn decode_read(value: &Value) -> Option<Option<String>> {
    let object = exact_object(value, &["ok", "raw"])?;
    if object.get("ok").and_then(Value::as_bool) != Some(true) {
        return None;
    }
    match object.get("raw")? {
        Value::Null => Some(None),
        Value::String(raw) => Some(Some(raw.clone())),
        _ => None,
    }
}

pub(crate) fn decode_write(value: &Value) -> Option<McpBytesWritten> {
    let object = exact_object(value, &["bytes_written", "ok"])?;
    if object.get("ok").and_then(Value::as_bool) != Some(true) {
        return None;
    }
    // `as_u64` rejects negative and non-integer JSON numbers. The domain
    // constructor adds Number.MAX_SAFE_INTEGER, so no imprecise count crosses
    // into the typed port.
    McpBytesWritten::new(object.get("bytes_written")?.as_u64()?).ok()
}

pub(crate) fn decode_probe(value: &Value) -> Option<McpProbeOutcome> {
    let object = value.as_object()?;
    if object.keys().any(|key| {
        !matches!(
            key.as_str(),
            "ok" | "phase" | "message" | "server_info" | "tools"
        )
    }) {
        return None;
    }
    let ok = object.get("ok")?.as_bool()?;
    let phase = match object.get("phase")?.as_str()? {
        "parse" => McpProbePhase::Parse,
        "not_found" => McpProbePhase::NotFound,
        "connect" => McpProbePhase::Connect,
        "initialize" => McpProbePhase::Initialize,
        "tools" => McpProbePhase::Tools,
        _ => return None,
    };
    let message = optional_string(object, "message")?;
    let server_info = match object.get("server_info") {
        None => None,
        Some(value) => {
            let info = value.as_object()?;
            if info
                .keys()
                .any(|key| !matches!(key.as_str(), "name" | "version"))
            {
                return None;
            }
            Some(McpProbeServerInfo {
                name: optional_string(info, "name")?,
                version: optional_string(info, "version")?,
            })
        }
    };
    let tools = match object.get("tools") {
        None => None,
        Some(Value::Array(rows)) => Some(
            rows.iter()
                .map(|row| {
                    let row = exact_optional_object(row, &["description"], &["name"])?;
                    Some(McpProbeTool {
                        name: row.get("name")?.as_str()?.to_owned(),
                        description: optional_string(row, "description")?,
                    })
                })
                .collect::<Option<Vec<_>>>()?,
        ),
        Some(_) => return None,
    };
    Some(McpProbeOutcome {
        ok,
        phase,
        message,
        server_info,
        tools,
    })
}

fn exact_object<'a>(value: &'a Value, keys: &[&str]) -> Option<&'a Map<String, Value>> {
    let object = value.as_object()?;
    (object.len() == keys.len() && keys.iter().all(|key| object.contains_key(*key)))
        .then_some(object)
}

fn exact_optional_object<'a>(
    value: &'a Value,
    optional: &[&str],
    required: &[&str],
) -> Option<&'a Map<String, Value>> {
    let object = value.as_object()?;
    (required.iter().all(|key| object.contains_key(*key))
        && object
            .keys()
            .all(|key| required.contains(&key.as_str()) || optional.contains(&key.as_str())))
    .then_some(object)
}

/// `z.string().optional()` admits absence, not explicit `null`.
fn optional_string(object: &Map<String, Value>, key: &str) -> Option<Option<String>> {
    match object.get(key) {
        None => Some(None),
        Some(Value::String(value)) => Some(Some(value.clone())),
        Some(_) => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn agent() -> AgentId {
        AgentId::parse("agent-a").unwrap()
    }

    #[test]
    fn command_fixtures_preserve_the_existing_shapes_and_raw_text() {
        let raw = "{\n  \"mcpServers\": {\"sky😀\": {\"command\": \"x\"}}\n}\n";
        assert_eq!(encode_read(&agent()), json!({ "agent_id": "agent-a" }));
        assert_eq!(
            encode_write(&agent(), raw),
            json!({ "agent_id": "agent-a", "raw": raw })
        );
        assert_eq!(
            encode_probe(
                &agent(),
                &McpProbeCommand {
                    server_name: "sky".to_owned(),
                    include_tools: false,
                }
            ),
            json!({
                "source": { "kind": "profile", "agent_id": "agent-a" },
                "server_name": "sky",
                "include_tools": false,
            })
        );
    }

    #[test]
    fn read_and_write_results_are_strict_and_javascript_exact() {
        assert_eq!(decode_read(&json!({ "ok": true, "raw": null })), Some(None));
        assert_eq!(
            decode_read(&json!({ "ok": true, "raw": "{ }" })),
            Some(Some("{ }".to_owned()))
        );
        assert!(decode_read(&json!({ "ok": true, "raw": null, "extra": 1 })).is_none());

        assert_eq!(
            decode_write(&json!({ "ok": true, "bytes_written": 9_007_199_254_740_991_i64 }))
                .unwrap()
                .get(),
            9_007_199_254_740_991
        );
        for invalid in [
            json!({ "ok": true, "bytes_written": -1 }),
            json!({ "ok": true, "bytes_written": 1.5 }),
            json!({ "ok": true, "bytes_written": 9_007_199_254_740_992_i64 }),
        ] {
            assert!(decode_write(&invalid).is_none(), "{invalid}");
        }
    }

    #[test]
    fn probe_result_matches_strict_zod_optionals() {
        let decoded = decode_probe(&json!({
            "ok": true,
            "phase": "tools",
            "server_info": { "name": "srv", "version": "1" },
            "tools": [
                { "name": "read" },
                { "name": "write", "description": "writes" }
            ]
        }))
        .unwrap();
        assert_eq!(
            decoded,
            McpProbeOutcome {
                ok: true,
                phase: McpProbePhase::Tools,
                message: None,
                server_info: Some(McpProbeServerInfo {
                    name: Some("srv".to_owned()),
                    version: Some("1".to_owned()),
                }),
                tools: Some(vec![
                    McpProbeTool {
                        name: "read".to_owned(),
                        description: None
                    },
                    McpProbeTool {
                        name: "write".to_owned(),
                        description: Some("writes".to_owned())
                    },
                ]),
            }
        );

        for invalid in [
            json!({ "ok": false, "phase": "banana" }),
            json!({ "ok": false, "phase": "connect", "message": null }),
            json!({ "ok": true, "phase": "initialize", "server_info": { "extra": 1 } }),
            json!({ "ok": true, "phase": "tools", "tools": [{ "name": "x", "extra": 1 }] }),
            json!({ "ok": true, "phase": "tools", "extra": true }),
        ] {
            assert!(decode_probe(&invalid).is_none(), "{invalid}");
        }
    }
}
