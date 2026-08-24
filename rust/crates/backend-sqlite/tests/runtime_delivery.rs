use silverhand_backend_core::{
    identity::{AgentId, ConversationId, DaemonInstanceId},
    messaging::{MessageContent, ReferencePositions},
    runtime_credential::{ClaimRuntimeCustody, RuntimeCustodyPort, RuntimeEventTime, RuntimeScope},
    runtime_delivery::{
        ClaimPendingInbox, DeliveryLeaseOwner, InboxSettlementDisposition,
        RuntimeDeliveryFailureReason, RuntimeDispatchReadPort, RuntimeInboxCustodyPort,
    },
    runtime_event::{
        CommitRuntimeConsumed, CommitRuntimeExit, DaemonEventDurablePort, RuntimeActivityFact,
        RuntimeActivityKind, RuntimeActivityPayload, RuntimeExitDisposition, RuntimeObservedStatus,
    },
};
use silverhand_backend_sqlite::{
    runtime_credential::SqliteRuntimeCustodyStore, runtime_delivery::SqliteRuntimeDeliveryStore,
};
use sqlx::{Connection, Row, SqliteConnection, sqlite::SqliteConnectOptions};
use std::ops::Range;
use tempfile::TempDir;

#[path = "support/current_schema_snapshot.rs"]
mod current_schema;

const AGENT: &str = "agent-delivery";
const CONVERSATION: &str = "conversation0001";

struct NoReferences;

impl ReferencePositions for NoReferences {
    fn autolink_spans(&self, _content: &MessageContent) -> Vec<Range<usize>> {
        Vec::new()
    }
}

struct FixtureReferences;

impl ReferencePositions for FixtureReferences {
    fn autolink_spans(&self, content: &MessageContent) -> Vec<Range<usize>> {
        let body = content.as_str();
        let mut spans = Vec::new();
        let mut offset = 0;
        while let Some(start) = body[offset..].find("<silverhand://") {
            let start = offset + start;
            let Some(end) = body[start..].find('>') else {
                break;
            };
            spans.push(start..start + end + 1);
            offset = start + end + 1;
        }
        spans
    }
}

struct Fixture {
    _directory: TempDir,
    path: std::path::PathBuf,
    custody: SqliteRuntimeCustodyStore,
    delivery: SqliteRuntimeDeliveryStore,
}

async fn fixture() -> Fixture {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("runtime-delivery.sqlite");
    let mut connection = current_schema::create_current_schema(&path).await;
    seed(&mut connection).await;
    connection.close().await.unwrap();
    Fixture {
        _directory: directory,
        path: path.clone(),
        custody: SqliteRuntimeCustodyStore::open(&path).await.unwrap(),
        delivery: SqliteRuntimeDeliveryStore::open(&path).await.unwrap(),
    }
}

async fn seed(connection: &mut SqliteConnection) {
    sqlx::query(
        "INSERT INTO users (id, name, display_name, created_at, updated_at)
         VALUES ('user-1', 'user-1', 'User One', 1, 1)",
    )
    .execute(&mut *connection)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO hosts (id, name, kind, created_at, user_id)
         VALUES ('host-1', 'host-1', 'remote', 1, 'user-1')",
    )
    .execute(&mut *connection)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO agents (
            id, name, runtime, host_id, created_at, updated_at,
            display_name, created_by_user_id, session_scope
         ) VALUES (?, 'agent-delivery', 'codex', 'host-1', 1, 1,
             'Delivery Agent', 'user-1', 'conversation')",
    )
    .bind(AGENT)
    .execute(&mut *connection)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO workspaces (
            id, name, name_key, created_at, updated_at, owner_user_id
         ) VALUES ('workspace-1', 'Workspace One', 'workspace one', 1, 1, 'user-1')",
    )
    .execute(&mut *connection)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO workspace_members (workspace_id, agent_id, joined_at)
         VALUES ('workspace-1', ?, 1)",
    )
    .bind(AGENT)
    .execute(&mut *connection)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO conversations (
            id, workspace_id, placement_kind, roster_policy, title, title_key,
            status, created_at, updated_at
         ) VALUES (?, 'workspace-1', 'workspace', 'open', 'Conversation One',
             'conversation one', 'active', 1, 1)",
    )
    .bind(CONVERSATION)
    .execute(&mut *connection)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO conversation_agents (conversation_id, agent_id, joined_at)
         VALUES (?, ?, 1)",
    )
    .bind(CONVERSATION)
    .bind(AGENT)
    .execute(&mut *connection)
    .await
    .unwrap();
    add_message(connection, "message-1", 1).await;
    add_message(connection, "message-2", 2).await;
    add_message(connection, "message-3", 3).await;
}

