//! Adapter tests: the source-bound snapshot resolves participation membership,
//! per-conversation redaction (both the workspace-roster and direct-pair arms),
//! the archived/closed split, per-scope queue depth, and seat redaction — all off
//! one `BEGIN DEFERRED` read composed from the SHARED ACL and participation macros.

use sqlx::{Connection, Executor};

use silverhand_backend_core::{
    foundation::identity::{AgentId, ConversationId, UserId},
    host_runtime::agent_runtime_state_read::{
        AgentRuntimeStateReadModel, AgentRuntimeStateView, PresentationFocus, RuntimeFocusView,
        RuntimeSeatScopeView,
    },
    host_runtime::runtime_credential::RuntimeGeneration,
    host_runtime::runtime_event::RuntimeObservedStatus,
};

use super::SqliteAgentRuntimeStateColdRead;

const DATABASE_FILE: &str = "agent-runtime-state.sqlite";

/// One fixture exercising every readability arm and scope.
///
/// * `a-agentscope` (session_scope `agent`) participates in four workspace channels
///   and one direct pair, and holds ONE agent-scope seat.
/// * `a-convscope` (session_scope `conversation`) holds two conversation-scope seats,
///   one the viewer may read and one it may not.
///
/// Readability is seeded so each arm holds a conversation the other cannot reach:
/// `u-member` reads `c-ws`/`c-arch`/`c-closed` through the workspace arm (a
/// `workspace_users` AND `conversation_users` row), `u-dp` reads `c-dp` through the
/// direct-pair endpoint, and `c-hidden` (workspace `w2`, which `u-member` is not in)
/// is readable by neither.
const SEED: &str = "\
INSERT INTO users (id, name, display_name, created_at, updated_at) VALUES \
  ('u-creator','u-creator','Creator',1,1), \
  ('u-member','u-member','Member',1,1), \
  ('u-dp','u-dp','DirectPair',1,1), \
  ('u-outsider','u-outsider','Outsider',1,1); \
INSERT INTO hosts (id, name, kind, created_at, user_id, provisioning_source) VALUES \
  ('h1','h1','local',1,'u-creator','app_install'); \
INSERT INTO agents (id, name, display_name, runtime, host_id, created_at, updated_at, \
    created_by_user_id, materialization_status, session_scope) VALUES \
  ('a-agentscope','a-agentscope','AgentScope','claude','h1',1,1,'u-creator','active','agent'), \
  ('a-convscope','a-convscope','ConvScope','claude','h1',1,1,'u-creator','active','conversation'); \
INSERT INTO workspaces (id, name, name_key, created_at, updated_at) VALUES \
  ('w1','W1','w1',1,1), \
  ('w2','W2','w2',1,1); \
INSERT INTO workspace_users (workspace_id, user_id, joined_at) VALUES \
  ('w1','u-member',1), \
  ('w1','u-creator',1), \
  ('w2','u-outsider',1); \
INSERT INTO workspace_members (workspace_id, agent_id, joined_at) VALUES \
  ('w1','a-agentscope',1), \
  ('w2','a-agentscope',1), \
  ('w1','a-convscope',1); \
INSERT INTO conversations (id, workspace_id, placement_kind, roster_policy, title, title_key, status, \
    created_at, updated_at, closed_at, archived_at) VALUES \
  ('c-ws','w1','workspace','open','General','general','active',1,300,NULL,NULL), \
  ('c-arch','w1','workspace','open','Archived','archived-ch','active',1,200,NULL,50), \
  ('c-closed','w1','workspace','open','Closed','closed-ch','active',1,400,100,NULL), \
  ('c-hidden','w2','workspace','open','Hidden','hidden-ch','active',1,350,NULL,NULL), \
  ('c-cv1','w1','workspace','open','Conv One','conv-one','active',1,110,NULL,NULL), \
  ('c-cv2','w1','workspace','open','Conv Two','conv-two','active',1,120,NULL,NULL); \
INSERT INTO conversations (id, workspace_id, endpoint_a_kind, endpoint_a_id, endpoint_b_kind, \
    endpoint_b_id, placement_kind, roster_policy, title, status, visibility, created_at, updated_at) \
  VALUES \
  ('c-dp',NULL,'agent','a-agentscope','human','u-dp','direct_pair','fixed','','active','private',1,500); \
INSERT INTO conversation_agents (conversation_id, agent_id, joined_at) VALUES \
  ('c-ws','a-agentscope',1), \
  ('c-arch','a-agentscope',1), \
  ('c-closed','a-agentscope',1), \
  ('c-hidden','a-agentscope',1), \
  ('c-cv1','a-convscope',1), \
  ('c-cv2','a-convscope',1); \
INSERT INTO conversation_users (conversation_id, user_id, joined_at) VALUES \
  ('c-ws','u-member',1), \
  ('c-arch','u-member',1), \
  ('c-closed','u-member',1), \
  ('c-cv1','u-member',1), \
  ('c-cv1','u-creator',1), \
  ('c-cv2','u-creator',1); \
INSERT INTO messages (id, conversation_id, from_kind, content, seq, created_at) VALUES \
  ('m1','c-ws','user','one',1,1), \
  ('m2','c-ws','user','two',2,1), \
  ('m3','c-arch','user','three',3,1), \
  ('m4','c-hidden','user','four',4,1), \
  ('m5','c-cv1','user','five',5,1), \
  ('m6','c-cv1','user','six',6,1), \
  ('m7','c-cv1','user','seven',7,1), \
  ('m8','c-cv2','user','eight',8,1); \
INSERT INTO conversation_inboxes (conversation_id, agent_id, message_id, delivered_at, failed_at, created_at) \
  VALUES \
  ('c-ws','a-agentscope','m1',NULL,NULL,1), \
  ('c-ws','a-agentscope','m2',NULL,NULL,1), \
  ('c-arch','a-agentscope','m3',10,NULL,1), \
  ('c-hidden','a-agentscope','m4',NULL,20,1), \
  ('c-cv1','a-convscope','m5',NULL,NULL,1), \
  ('c-cv1','a-convscope','m6',NULL,NULL,1), \
  ('c-cv1','a-convscope','m7',30,NULL,1), \
  ('c-cv2','a-convscope','m8',NULL,NULL,1); \
DELETE FROM agent_runtime_slots; \
INSERT INTO agent_runtime_slots (agent_id, conversation_id, generation, observed_status, \
    observed_pid, cli_session_id) VALUES \
  ('a-agentscope',NULL,5,'active',999,'cli-a'), \
  ('a-convscope','c-cv1',3,'idle',NULL,NULL), \
  ('a-convscope','c-cv2',4,'starting',NULL,NULL);";

