//! Profile MCP — the canonical config model and its fail-loud admission.
//!
//! Parity source: `packages/shared/src/mcp-config.ts` (the canonical raw shape)
//! and `docs/agent-mcp-config-v1.md` (the domain contract). This module owns
//! ONLY the canonical raw shape a subject declares — the standard MCP
//! `mcpServers` map — and how it parses and validates fail-loud. The
//! per-runtime translations (canonical → Claude / Codex / opencode argv) are a
//! spawn-path concern for a different consumer and are deliberately NOT
//! reproduced here: this lane's routes store and hand back the raw text and
//! only need the accept/reject admission plus, for `probe`, the resolved server
//! bodies.
//!
//! ## What is a contract and what is not
//!
//! The ACCEPT/REJECT decision is a hard contract: an input this module accepts
//! is exactly one `parseMcpConfig` accepts, and likewise for rejection. Two
//! product-authored facts are contracts and reproduced verbatim: an empty or
//! whitespace-only body parses to the empty config, and an out-of-charset
//! server name yields the message
//! `invalid MCP server name "<name>": use 1-64 chars of [A-Za-z0-9_-]`.
//!
//! The wording of a *structural* rejection (malformed JSON, wrong type, an
//! unknown key, a malformed server body) is NOT a contract. TS surfaces Zod's
//! internal issue text, which the migration guidance says to treat as an
//! implementation detail rather than clone. We emit our own stable single-line
//! message inside the same `invalid MCP config[ at <path>]: <message>` envelope
//! `parseMcpConfig` builds from `issue.path` + `issue.message`. When one server
//! carries both a bad name and a bad body we surface the product name message;
//! selecting between coexisting violations is likewise not a wire contract.

use std::collections::BTreeMap;

use serde_json::Value;

use crate::foundation::name_canonicalization::is_ecmascript_trim_whitespace;

/// Server-name charset ceiling. The raw name is embedded into a runtime server
/// name and, for Codex, into a TOML bare key, so it is bare-key safe:
/// `^[A-Za-z0-9_-]{1,64}$`.
const SERVER_NAME_MAX: usize = 64;

/// One MCP server: either a stdio launcher (the default when `type` is omitted)
/// or a remote endpoint (`type: http | sse` + `url`).
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum McpServerConfig {
    /// A stdio launcher. `command` is required and non-empty; `args`/`env` are
    /// optional. The `type` marker, when present, is exactly `"stdio"`.
    Stdio {
        command: String,
        args: Option<Vec<String>>,
        env: Option<BTreeMap<String, String>>,
    },
    /// A remote endpoint. `url` is a `new URL()`-parseable absolute URL;
    /// `headers` is optional. Both `http` and `sse` map to the same url-based
    /// form — the transport is the runtime's concern — but the declared
    /// `transport` is preserved so it survives a round trip.
    Remote {
        transport: McpRemoteTransport,
        url: String,
        headers: Option<BTreeMap<String, String>>,
    },
}

/// The declared remote transport. Both connect via `url`; the value is kept so
/// the canonical model is not lossy.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum McpRemoteTransport {
    Http,
    Sse,
}

/// The canonical raw file: the standard `{ "mcpServers": { <name>: {...} } }`
/// map. `mcpServers` defaults to empty when the key is absent.
#[derive(Clone, Debug, Eq, PartialEq, Default)]
pub struct McpConfig {
    servers: BTreeMap<String, McpServerConfig>,
}

impl McpConfig {
    /// The empty config — the value an empty or whitespace-only body parses to,
    /// and the default when `mcpServers` is omitted.
    pub fn empty() -> Self {
        Self::default()
    }

    /// The declared servers, keyed by their raw (user-visible) name.
    pub fn servers(&self) -> &BTreeMap<String, McpServerConfig> {
        &self.servers
    }
}

/// One rejection, mirroring a Zod issue: an optional path and a message. The
/// public string is assembled once by [`parse_mcp_config`] into the
/// `invalid MCP config[ at <path>]: <message>` envelope.
#[derive(Clone, Debug, Eq, PartialEq)]
struct ConfigIssue {
    path: Vec<String>,
    message: String,
}

