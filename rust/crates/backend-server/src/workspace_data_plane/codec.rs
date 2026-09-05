//! Transport-owned codecs for the workspace filesystem command family.
//!
//! These functions are the sole production owners of the tree/file params and
//! result schemas. The adapter supplies typed domain coordinates and consumes
//! typed results; it never assembles or opens free-form command JSON. Decoders
//! are strict — an unknown key, a wrong `ok`, a missing field, an empty `path`, or
//! a stat that is not a JavaScript-safe integer all return `None`, which the
//! adapter converges to `daemon_internal_error` rather than surfacing a half-shaped
//! answer.

use serde_json::{Map, Value, json};

use silverhand_backend_core::{
    foundation::identity::{AgentId, WorkspaceId},
    foundation::wire_number::JsSafeInteger,
    workspace_data_plane::{
        WorkspaceFileRead, WorkspaceMtime, WorkspaceNodeKind, WorkspaceTree, WorkspaceTreeNode,
    },
};

/// `{ agent_id, workspace_id? }` — the scope id is present only for the narrower
/// per-workspace view; its absence is the agent's broad home view.
pub(crate) fn encode_tree(agent: &AgentId, workspace: Option<&WorkspaceId>) -> Value {
    let mut params = Map::new();
    params.insert("agent_id".to_owned(), json!(agent.as_str()));
    if let Some(workspace) = workspace {
        params.insert("workspace_id".to_owned(), json!(workspace.as_str()));
    }
    Value::Object(params)
}

/// `{ agent_id, path, workspace_id? }` — `path` is passed through verbatim; the
/// backend does no shape work on it.
pub(crate) fn encode_file(agent: &AgentId, workspace: Option<&WorkspaceId>, path: &str) -> Value {
    let mut params = Map::new();
    params.insert("agent_id".to_owned(), json!(agent.as_str()));
    params.insert("path".to_owned(), json!(path));
    if let Some(workspace) = workspace {
        params.insert("workspace_id".to_owned(), json!(workspace.as_str()));
    }
    Value::Object(params)
}

/// `{ ok: true, tree: { nodes: [ { path, kind, size, mtime } ] } }`.
pub(crate) fn decode_tree(value: &Value) -> Option<WorkspaceTree> {
    let object = exact_object(value, &["ok", "tree"])?;
    if object.get("ok")?.as_bool() != Some(true) {
        return None;
    }
    let tree = exact_object(object.get("tree")?, &["nodes"])?;
    let Value::Array(rows) = tree.get("nodes")? else {
        return None;
    };
    let nodes = rows.iter().map(decode_node).collect::<Option<Vec<_>>>()?;
    Some(WorkspaceTree { nodes })
}

/// `{ ok: true, file: { path, content, size, mtime, truncated } }`.
pub(crate) fn decode_file(value: &Value) -> Option<WorkspaceFileRead> {
    let object = exact_object(value, &["ok", "file"])?;
    if object.get("ok")?.as_bool() != Some(true) {
        return None;
    }
    let file = exact_object(
        object.get("file")?,
        &["path", "content", "size", "mtime", "truncated"],
    )?;
    Some(WorkspaceFileRead {
        path: nonempty_path(file.get("path")?)?,
        content: file.get("content")?.as_str()?.to_owned(),
        size: js_safe_stat(file.get("size")?)?,
        mtime: WorkspaceMtime::new(file.get("mtime")?.as_f64()?)?,
        truncated: file.get("truncated")?.as_bool()?,
    })
}

fn decode_node(value: &Value) -> Option<WorkspaceTreeNode> {
    let node = exact_object(value, &["path", "kind", "size", "mtime"])?;
    let kind = match node.get("kind")?.as_str()? {
        "file" => WorkspaceNodeKind::File,
        "directory" => WorkspaceNodeKind::Directory,
        _ => return None,
    };
    Some(WorkspaceTreeNode {
        path: nonempty_path(node.get("path")?)?,
        kind,
        size: js_safe_stat(node.get("size")?)?,
        mtime: WorkspaceMtime::new(node.get("mtime")?.as_f64()?)?,
    })
}

