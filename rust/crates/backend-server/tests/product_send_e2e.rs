//! The product send path, end to end over a real store.
//!
//! What only a real transaction can answer: which fields a just-inserted message has, what each
//! door answers when a body's references reach nobody, that the reply projections come from the
//! cluster the reply actually joined, and that an operator is told once. The write unit here is
//! the real `MessagingStore`; only the gates a composition owns are fakes, because they are
//! implementation points rather than the subject.
//!
//! TWO SUCCESS CONTRACTS, ONE OUTCOME. A person's send is answered `201` with the
//! acknowledgement; a runtime's is answered `200` with the flat coordinate report its own schema
//! publishes. Both project from one `SendMessageOutcome` and share one projector for the
//! sender-only member — so the cells below pin each door's status and top-level key set
//! separately, and pin that the shared member is spelled identically on both.
//!
//! IT DOES NOT OBSERVE PUBLICATION. The router runs no post-commit announcer, so nothing here
//! may claim the published frame and a success payload were produced by one request. That
//! boundary is a type fact, proven by the compile gates beside `SendMessageOutcome`.

// The checked-in schema's fail-closed materializer, reused as test-only source rather than
// copied: it is the one authority for what a current database looks like, and a second copy
// would start answering questions the real schema refuses. Private to this test.
#[path = "../../backend-sqlite/tests/support/current_schema_snapshot.rs"]
mod current_schema;

// The shared log-capture harness, so "what an operator saw" is read the same way here as in
// the send-door suite.
#[path = "support/log_capture.rs"]
mod log_capture;

use std::{
    path::Path,
    sync::{Arc, Mutex, OnceLock},
};

use axum::{
    Router,
    body::Body,
    http::{Request, StatusCode},
};
use serde_json::Value;
use silverhand_backend_core::messaging::{
    ActiveAuthor, AddressedPrincipals, AgentId, ConversationId, DirectLineAuthority, MessageAuthor,
    PrincipalKind, SendMessage, SendMessageError, SendMessageOutcome, SendMessageUnitOfWork,
    ThreadRootId, UserId,
};
use silverhand_backend_core::persistence::PersistenceFailure;
use silverhand_backend_server::messaging::{
    adapters::{
        AddressRefusal, AgentCredential, CapabilityDenied, ChannelAccess, ChannelAccessRefusal,
        ResolvedStream, SendCapability, TargetAddress,
    },
    router::{HumanPrincipal, SendState, send_router},
};
use silverhand_backend_sqlite::messaging::MessagingStore;
use sqlx::SqliteConnection;
use tempfile::tempdir;
use tower::ServiceExt;

const HOST_ID: &str = "host-1";
const USER_ID: &str = "user-1";
const AGENT_ID: &str = "agent-1";
const WORKSPACE_ID: &str = "workspace-1";
const CHANNEL_ID: &str = "channel-1";
/// An agent of the workspace with NO roster row for the target conversation, so its reachability
/// turns entirely on whether a mention could be copied to it.
const OUTSIDE_AGENT_ID: &str = "agent-2";
/// An attachment of the target channel, so a send may reference it.
const ATTACHMENT_ID: &str = "att-1";
// There is deliberately NO user sharing an agent's name, and that is what makes the cell below
// mean something: the schema refuses such a row ("users.name collides with an existing agent
// name"), so a `human` token spelled like an agent names nobody — and must still be reported even
// when the agent token of the same spelling was copied successfully.

