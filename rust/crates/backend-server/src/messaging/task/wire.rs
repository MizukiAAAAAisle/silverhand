//! The board-list summary projector: a viewer-bound [`TaskSummarySource`] → the flat
//! `TaskSummaryDto` the CLI/list face reads. The single wire authority for a card's
//! shape, the parity of the TS `taskJoinedToSummary`.
//!
//! It reads BOTH halves of the one joined row together — the committed
//! [`TaskAggregate`](silverhand_backend_core::conversation_messaging::messaging::task::TaskAggregate) for every
//! identity/coordinate/status axis, and the [`TaskDisplaySidecars`] the same select read
//! for the joined display names — so a name never re-splits into an id map to rejoin. A
//! missing actor join degrades the name to the id (a deleted/unlinked actor), exactly as
//! the TS projection's `?? id` does; the aggregate's typed arms mean an id is never empty.
//!
//! ONE row shape the projector refuses rather than invents a place for: a workspace board
//! whose `channel_name` is absent. The sidecar contract makes `channel_name` `Some` for
//! every workspace board (`None` only on a direct-pair board, which projects the pair arm),
//! so a workspace board with no title is a corrupt row — a safe-500 the handler routes,
//! never a fabricated place on the wire (the parity of the TS `placeFrom` `throw`).

use serde::Serialize;
use silverhand_backend_core::conversation_messaging::messaging::task::{
    Assignee, BoardKey, Creator, TaskDisplaySidecars, TaskSummarySource,
};

/// The list envelope: `{ "tasks": [...] }`, the shape the route answers a `200` with.
#[derive(Debug, Serialize)]
pub(crate) struct TaskListDto {
    pub tasks: Vec<TaskSummaryDto>,
}

/// One task card. Field-for-field the TS `TaskSummaryDto`: the folded `place` union, the
/// nullable assignee, the always-present creator (a `system` arm when the actor is gone),
/// and the nullable timestamps.
#[derive(Debug, Serialize)]
pub(crate) struct TaskSummaryDto {
    pub id: String,
    pub task_number: i64,
    pub place: PlaceDto,
    pub thread_root_id: Option<String>,
    pub status: &'static str,
    pub title: String,
    pub assignee: Option<ActorDto>,
    pub creator: ActorDto,
    pub created_at: i64,
    pub closed_at: Option<i64>,
}

/// The task's place — the routing `conversation_id` folded together with the
/// placement-specific display coordinates, narrowed on `kind`.
#[derive(Debug, Serialize)]
#[serde(tag = "kind")]
pub(crate) enum PlaceDto {
    /// A workspace channel board: the board namespace plus the channel's display title.
    #[serde(rename = "workspace")]
    Workspace {
        conversation_id: String,
        workspace_id: String,
        channel_name: String,
    },
    /// A direct-pair board: only the immutable `pair_key` (no display title exists).
    #[serde(rename = "direct_pair")]
    DirectPair {
        conversation_id: String,
        pair_key: String,
    },
}

/// The assignee/creator shape: `{ type, id, name }`. `id` is `null` only for the creator's
/// `system` arm (a since-deleted actor); an assignee always carries a non-empty id, so the
/// whole assignee is nulled — never its id — when a task is unassigned.
#[derive(Debug, Serialize)]
pub(crate) struct ActorDto {
    #[serde(rename = "type")]
    pub kind: &'static str,
    pub id: Option<String>,
    pub name: String,
}

/// A committed row that reached projection in a shape a correct writer never stores. It is
/// corruption, not a caller error — the handler routes it to a safe-500 with the offending
/// field for the operator, and it never reaches the wire.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) struct ProjectionCorruption {
    field: &'static str,
}

impl ProjectionCorruption {
    /// The offending column, for the operator log only.
    pub fn field(self) -> &'static str {
        self.field
    }
}

/// Project a viewer-bound board-list row into its wire summary, or a named corruption for a
/// row a correct writer never stores.
pub(crate) fn project_summary(
    source: TaskSummarySource<'_>,
) -> Result<TaskSummaryDto, ProjectionCorruption> {
    let task = source.task;
    let display = source.display;

    Ok(TaskSummaryDto {
        id: task.id().as_str().to_owned(),
        task_number: task.task_number().get(),
        place: place_of(task.board(), task.conversation_id().as_str(), display)?,
        thread_root_id: task.thread_root_id().map(|root| root.as_str().to_owned()),
        status: task.status().as_str(),
        title: task.title().as_str().to_owned(),
        assignee: assignee_of(task.assignee(), display),
        creator: creator_of(task.creator(), display),
        created_at: task.created_at(),
        closed_at: task.closed_at(),
    })
}

