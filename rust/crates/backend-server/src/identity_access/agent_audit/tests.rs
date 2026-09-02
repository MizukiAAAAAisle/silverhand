//! Behavioural falsifiers for the three owner-audit faces.
//!
//! Every test drives the real [`router`] with three fakes — a read port whose Stage A
//! and Stage B calls are counted separately, a counting audit sink, and a blob store
//! with a panic-on-read arm — so each contract clause has a test that goes red when it
//! breaks:
//!
//!  * anti-enum: a non-viewer and an absent agent are ONE `404`, before any data read;
//!  * owner floor: a viewer who is not the creator is `403`, before any data read;
//!  * participation: an owner who is not a party — and an absent conversation — are ONE
//!    `403`, indistinguishable;
//!  * attachment row: an absent or cross-conversation row is `404` with the blob store
//!    NEVER touched (a panicking store proves it);
//!  * audit effect: a success emits EXACTLY ONE typed event; every refusal, read fault
//!    and blob fault emits NONE;
//!  * source-bind: a bundle resolved for another agent or conversation is a safe `500`;
//!  * fail-closed: an absent principal is a `500` that reads nothing.

use std::{
    io,
    sync::{
        Arc, Mutex,
        atomic::{AtomicUsize, Ordering::SeqCst},
    },
};

use axum::{
    body::{Body, to_bytes},
    http::{Request, StatusCode, header},
};
use serde_json::{Value, json};
use silverhand_backend_core::{
    conversation_messaging::direct_pair_read::DirectPairCounterpart,
    conversation_messaging::messaging::{
        AttachmentId,
        collaboration::{
            attachment::{
                AttachmentContentType, AttachmentCreator, AttachmentFilename, AttachmentRecord,
            },
            conversation_message_window::ConversationMessageWindowRequest,
            conversation_ref::ConversationRosterPolicy,
        },
    },
    foundation::blob_store::{
        BlobDeleteOutcome, BlobNamespace, BlobRead, BlobReadOutcome, BlobStorageKey, BlobStore,
        StorageKind, StoredBlob,
    },
    foundation::identity::{AgentId, ConversationId, Principal, UserId, WorkspaceId},
    foundation::persistence::PersistenceFailure,
    identity_access::agent_audit_read::{
        AgentAuditEvent, AgentAuditReadModel, AgentAuditSink, AuditAttachmentBundle,
        AuditChatSummary, AuditChatsBundle, AuditSubjectFacts, AuditTranscriptBundle,
        AuditTranscriptWindow,
    },
    identity_access::agent_lifecycle::MaterializationStatus,
    identity_access::capability::agent_audit::AuditedConversation,
};
use tower::ServiceExt;

use super::router;

// ---- typed coordinates -----------------------------------------------------

fn user(id: &str) -> UserId {
    UserId::parse(id).expect("user id")
}

fn agent(id: &str) -> AgentId {
    AgentId::parse(id).expect("agent id")
}

fn conversation(id: &str) -> ConversationId {
    ConversationId::parse(id).expect("conversation id")
}

fn fail() -> PersistenceFailure {
    PersistenceFailure::from_source(io::Error::other("audit read gone"))
}

/// Which ACL/owner arm the subject facts put `viewer-1` in.
///
/// `Creator` makes `viewer-1` the row's creator, so both `can_view_agent` and the owner
/// gate admit. `Workspace` admits `viewer-1` through the workspace arm but gives the
/// creator a DISTINCT id, so the visibility floor passes yet the owner gate refuses —
/// the "logged in, may see the agent, but is not its owner" `403`. `NobodyRelevant`
/// puts `viewer-1` in no arm at all, the anti-enum `404`.
enum Arm {
    Creator,
    Workspace,
    NobodyRelevant,
}

fn arms(arm: Arm) -> (UserId, Vec<UserId>, Vec<UserId>) {
    match arm {
        Arm::Creator => (user("viewer-1"), vec![], vec![]),
        Arm::Workspace => (user("creator-user"), vec![], vec![user("viewer-1")]),
        Arm::NobodyRelevant => (
            user("someone-else"),
            vec![user("pair-peer")],
            vec![user("member")],
        ),
    }
}

fn subject_facts(source: &str, arm: Arm) -> AuditSubjectFacts {
    subject_facts_at(source, arm, MaterializationStatus::Active)
}

/// The same subject facts at a chosen lifecycle stage, so a test can put the Stage-B
/// snapshot in a non-active stage the active-only visibility floor must refuse.
fn subject_facts_at(source: &str, arm: Arm, status: MaterializationStatus) -> AuditSubjectFacts {
    let (creator, direct_pair, workspace) = arms(arm);
    AuditSubjectFacts::from_source(agent(source), creator, direct_pair, workspace, status)
}

fn audited(exists: bool, agent_participates: bool) -> AuditedConversation {
    AuditedConversation {
        exists,
        agent_participates,
    }
}

fn workspace_chat() -> AuditChatSummary {
    AuditChatSummary::Workspace {
        conversation_id: conversation("conv-ws"),
        roster_policy: ConversationRosterPolicy::Open,
        title: "General".to_string(),
        workspace_id: WorkspaceId::parse("ws-1").expect("workspace id"),
        workspace_name: "Acme".to_string(),
        archived_at: None,
        created_at: 1000,
    }
}

fn direct_pair_chat() -> AuditChatSummary {
    AuditChatSummary::DirectPair {
        conversation_id: conversation("conv-dp"),
        counterpart: DirectPairCounterpart::active_human(
            user("peer-1"),
            "peer-one".to_string(),
            "Peer One".to_string(),
            None,
        ),
        read_only: false,
        archived_at: Some(2000),
        created_at: 1500,
    }
}