/// The smallest world these cells need: one host, one person, one agent, and ONE conversation
/// that both hold a roster row for — the same conversation the address resolves to, so a
/// participation answer here is about that row and nothing else.
///
/// Deliberately local and deliberately minimal. The larger fixture another test file builds is
/// that file's SCENARIO, not a canonical roster the product defines — sharing it would make this
/// test depend on principals it never names, and let a change to those cells alter the world
/// this one starts from. Both files answer to the checked-in schema, which is the only authority
/// here; a schema change breaks each of them on its own terms.
async fn seed_minimal_scenario(db: &mut SqliteConnection) {
    let statements: [(&str, Vec<&str>); 10] = [
        (
            "INSERT INTO hosts (id, name, kind, created_at) VALUES (?, 'host', 'local', 0)",
            vec![HOST_ID],
        ),
        (
            "INSERT INTO users (id, name, display_name, created_at, updated_at) \
             VALUES (?, 'human', 'Human', 0, 0)",
            vec![USER_ID],
        ),
        (
            "INSERT INTO agents (id, name, runtime, host_id, created_at, updated_at, \
             display_name, created_by_user_id) \
             VALUES (?, 'lio', 'claude', ?, 0, 0, 'Lio', ?)",
            vec![AGENT_ID, HOST_ID, USER_ID],
        ),
        (
            "INSERT INTO workspaces (id, name, name_key, created_at, updated_at, owner_user_id) \
             VALUES (?, 'Space', 'space', 0, 0, ?)",
            vec![WORKSPACE_ID, USER_ID],
        ),
        (
            "INSERT INTO workspace_users (workspace_id, user_id, joined_at) VALUES (?, ?, 0)",
            vec![WORKSPACE_ID, USER_ID],
        ),
        (
            "INSERT INTO conversations (id, workspace_id, placement_kind, roster_policy, title, \
             title_key, status, created_at, updated_at) \
             VALUES (?, ?, 'workspace', 'open', 'Channel', 'general', 'open', 0, 0)",
            vec![CHANNEL_ID, WORKSPACE_ID],
        ),
        (
            "INSERT INTO conversation_users (conversation_id, user_id, joined_at) \
             VALUES (?, ?, 0)",
            vec![CHANNEL_ID, USER_ID],
        ),
        (
            "INSERT INTO conversation_agents (conversation_id, agent_id, joined_at) \
             VALUES (?, ?, 0)",
            vec![CHANNEL_ID, AGENT_ID],
        ),
        // In the workspace, deliberately NOT in the conversation: a mention is the only way it
        // could be reached.
        (
            "INSERT INTO agents (id, name, runtime, host_id, created_at, updated_at, \
             display_name, created_by_user_id) \
             VALUES (?, 'outside', 'codex', ?, 0, 0, 'Outside', ?)",
            vec![OUTSIDE_AGENT_ID, HOST_ID, USER_ID],
        ),
        (
            "INSERT INTO attachments (id, channel_id, filename, size, content_type, storage, \
             storage_key, created_by_kind, created_by_id, created_at) \
             VALUES (?, ?, 'notes.txt', 12, 'text/plain', 'local', 'key-1', 'user', ?, 0)",
            vec![ATTACHMENT_ID, CHANNEL_ID, USER_ID],
        ),
    ];

    for (sql, binds) in statements {
        let mut query = sqlx::query(sql);
        for bind in binds {
            query = query.bind(bind);
        }
        query.execute(&mut *db).await.expect(sql);
    }

    // The load-bearing ABSENCE, asserted rather than described: the outside agent must hold no
    // roster row for the target conversation. Without this, "participation cannot explain why its
    // token went unreported" would be a claim about the fixture instead of a fact about it — and a
    // stray row added later would silently turn a copy cell into a participation cell.
    let rows: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM conversation_agents WHERE conversation_id = ? AND agent_id = ?",
    )
    .bind(CHANNEL_ID)
    .bind(OUTSIDE_AGENT_ID)
    .fetch_one(&mut *db)
    .await
    .expect("the roster is readable");
    assert_eq!(
        rows, 0,
        "the outside agent must not participate in the target conversation"
    );
}

/// The channel gate a composition owns: it answers yes, because what these cells are about is
/// what happens AFTER the gates.
struct OpenChannel;

impl ChannelAccess for OpenChannel {
    fn may_post(
        &self,
        _channel: &ConversationId,
        _author: &UserId,
    ) -> Result<(), ChannelAccessRefusal> {
        Ok(())
    }
}

/// The stand-in resolver: every target names the seeded channel, and a `/thread:<id>` suffix
/// names a cluster inside it.
///
/// It reads the suffix rather than answering a fixed `None`, because a reply cannot reach the
/// agent door any other way — a stream is what that door's destination comes from. The address
/// GRAMMAR is not restated here: this looks for one separator and hands the rest to the domain's
/// own parser, so a change to what an address may look like has nothing to break in this file.
struct ResolvesToChannel;

impl TargetAddress for ResolvesToChannel {
    fn resolve(&self, _agent: &AgentId, target: &str) -> Result<ResolvedStream, AddressRefusal> {
        Ok(ResolvedStream {
            conversation: ConversationId::parse(CHANNEL_ID).unwrap(),
            thread_root: target
                .split_once("/thread:")
                .map(|(_, root)| ThreadRootId::parse(root).expect("a legal root id")),
        })
    }
}

struct GrantsSend;

impl SendCapability for GrantsSend {
    fn may_send_messages(
        &self,
        _agent: &AgentId,
        _conversation: &ConversationId,
    ) -> Result<(), CapabilityDenied> {
        Ok(())
    }
}

/// Whether a mention may open a direct line. Its own fake because the CC branches turn on it:
/// a roster says who participates, not who can be reached privately, so seeding participants
/// proves nothing about a copy.
struct DirectLines(bool);

