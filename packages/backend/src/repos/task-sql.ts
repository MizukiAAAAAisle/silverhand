// Task-domain SHARED SQL constants (persistence zone). Kept out of the
// concrete repo files so the task repo and the board read-model can share ONE
// projection SELECT without a repo→repo concrete import edge (#task:1980).
// This module imports no driver and performs no statements — it only carries
// the SQL text.
export const SELECT_TASK_JOINED = `
  SELECT
    t.id                       AS id,
    t.conversation_id          AS conversation_id,
    t.task_number              AS task_number,
    t.status                   AS status,
    t.title                    AS title,
    t.closed_at                AS closed_at,
    t.workspace_id             AS workspace_id,
    conv.title                 AS channel_name,
    t.thread_root_id           AS thread_root_id,
    t.assignee_agent_id        AS assignee_agent_id,
    t.assignee_user_id         AS assignee_user_id,
    t.creator_kind             AS creator_kind,
    t.creator_agent_id         AS creator_agent_id,
    t.creator_user_id          AS creator_user_id,
    t.created_at               AS created_at,
    conv.title                 AS conversation_title,
    w.name                     AS workspace_name,
    aa.display_name            AS assignee_agent_name,
    au.display_name            AS assignee_user_name,
    ca.display_name            AS creator_agent_name,
    cu.display_name            AS creator_user_name
  FROM tasks t
  JOIN conversations conv ON conv.id = t.conversation_id
  JOIN workspaces w ON w.id = t.workspace_id
  LEFT JOIN agents aa ON aa.id = t.assignee_agent_id
  LEFT JOIN users au ON au.id = t.assignee_user_id
  LEFT JOIN agents ca ON ca.id = t.creator_agent_id
  LEFT JOIN users cu ON cu.id = t.creator_user_id
`;
