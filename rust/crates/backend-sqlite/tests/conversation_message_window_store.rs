use silverhand_backend_core::{
    identity::{ConversationId, UserId},
    messaging::{
        MessageId,
        collaboration::conversation_message_window::{
            ConversationMessageWindowReadPort, ConversationMessageWindowRequest,
            MessageWindowAnchor, MessageWindowAudience, MessageWindowRefusal,
            MessageWindowStreamRequest,
        },
    },
};
use silverhand_backend_sqlite::messaging::MessagingStore;
use silverhand_backend_sqlite::messaging::collaboration::conversation_message_window::ConversationMessageWindowStoreError;
use sqlx::{Connection, Executor};

#[path = "support/current_schema_snapshot.rs"]
mod current_schema;

async fn seed(path: &std::path::Path) {
    let mut db = current_schema::create_current_schema(path).await;
    for statement in [
        "INSERT INTO users(id,name,display_name,created_at,updated_at) VALUES \
         ('viewer','viewer','Viewer',1,1),('outsider','outsider','Outsider',1,1),\
         ('reply-a','reply-a','Reply A',1,1),('reply-b','reply-b','Reply B',1,1)",
        "INSERT INTO workspaces(id,name,name_key,created_at,updated_at) VALUES \
         ('w','Workspace','workspace',1,1)",
        "INSERT INTO workspace_users(workspace_id,user_id,joined_at,role) VALUES \
         ('w','viewer',1,'member'),('w','outsider',1,'member')",
        "INSERT INTO conversations(id,workspace_id,placement_kind,roster_policy,title,title_key,\
         status,visibility,latest_message_seq,created_at,updated_at) VALUES \
         ('c','w','workspace','open','Channel','channel','idle','public',5,1,1)",
        "INSERT INTO conversations(id,workspace_id,placement_kind,roster_policy,endpoint_a_kind,\
         endpoint_a_id,endpoint_b_kind,endpoint_b_id,title,title_key,status,visibility,\
         latest_message_seq,created_at,updated_at) VALUES \
         ('pair',NULL,'direct_pair','fixed','human','reply-a','human','viewer','',NULL,'idle',\
         'private',0,1,1)",
        "INSERT INTO conversation_users(conversation_id,user_id,joined_at) VALUES('c','viewer',1)",
        "INSERT INTO messages(id,conversation_id,from_kind,from_user_id,content,metadata,seq,\
         created_at,author_id,author_name,author_display_name) VALUES \
         ('root-1','c','user','viewer','root one',NULL,1,10,'viewer','viewer','Viewer'),\
         ('root-2','c','user','viewer','root two','{\"attachments\":[{\"id\":\"att-1\",\"filename\":\"x.png\",\"size\":12,\"content_type\":\"image/png\"}]}',2,20,'viewer','viewer','Viewer')",
        "INSERT INTO messages(id,conversation_id,from_kind,from_user_id,content,metadata,seq,\
         created_at,thread_root_id,author_id,author_name,author_display_name) VALUES \
         ('reply-1','c','user','reply-a',' first   reply ',NULL,3,30,'root-1','reply-a','reply-a','Reply A'),\
         ('reply-system','c','system',NULL,'system reply',NULL,4,40,'root-1',NULL,NULL,NULL),\
         ('reply-2','c','user','reply-b','second reply','{\"attachments\":[{\"id\":\"att-2\",\"filename\":\"note.txt\",\"size\":4,\"content_type\":\"text/plain\",\"label\":\"File #2\"}]}',5,50,'root-1','reply-b','reply-b','Reply B')",
        "INSERT INTO conversation_stream_heads(conversation_id,thread_root_id,latest_seq) VALUES \
         ('c',NULL,2),('c','root-1',5)",
        "INSERT INTO message_reactions(id,message_id,reactor_kind,reactor_id,emoji,created_at) VALUES \
         ('reaction-1','root-2','user','viewer','👍',3),\
         ('reaction-2','root-2','user','outsider','👍',4)",
        "INSERT INTO tasks(id,workspace_id,task_number,conversation_id,title,status,creator_kind,\
         creator_user_id,source_message_id,created_at,board_key) VALUES \
         ('task-1','w',1,'c','Linked task','todo','user','viewer','root-2',1,'ws:w')",
    ] {
        db.execute(statement).await.unwrap();
    }
    db.close().await.unwrap();
}

async fn read(
    path: &std::path::Path,
    viewer: &str,
    request: ConversationMessageWindowRequest,
) -> Result<
    Result<
        silverhand_backend_core::messaging::collaboration::conversation_message_window::ConversationMessageWindow,
        MessageWindowRefusal,
    >,
    silverhand_backend_core::persistence::PersistenceFailure,
>{
    MessagingStore::open(path)
        .await
        .unwrap()
        .conversation_message_window()
        .read(
            &UserId::parse(viewer).unwrap(),
            &ConversationId::parse("c").unwrap(),
            request,
        )
        .await
}