impl DirectLineAuthority for DirectLines {
    fn direct_lines(
        &self,
        _author: &UserId,
        addressed: &AddressedPrincipals,
    ) -> Result<Vec<AgentId>, PersistenceFailure> {
        if !self.0 {
            return Ok(Vec::new());
        }
        // Maps the one handle this world knows to the id it was seeded with. NOT "parse any
        // handle as an id": a handle is a name and an id is an id, and conflating them would
        // grant a line to a principal that does not exist while the store looks up the one that
        // does.
        Ok(addressed
            .iter()
            .filter(|reference| reference.kind() == PrincipalKind::Agent)
            .filter(|reference| reference.handle().as_str() == "outside")
            .map(|_| AgentId::parse(OUTSIDE_AGENT_ID).unwrap())
            .collect())
    }
}

/// A database with the current schema and the minimal world, with the real store over it.
async fn opened(path: &Path) -> MessagingStore {
    {
        let mut connection = current_schema::create_current_schema(path).await;
        seed_minimal_scenario(&mut connection).await;
    }
    MessagingStore::open(path)
        .await
        .expect("the store opens a database that already exists")
}

/// The product doors over a given write unit. Generic in that one collaborator only, so a cell
/// can observe what the real store committed without any other part of the composition changing.
fn routes<U>(unit_of_work: U, direct_lines: bool) -> Router
where
    U: SendMessageUnitOfWork + Send + Sync + 'static,
{
    send_router(SendState {
        channel_access: OpenChannel,
        target_address: ResolvesToChannel,
        capability: GrantsSend,
        authority: DirectLines(direct_lines),
        unit_of_work,
    })
}

/// The common case: the real store, unobserved.
async fn mounted(path: &Path, direct_lines: bool) -> Router {
    routes(opened(path).await, direct_lines)
}

fn human_send(content: &str) -> Request<Body> {
    authenticated_human(serde_json::json!({ "content": content }))
}

/// The human door's own destination: a message of this same conversation to reply to.
fn human_reply(content: &str, reply_to: &str) -> Request<Body> {
    authenticated_human(serde_json::json!({
        "content": content,
        "reply_to_message_id": reply_to,
    }))
}

fn authenticated_human(body: Value) -> Request<Body> {
    let mut request = Request::post(format!("/api/channels/{CHANNEL_ID}/messages"))
        .body(Body::from(body.to_string()))
        .unwrap();
    request
        .extensions_mut()
        .insert(HumanPrincipal(UserId::parse(USER_ID).unwrap()));
    request
}

/// The agent door's destination is the absolute address its body carries, so a main-line send
/// names the conversation and a reply names the cluster inside it. An unanchored credential,
/// which reaches wherever the agent participates.
fn agent_send(content: &str) -> Request<Body> {
    authenticated_agent(content, format!("#conv:{CHANNEL_ID}"))
}

fn agent_reply(content: &str, root: &str) -> Request<Body> {
    authenticated_agent(content, format!("#conv:{CHANNEL_ID}/thread:{root}"))
}

fn authenticated_agent(content: &str, target: String) -> Request<Body> {
    let mut request = Request::post(format!("/internal/agents/{AGENT_ID}/send-message"))
        .body(Body::from(
            serde_json::json!({ "content": content, "target": target }).to_string(),
        ))
        .unwrap();
    request.extensions_mut().insert(AgentCredential::AgentSlot {
        agent: AgentId::parse(AGENT_ID).unwrap(),
    });
    request
}

/// A pass-through write unit that keeps a copy of the outcome it committed.
///
/// The route's answer and the copy are projections of ONE value, which is the only way a test can
/// hold what the route itself held: nothing on the wire could distinguish "the same outcome" from
/// "an equal one built again".
struct RecordingUnit<U> {
    inner: U,
    observed: Arc<Mutex<Option<SendMessageOutcome>>>,
}

impl<U: SendMessageUnitOfWork + Sync> SendMessageUnitOfWork for RecordingUnit<U> {
    async fn send_message(
        &self,
        command: SendMessage,
    ) -> Result<SendMessageOutcome, SendMessageError> {
        let outcome = self.inner.send_message(command).await?;
        *self.observed.lock().unwrap() = Some(outcome.clone());
        Ok(outcome)
    }
}

async fn answered(router: Router, request: Request<Body>) -> (StatusCode, Value) {
    let response = router.oneshot(request).await.unwrap();
    let status = response.status();
    let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .unwrap();
    let body = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
    (status, body)
}

