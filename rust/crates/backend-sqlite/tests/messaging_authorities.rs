use std::{
    convert::Infallible,
    error::Error,
    ops::Range,
    path::PathBuf,
    sync::{Arc, Mutex},
};

use silverhand_backend_core::{
    identity::{AgentId, ConversationId, UserId},
    messaging::{
        AddressRefusal, ChannelAccess, ChannelAccessRefusal, DirectPairAllocation,
        DirectPairOpenedFact, DirectPairOpenedPort, MessageContent, ReferencePositions, SendActor,
        SendCapability, SendDestination, SendMessage, SendMessageDraft, SendMessageUnitOfWork,
        TargetAddress,
    },
};
use silverhand_backend_sqlite::messaging::MessagingStore;
use sqlx::SqliteConnection;
use tempfile::TempDir;

#[path = "support/current_schema_snapshot.rs"]
mod current_schema;

const USER: &str = "user-1";
const OTHER_USER: &str = "user-2";
const AGENT: &str = "agent-1";
const PEER: &str = "agent-2";
const HIDDEN: &str = "agent-3";
const WORKSPACE: &str = "workspace-1";
const CHANNEL: &str = "conv000000000001";
const ROOT: &str = "root000000000001";

struct Fixture {
    _temp: TempDir,
    path: PathBuf,
    db: SqliteConnection,
}

impl Fixture {
    async fn new() -> Self {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("authority.sqlite");
        let mut db = current_schema::create_current_schema(&path).await;
        seed(&mut db).await;
        Self {
            _temp: temp,
            path,
            db,
        }
    }

    async fn store(&self) -> MessagingStore {
        MessagingStore::open(&self.path).await.unwrap()
    }
}

#[derive(Clone, Default)]
struct Opened(Arc<Mutex<Vec<DirectPairOpenedFact>>>);

impl DirectPairOpenedPort for Opened {
    type Error = Infallible;

    async fn direct_pair_opened(&self, fact: &DirectPairOpenedFact) -> Result<(), Self::Error> {
        self.0.lock().unwrap().push(fact.clone());
        Ok(())
    }
}

fn user() -> UserId {
    UserId::parse(USER).unwrap()
}

fn agent() -> AgentId {
    AgentId::parse(AGENT).unwrap()
}

fn channel() -> ConversationId {
    ConversationId::parse(CHANNEL).unwrap()
}