async fn seeded() -> (tempfile::TempDir, SqliteAgentRuntimeStateColdRead) {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join(DATABASE_FILE);
    let mut db = crate::current_schema::create_current_schema(&path).await;
    db.execute(sqlx::raw_sql(SEED))
        .await
        .expect("seed must load against the current schema");
    db.close().await.unwrap();
    let cold_read = SqliteAgentRuntimeStateColdRead::open(&path).await.unwrap();
    (directory, cold_read)
}

async fn state(
    cold: &SqliteAgentRuntimeStateColdRead,
    agent: &str,
    viewer: &str,
) -> AgentRuntimeStateView {
    cold.read_agent_runtime_state(
        &AgentId::parse(agent).unwrap(),
        &UserId::parse(viewer).unwrap(),
    )
    .await
    .expect("read must not fault")
    .expect("agent present")
    .project(PresentationFocus::None)
}

/// The participation list is redacted to what the viewer may read and ordered
/// open-first, then most-recently-updated. `u-member` reads the three `w1` channels
/// through the workspace arm; `c-hidden` (a `w2` channel it is not in) and `c-dp` (a
/// pair it is not an endpoint of) are dropped.
#[tokio::test]
async fn participations_are_redacted_and_ordered() {
    let (_dir, cold) = seeded().await;
    let view = state(&cold, "a-agentscope", "u-member").await;

    let ids: Vec<&str> = view
        .participations
        .iter()
        .map(|row| row.conversation.as_str())
        .collect();
    assert_eq!(ids, ["c-ws", "c-arch", "c-closed"]);
}

