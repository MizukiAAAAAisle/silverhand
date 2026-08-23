//! Product wire contract for agent workspace enrollment.
//!
//! These DTOs mirror the existing TypeScript product API on
//! `POST /api/workspaces/:id/members`: snake_case fields, `joined_at` as a JSON
//! number of epoch milliseconds, and flat refusal bodies `{ "error": ... }`
//! carrying an optional `code`. The foundation store's camelCase /
//! stringified-i64 / `{ wireContractVersion, error }` envelope is a proof-store
//! choice and holds no authority over this product surface.

use serde::Serialize;
use serde_json::Value;
use silverhand_backend_core::access::{
    AgentWorkspaceMembership, HumanUser, WorkspaceUserMembership,
};

/// The product route: `POST /api/workspaces/{id}/members`.
pub const WORKSPACE_MEMBERS_PATH: &str = "/api/workspaces/{id}/members";

/// Exact refusal strings, pinned to the TypeScript handler so a fixture drift
/// shows up here rather than in a hand-copied assertion.
pub const WORKSPACE_NOT_FOUND: &str = "workspace not found";
pub const FORBIDDEN: &str = "forbidden";
pub const INVALID_INPUT: &str = "invalid input";
pub const AGENT_NOT_FOUND: &str = "agent not found";
pub const USER_NOT_FOUND: &str = "user not found";
pub const AGENT_NOT_OWNED_MESSAGE: &str =
    "you can only add agents you created — someone else's can be brought in only by its creator";
pub const AGENT_NOT_OWNED_CODE: &str = "agent_not_owned";

/// The unmapped-error body. The product route registers no `onError`, so an
/// unexpected failure falls to the framework default: a `500` with a bare
/// `text/plain` body of exactly `Internal Server Error` — **not** a JSON
/// `{ "error": ... }` envelope. This slice reproduces that byte-for-byte rather
/// than inventing a structured 500 the product surface never emits.
pub const INTERNAL_ERROR_BODY: &str = "Internal Server Error";

/// A classified add-member request. The product body is one of three forms — a
/// bare `{ agent_id }`, a tagged `{ kind: "agent", agent_id }`, or a human
/// `{ kind: "human", user_id }` — and anything else is invalid input.
#[derive(Debug, PartialEq, Eq)]
pub enum AddMemberRequest {
    Agent { agent_id: String },
    Human { user_id: String },
}

impl AddMemberRequest {
    /// Classify the request body, or `None` for a body no product variant
    /// accepts (which the surface maps to `400 invalid input`).
    ///
    /// The product schema is a plain `z.union` of three object shapes, tried in
    /// its declared order with the first match winning:
    ///
    /// 1. tagged agent — `{ kind: "agent", agent_id: string }`
    /// 2. human — `{ kind: "human", user_id: string }`
    /// 3. bare agent — `{ agent_id: string }`
    ///
    /// Each arm is an independent predicate over the raw JSON object, evaluated
    /// in that order. `kind` is deliberately NOT pre-parsed into one typed field:
    /// Zod objects strip unknown keys, so the bare-agent arm accepts any object
    /// carrying a string `agent_id` **whatever `kind` is** — an unknown tag
    /// (`"bogus"`), a non-string (`123`), or absent. Reproducing the union as a
    /// discriminator on `kind` would wrongly reject those as `400`; they are
    /// agents. `kind: "human"` only selects the human arm when a `user_id` is
    /// also present — otherwise the object still falls through to bare agent.
    pub fn from_body(body: &[u8]) -> Option<Self> {
        let raw: Value = serde_json::from_slice(body).ok()?;
        let object = raw.as_object()?;
        let kind = object.get("kind").and_then(Value::as_str);
        let agent_id = object.get("agent_id").and_then(Value::as_str);
        let user_id = object.get("user_id").and_then(Value::as_str);

        // 1. tagged agent: `{ kind: "agent", agent_id: string }`.
        if kind == Some("agent")
            && let Some(agent_id) = agent_id
        {
            return Some(Self::Agent {
                agent_id: agent_id.to_owned(),
            });
        }
        // 2. human: `{ kind: "human", user_id: string }`.
        if kind == Some("human")
            && let Some(user_id) = user_id
        {
            return Some(Self::Human {
                user_id: user_id.to_owned(),
            });
        }
        // 3. bare agent: `{ agent_id: string }` — `kind` is ignored entirely.
        if let Some(agent_id) = agent_id {
            return Some(Self::Agent {
                agent_id: agent_id.to_owned(),
            });
        }
        None
    }
}

/// One agent membership edge: snake_case, with a numeric millisecond
/// `joined_at`.
#[derive(Debug, Serialize, PartialEq, Eq)]
pub struct WorkspaceMemberDto {
    pub workspace_id: String,
    pub agent_id: String,
    pub joined_at: i64,
}

impl From<AgentWorkspaceMembership> for WorkspaceMemberDto {
    fn from(membership: AgentWorkspaceMembership) -> Self {
        Self {
            workspace_id: membership.workspace_id.as_str().to_owned(),
            agent_id: membership.agent_id.as_str().to_owned(),
            joined_at: membership.joined_at_ms,
        }
    }
}

/// Success body: `{ "member": { ... } }`, returned with `201 Created`.
#[derive(Debug, Serialize)]
pub struct AddWorkspaceAgentMemberResponse {
    pub member: WorkspaceMemberDto,
}

/// One human membership edge: the roster row with its governance `role`. Mirrors
/// the product `WorkspaceUserMemberDto`.
#[derive(Debug, Serialize, PartialEq, Eq)]
pub struct WorkspaceUserMemberDto {
    pub workspace_id: String,
    pub user_id: String,
    pub joined_at: i64,
    pub role: String,
}

