//! Product wire contract for agent workspace enrollment.
//!
//! These DTOs mirror the existing TypeScript product API on
//! `POST /api/workspaces/:id/members`: snake_case fields, `joined_at` as a JSON
//! number of epoch milliseconds, and flat refusal bodies `{ "error": ... }`
//! carrying an optional `code`. The foundation store's camelCase /
//! stringified-i64 / `{ wireContractVersion, error }` envelope is a proof-store
//! choice and holds no authority over this product surface.

use serde::{Deserialize, Serialize};
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

/// The add-member body, decoded structurally by serde. `agent_id`/`user_id` are
/// plain optional strings — a present non-string is a native decode fault (the
/// framework's `422`), never a classified body. `kind` is deliberately
/// [`Value`], not `Option<String>`: the product union consults it with
/// `and_then(as_str)`, so a present NON-string `kind` is not a decode fault — it
/// is simply "no tag", exactly as Zod's unknown-key-stripping union treats it.
/// Unknown keys are ignored (serde's default strip), matching the schema.
///
/// The top-level-object floor is NOT this DTO's job: a derived struct visitor
/// also fills fields positionally from a JSON *array*, so decoding it bare would
/// let `[null, "an-agent-id"]` classify as an agent enrollment. That shape floor
/// is sealed ONCE for the whole crate by [`wire_admission::ObjectOnly<T>`], which
/// every consumer of this DTO decodes through (the route uses
/// `Json<ObjectOnly<AddMemberRaw>>`); this stays an ordinary derive with no
/// leaf-local grammar of its own.
#[derive(Debug, Deserialize)]
pub struct AddMemberRaw {
    #[serde(default)]
    kind: Option<Value>,
    #[serde(default)]
    agent_id: Option<String>,
    #[serde(default)]
    user_id: Option<String>,
}

/// A classified add-member request. The product body is one of three forms — a
/// bare `{ agent_id }`, a tagged `{ kind: "agent", agent_id }`, or a human
/// `{ kind: "human", user_id }` — and anything else is invalid input.
#[derive(Debug, PartialEq, Eq)]
pub enum AddMemberRequest {
    Agent { agent_id: String },
    Human { user_id: String },
}

impl TryFrom<AddMemberRaw> for AddMemberRequest {
    /// Semantic-classification failure: a structurally valid body no product arm
    /// accepts. The caller maps it to the minimal `422 invalid input`.
    type Error = ();