/// The one log sink for this whole suite, installed process-wide.
///
/// NOT a scoped subscriber, and that is a correctness decision rather than a convenience. Most
/// cells here send bodies that name nobody, so they hit the report's callsite with no subscriber
/// installed; `tracing` then caches that callsite as never-interested, and a later cell that
/// scopes a subscriber around its own request records NOTHING. The counting gate below became
/// order-dependent that way — observed, not theorised. A global default is registered once and
/// rebuilds the interest cache, so the callsite stays live for every cell.
///
/// The cost is that this buffer holds every cell's events, so a count must name the send it is
/// about; the cell below counts by message id.
fn operator_log() -> &'static log_capture::LogBuffer {
    static SINK: OnceLock<log_capture::LogBuffer> = OnceLock::new();
    SINK.get_or_init(|| {
        let logs = log_capture::LogBuffer::default();
        let subscriber = tracing_subscriber::fmt()
            .json()
            .without_time()
            .with_target(false)
            .with_writer(logs.clone())
            .finish();
        tracing::subscriber::set_global_default(subscriber)
            .expect("this suite is the only thing installing a subscriber");
        logs
    })
}

/// The same request, plus the WARN events recorded while it ran. Both doors go through this
/// helper, so a per-door report would have to defeat the same count twice.
async fn observed(router: Router, request: Request<Body>) -> (StatusCode, Value, Vec<Value>) {
    let sink = operator_log();
    let before = sink.events().len();
    let (status, body) = answered(router, request).await;
    let warnings = sink
        .events()
        .into_iter()
        .skip(before)
        .filter(|event| event["level"] == "WARN")
        .collect();
    (status, body, warnings)
}

/// A response's top-level members, sorted — the shape of a contract rather than a probe of one
/// field, so a key that appears or vanishes cannot go unnoticed.
fn keys(body: &Value) -> Vec<String> {
    let mut keys = body
        .as_object()
        .expect("an object")
        .keys()
        .cloned()
        .collect::<Vec<_>>();
    keys.sort();
    keys
}

/// A committed send answers with its whole acknowledgement, and the fields a just-inserted
/// message cannot have are present and null rather than missing.
#[tokio::test]
async fn a_committed_send_answers_with_the_message_it_wrote() {
    let dir = tempdir().unwrap();
    let router = mounted(&dir.path().join("send.db"), false).await;

    let (status, body) = answered(router, human_send("plain words")).await;

    assert_eq!(status, StatusCode::CREATED, "{body}");
    let message = &body["message"];
    assert_eq!(message["conversation_id"], CHANNEL_ID);
    assert_eq!(message["from_kind"], "user");
    assert_eq!(message["from_user_id"], USER_ID);
    assert_eq!(message["from_agent_id"], Value::Null);
    assert_eq!(message["content"], "plain words");
    assert_eq!(message["seq"], 1);
    assert_eq!(message["thread_root_id"], Value::Null);
    // No attachments: both members are null, together.
    assert_eq!(message["metadata"], Value::Null);
    assert_eq!(message["attachments"], Value::Null);
    // STRUCTURALLY impossible on a row inserted this instant, and reported as such rather than
    // omitted: nothing has had the chance to react to it or link a task to it.
    assert_eq!(message["reactions"], Value::Null);
    assert_eq!(message["linked_task"], Value::Null);

    // A main-line send changed no cluster, so there is no projection sidecar to apply…
    assert!(body.get("projections").is_none(), "{body}");
    // …and every reference reached somebody, because there were none to reach.
    assert!(body.get("unresolved_references").is_none(), "{body}");
}

/// A reference whose principal has no row in the TARGET conversation's roster comes back to its
/// sender, and one that has such a row does not.
#[tokio::test]
async fn a_reference_outside_the_target_conversations_roster_is_reported_to_its_sender() {
    let dir = tempdir().unwrap();
    let router = mounted(&dir.path().join("unresolved.db"), false).await;

    let (status, body) = answered(
        router,
        human_send("hi <silverhand://agent/nobody> and <silverhand://agent/lio>"),
    )
    .await;

    assert_eq!(status, StatusCode::CREATED, "{body}");
    // `lio` holds a `conversation_agents` row for the conversation this send RESOLVED TO — the
    // same id the seed used and the address resolves to — so it reached somebody. `nobody` names
    // no principal at all. The fact is a row in the target conversation's roster, not membership
    // of any transport channel. Unknown and not-a-participant are one answer, and the reference
    // vocabulary says `agent`/`human` where the author DTO says `agent`/`user`.
    assert_eq!(
        body["unresolved_references"],
        serde_json::json!([{ "kind": "agent", "handle": "nobody" }])
    );
}