async fn add_message(connection: &mut SqliteConnection, id: &str, seq: i64) {
    sqlx::query(
        "INSERT INTO messages (
            id, conversation_id, from_kind, from_user_id, content, seq, created_at
         ) VALUES (?, ?, 'user', 'user-1', ?, ?, ?)",
    )
    .bind(id)
    .bind(CONVERSATION)
    .bind(format!("content-{seq}"))
    .bind(seq)
    .bind(seq)
    .execute(&mut *connection)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO conversation_inboxes (
            conversation_id, agent_id, message_id, created_at, delivery_kind
         ) VALUES (?, ?, ?, ?, 'turn')",
    )
    .bind(CONVERSATION)
    .bind(AGENT)
    .bind(id)
    .bind(seq)
    .execute(&mut *connection)
    .await
    .unwrap();
}

fn scope() -> RuntimeScope {
    RuntimeScope::ConversationSlot {
        agent: AgentId::parse(AGENT).unwrap(),
        source: ConversationId::parse(CONVERSATION).unwrap(),
    }
}

async fn claim_runtime(
    fixture: &Fixture,
    daemon: &str,
) -> silverhand_backend_core::runtime_credential::RuntimePrincipal {
    fixture
        .custody
        .claim_or_current(ClaimRuntimeCustody::new(
            scope(),
            DaemonInstanceId::parse(daemon).unwrap(),
            RuntimeEventTime::from_unix_millis(10),
        ))
        .await
        .unwrap()
        .unwrap()
        .into_principal()
}

fn owner(raw: &str) -> DeliveryLeaseOwner {
    DeliveryLeaseOwner::parse(raw).unwrap()
}

async fn open(path: &std::path::Path) -> SqliteConnection {
    SqliteConnection::connect_with(
        &SqliteConnectOptions::new()
            .filename(path)
            .foreign_keys(true),
    )
    .await
    .unwrap()
}

#[tokio::test]
async fn target_projection_and_claim_are_bound_to_live_custody() {
    let fixture = fixture().await;
    let principal = claim_runtime(&fixture, "daemon-1").await;
    let target = fixture
        .delivery
        .resolve_dispatch_target(
            ConversationId::parse(CONVERSATION).unwrap(),
            AgentId::parse(AGENT).unwrap(),
        )
        .await
        .unwrap()
        .unwrap();
    assert_eq!(target.host_id, "host-1");
    assert_eq!(target.plan.scope, scope());
    assert_eq!(
        target.plan.workspace.as_ref().unwrap().name(),
        "Workspace One"
    );

    let first = fixture
        .delivery
        .claim_pending(
            "host-1".into(),
            principal.clone(),
            ConversationId::parse(CONVERSATION).unwrap(),
            owner("owner-1"),
            100,
            50,
            &NoReferences,
        )
        .await
        .unwrap();
    let ClaimPendingInbox::Claimed(first) = first else {
        panic!("current custody must claim pending rows")
    };
    assert_eq!(first.deliveries().len(), 3);

    assert_eq!(
        fixture
            .delivery
            .claim_pending(
                "host-1".into(),
                principal,
                ConversationId::parse(CONVERSATION).unwrap(),
                owner("owner-2"),
                101,
                50,
                &NoReferences,
            )
            .await
            .unwrap(),
        ClaimPendingInbox::Empty
    );
}

