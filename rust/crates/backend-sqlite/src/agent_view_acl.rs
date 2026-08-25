//! The SQL authority for the agent-visibility ACL's two set-shaped arms.
//!
//! `GET /api/agents/{id}/availability` and `GET /api/agents/{id}` decide the SAME
//! "who may see this agent" question, so the arm SQL lives here ONCE. A second
//! consumer that copied the text instead of sharing it would let the two drift, and
//! a drift in an ACL is a security bug, not a style nit. These are the ports of the
//! TypeScript `DIRECT_PAIR_HUMAN_ENDPOINT_IDS_FOR_AGENT_SQL` and the
//! `workspaces.listForAgent` ⇒ `workspaceMemberUserIds` pair. The creator arm is a
//! single column on the agent row, so it needs no query and is not here.
//!
//! The rows each query returns are decoded into `UserId`s by the calling adapter,
//! whose own strict-decode falsifier proves that decode refuses a corrupt id — the
//! text below is only the membership definition, not the decode.

/// Port of `DIRECT_PAIR_HUMAN_ENDPOINT_IDS_FOR_AGENT_SQL`: the human endpoint of
/// every human↔agent direct pair this agent is in, both slot orders, with the
/// OTHER endpoint gated on `'human'` so an agent↔agent pair contributes nobody.
/// Binds the agent id once per arm.
pub(crate) const SELECT_DIRECT_PAIR_HUMAN_ENDPOINTS: &str = "SELECT endpoint_b_id AS user_id \
       FROM conversations \
      WHERE placement_kind = 'direct_pair' \
        AND endpoint_a_kind = 'agent' AND endpoint_a_id = ? \
        AND endpoint_b_kind = 'human' \
      UNION \
     SELECT endpoint_a_id AS user_id \
       FROM conversations \
      WHERE placement_kind = 'direct_pair' \
        AND endpoint_b_kind = 'agent' AND endpoint_b_id = ? \
        AND endpoint_a_kind = 'human'";

/// The workspace arm: the members of every workspace the agent reaches — the
/// regular workspaces it is a `workspace_members` row of, plus its own agent-home
/// workspace (`owner_agent_id = agent`). The exact set `agentWorkspaceIds` hands
/// `workspaceMemberUserIds`. Binds the agent id once per arm of the inner union.
pub(crate) const SELECT_SHARED_WORKSPACE_MEMBERS: &str = "SELECT DISTINCT wu.user_id \
       FROM workspace_users wu \
      WHERE wu.workspace_id IN ( \
        SELECT w.id FROM workspaces w \
          JOIN workspace_members wm ON wm.workspace_id = w.id \
         WHERE wm.agent_id = ? AND w.owner_agent_id IS NULL \
        UNION \
        SELECT w.id FROM workspaces w WHERE w.owner_agent_id = ? \
      )";
