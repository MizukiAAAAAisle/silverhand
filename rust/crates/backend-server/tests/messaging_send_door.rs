//! The two message-send routes as an operator and a caller see them, end to end.
//!
//! Everything here goes through the real [`send_router`]. An earlier version of this
//! suite mounted the stages under a hand-built router with a `200 reached` stub for its
//! terminal answer, which proved the fence worked under a router production does not
//! have — and could not have caught a handler that took its destination from the wrong
//! coordinate, because the stub had no destination at all.
//!
//! Three contracts live here that no unit test can hold:
//!
//! - the ingress ORDER over real HTTP: the fence before anything, then the path
//!   coordinate, then the shape, then the content cap;
//! - how MANY times a failure is reported — a future edit that logged the cause in the
//!   middleware and again in a renderer would leave every unit test green while doubling
//!   the noise an operator has to read (@Cindy, review of `2bb73d7c`);
//! - that each door's gate order survives being mounted. The order is decided in the
//!   adapters, but a router that reached for the body before dispatching would break it
//!   without touching them.

use std::{
    io::{self, Write},
    sync::{
        Arc, Mutex,
        atomic::{AtomicUsize, Ordering},
    },
};

use axum::{
    Router,
    body::{Body, Bytes},
    http::{Request, StatusCode, header::CONTENT_LENGTH},
};
use futures_util::stream;
use serde_json::Value;
use silverhand_backend_core::messaging::{
    AddressedPrincipals, AgentId, ConversationId, ConversationRefusal, DirectLineAuthority,
    MessageCreatedFact, PrincipalKind, SendMessage, SendMessageError, SendMessageUnitOfWork,
    UserId,
};
use silverhand_backend_core::persistence::PersistenceFailure;
use silverhand_backend_server::messaging::{
    MESSAGE_SEND_MAX_BODY_BYTES,
    adapters::{ChannelAccess, ChannelAccessRefusal, ResolvedStream, TargetAccess, TargetRefusal},
    router::{AgentPrincipal, HumanPrincipal, SendState, send_router},
};
use tower::ServiceExt;
use tracing_subscriber::fmt::MakeWriter;

const FRAME_CAUSE: &str = "upstream frame source vanished";

const HUMAN_PATH: &str = "/api/channels/conv-1/messages";
const AGENT_PATH: &str = "/internal/agents/agent-1/send-message";
const HUMAN_PATH_WITHOUT_ID: &str = "/api/channels//messages";
const AGENT_PATH_WITHOUT_ID: &str = "/internal/agents//send-message";

#[derive(Debug, thiserror::Error)]
#[error("upstream frame source vanished")]
struct FrameSourceGone;

/// A body that delivers real bytes and then fails, with no declared length. The prefix
/// matters: part of the read had already succeeded, so the failure cannot be mistaken
/// for an empty body.
fn breaks_after_one_frame() -> Body {
    Body::from_stream(stream::iter(vec![
        Ok::<Bytes, FrameSourceGone>(Bytes::from_static(b"{\"content\":\"hi\"}")),
        Err(FrameSourceGone),
    ]))
}

/// The human gate: a predicate, which is all the port can express.
struct Channel(Result<(), ChannelAccessRefusal>);

impl ChannelAccess for Channel {
    fn may_post(
        &self,
        _channel: &ConversationId,
        _author: &UserId,
    ) -> Result<(), ChannelAccessRefusal> {
        self.0.clone()
    }
}

/// Resolves every address to one fixed main-line stream, or refuses. The grammar that
/// reads an address is not restated here; what a test needs is where one landed.
struct Target(Result<(), TargetRefusal>);

impl TargetAccess for Target {
    fn resolve(&self, _agent: &AgentId, _target: &str) -> Result<ResolvedStream, TargetRefusal> {
        self.0.clone().map(|()| ResolvedStream {
            conversation: ConversationId::parse("conv-2").unwrap(),
            thread_root: None,
        })
    }
}

struct GrantsNothing;

impl DirectLineAuthority for GrantsNothing {
    fn direct_lines(
        &self,
        _author: &UserId,
        _addressed: &AddressedPrincipals,
    ) -> Result<Vec<AgentId>, PersistenceFailure> {
        Ok(Vec::new())
    }
}