/// One legal attachment row bound to `conv-1`, sized to `len` bytes.
fn attachment_record(len: i64) -> AttachmentRecord {
    AttachmentRecord::projected(
        AttachmentId::parse("att-1").expect("attachment id"),
        conversation("conv-1"),
        None,
        AttachmentFilename::parse("report.pdf").expect("filename"),
        len,
        AttachmentContentType::parse("application/pdf").expect("content type"),
        StoredBlob::new(
            StorageKind::Local,
            BlobStorageKey::parse("attachments/conv-1/blob-a1.bin").expect("blob key"),
        ),
        1,
        AttachmentCreator::Human(user("creator-user")),
        1000,
    )
    .expect("legal attachment row")
}

// ---- fakes -----------------------------------------------------------------

enum SubjectOutcome {
    Present(AuditSubjectFacts),
    Absent,
    Fails,
}

enum ChatsOutcome {
    Present(AuditChatsBundle),
    Absent,
    Fails,
}

enum TranscriptOutcome {
    Present(AuditTranscriptBundle),
    Absent,
    Fails,
}

enum AttachmentOutcome {
    Present(Box<AuditAttachmentBundle>),
    Absent,
    Fails,
}

/// A read port whose Stage A (`read_audit_subject`) and Stage B (the three data reads)
/// call counts are recorded separately, so a test can prove the expensive read never
/// ran when the cheap floor already refused.
#[derive(Clone)]
struct FakeAuditRead {
    subject: Arc<SubjectOutcome>,
    chats: Arc<ChatsOutcome>,
    transcript: Arc<TranscriptOutcome>,
    attachment: Arc<AttachmentOutcome>,
    stage_a: Arc<AtomicUsize>,
    stage_b: Arc<AtomicUsize>,
}

impl FakeAuditRead {
    fn new() -> Self {
        Self {
            subject: Arc::new(SubjectOutcome::Absent),
            chats: Arc::new(ChatsOutcome::Absent),
            transcript: Arc::new(TranscriptOutcome::Absent),
            attachment: Arc::new(AttachmentOutcome::Absent),
            stage_a: Arc::new(AtomicUsize::new(0)),
            stage_b: Arc::new(AtomicUsize::new(0)),
        }
    }

    fn subject(mut self, outcome: SubjectOutcome) -> Self {
        self.subject = Arc::new(outcome);
        self
    }

    fn chats(mut self, outcome: ChatsOutcome) -> Self {
        self.chats = Arc::new(outcome);
        self
    }

    fn transcript(mut self, outcome: TranscriptOutcome) -> Self {
        self.transcript = Arc::new(outcome);
        self
    }

    fn attachment(mut self, outcome: AttachmentOutcome) -> Self {
        self.attachment = Arc::new(outcome);
        self
    }
}

impl AgentAuditReadModel for FakeAuditRead {
    async fn read_audit_subject(
        &self,
        _agent: &AgentId,
    ) -> Result<Option<AuditSubjectFacts>, PersistenceFailure> {
        self.stage_a.fetch_add(1, SeqCst);
        match &*self.subject {
            SubjectOutcome::Present(facts) => Ok(Some(facts.clone())),
            SubjectOutcome::Absent => Ok(None),
            SubjectOutcome::Fails => Err(fail()),
        }
    }

    async fn read_audit_chats(
        &self,
        _principal: &Principal,
        _agent: &AgentId,
    ) -> Result<Option<AuditChatsBundle>, PersistenceFailure> {
        self.stage_b.fetch_add(1, SeqCst);
        match &*self.chats {
            ChatsOutcome::Present(bundle) => Ok(Some(bundle.clone())),
            ChatsOutcome::Absent => Ok(None),
            ChatsOutcome::Fails => Err(fail()),
        }
    }

    async fn read_audit_transcript(
        &self,
        _principal: &Principal,
        _agent: &AgentId,
        _conversation: &ConversationId,
        _request: &ConversationMessageWindowRequest,
    ) -> Result<Option<AuditTranscriptBundle>, PersistenceFailure> {
        self.stage_b.fetch_add(1, SeqCst);
        match &*self.transcript {
            TranscriptOutcome::Present(bundle) => Ok(Some(bundle.clone())),
            TranscriptOutcome::Absent => Ok(None),
            TranscriptOutcome::Fails => Err(fail()),
        }
    }

    async fn read_audit_attachment(
        &self,
        _principal: &Principal,
        _agent: &AgentId,
        _conversation: &ConversationId,
        _attachment: &AttachmentId,
    ) -> Result<Option<AuditAttachmentBundle>, PersistenceFailure> {
        self.stage_b.fetch_add(1, SeqCst);
        match &*self.attachment {
            AttachmentOutcome::Present(bundle) => Ok(Some(bundle.as_ref().clone())),
            AttachmentOutcome::Absent => Ok(None),
            AttachmentOutcome::Fails => Err(fail()),
        }
    }
}

/// Records every emitted audit event, so a test can assert EXACTLY ONE on success and
/// NONE on any refusal or failure.
#[derive(Clone)]
struct CountingSink {
    events: Arc<Mutex<Vec<AgentAuditEvent>>>,
}

impl CountingSink {
    fn new() -> Self {
        Self {
            events: Arc::new(Mutex::new(Vec::new())),
        }
    }

    fn events(&self) -> Vec<AgentAuditEvent> {
        self.events.lock().expect("sink lock").clone()
    }
}

impl AgentAuditSink for CountingSink {
    fn record(&self, event: AgentAuditEvent) {
        self.events.lock().expect("sink lock").push(event);
    }
}

/// A blob store whose `read` arm is chosen per test. `Panics` proves a code path never
/// reaches the store: any read at all aborts the test.
#[derive(Clone)]
enum FakeBlob {
    Found(Arc<Vec<u8>>),
    Missing,
    Errs,
    Panics,
}

impl FakeBlob {
    fn found(bytes: Vec<u8>) -> Self {
        Self::Found(Arc::new(bytes))
    }
}

impl BlobStore for FakeBlob {
    type Error = io::Error;

    async fn put(
        &self,
        _namespace: &BlobNamespace,
        _normalized_content_type: &str,
        _bytes: Vec<u8>,
    ) -> Result<StoredBlob, Self::Error> {
        unreachable!("the audit face never writes a blob")
    }