async fn read_conversation(
    path: &std::path::Path,
    viewer: &str,
    conversation: &str,
    request: ConversationMessageWindowRequest,
) -> Result<
    Result<
        silverhand_backend_core::messaging::collaboration::conversation_message_window::ConversationMessageWindow,
        MessageWindowRefusal,
    >,
    silverhand_backend_core::persistence::PersistenceFailure,
>{
    MessagingStore::open(path)
        .await
        .unwrap()
        .conversation_message_window()
        .read(
            &UserId::parse(viewer).unwrap(),
            &ConversationId::parse(conversation).unwrap(),
            request,
        )
        .await
}

#[tokio::test]
async fn mainline_thread_public_neutralization_and_sidecars_share_one_snapshot() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("message-window.sqlite");
    seed(&path).await;
    let conversation = ConversationId::parse("c").unwrap();

    let latest = ConversationMessageWindowRequest::new(
        MessageWindowStreamRequest::Mainline,
        2,
        MessageWindowAnchor::Latest,
    )
    .unwrap();
    let bound = read(&path, "viewer", latest.clone())
        .await
        .unwrap()
        .unwrap()
        .bind(&UserId::parse("viewer").unwrap(), &conversation, &latest)
        .unwrap();
    assert_eq!(bound.audience(), MessageWindowAudience::Participating);
    assert_eq!(bound.stream_head().get(), 2);
    assert_eq!(
        bound
            .messages()
            .iter()
            .map(|row| row.projection().id.as_str())
            .collect::<Vec<_>>(),
        ["root-1", "root-2"]
    );
    assert_eq!(bound.roots().len(), 2);
    assert_eq!(bound.roots()[0].root().as_str(), "root-1");
    assert_eq!(bound.roots()[0].count().get(), 2);
    assert_eq!(bound.roots()[0].previews().len(), 2);
    assert_eq!(
        bound.roots()[0].previews()[1]
            .first_attachment_label()
            .unwrap()
            .to_string(),
        "File #2"
    );
    assert_eq!(
        bound.messages()[1]
            .projection()
            .linked_task
            .as_ref()
            .unwrap()
            .id(),
        "task-1"
    );
    assert!(!bound.has_more_before() && !bound.has_more_after());
    assert!(
        bound.messages()[1].projection().reactions[0]
            .aggregate()
            .viewer_reacted()
    );

    let public = read(&path, "outsider", latest.clone())
        .await
        .unwrap()
        .unwrap()
        .bind(&UserId::parse("outsider").unwrap(), &conversation, &latest)
        .unwrap();
    assert_eq!(public.audience(), MessageWindowAudience::PublicNonmember);
    assert!(
        !public.messages()[1].projection().reactions[0]
            .aggregate()
            .viewer_reacted()
    );

    let thread = ConversationMessageWindowRequest::new(
        MessageWindowStreamRequest::Thread(MessageId::parse("reply-1").unwrap()),
        10,
        MessageWindowAnchor::Latest,
    )
    .unwrap();
    let thread_page = read(&path, "viewer", thread.clone())
        .await
        .unwrap()
        .unwrap()
        .bind(&UserId::parse("viewer").unwrap(), &conversation, &thread)
        .unwrap();
    assert_eq!(thread_page.stream().root().unwrap().as_str(), "root-1");
    assert_eq!(thread_page.stream_head().get(), 5);
    assert_eq!(thread_page.messages().len(), 4);

    let before = ConversationMessageWindowRequest::new(
        MessageWindowStreamRequest::Mainline,
        1,
        MessageWindowAnchor::Before(
            silverhand_backend_core::messaging::MessageSeq::try_from(2).unwrap(),
        ),
    )
    .unwrap();
    let before_page = read(&path, "viewer", before.clone())
        .await
        .unwrap()
        .unwrap()
        .bind(&UserId::parse("viewer").unwrap(), &conversation, &before)
        .unwrap();
    assert_eq!(before_page.messages()[0].projection().id.as_str(), "root-1");
    assert!(!before_page.has_more_before());
    assert!(before_page.has_more_after());

    let after = ConversationMessageWindowRequest::new(
        MessageWindowStreamRequest::Mainline,
        1,
        MessageWindowAnchor::After(
            silverhand_backend_core::messaging::MessageSeq::try_from(1).unwrap(),
        ),
    )
    .unwrap();
    let after_page = read(&path, "viewer", after.clone())
        .await
        .unwrap()
        .unwrap()
        .bind(&UserId::parse("viewer").unwrap(), &conversation, &after)
        .unwrap();
    assert_eq!(after_page.messages()[0].projection().id.as_str(), "root-2");
    assert!(after_page.has_more_before());
    assert!(!after_page.has_more_after());

    let around = ConversationMessageWindowRequest::new(
        MessageWindowStreamRequest::Mainline,
        1,
        MessageWindowAnchor::Around(MessageId::parse("root-1").unwrap()),
    )
    .unwrap();
    let around_page = read(&path, "viewer", around.clone())
        .await
        .unwrap()
        .unwrap()
        .bind(&UserId::parse("viewer").unwrap(), &conversation, &around)
        .unwrap();
    assert_eq!(around_page.messages()[0].projection().id.as_str(), "root-1");
    assert!(around_page.has_more_after());

    let pair_request = ConversationMessageWindowRequest::new(
        MessageWindowStreamRequest::Mainline,
        10,
        MessageWindowAnchor::Latest,
    )
    .unwrap();
    let pair = read_conversation(&path, "viewer", "pair", pair_request.clone())
        .await
        .unwrap()
        .unwrap()
        .bind(
            &UserId::parse("viewer").unwrap(),
            &ConversationId::parse("pair").unwrap(),
            &pair_request,
        )
        .unwrap();
    assert!(pair.messages().is_empty());

    let missing = ConversationMessageWindowRequest::new(
        MessageWindowStreamRequest::Mainline,
        10,
        MessageWindowAnchor::Around(MessageId::parse("missing").unwrap()),
    )
    .unwrap();
    assert_eq!(
        read(&path, "viewer", missing).await.unwrap().unwrap_err(),
        MessageWindowRefusal::AnchorNotFound
    );
}

