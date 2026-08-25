use axum::{
    body::{Body, to_bytes},
    http::Request,
};
use serde_json::Value;
use silverhand_backend_core::{
    identity::{ConversationId, UserId, WorkspaceId},
    messaging::collaboration::message_unread::{
        ConversationMessageUnread, ConversationMessageUnreadReadPort,
        ConversationMessageUnreadRefusal, LatestUnreadPointer, NonZeroUnreadCount, UnreadCount,
        UnreadRollup, ViewerMessageUnreadSummary, ViewerMessageUnreadSummaryReadPort,
        WorkspaceConversationUnread, WorkspaceMessageUnread, WorkspaceMessageUnreadReadPort,
        WorkspaceMessageUnreadRefusal, WorkspaceUnreadTotal,
    },
    messaging::{MessageId, MessageSeq},
};
use silverhand_backend_server::messaging::collaboration::message_unread::router;
use silverhand_backend_sqlite::messaging::MessagingStore;
use sqlx::{Connection, Executor, SqliteConnection, sqlite::SqliteConnectOptions};
use tower::ServiceExt;

const SCHEMA: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../../packages/backend/tests/migration-baseline/schema-current.sql"
));

async fn store(setup: &str) -> (tempfile::TempDir, MessagingStore) {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("message-unread.sqlite");
    let options = SqliteConnectOptions::new()
        .filename(&path)
        .create_if_missing(true)
        .foreign_keys(true);
    let mut db = SqliteConnection::connect_with(&options).await.unwrap();
    db.execute(sqlx::raw_sql(SCHEMA)).await.unwrap();
    sqlx::query("INSERT INTO users(id,name,display_name,created_at,updated_at) VALUES('local','local-message-unread','Local',1,1),('other','other-message-unread','Other',1,1)")
        .execute(&mut db).await.unwrap();
    if matches!(
        setup,
        "summary_empty" | "missing_workspace" | "missing_conversation"
    ) {
        drop(db);
        return (dir, MessagingStore::open(path).await.unwrap());
    }
    if setup == "direct_pair_endpoint" {
        sqlx::query("INSERT INTO conversations(id,workspace_id,placement_kind,roster_policy,endpoint_a_kind,endpoint_a_id,endpoint_b_kind,endpoint_b_id,title,title_key,status,visibility,created_at,updated_at) VALUES('c',NULL,'direct_pair','fixed','human','local','human','other','',NULL,'idle','private',1,1)")
            .execute(&mut db).await.unwrap();
        seed_messages(&mut db, "c").await;
        drop(db);
        return (dir, MessagingStore::open(path).await.unwrap());
    }

    sqlx::query("INSERT INTO workspaces(id,name,name_key,created_at,updated_at) VALUES('w','Workspace','message-unread',1,1)")
        .execute(&mut db).await.unwrap();
    let archived = (setup == "archived_workspace_member").then_some(9_i64);
    let visibility = if setup == "public_workspace_nonmember" {
        "public"
    } else {
        "private"
    };
    sqlx::query("INSERT INTO conversations(id,workspace_id,placement_kind,roster_policy,title,title_key,status,visibility,archived_at,created_at,updated_at) VALUES('c','w','workspace','open','General','general-message-unread','idle',?,?,1,1)")
        .bind(visibility).bind(archived).execute(&mut db).await.unwrap();
    if setup != "workspace_forbidden" {
        sqlx::query(
            "INSERT INTO workspace_users(workspace_id,user_id,joined_at) VALUES('w','local',1)",
        )
        .execute(&mut db)
        .await
        .unwrap();
    }
    if setup != "workspace_forbidden" && setup != "public_workspace_nonmember" {
        sqlx::query("INSERT INTO conversation_users(conversation_id,user_id,joined_at) VALUES('c','local',1)")
            .execute(&mut db).await.unwrap();
        seed_messages(&mut db, "c").await;
    }
    if setup == "workspace_member" {
        sqlx::query("INSERT INTO conversations(id,workspace_id,placement_kind,roster_policy,title,title_key,status,visibility,created_at,updated_at) VALUES('c2','w','workspace','open','Second','second-message-unread','idle','private',2,2)")
            .execute(&mut db).await.unwrap();
        sqlx::query("INSERT INTO conversation_users(conversation_id,user_id,joined_at) VALUES('c2','local',2)")
            .execute(&mut db).await.unwrap();
        sqlx::query("INSERT INTO messages(id,conversation_id,from_kind,from_user_id,content,seq,created_at) VALUES('c2-message','c2','user','other','other conversation',1,9)")
            .execute(&mut db).await.unwrap();
        sqlx::query("INSERT INTO conversation_stream_heads(conversation_id,thread_root_id,latest_seq) VALUES('c2',NULL,1)")
            .execute(&mut db).await.unwrap();
    }
    drop(db);
    (dir, MessagingStore::open(path).await.unwrap())
}