async fn seed(db: &mut SqliteConnection) {
    sqlx::query(
        "INSERT INTO hosts (id, name, kind, created_at) VALUES ('host-1', 'host', 'local', 0)",
    )
    .execute(&mut *db)
    .await
    .unwrap();
    for (id, name) in [(USER, "human"), (OTHER_USER, "other")] {
        sqlx::query("INSERT INTO users (id, name, display_name, created_at, updated_at) VALUES (?, ?, ?, 0, 0)")
            .bind(id).bind(name).bind(name).execute(&mut *db).await.unwrap();
    }
    for (id, name, creator, scope) in [
        (AGENT, "actor", USER, "agent"),
        (PEER, "peer", USER, "agent"),
        (HIDDEN, "hidden", OTHER_USER, "agent"),
    ] {
        sqlx::query("INSERT INTO agents (id, name, runtime, host_id, created_at, updated_at, display_name, created_by_user_id, materialization_status, session_scope) VALUES (?, ?, 'codex', 'host-1', 0, 0, ?, ?, 'active', ?)")
            .bind(id).bind(name).bind(name).bind(creator).bind(scope).execute(&mut *db).await.unwrap();
    }
    sqlx::query("INSERT INTO workspaces (id, name, name_key, owner_user_id, created_at, updated_at) VALUES (?, 'Product Space', 'product space', ?, 0, 0)")
        .bind(WORKSPACE).bind(USER).execute(&mut *db).await.unwrap();
    sqlx::query("INSERT INTO workspace_users (workspace_id, user_id, joined_at, role) VALUES (?, ?, 0, 'owner')")
        .bind(WORKSPACE).bind(USER).execute(&mut *db).await.unwrap();
    for id in [AGENT, PEER] {
        sqlx::query(
            "INSERT INTO workspace_members (workspace_id, agent_id, joined_at) VALUES (?, ?, 0)",
        )
        .bind(WORKSPACE)
        .bind(id)
        .execute(&mut *db)
        .await
        .unwrap();
    }
    sqlx::query("INSERT INTO conversations (id, workspace_id, placement_kind, roster_policy, title, title_key, status, visibility, created_at, updated_at, latest_message_seq) VALUES (?, ?, 'workspace', 'open', 'General Chat', 'general chat', 'open', 'private', 0, 0, 1)")
        .bind(CHANNEL).bind(WORKSPACE).execute(&mut *db).await.unwrap();
    sqlx::query(
        "INSERT INTO conversation_users (conversation_id, user_id, joined_at) VALUES (?, ?, 0)",
    )
    .bind(CHANNEL)
    .bind(USER)
    .execute(&mut *db)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO conversation_agents (conversation_id, agent_id, joined_at) VALUES (?, ?, 0)",
    )
    .bind(CHANNEL)
    .bind(AGENT)
    .execute(&mut *db)
    .await
    .unwrap();
    sqlx::query("INSERT INTO workspace_agent_capabilities (workspace_id, agent_id, capability) VALUES (?, ?, 'send_messages')")
        .bind(WORKSPACE).bind(AGENT).execute(&mut *db).await.unwrap();
    sqlx::query("INSERT INTO messages (id, conversation_id, from_kind, from_user_id, content, seq, created_at) VALUES (?, ?, 'user', ?, 'root', 1, 0)")
        .bind(ROOT).bind(CHANNEL).bind(USER).execute(&mut *db).await.unwrap();
}

#[tokio::test]
async fn human_channel_access_distinguishes_refusal_from_driver_failure() {
    let mut fixture = Fixture::new().await;
    let store = fixture.store().await;

    assert_eq!(store.may_post(&channel(), &user()).await.unwrap(), Ok(()));
    sqlx::query("DELETE FROM conversation_users WHERE conversation_id = ? AND user_id = ?")
        .bind(CHANNEL)
        .bind(USER)
        .execute(&mut fixture.db)
        .await
        .unwrap();
    assert_eq!(
        store.may_post(&channel(), &user()).await.unwrap(),
        Err(ChannelAccessRefusal::Forbidden)
    );
    assert_eq!(
        store
            .may_post(&ConversationId::parse("missing").unwrap(), &user())
            .await
            .unwrap(),
        Err(ChannelAccessRefusal::NotFound)
    );

    sqlx::query("DROP TABLE conversation_users")
        .execute(&mut fixture.db)
        .await
        .unwrap();
    let error = store.may_post(&channel(), &user()).await.unwrap_err();
    assert!(error.to_string().contains("persistence operation failed"));
    assert!(error.source().is_some());
}