impl From<WorkspaceUserMembership> for WorkspaceUserMemberDto {
    fn from(membership: WorkspaceUserMembership) -> Self {
        Self {
            workspace_id: membership.workspace_id.as_str().to_owned(),
            user_id: membership.user_id.as_str().to_owned(),
            joined_at: membership.joined_at_ms,
            role: membership.role.as_str().to_owned(),
        }
    }
}

/// The list-item projection: the enrolled person's display fields merged with
/// their membership edge, mirroring the product `human_member` (a `UserDto`
/// spread under the membership fields, `{ ...user, ...member }`).
#[derive(Debug, Serialize)]
pub struct WorkspaceHumanMemberDto {
    pub id: String,
    pub name: String,
    pub display_name: String,
    pub avatar_url: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
    pub workspace_id: String,
    pub user_id: String,
    pub joined_at: i64,
    pub role: String,
}

/// Human success body: `{ "member": { ... }, "human_member": { ... } }`,
/// returned with `201 Created`.
#[derive(Debug, Serialize)]
pub struct AddWorkspaceHumanMemberResponse {
    pub member: WorkspaceUserMemberDto,
    pub human_member: WorkspaceHumanMemberDto,
}

impl AddWorkspaceHumanMemberResponse {
    /// Merge the resolved user with the enrolled membership, exactly as the
    /// product route's `{ member, human_member: { ...user, ...member } }` does:
    /// `human_member` takes its `user_id`, `joined_at` and `role` from the
    /// membership edge (the member fields overwrite the spread user), and its
    /// identity fields from the user.
    pub fn build(user: &HumanUser, membership: WorkspaceUserMembership) -> Self {
        let member = WorkspaceUserMemberDto::from(membership);
        let human_member = WorkspaceHumanMemberDto {
            id: user.id.as_str().to_owned(),
            name: user.name.clone(),
            display_name: user.display_name.clone(),
            avatar_url: user.avatar_url.clone(),
            created_at: user.created_at,
            updated_at: user.updated_at,
            workspace_id: member.workspace_id.clone(),
            user_id: member.user_id.clone(),
            joined_at: member.joined_at,
            role: member.role.clone(),
        };
        Self {
            member,
            human_member,
        }
    }
}

/// A flat refusal body. `code` is serialized only where the product API sets one
/// (currently only `agent_not_owned`); it is omitted otherwise.
#[derive(Debug, Serialize)]
pub struct ErrorBody {
    pub error: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub code: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::AddMemberRequest;

    fn classify(body: &str) -> Option<AddMemberRequest> {
        AddMemberRequest::from_body(body.as_bytes())
    }

    fn agent(agent_id: &str) -> Option<AddMemberRequest> {
        Some(AddMemberRequest::Agent {
            agent_id: agent_id.to_owned(),
        })
    }

    fn human(user_id: &str) -> Option<AddMemberRequest> {
        Some(AddMemberRequest::Human {
            user_id: user_id.to_owned(),
        })
    }

    // The product schema is `z.union([tagged-agent, human, bare-agent])`, tried
    // in that order with the first match winning and Zod objects stripping
    // unknown keys. These rows pin the accept-set against a `kind`-discriminator
    // reading, which would wrongly reject an agent body carrying an extra `kind`.

    #[test]
    fn tagged_agent_and_bare_agent_both_classify_as_agent() {
        assert_eq!(classify(r#"{"kind":"agent","agent_id":"a1"}"#), agent("a1"));
        assert_eq!(classify(r#"{"agent_id":"a1"}"#), agent("a1"));
    }

    #[test]
    fn tagged_human_classifies_as_human() {
        assert_eq!(classify(r#"{"kind":"human","user_id":"u1"}"#), human("u1"));
    }

    #[test]
    fn an_agent_body_with_a_non_agent_kind_falls_through_to_bare_agent() {
        // `kind: "human"` but no `user_id`: the human arm fails, then bare-agent
        // strips the `kind` and accepts the `agent_id`.
        assert_eq!(classify(r#"{"kind":"human","agent_id":"a1"}"#), agent("a1"));
        // An unknown tag is likewise ignored by the bare-agent arm.
        assert_eq!(classify(r#"{"kind":"bogus","agent_id":"a1"}"#), agent("a1"));
        // A `kind` that is not even a string cannot select a tagged arm, but the
        // bare-agent arm ignores it entirely.
        assert_eq!(classify(r#"{"kind":123,"agent_id":"a1"}"#), agent("a1"));
    }

    #[test]
    fn a_valid_human_body_stays_human_even_with_an_extra_agent_id() {
        // The human arm is tried before bare-agent, so a well-formed human body
        // is a human even when it also carries an `agent_id`.
        assert_eq!(
            classify(r#"{"kind":"human","user_id":"u1","agent_id":"a1"}"#),
            human("u1")
        );
    }

    #[test]
    fn bodies_no_arm_accepts_are_invalid_input() {
        assert_eq!(classify("{}"), None); // empty object
        assert_eq!(classify(r#"{"kind":"agent"}"#), None); // tagged agent, no agent_id
        assert_eq!(classify(r#"{"agent_id":123}"#), None); // agent_id not a string
        assert_eq!(classify(r#"{"user_id":"u1"}"#), None); // human data without a kind
        assert_eq!(classify(r#"["agent_id"]"#), None); // not an object
        assert_eq!(classify("not json{"), None); // malformed JSON
    }
}