/// Which side of the write unit's failure this fake plays: a refusal the caller can act on,
/// or a failure of ours. The two are answered AND reported differently, and that difference
/// is only observable at the boundary.
#[derive(Clone, Copy, Default)]
enum Fails {
    #[default]
    AsRefusal,
    /// Our own store, broken, with a named cause underneath.
    AsOurFailure,
}

const UNDERLYING_CAUSE: &str = "the write-ahead log is unreadable";

#[derive(Debug, thiserror::Error)]
#[error("the write-ahead log is unreadable")]
struct StoreBroken;

/// Counts what it was asked to commit. "Reached the write unit" is the only honest way
/// to say a request got all the way through, now that there is no stub answer standing
/// in for one.
#[derive(Clone, Default)]
struct CountingUnitOfWork(Arc<AtomicUsize>, Fails, Arc<Mutex<Vec<String>>>);

impl CountingUnitOfWork {
    fn failing(how: Fails) -> Self {
        Self(Arc::default(), how, Arc::default())
    }

    fn calls(&self) -> usize {
        self.0.load(Ordering::SeqCst)
    }

    /// Who the commands it was handed addressed, as the send itself derived it.
    fn addressed(&self) -> Vec<String> {
        self.2.lock().unwrap().clone()
    }
}

impl SendMessageUnitOfWork for CountingUnitOfWork {
    async fn send_message(
        &self,
        command: SendMessage,
    ) -> Result<MessageCreatedFact, SendMessageError> {
        self.0.fetch_add(1, Ordering::SeqCst);
        self.2
            .lock()
            .unwrap()
            .extend(command.addressed().iter().map(|reference| {
                let kind = match reference.kind() {
                    PrincipalKind::Agent => "agent",
                    PrincipalKind::Human => "human",
                };
                format!("{kind}/{}", reference.handle().as_str())
            }));
        // A fact needs a committed transaction, which a fake has not got. Recording the
        // attempt, and which KIND of failure follows it, is the whole purpose.
        Err(match self.1 {
            Fails::AsRefusal => ConversationRefusal::NotFound.into(),
            Fails::AsOurFailure => PersistenceFailure::from_source(StoreBroken).into(),
        })
    }
}

fn mounted(
    channel: Result<(), ChannelAccessRefusal>,
    target: Result<(), TargetRefusal>,
    unit: CountingUnitOfWork,
) -> Router {
    send_router(SendState {
        channel_access: Channel(channel),
        target_access: Target(target),
        authority: GrantsNothing,
        unit_of_work: unit,
    })
}

/// Both gates open, so whatever answers is the request's own doing.
fn open(unit: CountingUnitOfWork) -> Router {
    mounted(Ok(()), Ok(()), unit)
}

fn human_request(path: &str, body: Body) -> Request<Body> {
    let mut request = Request::post(path).body(body).unwrap();
    request
        .extensions_mut()
        .insert(HumanPrincipal(UserId::parse("user-1").unwrap()));
    request
}

fn agent_request(path: &str, body: Body) -> Request<Body> {
    let mut request = Request::post(path).body(body).unwrap();
    request.extensions_mut().insert(AgentPrincipal {
        agent: AgentId::parse("agent-1").unwrap(),
        source: ConversationId::parse("conv-1").unwrap(),
    });
    request
}

/// One request, and everything an operator and a caller each saw. Both doors go through this
/// helper on purpose: a future adapter that added a report of its own would have to defeat the
/// same assertion twice.
async fn observed(router: Router, request: Request<Body>) -> (StatusCode, String, Vec<Value>) {
    let logs = LogBuffer::default();
    let subscriber = tracing_subscriber::fmt()
        .json()
        .without_time()
        .with_target(false)
        .with_writer(logs.clone())
        .finish();
    let guard = tracing::subscriber::set_default(subscriber);
    let (status, body) = answered(router, request).await;
    drop(guard);
    let errors = logs
        .events()
        .into_iter()
        .filter(|event| event["level"] == "ERROR")
        .collect();
    (status, body, errors)
}

async fn answered(router: Router, request: Request<Body>) -> (StatusCode, String) {
    let response = router.oneshot(request).await.unwrap();
    let status = response.status();
    let body = String::from_utf8(
        axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap()
            .to_vec(),
    )
    .unwrap();
    (status, body)
}

