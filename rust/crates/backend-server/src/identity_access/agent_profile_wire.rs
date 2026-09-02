//! The internal agent-profile wire projection.
//!
//! One projector, shared by the self read, self write, and peer read. The product
//! keeps a SINGLE profile shape across all three (`toAgentProfileDto`,
//! `profile-routes.ts`): forking a
//! narrower "peer" DTO would make one domain fact two contracts, and nothing in
//! it is privileged — `id` buys no authority (every self route is token-pinned)
//! and `avatar_url` is a derived, read-only route. So this lives here, private to
//! the `identity_access` sibling set, and never becomes public API.

use serde::Serialize;
use silverhand_backend_core::identity_access::agent_profile_read::AgentProfileFact;

/// `{ id, name, display_name, description, avatar_url }` — the exact
/// `AgentProfileDto` the CLI consumes. `description` and `avatar_url` serialize as
/// explicit JSON `null` when absent (never skipped), mirroring the TS `string |
/// null` fields.
#[derive(Serialize)]
pub(super) struct AgentProfileDto {
    pub id: String,
    pub name: String,
    pub display_name: String,
    pub description: Option<String>,
    pub avatar_url: Option<String>,
}

/// Project a committed [`AgentProfileFact`] into the wire DTO. The `avatar_url` is
/// the canonical cache-busted route (`/api/agents/{id}/avatar?v={revision}`) when
/// the fact carries an avatar revision, else `null` — the same derivation the
/// detail projector applies, but folded upstream: the fact already collapsed a
/// non-empty storage key + `updated_at` into `Option<AvatarRevision>`, so the
/// storage locator never reaches this boundary.
pub(super) fn agent_profile_dto(fact: &AgentProfileFact) -> AgentProfileDto {
    let id = fact.id.as_str().to_string();
    let avatar_url = fact
        .avatar
        .map(|revision| format!("/api/agents/{id}/avatar?v={}", revision.cache_buster()));
    AgentProfileDto {
        id,
        name: fact.name.clone(),
        display_name: fact.display_name.clone(),
        description: fact.description.clone(),
        avatar_url,
    }
}
