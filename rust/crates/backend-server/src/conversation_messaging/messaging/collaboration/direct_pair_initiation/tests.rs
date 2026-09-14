use std::{
    convert::Infallible,
    sync::{
        Arc,
        atomic::{AtomicBool, AtomicUsize, Ordering},
    },
};

use axum::{
    body::{Body, Bytes, to_bytes},
    extract::Extension,
    http::{Request, StatusCode, header::CONTENT_LENGTH},
};
use futures_util::stream;
use serde_json::{Value, json};
use silverhand_backend_core::{
    conversation_messaging::messaging::{
        AddressedPrincipals, AttachmentId, AttachmentRefusal, CreatedMessage, DirectLineAuthority,
        DirectPairMint, DirectPairMinted, DirectPairOpenedFact, DirectPairOpenedPort,
        DirectPairParticipants, EnvironmentUnavailable, FromKind, MessageContent,
        MessageCreatedFact, MessageId, MessageSeq, PrincipalIdentity, SendClock, SendEntropy,
        SendMessage, SendMessageError, SendMessageOutcome, SendMessageUnitOfWork,
        collaboration::direct_pair_initiation::{
            AuthorizedDirectPairInitiation, DirectPairFirstSendError,
            DirectPairInitiationAuthority, DirectPairInitiationDecision,
            DirectPairInitiationGrantFact, DirectPairInitiationPort, DirectPairInitiationSource,
            OpenedDirectPairFirstMessage, open_and_send_direct_pair,
        },
        post_commit::{DeliveryPlan, MainDeliveryPlan, PostCommitPlan},
    },
    foundation::identity::{AgentId, ConversationId, UserId},
    foundation::persistence::PersistenceFailure,
};
use silverhand_backend_sqlite::conversation_messaging::messaging::MessagingStore;
use sqlx::{Connection, Executor};
use tower::ServiceExt;

use super::{DIRECT_PAIR_INITIATION_PATH, router};
use crate::conversation_messaging::messaging::{
    MESSAGE_SEND_MAX_BODY_BYTES, aftermath::SendAftermath,
};

fn user(raw: &str) -> UserId {
    UserId::parse(raw).unwrap()
}

fn agent(raw: &str) -> AgentId {
    AgentId::parse(raw).unwrap()
}

fn conversation(raw: &str) -> ConversationId {
    ConversationId::parse(raw).unwrap()
}

#[derive(Clone)]
struct Initiation {
    decision: DirectPairInitiationDecision,
    authority_calls: Arc<AtomicUsize>,
    opens: Arc<AtomicUsize>,
}

impl Initiation {
    fn granted() -> Self {
        Self {
            decision: DirectPairInitiationDecision::Granted(
                DirectPairInitiationGrantFact::granted(
                    user("user-1"),
                    PrincipalIdentity::Agent(agent("agent-1")),
                ),
            ),
            authority_calls: Arc::new(AtomicUsize::new(0)),
            opens: Arc::new(AtomicUsize::new(0)),
        }
    }

    fn refusal(decision: DirectPairInitiationDecision) -> Self {
        Self {
            decision,
            authority_calls: Arc::new(AtomicUsize::new(0)),
            opens: Arc::new(AtomicUsize::new(0)),
        }
    }
}

impl DirectPairInitiationAuthority for Initiation {
    type Error = Infallible;

    async fn decide(
        &self,
        _: &UserId,
        _: &PrincipalIdentity,
    ) -> Result<DirectPairInitiationDecision, Self::Error> {
        self.authority_calls.fetch_add(1, Ordering::SeqCst);
        Ok(self.decision.clone())
    }
}

struct Mint(DirectPairParticipants);

impl DirectPairMint for Mint {
    type Error = Infallible;

    async fn mint_direct_pair(
        &mut self,
        _: &DirectPairParticipants,
        _: i64,
    ) -> Result<DirectPairMinted, Self::Error> {
        Ok(DirectPairMinted::committed(
            conversation("pair-1"),
            self.0.clone(),
            true,
        ))
    }
}