impl ConfigIssue {
    fn at(path: Vec<String>, message: impl Into<String>) -> Self {
        Self {
            path,
            message: message.into(),
        }
    }

    fn root(message: impl Into<String>) -> Self {
        Self::at(Vec::new(), message)
    }

    /// Assemble the public single-line error exactly as `parseMcpConfig` does:
    /// `" at " + path.join('.')` when the path is non-empty, else the bare
    /// envelope.
    fn into_public_error(self) -> String {
        let where_clause = if self.path.is_empty() {
            String::new()
        } else {
            format!(" at {}", self.path.join("."))
        };
        format!("invalid MCP config{where_clause}: {}", self.message)
    }
}

/// Parse and validate raw JSON text into an [`McpConfig`]. Fail-loud: returns a
/// readable single-line error for bad JSON or a schema violation and never
/// panics. An empty or whitespace-only body parses to the empty config.
///
/// The trim uses the SAME ECMAScript whitespace set as every other Zod
/// `.trim()` mirror in the domain, so the empty-body discriminator can never
/// drift from `String.prototype.trim()`.
pub fn parse_mcp_config(raw: &str) -> Result<McpConfig, String> {
    let trimmed = raw.trim_matches(is_ecmascript_trim_whitespace);
    if trimmed.is_empty() {
        return Ok(McpConfig::empty());
    }

    let json: Value = match serde_json::from_str(trimmed) {
        Ok(value) => value,
        // The JSON parser's detail differs between engines; only the
        // `invalid JSON: ` envelope is stable, matching `parseMcpConfig`.
        Err(err) => return Err(format!("invalid JSON: {err}")),
    };

    validate_config(&json).map_err(ConfigIssue::into_public_error)
}

/// Validate a parsed JSON value against the strict `McpConfigSchema`.
fn validate_config(json: &Value) -> Result<McpConfig, ConfigIssue> {
    let object = json
        .as_object()
        .ok_or_else(|| ConfigIssue::root("expected an object"))?;

    // `.strict()` at the top level: `mcpServers` is the only permitted key.
    for key in object.keys() {
        if key != "mcpServers" {
            return Err(ConfigIssue::root(format!("unexpected key \"{key}\"")));
        }
    }

    let mut servers = BTreeMap::new();
    // `mcpServers` defaults to `{}` only when ABSENT; an explicit `null` is a
    // value the record rejects, so it is not treated as the default.
    if let Some(raw_servers) = object.get("mcpServers") {
        let entries = raw_servers
            .as_object()
            .ok_or_else(|| ConfigIssue::at(vec!["mcpServers".to_string()], "expected an object"))?;
        for (name, value) in entries {
            let name_path = vec!["mcpServers".to_string(), name.clone()];
            if !is_valid_server_name(name) {
                // The one product-authored message, reproduced verbatim.
                return Err(ConfigIssue::at(
                    name_path,
                    format!("invalid MCP server name \"{name}\": use 1-64 chars of [A-Za-z0-9_-]"),
                ));
            }
            let server =
                validate_server(value).map_err(|message| ConfigIssue::at(name_path, message))?;
            servers.insert(name.clone(), server);
        }
    }

    Ok(McpConfig { servers })
}

/// Validate one server value against the `McpServerConfig` union: stdio (the
/// default) or remote (`type: http | sse`). Returns a bare message; the caller
/// attaches the `mcpServers.<name>` path.
fn validate_server(value: &Value) -> Result<McpServerConfig, String> {
    let object = value
        .as_object()
        .ok_or_else(|| "expected a stdio or http/sse server object".to_string())?;

    // The union is discriminated by `type`: absent / "stdio" is the stdio arm;
    // "http" / "sse" is the remote arm; anything else matches neither strict
    // arm and is rejected, exactly as the Zod union would fail both.
    let declared_type = match object.get("type") {
        None => None,
        Some(Value::String(kind)) => Some(kind.as_str()),
        Some(_) => return Err("\"type\" must be a string".to_string()),
    };

    match declared_type {
        None | Some("stdio") => validate_stdio(object),
        Some("http") => validate_remote(object, McpRemoteTransport::Http),
        Some("sse") => validate_remote(object, McpRemoteTransport::Sse),
        Some(other) => Err(format!(
            "\"type\" must be one of stdio, http, sse (got \"{other}\")"
        )),
    }
}