/// The board's own coordinate decides the arm; the workspace arm additionally REQUIRES the
/// joined title (a workspace board with none is the one corrupt shape).
fn place_of(
    board: &BoardKey,
    conversation_id: &str,
    display: &TaskDisplaySidecars,
) -> Result<PlaceDto, ProjectionCorruption> {
    match board {
        BoardKey::Workspace(workspace) => {
            let channel_name = display.channel_name.clone().ok_or(ProjectionCorruption {
                field: "channel_name",
            })?;
            Ok(PlaceDto::Workspace {
                conversation_id: conversation_id.to_owned(),
                workspace_id: workspace.as_str().to_owned(),
                channel_name,
            })
        }
        BoardKey::Pair(pair) => Ok(PlaceDto::DirectPair {
            conversation_id: conversation_id.to_owned(),
            pair_key: pair.as_str().to_owned(),
        }),
    }
}

/// The assignee card: `None` when unassigned; otherwise the arm's id with the joined name
/// degraded to the id when the actor join did not match.
fn assignee_of(assignee: &Assignee, display: &TaskDisplaySidecars) -> Option<ActorDto> {
    match assignee {
        Assignee::Unassigned => None,
        Assignee::Agent(agent) => Some(ActorDto {
            kind: "agent",
            id: Some(agent.as_str().to_owned()),
            name: name_or_id(display.assignee_agent_name.as_deref(), agent.as_str()),
        }),
        Assignee::User(user) => Some(ActorDto {
            kind: "user",
            id: Some(user.as_str().to_owned()),
            name: name_or_id(display.assignee_user_name.as_deref(), user.as_str()),
        }),
    }
}

/// The creator card: the agent/user arm with the same name-degrades-to-id rule, or the
/// `system` arm (`id: null`, `name: "system"`) for a since-deleted actor.
fn creator_of(creator: &Creator, display: &TaskDisplaySidecars) -> ActorDto {
    match creator {
        Creator::Agent(agent) => ActorDto {
            kind: "agent",
            id: Some(agent.as_str().to_owned()),
            name: name_or_id(display.creator_agent_name.as_deref(), agent.as_str()),
        },
        Creator::User(user) => ActorDto {
            kind: "user",
            id: Some(user.as_str().to_owned()),
            name: name_or_id(display.creator_user_name.as_deref(), user.as_str()),
        },
        Creator::System => ActorDto {
            kind: "system",
            id: None,
            name: "system".to_owned(),
        },
    }
}

/// The joined display name if the actor join matched, else the id — the parity of the TS
/// `name ?? id`.
fn name_or_id(name: Option<&str>, id: &str) -> String {
    name.unwrap_or(id).to_owned()
}

#[cfg(test)]
mod tests {
    use super::*;
    use silverhand_backend_core::conversation_messaging::messaging::task::{
        TaskAggregate, TaskRow,
    };

    /// A minimal decodable workspace-board row; each test mutates one facet. A workspace
    /// board REQUIRES `board_key = "ws:" || workspace_id` (a row-local decode coupling).
    fn workspace_row() -> TaskRow {
        TaskRow {
            id: "task_1".into(),
            task_number: 1,
            conversation_id: "conv_1".into(),
            thread_root_id: None,
            board_key: "ws:workspace_1".into(),
            workspace_id: Some("workspace_1".into()),
            title: "a title".into(),
            content: String::new(),
            status: "todo".into(),
            assignee_agent_id: None,
            assignee_user_id: None,
            creator_kind: "system".into(),
            creator_agent_id: None,
            creator_user_id: None,
            source_message_id: None,
            created_event_message_id: None,
            last_editor_kind: None,
            last_editor_id: None,
            last_edited_at: None,
            created_at: 100,
            closed_at: None,
        }
    }

    fn decode(row: TaskRow) -> TaskAggregate {
        TaskAggregate::decode(row).expect("row decodes")
    }