    async fn read(&self, _blob: &StoredBlob) -> Result<BlobReadOutcome, Self::Error> {
        match self {
            Self::Found(bytes) => Ok(BlobReadOutcome::Found(BlobRead::exact(
                bytes.as_ref().clone(),
            ))),
            Self::Missing => Ok(BlobReadOutcome::Missing),
            Self::Errs => Err(io::Error::other("blob store down")),
            Self::Panics => panic!("blob store must not be read on a refused/absent-row path"),
        }
    }

    async fn delete(&self, _blob: &StoredBlob) -> Result<BlobDeleteOutcome, Self::Error> {
        unreachable!("the audit face never deletes a blob")
    }
}

// ---- driver ----------------------------------------------------------------

struct Reply {
    status: StatusCode,
    body: Vec<u8>,
    content_type: Option<String>,
    content_length: Option<String>,
    content_disposition: Option<String>,
    cache_control: Option<String>,
    stage_a: usize,
    stage_b: usize,
    events: Vec<AgentAuditEvent>,
}

impl Reply {
    fn json(&self) -> Value {
        serde_json::from_slice(&self.body).expect("json body")
    }

    fn text(&self) -> String {
        String::from_utf8(self.body.clone()).expect("utf8 body")
    }
}

async fn run(
    reads: FakeAuditRead,
    blobs: FakeBlob,
    sink: CountingSink,
    uri: &str,
    with_principal: bool,
) -> Reply {
    let stage_a = reads.stage_a.clone();
    let stage_b = reads.stage_b.clone();
    let app = router(reads, blobs, sink.clone());
    let mut request = Request::get(uri);
    if with_principal {
        request = request.extension(user("viewer-1"));
    }
    let response = app
        .oneshot(request.body(Body::empty()).unwrap())
        .await
        .unwrap();
    let status = response.status();
    let header_text = |name: header::HeaderName| {
        response
            .headers()
            .get(&name)
            .map(|value| value.to_str().expect("ascii header").to_owned())
    };
    let content_type = header_text(header::CONTENT_TYPE);
    let content_length = header_text(header::CONTENT_LENGTH);
    let content_disposition = header_text(header::CONTENT_DISPOSITION);
    let cache_control = header_text(header::CACHE_CONTROL);
    let body = to_bytes(response.into_body(), usize::MAX)
        .await
        .unwrap()
        .to_vec();
    Reply {
        status,
        body,
        content_type,
        content_length,
        content_disposition,
        cache_control,
        stage_a: stage_a.load(SeqCst),
        stage_b: stage_b.load(SeqCst),
        events: sink.events(),
    }
}

const CHATS: &str = "/api/agents/a1/chats";
const TRANSCRIPT: &str = "/api/agents/a1/chats/conv-1/messages";
const ATTACHMENT: &str = "/api/agents/a1/chats/conv-1/attachments/att-1";

// ---- chats -----------------------------------------------------------------

#[tokio::test]
async fn chats_success_lists_every_arm_and_emits_one_event() {
    let bundle = AuditChatsBundle::from_source(
        subject_facts("a1", Arm::Creator),
        vec![workspace_chat(), direct_pair_chat()],
    );
    let reads = FakeAuditRead::new()
        .subject(SubjectOutcome::Present(subject_facts("a1", Arm::Creator)))
        .chats(ChatsOutcome::Present(bundle));
    let reply = run(reads, FakeBlob::Panics, CountingSink::new(), CHATS, true).await;

    assert_eq!(reply.status, StatusCode::OK);
    let body = reply.json();
    assert_eq!(body["chats"][0]["placement_kind"], "workspace");
    assert_eq!(body["chats"][0]["conversation_id"], "conv-ws");
    assert_eq!(body["chats"][0]["roster_policy"], "open");
    assert_eq!(body["chats"][0]["title"], "General");
    assert_eq!(body["chats"][0]["workspace_id"], "ws-1");
    assert_eq!(body["chats"][0]["archived_at"], Value::Null);
    assert_eq!(body["chats"][1]["placement_kind"], "direct_pair");
    assert_eq!(body["chats"][1]["counterpart"]["id"], "peer-1");
    assert_eq!(body["chats"][1]["archived_at"], 2000);
    assert_eq!(body["chats"][1]["read_only"], false);
    assert_eq!(
        reply.events,
        vec![AgentAuditEvent::ChatsListed {
            viewer: user("viewer-1"),
            agent_id: agent("a1"),
            chat_count: 2,
        }]
    );
    assert_eq!((reply.stage_a, reply.stage_b), (1, 1));
}

#[tokio::test]
async fn chats_empty_list_projects_an_empty_array_and_still_emits() {
    let bundle = AuditChatsBundle::from_source(subject_facts("a1", Arm::Creator), vec![]);
    let reads = FakeAuditRead::new()
        .subject(SubjectOutcome::Present(subject_facts("a1", Arm::Creator)))
        .chats(ChatsOutcome::Present(bundle));
    let reply = run(reads, FakeBlob::Panics, CountingSink::new(), CHATS, true).await;

    assert_eq!(reply.status, StatusCode::OK);
    assert_eq!(reply.json(), json!({ "chats": [] }));
    assert_eq!(
        reply.events,
        vec![AgentAuditEvent::ChatsListed {
            viewer: user("viewer-1"),
            agent_id: agent("a1"),
            chat_count: 0,
        }]
    );
}

#[tokio::test]
async fn chats_non_viewer_is_the_anti_enum_404_before_any_data_read() {
    let reads = FakeAuditRead::new().subject(SubjectOutcome::Present(subject_facts(
        "a1",
        Arm::NobodyRelevant,
    )));
    let reply = run(reads, FakeBlob::Panics, CountingSink::new(), CHATS, true).await;

    assert_eq!(reply.status, StatusCode::NOT_FOUND);
    assert_eq!(reply.json(), json!({ "error": "agent not found" }));
    assert!(reply.events.is_empty());
    assert_eq!((reply.stage_a, reply.stage_b), (1, 0));
}