#[tokio::test]
async fn direct_pair_and_thread_coordinates_are_projected_from_persisted_placement() {
    let fixture = fixture().await;
    let mut db = open(&fixture.path).await;
    sqlx::query("DELETE FROM conversation_inboxes WHERE conversation_id = ?")
        .bind(CONVERSATION)
        .execute(&mut db)
        .await
        .unwrap();
    sqlx::query("DELETE FROM messages WHERE conversation_id = ?")
        .bind(CONVERSATION)
        .execute(&mut db)
        .await
        .unwrap();
    sqlx::query("DELETE FROM conversation_agents WHERE conversation_id = ?")
        .bind(CONVERSATION)
        .execute(&mut db)
        .await
        .unwrap();
    sqlx::query("DELETE FROM agent_runtime_slots WHERE conversation_id = ?")
        .bind(CONVERSATION)
        .execute(&mut db)
        .await
        .unwrap();
    sqlx::query("DELETE FROM conversations WHERE id = ?")
        .bind(CONVERSATION)
        .execute(&mut db)
        .await
        .unwrap();
    sqlx::query(
        "INSERT INTO conversations (
            id, workspace_id, placement_kind, roster_policy, title, title_key,
            status, created_at, updated_at, endpoint_a_kind, endpoint_a_id,
            endpoint_b_kind, endpoint_b_id
         ) VALUES (?, NULL, 'direct_pair', 'fixed', 'Direct Pair', NULL,
             'active', 1, 1, 'agent', ?, 'human', 'user-1')",
    )
    .bind(CONVERSATION)
    .bind(AGENT)
    .execute(&mut db)
    .await
    .unwrap();
    add_message(&mut db, "message-1", 1).await;
    add_message(&mut db, "message-2", 2).await;
    add_message(&mut db, "message-3", 3).await;
    sqlx::query(
        "INSERT INTO messages (
            id, conversation_id, from_kind, content, seq, created_at
         ) VALUES ('rootmessage00001', ?, 'system', 'root', 0, 0)",
    )
    .bind(CONVERSATION)
    .execute(&mut db)
    .await
    .unwrap();
    sqlx::query("UPDATE messages SET thread_root_id = 'rootmessage00001' WHERE id = 'message-2'")
        .execute(&mut db)
        .await
        .unwrap();
    sqlx::query(
        "UPDATE messages
            SET from_kind = 'agent', from_user_id = NULL, from_agent_id = ?,
                content = '<silverhand://agent/agent-delivery> review'
          WHERE id = 'message-2'",
    )
    .bind(AGENT)
    .execute(&mut db)
    .await
    .unwrap();
    sqlx::query("UPDATE messages SET from_user_id = NULL WHERE id = 'message-1'")
        .execute(&mut db)
        .await
        .unwrap();
    sqlx::query(
        "UPDATE messages
            SET from_kind = 'system', from_user_id = NULL, from_agent_id = NULL
          WHERE id = 'message-3'",
    )
    .execute(&mut db)
    .await
    .unwrap();
    db.close().await.unwrap();

    let principal = claim_runtime(&fixture, "daemon-1").await;
    let batch = fixture
        .delivery
        .claim_pending(
            "host-1".into(),
            principal,
            ConversationId::parse(CONVERSATION).unwrap(),
            owner("owner-direct"),
            100,
            50,
            &FixtureReferences,
        )
        .await
        .unwrap();
    let ClaimPendingInbox::Claimed(batch) = batch else {
        panic!("direct-pair inbox rows must be claimable")
    };
    assert!(
        batch.deliveries()[0]
            .presentation()
            .contains("target=dm:@user-1 ")
    );
    assert!(
        batch.deliveries()[0]
            .presentation()
            .contains("sender=@user-1 type=human")
    );
    assert!(
        batch.deliveries()[1]
            .presentation()
            .contains("target=dm:@user-1/thread:rootmessage00001 ")
    );
    assert!(
        batch.deliveries()[1]
            .presentation()
            .contains("sender=@agent-delivery type=agent computer=host-1")
    );
    assert_eq!(
        batch.deliveries()[1].instruction(),
        silverhand_backend_core::runtime_delivery::DeliveryInstruction::NonSystemMention
    );
    assert!(
        batch.deliveries()[2]
            .presentation()
            .contains("sender=system type=system")
    );
}