    fn no_sidecars() -> TaskDisplaySidecars {
        TaskDisplaySidecars {
            channel_name: None,
            assignee_agent_name: None,
            assignee_user_name: None,
            creator_agent_name: None,
            creator_user_name: None,
        }
    }

    /// The closed-set JSON gate: the whole wire shape for a workspace-placed, agent-assigned,
    /// user-created card. Asserted as a value, so a missing or renamed field fails here.
    #[test]
    fn a_workspace_card_projects_every_field() {
        let task = decode(TaskRow {
            assignee_agent_id: Some("agent_9".into()),
            creator_kind: "user".into(),
            creator_user_id: Some("user_3".into()),
            ..workspace_row()
        });
        let display = TaskDisplaySidecars {
            channel_name: Some("general".into()),
            assignee_agent_name: Some("Agent Nine".into()),
            creator_user_name: Some("User Three".into()),
            ..no_sidecars()
        };

        let dto = project_summary(TaskSummarySource {
            task: &task,
            display: &display,
        })
        .expect("projects");

        assert_eq!(
            serde_json::to_value(&dto).unwrap(),
            serde_json::json!({
                "id": "task_1",
                "task_number": 1,
                "place": {
                    "kind": "workspace",
                    "conversation_id": "conv_1",
                    "workspace_id": "workspace_1",
                    "channel_name": "general",
                },
                "thread_root_id": null,
                "status": "todo",
                "title": "a title",
                "assignee": { "type": "agent", "id": "agent_9", "name": "Agent Nine" },
                "creator": { "type": "user", "id": "user_3", "name": "User Three" },
                "created_at": 100,
                "closed_at": null,
            })
        );
    }

    /// A direct-pair card: the pair arm carries only `pair_key`, an unassigned task nulls the
    /// whole assignee, a missing creator-name join degrades the name to the id, and a closed
    /// task carries its `thread_root_id` and `closed_at`.
    #[test]
    fn a_direct_pair_card_projects_the_pair_arm_and_degrades_a_missing_name() {
        let task = decode(TaskRow {
            board_key: "pair:agent_1:user_1".into(),
            workspace_id: None,
            thread_root_id: Some("root_5".into()),
            status: "closed".into(),
            closed_at: Some(200),
            creator_kind: "agent".into(),
            creator_agent_id: Some("agent_2".into()),
            ..workspace_row()
        });
        // No channel name (a pair board has none) and no creator name (a dropped join).
        let display = no_sidecars();

        let dto = project_summary(TaskSummarySource {
            task: &task,
            display: &display,
        })
        .expect("projects");

        assert_eq!(
            serde_json::to_value(&dto).unwrap(),
            serde_json::json!({
                "id": "task_1",
                "task_number": 1,
                "place": {
                    "kind": "direct_pair",
                    "conversation_id": "conv_1",
                    "pair_key": "agent_1:user_1",
                },
                "thread_root_id": "root_5",
                "status": "closed",
                "title": "a title",
                "assignee": null,
                "creator": { "type": "agent", "id": "agent_2", "name": "agent_2" },
                "created_at": 100,
                "closed_at": 200,
            })
        );
    }

    /// A system creator is the `{ type: "system", id: null, name: "system" }` arm — the only
    /// creator with a null id.
    #[test]
    fn a_system_creator_projects_a_null_id() {
        let task = decode(workspace_row());
        let display = TaskDisplaySidecars {
            channel_name: Some("general".into()),
            ..no_sidecars()
        };

        let dto = project_summary(TaskSummarySource {
            task: &task,
            display: &display,
        })
        .expect("projects");

        assert_eq!(
            serde_json::to_value(&dto).unwrap()["creator"],
            serde_json::json!({ "type": "system", "id": null, "name": "system" })
        );
        assert_eq!(
            serde_json::to_value(&dto).unwrap()["assignee"],
            serde_json::Value::Null
        );
    }

    /// A workspace board with no joined channel title is a corrupt committed row: the
    /// projector refuses it (a safe-500 the handler routes) rather than inventing a place.
    #[test]
    fn a_workspace_board_without_a_channel_name_is_corrupt() {
        let task = decode(workspace_row());
        let display = no_sidecars();

        let corruption = project_summary(TaskSummarySource {
            task: &task,
            display: &display,
        })
        .expect_err("a titleless workspace board is corrupt");
        assert_eq!(corruption.field(), "channel_name");
    }
}