#[tokio::test]
async fn chats_absent_agent_is_the_same_404() {
    let reads = FakeAuditRead::new().subject(SubjectOutcome::Absent);
    let reply = run(reads, FakeBlob::Panics, CountingSink::new(), CHATS, true).await;

    assert_eq!(reply.status, StatusCode::NOT_FOUND);
    assert_eq!(reply.json(), json!({ "error": "agent not found" }));
    assert!(reply.events.is_empty());
    assert_eq!((reply.stage_a, reply.stage_b), (1, 0));
}

#[tokio::test]
async fn chats_owner_floor_refuses_a_non_creator_viewer_403_before_data() {
    let reads =
        FakeAuditRead::new().subject(SubjectOutcome::Present(subject_facts("a1", Arm::Workspace)));
    let reply = run(reads, FakeBlob::Panics, CountingSink::new(), CHATS, true).await;

    assert_eq!(reply.status, StatusCode::FORBIDDEN);
    assert_eq!(reply.json(), json!({ "error": "forbidden" }));
    assert!(reply.events.is_empty());
    assert_eq!((reply.stage_a, reply.stage_b), (1, 0));
}

#[tokio::test]
async fn chats_missing_principal_is_a_safe_500_that_never_reads() {
    let reads =
        FakeAuditRead::new().subject(SubjectOutcome::Present(subject_facts("a1", Arm::Creator)));
    let reply = run(reads, FakeBlob::Panics, CountingSink::new(), CHATS, false).await;

    assert_eq!(reply.status, StatusCode::INTERNAL_SERVER_ERROR);
    assert_eq!(reply.text(), "Internal Server Error");
    assert!(reply.events.is_empty());
    assert_eq!((reply.stage_a, reply.stage_b), (0, 0));
}

#[tokio::test]
async fn chats_subject_read_failure_is_a_safe_500() {
    let reads = FakeAuditRead::new().subject(SubjectOutcome::Fails);
    let reply = run(reads, FakeBlob::Panics, CountingSink::new(), CHATS, true).await;

    assert_eq!(reply.status, StatusCode::INTERNAL_SERVER_ERROR);
    assert_eq!(reply.text(), "Internal Server Error");
    assert!(!reply.text().contains("audit read gone"));
    assert!(reply.events.is_empty());
}

#[tokio::test]
async fn chats_stage_b_read_failure_is_a_safe_500_with_no_event() {
    let reads = FakeAuditRead::new()
        .subject(SubjectOutcome::Present(subject_facts("a1", Arm::Creator)))
        .chats(ChatsOutcome::Fails);
    let reply = run(reads, FakeBlob::Panics, CountingSink::new(), CHATS, true).await;

    assert_eq!(reply.status, StatusCode::INTERNAL_SERVER_ERROR);
    assert!(reply.events.is_empty());
    assert_eq!((reply.stage_a, reply.stage_b), (1, 1));
}

#[tokio::test]
async fn chats_bundle_resolved_for_another_agent_is_a_safe_500() {
    // The URL asks about `a1`, but the Stage A subject decodes to `a2`: the gate would
    // judge one row and the wire render another, so the source-bind takes a safe 500.
    let reads =
        FakeAuditRead::new().subject(SubjectOutcome::Present(subject_facts("a2", Arm::Creator)));
    let reply = run(reads, FakeBlob::Panics, CountingSink::new(), CHATS, true).await;

    assert_eq!(reply.status, StatusCode::INTERNAL_SERVER_ERROR);
    assert!(reply.events.is_empty());
    assert_eq!((reply.stage_a, reply.stage_b), (1, 0));
}

#[tokio::test]
async fn chats_fresh_non_owner_verdict_is_mapped_to_403_not_the_prebuilt_list() {
    // P0#2 (route re-run): Stage A admits the owner, but the Stage-B bundle's own subject
    // facts put the caller in the non-owner arm. The route maps that fresh verdict to a
    // 403 — the chat rows the bundle carries are never projected and no event fires.
    let bundle = AuditChatsBundle::from_source(
        subject_facts("a1", Arm::Workspace),
        vec![workspace_chat(), direct_pair_chat()],
    );
    let reads = FakeAuditRead::new()
        .subject(SubjectOutcome::Present(subject_facts("a1", Arm::Creator)))
        .chats(ChatsOutcome::Present(bundle));
    let reply = run(reads, FakeBlob::Panics, CountingSink::new(), CHATS, true).await;

    assert_eq!(reply.status, StatusCode::FORBIDDEN);
    assert_eq!(reply.json(), json!({ "error": "forbidden" }));
    assert!(reply.events.is_empty());
    assert_eq!((reply.stage_a, reply.stage_b), (1, 1));
}

#[tokio::test]
async fn chats_stage_b_non_active_subject_is_mapped_to_404_not_the_prebuilt_list() {
    // P0#2 (visibility floor): Stage A admits an active owner, but the Stage-B bundle's
    // own subject facts are the SAME owner gone non-active (Failed) — the agent left its
    // active stage under the read. The route re-runs the full floor, whose active-stage
    // `can_view_agent` now refuses: a fresh anti-enum 404, with the chat rows the bundle
    // carries never projected and no event fired.
    let bundle = AuditChatsBundle::from_source(
        subject_facts_at("a1", Arm::Creator, MaterializationStatus::Failed),
        vec![workspace_chat(), direct_pair_chat()],
    );
    let reads = FakeAuditRead::new()
        .subject(SubjectOutcome::Present(subject_facts("a1", Arm::Creator)))
        .chats(ChatsOutcome::Present(bundle));
    let reply = run(reads, FakeBlob::Panics, CountingSink::new(), CHATS, true).await;

    assert_eq!(reply.status, StatusCode::NOT_FOUND);
    assert_eq!(reply.json(), json!({ "error": "agent not found" }));
    assert!(reply.events.is_empty());
    assert_eq!((reply.stage_a, reply.stage_b), (1, 1));
}

// ---- transcript ------------------------------------------------------------

fn transcript_bundle(
    arm: Arm,
    audited: AuditedConversation,
    window: Option<AuditTranscriptWindow>,
) -> AuditTranscriptBundle {
    AuditTranscriptBundle::from_source(
        subject_facts("a1", arm),
        Some(conversation("conv-1")),
        audited,
        window,
    )
}