#[tokio::test]
async fn target_resolution_covers_all_grammar_arms_and_required_pair_announcement() {
    let mut fixture = Fixture::new().await;
    let store = fixture.store().await;
    let opened = Opened::default();
    let target = store.target_address(opened.clone());

    let by_id = target
        .resolve(
            &agent(),
            "#conv:conv000000000001/thread:root000000000001",
            DirectPairAllocation::Permitted,
        )
        .await
        .unwrap()
        .unwrap();
    assert_eq!(by_id.conversation.as_str(), CHANNEL);
    assert_eq!(by_id.thread_root.unwrap().as_str(), ROOT);

    let by_name = target
        .resolve(
            &agent(),
            "#Product%20Space/General%20Chat",
            DirectPairAllocation::Permitted,
        )
        .await
        .unwrap()
        .unwrap();
    assert_eq!(by_name.conversation.as_str(), CHANNEL);

    sqlx::query("UPDATE workspaces SET name = 'Straße', name_key = 'strasse' WHERE id = ?")
        .bind(WORKSPACE)
        .execute(&mut fixture.db)
        .await
        .unwrap();
    sqlx::query("UPDATE conversations SET title = 'Kelvin', title_key = 'kelvin' WHERE id = ?")
        .bind(CHANNEL)
        .execute(&mut fixture.db)
        .await
        .unwrap();
    let folded = target
        .resolve(&agent(), "#STRASSE/kelvin", DirectPairAllocation::Permitted)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(folded.conversation.as_str(), CHANNEL);

    let first = target
        .resolve(&agent(), "dm:@peer", DirectPairAllocation::Permitted)
        .await
        .unwrap()
        .unwrap();
    let second = target
        .resolve(&agent(), "dm:@peer", DirectPairAllocation::Permitted)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(first.conversation, second.conversation);
    assert_eq!(opened.0.lock().unwrap().len(), 1);

    assert_eq!(
        target
            .resolve(&agent(), "dm:@hidden", DirectPairAllocation::Forbidden)
            .await
            .unwrap(),
        Err(AddressRefusal::Unresolved)
    );
    assert_eq!(
        target
            .resolve(&agent(), "not-an-address", DirectPairAllocation::Permitted)
            .await
            .unwrap(),
        Err(AddressRefusal::Malformed)
    );
}

#[tokio::test]
async fn send_capability_uses_placement_and_reports_corruption_as_our_failure() {
    let mut fixture = Fixture::new().await;
    let store = fixture.store().await;
    assert_eq!(
        store.may_send_messages(&agent(), &channel()).await.unwrap(),
        Ok(())
    );

    sqlx::query("DELETE FROM workspace_agent_capabilities WHERE workspace_id = ? AND agent_id = ?")
        .bind(WORKSPACE)
        .bind(AGENT)
        .execute(&mut fixture.db)
        .await
        .unwrap();
    assert!(
        store
            .may_send_messages(&agent(), &channel())
            .await
            .unwrap()
            .is_err()
    );

    sqlx::query("DROP TABLE workspace_agent_capabilities")
        .execute(&mut fixture.db)
        .await
        .unwrap();
    let error = store
        .may_send_messages(&agent(), &channel())
        .await
        .unwrap_err();
    assert!(error.source().is_some());
}

#[tokio::test]
async fn direct_line_authority_is_active_agent_scoped_and_uses_the_real_viewer_acl() {
    let mut fixture = Fixture::new().await;
    let store = fixture.store().await;
    struct Autolinks;
    impl ReferencePositions for Autolinks {
        fn autolink_spans(&self, content: &MessageContent) -> Vec<Range<usize>> {
            let body = content.as_str();
            let mut spans = Vec::new();
            let mut cursor = 0;
            while let Some(open) = body[cursor..].find('<') {
                let open = cursor + open;
                let close = open + body[open..].find('>').unwrap();
                spans.push(open..close + 1);
                cursor = close + 1;
            }
            spans
        }
    }
    let command = SendMessage::prepare(
        SendMessageDraft {
            source_conversation: channel(),
            target_conversation: channel(),
            actor: SendActor::User(user()),
            content: MessageContent::parse("<silverhand://agent/peer> <silverhand://agent/hidden>")
                .unwrap(),
            destination: SendDestination::MainLine,
            attachment_refs: Vec::new(),
            freshness_bypass: false,
        },
        &Autolinks,
        &store,
    )
    .await
    .unwrap();
    assert!(
        command
            .direct_lines()
            .contains(&AgentId::parse(PEER).unwrap())
    );
    assert!(
        !command
            .direct_lines()
            .contains(&AgentId::parse(HIDDEN).unwrap())
    );

    let drifted = SendMessage::prepare(
        SendMessageDraft {
            source_conversation: channel(),
            target_conversation: channel(),
            actor: SendActor::User(user()),
            content: MessageContent::parse("<silverhand://agent/peer>").unwrap(),
            destination: SendDestination::MainLine,
            attachment_refs: Vec::new(),
            freshness_bypass: false,
        },
        &Autolinks,
        &store,
    )
    .await
    .unwrap();
    sqlx::query("UPDATE agents SET name = 'renamed' WHERE id = ?")
        .bind(PEER)
        .execute(&mut fixture.db)
        .await
        .unwrap();
    sqlx::query("UPDATE agents SET name = 'peer' WHERE id = ?")
        .bind(HIDDEN)
        .execute(&mut fixture.db)
        .await
        .unwrap();
    store.send_message(drifted).await.unwrap();
    let copied: i64 =
        sqlx::query_scalar("SELECT count(*) FROM messages WHERE cc_source_message_id IS NOT NULL")
            .fetch_one(&mut fixture.db)
            .await
            .unwrap();
    assert_eq!(
        copied, 0,
        "an ACL grant must not follow a reassigned handle"
    );
}