    /// Classify the decoded body, reproducing the product `z.union` of three
    /// object shapes tried in its declared order, first match winning:
    ///
    /// 1. tagged agent — `{ kind: "agent", agent_id: string }`
    /// 2. human — `{ kind: "human", user_id: string }`
    /// 3. bare agent — `{ agent_id: string }`
    ///
    /// `kind` is consulted per-arm, never a discriminator: Zod objects strip
    /// unknown keys, so the bare-agent arm accepts any object carrying a string
    /// `agent_id` **whatever `kind` is** — an unknown tag (`"bogus"`), a
    /// non-string (`123`), or absent. `kind: "human"` selects the human arm only
    /// when a `user_id` is also present — otherwise the body falls through to
    /// bare agent.
    fn try_from(raw: AddMemberRaw) -> Result<Self, Self::Error> {
        let AddMemberRaw {
            kind,
            agent_id,
            user_id,
        } = raw;
        let kind = kind.as_ref().and_then(Value::as_str);

        // 1. tagged agent: `{ kind: "agent", agent_id: string }`.
        if kind == Some("agent")
            && let Some(agent_id) = agent_id.clone()
        {
            return Ok(Self::Agent { agent_id });
        }
        // 2. human: `{ kind: "human", user_id: string }`.
        if kind == Some("human")
            && let Some(user_id) = user_id
        {
            return Ok(Self::Human { user_id });
        }
        // 3. bare agent: `{ agent_id: string }` — `kind` is ignored entirely.
        if let Some(agent_id) = agent_id {
            return Ok(Self::Agent { agent_id });
        }
        Err(())
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
    use super::{AddMemberRaw, AddMemberRequest};

    /// Decode the body structurally through the shared object floor, exactly as
    /// the route boundary does (`Json<ObjectOnly<AddMemberRaw>>`). `Err` here is a
    /// native decode fault (bad JSON, wrong SHAPE — a top-level array/scalar/null
    /// — or a wrong-typed known field) — a `400`/`422` the framework owns, never a
    /// classified body. Routing through [`from_object_slice`] rather than a bare
    /// `from_str` is what keeps a positionally-decodable JSON *array* out: the
    /// derived struct visitor would fill fields from a sequence, and only the
    /// shared `ObjectOnly<T>` map floor rejects that.
    ///
    /// [`from_object_slice`]: crate::wire_admission::from_object_slice
    fn decode(body: &str) -> Result<AddMemberRaw, serde_json::Error> {
        crate::wire_admission::from_object_slice::<AddMemberRaw>(body.as_bytes())
    }

    /// Classify a structurally valid body into a product arm, or `Err(())` for a
    /// body no arm accepts (the minimal semantic `422`). Panics if the body does
    /// not even decode — those are asserted with [`decode`] directly.
    fn classify(body: &str) -> Result<AddMemberRequest, ()> {
        let raw = decode(body).expect("body decodes structurally");
        AddMemberRequest::try_from(raw)
    }

    fn agent(agent_id: &str) -> Result<AddMemberRequest, ()> {
        Ok(AddMemberRequest::Agent {
            agent_id: agent_id.to_owned(),
        })
    }

    fn human(user_id: &str) -> Result<AddMemberRequest, ()> {
        Ok(AddMemberRequest::Human {
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
        // bare-agent arm ignores it entirely — `kind` is `Value`, so a non-string
        // decodes fine and is simply "no tag".
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
    fn structurally_valid_bodies_no_arm_accepts_are_semantic_invalid_input() {
        // These all DECODE (the typed fields are absent or correctly typed) but
        // match no product arm: the classifier returns the semantic `Err(())`.
        assert_eq!(classify("{}"), Err(())); // empty object
        assert_eq!(classify(r#"{"kind":"agent"}"#), Err(())); // tagged agent, no agent_id
        assert_eq!(classify(r#"{"user_id":"u1"}"#), Err(())); // human data without a kind
    }

    #[test]
    fn structurally_invalid_bodies_are_native_decode_faults() {
        // A wrong-typed known field, the wrong top-level SHAPE, and malformed
        // JSON never reach the classifier — the native `Json` extractor owns
        // them (`422`/`422`/`400`). This is the boundary the typed DTO moves off
        // the hand-rolled `serde_json::Value` classifier.
        assert!(decode(r#"{"agent_id":123}"#).is_err()); // agent_id not a string
        assert!(decode(r#"["agent_id"]"#).is_err()); // top-level array, wrong shape
        assert!(decode("not json{").is_err()); // malformed JSON
    }

    #[test]
    fn a_value_shaped_array_matching_the_field_order_is_still_a_native_decode_fault() {
        // The sharp hazard the shared object floor exists to defeat: a derived
        // struct visitor fills fields POSITIONALLY from a JSON sequence, so a
        // top-level array whose element types AND values line up with the field
        // order (`kind`, `agent_id`, `user_id`) would otherwise decode into a
        // fully-populated `AddMemberRaw` and classify as an agent enrollment. The
        // schema is `z.object`, which admits only an object; `["agent","a1",null]`
        // is a native decode fault before any arm is consulted — zero classifier
        // reach, zero authority reach.
        assert!(decode(r#"["agent","a1",null]"#).is_err());
        // A shorter value-shaped array (bare-agent shape by position) is equally
        // refused — the floor rejects the sequence SHAPE, not a particular arity.
        assert!(decode(r#"[null,"a1"]"#).is_err());
    }
}