#[derive(Clone)]
struct Opened(Arc<AtomicUsize>);

impl DirectPairOpenedPort for Opened {
    type Error = Infallible;

    async fn direct_pair_opened(&self, _: &DirectPairOpenedFact) -> Result<(), Self::Error> {
        self.0.fetch_add(1, Ordering::SeqCst);
        Ok(())
    }
}

struct Clock;

impl SendClock for Clock {
    fn now_unix_ms(&self) -> Result<i64, EnvironmentUnavailable> {
        Ok(1)
    }
}

impl DirectPairInitiationPort for Initiation {
    type MintError = Infallible;
    type OpenedError = Infallible;

    async fn open_and_send<F, Fut, T, S>(
        &self,
        authorized: AuthorizedDirectPairInitiation,
        send: F,
    ) -> Result<T, DirectPairFirstSendError<Self::MintError, Self::OpenedError, S>>
    where
        F: FnOnce(OpenedDirectPairFirstMessage) -> Fut + Send,
        Fut: Future<Output = Result<T, S>> + Send,
        T: Send,
        S: std::error::Error + Send + Sync + 'static,
    {
        let participants = DirectPairParticipants::between(
            PrincipalIdentity::Human(authorized.viewer().clone()),
            authorized.target().clone(),
        )
        .unwrap();
        let mut mint = Mint(participants);
        open_and_send_direct_pair(
            authorized,
            &mut mint,
            &Opened(self.opens.clone()),
            &Clock,
            send,
        )
        .await
    }
}

#[derive(Clone, Default)]
struct DirectLines;

impl DirectLineAuthority for DirectLines {
    async fn direct_lines(
        &self,
        _: &UserId,
        _: &AddressedPrincipals,
    ) -> Result<Vec<AgentId>, PersistenceFailure> {
        Ok(Vec::new())
    }
}

#[derive(Clone, Default)]
struct NoAftermath;

impl SendAftermath for NoAftermath {
    async fn announce(&self, _: &SendMessageOutcome) {}
}

#[derive(Clone)]
struct SuccessUnit {
    calls: Arc<AtomicUsize>,
}

impl SendMessageUnitOfWork for SuccessUnit {
    async fn send_message(&self, _: SendMessage) -> Result<SendMessageOutcome, SendMessageError> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        Ok(committed_outcome())
    }
}

#[derive(Clone)]
struct FailingUnit {
    calls: Arc<AtomicUsize>,
}

impl SendMessageUnitOfWork for FailingUnit {
    async fn send_message(&self, _: SendMessage) -> Result<SendMessageOutcome, SendMessageError> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        Err(AttachmentRefusal::OutsideChannel {
            attachment_id: AttachmentId::parse("missing").unwrap(),
        }
        .into())
    }
}

fn committed_outcome() -> SendMessageOutcome {
    let message = CreatedMessage {
        client_message_id: None,
        id: MessageId::parse("message-1").unwrap(),
        conversation_id: conversation("pair-1"),
        from_kind: FromKind::User,
        from_agent_id: None,
        from_user_id: Some(user("user-1")),
        author: None,
        content: MessageContent::parse("hello").unwrap(),
        attachments: Vec::new(),
        seq: MessageSeq::try_from(1).unwrap(),
        created_at_ms: 10,
        thread_root_id: None,
    };
    SendMessageOutcome::committed_send(
        MessageCreatedFact::committed(
            message,
            None,
            PostCommitPlan::committed(
                None,
                DeliveryPlan::MainLine(MainDeliveryPlan::committed(Vec::new(), Vec::new())),
                Vec::new(),
            ),
            false,
            Vec::new(),
        ),
        Vec::new(),
    )
}

fn app<U>(initiation: Initiation, unit: U) -> axum::Router
where
    U: SendMessageUnitOfWork + Send + Sync + 'static,
{
    router(initiation, DirectLines, unit, NoAftermath).layer(Extension(user("user-1")))
}

async fn call(app: axum::Router, body: Body, declared: Option<usize>) -> (StatusCode, Value) {
    call_path(app, "agent-1", body, declared).await
}

