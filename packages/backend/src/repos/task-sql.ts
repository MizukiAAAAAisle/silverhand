// Task-domain SHARED SQL constants (persistence zone). Kept out of the
// concrete repo files so the task repo and the board read-model can share ONE
// projection SELECT without a repo→repo concrete import edge (#task:1980).
// This module imports no driver and performs no statements — it only carries
// the SQL text.
//
// The row carries only the placement columns the DTO mapper consumes. In
// particular a DirectPair's sentinel storage title never enters this read
// projection: channel_name is workspace-arm-only by construction.
//
// There is NO `workspaces` join any more: the container word (#task:2075's
// stop-publish step) was the last column this projection took from that row —
// `workspace_id` is the task's own column. If a future face needs a workspace
// column back, P0-f (#task:2022) still applies to the join it adds: it must be a
// LEFT JOIN, because a DirectPair task has no workspace and an INNER JOIN would
// silently drop the whole row (the §1 "INNER JOIN row vanishes" family); and a
// face that wants only workspace-board rows must SAY so with a predicate, never
// lean on the join shape.

export const SELECT_TASK_JOINED = `
  SELECT
    t.id                       AS id,
    t.conversation_id          AS conversation_id,
    t.task_number              AS task_number,
    t.status                   AS status,
    t.title                    AS title,
    t.closed_at                AS closed_at,
    t.workspace_id             AS workspace_id,
    conv.pair_key              AS conversation_pair_key,
    CASE WHEN conv.placement_kind = 'workspace'
         THEN conv.title
         ELSE NULL
     END                       AS channel_name,
    t.thread_root_id           AS thread_root_id,
    t.assignee_agent_id        AS assignee_agent_id,
    t.assignee_user_id         AS assignee_user_id,
    t.creator_kind             AS creator_kind,
    t.creator_agent_id         AS creator_agent_id,
    t.creator_user_id          AS creator_user_id,
    t.created_at               AS created_at,
    aa.display_name            AS assignee_agent_name,
    au.display_name            AS assignee_user_name,
    ca.display_name            AS creator_agent_name,
    cu.display_name            AS creator_user_name
  FROM tasks t
  JOIN conversations conv ON conv.id = t.conversation_id
  LEFT JOIN agents aa ON aa.id = t.assignee_agent_id
  LEFT JOIN users au ON au.id = t.assignee_user_id
  LEFT JOIN agents ca ON ca.id = t.creator_agent_id
  LEFT JOIN users cu ON cu.id = t.creator_user_id
`;