#[tokio::test]
async fn legacy_human_sender_fallback_requires_exactly_one_live_workspace_viewer() {
    let fixture = fixture().await;
    let mut db = open(&fixture.path).await;
    sqlx::query(
        "INSERT INTO users (id, name, display_name, created_at, updated_at)
         VALUES ('user-2', 'user-2', 'User Two', 2, 2)",
    )
    .execute(&mut db)
    .await
    .unwrap();
    for user in ["user-1", "user-2"] {
        sqlx::query(
            "INSERT INTO workspace_users (workspace_id, user_id, joined_at)
             VALUES ('workspace-1', ?, 1)",
        )
        .bind(user)
        .execute(&mut db)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO conversation_users (conversation_id, user_id, joined_at)
             VALUES (?, ?, 1)",
        )
        .bind(CONVERSATION)
        .bind(user)
        .execute(&mut db)
        .await
        .unwrap();
    }
    sqlx::query("UPDATE messages SET from_user_id = NULL WHERE id = 'message-1'")
        .execute(&mut db)
        .await
        .unwrap();
    db.close().await.unwrap();

    let principal = claim_runtime(&fixture, "daemon-1").await;
    let conversation = ConversationId::parse(CONVERSATION).unwrap();
    let two_viewers = fixture
        .delivery
        .claim_pending(
            "host-1".into(),
            principal.clone(),
            conversation.clone(),
            owner("owner-two-viewers"),
            100,
            50,
            &NoReferences,
        )
        .await
        .unwrap();
    let ClaimPendingInbox::Claimed(two_viewers) = two_viewers else {
        panic!("pending rows must be claimed")
    };
    assert!(
        two_viewers.deliveries()[0]
            .presentation()
            .contains("sender=user type=human")
    );
    assert!(
        !two_viewers.deliveries()[0]
            .presentation()
            .contains("sender=@user-")
    );
    assert_eq!(
        fixture
            .delivery
            .release_owner(owner("owner-two-viewers"))
            .await
            .unwrap(),
        3
    );

    let mut db = open(&fixture.path).await;
    sqlx::query(
        "DELETE FROM workspace_users
          WHERE workspace_id = 'workspace-1' AND user_id = 'user-2'",
    )
    .execute(&mut db)
    .await
    .unwrap();
    db.close().await.unwrap();

    let one_viewer = fixture
        .delivery
        .claim_pending(
            "host-1".into(),
            principal,
            conversation,
            owner("owner-one-viewer"),
            101,
            50,
            &NoReferences,
        )
        .await
        .unwrap();
    let ClaimPendingInbox::Claimed(one_viewer) = one_viewer else {
        panic!("released rows must be claimable again")
    };
    assert!(
        one_viewer.deliveries()[0]
            .presentation()
            .contains("sender=@user-1 type=human")
    );
}

#[tokio::test]
async fn lease_expiry_disconnect_and_settlement_are_owner_scoped() {
    let fixture = fixture().await;
    let principal = claim_runtime(&fixture, "daemon-1").await;
    let conversation = ConversationId::parse(CONVERSATION).unwrap();
    let first = fixture
        .delivery
        .claim_pending(
            "host-1".into(),
            principal.clone(),
            conversation.clone(),
            owner("owner-1"),
            100,
            50,
            &NoReferences,
        )
        .await
        .unwrap();
    let ClaimPendingInbox::Claimed(first) = first else {
        panic!("first owner must claim")
    };
    let second = fixture
        .delivery
        .claim_pending(
            "host-1".into(),
            principal.clone(),
            conversation.clone(),
            owner("owner-2"),
            151,
            50,
            &NoReferences,
        )
        .await
        .unwrap();
    let ClaimPendingInbox::Claimed(second) = second else {
        panic!("expired lease must be reclaimed")
    };
    assert_eq!(second.delivery_ids(), first.delivery_ids());
    assert_eq!(
        fixture
            .delivery
            .settle_consumed(
                "host-1".into(),
                principal.clone(),
                conversation.clone(),
                owner("owner-1"),
                first.delivery_ids(),
                160,
            )
            .await
            .unwrap(),
        InboxSettlementDisposition::Stale
    );
    assert_eq!(
        fixture
            .delivery
            .settle_consumed(
                "host-1".into(),
                principal.clone(),
                conversation.clone(),
                owner("owner-2"),
                second.delivery_ids(),
                161,
            )
            .await
            .unwrap(),
        InboxSettlementDisposition::Applied
    );
    assert_eq!(
        fixture
            .delivery
            .settle_consumed(
                "host-1".into(),
                principal,
                conversation,
                owner("owner-2"),
                second.delivery_ids(),
                162,
            )
            .await
            .unwrap(),
        InboxSettlementDisposition::Duplicate
    );
}

