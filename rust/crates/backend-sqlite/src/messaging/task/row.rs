//! Committed-row decode and the cross-row board seal that every task read shares.
//!
//! "What a trustworthy `tasks` row is" has exactly one definition, so the point
//! read and the board read models route through the same two layered corruption
//! gates before any product logic or DTO sees a fact:
//!
//!  - [`decode_row`] runs the ROW-LOCAL gate ([`TaskAggregate::decode`]): the
//!    value-object contracts and the intra-row couplings the `tasks` CHECKs
//!    enforce. It is row-local by construction — it carries a single row.
//!  - [`seal_board_against_conversation`] runs the CROSS-ROW gate the core module
//!    (`messaging::task::aggregate`) delegates to the adapter by name: the board
//!    coordinate must agree with the task's OWN conversation placement. This
//!    adapter re-derives the board from the authoritative placement (the same
//!    `CASE placement_kind` the v76 derivation trigger enforces on INSERT) and
//!    asserts it equals the decoded aggregate's board. A row whose frozen board
//!    coordinates have drifted from its conversation's placement is corruption — a
//!    safe-500, never a task served on the wrong board. The insert trigger
//!    guarantees agreement at birth and the task's coordinates are frozen, so this
//!    gate never fires on a legitimately-written row; it exists to refuse a drifted
//!    or hand-mutated one, exactly the class TS leaves to the database and this
//!    decoder asserts.
//!
//! Both gates turn a broken row into a safe-500 carrying the offending column.

use silverhand_backend_core::foundation::persistence::PersistenceFailure;
use silverhand_backend_core::messaging::task::{
    BoardKey, TaskAggregate, TaskDisplaySidecars, TaskRow, TaskRowCorruption,
};
use sqlx::{Row, sqlite::SqliteRow};

use super::{corrupt, driver};

/// The row projection every task read decodes: the task's own 21 columns PLUS the
/// board its conversation's placement authoritatively yields. The `LEFT JOIN` and the
/// `CASE` mirror the v76 derivation trigger's authority (`'ws:' || workspace_id` for a
/// workspace conversation, `'pair:' || pair_key` for a direct pair); a missing or
/// unknown-placement conversation leaves `conversation_board_key` NULL, which
/// [`seal_board_against_conversation`] treats as corruption. `conversation_id` is `NOT
/// NULL REFERENCES conversations`, so the join matches for any row a correct writer
/// produced — the LEFT arm only exists so a broken row fails the seal rather than
/// silently vanishing from an inner join.
///
/// Owning the projection HERE — beside the two decode gates it feeds — is what lets the
/// point read and every board read model share one definition of "the columns a
/// trustworthy row is decoded from": a per-leaf copy could drift a column out from under
/// [`decode_row`]/[`seal_board_against_conversation`]. Each leaf appends only its own
/// `WHERE`/`ORDER`/`LIMIT`.
pub(super) const SELECT_TASK_ROW: &str = "SELECT \
     t.id, t.task_number, t.conversation_id, t.thread_root_id, t.board_key, t.workspace_id, \
     t.title, t.content, t.status, t.assignee_agent_id, t.assignee_user_id, \
     t.creator_kind, t.creator_agent_id, t.creator_user_id, \
     t.source_message_id, t.created_event_message_id, \
     t.last_editor_kind, t.last_editor_id, t.last_edited_at, \
     t.created_at, t.closed_at, \
     CASE c.placement_kind \
       WHEN 'workspace'   THEN 'ws:'   || c.workspace_id \
       WHEN 'direct_pair' THEN 'pair:' || c.pair_key \
     END AS conversation_board_key, \
     c.workspace_id AS conversation_workspace_id \
     FROM tasks t \
     LEFT JOIN conversations c ON c.id = t.conversation_id";

