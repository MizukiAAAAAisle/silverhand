//! Wire projection for the owner-audit faces.
//!
//! Every shared value object is projected through the ONE authority the sibling
//! faces already use, so the audit wire cannot drift from them: the direct-pair
//! counterpart through [`counterpart_dto_value`], and each transcript message row
//! through the authenticated message-window projector [`message`].

use serde_json::{Value, json};
use silverhand_backend_core::identity_access::agent_audit_read::{
    AuditChatSummary, AuditChatsBundle, AuditTranscriptWindow,
};

use crate::conversation_messaging::direct_pairs::counterpart_dto_value;
use crate::messaging::collaboration::conversation_message_window::{
    MessageWindowWireError, message,
};

/// `{ "chats": [ ...discriminated summaries... ] }`. Empty list projects
/// `{ "chats": [] }`.
pub(super) fn chats_response(bundle: &AuditChatsBundle) -> Value {
    json!({
        "chats": bundle.chats().iter().map(chat_summary).collect::<Vec<_>>(),
    })
}

/// One conversation summary, discriminated on `placement_kind`. A workspace chat
/// draws by its title and workspace coordinates; a direct pair draws by its
/// counterpart and the survivor read-only state of the LINE itself.
fn chat_summary(summary: &AuditChatSummary) -> Value {
    match summary {
        AuditChatSummary::Workspace {
            conversation_id,
            roster_policy,
            title,
            workspace_id,
            workspace_name,
            archived_at,
            created_at,
        } => json!({
            "placement_kind": "workspace",
            "conversation_id": conversation_id.as_str(),
            "roster_policy": roster_policy.as_str(),
            "title": title,
            "workspace_id": workspace_id.as_str(),
            "workspace_name": workspace_name,
            "archived_at": archived_at,
            "created_at": created_at,
        }),
        AuditChatSummary::DirectPair {
            conversation_id,
            counterpart,
            read_only,
            archived_at,
            created_at,
        } => json!({
            "placement_kind": "direct_pair",
            "conversation_id": conversation_id.as_str(),
            "counterpart": counterpart_dto_value(counterpart),
            "read_only": read_only,
            "archived_at": archived_at,
            "created_at": created_at,
        }),
    }
}

/// `{ messages, reply_counts_by_root, has_more_before, has_more_after }`. `mode=all`
/// carries NO reply roots — the same empty map the authenticated
/// `listWindowForConversation` returns — no per-viewer reactions (every row seals
/// with EMPTY reactions, so `message` renders `reactions: null`), and no stream head.
pub(super) fn transcript_response(
    window: &AuditTranscriptWindow,
) -> Result<Value, MessageWindowWireError> {
    let messages = window
        .messages()
        .iter()
        .map(|selected| message(selected.projection()))
        .collect::<Result<Vec<_>, _>>()?;
    Ok(json!({
        "messages": messages,
        "reply_counts_by_root": json!({}),
        "has_more_before": window.has_more_before(),
        "has_more_after": window.has_more_after(),
    }))
}