#[tokio::test]
async fn transcript_success_projects_the_envelope_and_emits_one_event() {
    let bundle = transcript_bundle(
        Arm::Creator,
        audited(true, true),
        Some(AuditTranscriptWindow::projected(vec![], false, false)),
    );
    let reads = FakeAuditRead::new()
        .subject(SubjectOutcome::Present(subject_facts("a1", Arm::Creator)))
        .transcript(TranscriptOutcome::Present(bundle));
    let reply = run(
        reads,
        FakeBlob::Panics,
        CountingSink::new(),
        TRANSCRIPT,
        true,
    )
    .await;

    assert_eq!(reply.status, StatusCode::OK);
    assert_eq!(
        reply.json(),
        json!({
            "messages": [],
            "reply_counts_by_root": {},
            "has_more_before": false,
            "has_more_after": false,
        })
    );
    assert_eq!(
        reply.events,
        vec![AgentAuditEvent::TranscriptRead {
            viewer: user("viewer-1"),
            agent_id: agent("a1"),
            conversation_id: conversation("conv-1"),
            message_count: 0,
        }]
    );
    assert_eq!((reply.stage_a, reply.stage_b), (1, 1));
}

#[tokio::test]
async fn transcript_non_participant_and_absent_conversation_are_one_403() {
    // An owner whose agent is not a party, and a conversation that does not exist, both
    // collapse to the SAME owner-only 403 — a guessed id is no existence oracle.
    for audited in [audited(true, false), audited(false, false)] {
        let bundle = transcript_bundle(
            Arm::Creator,
            audited,
            Some(AuditTranscriptWindow::projected(vec![], false, false)),
        );
        let reads = FakeAuditRead::new()
            .subject(SubjectOutcome::Present(subject_facts("a1", Arm::Creator)))
            .transcript(TranscriptOutcome::Present(bundle));
        let reply = run(
            reads,
            FakeBlob::Panics,
            CountingSink::new(),
            TRANSCRIPT,
            true,
        )
        .await;

        assert_eq!(reply.status, StatusCode::FORBIDDEN);
        assert_eq!(reply.json(), json!({ "error": "forbidden" }));
        assert!(reply.events.is_empty());
        assert_eq!((reply.stage_a, reply.stage_b), (1, 1));
    }
}

#[tokio::test]
async fn transcript_anchor_not_found_is_a_post_gate_404() {
    let bundle = transcript_bundle(Arm::Creator, audited(true, true), None);
    let reads = FakeAuditRead::new()
        .subject(SubjectOutcome::Present(subject_facts("a1", Arm::Creator)))
        .transcript(TranscriptOutcome::Present(bundle));
    let reply = run(
        reads,
        FakeBlob::Panics,
        CountingSink::new(),
        TRANSCRIPT,
        true,
    )
    .await;

    assert_eq!(reply.status, StatusCode::NOT_FOUND);
    assert_eq!(
        reply.json(),
        json!({
            "error": "around_message_id not found in this conversation",
            "code": "message_not_found",
        })
    );
    assert!(reply.events.is_empty());
}

#[tokio::test]
async fn transcript_bad_cursor_is_a_400_after_the_floor_before_any_data_read() {
    let reads =
        FakeAuditRead::new().subject(SubjectOutcome::Present(subject_facts("a1", Arm::Creator)));
    let reply = run(
        reads,
        FakeBlob::Panics,
        CountingSink::new(),
        "/api/agents/a1/chats/conv-1/messages?before_seq=abc",
        true,
    )
    .await;

    assert_eq!(reply.status, StatusCode::BAD_REQUEST);
    assert!(reply.events.is_empty());
    // The floor read ran; the expensive window read did not.
    assert_eq!((reply.stage_a, reply.stage_b), (1, 0));
}

#[tokio::test]
async fn transcript_non_owner_with_a_malformed_query_is_403_not_400() {
    // P0#1: the cursor is parsed only AFTER the Stage A owner floor. A viewer who may
    // SEE the agent but is not its owner, carrying a broken cursor, must get the owner
    // 403 — never a 400 that would confirm the query was read first (an oracle the
    // authenticated 403 must not hand a non-owner).
    let reads =
        FakeAuditRead::new().subject(SubjectOutcome::Present(subject_facts("a1", Arm::Workspace)));
    let reply = run(
        reads,
        FakeBlob::Panics,
        CountingSink::new(),
        "/api/agents/a1/chats/conv-1/messages?before_seq=abc&before_seq=def",
        true,
    )
    .await;

    assert_eq!(reply.status, StatusCode::FORBIDDEN);
    assert_eq!(reply.json(), json!({ "error": "forbidden" }));
    assert!(reply.events.is_empty());
    // The floor refused; the cursor was never parsed and the window never read.
    assert_eq!((reply.stage_a, reply.stage_b), (1, 0));
}

#[tokio::test]
async fn transcript_non_viewer_with_a_malformed_query_is_404_not_400() {
    // Same ordering, one rung lower: a caller outside the visibility ACL is the anti-enum
    // 404 — a malformed cursor cannot turn it into a 400 that distinguishes this agent
    // from an absent one.
    let reads = FakeAuditRead::new().subject(SubjectOutcome::Present(subject_facts(
        "a1",
        Arm::NobodyRelevant,
    )));
    let reply = run(
        reads,
        FakeBlob::Panics,
        CountingSink::new(),
        "/api/agents/a1/chats/conv-1/messages?before_seq=abc",
        true,
    )
    .await;

    assert_eq!(reply.status, StatusCode::NOT_FOUND);
    assert_eq!(reply.json(), json!({ "error": "agent not found" }));
    assert!(reply.events.is_empty());
    assert_eq!((reply.stage_a, reply.stage_b), (1, 0));
}