async fn seed_messages(db: &mut SqliteConnection, conversation: &str) {
    sqlx::query("INSERT INTO messages(id,conversation_id,from_kind,from_user_id,content,seq,created_at,thread_root_id) VALUES('main-1',?,'user','other','main first',1,1,NULL),('own-main',?,'user','local','own',2,2,NULL),('system-main',?,'system',NULL,'system',3,3,NULL),('root',?,'user','other','root',4,4,NULL),('reply-1',?,'user','other','reply one',5,5,'root'),('own-reply',?,'user','local','own reply',6,6,'root'),('reply-2',?,'user','other','reply two',7,7,'root')")
        .bind(conversation).bind(conversation).bind(conversation).bind(conversation)
        .bind(conversation).bind(conversation).bind(conversation)
        .execute(&mut *db).await.unwrap();
    sqlx::query("INSERT INTO conversation_stream_heads(conversation_id,thread_root_id,latest_seq) VALUES(?,NULL,4),(?,'root',7)")
        .bind(conversation).bind(conversation).execute(&mut *db).await.unwrap();
    sqlx::query("INSERT INTO conversation_reads(user_id,conversation_id,thread_root_id,last_read_seq,read_at) VALUES('local',?,NULL,1,8),('local',?,'root',5,8)")
        .bind(conversation).bind(conversation).execute(&mut *db).await.unwrap();
    sqlx::query("INSERT INTO thread_followers(thread_root_id,conversation_id,principal_kind,principal_id,followed_at,source) VALUES('root',?,'human','local',8,'manual')")
        .bind(conversation).execute(&mut *db).await.unwrap();
}

#[tokio::test]
async fn production_router_matches_the_typescript_signed_closed_set() {
    let fixture: Value = serde_json::from_str(include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../../packages/backend/tests/fixtures/message-unread-wire.json"
    )))
    .unwrap();
    let entries = fixture.as_array().unwrap();
    for entry in entries {
        let setup = entry["setup"].as_str().unwrap();
        let (_dir, store) = store(setup).await;
        let mut request = Request::builder()
            .uri(entry["path"].as_str().unwrap())
            .body(Body::empty())
            .unwrap();
        request
            .extensions_mut()
            .insert(UserId::parse("local").unwrap());
        let response = router(store.message_unread())
            .oneshot(request)
            .await
            .unwrap();
        assert_eq!(
            response.status().as_u16(),
            entry["status"].as_u64().unwrap() as u16,
            "{}",
            entry["name"]
        );
        let body: Value =
            serde_json::from_slice(&to_bytes(response.into_body(), usize::MAX).await.unwrap())
                .unwrap();
        assert_eq!(body, entry["body"], "{}", entry["name"]);
    }
    assert_eq!(entries.len(), 10);
}

