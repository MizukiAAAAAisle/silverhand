use silverhand_backend_core::{
    identity::{UserId, WorkspaceId},
    messaging::collaboration::activity::{
        ActivityLocation, ActivityReadModel, ActivitySalience, ActivitySource,
    },
};
use silverhand_backend_sqlite::messaging::MessagingStore;
use sqlx::Connection;
use std::error::Error;

#[path = "support/current_schema_snapshot.rs"]
mod current_schema;

async fn seed(path: &std::path::Path) {
    let mut db = current_schema::create_current_schema(path).await;
    for sql in [
        "INSERT INTO users(id,name,display_name,created_at,updated_at) VALUES \
         ('u','viewer-activity','Viewer',1,1),('other','other-activity','Other',1,2)",
        "INSERT INTO workspaces(id,name,name_key,created_at,updated_at) VALUES \
         ('w','Workspace','workspace-activity',1,1)",
        "INSERT INTO workspace_users(workspace_id,user_id,joined_at) VALUES('w','u',1)",
        "INSERT INTO conversations(id,workspace_id,placement_kind,roster_policy,title,title_key,\
         status,created_at,updated_at,latest_message_seq) VALUES \
         ('c','w','workspace','open','General','general-activity','open',1,1,2)",
        "INSERT INTO conversation_users(conversation_id,user_id,joined_at) VALUES('c','u',1)",
        "INSERT INTO messages(id,conversation_id,from_kind,from_user_id,content,seq,created_at,\
         author_id,author_name,author_display_name) VALUES \
         ('m-mention','c','user','other','  directed   text  ',1,1,'other','other-activity','Other'),\
         ('m-plain','c','user','other','plain unread',2,2,'other','other-activity','Other')",
        "INSERT INTO conversation_stream_heads(conversation_id,thread_root_id,latest_seq) VALUES('c',NULL,2)",
        "INSERT INTO notifications(id,kind,user_id,workspace_id,conversation_id,message_id,payload,created_at) VALUES \
         ('n-old','mention_self','u','w','c','m-mention','{}',2),\
         ('n-new','mention_self','u','w','c','m-mention','{}',3),\
         ('n-fail','agent_start_failed','u','w','c',NULL,'{\"agent_name\":\"Alice\",\"error\":\"runtime down\"}',4)",
        "INSERT INTO conversations(id,workspace_id,placement_kind,roster_policy,title,title_key,\
         status,created_at,updated_at,latest_message_seq,endpoint_a_kind,endpoint_a_id,\
         endpoint_b_kind,endpoint_b_id) VALUES \
         ('pair',NULL,'direct_pair','fixed','',NULL,'open',2,2,1,'human','other','human','u')",
        "INSERT INTO messages(id,conversation_id,from_kind,from_user_id,content,seq,created_at,\
         author_id,author_name,author_display_name) VALUES \
         ('m-pair','pair','user','other','pair unread',1,2,'other','other-activity','Other')",
        "INSERT INTO conversation_stream_heads(conversation_id,thread_root_id,latest_seq) VALUES('pair',NULL,1)",
    ] {
        sqlx::query(sql).execute(&mut db).await.unwrap();
    }
    db.close().await.unwrap();
}

#[tokio::test]
async fn ordered_sources_dedupe_and_subtract_in_one_complete_projection() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("activity.sqlite");
    seed(&path).await;
    let read = MessagingStore::open(&path)
        .await
        .unwrap()
        .activity_read_model();
    let viewer = UserId::parse("u").unwrap();

    let list = read.list_activity(&viewer, None).await.unwrap();
    assert_eq!(list.items().len(), 4);
    assert!(matches!(
        list.items()[0].source(),
        ActivitySource::AgentFailed { notification }
            if notification.as_str() == "n-fail"
    ));
    assert!(matches!(
        list.items()[1].source(),
        ActivitySource::Mention { notification, message }
            if notification.as_str() == "n-new" && message.as_str() == "m-mention"
    ));
    assert!(matches!(
        list.items()[2].source(),
        ActivitySource::Unread { message, count }
            if message.as_str() == "m-pair" && count.get() == 1
    ));
    assert_eq!(list.items()[2].salience(), ActivitySalience::Directed);
    assert!(matches!(
        list.items()[2].location(),
        ActivityLocation::DirectPair { .. }
    ));
    assert!(matches!(
        list.items()[3].source(),
        ActivitySource::Unread { message, count }
            if message.as_str() == "m-plain" && count.get() == 1
    ));
    assert_eq!(list.items()[3].salience(), ActivitySalience::Ambient);
    assert_eq!(list.items()[1].preview().unwrap().as_str(), "directed text");
    assert!(list.items()[1].preview_sender().is_some());

    let scoped = read
        .list_activity(&viewer, Some(&WorkspaceId::parse("w").unwrap()))
        .await
        .unwrap();
    assert_eq!(scoped.items().len(), 3);
    assert!(scoped.items().iter().all(|item| matches!(
        item.location(),
        ActivityLocation::WorkspaceChannel { workspace, .. } if workspace.as_str() == "w"
    )));
}