/// A HANDLE IS NOT A PRINCIPAL: one body may spell the same handle as both kinds, and a copy made
/// for the agent says nothing about the person.
///
/// `outside` is an agent of the workspace with no roster row for the target conversation, so the
/// only way it is reached is a mention copy — granted here. No user of that name exists, and the
/// schema would refuse one, so the `human` token names nobody at all.
///
/// If the copied set were consulted by handle alone, the agent's successful copy would swallow the
/// human token and this send would look fully addressed. The kind is half of that key.
#[tokio::test]
async fn a_copy_for_an_agent_does_not_cover_a_person_of_the_same_handle() {
    let dir = tempdir().unwrap();
    let router = mounted(&dir.path().join("homonym.db"), true).await;

    let (status, body) = answered(
        router,
        human_send("<silverhand://agent/outside> and <silverhand://human/outside>"),
    )
    .await;

    assert_eq!(status, StatusCode::CREATED, "{body}");
    // The agent token is NOT reported, and the only thing that can have covered it is a copy:
    // `outside` holds no roster row for the target conversation, so participation cannot explain
    // its absence. That is the observable evidence the copy really happened.
    assert_eq!(
        body["unresolved_references"],
        serde_json::json!([{ "kind": "human", "handle": "outside" }])
    );
}

/// WITHOUT THE LINE, THE COPY DOES NOT HAPPEN — and the same body then reports both tokens.
///
/// The mirror of the cell above, and what makes its claim precise: the only difference here is
/// that no direct line is granted, so the mention is skipped for want of one and the agent is
/// reached by nothing. Reading the two together, the agent token's absence up there is
/// attributable to the copy and to nothing else in the fixture.
#[tokio::test]
async fn without_a_direct_line_the_mention_reaches_nobody() {
    let dir = tempdir().unwrap();
    let router = mounted(&dir.path().join("no_line.db"), false).await;

    let (status, body) = answered(
        router,
        human_send("<silverhand://agent/outside> and <silverhand://human/outside>"),
    )
    .await;

    assert_eq!(status, StatusCode::CREATED, "{body}");
    // Source order, both kinds: the agent because no copy could be made and it holds no roster
    // row, the person because no such person exists.
    assert_eq!(
        body["unresolved_references"],
        serde_json::json!([
            { "kind": "agent", "handle": "outside" },
            { "kind": "human", "handle": "outside" }
        ])
    );
}

/// THE HUMAN ACKNOWLEDGEMENT IS A SUPERSET OF THE BROADCAST PAYLOAD, never a different shape.
///
/// The renderer applies the acknowledgement and the published frame through one seam, so the
/// sender's own view must converge exactly as everyone else's does. The only key the ACK may add
/// is the one with an audience of one.
///
/// Asserted as the STATUS and the top-level key SET rather than by probing members: a second
/// sender-only key appearing here would be a private field riding a shape a client reads as the
/// shared one, and the status is as much of the published contract as the body is.
#[tokio::test]
async fn the_human_door_answers_its_own_published_contract() {
    let dir = tempdir().unwrap();
    let router = mounted(&dir.path().join("superset.db"), false).await;

    let (status, plain) = answered(router, human_send("nothing named here")).await;
    assert_eq!(status, StatusCode::CREATED);
    // A main-line send with every reference resolved: the payload's own member and nothing else.
    assert_eq!(keys(&plain), ["message"]);

    let dir = tempdir().unwrap();
    let router = mounted(&dir.path().join("superset_unresolved.db"), false).await;
    let (status, with_diagnostic) =
        answered(router, human_send("<silverhand://human/outside>")).await;
    assert_eq!(status, StatusCode::CREATED);
    assert_eq!(keys(&with_diagnostic), ["message", "unresolved_references"]);
}

/// THE AGENT DOOR ANSWERS A DIFFERENT PUBLISHED CONTRACT, and that difference is the point.
///
/// `200` and a flat coordinate report: the four members a runtime reads to advance its own
/// cursor, and — when it applies — the same sender-only member the person's ACK carries. It is
/// NOT the acknowledgement: a daemon has no schema for a message DTO or cluster projections, and
/// would find none of `message_id`/`message_seq`/`conversation_id` if it were handed one
/// (@Cindy, terminal review P0).
///
/// `thread_root_id` is present and NULL on the main line rather than omitted, because "which
/// stream did my words join" has an answer for every send.
#[tokio::test]
async fn the_agent_door_answers_its_own_published_contract() {
    let dir = tempdir().unwrap();
    let router = mounted(&dir.path().join("agent_output.db"), false).await;

    let (status, output) = answered(router.clone(), agent_send("from a runtime")).await;

    assert_eq!(status, StatusCode::OK, "{output}");
    assert_eq!(
        keys(&output),
        [
            "conversation_id",
            "message_id",
            "message_seq",
            "thread_root_id"
        ]
    );
    assert_eq!(output["conversation_id"], CHANNEL_ID);
    assert_eq!(output["message_seq"], 1);
    assert_eq!(output["thread_root_id"], Value::Null);
    assert!(
        output["message_id"]
            .as_str()
            .is_some_and(|id| !id.is_empty()),
        "{output}"
    );
    // The person's whole payload is absent, not merely unasserted.
    assert!(output.get("message").is_none(), "{output}");
    assert!(output.get("projections").is_none(), "{output}");

    // The ONE shared member, spelled the same way on this contract as on the other: same key,
    // same element shape, same omitted-when-empty rule.
    let (status, named_nobody) =
        answered(router, agent_send("<silverhand://human/nobody> hello")).await;
    assert_eq!(status, StatusCode::OK, "{named_nobody}");
    assert_eq!(
        keys(&named_nobody),
        [
            "conversation_id",
            "message_id",
            "message_seq",
            "thread_root_id",
            "unresolved_references"
        ]
    );
    assert_eq!(
        named_nobody["unresolved_references"],
        serde_json::json!([{ "kind": "human", "handle": "nobody" }])
    );
}