/// A legal human body whose content is exactly `content_bytes` long.
fn human_send_body(content_bytes: usize) -> String {
    format!(r#"{{"content":"{}"}}"#, "a".repeat(content_bytes))
}

/// The agent equivalent. It carries an address because that door requires one, which is
/// also why the two envelopes are not the same size. The address itself is arbitrary:
/// its grammar belongs to the resolver, and the fake above ignores it.
fn agent_send_body(content_bytes: usize) -> String {
    format!(
        r#"{{"content":"{}","target":"conv-2"}}"#,
        "a".repeat(content_bytes)
    )
}

/// A body over the bound, DECLARED, on a request that also names no identifier AND
/// carries no principal.
///
/// The cross is the point: either of the other two faults would be answered by the
/// handler, so a 413 here can only mean the fence ran before the handler existed as far
/// as this request is concerned. It pins "envelope first" rather than "envelope before
/// parsing".
#[tokio::test]
async fn a_declared_oversize_body_is_refused_before_any_other_fault() {
    for path in [HUMAN_PATH_WITHOUT_ID, AGENT_PATH_WITHOUT_ID] {
        let unit = CountingUnitOfWork::default();
        let oversized = "a".repeat(MESSAGE_SEND_MAX_BODY_BYTES + 1);
        let request = Request::post(path)
            .header(CONTENT_LENGTH, oversized.len())
            .body(Body::from(oversized))
            .unwrap();

        let (status, body) = answered(open(unit.clone()), request).await;

        assert_eq!(status, StatusCode::PAYLOAD_TOO_LARGE, "{path}");
        assert!(
            body.contains("request body exceeds message-send bound"),
            "{path}"
        );
        assert!(body.contains(r#""code":"content_too_large""#), "{path}");
        assert!(body.contains(r#""max_body_bytes":524288"#), "{path}");
        assert_eq!(unit.calls(), 0, "{path}");
    }
}

/// The same cross with the size UNDECLARED, which is the cell that kills a
/// limited-extractor design: nothing about this request would ever have reached for the
/// body, so a limit that only applies to extraction never fires and the answer degrades
/// to whichever fault the handler found first.
#[tokio::test]
async fn a_chunked_oversize_body_is_refused_before_any_other_fault() {
    for path in [HUMAN_PATH_WITHOUT_ID, AGENT_PATH_WITHOUT_ID] {
        let request = Request::post(path)
            .body(Body::from("a".repeat(MESSAGE_SEND_MAX_BODY_BYTES + 1)))
            .unwrap();

        let (status, body) = answered(open(CountingUnitOfWork::default()), request).await;

        assert_eq!(status, StatusCode::PAYLOAD_TOO_LARGE, "{path}");
        assert!(
            body.contains("request body exceeds message-send bound"),
            "{path}"
        );
    }
}

/// The bound is exact, and it bounds the ENVELOPE rather than the content: a body of
/// precisely the bound gets past the fence and is answered by a LATER gate, and one byte
/// more does not get that far.
#[tokio::test]
async fn the_envelope_bound_admits_its_own_size_and_nothing_over() {
    let envelope = agent_send_body(0).len();
    let at_bound = agent_send_body(MESSAGE_SEND_MAX_BODY_BYTES - envelope);
    assert_eq!(at_bound.len(), MESSAGE_SEND_MAX_BODY_BYTES);

    // At the bound the fence passes it on, and the CONTENT cap is what answers — a
    // different gate with a different body, so the fence is not the thing refusing it.
    let (status, body) = answered(
        open(CountingUnitOfWork::default()),
        agent_request(AGENT_PATH, Body::from(at_bound)),
    )
    .await;
    assert_eq!(status, StatusCode::PAYLOAD_TOO_LARGE);
    assert!(body.contains("message content exceeds"), "{body}");
    assert!(!body.contains("max_body_bytes"), "{body}");

    let over = agent_send_body(MESSAGE_SEND_MAX_BODY_BYTES - envelope + 1);
    assert_eq!(over.len(), MESSAGE_SEND_MAX_BODY_BYTES + 1);
    let (status, body) = answered(
        open(CountingUnitOfWork::default()),
        agent_request(AGENT_PATH, Body::from(over)),
    )
    .await;
    assert_eq!(status, StatusCode::PAYLOAD_TOO_LARGE);
    assert!(
        body.contains("request body exceeds message-send bound"),
        "{body}"
    );
}

/// Once the envelope is admitted, a missing path parameter is answered before the body
/// is read at all — and each door names its own coordinate.
#[tokio::test]
async fn a_missing_identifier_answers_before_the_body_is_parsed() {
    let unit = CountingUnitOfWork::default();
    // The body is malformed too. If parsing came first this would be `invalid input`;
    // the identifier wins.
    let unparseable = || Body::from("not json at all");

    let (human_status, human_body) = answered(
        open(unit.clone()),
        human_request(HUMAN_PATH_WITHOUT_ID, unparseable()),
    )
    .await;
    assert_eq!(human_status, StatusCode::BAD_REQUEST);
    assert!(human_body.contains("channel id required"), "{human_body}");

    let (agent_status, agent_body) = answered(
        open(unit.clone()),
        agent_request(AGENT_PATH_WITHOUT_ID, unparseable()),
    )
    .await;
    assert_eq!(agent_status, StatusCode::BAD_REQUEST);
    assert!(agent_body.contains("agent id required"), "{agent_body}");

    assert_eq!(unit.calls(), 0);
}

/// Shape before size: a body that is both the wrong shape AND oversized is answered as
/// the wrong shape, with privacy-safe issues and no echo of what was sent.
#[tokio::test]
async fn an_invalid_shape_answers_before_the_content_cap() {
    let oversized_but_not_a_string = format!(r#"{{"content":{}}}"#, "1".repeat(70_000));

    let (status, body) = answered(
        open(CountingUnitOfWork::default()),
        agent_request(AGENT_PATH, Body::from(oversized_but_not_a_string)),
    )
    .await;

    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert!(body.contains(r#""error":"invalid input""#), "{body}");
    assert!(body.contains(r#""code":"invalid_type""#), "{body}");
    assert!(body.contains(r#""path":["content"]"#), "{body}");
    assert!(
        !body.contains("111"),
        "the refusal echoed the value: {body}"
    );
}

/// The two doors word the same bound differently, and the difference is the contract: a
/// runtime is told what to do instead, a person is not.
#[tokio::test]
async fn each_door_words_the_content_cap_for_its_own_caller() {
    let unit = CountingUnitOfWork::default();

    let (agent_status, agent_body) = answered(
        open(unit.clone()),
        agent_request(AGENT_PATH, Body::from(agent_send_body(65_537))),
    )
    .await;
    let (human_status, human_body) = answered(
        open(unit.clone()),
        human_request(HUMAN_PATH, Body::from(human_send_body(65_537))),
    )
    .await;

    assert_eq!(agent_status, StatusCode::PAYLOAD_TOO_LARGE);
    assert_eq!(human_status, StatusCode::PAYLOAD_TOO_LARGE);
    assert!(
        agent_body
            .contains("message content exceeds 64KiB limit; send it as an attachment instead"),
        "{agent_body}"
    );
    assert!(
        human_body.contains(r#""error":"message content exceeds 64KiB limit""#),
        "{human_body}"
    );
    // The human door must not acquire the agent's instruction.
    assert!(!human_body.contains("attachment"), "{human_body}");
    // Both report the same two bounds.
    for body in [&agent_body, &human_body] {
        assert!(body.contains(r#""max_bytes":65536"#), "{body}");
        assert!(body.contains(r#""actual_bytes":65537"#), "{body}");
    }
    assert_eq!(unit.calls(), 0);
}

/// A LEGAL JSON BODY THAT IS NOT AN OBJECT is answered about the document, and the empty
/// path survives all the way to the wire.
///
/// `path: []` is the observable half: a renderer that dropped an empty array, or a door that
/// went looking for fields a number does not have, would both still answer 400 — so the
/// status is not the assertion here, the body is.
#[tokio::test]
async fn a_non_object_body_is_refused_at_the_root_on_both_doors() {
    let unit = CountingUnitOfWork::default();

    for root in ["7", "null", "[]", "\"x\""] {
        let (human_status, human_body) = answered(
            open(unit.clone()),
            human_request(HUMAN_PATH, Body::from(root)),
        )
        .await;
        let (agent_status, agent_body) = answered(
            open(unit.clone()),
            agent_request(AGENT_PATH, Body::from(root)),
        )
        .await;

        for (status, body) in [(human_status, &human_body), (agent_status, &agent_body)] {
            assert_eq!(status, StatusCode::BAD_REQUEST, "{root}");
            assert_eq!(
                serde_json::from_str::<Value>(body).unwrap(),
                serde_json::json!({
                    "error": "invalid input",
                    "issues": [{"code": "invalid_type", "path": []}]
                }),
                "{root}"
            );
        }
        // Neither door invented a missing field — the agent door in particular does not
        // report its required `target` against a body that has no fields.
        assert!(!agent_body.contains("target"), "{root}: {agent_body}");
    }

    assert_eq!(unit.calls(), 0);
}

/// THE SAME REQUEST AT BOTH DOORS, mounted. One body, malformed, aimed at a gate that
/// also refuses: the human door answers its gate and the agent door answers the body.
///
/// This is the ordering contract surviving the router. A handler that read and judged the
/// body before dispatching — the obvious way to share work between two routes — would
/// answer both of these the same way, and a person who may not post to a channel would
/// learn how their body was judged there.
#[tokio::test]
async fn one_faulty_request_is_answered_by_whichever_gate_its_own_door_asks_first() {
    let unit = CountingUnitOfWork::default();
    let closed = || {
        mounted(
            Err(ChannelAccessRefusal::Forbidden),
            Err(TargetRefusal::CapabilityDenied),
            unit.clone(),
        )
    };
    let malformed = || Body::from(r#"{"content":7}"#);

    let (human_status, human_body) =
        answered(closed(), human_request(HUMAN_PATH, malformed())).await;
    assert_eq!(human_status, StatusCode::FORBIDDEN);
    // The gate's own body, which carries no code: the reference's does not either.
    assert_eq!(
        serde_json::from_str::<Value>(&human_body).unwrap(),
        serde_json::json!({"error": "forbidden"})
    );

    let (agent_status, agent_body) =
        answered(closed(), agent_request(AGENT_PATH, malformed())).await;
    assert_eq!(agent_status, StatusCode::BAD_REQUEST);
    assert!(agent_body.contains("invalid input"), "{agent_body}");
    assert!(!agent_body.contains("forbidden"), "{agent_body}");

    // Neither reached the write unit, which is what makes both answers refusals rather
    // than reports of something that already happened.
    assert_eq!(unit.calls(), 0);
}

/// A body within every bound reaches the WRITE UNIT — through the real router, for both
/// principals — and the refusal it meets there comes back as the refusal it IS.
///
/// The fake write unit refuses with "conversation not found", so this is the whole path in
/// one cell: door, gates, write unit, projection, wire. Without it the refusals above could
/// all be an accident of something else failing, and the projection could be correct in
/// isolation while reaching neither door.
#[tokio::test]
async fn a_well_shaped_body_reaches_the_write_unit_and_its_refusal_reaches_the_caller() {
    let unit = CountingUnitOfWork::default();
    let refused = serde_json::json!({
        "error": "conversation not found",
        "code": "conversation_not_found"
    });

    for (label, request) in both_doors() {
        let (status, body, errors) = observed(open(unit.clone()), request).await;

        assert_eq!(status, StatusCode::NOT_FOUND, "{label}");
        assert_eq!(
            serde_json::from_str::<Value>(&body).unwrap(),
            refused,
            "{label}"
        );
        // A REFUSAL IS NOT AN INCIDENT. One line per refused send tells an operator nothing
        // and buries the failures that are ours — and this boundary is where a door that
        // logged its own copy would show up.
        assert!(errors.is_empty(), "{label}: {errors:?}");
    }
    assert_eq!(unit.calls(), 2);
}

/// OUR OWN FAILURE, through both real doors: answered safely, and reported EXACTLY ONCE.
///
/// The unit tests beside the projection prove the split; what they cannot see is a second
/// report added by a route, a middleware or a future adapter. This lane has already made that
/// mistake once, at the ingress fence, so it is asserted at the boundary rather than trusted.
#[tokio::test(flavor = "current_thread")]
async fn our_own_failure_is_answered_safely_and_reported_once_at_either_door() {
    for (label, request) in both_doors() {
        let unit = CountingUnitOfWork::failing(Fails::AsOurFailure);
        let (status, body, errors) = observed(open(unit.clone()), request).await;

        assert_eq!(unit.calls(), 1, "{label}");
        assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR, "{label}");
        // Not JSON, so there is no code or reason for a client to branch on…
        assert!(
            serde_json::from_str::<Value>(&body).is_err(),
            "{label}: {body}"
        );
        // …and nothing of the cause reaches them.
        assert!(!body.contains(UNDERLYING_CAUSE), "{label}: {body}");
        assert!(!body.contains("persistence"), "{label}: {body}");

        // ONE report, with the whole chain. Not "at least one": a second would leave an
        // operator unable to tell one broken request from two.
        assert_eq!(errors.len(), 1, "{label}: {errors:?}");
        let chain = errors[0]["fields"]["error_chain"].as_str().unwrap();
        assert!(
            chain.contains("persistence operation failed"),
            "{label}: {chain}"
        );
        assert!(chain.contains(UNDERLYING_CAUSE), "{label}: {chain}");
    }
}

/// Four principals, one per position, with NO source indentation able to reach the body.
///
/// Written as `concat!` fragments that each begin at column 0. A line-continuation escape
/// looked equivalent and was not: `cargo fmt` reflowed the literal onto one line and kept the
/// alignment spaces it had introduced, so every line after the first arrived with twenty
/// leading spaces — which makes all three of them INDENTED CODE BLOCKS. The cell still passed,
/// because one cause was quietly explaining three exclusions (@Cindy, review of `7e3402d2`).
const FOUR_POSITIONS: &str = concat!(
    "hi <silverhand://agent/Alice>\n",
    "\n",
    "> quoting <silverhand://human/shiki>\n",
    "\n",
    "`<silverhand://agent/Bob>`\n",
    "\n",
    "[Dana](silverhand://agent/Dana)",
);

/// The same four in PROSE, which is the control: it proves each of them CAN address, so an
/// empty answer below means the position refused it — not that the handle was unparseable, and
/// not that the line had quietly become something else.
const FOUR_IN_PROSE: &str = concat!(
    "hi <silverhand://agent/Alice>\n",
    "\n",
    "quoting <silverhand://human/shiki>\n",
    "\n",
    "<silverhand://agent/Bob>\n",
    "\n",
    "<silverhand://agent/Dana>",
);

fn sent(content: &str) -> Body {
    Body::from(serde_json::json!({ "content": content }).to_string())
}

/// Who a body addresses once it has gone all the way through the real route.
async fn addressed_through_the_route(content: &str) -> Vec<String> {
    let unit = CountingUnitOfWork::default();
    let (status, _) = answered(open(unit.clone()), human_request(HUMAN_PATH, sent(content))).await;

    // It reached the write unit, so what follows is a real derivation and not the silence of a
    // request that never got there.
    assert_eq!(status, StatusCode::NOT_FOUND, "{content:?}");
    assert_eq!(unit.calls(), 1, "{content:?}");
    unit.addressed()
}

/// THE POSITION RULE IS THE PRODUCT'S, not the composition's.
///
/// Asserted on the command the REAL router handed the write unit, so it is the send's own
/// answer rather than the rule's in isolation. Both ways of getting the wiring wrong are
/// caught: a route with a no-op rule addresses nobody, and a permissive one that took every
/// bracketed run would add the quoted and quoted-syntax names. Neither is expressible any more
/// — the route has no position parameter — and this is what would go red if one came back.
#[tokio::test]
async fn only_prose_addresses_and_the_route_decides_that_not_its_composition() {
    // The BYTES, not the source layout. This is the check the earlier version of this cell
    // needed and did not have.
    for line in FOUR_POSITIONS.lines().chain(FOUR_IN_PROSE.lines()) {
        assert!(
            !line.starts_with(' '),
            "source indentation reached the body: {line:?}"
        );
    }

    // THE CONTROL. All four in prose, so all four address, in first-occurrence order.
    assert_eq!(
        addressed_through_the_route(FOUR_IN_PROSE).await,
        ["agent/Alice", "human/shiki", "agent/Bob", "agent/Dana"]
    );

    // THE SUBJECT. The same four, three of them moved into a blockquote, a code span and a
    // label-carrying link — and only the one still in prose addresses.
    assert_eq!(
        addressed_through_the_route(FOUR_POSITIONS).await,
        ["agent/Alice"]
    );

    // And each excluded position on its own, so no single cause can stand in for three.
    for (position, content) in [
        ("blockquote", "> quoting <silverhand://human/shiki>"),
        ("code span", "`<silverhand://agent/Bob>`"),
        ("label link", "[Dana](silverhand://agent/Dana)"),
    ] {
        assert!(
            addressed_through_the_route(content).await.is_empty(),
            "{position} addressed someone"
        );
    }
}

/// EVERY TARGET REFUSAL, exactly as an agent receives it.
///
/// One table, because the interesting part is that the statuses DISAGREE across the six and
/// only disagree where the fact does. A token judgement is a 400 and says nothing about what
/// exists; the two existence answers are one 404, which is what stops this door from becoming
/// an oracle that separates unknown from unauthorized by status; and a 403 appears only where
/// the address was right and the credential is the limit.
#[tokio::test]
async fn each_target_refusal_reaches_the_agent_in_its_own_words() {
    let cases: Vec<(TargetRefusal, StatusCode, serde_json::Value)> = vec![
        (
            TargetRefusal::Malformed,
            StatusCode::BAD_REQUEST,
            serde_json::json!({
                "error": "target is not an address",
                "code": "target_malformed"
            }),
        ),
        (
            TargetRefusal::SelfPair,
            StatusCode::BAD_REQUEST,
            serde_json::json!({
                "error": "a direct message needs another participant",
                "code": "self_pair_not_addressable"
            }),
        ),
        (
            TargetRefusal::Unresolved,
            StatusCode::NOT_FOUND,
            serde_json::json!({
                "error": "target names no stream you can use",
                "code": "target_unresolved"
            }),
        ),
        (
            TargetRefusal::ThreadNotInTarget,
            StatusCode::NOT_FOUND,
            serde_json::json!({
                "error": "target names no reply cluster of that conversation",
                "code": "thread_not_in_target"
            }),
        ),
        (
            TargetRefusal::OutOfSessionScope,
            StatusCode::FORBIDDEN,
            serde_json::json!({
                "error": "this operation acts only in the conversation your session is anchored to",
                "code": "slot_out_of_scope"
            }),
        ),
        (
            // ITS OWN SHAPE: no `error` member, and the missing bucket twice. A client that
            // reads `code` to decide what to tell a human would get "forbidden" from a
            // codeless 403 and lose the one fact that makes the refusal actionable.
            TargetRefusal::CapabilityDenied,
            StatusCode::FORBIDDEN,
            serde_json::json!({
                "code": "capability_denied",
                "capability": "send_messages",
                "message": "missing 'send_messages' capability in this workspace",
                "details": { "capability": "send_messages" }
            }),
        ),
    ];

    for (refusal, status, body) in cases {
        let unit = CountingUnitOfWork::default();
        let (answered_status, answered_body) = answered(
            mounted(Ok(()), Err(refusal.clone()), unit.clone()),
            agent_request(AGENT_PATH, Body::from(agent_send_body(16))),
        )
        .await;

        assert_eq!(answered_status, status, "{refusal:?}");
        assert_eq!(
            serde_json::from_str::<Value>(&answered_body).unwrap(),
            body,
            "{refusal:?}"
        );
        // Every one of them refuses BEFORE the write unit: an address the door would not use
        // is not an address it may commit a message to.
        assert_eq!(unit.calls(), 0, "{refusal:?}");
    }
}

/// The two doors keep their own vocabularies. The human door's gate answers carry NO code,
/// because the reference draws no distinction there — and acquiring the agent door's codes
/// would publish a contract its clients never agreed to.
#[tokio::test]
async fn the_human_gate_does_not_borrow_the_agent_doors_codes() {
    for (refusal, status, error) in [
        (
            ChannelAccessRefusal::NotFound,
            StatusCode::NOT_FOUND,
            "channel not found",
        ),
        (
            ChannelAccessRefusal::Forbidden,
            StatusCode::FORBIDDEN,
            "forbidden",
        ),
    ] {
        let unit = CountingUnitOfWork::default();
        let (answered_status, body) = answered(
            mounted(Err(refusal.clone()), Ok(()), unit.clone()),
            human_request(HUMAN_PATH, Body::from(human_send_body(16))),
        )
        .await;

        assert_eq!(answered_status, status, "{refusal:?}");
        assert_eq!(
            serde_json::from_str::<Value>(&body).unwrap(),
            serde_json::json!({ "error": error }),
            "{refusal:?}"
        );
        assert_eq!(unit.calls(), 0, "{refusal:?}");
    }
}

/// One legal request per door, so a cell that is about the OUTCOME does not restate how a
/// request is shaped.
fn both_doors() -> Vec<(&'static str, Request<Body>)> {
    vec![
        (
            "human",
            human_request(HUMAN_PATH, Body::from(human_send_body(16))),
        ),
        (
            "agent",
            agent_request(AGENT_PATH, Body::from(agent_send_body(16))),
        ),
    ]
}

#[tokio::test(flavor = "current_thread")]
async fn an_unreadable_body_is_reported_exactly_once_and_never_to_the_caller() {
    let logs = LogBuffer::default();
    let subscriber = tracing_subscriber::fmt()
        .json()
        .without_time()
        .with_target(false)
        .with_writer(logs.clone())
        .finish();
    let _guard = tracing::subscriber::set_default(subscriber);

    let unit = CountingUnitOfWork::default();
    let (status, body) = answered(
        open(unit.clone()),
        agent_request(AGENT_PATH, breaks_after_one_frame()),
    )
    .await;

    assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR);
    assert_ne!(status, StatusCode::PAYLOAD_TOO_LARGE);
    assert_ne!(status, StatusCode::BAD_REQUEST);
    assert_eq!(unit.calls(), 0);

    let events = logs.events();
    let errors = events
        .iter()
        .filter(|event| event["level"] == "ERROR")
        .collect::<Vec<_>>();
    // ONE report. Not "at least one": a second would mean an operator reads the same
    // failure twice and cannot tell one broken request from two.
    assert_eq!(errors.len(), 1, "{events:?}");
    assert_eq!(
        errors[0]["fields"]["message"],
        "message-send request body could not be read"
    );
    assert!(
        errors[0]["fields"]["error_chain"]
            .as_str()
            .is_some_and(|chain| chain.contains(FRAME_CAUSE)),
        "{:?}",
        errors[0]["fields"]["error_chain"]
    );

    // The operator has the cause; the caller has none of it.
    assert!(!body.contains(FRAME_CAUSE), "{body}");
    assert!(!body.contains("content"), "{body}");
    assert!(!body.contains("invalid input"), "{body}");
    assert!(!body.contains("message-send bound"), "{body}");
}

/// A route reached without the principal its composition owes it refuses, and tells the
/// caller nothing about why. The alternative — an anonymous or default identity — would
/// attribute a send to someone who did not write it.
///
/// This is also what a router mounted without its authentication middleware looks like,
/// which is the state this slice is deliberately in.
#[tokio::test(flavor = "current_thread")]
async fn a_missing_principal_refuses_rather_than_inventing_one() {
    let logs = LogBuffer::default();
    let subscriber = tracing_subscriber::fmt()
        .json()
        .without_time()
        .with_target(false)
        .with_writer(logs.clone())
        .finish();
    let _guard = tracing::subscriber::set_default(subscriber);

    let unit = CountingUnitOfWork::default();
    for path in [HUMAN_PATH, AGENT_PATH] {
        let (status, body) = answered(
            open(unit.clone()),
            Request::post(path)
                .body(Body::from(r#"{"content":"hi","target":"conv-2"}"#))
                .unwrap(),
        )
        .await;

        assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR, "{path}");
        assert!(!body.contains("principal"), "{path}: {body}");
    }

    assert_eq!(unit.calls(), 0);
    assert_eq!(
        logs.events()
            .iter()
            .filter(|event| event["level"] == "ERROR")
            .count(),
        2
    );
}

#[derive(Clone, Default)]
struct LogBuffer(Arc<Mutex<Vec<u8>>>);

impl LogBuffer {
    fn events(&self) -> Vec<Value> {
        let bytes = self.0.lock().unwrap().clone();
        String::from_utf8(bytes)
            .unwrap()
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect()
    }
}

struct LogWriter(LogBuffer);

impl Write for LogWriter {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        self.0.0.lock().unwrap().extend_from_slice(bytes);
        Ok(bytes.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

impl<'a> MakeWriter<'a> for LogBuffer {
    type Writer = LogWriter;

    fn make_writer(&'a self) -> Self::Writer {
        LogWriter(self.clone())
    }
}