/// The strict stdio arm: keys ⊆ {type, command, args, env}; `command` a
/// non-empty string; `args` an optional array of strings; `env` an optional map
/// of strings.
fn validate_stdio(object: &serde_json::Map<String, Value>) -> Result<McpServerConfig, String> {
    reject_unknown_keys(object, &["type", "command", "args", "env"])?;

    let command = match object.get("command") {
        Some(Value::String(command)) if !command.is_empty() => command.clone(),
        Some(Value::String(_)) => return Err("\"command\" must not be empty".to_string()),
        Some(_) => return Err("\"command\" must be a string".to_string()),
        None => return Err("stdio server requires a \"command\"".to_string()),
    };

    let args = match object.get("args") {
        Some(value) => Some(string_array(value, "args")?),
        None => None,
    };

    let env = match object.get("env") {
        Some(value) => Some(string_map(value, "env")?),
        None => None,
    };

    Ok(McpServerConfig::Stdio { command, args, env })
}

/// The strict remote arm: keys ⊆ {type, url, headers}; `url` a `new URL()`
/// -parseable string; `headers` an optional map of strings.
fn validate_remote(
    object: &serde_json::Map<String, Value>,
    transport: McpRemoteTransport,
) -> Result<McpServerConfig, String> {
    reject_unknown_keys(object, &["type", "url", "headers"])?;

    let url = match object.get("url") {
        Some(Value::String(url)) if url::Url::parse(url).is_ok() => url.clone(),
        Some(Value::String(_)) => return Err("\"url\" must be a valid URL".to_string()),
        Some(_) => return Err("\"url\" must be a string".to_string()),
        None => return Err("remote server requires a \"url\"".to_string()),
    };

    let headers = match object.get("headers") {
        Some(value) => Some(string_map(value, "headers")?),
        None => None,
    };

    Ok(McpServerConfig::Remote {
        transport,
        url,
        headers,
    })
}

/// Reject any key outside `allowed`, mirroring `.strict()`.
fn reject_unknown_keys(
    object: &serde_json::Map<String, Value>,
    allowed: &[&str],
) -> Result<(), String> {
    for key in object.keys() {
        if !allowed.contains(&key.as_str()) {
            return Err(format!("unexpected key \"{key}\""));
        }
    }
    Ok(())
}

/// `z.array(z.string())`: an array whose every element is a string.
fn string_array(value: &Value, field: &str) -> Result<Vec<String>, String> {
    let items = value
        .as_array()
        .ok_or_else(|| format!("\"{field}\" must be an array of strings"))?;
    let mut out = Vec::with_capacity(items.len());
    for item in items {
        match item {
            Value::String(item) => out.push(item.clone()),
            _ => return Err(format!("\"{field}\" must be an array of strings")),
        }
    }
    Ok(out)
}

/// `z.record(z.string())`: an object whose every value is a string.
fn string_map(value: &Value, field: &str) -> Result<BTreeMap<String, String>, String> {
    let entries = value
        .as_object()
        .ok_or_else(|| format!("\"{field}\" must be an object of strings"))?;
    let mut out = BTreeMap::new();
    for (key, item) in entries {
        match item {
            Value::String(item) => {
                out.insert(key.clone(), item.clone());
            }
            _ => return Err(format!("\"{field}\" must be an object of strings")),
        }
    }
    Ok(out)
}

