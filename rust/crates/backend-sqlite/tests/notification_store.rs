use silverhand_backend_core::{
    identity::UserId,
    messaging::collaboration::notification::{
        NotificationClearPort, NotificationClearSelector, NotificationListQuery,
        NotificationReadPort,
    },
};
use silverhand_backend_sqlite::messaging::MessagingStore;
use sqlx::Connection;
#[path = "support/current_schema_snapshot.rs"]
mod current_schema;

async fn seeded(path: &std::path::Path) {
    let mut db = current_schema::create_current_schema(path).await;
    for sql in [
        "INSERT INTO users(id,name,display_name,created_at,updated_at) VALUES('u','u','U',1,1),('other','o','O',1,1)",
        "INSERT INTO workspaces(id,name,name_key,created_at,owner_user_id,updated_at) VALUES('w1','W1','w1',1,'u',1),('w2','W2','w2',1,'u',1)",
        "INSERT INTO conversations(id,workspace_id,placement_kind,roster_policy,title,title_key,status,created_at,updated_at) VALUES('c1','w1','workspace','open','C1','c1','open',1,1),('c2','w2','workspace','open','C2','c2','open',1,1)",
        "INSERT INTO messages(id,conversation_id,from_kind,from_user_id,content,seq,created_at) VALUES('m1','c1','user','u','one',1,1),('m2','c2','user','u','two',1,2)",
        "INSERT INTO notifications(id,kind,user_id,workspace_id,conversation_id,message_id,payload,created_at) VALUES('n1','mention_self','u','w1','c1','m1','{}',10),('n2','mention_self','u',NULL,'c2','m2','{}',10),('n3','agent_start_failed','u','w1',NULL,NULL,'{}',10),('n4','agent_start_failed','u','w2',NULL,NULL,'{}',10),('foreign','mention_self','other','w1','c1','m1','{}',20)",
    ] {
        sqlx::query(sql).execute(&mut db).await.unwrap();
    }
    db.close().await.unwrap();
}

#[tokio::test]
async fn viewer_read_and_atomic_clear_return_exact_committed_workspaces() {
    let d = tempfile::tempdir().unwrap();
    let path = d.path().join("n.sqlite");
    seeded(&path).await;
    let store = MessagingStore::open(&path).await.unwrap();
    let n = store.notifications();
    let viewer = UserId::parse("u").unwrap();
    let list = n
        .list(
            &viewer,
            NotificationListQuery {
                unread_only: true,
                limit: 100,
            },
        )
        .await
        .unwrap();
    assert_eq!(
        list.iter().map(|n| n.id.as_str()).collect::<Vec<_>>(),
        ["n4", "n3", "n2", "n1"]
    );
    let summary = n.unread_summary(&viewer).await.unwrap();
    assert_eq!(summary.total, 4);
    assert_eq!(summary.latest_by_workspace.len(), 2);
    let by_id = n
        .clear(viewer.clone(), NotificationClearSelector::Id(silverhand_backend_core::messaging::collaboration::notification::NotificationId::parse("n1").unwrap()))
        .await
        .unwrap();
    assert_eq!(by_id.marked(), 1);
    assert_eq!(by_id.changed_workspaces()[0].as_str(), "w1");
    let by_workspace = n
        .clear(
            viewer.clone(),
            NotificationClearSelector::Workspace(
                silverhand_backend_core::identity::WorkspaceId::parse("w1").unwrap(),
            ),
        )
        .await
        .unwrap();
    assert_eq!(by_workspace.marked(), 1);
    let by_conversation = n
        .clear(
            viewer.clone(),
            NotificationClearSelector::Conversation(
                silverhand_backend_core::identity::ConversationId::parse("c2").unwrap(),
            ),
        )
        .await
        .unwrap();
    assert_eq!(by_conversation.marked(), 1);
    assert_eq!(by_conversation.changed_workspaces()[0].as_str(), "w2");
    let committed = n
        .clear(viewer.clone(), NotificationClearSelector::All)
        .await
        .unwrap();
    assert_eq!(committed.marked(), 1);
    assert_eq!(
        committed
            .changed_workspaces()
            .iter()
            .map(|w| w.as_str())
            .collect::<Vec<_>>(),
        ["w2"]
    );
    assert!(
        n.list(
            &viewer,
            NotificationListQuery {
                unread_only: true,
                limit: 100
            }
        )
        .await
        .unwrap()
        .is_empty()
    );
    let mut db = sqlx::SqliteConnection::connect(&format!("sqlite:{}", path.display()))
        .await
        .unwrap();
    let foreign: Option<i64> =
        sqlx::query_scalar("SELECT read_at FROM notifications WHERE id='foreign'")
            .fetch_one(&mut db)
            .await
            .unwrap();
    assert_eq!(foreign, None);
}