/// The board-LIST projection: everything [`SELECT_TASK_ROW`] decodes (so the list path
/// runs the SAME row-local decode and cross-row board seal) PLUS the display sidecars a
/// task CARD needs — the conversation's channel name and the joined display names of the
/// assignee/creator. The five sidecar columns are the ONLY difference from
/// [`SELECT_TASK_ROW`]; the shared task/seal columns are repeated verbatim so
/// [`decode_row`] and [`seal_board_against_conversation`] read the same names either way.
///
/// `channel_name` is workspace-arm-only by construction — the `CASE` projects the
/// conversation's title ONLY for a workspace placement, so a DirectPair's sentinel storage
/// title never enters this read model (parity with the TS `SELECT_TASK_JOINED`). The four
/// actor-name joins are LEFT JOINs keyed on the task's ACTUAL foreign keys, so a joined
/// name is by construction the name of the exact FK'd actor or NULL — the DTO's
/// name-degrades-to-id fallback (see [`TaskDisplaySidecars`]) fires ONLY when the join is
/// genuinely missing (a deleted/unlinked actor), never attaching a name to the wrong one.
pub(super) const SELECT_TASK_JOINED: &str = "SELECT \
     t.id, t.task_number, t.conversation_id, t.thread_root_id, t.board_key, t.workspace_id, \
     t.title, t.content, t.status, t.assignee_agent_id, t.assignee_user_id, \
     t.creator_kind, t.creator_agent_id, t.creator_user_id, \
     t.source_message_id, t.created_event_message_id, \
     t.last_editor_kind, t.last_editor_id, t.last_edited_at, \
     t.created_at, t.closed_at, \
     CASE c.placement_kind \
       WHEN 'workspace'   THEN 'ws:'   || c.workspace_id \
       WHEN 'direct_pair' THEN 'pair:' || c.pair_key \
     END AS conversation_board_key, \
     c.workspace_id AS conversation_workspace_id, \
     CASE c.placement_kind WHEN 'workspace' THEN c.title END AS channel_name, \
     aa.display_name AS assignee_agent_name, \
     au.display_name AS assignee_user_name, \
     ca.display_name AS creator_agent_name, \
     cu.display_name AS creator_user_name \
     FROM tasks t \
     LEFT JOIN conversations c ON c.id = t.conversation_id \
     LEFT JOIN agents aa ON aa.id = t.assignee_agent_id \
     LEFT JOIN users  au ON au.id = t.assignee_user_id \
     LEFT JOIN agents ca ON ca.id = t.creator_agent_id \
     LEFT JOIN users  cu ON cu.id = t.creator_user_id";

/// The column a [`TaskRowCorruption`] arm names, so a row-local decode failure
/// carries an operator reason through the erased [`PersistenceFailure`].
fn row_local_field(reason: TaskRowCorruption) -> &'static str {
    use TaskRowCorruption as E;
    match reason {
        E::Id => "tasks.id",
        E::TaskNumber => "tasks.task_number",
        E::ConversationId => "tasks.conversation_id",
        E::Status => "tasks.status",
        E::Title => "tasks.title",
        E::TitleNotCanonical => "tasks.title:non_canonical",
        E::Content => "tasks.content",
        E::Board => "tasks.board_key:row_local",
        E::ThreadRootId => "tasks.thread_root_id",
        E::SourceMessageId => "tasks.source_message_id",
        E::CreatedEventMessageId => "tasks.created_event_message_id",
        E::Creator => "tasks.creator",
        E::Assignee => "tasks.assignee",
        E::LastEditor => "tasks.last_editor",
        E::ClosedAt => "tasks.closed_at",
    }
}

/// The `board_key` string a decoded board reproduces: `'ws:' || workspace_id` for
/// a workspace board, `'pair:' || pair_key` for a direct pair. The row-local decode
/// already proved this equals the task's stored `board_key`; here it is compared
/// against the conversation-derived authority.
pub(super) fn board_key_string(board: &BoardKey) -> String {
    match board {
        BoardKey::Workspace(workspace) => format!("ws:{}", workspace.as_str()),
        BoardKey::Pair(pair) => format!("pair:{}", pair.as_str()),
    }
}