#[tokio::test]
async fn cursor_archive_and_attention_tier_drive_both_sources_without_mutating_claims() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("activity.sqlite");
    seed(&path).await;
    let read = MessagingStore::open(&path)
        .await
        .unwrap()
        .activity_read_model();
    let viewer = UserId::parse("u").unwrap();
    let mut db = sqlx::SqliteConnection::connect(&format!("sqlite:{}", path.display()))
        .await
        .unwrap();

    sqlx::query("INSERT INTO conversation_reads(user_id,conversation_id,thread_root_id,last_read_seq,read_at) VALUES('u','c',NULL,1,5)")
        .execute(&mut db)
        .await
        .unwrap();
    let after_cursor = read.list_activity(&viewer, None).await.unwrap();
    assert!(
        !after_cursor
            .items()
            .iter()
            .any(|item| matches!(item.source(), ActivitySource::Mention { .. }))
    );
    assert!(after_cursor.items().iter().any(|item| matches!(
        item.source(), ActivitySource::Unread { message, .. } if message.as_str() == "m-plain"
    )));

    sqlx::query("INSERT INTO channel_attention_preferences(user_id,conversation_id,mode,updated_at) VALUES('u','c','mentions',6)")
        .execute(&mut db)
        .await
        .unwrap();
    let mentions_only = read.list_activity(&viewer, None).await.unwrap();
    assert!(
        !mentions_only
            .items()
            .iter()
            .any(|item| item.conversation().as_str() == "c"
                && matches!(item.source(), ActivitySource::Unread { .. }))
    );
    assert!(
        mentions_only
            .items()
            .iter()
            .any(|item| matches!(item.source(), ActivitySource::AgentFailed { .. }))
    );

    sqlx::query("UPDATE conversations SET archived_at=7 WHERE id='c'")
        .execute(&mut db)
        .await
        .unwrap();
    let archived = read.list_activity(&viewer, None).await.unwrap();
    assert!(
        archived
            .items()
            .iter()
            .all(|item| item.conversation().as_str() != "c")
    );
    let still_unread: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM notifications WHERE read_at IS NULL")
            .fetch_one(&mut db)
            .await
            .unwrap();
    assert_eq!(still_unread, 3, "cold projection never clears its sources");
}

#[tokio::test]
async fn malformed_placement_fails_the_whole_snapshot_with_a_source_chain() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("activity.sqlite");
    seed(&path).await;
    let read = MessagingStore::open(&path)
        .await
        .unwrap()
        .activity_read_model();
    let viewer = UserId::parse("u").unwrap();
    let mut db = sqlx::SqliteConnection::connect(&format!("sqlite:{}", path.display()))
        .await
        .unwrap();
    sqlx::query("PRAGMA ignore_check_constraints=ON")
        .execute(&mut db)
        .await
        .unwrap();
    sqlx::query("DROP TRIGGER trg_conversations_endpoints_immutable")
        .execute(&mut db)
        .await
        .unwrap();
    sqlx::query("UPDATE conversations SET endpoint_a_kind='device' WHERE id='pair'")
        .execute(&mut db)
        .await
        .unwrap();

    let error = read.list_activity(&viewer, None).await.unwrap_err();
    assert!(error.source().is_some());
    assert!(format!("{error:?}").contains("UnknownEndpointKind"));
}