#[tokio::test]
async fn all_three_surfaces_require_the_human_principal_before_product_work() {
    let (_dir, store) = store("workspace_member").await;
    for path in [
        "/api/workspaces/w/message-unread",
        "/api/message-unread-summary",
        "/api/channels/c/message-unread",
    ] {
        let response = router(store.message_unread())
            .oneshot(Request::builder().uri(path).body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(
            response.status(),
            axum::http::StatusCode::INTERNAL_SERVER_ERROR
        );
    }
}

#[derive(Clone)]
struct SplicedRead {
    summary_viewer: &'static str,
    summary_row_viewer: Option<&'static str>,
}

impl WorkspaceMessageUnreadReadPort for SplicedRead {
    type Error = std::io::Error;

    async fn read_workspace(
        &self,
        _: &UserId,
        _: &WorkspaceId,
    ) -> Result<Result<WorkspaceMessageUnread, WorkspaceMessageUnreadRefusal>, Self::Error> {
        let workspace = WorkspaceId::parse("b").unwrap();
        let conversation = ConversationId::parse("b-conversation").unwrap();
        let unread = UnreadRollup::projected(
            UnreadCount::new(1).unwrap(),
            Some(LatestUnreadPointer::projected(
                conversation.clone(),
                MessageId::parse("m").unwrap(),
                MessageSeq::try_from(1).unwrap(),
                None,
            )),
        )
        .unwrap();
        let UnreadRollup::Unread(unread) = unread else {
            unreachable!()
        };
        Ok(Ok(WorkspaceMessageUnread::projected(
            workspace.clone(),
            vec![WorkspaceConversationUnread::projected(workspace, conversation, unread).unwrap()],
        )
        .unwrap()))
    }
}

impl ViewerMessageUnreadSummaryReadPort for SplicedRead {
    type Error = std::io::Error;

    async fn read_summary(&self, _: &UserId) -> Result<ViewerMessageUnreadSummary, Self::Error> {
        let rows = self
            .summary_row_viewer
            .map(|viewer| {
                WorkspaceUnreadTotal::projected(
                    UserId::parse(viewer).unwrap(),
                    WorkspaceId::parse("w").unwrap(),
                    NonZeroUnreadCount::new(UnreadCount::new(1).unwrap()).unwrap(),
                )
            })
            .into_iter()
            .collect();
        ViewerMessageUnreadSummary::projected(UserId::parse(self.summary_viewer).unwrap(), rows)
            .map_err(std::io::Error::other)
    }
}

impl ConversationMessageUnreadReadPort for SplicedRead {
    type Error = std::io::Error;

    async fn read_conversation(
        &self,
        _: &UserId,
        _: &ConversationId,
    ) -> Result<Result<ConversationMessageUnread, ConversationMessageUnreadRefusal>, Self::Error>
    {
        Ok(Ok(ConversationMessageUnread::projected(
            ConversationId::parse("b").unwrap(),
            UnreadRollup::CaughtUp,
        )
        .unwrap()))
    }
}

#[tokio::test]
async fn request_coordinates_bind_before_either_success_envelope() {
    for path in [
        "/api/workspaces/a/message-unread",
        "/api/channels/a/message-unread",
    ] {
        let mut request = Request::builder().uri(path).body(Body::empty()).unwrap();
        request
            .extensions_mut()
            .insert(UserId::parse("local").unwrap());
        let response = router(SplicedRead {
            summary_viewer: "local",
            summary_row_viewer: None,
        })
        .oneshot(request)
        .await
        .unwrap();
        assert_eq!(
            response.status(),
            axum::http::StatusCode::INTERNAL_SERVER_ERROR
        );
        let body: Value =
            serde_json::from_slice(&to_bytes(response.into_body(), usize::MAX).await.unwrap())
                .unwrap();
        assert_eq!(body, serde_json::json!({"error":"internal error"}));
    }
}

#[tokio::test]
async fn summary_binds_aggregate_and_every_row_viewer_before_wire() {
    let cases = [
        (
            "other",
            Some("other"),
            axum::http::StatusCode::INTERNAL_SERVER_ERROR,
        ),
        (
            "local",
            Some("other"),
            axum::http::StatusCode::INTERNAL_SERVER_ERROR,
        ),
        ("local", Some("local"), axum::http::StatusCode::OK),
        ("local", None, axum::http::StatusCode::OK),
    ];
    for (summary_viewer, summary_row_viewer, expected) in cases {
        let mut request = Request::builder()
            .uri("/api/message-unread-summary")
            .body(Body::empty())
            .unwrap();
        request
            .extensions_mut()
            .insert(UserId::parse("local").unwrap());
        let response = router(SplicedRead {
            summary_viewer,
            summary_row_viewer,
        })
        .oneshot(request)
        .await
        .unwrap();
        assert_eq!(response.status(), expected);
        let body: Value =
            serde_json::from_slice(&to_bytes(response.into_body(), usize::MAX).await.unwrap())
                .unwrap();
        if expected == axum::http::StatusCode::OK {
            let expected_body = if summary_row_viewer.is_some() {
                serde_json::json!({"by_workspace":{"w":1}})
            } else {
                serde_json::json!({"by_workspace":{}})
            };
            assert_eq!(body, expected_body);
        } else {
            assert_eq!(body, serde_json::json!({"error":"internal error"}));
        }
    }
}

#[tokio::test]
async fn every_selected_candidate_is_strictly_decoded_before_any_envelope() {
    let (dir, store) = store("workspace_member").await;
    let options = SqliteConnectOptions::new()
        .filename(dir.path().join("message-unread.sqlite"))
        .foreign_keys(false);
    let mut db = SqliteConnection::connect_with(&options).await.unwrap();
    sqlx::query("DELETE FROM users WHERE id='other'")
        .execute(&mut db)
        .await
        .unwrap();
    drop(db);

    for path in [
        "/api/workspaces/w/message-unread",
        "/api/message-unread-summary",
        "/api/channels/c/message-unread",
    ] {
        let mut request = Request::builder().uri(path).body(Body::empty()).unwrap();
        request
            .extensions_mut()
            .insert(UserId::parse("local").unwrap());
        let response = router(store.message_unread())
            .oneshot(request)
            .await
            .unwrap();
        assert_eq!(
            response.status(),
            axum::http::StatusCode::INTERNAL_SERVER_ERROR
        );
        let body: Value =
            serde_json::from_slice(&to_bytes(response.into_body(), usize::MAX).await.unwrap())
                .unwrap();
        assert_eq!(body, serde_json::json!({"error":"internal error"}));
    }
}
