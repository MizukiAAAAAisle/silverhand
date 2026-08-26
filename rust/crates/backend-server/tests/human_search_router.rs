use axum::{
    body::{Body, to_bytes},
    http::Request,
};
use serde::Deserialize;
use serde_json::Value;
use silverhand_backend_core::identity::UserId;
use silverhand_backend_server::messaging::collaboration::human_search;
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
        "INSERT INTO hosts(id,name,kind,created_at) VALUES('h','host','local',1)",
        "INSERT INTO users(id,name,display_name,created_at,updated_at) VALUES \
         ('local','local','Local',1,1),('gone','gone','Gone',1,1)",
        "INSERT INTO agents(id,name,runtime,host_id,created_by_user_id,created_at,updated_at,display_name) \
         VALUES('pair-agent','pair-agent','codex','h','local',1,1,'Pair Agent')",
        "INSERT INTO workspaces(id,name,name_key,description,created_at,updated_at) \
         VALUES('w','cap-needle workspace','cap-needle-workspace','cap discovery',1,2)",
        "INSERT OR IGNORE INTO workspace_users(workspace_id,user_id,joined_at,role) \
         VALUES('w','local',1,'member')",
        "INSERT INTO conversations( \
         id,workspace_id,placement_kind,roster_policy,title,title_key,status,visibility,created_at,updated_at \
         ) VALUES('c','w','workspace','open','Cap-Needle Channel','cap-needle-channel','idle','private',1,2)",
        "INSERT INTO conversations( \
         id,placement_kind,roster_policy,endpoint_a_kind,endpoint_a_id,endpoint_b_kind,endpoint_b_id, \
         title,status,visibility,created_at,updated_at \
         ) VALUES('pair','direct_pair','fixed','agent','pair-agent','human','local','','idle','private',1,1)",
        "INSERT OR IGNORE INTO conversation_users(conversation_id,user_id,joined_at) \
         VALUES('c','local',1)",
        "INSERT INTO messages(id,conversation_id,from_kind,content,seq,created_at) VALUES \
         ('cap-1','c','system','cap-needle one',1,10), \
         ('cap-2','c','system','cap-needle two',2,11), \
         ('cap-3','c','system','cap-needle three',3,12), \
         ('thread-root','c','system','thread root',4,20), \
         ('pair-message','pair','system','dm-needle',1,30)",
        "INSERT INTO messages(id,conversation_id,from_kind,content,seq,created_at,thread_root_id) \
         VALUES('thread-reply','c','system','thread-needle',5,21,'thread-root')",
        "INSERT INTO messages( \
         id,conversation_id,from_kind,from_user_id,content,seq,created_at,author_id,author_name,author_display_name \
         ) VALUES('deleted-message','c','user','gone','deleted-needle',6,22,'gone','gone','Gone')",
        "DELETE FROM users WHERE id='gone'",
    ] {
        db.execute(statement).await.unwrap();
    }
    db.close().await.unwrap();
}

#[tokio::test]
async fn production_sqlite_router_consumes_the_typescript_wire_fixture() {
    let fixture: Vec<FixtureEntry> = serde_json::from_str(include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../../packages/backend/tests/fixtures/human-search-wire.json"
    )))
    .unwrap();
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("human-search-router.sqlite");
    seed(&path).await;
    let store = MessagingStore::open(&path).await.unwrap();
    let app = human_search::router(store.human_search());

    for entry in fixture {
        let mut request = Request::builder()
            .uri(format!("/api/search{}", entry.query))
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