/// The visible list is the readable list minus ARCHIVED — not minus closed. `c-arch`
/// (archived) drops; `c-closed` (closed but not archived) stays, ordered after the
/// open channel.
#[tokio::test]
async fn visible_participations_drop_archived_not_closed() {
    let (_dir, cold) = seeded().await;
    let view = state(&cold, "a-agentscope", "u-member").await;

    let visible: Vec<&str> = view
        .visible_participations
        .iter()
        .map(|row| row.conversation.as_str())
        .collect();
    assert_eq!(visible, ["c-ws", "c-closed"]);
}

/// The workspace-arm redaction facts ride the row: `c-ws` carries its workspace id,
/// name, placement and title verbatim.
#[tokio::test]
async fn participation_echoes_carry_the_workspace_facts() {
    let (_dir, cold) = seeded().await;
    let view = state(&cold, "a-agentscope", "u-member").await;

    let row = view
        .participations
        .iter()
        .find(|row| row.conversation.as_str() == "c-ws")
        .expect("c-ws present");
    assert_eq!(row.workspace_id.as_deref(), Some("w1"));
    assert_eq!(row.workspace_name.as_deref(), Some("W1"));
    assert_eq!(row.placement_kind, "workspace");
    assert_eq!(row.channel_title, "General");
}

/// The direct-pair arm: `u-dp` reads its pair through the endpoint, and nothing else
/// — the workspace channels it is not in are dropped. Proves the redaction is the
/// human-participation authority's TWO arms, not a workspace-only shortcut.
#[tokio::test]
async fn the_direct_pair_arm_admits_only_its_endpoint() {
    let (_dir, cold) = seeded().await;
    let view = state(&cold, "a-agentscope", "u-dp").await;

    let ids: Vec<&str> = view
        .participations
        .iter()
        .map(|row| row.conversation.as_str())
        .collect();
    assert_eq!(ids, ["c-dp"]);
}

/// The agent-scope seat's queue depth is the agent-WIDE undelivered total across all
/// conversations — not per-conversation and not viewer-redacted. Two undelivered rows
/// count; a delivered row and a failed row (in a conversation the viewer cannot even
/// read) are both excluded.
#[tokio::test]
async fn the_agent_seat_queue_is_the_agent_wide_undelivered_total() {
    let (_dir, cold) = seeded().await;
    let view = state(&cold, "a-agentscope", "u-member").await;

    assert_eq!(view.seats.len(), 1);
    let seat = &view.seats[0];
    assert_eq!(seat.scope, RuntimeSeatScopeView::Agent);
    assert_eq!(seat.queue_depth, 2);
    assert_eq!(seat.generation, RuntimeGeneration::new(5).unwrap());
    assert_eq!(seat.status, RuntimeObservedStatus::Active);
    assert_eq!(seat.pid, Some(999));
    assert_eq!(seat.cli_session_id.as_deref(), Some("cli-a"));
    // No live focus supplied ⇒ null, never a fabricated conversation.
    assert_eq!(seat.focus, None);
}

/// A conversation seat the viewer cannot read is dropped WHOLE; a readable one
/// survives and carries its own conversation's undelivered count (two of three rows;
/// the delivered one excluded), focused on its own conversation. Proves per-conversation
/// queue scoping and seat redaction together.
#[tokio::test]
async fn conversation_seats_are_redacted_and_counted_per_conversation() {
    let (_dir, cold) = seeded().await;
    let view = state(&cold, "a-convscope", "u-member").await;

    assert_eq!(view.seats.len(), 1, "c-cv2 seat is redacted away");
    let seat = &view.seats[0];
    assert_eq!(
        seat.scope,
        RuntimeSeatScopeView::Conversation(ConversationId::parse("c-cv1").unwrap())
    );
    assert_eq!(seat.queue_depth, 2);
    assert_eq!(
        seat.focus,
        Some(RuntimeFocusView::Conversation(
            ConversationId::parse("c-cv1").unwrap()
        ))
    );
}

