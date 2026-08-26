use axum::{
    body::{Body, to_bytes},
    http::Request,
};
use serde::Deserialize;
use serde_json::Value;
use silverhand_backend_core::identity::UserId;
use silverhand_backend_server::messaging::collaboration::conversation_message_window;
use silverhand_backend_sqlite::messaging::MessagingStore;
use sqlx::{Connection, Executor, SqliteConnection, sqlite::SqliteConnectOptions};
use tower::ServiceExt;

#[derive(Debug, Deserialize)]
struct FixtureEntry {
    name: String,
    query: String,
    status: u16,
    body: Value,
}

async fn seed(path: &std::path::Path) {
    const SCHEMA: &str = include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../../packages/backend/tests/migration-baseline/schema-current.sql"
    ));
    let options = SqliteConnectOptions::new()
        .filename(path)
        .create_if_missing(true)
        .foreign_keys(true);
    let mut db = SqliteConnection::connect_with(&options).await.unwrap();
    db.execute(sqlx::raw_sql(SCHEMA)).await.unwrap();
    for statement in [
        "INSERT INTO users(id,name,display_name,created_at,updated_at) VALUES \
         ('local','local-test','Local Test User',1,1),('reply-a','reply-a','Reply A',1,1),\
         ('reply-b','reply-b','Reply B',1,1),('outsider','outsider','Outsider',1,1)",
        "INSERT INTO workspaces(id,name,name_key,created_at,updated_at) VALUES \
         ('window-w','Window Workspace','window-workspace',1,1)",
        "INSERT INTO workspace_users(workspace_id,user_id,joined_at,role) VALUES \
         ('window-w','local',1,'member')",
        "INSERT INTO conversations(id,workspace_id,placement_kind,roster_policy,title,title_key,\
         status,visibility,latest_message_seq,created_at,updated_at) VALUES \
         ('c','window-w','workspace','open','Window','window','idle','public',5,1,1)",
        "INSERT INTO conversation_users(conversation_id,user_id,joined_at) VALUES('c','local',1)",
        "INSERT INTO messages(id,conversation_id,from_kind,from_user_id,content,seq,created_at,\
         author_id,author_name,author_display_name) VALUES \
         ('root-1','c','user','local','root one',1,10,'local','local','Local User'),\
         ('root-2','c','user','local','root two',2,20,'local','local','Local User')",
        "INSERT INTO messages(id,conversation_id,from_kind,from_user_id,content,metadata,seq,\
         created_at,thread_root_id,author_id,author_name,author_display_name) VALUES \
         ('reply-1','c','user','reply-a',' first   reply ',NULL,3,30,'root-1','reply-a','reply-a','Reply A'),\
         ('reply-system','c','system',NULL,'system reply',NULL,4,40,'root-1',NULL,NULL,NULL),\
         ('reply-2','c','user','reply-b','second reply',\
          '{\"attachments\":[{\"id\":\"att-2\",\"filename\":\"note.txt\",\"size\":4,\"content_type\":\"text/plain\",\"label\":\"File #2\"}]}',\
          5,50,'root-1','reply-b','reply-b','Reply B')",
        "INSERT INTO conversation_stream_heads(conversation_id,thread_root_id,latest_seq) VALUES \
         ('c',NULL,2),('c','root-1',5)",
        "INSERT INTO message_reactions(id,message_id,reactor_kind,reactor_id,emoji,created_at) VALUES \
         ('reaction-1','root-2','user','local','👍',3),\
         ('reaction-2','root-2','user','outsider','👍',4)",
        "INSERT INTO tasks(id,workspace_id,task_number,conversation_id,title,status,creator_kind,\
         creator_user_id,source_message_id,created_at,board_key) VALUES \
         ('task-1','window-w',1,'c','Linked task','todo','user','local','root-2',1,'ws:window-w')",
    ] {
        db.execute(statement).await.unwrap();
    }
    db.close().await.unwrap();
}

#[tokio::test]
async fn production_sqlite_router_consumes_the_typescript_wire_fixture() {
    let fixture: Vec<FixtureEntry> = serde_json::from_str(include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../../packages/backend/tests/fixtures/conversation-message-window-wire.json"
    )))
    .unwrap();
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("conversation-message-window-router.sqlite");
    seed(&path).await;
    let store = MessagingStore::open(&path).await.unwrap();
    let app = conversation_message_window::router(store.conversation_message_window());

    for entry in fixture {
        if entry.name.starts_with("public_") {
            let mut db = SqliteConnection::connect(&format!("sqlite:{}", path.display()))
                .await
                .unwrap();
            db.execute(
                "DELETE FROM conversation_users WHERE conversation_id='c' AND user_id='local'",
            )
            .await
            .unwrap();
            db.close().await.unwrap();
        }
        let mut request = Request::builder()
            .uri(format!("/api/channels/c/messages{}", entry.query))
            .body(Body::empty())
            .unwrap();
        request
            .extensions_mut()
            .insert(UserId::parse("local").unwrap());
        let response = app.clone().oneshot(request).await.unwrap();
        assert_eq!(response.status().as_u16(), entry.status, "{}", entry.name);
        let body: Value =
            serde_json::from_slice(&to_bytes(response.into_body(), usize::MAX).await.unwrap())
                .unwrap();
        assert_eq!(body, entry.body, "{}", entry.name);
    }
}