#[tokio::test]
async fn retriable_and_terminal_failures_have_distinct_durable_outcomes() {
    let fixture = fixture().await;
    let principal = claim_runtime(&fixture, "daemon-1").await;
    let conversation = ConversationId::parse(CONVERSATION).unwrap();
    let batch = fixture
        .delivery
        .claim_pending(
            "host-1".into(),
            principal.clone(),
            conversation.clone(),
            owner("owner-1"),
            100,
            50,
            &NoReferences,
        )
        .await
        .unwrap();
    let ClaimPendingInbox::Claimed(batch) = batch else {
        panic!("pending rows must be claimed")
    };
    assert_eq!(
        fixture
            .delivery
            .settle_failed(
                "host-1".into(),
                principal.clone(),
                conversation.clone(),
                owner("owner-1"),
                batch.delivery_ids(),
                RuntimeDeliveryFailureReason::ChildExit,
                110,
            )
            .await
            .unwrap(),
        InboxSettlementDisposition::Applied
    );
    let retry = fixture
        .delivery
        .claim_pending(
            "host-1".into(),
            principal.clone(),
            conversation.clone(),
            owner("owner-2"),
            111,
            50,
            &NoReferences,
        )
        .await
        .unwrap();
    let ClaimPendingInbox::Claimed(retry) = retry else {
        panic!("retriable failure must return rows to pending")
    };
    fixture
        .delivery
        .settle_failed(
            "host-1".into(),
            principal,
            conversation,
            owner("owner-2"),
            retry.delivery_ids(),
            RuntimeDeliveryFailureReason::DriverRefused,
            112,
        )
        .await
        .unwrap();
    let mut connection = open(&fixture.path).await;
    let row = sqlx::query(
        "SELECT COUNT(*) AS total, COUNT(failed_at) AS failed,
                COUNT(in_flight_owner) AS leased
           FROM conversation_inboxes",
    )
    .fetch_one(&mut connection)
    .await
    .unwrap();
    assert_eq!(row.get::<i64, _>("total"), 3);
    assert_eq!(row.get::<i64, _>("failed"), 3);
    assert_eq!(row.get::<i64, _>("leased"), 0);
}

#[tokio::test]
async fn successor_custody_rejects_stale_settlement_and_disconnect_releases_exact_owner() {
    let fixture = fixture().await;
    let stale = claim_runtime(&fixture, "daemon-1").await;
    let conversation = ConversationId::parse(CONVERSATION).unwrap();
    let batch = fixture
        .delivery
        .claim_pending(
            "host-1".into(),
            stale.clone(),
            conversation.clone(),
            owner("owner-1"),
            100,
            50,
            &NoReferences,
        )
        .await
        .unwrap();
    let ClaimPendingInbox::Claimed(batch) = batch else {
        panic!("pending rows must be claimed")
    };
    let successor = claim_runtime(&fixture, "daemon-2").await;
    assert_ne!(stale, successor);
    assert_eq!(
        fixture
            .delivery
            .settle_consumed(
                "host-1".into(),
                stale,
                conversation,
                owner("owner-1"),
                batch.delivery_ids(),
                110,
            )
            .await
            .unwrap(),
        InboxSettlementDisposition::Stale
    );
    assert_eq!(
        fixture
            .delivery
            .release_owner(owner("owner-1"))
            .await
            .unwrap(),
        3
    );
}