/// THE TYPED MEMBER AND THE STORED METADATA ARE ONE PROJECTION, placed twice.
///
/// Read back from a real insert: with an attachment the two carry the same snapshot set and the
/// metadata holds nothing besides it, and an unlabelled attachment omits `label` rather than
/// nulling it. The pairing is structural in the projector — this reads it off a real row.
#[tokio::test]
async fn the_stored_metadata_mirrors_the_typed_attachments() {
    let dir = tempdir().unwrap();
    let router = mounted(&dir.path().join("attached.db"), false).await;

    let mut request = Request::post(format!("/api/channels/{CHANNEL_ID}/messages"))
        .body(Body::from(
            serde_json::json!({ "content": "see this", "attachment_ids": [ATTACHMENT_ID] })
                .to_string(),
        ))
        .unwrap();
    request
        .extensions_mut()
        .insert(HumanPrincipal(UserId::parse(USER_ID).unwrap()));

    let (status, body) = answered(router, request).await;

    assert_eq!(status, StatusCode::CREATED, "{body}");
    let expected = serde_json::json!([{
        "id": ATTACHMENT_ID,
        "filename": "notes.txt",
        "size": 12,
        "content_type": "text/plain",
    }]);
    assert_eq!(body["message"]["attachments"], expected);
    // Exactly `{attachments}`, with no second key: the metadata is not a free-form record here.
    assert_eq!(
        body["message"]["metadata"],
        serde_json::json!({ "attachments": expected })
    );
}

/// A REPLY'S TWO SIDECAR MEMBERS DESCRIBE THE ONE CLUSTER IT JOINED.
///
/// The root and the reply are both written through the human door, so the cluster is a real one
/// and the sidecar is read from the contract that actually carries it — `projections` is a member
/// of the acknowledgement, and the agent door publishes no such thing.
///
/// The entry is compared as WHOLE JSON so its ten members are a closed set, and every member is
/// anchored to a row these two sends wrote: the root's own preview, coordinate and byline, and
/// the reply being acknowledged as the last one. Both members come from the ONE `ThreadReplyFact`,
/// which is what makes "the count and the entry cannot describe different clusters" observable.
#[tokio::test]
async fn a_replys_sidecar_describes_the_cluster_it_joined() {
    let dir = tempdir().unwrap();
    let router = mounted(&dir.path().join("cluster.db"), false).await;

    let (_, root) = answered(router.clone(), human_send("the root of it")).await;
    let root_id = root["message"]["id"].as_str().unwrap().to_owned();

    let (status, reply) = answered(router, human_reply("the person answers", &root_id)).await;

    assert_eq!(status, StatusCode::CREATED, "{reply}");
    assert_eq!(
        reply["projections"]["thread_root_reply_count"],
        serde_json::json!({ "root_id": root_id, "reply_count": 1 })
    );
    assert_eq!(
        reply["projections"]["threads_list_entry"]["entry"],
        serde_json::json!({
            "root_message_id": root_id,
            "root_author": root["message"]["author"],
            // The raw root content: a preview under the bound is neither trimmed nor elided.
            "root_preview": root["message"]["content"],
            "root_created_at": root["message"]["created_at"],
            "root_seq": root["message"]["seq"],
            // Projected INSIDE the transaction that wrote it, so the reply already counts itself.
            "reply_count": 1,
            "last_reply_at": reply["message"]["created_at"],
            "last_reply_message_id": reply["message"]["id"],
            "repliers": [reply["message"]["author"]],
            "replier_total": 1,
        })
    );
}

