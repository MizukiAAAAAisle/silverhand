use silverhand_backend_core::{
    conversation_messaging::messaging::collaboration::conversation_agent_activity::{
        ActivityPageRequest, ConversationAgentActivityReadPort, ConversationAgentActivityRefusal,
    },
    foundation::identity::{AgentId, ConversationId, UserId},
};
use silverhand_backend_sqlite::messaging::{
    MessagingStore, collaboration::conversation_agent_activity::ConversationAgentActivityStoreError,
};
use sqlx::{Connection, Executor};

#[path = "support/current_schema_snapshot.rs"]
mod current_schema;

async fn seed(path: &std::path::Path) {
    let mut db = current_schema::create_current_schema(path).await;
    for statement in [
        "INSERT INTO hosts(id,name,kind,created_at) VALUES('h','host','local',1)",
        "INSERT INTO users(id,name,display_name,created_at,updated_at) VALUES \
         ('member','activity-member','Member',1,1),('browser','activity-browser','Browser',1,1),\
         ('other','activity-other','Other',1,1)",
        "INSERT INTO agents(id,name,runtime,host_id,created_by_user_id,created_at,updated_at,display_name) VALUES \
         ('target','activity-target','codex','h','member',1,1,'Target'),\
         ('stranger','activity-stranger','codex','h','member',1,1,'Stranger')",
        "INSERT INTO workspaces(id,name,name_key,created_at,updated_at) VALUES \
         ('w','Workspace','activity-workspace',1,1)",
        "INSERT INTO workspace_users(workspace_id,user_id,joined_at,role) VALUES \
         ('w','member',1,'member'),('w','browser',1,'member')",
        "INSERT INTO conversations(id,workspace_id,placement_kind,roster_policy,title,title_key,status,visibility,created_at,updated_at) VALUES \
         ('private','w','workspace','open','Private','private','idle','private',1,1),\
         ('public','w','workspace','open','Public','public','idle','public',1,1)",
        "INSERT INTO conversation_users(conversation_id,user_id,joined_at) VALUES ('private','member',1)",
        "INSERT INTO conversation_agents(conversation_id,agent_id,joined_at) VALUES \
         ('private','target',1),('public','target',1)",
        "INSERT INTO conversations(id,workspace_id,placement_kind,roster_policy,endpoint_a_kind,endpoint_a_id,endpoint_b_kind,endpoint_b_id,title,title_key,status,visibility,created_at,updated_at) VALUES \
         ('pair',NULL,'direct_pair','fixed','agent','target','human','member','',NULL,'idle','private',1,1)",
        "INSERT INTO conversation_events(id,conversation_id,agent_id,kind,payload,created_at) VALUES \
         (1,'private','target','text','{\"text\":\"one\"}',11),\
         (2,'private','target','text','{\"text\":\"two\"}',12),\
         (3,'private','target','turn_end',NULL,13),\
         (4,'pair','target','text','{\"text\":\"pair\"}',14)",
    ] {
        db.execute(statement).await.unwrap();
    }
    db.close().await.unwrap();
}

async fn read(
    path: &std::path::Path,
    viewer: &str,
    conversation: &str,
    agent: &str,
    limit: u16,
    before: Option<i64>,
) -> Result<
    Result<
        silverhand_backend_core::conversation_messaging::messaging::collaboration::conversation_agent_activity::ConversationAgentActivityPage,
        ConversationAgentActivityRefusal,
    >,
    silverhand_backend_core::foundation::persistence::PersistenceFailure,
>{
    let before = before.map(|value| {
        silverhand_backend_core::conversation_messaging::messaging::collaboration::conversation_agent_activity::ActivityBefore::Persisted(
            silverhand_backend_core::conversation_messaging::messaging::collaboration::conversation_agent_activity::ActivityEventId::new(value)
                .unwrap(),
        )
    });
    MessagingStore::open(path)
        .await
        .unwrap()
        .conversation_agent_activity()
        .read(
            &UserId::parse(viewer).unwrap(),
            &ConversationId::parse(conversation).unwrap(),
            &AgentId::parse(agent).unwrap(),
            ActivityPageRequest::new(limit, before).unwrap(),
        )
        .await
}