#[tokio::test]
async fn consumed_settlement_and_non_replayable_activity_are_one_root_transaction() {
    let fixture = fixture().await;
    let principal = claim_runtime(&fixture, "daemon-1").await;
    let conversation = ConversationId::parse(CONVERSATION).unwrap();
    let lease_owner = owner("owner-combined-consumed");
    let ClaimPendingInbox::Claimed(batch) = fixture
        .delivery
        .claim_pending(
            "host-1".into(),
            principal.clone(),
            conversation.clone(),
            lease_owner.clone(),
            100,
            1_000,
            &NoReferences,
        )
        .await
        .unwrap()
    else {
        panic!("pending rows must be claimed")
    };
    let input = CommitRuntimeConsumed::new(
        "host-1".into(),
        principal.clone(),
        conversation.clone(),
        lease_owner.clone(),
        batch.delivery_ids(),
        RuntimeEventTime::from_unix_millis(200),
        RuntimeEventTime::from_unix_millis(201),
    );

    let mut db = open(&fixture.path).await;
    sqlx::raw_sql(
        "CREATE TRIGGER fail_message_received_activity
         BEFORE INSERT ON conversation_events
         WHEN NEW.kind = 'message_received'
         BEGIN SELECT RAISE(ABORT, 'activity-failure'); END;",
    )
    .execute(&mut db)
    .await
    .unwrap();
    assert!(
        fixture
            .delivery
            .commit_consumed(input.clone())
            .await
            .is_err()
    );
    let row = sqlx::query(
        "SELECT
             (SELECT COUNT(delivered_at) FROM conversation_inboxes) AS delivered,
             (SELECT COUNT(in_flight_owner) FROM conversation_inboxes) AS leased,
             (SELECT last_activity_at FROM agents WHERE id = ?) AS last_activity",
    )
    .bind(AGENT)
    .fetch_one(&mut db)
    .await
    .unwrap();
    assert_eq!(row.get::<i64, _>("delivered"), 0);
    assert_eq!(row.get::<i64, _>("leased"), 3);
    assert!(row.get::<Option<i64>, _>("last_activity").is_none());
    sqlx::raw_sql("DROP TRIGGER fail_message_received_activity;")
        .execute(&mut db)
        .await
        .unwrap();

    let applied = fixture
        .delivery
        .commit_consumed(input.clone())
        .await
        .unwrap();
    assert_eq!(applied.disposition(), InboxSettlementDisposition::Applied);
    assert!(applied.activity_id().is_some());
    let duplicate = fixture.delivery.commit_consumed(input).await.unwrap();
    assert_eq!(
        duplicate.disposition(),
        InboxSettlementDisposition::Duplicate
    );
    assert!(duplicate.activity_id().is_none());

    let row = sqlx::query(
        "SELECT
             (SELECT COUNT(*) FROM conversation_inboxes WHERE delivered_at = 200) AS delivered,
             (SELECT COUNT(*) FROM conversation_events WHERE kind = 'message_received') AS activities,
             (SELECT last_activity_at FROM agents WHERE id = ?) AS last_activity",
    )
    .bind(AGENT)
    .fetch_one(&mut db)
    .await
    .unwrap();
    assert_eq!(row.get::<i64, _>("delivered"), 3);
    assert_eq!(row.get::<i64, _>("activities"), 1);
    assert_eq!(row.get::<i64, _>("last_activity"), 201);
}

