//! Real SQLite proof for the three task point/detail faces. Each call enters the
//! connection-bound `TaskAuthorizedPointRead` and returns only an authorized
//! projection; revoking a viewer before a new call cannot leave task content from
//! an earlier candidate read visible.

use silverhand_backend_core::conversation_messaging::messaging::task::{
    AgentRead, TaskAuthorizedPointRead, TaskId, TaskNumber, TaskReadActor, TaskReadAddress,
    TaskReadRequest, authorize_global_by_id,
};
use silverhand_backend_core::foundation::identity::{
    AgentId, ConversationId, DaemonInstanceId, UserId,
};
use silverhand_backend_core::host_runtime::runtime_credential::{
    RuntimeCustody, RuntimeGeneration, RuntimePrincipal, RuntimeScope,
};
use silverhand_backend_sqlite::conversation_messaging::messaging::task::SqliteTaskStore;
use sqlx::{Connection, SqliteConnection};

#[path = "support/current_schema_snapshot.rs"]
mod current_schema;

fn user() -> UserId {
    UserId::parse("user-1").unwrap()
}

fn agent() -> AgentId {
    AgentId::parse("agent-1").unwrap()
}

fn task() -> TaskId {
    TaskId::parse("task-1").unwrap()
}

fn by_id(actor: TaskReadActor) -> TaskReadRequest {
    TaskReadRequest {
        address: TaskReadAddress::ById(task()),
        actor,
    }
}

fn agent_global_by_id() -> TaskReadActor {
    let address = TaskReadAddress::ById(task());
    let principal = RuntimePrincipal::for_scope(
        RuntimeScope::AgentSlot { agent: agent() },
        RuntimeCustody::new(
            RuntimeGeneration::new(1).unwrap(),
            DaemonInstanceId::parse("daemon-1").unwrap(),
        ),
    );
    TaskReadActor::Agent(AgentRead::GlobalById(
        authorize_global_by_id(&principal, &address).unwrap(),
    ))
}

#[tokio::test]
async fn all_three_point_faces_bind_candidate_permission_and_projection_to_one_read_authority() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("tasks.sqlite");
    let mut db = current_schema::create_current_schema(&path).await;
    for statement in [
        "INSERT INTO users (id,name,display_name,created_at,updated_at) VALUES ('user-1','user','User',1,1)",
        "INSERT INTO hosts (id,name,kind,created_at,user_id) VALUES ('host-1','host','remote',1,'user-1')",
        "INSERT INTO agents (id,name,display_name,runtime,host_id,created_by_user_id,session_scope,created_at,updated_at) VALUES ('agent-1','agent','Agent','codex','host-1','user-1','conversation',1,1)",
        "INSERT INTO workspaces (id,name,name_key,created_at,updated_at) VALUES ('ws-1','Space','space',1,1)",
        "INSERT INTO workspace_users (workspace_id,user_id,role,joined_at) VALUES ('ws-1','user-1','member',1)",
        "INSERT INTO workspace_members (workspace_id,agent_id,joined_at) VALUES ('ws-1','agent-1',1)",
        "INSERT INTO workspace_agent_capabilities (workspace_id,agent_id,capability) VALUES ('ws-1','agent-1','read_tasks')",
        "INSERT INTO conversations (id,workspace_id,placement_kind,roster_policy,title,title_key,status,created_at,updated_at) VALUES ('conv-1','ws-1','workspace','open','General','general','active',1,1)",
        "INSERT INTO conversation_users (conversation_id,user_id,joined_at) VALUES ('conv-1','user-1',1)",
        "INSERT INTO conversation_agents (conversation_id,agent_id,joined_at) VALUES ('conv-1','agent-1',1)",
        "INSERT INTO tasks (id,workspace_id,task_number,conversation_id,title,content,status,creator_kind,creator_user_id,created_at,board_key) VALUES ('task-1','ws-1',1,'conv-1','Private task','secret','todo','user','user-1',1,'ws:ws-1')",
    ] {
        sqlx::query(statement).execute(&mut db).await.unwrap();
    }
    db.close().await.unwrap();

    let store = SqliteTaskStore::open(&path).await.unwrap();
    assert!(
        store
            .read_authorized_point(by_id(TaskReadActor::User(user())))
            .await
            .unwrap()
            .is_some(),
        "public by-id succeeds through the snapshot authority"
    );
    assert!(
        store
            .read_authorized_point_by_conversation_number(
                user(),
                ConversationId::parse("conv-1").unwrap(),
                TaskNumber::new(1).unwrap(),
            )
            .await
            .unwrap()
            .is_some(),
        "public by-number resolves its board inside the same snapshot"
    );
    assert!(
        store
            .read_authorized_point(by_id(agent_global_by_id()))
            .await
            .unwrap()
            .is_some(),
        "internal detail succeeds through the same snapshot authority"
    );

    let mut writer = SqliteConnection::connect(&format!("sqlite://{}", path.display()))
        .await
        .unwrap();
    sqlx::query("DELETE FROM workspace_users WHERE workspace_id='ws-1' AND user_id='user-1'")
        .execute(&mut writer)
        .await
        .unwrap();
    sqlx::query("DELETE FROM workspace_agent_capabilities WHERE workspace_id='ws-1' AND agent_id='agent-1' AND capability='read_tasks'")
        .execute(&mut writer)
        .await
        .unwrap();
    writer.close().await.unwrap();

    assert!(
        store
            .read_authorized_point(by_id(TaskReadActor::User(user())))
            .await
            .unwrap()
            .is_none()
    );
    assert!(
        store
            .read_authorized_point_by_conversation_number(
                user(),
                ConversationId::parse("conv-1").unwrap(),
                TaskNumber::new(1).unwrap(),
            )
            .await
            .unwrap()
            .is_none()
    );
    assert!(
        store
            .read_authorized_point(by_id(agent_global_by_id()))
            .await
            .unwrap()
            .is_none()
    );
}