#[tokio::test]
async fn transcript_fresh_non_owner_verdict_is_mapped_to_403_not_the_prebuilt_window() {
    // P0#2 (route re-run): Stage A admits the owner, but the Stage-B snapshot's own
    // subject facts put the caller in the non-owner arm (ownership changed under the
    // read). The route MAPS that fresh verdict to a 403 — the window the bundle happens
    // to carry is never projected.
    let bundle = transcript_bundle(
        Arm::Workspace,
        audited(true, true),
        Some(AuditTranscriptWindow::projected(vec![], false, false)),
    );
    let reads = FakeAuditRead::new()
        .subject(SubjectOutcome::Present(subject_facts("a1", Arm::Creator)))
        .transcript(TranscriptOutcome::Present(bundle));
    let reply = run(
        reads,
        FakeBlob::Panics,
        CountingSink::new(),
        TRANSCRIPT,
        true,
    )
    .await;

    assert_eq!(reply.status, StatusCode::FORBIDDEN);
    assert_eq!(reply.json(), json!({ "error": "forbidden" }));
    assert!(reply.events.is_empty());
    assert_eq!((reply.stage_a, reply.stage_b), (1, 1));
}

#[tokio::test]
async fn transcript_stage_b_non_active_subject_is_mapped_to_404_not_the_prebuilt_window() {
    // P0#2 (visibility floor): Stage A admits the active owner; the Stage-B snapshot's
    // subject facts are that owner gone non-active. The route maps the fresh floor's
    // active-stage refusal to a 404 — the window the bundle carries is never projected.
    let bundle = AuditTranscriptBundle::from_source(
        subject_facts_at("a1", Arm::Creator, MaterializationStatus::Failed),
        Some(conversation("conv-1")),
        audited(true, true),
        Some(AuditTranscriptWindow::projected(vec![], false, false)),
    );
    let reads = FakeAuditRead::new()
        .subject(SubjectOutcome::Present(subject_facts("a1", Arm::Creator)))
        .transcript(TranscriptOutcome::Present(bundle));
    let reply = run(
        reads,
        FakeBlob::Panics,
        CountingSink::new(),
        TRANSCRIPT,
        true,
    )
    .await;

    assert_eq!(reply.status, StatusCode::NOT_FOUND);
    assert_eq!(reply.json(), json!({ "error": "agent not found" }));
    assert!(reply.events.is_empty());
    assert_eq!((reply.stage_a, reply.stage_b), (1, 1));
}

#[tokio::test]
async fn transcript_allow_with_a_missing_coordinate_is_a_safe_500() {
    // P0#3: the coordinate is load-bearing. An allowed gate whose bundle carries NO
    // decoded conversation id is a resolver defect (the gate judged a row the wire has
    // no coordinate for), so the bind guard takes the lane's safe 500 rather than
    // rendering a coordinate-less transcript.
    let bundle = AuditTranscriptBundle::from_source(
        subject_facts("a1", Arm::Creator),
        None,
        audited(true, true),
        Some(AuditTranscriptWindow::projected(vec![], false, false)),
    );
    let reads = FakeAuditRead::new()
        .subject(SubjectOutcome::Present(subject_facts("a1", Arm::Creator)))
        .transcript(TranscriptOutcome::Present(bundle));
    let reply = run(
        reads,
        FakeBlob::Panics,
        CountingSink::new(),
        TRANSCRIPT,
        true,
    )
    .await;

    assert_eq!(reply.status, StatusCode::INTERNAL_SERVER_ERROR);
    assert!(reply.events.is_empty());
    assert_eq!((reply.stage_a, reply.stage_b), (1, 1));
}

#[tokio::test]
async fn transcript_non_viewer_is_the_anti_enum_404_before_the_window() {
    let reads = FakeAuditRead::new().subject(SubjectOutcome::Present(subject_facts(
        "a1",
        Arm::NobodyRelevant,
    )));
    let reply = run(
        reads,
        FakeBlob::Panics,
        CountingSink::new(),
        TRANSCRIPT,
        true,
    )
    .await;

    assert_eq!(reply.status, StatusCode::NOT_FOUND);
    assert_eq!(reply.json(), json!({ "error": "agent not found" }));
    assert!(reply.events.is_empty());
    assert_eq!((reply.stage_a, reply.stage_b), (1, 0));
}

#[tokio::test]
async fn transcript_bundle_for_the_wrong_conversation_is_a_safe_500() {
    let bundle = AuditTranscriptBundle::from_source(
        subject_facts("a1", Arm::Creator),
        Some(conversation("other")),
        audited(true, true),
        Some(AuditTranscriptWindow::projected(vec![], false, false)),
    );
    let reads = FakeAuditRead::new()
        .subject(SubjectOutcome::Present(subject_facts("a1", Arm::Creator)))
        .transcript(TranscriptOutcome::Present(bundle));
    let reply = run(
        reads,
        FakeBlob::Panics,
        CountingSink::new(),
        TRANSCRIPT,
        true,
    )
    .await;

    assert_eq!(reply.status, StatusCode::INTERNAL_SERVER_ERROR);
    assert!(reply.events.is_empty());
    assert_eq!((reply.stage_a, reply.stage_b), (1, 1));
}

#[tokio::test]
async fn transcript_missing_principal_is_a_safe_500_that_never_reads() {
    let reads =
        FakeAuditRead::new().subject(SubjectOutcome::Present(subject_facts("a1", Arm::Creator)));
    let reply = run(
        reads,
        FakeBlob::Panics,
        CountingSink::new(),
        TRANSCRIPT,
        false,
    )
    .await;

    assert_eq!(reply.status, StatusCode::INTERNAL_SERVER_ERROR);
    assert_eq!((reply.stage_a, reply.stage_b), (0, 0));
    assert!(reply.events.is_empty());
}

#[tokio::test]
async fn transcript_stage_b_read_failure_is_a_safe_500() {
    let reads = FakeAuditRead::new()
        .subject(SubjectOutcome::Present(subject_facts("a1", Arm::Creator)))
        .transcript(TranscriptOutcome::Fails);
    let reply = run(
        reads,
        FakeBlob::Panics,
        CountingSink::new(),
        TRANSCRIPT,
        true,
    )
    .await;

    assert_eq!(reply.status, StatusCode::INTERNAL_SERVER_ERROR);
    assert!(reply.events.is_empty());
}