/// A node/file path must be a non-empty string. The daemon owns the path grammar,
/// but an empty `path` is never a real node it walked; matching the TS
/// `z.string().min(1)` inbound shape, it fails the decode.
fn nonempty_path(value: &Value) -> Option<String> {
    let path = value.as_str()?;
    (!path.is_empty()).then(|| path.to_owned())
}

/// A stat must be an integer JavaScript can represent exactly. `as_i64` already
/// rejects a fraction or an out-of-`i64` number; [`JsSafeInteger`] then rejects a
/// magnitude past `2^53-1` that would round on the JS side. A stat the boundary
/// refuses is a daemon answer this codec cannot represent, so the whole frame
/// folds to `daemon_internal_error` rather than crossing into the domain as an
/// unsafe value that would re-serialize wrong.
fn js_safe_stat(value: &Value) -> Option<JsSafeInteger> {
    JsSafeInteger::new(value.as_i64()?).ok()
}

fn exact_object<'a>(value: &'a Value, keys: &[&str]) -> Option<&'a Map<String, Value>> {
    let object = value.as_object()?;
    (object.len() == keys.len() && keys.iter().all(|key| object.contains_key(*key)))
        .then_some(object)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn agent() -> AgentId {
        AgentId::parse("agent-a").unwrap()
    }

    fn workspace() -> WorkspaceId {
        WorkspaceId::parse("ws-1").unwrap()
    }

    #[test]
    fn params_omit_the_scope_for_the_home_view_and_carry_it_otherwise() {
        assert_eq!(
            encode_tree(&agent(), None),
            json!({ "agent_id": "agent-a" })
        );
        assert_eq!(
            encode_tree(&agent(), Some(&workspace())),
            json!({ "agent_id": "agent-a", "workspace_id": "ws-1" })
        );
        assert_eq!(
            encode_file(&agent(), None, "src/main.rs"),
            json!({ "agent_id": "agent-a", "path": "src/main.rs" })
        );
        assert_eq!(
            encode_file(&agent(), Some(&workspace()), "a/b"),
            json!({ "agent_id": "agent-a", "path": "a/b", "workspace_id": "ws-1" })
        );
    }

    #[test]
    fn a_well_formed_tree_decodes_every_node() {
        let decoded = decode_tree(&json!({
            "ok": true,
            "tree": { "nodes": [
                { "path": "a", "kind": "directory", "size": 0, "mtime": 10 },
                { "path": "a/b.txt", "kind": "file", "size": 12, "mtime": 20 }
            ] }
        }))
        .unwrap();
        assert_eq!(decoded.nodes.len(), 2);
        assert_eq!(decoded.nodes[0].kind, WorkspaceNodeKind::Directory);
        assert_eq!(decoded.nodes[1].kind, WorkspaceNodeKind::File);
        assert_eq!(decoded.nodes[1].size.get(), 12);
    }

    #[test]
    fn an_empty_tree_is_a_valid_zero_node_answer() {
        let decoded = decode_tree(&json!({ "ok": true, "tree": { "nodes": [] } })).unwrap();
        assert!(decoded.nodes.is_empty());
    }

    #[test]
    fn a_well_formed_file_decodes() {
        let decoded = decode_file(&json!({
            "ok": true,
            "file": { "path": "a.txt", "content": "hi", "size": 2, "mtime": 5, "truncated": false }
        }))
        .unwrap();
        assert_eq!(decoded.content, "hi");
        assert!(!decoded.truncated);
    }

    #[test]
    fn strict_decode_rejects_drift_in_either_shape() {
        for invalid in [
            json!({ "ok": false, "tree": { "nodes": [] } }),
            json!({ "ok": true, "tree": { "nodes": [], "extra": 1 } }),
            json!({ "ok": true, "tree": { "nodes": [ { "path": "a", "kind": "socket", "size": 0, "mtime": 0 } ] } }),
            json!({ "ok": true, "tree": { "nodes": [ { "path": "a", "kind": "file", "size": 1.5, "mtime": 0 } ] } }),
            json!({ "ok": true, "tree": { "nodes": [ { "path": "a", "kind": "file", "size": 0 } ] } }),
            json!({ "ok": true }),
            json!({ "ok": true, "tree": { "nodes": [], "": 0 }, "spare": 1 }),
        ] {
            assert!(decode_tree(&invalid).is_none(), "{invalid}");
        }
        for invalid in [
            json!({ "ok": false, "file": { "path": "a", "content": "", "size": 0, "mtime": 0, "truncated": false } }),
            json!({ "ok": true, "file": { "path": "a", "content": "", "size": 0, "mtime": 0 } }),
            json!({ "ok": true, "file": { "path": "a", "content": "", "size": 0, "mtime": 0, "truncated": false, "extra": 1 } }),
            json!({ "ok": true, "file": { "path": "a", "content": "", "size": 1.5, "mtime": 0, "truncated": false } }),
        ] {
            assert!(decode_file(&invalid).is_none(), "{invalid}");
        }
    }

    #[test]
    fn an_empty_path_is_never_a_real_node_and_fails_the_decode() {
        // TS admits `z.string().min(1)`; an empty `path` is not a node the daemon
        // walked, so both shapes reject it rather than crossing an empty coordinate.
        assert!(
            decode_tree(&json!({
                "ok": true,
                "tree": { "nodes": [ { "path": "", "kind": "file", "size": 0, "mtime": 0 } ] }
            }))
            .is_none()
        );
        assert!(
            decode_file(&json!({
                "ok": true,
                "file": { "path": "", "content": "", "size": 0, "mtime": 0, "truncated": false }
            }))
            .is_none()
        );
    }

    #[test]
    fn byte_counts_keep_integer_bounds_while_mtime_uses_the_number_contract() {
        // A magnitude one past `JsSafeInteger::MAX` would round on the JS side, so
        // the codec refuses it — the adapter converges that to daemon_internal_error
        // rather than letting an unsafe stat cross into the domain. (Derived from the
        // boundary constant, never a copied `2^53-1` literal.)
        let over = JsSafeInteger::MAX + 1;
        assert!(
            decode_tree(&json!({
                "ok": true,
                "tree": { "nodes": [ { "path": "a", "kind": "file", "size": over, "mtime": 0 } ] }
            }))
            .is_none()
        );
        assert!(
            decode_tree(&json!({
                "ok": true,
                "tree": { "nodes": [ { "path": "a", "kind": "file", "size": 0, "mtime": over } ] }
            }))
            .is_some()
        );
        assert!(
            decode_file(&json!({
                "ok": true,
                "file": { "path": "a", "content": "", "size": over, "mtime": 0, "truncated": false }
            }))
            .is_none()
        );
        assert!(
            decode_file(&json!({
                "ok": true,
                "file": { "path": "a", "content": "", "size": 0, "mtime": over, "truncated": false }
            }))
            .is_some()
        );
    }

    #[test]
    fn the_javascript_safe_boundary_itself_is_admitted() {
        // The boundary value is exactly representable, so it decodes and round-trips.
        let max = JsSafeInteger::MAX;
        let node = decode_tree(&json!({
            "ok": true,
            "tree": { "nodes": [ { "path": "a", "kind": "file", "size": max, "mtime": max } ] }
        }))
        .unwrap();
        assert_eq!(node.nodes[0].size.get(), JsSafeInteger::MAX);
        assert_eq!(node.nodes[0].mtime.get(), JsSafeInteger::MAX as f64);
        let file = decode_file(&json!({
            "ok": true,
            "file": { "path": "a", "content": "", "size": max, "mtime": max, "truncated": false }
        }))
        .unwrap();
        assert_eq!(file.size.get(), JsSafeInteger::MAX);
        assert_eq!(file.mtime.get(), JsSafeInteger::MAX as f64);
    }
    #[test]
    fn mtime_refuses_wrong_types_and_non_finite_json_representations() {
        for invalid in [
            json!(null),
            json!("1700000000123.456"),
            json!(true),
            json!([]),
            json!({}),
            json!(f64::INFINITY),
            json!(f64::NAN),
        ] {
            assert!(
                decode_tree(&json!({"ok": true, "tree": {"nodes": [
                    {"path": "a", "kind": "file", "size": 1, "mtime": invalid}
                ]}}))
                .is_none()
            );
            assert!(
                decode_file(&json!({"ok": true, "file": {
                    "path": "a", "content": "x", "size": 1, "mtime": invalid, "truncated": false
                }}))
                .is_none()
            );
        }
    }
}