async fn call_path(
    app: axum::Router,
    target: &str,
    body: Body,
    declared: Option<usize>,
) -> (StatusCode, Value) {
    let mut builder = Request::builder()
        .method("POST")
        .uri(DIRECT_PAIR_INITIATION_PATH.replace("{id}", target))
        .header("content-type", "application/json");
    if let Some(length) = declared {
        builder = builder.header(CONTENT_LENGTH, length);
    }
    let response = app.oneshot(builder.body(body).unwrap()).await.unwrap();
    let status = response.status();
    let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
    let body = serde_json::from_slice(&bytes)
        .unwrap_or_else(|_| Value::String(String::from_utf8(bytes.to_vec()).unwrap()));
    (status, body)
}

#[tokio::test]
async fn authority_refusals_precede_and_do_not_poll_the_body() {
    for (decision, status, expected) in [
        (
            DirectPairInitiationDecision::NotFound,
            StatusCode::NOT_FOUND,
            json!({"error":"not found"}),
        ),
        (
            DirectPairInitiationDecision::Forbidden,
            StatusCode::FORBIDDEN,
            json!({"error":"forbidden"}),
        ),
    ] {
        let initiation = Initiation::refusal(decision);
        let opens = initiation.opens.clone();
        let polled = Arc::new(AtomicBool::new(false));
        let flag = polled.clone();
        let body = Body::from_stream(stream::once(async move {
            flag.store(true, Ordering::SeqCst);
            Ok::<Bytes, Infallible>(Bytes::from_static(b"{}"))
        }));
        let unit_calls = Arc::new(AtomicUsize::new(0));
        let (actual_status, actual) = call(
            app(
                initiation,
                SuccessUnit {
                    calls: unit_calls.clone(),
                },
            ),
            body,
            Some(MESSAGE_SEND_MAX_BODY_BYTES + 1),
        )
        .await;
        assert_eq!(actual_status, status);
        assert_eq!(actual, expected);
        assert!(!polled.load(Ordering::SeqCst));
        assert_eq!(opens.load(Ordering::SeqCst), 0);
        assert_eq!(unit_calls.load(Ordering::SeqCst), 0);
    }
}