/// THE CLUSTER'S REPLIERS ARE MOST-RECENT-FIRST, and the agent door still reports its own stream.
///
/// The order matters to a client placing faces on a thread, and it is only observable once two
/// different principals have replied AND the most recent one is not the one who spoke first. So
/// the agent replies last — which means its own answer is the flat report, carrying
/// `thread_root_id` and no projections at all.
///
/// The ORDER is therefore read off the committed fact that very send produced, captured through
/// the write unit. That is a deliberate choice about evidence: the alternative is to read
/// `projections` off the agent's response, which would require the agent door to answer with the
/// person's ACK — a test fixing a contract that is wrong (@Cindy, terminal review P0). An
/// insertion-ordered entry would put the person first and turn this cell red.
#[tokio::test]
async fn the_cluster_orders_its_repliers_most_recent_first() {
    let dir = tempdir().unwrap();
    let observed = Arc::new(Mutex::new(None));
    let router = routes(
        RecordingUnit {
            inner: opened(&dir.path().join("ordering.db")).await,
            observed: Arc::clone(&observed),
        },
        false,
    );

    let (_, root) = answered(router.clone(), human_send("the root of it")).await;
    let root_id = root["message"]["id"].as_str().unwrap().to_owned();
    let (_, first) = answered(
        router.clone(),
        human_reply("the person answers first", &root_id),
    )
    .await;

    let (status, output) = answered(router, agent_reply("the agent answers last", &root_id)).await;

    // The agent's own contract: its stream, reported as the coordinate it is.
    assert_eq!(status, StatusCode::OK, "{output}");
    assert_eq!(output["thread_root_id"], root_id);
    assert!(output.get("projections").is_none(), "{output}");

    let outcome = observed
        .lock()
        .unwrap()
        .clone()
        .expect("the agent's reply committed through the write unit");
    let entry = outcome
        .committed()
        .thread()
        .expect("a reply carries its cluster projection")
        .list_entry();

    assert_eq!(entry.root_id().as_str(), root_id);
    assert_eq!(entry.reply_count(), 2);
    assert_eq!(entry.replier_total(), 2);
    // The last reply is the agent's — the one being committed, not the newest row at read time.
    assert_eq!(
        entry.last_reply_message_id().as_str(),
        output["message_id"].as_str().unwrap()
    );
    // MOST-RECENT-FIRST: the agent that just spoke, then the person it answered.
    assert_eq!(
        entry
            .repliers()
            .iter()
            .map(principal_of)
            .collect::<Vec<_>>(),
        vec![
            format!("agent/{AGENT_ID}"),
            format!(
                "user/{}",
                first["message"]["from_user_id"].as_str().unwrap()
            ),
        ]
    );
}

/// An author as "which principal is this", which is all the ordering cell needs to tell two
/// repliers apart.
fn principal_of(author: &MessageAuthor) -> String {
    match author {
        MessageAuthor::Active(ActiveAuthor::Agent(agent)) => {
            format!("agent/{}", agent.id().as_str())
        }
        MessageAuthor::Active(ActiveAuthor::Human(human)) => {
            format!("user/{}", human.id().as_str())
        }
        other => panic!("this world has no such replier: {other:?}"),
    }
}

/// ONE OUTCOME, TWO PROJECTIONS, and only one of them may carry the verdict.
///
/// The route answers its sender from the same value a publication would read, so this holds the
/// outcome the route itself committed rather than an equal one rebuilt afterwards. The ACK carries
/// `unresolved_references`; the publication view of that very outcome carries the row — content
/// included, mention token and all — and no answer about whether the token reached anybody.
///
/// WHAT THIS IS NOT: evidence that one request produces both. The router runs no post-commit
/// announcer, so nothing here observes a published frame, and the pair below is one outcome
/// projected twice (@Cindy). That the sender-only half is UNREACHABLE from a view — rather than
/// merely absent from this one — is a type fact, proven by the `compile_fail` gates beside
/// `SendMessageOutcome`; a test cannot assert the absence of an accessor.
#[tokio::test]
async fn one_outcome_answers_its_sender_and_publishes_the_row_without_the_verdict() {
    let dir = tempdir().unwrap();
    let observed = Arc::new(Mutex::new(None));
    let router = routes(
        RecordingUnit {
            inner: opened(&dir.path().join("one_outcome.db")).await,
            observed: Arc::clone(&observed),
        },
        false,
    );

    let named_nobody = "about <silverhand://human/outside>";
    let (status, ack) = answered(router, human_send(named_nobody)).await;
    assert_eq!(status, StatusCode::CREATED, "{ack}");

    let outcome = observed
        .lock()
        .unwrap()
        .clone()
        .expect("the route committed a send through the write unit");

    // The sender's half, on the wire and in the outcome it was read from.
    assert_eq!(
        ack["unresolved_references"],
        serde_json::json!([{ "kind": "human", "handle": "outside" }])
    );
    assert_eq!(outcome.unresolved_references().len(), 1);

    // The publication half of the SAME outcome: the row every reader of this conversation gets.
    let published = outcome
        .committed()
        .main_line()
        .expect("a main-line send")
        .published();
    assert_eq!(
        published.message().id.as_str(),
        ack["message"]["id"].as_str().unwrap(),
        "the two projections describe one row"
    );
    assert_eq!(
        published.message().seq.get(),
        ack["message"]["seq"].as_i64().unwrap()
    );
    assert!(published.reply_projection().is_none());
    // The BODY still names the person — publication is not a redaction of what was written. What
    // it has no way to carry is the verdict about that name, which is the whole distinction.
    assert_eq!(published.message().content.as_str(), named_nobody);
}

