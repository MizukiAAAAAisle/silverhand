use silverhand_backend_core::{
    identity::{ConversationId, UserId, WorkspaceId},
    messaging::collaboration::attention_preference::{
        AttentionPreferencePort, AttentionPreferenceRefusal, ChannelAttentionMode,
    },
};
use silverhand_backend_sqlite::messaging::MessagingStore;
use sqlx::Connection;

#[path = "support/current_schema_snapshot.rs"]
mod current_schema;

async fn seeded(path: &std::path::Path) {
    let mut db = current_schema::create_current_schema(path).await;
    for sql in [
        "INSERT INTO users(id,name,display_name,created_at,updated_at) VALUES('u','u','U',1,1),('outsider','outsider','Out',1,1)",
        "INSERT INTO hosts(id,name,kind,created_at,user_id) VALUES('h','H','local',1,'u')",
        "INSERT INTO agents(id,name,runtime,host_id,display_name,created_by_user_id,created_at,updated_at,materialization_status,session_scope) VALUES('a','a','codex','h','A','u',1,1,'active','agent')",
        "INSERT INTO workspaces(id,name,name_key,created_at,owner_user_id,updated_at) VALUES('w','W','w',1,'u',1)",
        "INSERT INTO workspaces(id,name,name_key,owner_agent_id,created_at,owner_user_id,updated_at) VALUES('home','Home',NULL,'a',1,'u',1)",
        "INSERT INTO workspace_users(workspace_id,user_id,joined_at) VALUES('w','u',1)",
        "INSERT INTO workspace_users(workspace_id,user_id,joined_at) VALUES('home','u',1)",
        "INSERT INTO conversations(id,workspace_id,placement_kind,roster_policy,title,title_key,status,created_at,updated_at) VALUES('c','w','workspace','open','C','c','open',1,1)",
        "INSERT INTO conversation_users(conversation_id,user_id,joined_at) VALUES('c','u',1)",
        "INSERT INTO conversations(id,placement_kind,roster_policy,endpoint_a_kind,endpoint_a_id,endpoint_b_kind,endpoint_b_id,title,status,created_at,updated_at) VALUES('pair','direct_pair','fixed','human','outsider','human','u','','open',1,1)",
    ] {
        sqlx::query(sql).execute(&mut db).await.unwrap();
    }
    db.close().await.unwrap();
}

#[tokio::test]
async fn regular_channel_and_workspace_round_trip_through_in_lock_authority() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("attention.sqlite");
    seeded(&path).await;
    let store = MessagingStore::open(&path)
        .await
        .unwrap()
        .attention_preferences();
    let viewer = UserId::parse("u").unwrap();
    let workspace = WorkspaceId::parse("w").unwrap();
    let conversation = ConversationId::parse("c").unwrap();

    let default = store
        .get_workspace(&viewer, workspace.clone())
        .await
        .unwrap()
        .unwrap();
    assert!(!default.muted());

    let channel = store
        .set_channel(
            viewer.clone(),
            conversation.clone(),
            Some(ChannelAttentionMode::Mentions),
        )
        .await
        .unwrap()
        .unwrap();
    assert_eq!(channel.workspace_id(), &workspace);
    assert_eq!(channel.conversation_id(), Some(&conversation));
    assert_eq!(
        channel.channel_preference().unwrap().mode(),
        ChannelAttentionMode::Mentions
    );

    let workspace_write = store
        .set_workspace(viewer.clone(), workspace.clone(), Some(true))
        .await
        .unwrap()
        .unwrap();
    assert!(workspace_write.workspace_preference().unwrap().muted());
    assert!(
        store
            .get_workspace(&viewer, workspace)
            .await
            .unwrap()
            .unwrap()
            .muted()
    );
}

#[tokio::test]
async fn target_and_access_refusals_precede_invalid_body_and_write_nothing() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("attention.sqlite");
    seeded(&path).await;
    let store = MessagingStore::open(&path)
        .await
        .unwrap()
        .attention_preferences();
    let viewer = UserId::parse("u").unwrap();

    let pair = store
        .set_channel(viewer.clone(), ConversationId::parse("pair").unwrap(), None)
        .await
        .unwrap();
    assert!(matches!(
        pair,
        Err(AttentionPreferenceRefusal::ChannelNotFound)
    ));

    let missing_workspace = store
        .set_workspace(viewer.clone(), WorkspaceId::parse("missing").unwrap(), None)
        .await
        .unwrap();
    assert!(matches!(
        missing_workspace,
        Err(AttentionPreferenceRefusal::Forbidden)
    ));

    let invalid_after_admission = store
        .set_channel(viewer, ConversationId::parse("c").unwrap(), None)
        .await
        .unwrap();
    assert!(matches!(
        invalid_after_admission,
        Err(AttentionPreferenceRefusal::InvalidInput)
    ));

    let mut db = sqlx::SqliteConnection::connect(&format!("sqlite:{}", path.display()))
        .await
        .unwrap();
    let rows: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM channel_attention_preferences")
        .fetch_one(&mut db)
        .await
        .unwrap();
    assert_eq!(rows, 0);
}

#[tokio::test]
async fn removing_either_membership_arc_revokes_channel_and_workspace_access() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("attention.sqlite");
    seeded(&path).await;
    let store = MessagingStore::open(&path)
        .await
        .unwrap()
        .attention_preferences();
    let viewer = UserId::parse("u").unwrap();
    let workspace = WorkspaceId::parse("w").unwrap();

    let mut db = sqlx::SqliteConnection::connect(&format!("sqlite:{}", path.display()))
        .await
        .unwrap();
    sqlx::query("DELETE FROM conversation_users WHERE conversation_id='c' AND user_id='u'")
        .execute(&mut db)
        .await
        .unwrap();
    assert!(matches!(
        store
            .set_channel(
                viewer.clone(),
                ConversationId::parse("c").unwrap(),
                Some(ChannelAttentionMode::All)
            )
            .await
            .unwrap(),
        Err(AttentionPreferenceRefusal::Forbidden)
    ));

    sqlx::query("DELETE FROM workspace_users WHERE workspace_id='w' AND user_id='u'")
        .execute(&mut db)
        .await
        .unwrap();
    assert!(matches!(
        store.get_workspace(&viewer, workspace).await.unwrap(),
        Err(AttentionPreferenceRefusal::Forbidden)
    ));
}

#[tokio::test]
async fn visible_agent_home_is_still_hidden_on_both_workspace_faces() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("attention.sqlite");
    seeded(&path).await;
    let store = MessagingStore::open(&path)
        .await
        .unwrap()
        .attention_preferences();
    let viewer = UserId::parse("u").unwrap();
    let home = WorkspaceId::parse("home").unwrap();
    assert!(matches!(
        store.get_workspace(&viewer, home.clone()).await.unwrap(),
        Err(AttentionPreferenceRefusal::WorkspaceNotFound)
    ));
    assert!(matches!(
        store.set_workspace(viewer, home, Some(true)).await.unwrap(),
        Err(AttentionPreferenceRefusal::WorkspaceNotFound)
    ));
}