// ---- attachment ------------------------------------------------------------

fn attachment_bundle(
    arm: Arm,
    audited: AuditedConversation,
    record: Option<AttachmentRecord>,
) -> AuditAttachmentBundle {
    AuditAttachmentBundle::from_source(
        subject_facts("a1", arm),
        Some(conversation("conv-1")),
        audited,
        record,
    )
}

#[tokio::test]
async fn attachment_success_serves_the_bytes_headers_and_one_event() {
    let bytes = b"%PDF-1.4 body".to_vec();
    let bundle = attachment_bundle(
        Arm::Creator,
        audited(true, true),
        Some(attachment_record(bytes.len() as i64)),
    );
    let reads = FakeAuditRead::new()
        .subject(SubjectOutcome::Present(subject_facts("a1", Arm::Creator)))
        .attachment(AttachmentOutcome::Present(Box::new(bundle)));
    let reply = run(
        reads,
        FakeBlob::found(bytes.clone()),
        CountingSink::new(),
        ATTACHMENT,
        true,
    )
    .await;

    assert_eq!(reply.status, StatusCode::OK);
    assert_eq!(reply.body, bytes);
    assert_eq!(reply.content_type.as_deref(), Some("application/pdf"));
    assert_eq!(
        reply.content_length.as_deref(),
        Some(bytes.len().to_string().as_str())
    );
    assert_eq!(
        reply.content_disposition.as_deref(),
        Some("inline; filename=\"report.pdf\"; filename*=UTF-8''report.pdf")
    );
    assert_eq!(reply.cache_control.as_deref(), Some("private, no-store"));
    assert_eq!(
        reply.events,
        vec![AgentAuditEvent::AttachmentRead {
            viewer: user("viewer-1"),
            agent_id: agent("a1"),
            conversation_id: conversation("conv-1"),
            attachment_id: AttachmentId::parse("att-1").unwrap(),
        }]
    );
}

#[tokio::test]
async fn attachment_absent_row_is_a_404_with_the_blob_never_read() {
    // The bundle resolves no row (absent, or in another conversation). The blob store
    // panics on any read, so reaching it fails the test: this face touches no bytes.
    let bundle = attachment_bundle(Arm::Creator, audited(true, true), None);
    let reads = FakeAuditRead::new()
        .subject(SubjectOutcome::Present(subject_facts("a1", Arm::Creator)))
        .attachment(AttachmentOutcome::Present(Box::new(bundle)));
    let reply = run(
        reads,
        FakeBlob::Panics,
        CountingSink::new(),
        ATTACHMENT,
        true,
    )
    .await;

    assert_eq!(reply.status, StatusCode::NOT_FOUND);
    assert_eq!(reply.json(), json!({ "error": "attachment not found" }));
    assert!(reply.events.is_empty());
}

#[tokio::test]
async fn attachment_non_participant_is_403_with_the_blob_never_read() {
    let bundle = attachment_bundle(
        Arm::Creator,
        audited(true, false),
        Some(attachment_record(4)),
    );
    let reads = FakeAuditRead::new()
        .subject(SubjectOutcome::Present(subject_facts("a1", Arm::Creator)))
        .attachment(AttachmentOutcome::Present(Box::new(bundle)));
    let reply = run(
        reads,
        FakeBlob::Panics,
        CountingSink::new(),
        ATTACHMENT,
        true,
    )
    .await;

    assert_eq!(reply.status, StatusCode::FORBIDDEN);
    assert_eq!(reply.json(), json!({ "error": "forbidden" }));
    assert!(reply.events.is_empty());
}

#[tokio::test]
async fn attachment_non_viewer_is_the_anti_enum_404_with_the_blob_never_read() {
    let bundle = attachment_bundle(
        Arm::NobodyRelevant,
        audited(true, true),
        Some(attachment_record(4)),
    );
    let reads = FakeAuditRead::new()
        .subject(SubjectOutcome::Present(subject_facts(
            "a1",
            Arm::NobodyRelevant,
        )))
        .attachment(AttachmentOutcome::Present(Box::new(bundle)));
    let reply = run(
        reads,
        FakeBlob::Panics,
        CountingSink::new(),
        ATTACHMENT,
        true,
    )
    .await;

    assert_eq!(reply.status, StatusCode::NOT_FOUND);
    assert_eq!(reply.json(), json!({ "error": "agent not found" }));
    assert!(reply.events.is_empty());
    assert_eq!((reply.stage_a, reply.stage_b), (1, 0));
}

#[tokio::test]
async fn attachment_blob_missing_is_a_500_with_no_event() {
    let bundle = attachment_bundle(
        Arm::Creator,
        audited(true, true),
        Some(attachment_record(4)),
    );
    let reads = FakeAuditRead::new()
        .subject(SubjectOutcome::Present(subject_facts("a1", Arm::Creator)))
        .attachment(AttachmentOutcome::Present(Box::new(bundle)));
    let reply = run(
        reads,
        FakeBlob::Missing,
        CountingSink::new(),
        ATTACHMENT,
        true,
    )
    .await;

    assert_eq!(reply.status, StatusCode::INTERNAL_SERVER_ERROR);
    assert_eq!(reply.text(), "Internal Server Error");
    assert!(reply.events.is_empty());
}

#[tokio::test]
async fn attachment_blob_read_error_is_a_500_with_no_event() {
    let bundle = attachment_bundle(
        Arm::Creator,
        audited(true, true),
        Some(attachment_record(4)),
    );
    let reads = FakeAuditRead::new()
        .subject(SubjectOutcome::Present(subject_facts("a1", Arm::Creator)))
        .attachment(AttachmentOutcome::Present(Box::new(bundle)));
    let reply = run(reads, FakeBlob::Errs, CountingSink::new(), ATTACHMENT, true).await;

    assert_eq!(reply.status, StatusCode::INTERNAL_SERVER_ERROR);
    assert!(reply.events.is_empty());
}