/// AN OPERATOR IS TOLD ONCE PER SEND, and only when it happened.
///
/// The reference implementation records this after the commit succeeds, at WARN, because it is an
/// anomaly somebody may have to explain later — "I told the agent and nothing happened" — and a
/// running install's default level would not have kept an `info` line. It SUPPLEMENTS the answer
/// the sender already got; it is not a second audience for the diagnostic and carries nothing
/// about who exists.
///
/// Counted rather than probed, on three axes a wrong implementation would break: per SEND and not
/// per reference (two tokens, one line), silent when every reference landed, and ONE
/// implementation for both doors — a per-adapter report would double this or lose it.
///
/// Counted BY MESSAGE ID, because the sink is process-wide and other cells send concurrently. A
/// duplicate report is therefore caught as long as it names the send it is about, which is one of
/// the report's own required coordinates.
#[tokio::test]
async fn an_operator_is_told_once_when_references_reached_nobody() {
    const REPORT: &str = "send.references_unresolved";
    let dir = tempdir().unwrap();
    let router = mounted(&dir.path().join("reported.db"), false).await;

    let (status, ack, warnings) = observed(
        router.clone(),
        human_send("<silverhand://human/nobody> and <silverhand://agent/missing>"),
    )
    .await;

    assert_eq!(status, StatusCode::CREATED, "{ack}");
    let about_this_send = |warnings: &[Value], message: &Value| -> Vec<Value> {
        warnings
            .iter()
            .filter(|event| event["fields"]["message_id"] == *message)
            .cloned()
            .collect()
    };
    // ONE line for a send that named two.
    let reports = about_this_send(&warnings, &ack["message"]["id"]);
    assert_eq!(reports.len(), 1, "{warnings:?}");

    let fields = &reports[0]["fields"];
    assert_eq!(fields["event"], REPORT);
    assert_eq!(fields["source_conversation_id"], CHANNEL_ID);
    assert_eq!(fields["target_conversation_id"], CHANNEL_ID);
    assert_eq!(fields["actor_kind"], "user");
    assert_eq!(fields["actor_id"], USER_ID);
    // The author's OWN tokens as a WHOLE array: closed element set, body order, and no reason
    // — unknown and exists-but-unreachable are indistinguishable here, exactly as they are on
    // the wire.
    assert_eq!(
        reported_tokens(fields),
        serde_json::json!([
            { "kind": "human", "handle": "nobody" },
            { "kind": "agent", "handle": "missing" }
        ])
    );
    // …and the field is NOT called `unresolved`. Its value is that array's JSON text, because a
    // `tracing` field cannot be a nested array; a string under the reference's own field name
    // would claim a shape it does not have (residual, for @Cindy and @shiki to accept or not).
    assert!(fields.get("unresolved").is_none(), "{fields}");

    // Every reference landed: nothing to explain, so nothing about this send on disk.
    let (_, resolved, quiet) = observed(router, human_send("nobody is named here")).await;
    assert!(
        about_this_send(&quiet, &resolved["message"]["id"]).is_empty(),
        "{quiet:?}"
    );

    // The OTHER door, same report: it lives at the stage both doors converge on.
    let dir = tempdir().unwrap();
    let router = mounted(&dir.path().join("reported_agent.db"), false).await;
    let (status, output, warnings) =
        observed(router, agent_send("<silverhand://human/nobody>")).await;

    assert_eq!(status, StatusCode::OK, "{output}");
    let reports = about_this_send(&warnings, &output["message_id"]);
    assert_eq!(reports.len(), 1, "{warnings:?}");
    let fields = &reports[0]["fields"];
    assert_eq!(fields["event"], REPORT);
    // The actor is the one the message records, so each door reports its own principal.
    assert_eq!(fields["actor_kind"], "agent");
    assert_eq!(fields["actor_id"], AGENT_ID);
    assert_eq!(
        reported_tokens(fields),
        serde_json::json!([{ "kind": "human", "handle": "nobody" }])
    );
}

/// The report's tokens, read back as the array they are projected as.
fn reported_tokens(fields: &Value) -> Value {
    let text = fields["unresolved_json"]
        .as_str()
        .expect("the report carries its tokens");
    serde_json::from_str(text).expect("the tokens are that array's JSON")
}