#[tokio::test]
async fn persisted_placement_corruption_is_never_a_capability_denial() {
    for mutation in [
        "UPDATE conversations SET placement_kind = 'broken' WHERE id = 'conv000000000001'",
        "UPDATE conversations SET workspace_id = NULL WHERE id = 'conv000000000001'",
        "UPDATE conversations SET placement_kind = 'direct_pair', workspace_id = NULL, \
         endpoint_a_kind = 'agent', endpoint_a_id = 'agent-1', endpoint_b_kind = NULL, \
         endpoint_b_id = NULL, title_key = NULL, roster_policy = 'fixed' \
         WHERE id = 'conv000000000001'",
    ] {
        let mut fixture = Fixture::new().await;
        sqlx::query("PRAGMA ignore_check_constraints = ON")
            .execute(&mut fixture.db)
            .await
            .unwrap();
        sqlx::query("DROP TRIGGER conversations_placement_immutable")
            .execute(&mut fixture.db)
            .await
            .unwrap();
        sqlx::query("DROP TRIGGER trg_conversations_endpoints_immutable")
            .execute(&mut fixture.db)
            .await
            .unwrap();
        sqlx::query(mutation)
            .execute(&mut fixture.db)
            .await
            .unwrap();
        let store = fixture.store().await;
        let error = store
            .may_send_messages(&agent(), &channel())
            .await
            .unwrap_err();
        assert!(error.source().is_some());
    }
}

#[tokio::test]
async fn a_shaping_read_never_survives_revocation_into_the_write_unit() {
    struct NoReferences;
    impl ReferencePositions for NoReferences {
        fn autolink_spans(&self, _content: &MessageContent) -> Vec<Range<usize>> {
            Vec::new()
        }
    }

    let mut fixture = Fixture::new().await;
    let store = fixture.store().await;
    assert_eq!(store.may_post(&channel(), &user()).await.unwrap(), Ok(()));
    let command = SendMessage::prepare(
        SendMessageDraft {
            source_conversation: channel(),
            target_conversation: channel(),
            actor: SendActor::User(user()),
            content: MessageContent::parse("will be revoked").unwrap(),
            destination: SendDestination::MainLine,
            attachment_refs: Vec::new(),
            freshness_bypass: false,
        },
        &NoReferences,
        &store,
    )
    .await
    .unwrap();

    sqlx::query("DELETE FROM conversation_users WHERE conversation_id = ? AND user_id = ?")
        .bind(CHANNEL)
        .bind(USER)
        .execute(&mut fixture.db)
        .await
        .unwrap();
    assert!(store.send_message(command).await.is_err());
    let count: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM messages WHERE content = 'will be revoked'")
            .fetch_one(&mut fixture.db)
            .await
            .unwrap();
    assert_eq!(count, 0);
}