/// `^[A-Za-z0-9_-]{1,64}$`. Every permitted character is ASCII, so a name that
/// carries any non-ASCII code point fails the charset test before length ever
/// matters — counting `chars()` therefore matches the regex's code-point count.
fn is_valid_server_name(name: &str) -> bool {
    let mut count = 0usize;
    for character in name.chars() {
        if !(character.is_ascii_alphanumeric() || character == '_' || character == '-') {
            return false;
        }
        count += 1;
        if count > SERVER_NAME_MAX {
            return false;
        }
    }
    count >= 1
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(raw: &str) -> Result<McpConfig, String> {
        parse_mcp_config(raw)
    }

    #[test]
    fn empty_and_whitespace_only_bodies_parse_to_the_empty_config() {
        for raw in ["", "   ", "\t\n", "\u{feff}\u{2028} \u{00a0}"] {
            assert_eq!(parse(raw), Ok(McpConfig::empty()), "raw = {raw:?}");
        }
    }

    #[test]
    fn an_absent_mcp_servers_key_defaults_to_empty() {
        assert_eq!(parse("{}"), Ok(McpConfig::empty()));
        assert_eq!(parse(r#"{"mcpServers": {}}"#), Ok(McpConfig::empty()));
    }

    #[test]
    fn malformed_json_reports_the_invalid_json_envelope() {
        let error = parse("{not json").unwrap_err();
        assert!(error.starts_with("invalid JSON: "), "{error}");
    }

    #[test]
    fn a_non_object_top_level_is_rejected() {
        assert_eq!(
            parse("[]").unwrap_err(),
            "invalid MCP config: expected an object"
        );
        assert_eq!(
            parse("\"hi\"").unwrap_err(),
            "invalid MCP config: expected an object"
        );
    }

    #[test]
    fn an_unknown_top_level_key_is_rejected() {
        assert_eq!(
            parse(r#"{"mcpServers": {}, "extra": 1}"#).unwrap_err(),
            "invalid MCP config: unexpected key \"extra\""
        );
    }

    #[test]
    fn mcp_servers_must_be_an_object() {
        assert_eq!(
            parse(r#"{"mcpServers": []}"#).unwrap_err(),
            "invalid MCP config at mcpServers: expected an object"
        );
        // Explicit null is a rejected value, not the absent-key default.
        assert_eq!(
            parse(r#"{"mcpServers": null}"#).unwrap_err(),
            "invalid MCP config at mcpServers: expected an object"
        );
    }

    #[test]
    fn a_minimal_stdio_server_is_accepted() {
        let config = parse(r#"{"mcpServers": {"gh": {"command": "run"}}}"#).unwrap();
        assert_eq!(
            config.servers().get("gh"),
            Some(&McpServerConfig::Stdio {
                command: "run".to_string(),
                args: None,
                env: None,
            })
        );
    }

    #[test]
    fn a_full_stdio_server_is_accepted() {
        let config = parse(
            r#"{"mcpServers": {"gh": {"type": "stdio", "command": "run", "args": ["a", "b"], "env": {"K": "V"}}}}"#,
        )
        .unwrap();
        let McpServerConfig::Stdio { command, args, env } = config.servers().get("gh").unwrap()
        else {
            panic!("expected stdio");
        };
        assert_eq!(command, "run");
        assert_eq!(
            args.as_deref(),
            Some(["a".to_string(), "b".to_string()].as_slice())
        );
        assert_eq!(env.as_ref().unwrap().get("K"), Some(&"V".to_string()));
    }

    #[test]
    fn stdio_requires_a_non_empty_command() {
        assert_eq!(
            parse(r#"{"mcpServers": {"gh": {}}}"#).unwrap_err(),
            "invalid MCP config at mcpServers.gh: stdio server requires a \"command\""
        );
        assert_eq!(
            parse(r#"{"mcpServers": {"gh": {"command": ""}}}"#).unwrap_err(),
            "invalid MCP config at mcpServers.gh: \"command\" must not be empty"
        );
        assert_eq!(
            parse(r#"{"mcpServers": {"gh": {"command": 1}}}"#).unwrap_err(),
            "invalid MCP config at mcpServers.gh: \"command\" must be a string"
        );
    }

    #[test]
    fn stdio_rejects_unknown_keys() {
        assert_eq!(
            parse(r#"{"mcpServers": {"gh": {"command": "run", "url": "http://x"}}}"#).unwrap_err(),
            "invalid MCP config at mcpServers.gh: unexpected key \"url\""
        );
    }

    #[test]
    fn stdio_args_and_env_must_be_string_shaped() {
        assert_eq!(
            parse(r#"{"mcpServers": {"gh": {"command": "run", "args": [1]}}}"#).unwrap_err(),
            "invalid MCP config at mcpServers.gh: \"args\" must be an array of strings"
        );
        assert_eq!(
            parse(r#"{"mcpServers": {"gh": {"command": "run", "env": {"K": 1}}}}"#).unwrap_err(),
            "invalid MCP config at mcpServers.gh: \"env\" must be an object of strings"
        );
    }

    #[test]
    fn a_remote_http_and_sse_server_is_accepted() {
        let config = parse(
            r#"{"mcpServers": {"a": {"type": "http", "url": "https://x/y"}, "b": {"type": "sse", "url": "https://z", "headers": {"H": "1"}}}}"#,
        )
        .unwrap();
        assert_eq!(
            config.servers().get("a"),
            Some(&McpServerConfig::Remote {
                transport: McpRemoteTransport::Http,
                url: "https://x/y".to_string(),
                headers: None,
            })
        );
        let McpServerConfig::Remote {
            transport, headers, ..
        } = config.servers().get("b").unwrap()
        else {
            panic!("expected remote");
        };
        assert_eq!(*transport, McpRemoteTransport::Sse);
        assert_eq!(headers.as_ref().unwrap().get("H"), Some(&"1".to_string()));
    }

    #[test]
    fn remote_requires_a_valid_url() {
        assert_eq!(
            parse(r#"{"mcpServers": {"a": {"type": "http"}}}"#).unwrap_err(),
            "invalid MCP config at mcpServers.a: remote server requires a \"url\""
        );
        assert_eq!(
            parse(r#"{"mcpServers": {"a": {"type": "http", "url": "not a url"}}}"#).unwrap_err(),
            "invalid MCP config at mcpServers.a: \"url\" must be a valid URL"
        );
    }

    #[test]
    fn remote_rejects_unknown_keys() {
        assert_eq!(
            parse(
                r#"{"mcpServers": {"a": {"type": "http", "url": "https://x", "command": "run"}}}"#
            )
            .unwrap_err(),
            "invalid MCP config at mcpServers.a: unexpected key \"command\""
        );
    }

    #[test]
    fn an_unknown_or_non_string_type_is_rejected() {
        assert_eq!(
            parse(r#"{"mcpServers": {"a": {"type": "grpc", "url": "https://x"}}}"#).unwrap_err(),
            "invalid MCP config at mcpServers.a: \"type\" must be one of stdio, http, sse (got \"grpc\")"
        );
        assert_eq!(
            parse(r#"{"mcpServers": {"a": {"type": 1}}}"#).unwrap_err(),
            "invalid MCP config at mcpServers.a: \"type\" must be a string"
        );
    }

    #[test]
    fn an_out_of_charset_server_name_yields_the_product_message() {
        assert_eq!(
            parse(r#"{"mcpServers": {"bad name": {"command": "run"}}}"#).unwrap_err(),
            "invalid MCP config at mcpServers.bad name: invalid MCP server name \"bad name\": use 1-64 chars of [A-Za-z0-9_-]"
        );
        // The empty-string key both fails the charset and renders a trailing-dot path.
        assert_eq!(
            parse(r#"{"mcpServers": {"": {"command": "run"}}}"#).unwrap_err(),
            "invalid MCP config at mcpServers.: invalid MCP server name \"\": use 1-64 chars of [A-Za-z0-9_-]"
        );
    }

    #[test]
    fn server_name_charset_and_length_match_the_regex() {
        assert!(is_valid_server_name("a"));
        assert!(is_valid_server_name("A0_-z"));
        assert!(is_valid_server_name(&"x".repeat(64)));
        assert!(!is_valid_server_name(""));
        assert!(!is_valid_server_name(&"x".repeat(65)));
        assert!(!is_valid_server_name("a.b"));
        assert!(!is_valid_server_name("na me"));
        assert!(!is_valid_server_name("café"));
    }
}