/// A viewer who reads BOTH conversation seats sees each counted against its OWN
/// conversation — `c-cv2`'s single undelivered row does not bleed into `c-cv1`'s two.
#[tokio::test]
async fn per_conversation_queue_counts_do_not_bleed() {
    let (_dir, cold) = seeded().await;
    let view = state(&cold, "a-convscope", "u-creator").await;

    let mut depths: Vec<(String, i64)> = view
        .seats
        .iter()
        .map(|seat| match &seat.scope {
            RuntimeSeatScopeView::Conversation(id) => (id.as_str().to_owned(), seat.queue_depth),
            RuntimeSeatScopeView::Agent => ("agent".to_owned(), seat.queue_depth),
        })
        .collect();
    depths.sort();
    assert_eq!(
        depths,
        vec![("c-cv1".to_owned(), 2), ("c-cv2".to_owned(), 1)]
    );
}

/// The bundle is SEALED to the id the agent ROW carries, decoded from the
/// `agents.id` column the ACL read now selects — not the request echo. This is the
/// witness the route's `facts.source()` guard needs: the seal coordinate is a stored
/// fact, so a query that ever resolved a different row than the one asked for would
/// surface a mismatched id here rather than silently projecting the wrong agent.
#[tokio::test]
async fn the_source_is_the_stored_row_coordinate() {
    let (_dir, cold) = seeded().await;
    let facts = cold
        .read_agent_runtime_state(
            &AgentId::parse("a-agentscope").unwrap(),
            &UserId::parse("u-member").unwrap(),
        )
        .await
        .unwrap()
        .expect("agent present");
    assert_eq!(facts.source(), &AgentId::parse("a-agentscope").unwrap());
}

/// The agent-scope generation the focus guard reads is the seat's stored generation.
#[tokio::test]
async fn the_agent_scope_generation_is_the_seat_generation() {
    let (_dir, cold) = seeded().await;
    let facts = cold
        .read_agent_runtime_state(
            &AgentId::parse("a-agentscope").unwrap(),
            &UserId::parse("u-member").unwrap(),
        )
        .await
        .unwrap()
        .expect("agent present");
    assert_eq!(
        facts.agent_scope_generation(),
        Some(RuntimeGeneration::new(5).unwrap())
    );
}

/// An absent agent is the ACL's absence arm — `None`, never a fault.
#[tokio::test]
async fn an_absent_agent_reads_none() {
    let (_dir, cold) = seeded().await;
    let facts = cold
        .read_agent_runtime_state(
            &AgentId::parse("a-missing").unwrap(),
            &UserId::parse("u-member").unwrap(),
        )
        .await
        .unwrap();
    assert!(facts.is_none());
}

/// The post-snapshot focus-readability probe reuses the SAME two-arm authority: the
/// workspace arm admits `u-member` on `c-ws`, the direct-pair arm admits `u-dp` on
/// `c-dp`, and a non-member is refused.
#[tokio::test]
async fn conversation_visibility_reuses_both_arms() {
    let (_dir, cold) = seeded().await;

    let readable = |viewer: &'static str, conversation: &'static str| {
        let cold = cold.clone();
        async move {
            cold.read_conversation_visibility(
                &UserId::parse(viewer).unwrap(),
                &ConversationId::parse(conversation).unwrap(),
            )
            .await
            .unwrap()
        }
    };

    assert!(readable("u-member", "c-ws").await, "workspace arm");
    assert!(readable("u-dp", "c-dp").await, "direct-pair arm");
    assert!(!readable("u-outsider", "c-ws").await, "non-member refused");
    assert!(
        !readable("u-member", "c-hidden").await,
        "workspace non-member refused"
    );
}