/// Fills a [`TaskRow`] from the raw columns and runs the row-local decode, routing
/// a driver read error and a decode corruption to their distinct safe-500 sources.
/// The row must carry the task's own 21 columns under their table names.
pub(super) fn decode_row(row: &SqliteRow) -> Result<TaskAggregate, PersistenceFailure> {
    let raw = TaskRow {
        id: row.try_get("id").map_err(driver)?,
        task_number: row.try_get("task_number").map_err(driver)?,
        conversation_id: row.try_get("conversation_id").map_err(driver)?,
        thread_root_id: row.try_get("thread_root_id").map_err(driver)?,
        board_key: row.try_get("board_key").map_err(driver)?,
        workspace_id: row.try_get("workspace_id").map_err(driver)?,
        title: row.try_get("title").map_err(driver)?,
        content: row.try_get("content").map_err(driver)?,
        status: row.try_get("status").map_err(driver)?,
        assignee_agent_id: row.try_get("assignee_agent_id").map_err(driver)?,
        assignee_user_id: row.try_get("assignee_user_id").map_err(driver)?,
        creator_kind: row.try_get("creator_kind").map_err(driver)?,
        creator_agent_id: row.try_get("creator_agent_id").map_err(driver)?,
        creator_user_id: row.try_get("creator_user_id").map_err(driver)?,
        source_message_id: row.try_get("source_message_id").map_err(driver)?,
        created_event_message_id: row.try_get("created_event_message_id").map_err(driver)?,
        last_editor_kind: row.try_get("last_editor_kind").map_err(driver)?,
        last_editor_id: row.try_get("last_editor_id").map_err(driver)?,
        last_edited_at: row.try_get("last_edited_at").map_err(driver)?,
        created_at: row.try_get("created_at").map_err(driver)?,
        closed_at: row.try_get("closed_at").map_err(driver)?,
    };
    TaskAggregate::decode(raw).map_err(|reason| corrupt(row_local_field(reason)))
}

/// The cross-row board gate the core decode delegates here: the decoded board must
/// equal the board the task's conversation placement authoritatively yields, in
/// BOTH the key and the `workspace_id` it implies. A NULL authority (missing row or
/// a placement the `CASE` does not recognize) or any disagreement is corruption.
/// The row must carry `conversation_board_key` and `conversation_workspace_id` — the
/// board its conversation's placement yields — alongside the task's own columns.
pub(super) fn seal_board_against_conversation(
    row: &SqliteRow,
    aggregate: &TaskAggregate,
) -> Result<(), PersistenceFailure> {
    let conversation_board_key: Option<String> =
        row.try_get("conversation_board_key").map_err(driver)?;
    let conversation_workspace_id: Option<String> =
        row.try_get("conversation_workspace_id").map_err(driver)?;

    let Some(authoritative_board_key) = conversation_board_key else {
        return Err(corrupt("tasks.board_key:conversation_placement"));
    };

    let board_agrees = board_key_string(aggregate.board()) == authoritative_board_key;
    let workspace_agrees = aggregate
        .board()
        .workspace_id()
        .map(|workspace| workspace.as_str())
        == conversation_workspace_id.as_deref();

    if board_agrees && workspace_agrees {
        Ok(())
    } else {
        Err(corrupt("tasks.board_key:conversation_placement"))
    }
}

/// Decodes the display sidecars a [`SELECT_TASK_JOINED`] row carries alongside the task's
/// own columns: the conversation's channel name (workspace-arm-only; NULL for a DirectPair)
/// and the joined display names of the assignee/creator (NULL when the FK'd actor is
/// deleted/unlinked). These are pure display strings — no invariant rides them, so a NULL
/// is an honest absence the DTO resolves with its id fallback, never corruption. The row
/// must carry the five sidecar columns [`SELECT_TASK_JOINED`] projects.
pub(super) fn decode_sidecars(row: &SqliteRow) -> Result<TaskDisplaySidecars, PersistenceFailure> {
    Ok(TaskDisplaySidecars {
        channel_name: row.try_get("channel_name").map_err(driver)?,
        assignee_agent_name: row.try_get("assignee_agent_name").map_err(driver)?,
        assignee_user_name: row.try_get("assignee_user_name").map_err(driver)?,
        creator_agent_name: row.try_get("creator_agent_name").map_err(driver)?,
        creator_user_name: row.try_get("creator_user_name").map_err(driver)?,
    })
}