#[tokio::test]
async fn selected_reply_sidecars_are_strictly_decoded_before_projection() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("message-window-corrupt.sqlite");
    seed(&path).await;
    let mut db = sqlx::SqliteConnection::connect(&format!("sqlite:{}", path.display()))
        .await
        .unwrap();
    db.execute("UPDATE messages SET metadata='not-json' WHERE id='reply-2'")
        .await
        .unwrap();
    db.close().await.unwrap();
    let latest = ConversationMessageWindowRequest::new(
        MessageWindowStreamRequest::Mainline,
        2,
        MessageWindowAnchor::Latest,
    )
    .unwrap();
    assert!(read(&path, "viewer", latest.clone()).await.is_err());

    let mut db = sqlx::SqliteConnection::connect(&format!("sqlite:{}", path.display()))
        .await
        .unwrap();
    db.execute("UPDATE messages SET metadata=NULL WHERE id='reply-2'")
        .await
        .unwrap();
    db.close().await.unwrap();
    assert!(read(&path, "viewer", latest).await.unwrap().is_ok());
}

#[tokio::test]
async fn linked_task_uses_its_actual_conversation_and_rejects_cross_conversation_drift() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("message-window-linked-task-corrupt.sqlite");
    seed(&path).await;
    let latest = ConversationMessageWindowRequest::new(
        MessageWindowStreamRequest::Mainline,
        2,
        MessageWindowAnchor::Latest,
    )
    .unwrap();

    let mut db = sqlx::SqliteConnection::connect(&format!("sqlite:{}", path.display()))
        .await
        .unwrap();
    db.execute(
        "INSERT INTO conversations(id,workspace_id,placement_kind,roster_policy,title,title_key,\
         status,visibility,latest_message_seq,created_at,updated_at) VALUES \
         ('foreign','w','workspace','open','Foreign','foreign','idle','private',0,1,1)",
    )
    .await
    .unwrap();
    db.execute("DROP TRIGGER trg_tasks_board_coordinates_immutable")
        .await
        .unwrap();
    db.execute("UPDATE tasks SET conversation_id='foreign' WHERE id='task-1'")
        .await
        .unwrap();
    db.close().await.unwrap();

    let error = read(&path, "viewer", latest.clone()).await.unwrap_err();
    let source = std::error::Error::source(&error)
        .and_then(|source| source.downcast_ref::<ConversationMessageWindowStoreError>())
        .expect("message-window failure preserves its named SQLite source");
    assert!(matches!(
        source,
        ConversationMessageWindowStoreError::Projection(
            silverhand_backend_core::messaging::collaboration::conversation_message_window::MessageWindowCorruption::LinkedTask
        )
    ));

    let mut db = sqlx::SqliteConnection::connect(&format!("sqlite:{}", path.display()))
        .await
        .unwrap();
    db.execute("UPDATE tasks SET conversation_id='c' WHERE id='task-1'")
        .await
        .unwrap();
    db.close().await.unwrap();

    let repaired = read(&path, "viewer", latest.clone())
        .await
        .unwrap()
        .unwrap()
        .bind(
            &UserId::parse("viewer").unwrap(),
            &ConversationId::parse("c").unwrap(),
            &latest,
        )
        .unwrap();
    assert_eq!(
        repaired.messages()[1]
            .projection()
            .linked_task
            .as_ref()
            .unwrap()
            .id(),
        "task-1"
    );
}