#[tokio::test]
async fn attachment_size_mismatch_is_a_500_with_no_event() {
    // The committed row claims 5 bytes; the store returns 3. The lane refuses the splice.
    let bundle = attachment_bundle(
        Arm::Creator,
        audited(true, true),
        Some(attachment_record(5)),
    );
    let reads = FakeAuditRead::new()
        .subject(SubjectOutcome::Present(subject_facts("a1", Arm::Creator)))
        .attachment(AttachmentOutcome::Present(Box::new(bundle)));
    let reply = run(
        reads,
        FakeBlob::found(vec![1, 2, 3]),
        CountingSink::new(),
        ATTACHMENT,
        true,
    )
    .await;

    assert_eq!(reply.status, StatusCode::INTERNAL_SERVER_ERROR);
    assert!(reply.events.is_empty());
}

#[tokio::test]
async fn attachment_fresh_non_owner_verdict_is_mapped_to_403_with_the_blob_never_read() {
    // P0#2 (route re-run): Stage A admits the owner; the Stage-B bundle's own subject
    // facts are the non-owner arm. The route maps that fresh verdict to a 403 and the
    // (panicking) blob store is never reached.
    let bundle = attachment_bundle(
        Arm::Workspace,
        audited(true, true),
        Some(attachment_record(4)),
    );
    let reads = FakeAuditRead::new()
        .subject(SubjectOutcome::Present(subject_facts("a1", Arm::Creator)))
        .attachment(AttachmentOutcome::Present(Box::new(bundle)));
    let reply = run(
        reads,
        FakeBlob::Panics,
        CountingSink::new(),
        ATTACHMENT,
        true,
    )
    .await;

    assert_eq!(reply.status, StatusCode::FORBIDDEN);
    assert_eq!(reply.json(), json!({ "error": "forbidden" }));
    assert!(reply.events.is_empty());
}

#[tokio::test]
async fn attachment_stage_b_non_active_subject_is_mapped_to_404_with_the_blob_never_read() {
    // P0#2 (visibility floor): Stage A admits the active owner; the Stage-B bundle's
    // subject facts are that owner gone non-active. The route maps the fresh floor's
    // active-stage refusal to a 404 and the (panicking) blob store is never reached.
    let bundle = AuditAttachmentBundle::from_source(
        subject_facts_at("a1", Arm::Creator, MaterializationStatus::Failed),
        Some(conversation("conv-1")),
        audited(true, true),
        Some(attachment_record(4)),
    );
    let reads = FakeAuditRead::new()
        .subject(SubjectOutcome::Present(subject_facts("a1", Arm::Creator)))
        .attachment(AttachmentOutcome::Present(Box::new(bundle)));
    let reply = run(
        reads,
        FakeBlob::Panics,
        CountingSink::new(),
        ATTACHMENT,
        true,
    )
    .await;

    assert_eq!(reply.status, StatusCode::NOT_FOUND);
    assert_eq!(reply.json(), json!({ "error": "agent not found" }));
    assert!(reply.events.is_empty());
}

#[tokio::test]
async fn attachment_allow_with_a_missing_coordinate_is_a_safe_500() {
    // P0#3: the coordinate is load-bearing. An allowed gate whose bundle carries no
    // decoded conversation id is a resolver defect — the bind guard takes a safe 500
    // before any row or blob is served.
    let bundle = AuditAttachmentBundle::from_source(
        subject_facts("a1", Arm::Creator),
        None,
        audited(true, true),
        Some(attachment_record(4)),
    );
    let reads = FakeAuditRead::new()
        .subject(SubjectOutcome::Present(subject_facts("a1", Arm::Creator)))
        .attachment(AttachmentOutcome::Present(Box::new(bundle)));
    let reply = run(
        reads,
        FakeBlob::Panics,
        CountingSink::new(),
        ATTACHMENT,
        true,
    )
    .await;

    assert_eq!(reply.status, StatusCode::INTERNAL_SERVER_ERROR);
    assert!(reply.events.is_empty());
}

#[tokio::test]
async fn attachment_bundle_for_the_wrong_conversation_is_a_safe_500() {
    let bundle = AuditAttachmentBundle::from_source(
        subject_facts("a1", Arm::Creator),
        Some(conversation("other")),
        audited(true, true),
        Some(attachment_record(4)),
    );
    let reads = FakeAuditRead::new()
        .subject(SubjectOutcome::Present(subject_facts("a1", Arm::Creator)))
        .attachment(AttachmentOutcome::Present(Box::new(bundle)));
    let reply = run(
        reads,
        FakeBlob::Panics,
        CountingSink::new(),
        ATTACHMENT,
        true,
    )
    .await;

    assert_eq!(reply.status, StatusCode::INTERNAL_SERVER_ERROR);
    assert!(reply.events.is_empty());
}

#[tokio::test]
async fn attachment_stage_b_read_failure_is_a_safe_500_with_no_event() {
    let reads = FakeAuditRead::new()
        .subject(SubjectOutcome::Present(subject_facts("a1", Arm::Creator)))
        .attachment(AttachmentOutcome::Fails);
    let reply = run(
        reads,
        FakeBlob::Panics,
        CountingSink::new(),
        ATTACHMENT,
        true,
    )
    .await;

    assert_eq!(reply.status, StatusCode::INTERNAL_SERVER_ERROR);
    assert_eq!(reply.text(), "Internal Server Error");
    assert!(!reply.text().contains("audit read gone"));
    assert!(reply.events.is_empty());
}

#[tokio::test]
async fn attachment_missing_principal_is_a_safe_500_that_never_reads() {
    let reads =
        FakeAuditRead::new().subject(SubjectOutcome::Present(subject_facts("a1", Arm::Creator)));
    let reply = run(
        reads,
        FakeBlob::Panics,
        CountingSink::new(),
        ATTACHMENT,
        false,
    )
    .await;

    assert_eq!(reply.status, StatusCode::INTERNAL_SERVER_ERROR);
    assert_eq!((reply.stage_a, reply.stage_b), (0, 0));
    assert!(reply.events.is_empty());
}