#[tokio::test]
async fn every_door_local_preflight_refuses_before_pair_allocation() {
    // The reply-target refusal is asserted as the EXACT wire envelope, not a substring:
    // a `contains` on the marker would pass a wrong message, an extra or missing field,
    // or any non-contract body that merely mentions the code. The two cells that answer
    // the reply target therefore pin the whole object. The shape cell (a body carrying
    // no content) is now the shared semantic refusal `422 {"error":"invalid input"}`,
    // pinned exactly — the door no longer publishes which field was wrong. The cap cell
    // keeps a marker here; `each_door_words_the_content_cap_for_its_own_caller` pins its
    // `max_bytes`/`actual_bytes`.
    enum Expect {
        Exact(Value),
        Contains(&'static str),
    }
    let reply_unsupported = || {
        Expect::Exact(json!({
            "error": "cannot open a direct-message line into a reply cluster",
            "code": "reply_to_unsupported",
        }))
    };
    let cases = [
        (
            Body::from("{}"),
            None,
            StatusCode::UNPROCESSABLE_ENTITY,
            Expect::Exact(json!({ "error": "invalid input" })),
        ),
        // A value-shaped positional array. Serde's derived struct would bind `["x"]` to the
        // envelope's fields positionally (content="x"), so without the shared `ObjectOnly`
        // floor this array — with authority already GRANTED for this fixture — would allocate
        // the pair and reach the send unit. It is the same minimal `422 {"error":"invalid
        // input"}` and never reaches allocation (`opens`) or the write unit (`unit_calls`).
        (
            Body::from(json!(["x"]).to_string()),
            None,
            StatusCode::UNPROCESSABLE_ENTITY,
            Expect::Exact(json!({ "error": "invalid input" })),
        ),
        (
            Body::from(json!({"content":"x","reply_to_message_id":"root"}).to_string()),
            None,
            StatusCode::BAD_REQUEST,
            reply_unsupported(),
        ),
        (
            Body::from(json!({"content":"x".repeat(65_537)}).to_string()),
            None,
            StatusCode::PAYLOAD_TOO_LARGE,
            Expect::Contains("content_too_large"),
        ),
        // The reply-target↔cap crossing cell. Oversized content AND a reply target is
        // reachable within the transport bound (513 bytes over the 64KiB cap, far under
        // the 512KiB envelope), and TS answers the reply target first: 400
        // `reply_to_unsupported`, never 413. The fused order this route used to inherit
        // sealed the cap inside admission and answered 413 here — this cell is the
        // resident falsifier that goes red the moment the two stages refuse in the wrong
        // order. A single-trigger cell proves each gate exists but says nothing about
        // which of two adjacent gates wins. Asserted as the EXACT 400 envelope so a
        // 413-with-the-wrong-body can never masquerade as a pass.
        (
            Body::from(
                json!({"content":"x".repeat(65_537),"reply_to_message_id":"root"}).to_string(),
            ),
            None,
            StatusCode::BAD_REQUEST,
            reply_unsupported(),
        ),
    ];
    for (body, declared, expected_status, expected_body) in cases {
        let initiation = Initiation::granted();
        let opens = initiation.opens.clone();
        let unit_calls = Arc::new(AtomicUsize::new(0));
        let (status, body) = call(
            app(
                initiation,
                SuccessUnit {
                    calls: unit_calls.clone(),
                },
            ),
            body,
            declared,
        )
        .await;
        assert_eq!(status, expected_status);
        match expected_body {
            Expect::Exact(expected) => assert_eq!(body, expected),
            Expect::Contains(marker) => assert!(body.to_string().contains(marker)),
        }
        assert_eq!(opens.load(Ordering::SeqCst), 0);
        assert_eq!(unit_calls.load(Ordering::SeqCst), 0);
    }
}

#[tokio::test]
async fn the_shared_envelope_bound_is_applied_after_authority_and_before_allocation() {
    let initiation = Initiation::granted();
    let opens = initiation.opens.clone();
    let unit_calls = Arc::new(AtomicUsize::new(0));
    let polled = Arc::new(AtomicBool::new(false));
    let flag = polled.clone();
    let body = Body::from_stream(stream::once(async move {
        flag.store(true, Ordering::SeqCst);
        Ok::<Bytes, Infallible>(Bytes::from_static(b"{}"))
    }));
    let (status, value) = call(
        app(
            initiation,
            SuccessUnit {
                calls: unit_calls.clone(),
            },
        ),
        body,
        Some(MESSAGE_SEND_MAX_BODY_BYTES + 1),
    )
    .await;
    assert_eq!(status, StatusCode::PAYLOAD_TOO_LARGE);
    assert_eq!(value["max_body_bytes"], MESSAGE_SEND_MAX_BODY_BYTES);
    assert!(!polled.load(Ordering::SeqCst));
    assert_eq!(opens.load(Ordering::SeqCst), 0);
    assert_eq!(unit_calls.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn chunked_overflow_and_exact_limit_share_the_bound_without_minting_early() {
    let initiation = Initiation::granted();
    let opens = initiation.opens.clone();
    let unit_calls = Arc::new(AtomicUsize::new(0));
    let half = MESSAGE_SEND_MAX_BODY_BYTES / 2;
    let chunked = Body::from_stream(stream::iter(vec![
        Ok::<Bytes, Infallible>(Bytes::from(vec![b' '; half])),
        Ok(Bytes::from(vec![b' '; half + 1])),
    ]));
    let (status, _) = call(
        app(
            initiation,
            SuccessUnit {
                calls: unit_calls.clone(),
            },
        ),
        chunked,
        None,
    )
    .await;
    assert_eq!(status, StatusCode::PAYLOAD_TOO_LARGE);
    assert_eq!(opens.load(Ordering::SeqCst), 0);
    assert_eq!(unit_calls.load(Ordering::SeqCst), 0);

    let prefix = br#"{"content":"hello","padding":""#;
    let suffix = br#""}"#;
    let mut exact = Vec::with_capacity(MESSAGE_SEND_MAX_BODY_BYTES);
    exact.extend_from_slice(prefix);
    exact.resize(MESSAGE_SEND_MAX_BODY_BYTES - suffix.len(), b' ');
    exact.extend_from_slice(suffix);
    assert_eq!(exact.len(), MESSAGE_SEND_MAX_BODY_BYTES);
    let initiation = Initiation::granted();
    let opens = initiation.opens.clone();
    let unit_calls = Arc::new(AtomicUsize::new(0));
    let (status, _) = call(
        app(
            initiation,
            SuccessUnit {
                calls: unit_calls.clone(),
            },
        ),
        Body::from(exact),
        Some(MESSAGE_SEND_MAX_BODY_BYTES),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED);
    assert_eq!(opens.load(Ordering::SeqCst), 1);
    assert_eq!(unit_calls.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn missing_authentication_never_polls_or_consults_product_authority() {
    let initiation = Initiation::granted();
    let authority_calls = initiation.authority_calls.clone();
    let opens = initiation.opens.clone();
    let unit_calls = Arc::new(AtomicUsize::new(0));
    let polled = Arc::new(AtomicBool::new(false));
    let flag = polled.clone();
    let body = Body::from_stream(stream::once(async move {
        flag.store(true, Ordering::SeqCst);
        Ok::<Bytes, Infallible>(Bytes::from_static(b"{}"))
    }));
    let app = router(
        initiation,
        DirectLines,
        SuccessUnit {
            calls: unit_calls.clone(),
        },
        NoAftermath,
    );
    let (status, body) = call(app, body, Some(MESSAGE_SEND_MAX_BODY_BYTES + 1)).await;
    assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR);
    assert_eq!(body, Value::String("Internal Server Error".into()));
    assert!(!polled.load(Ordering::SeqCst));
    assert_eq!(authority_calls.load(Ordering::SeqCst), 0);
    assert_eq!(opens.load(Ordering::SeqCst), 0);
    assert_eq!(unit_calls.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn ordinary_body_driver_failure_uses_the_typescript_empty_object_catch() {
    let initiation = Initiation::granted();
    let opens = initiation.opens.clone();
    let unit_calls = Arc::new(AtomicUsize::new(0));
    let body = Body::from_stream(stream::once(async {
        Err::<Bytes, _>(std::io::Error::other("body driver failed"))
    }));
    let (status, body) = call(
        app(
            initiation,
            SuccessUnit {
                calls: unit_calls.clone(),
            },
        ),
        body,
        None,
    )
    .await;
    // An unreadable body becomes `None`, which admission treats as an empty object: the
    // required content is then missing and the shared semantic refusal answers. The
    // reference's own empty-object catch lands on the same "says nothing" verdict; the
    // door renders it `422 {"error":"invalid input"}` rather than a field-path issue.
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(body, json!({ "error": "invalid input" }));
    assert_eq!(opens.load(Ordering::SeqCst), 0);
    assert_eq!(unit_calls.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn a_send_refusal_after_mint_keeps_the_opened_pair_and_maps_existing_send_wire() {
    let initiation = Initiation::granted();
    let opens = initiation.opens.clone();
    let unit_calls = Arc::new(AtomicUsize::new(0));
    let (status, body) = call(
        app(
            initiation,
            FailingUnit {
                calls: unit_calls.clone(),
            },
        ),
        Body::from(json!({"content":"hello","attachment_ids":["missing"]}).to_string()),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(
        body,
        json!({
            "error":"attachment does not belong to this channel",
            "code":"attachment_outside_channel",
            "attachment_id":"missing"
        })
    );
    assert_eq!(opens.load(Ordering::SeqCst), 1);
    assert_eq!(unit_calls.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn success_is_the_existing_human_send_ack_at_201() {
    let initiation = Initiation::granted();
    let opens = initiation.opens.clone();
    let unit_calls = Arc::new(AtomicUsize::new(0));
    let (status, body) = call(
        app(
            initiation,
            SuccessUnit {
                calls: unit_calls.clone(),
            },
        ),
        Body::from(json!({"content":"hello"}).to_string()),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::CREATED);
    assert_eq!(body["message"]["conversation_id"], "pair-1");
    assert_eq!(body["message"]["from_kind"], "user");
    assert_eq!(body["message"]["content"], "hello");
    assert_eq!(body.get("unresolved_references"), None);
    assert_eq!(opens.load(Ordering::SeqCst), 1);
    assert_eq!(unit_calls.load(Ordering::SeqCst), 1);
}

#[derive(Clone)]
struct FixedEnvironment;

impl SendClock for FixedEnvironment {
    fn now_unix_ms(&self) -> Result<i64, EnvironmentUnavailable> {
        Ok(77)
    }
}

impl SendEntropy for FixedEnvironment {
    fn fill(&self, bytes: &mut [u8]) -> Result<(), EnvironmentUnavailable> {
        bytes.fill(7);
        Ok(())
    }
}

async fn seeded_store() -> (
    tempfile::TempDir,
    std::path::PathBuf,
    MessagingStore<FixedEnvironment>,
) {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("direct-pair-initiation-wire.sqlite");
    let mut db = crate::current_schema::create_current_schema(&path).await;
    db.execute(sqlx::raw_sql(
        "INSERT INTO users(id,name,display_name,created_at,updated_at) VALUES \
           ('local','local-test','Local Test User',1,1), \
           ('other','other-test','Other Test User',1,1); \
         INSERT INTO hosts(id,name,kind,created_at) VALUES \
           ('host-1','Host','local',1); \
         INSERT INTO agents(id,name,runtime,host_id,display_name,created_by_user_id, \
           session_scope,materialization_status,created_at,updated_at) VALUES \
           ('agent-1','assistant','claude','host-1','Assistant','local', \
           'agent','active',1,1), \
           ('agent-frame','frame','claude','host-1','Frame','local', \
           'conversation','active',1,1), \
           ('agent-hidden','hidden','claude','host-1','Hidden','other', \
           'agent','active',1,1);",
    ))
    .await
    .unwrap();
    db.close().await.unwrap();
    let store = MessagingStore::open_with(&path, FixedEnvironment)
        .await
        .unwrap();
    (directory, path, store)
}

#[tokio::test]
async fn production_sqlite_route_keeps_a_minted_pair_when_the_existing_send_unit_refuses() {
    let (_directory, path, store) = seeded_store().await;
    let opened = Opened(Arc::new(AtomicUsize::new(0)));
    let app = router(
        store.clone().bind_initiation(opened.clone()),
        store.clone(),
        store.clone(),
        NoAftermath,
    )
    .layer(Extension(user("local")));

    let (status, body) = call(
        app.clone(),
        Body::from(json!({"content":"hello","attachment_ids":["missing"]}).to_string()),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(body["code"], "attachment_outside_channel");
    assert_eq!(opened.0.load(Ordering::SeqCst), 1);
    let mut db = sqlx::SqliteConnection::connect(path.to_str().unwrap())
        .await
        .unwrap();
    let pair_count: i64 = sqlx::query_scalar("SELECT count(*) FROM conversations")
        .fetch_one(&mut db)
        .await
        .unwrap();
    let message_count: i64 = sqlx::query_scalar("SELECT count(*) FROM messages")
        .fetch_one(&mut db)
        .await
        .unwrap();
    assert_eq!((pair_count, message_count), (1, 0));

    let (status, body) = call(
        app,
        Body::from(json!({"content":"hello"}).to_string()),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::CREATED);
    assert!(body["message"]["conversation_id"].as_str().is_some());
    assert_eq!(body["message"]["content"], "hello");
    assert_eq!(opened.0.load(Ordering::SeqCst), 1);
    let pair_count: i64 = sqlx::query_scalar("SELECT count(*) FROM conversations")
        .fetch_one(&mut db)
        .await
        .unwrap();
    let message_count: i64 = sqlx::query_scalar("SELECT count(*) FROM messages")
        .fetch_one(&mut db)
        .await
        .unwrap();
    assert_eq!((pair_count, message_count), (1, 1));
}

fn fixture() -> Vec<Value> {
    serde_json::from_str(include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../../rust/test-fixtures/fixtures/direct-pair-initiation-wire.json"
    )))
    .unwrap()
}

fn fixture_request(entry: &Value) -> Value {
    match entry.get("request_case").and_then(Value::as_str) {
        None => entry["request"].clone(),
        Some("content_over_limit") => json!({"content":"x".repeat(65_537)}),
        Some("malformed_json") => json!({}),
        Some(other) => panic!("unknown initiation request case {other}"),
    }
}

fn fixture_raw(entry: &Value) -> String {
    match entry.get("request_case").and_then(Value::as_str) {
        Some("malformed_json") => "{".into(),
        _ => serde_json::to_string(&fixture_request(entry)).unwrap(),
    }
}

fn fixture_body(entry: &Value, fixture: &[Value]) -> Value {
    let Some(name) = entry.get("body_case").and_then(Value::as_str) else {
        return entry["body"].clone();
    };
    fixture_body(
        fixture
            .iter()
            .find(|candidate| candidate["name"] == name)
            .unwrap(),
        fixture,
    )
}

fn normalize_success(mut body: Value) -> Value {
    let Some(message) = body.get_mut("message").and_then(Value::as_object_mut) else {
        return body;
    };
    message.insert("id".into(), json!("message"));
    message.insert("conversation_id".into(), json!("pair"));
    message.insert("created_at".into(), json!(77));
    body
}

#[tokio::test]
async fn production_sqlite_router_consumes_every_typescript_signed_wire_cell() {
    let fixture = fixture();
    for entry in &fixture {
        let (_directory, path, store) = seeded_store().await;
        let opened = Opened(Arc::new(AtomicUsize::new(0)));
        let app = router(
            store.clone().bind_initiation(opened.clone()),
            store.clone(),
            store,
            NoAftermath,
        )
        .layer(Extension(user("local")));
        let (status, body) = call_path(
            app,
            entry["target"].as_str().unwrap(),
            Body::from(fixture_raw(entry)),
            None,
        )
        .await;
        // The `admission_only` cells sign only that the schema REFUSES the body: the TS
        // parity wire test skips them (`if (entry.admission_only) continue;`) because
        // their fixture body is the pre-migration Zod issue list, not a mounted wire. In
        // the shared governance model every one is the single semantic refusal
        // `422 {"error":"invalid input"}`, and none mints a pair — so this consumer
        // branches exactly as the TS test does rather than reading that schema-level body.
        if entry.get("admission_only").and_then(Value::as_bool) == Some(true) {
            assert_eq!(
                status,
                StatusCode::UNPROCESSABLE_ENTITY,
                "{}",
                entry["name"]
            );
            assert_eq!(
                body,
                json!({ "error": "invalid input" }),
                "{}",
                entry["name"]
            );
        } else {
            assert_eq!(
                status.as_u16(),
                entry["status"].as_u64().unwrap() as u16,
                "{}",
                entry["name"]
            );
            assert_eq!(
                normalize_success(body),
                fixture_body(entry, &fixture),
                "{}",
                entry["name"]
            );
        }

        let mut db = sqlx::SqliteConnection::connect(path.to_str().unwrap())
            .await
            .unwrap();
        let pair_count: i64 = sqlx::query_scalar("SELECT count(*) FROM conversations")
            .fetch_one(&mut db)
            .await
            .unwrap();
        let message_count: i64 = sqlx::query_scalar("SELECT count(*) FROM messages")
            .fetch_one(&mut db)
            .await
            .unwrap();
        let name = entry["name"].as_str().unwrap();
        let expected = match name {
            "send_refusal_keeps_minted_pair" => (1, 0, 1),
            "unknown_keys_are_stripped" | "created" => (1, 1, 1),
            _ => (0, 0, 0),
        };
        assert_eq!(
            (pair_count, message_count, opened.0.load(Ordering::SeqCst)),
            expected,
            "{name}"
        );
    }
}
