//! The agent wire DTO, projected once for every face that returns one.
//!
//! `agentRowToDto` is ONE function in the TypeScript authority, and the list and
//! detail routes call it identically — their responses differ only in the wrapper.
//! Lifting the projector here keeps that true by construction rather than by review:
//! a field added for detail cannot silently miss the list.
//!
//! It stays PRIVATE to `host_agent`. This is an internal projection shared between
//! sibling route modules, not a route surface, so it is declared `mod` and exposes
//! `pub(super)` items only: promoting an internal DTO helper to the crate's public
//! API would turn a later refactor into a compatibility obligation.

use serde::Serialize;
use silverhand_backend_core::agent_detail_read::AgentDetailFacts;

/// The wire projection of one agent row. Field-for-field the TypeScript `AgentDto`:
/// every optional column serializes as an explicit `null` (never skipped),
/// `idempotency_key` is deliberately absent, and the two derived fields — `host_label`
/// and `avatar_url` — are computed here. Both the detail and list faces build this
/// same DTO; they differ only in the wrapper that carries it.
#[derive(Serialize)]
pub(super) struct AgentDto {
    id: String,
    name: String,
    display_name: String,
    runtime: String,
    model: Option<String>,
    reasoning_effort: Option<String>,
    fast_mode: Option<bool>,
    host_id: String,
    host_label: Option<String>,
    description: Option<String>,
    session_scope: String,
    created_by_user_id: String,
    avatar_url: Option<String>,
    materialization_status: &'static str,
    materialization_failed_code: Option<String>,
    materialization_failed_at: Option<i64>,
    deletion_started_at: Option<i64>,
    created_at: i64,
    updated_at: i64,
}

pub(super) fn agent_dto(detail: &AgentDetailFacts) -> AgentDto {
    let projection = detail.projection();
    let id = detail.source().as_str().to_string();
    AgentDto {
        name: projection.name.clone(),
        display_name: projection.display_name.clone(),
        runtime: projection.runtime.clone(),
        model: projection.model.clone(),
        reasoning_effort: projection.reasoning_effort.clone(),
        fast_mode: projection.fast_mode,
        host_id: projection.host_id.clone(),
        host_label: host_label(
            projection.host_display_label.as_deref(),
            projection.host_name.as_deref(),
        ),
        description: projection.description.clone(),
        session_scope: projection.session_scope.clone(),
        created_by_user_id: detail.created_by_user_id().as_str().to_string(),
        avatar_url: avatar_url(
            &id,
            projection.avatar_storage_key.as_deref(),
            projection.updated_at,
        ),
        materialization_status: detail.visibility().materialization_status.as_str(),
        materialization_failed_code: projection.materialization_failed_code.clone(),
        materialization_failed_at: projection.materialization_failed_at,
        deletion_started_at: projection.deletion_started_at,
        created_at: projection.created_at,
        updated_at: projection.updated_at,
        id,
    }
}

/// `row.host_display_label?.trim() || row.host_name || null`: the trimmed label when
/// it is non-empty after trimming, else the host name when non-empty, else null.
fn host_label(display_label: Option<&str>, host_name: Option<&str>) -> Option<String> {
    if let Some(label) = display_label {
        let trimmed = label.trim();
        if !trimmed.is_empty() {
            return Some(trimmed.to_string());
        }
    }
    match host_name {
        Some(name) if !name.is_empty() => Some(name.to_string()),
        _ => None,
    }
}

/// `principalAvatarUrl`: a cache-busted URL when the row carries a non-empty avatar
/// storage key, else null. Truthiness, not `!= null`, so an empty key is no avatar.
fn avatar_url(id: &str, avatar_storage_key: Option<&str>, updated_at: i64) -> Option<String> {
    match avatar_storage_key {
        Some(key) if !key.is_empty() => Some(format!("/api/agents/{id}/avatar?v={updated_at}")),
        _ => None,
    }
}