#[tokio::test]
async fn exit_finalization_status_activity_and_lease_cleanup_are_one_root_transaction() {
    let fixture = fixture().await;
    let principal = claim_runtime(&fixture, "daemon-exit").await;
    let conversation = ConversationId::parse(CONVERSATION).unwrap();
    let lease_owner = owner("owner-exit");
    let ClaimPendingInbox::Claimed(_) = fixture
        .delivery
        .claim_pending(
            "host-1".into(),
            principal.clone(),
            conversation.clone(),
            lease_owner.clone(),
            100,
            1_000,
            &NoReferences,
        )
        .await
        .unwrap()
    else {
        panic!("pending rows must be claimed")
    };
    let pending = RuntimeActivityFact::new(
        conversation,
        AgentId::parse(AGENT).unwrap(),
        RuntimeActivityKind::Text,
        RuntimeActivityPayload::Text {
            text: "last fragment".into(),
        },
        RuntimeEventTime::from_unix_millis(300),
    );
    let input = CommitRuntimeExit::new(
        principal.clone(),
        RuntimeObservedStatus::Crashed,
        RuntimeEventTime::from_unix_millis(300),
        Some(pending),
    );
    let mut db = open(&fixture.path).await;
    sqlx::raw_sql(
        "CREATE TRIGGER fail_runtime_finalize_event
         BEFORE INSERT ON agent_runtime_events
         WHEN NEW.event_kind = 'generation_finalized'
         BEGIN SELECT RAISE(ABORT, 'finalize-failure'); END;",
    )
    .execute(&mut db)
    .await
    .unwrap();
    assert!(fixture.delivery.commit_exit(input.clone()).await.is_err());
    let row = sqlx::query(
        "SELECT
             (SELECT claimed_by_daemon_instance_id FROM agent_runtime_slots
               WHERE conversation_id = ? AND agent_id = ?) AS daemon,
             (SELECT COUNT(in_flight_owner) FROM conversation_inboxes) AS leased,
             (SELECT COUNT(*) FROM conversation_events WHERE kind = 'text') AS activities",
    )
    .bind(CONVERSATION)
    .bind(AGENT)
    .fetch_one(&mut db)
    .await
    .unwrap();
    assert_eq!(row.get::<String, _>("daemon"), "daemon-exit");
    assert_eq!(row.get::<i64, _>("leased"), 3);
    assert_eq!(row.get::<i64, _>("activities"), 0);
    sqlx::raw_sql("DROP TRIGGER fail_runtime_finalize_event;")
        .execute(&mut db)
        .await
        .unwrap();

    let applied = fixture.delivery.commit_exit(input.clone()).await.unwrap();
    assert_eq!(applied.disposition(), RuntimeExitDisposition::Applied);
    assert!(applied.activity_id().is_some());
    let stale = fixture.delivery.commit_exit(input).await.unwrap();
    assert_eq!(stale.disposition(), RuntimeExitDisposition::Stale);
    let row = sqlx::query(
        "SELECT
             (SELECT claimed_by_daemon_instance_id FROM agent_runtime_slots
               WHERE conversation_id = ? AND agent_id = ?) AS daemon,
             (SELECT observed_status FROM agent_runtime_slots
               WHERE conversation_id = ? AND agent_id = ?) AS status,
             (SELECT COUNT(in_flight_owner) FROM conversation_inboxes) AS leased,
             (SELECT COUNT(*) FROM conversation_events WHERE kind = 'text') AS activities,
             (SELECT COUNT(*) FROM agent_runtime_events
               WHERE event_kind = 'generation_finalized') AS finalized",
    )
    .bind(CONVERSATION)
    .bind(AGENT)
    .bind(CONVERSATION)
    .bind(AGENT)
    .fetch_one(&mut db)
    .await
    .unwrap();
    assert!(
        row.try_get::<Option<String>, _>("daemon")
            .unwrap()
            .is_none()
    );
    assert_eq!(row.get::<String, _>("status"), "crashed");
    assert_eq!(row.get::<i64, _>("leased"), 0);
    assert_eq!(row.get::<i64, _>("activities"), 1);
    assert_eq!(row.get::<i64, _>("finalized"), 1);
}

#[tokio::test]
async fn presence_audience_is_emitted_only_on_deterministic_away_to_online_edges() {
    let fixture = fixture().await;
    let principal = claim_runtime(&fixture, "daemon-presence").await;
    let fact = |created_at| {
        RuntimeActivityFact::new(
            ConversationId::parse(CONVERSATION).unwrap(),
            AgentId::parse(AGENT).unwrap(),
            RuntimeActivityKind::Text,
            RuntimeActivityPayload::Text {
                text: format!("presence-{created_at}"),
            },
            RuntimeEventTime::from_unix_millis(created_at),
        )
    };

    let first = fixture
        .delivery
        .record_activity(
            principal.clone(),
            fact(1_000),
            RuntimeEventTime::from_unix_millis(1_000),
        )
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        first
            .presence_viewers()
            .iter()
            .map(|viewer| viewer.as_str())
            .collect::<Vec<_>>(),
        ["user-1"]
    );

    let continuous = fixture
        .delivery
        .record_activity(
            principal.clone(),
            fact(2_000),
            RuntimeEventTime::from_unix_millis(2_000),
        )
        .await
        .unwrap()
        .unwrap();
    assert!(continuous.presence_viewers().is_empty());

    let recovered_at = 2_000 + 30 * 60_000;
    let recovered = fixture
        .delivery
        .record_activity(
            principal,
            fact(recovered_at),
            RuntimeEventTime::from_unix_millis(recovered_at),
        )
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        recovered
            .presence_viewers()
            .iter()
            .map(|viewer| viewer.as_str())
            .collect::<Vec<_>>(),
        ["user-1"]
    );
}