fn storage_source(
    error: &silverhand_backend_core::foundation::persistence::PersistenceFailure,
) -> &ConversationAgentActivityStoreError {
    std::error::Error::source(error)
        .and_then(|source| source.downcast_ref())
        .expect("activity failures preserve their named store source")
}

#[tokio::test]
async fn page_order_cursor_visibility_and_target_participation_match_the_product_faces() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("conversation-agent-activity.sqlite");
    seed(&path).await;

    let first = read(&path, "member", "private", "target", 2, None)
        .await
        .unwrap()
        .unwrap()
        .bind(
            &UserId::parse("member").unwrap(),
            &ConversationId::parse("private").unwrap(),
            &AgentId::parse("target").unwrap(),
        )
        .unwrap();
    assert_eq!(
        first
            .events()
            .iter()
            .map(|event| event.id().get())
            .collect::<Vec<_>>(),
        [2, 3]
    );
    assert_eq!(first.next_before().unwrap().get(), 2);

    let second = read(&path, "member", "private", "target", 2, Some(2))
        .await
        .unwrap()
        .unwrap()
        .bind(
            &UserId::parse("member").unwrap(),
            &ConversationId::parse("private").unwrap(),
            &AgentId::parse("target").unwrap(),
        )
        .unwrap();
    assert_eq!(second.events()[0].id().get(), 1);
    assert!(second.next_before().is_none());

    assert_eq!(
        read(&path, "member", "missing", "target", 2, None)
            .await
            .unwrap()
            .unwrap_err(),
        ConversationAgentActivityRefusal::NotFound
    );
    assert_eq!(
        read(&path, "browser", "private", "target", 2, None)
            .await
            .unwrap()
            .unwrap_err(),
        ConversationAgentActivityRefusal::Forbidden
    );
    assert_eq!(
        read(&path, "member", "private", "stranger", 2, None)
            .await
            .unwrap()
            .unwrap_err(),
        ConversationAgentActivityRefusal::TargetNotParticipant
    );
    assert!(
        read(&path, "browser", "public", "target", 2, None)
            .await
            .unwrap()
            .is_ok()
    );
    assert!(
        read(&path, "member", "pair", "target", 2, None)
            .await
            .unwrap()
            .is_ok()
    );
}

#[tokio::test]
async fn lookahead_rows_are_fully_decoded_before_page_slicing() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir
        .path()
        .join("conversation-agent-activity-corrupt.sqlite");
    seed(&path).await;
    let mut db = sqlx::SqliteConnection::connect(&format!("sqlite:{}", path.display()))
        .await
        .unwrap();
    db.execute("PRAGMA ignore_check_constraints=ON")
        .await
        .unwrap();

    db.execute("UPDATE conversation_events SET payload='{' WHERE id=2")
        .await
        .unwrap();
    let error = read(&path, "member", "private", "target", 1, None)
        .await
        .unwrap_err();
    assert!(matches!(
        storage_source(&error),
        ConversationAgentActivityStoreError::Payload
    ));
    db.execute("UPDATE conversation_events SET payload='{\"text\":\"two\"}' WHERE id=2")
        .await
        .unwrap();

    db.execute("UPDATE conversation_events SET kind='future_kind' WHERE id=2")
        .await
        .unwrap();
    let error = read(&path, "member", "private", "target", 1, None)
        .await
        .unwrap_err();
    assert!(matches!(
        storage_source(&error),
        ConversationAgentActivityStoreError::Kind
    ));
    db.execute("UPDATE conversation_events SET kind='text',created_at=-1 WHERE id=2")
        .await
        .unwrap();

    let error = read(&path, "member", "private", "target", 1, None)
        .await
        .unwrap_err();
    assert!(matches!(
        storage_source(&error),
        ConversationAgentActivityStoreError::CreatedAt
    ));
    db.execute("UPDATE conversation_events SET created_at=12 WHERE id=2")
        .await
        .unwrap();
    assert!(
        read(&path, "member", "private", "target", 1, None)
            .await
            .unwrap()
            .is_ok()
    );
}
