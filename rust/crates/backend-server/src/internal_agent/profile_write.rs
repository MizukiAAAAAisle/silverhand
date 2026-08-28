//! The internal agent-profile WRITE routes — `POST /internal/agents/{aid}/profile`,
//! `POST /internal/agents/{aid}/avatar`, and `DELETE /internal/agents/{aid}/avatar`.
//!
//! ## Self-pin, admission, one write, reproject
//!
//! Every route sits behind the same self-pin credential layer as the read
//! ([`require_runtime_credential`](crate::runtime_credential::require_runtime_credential)):
//! `{aid}` is bound to the caller's own agent before any handler runs, so a non-self
//! caller is an indistinguishable `401` upstream and these handlers take NO path param —
//! the subject is `credential.agent()`, never a wire value. An absent credential is the
//! composition-fault safe `500`, never a `401` (that verdict is the layer's).
//!
//! The body is decoded by the request-admission checkpoint
//! ([`admit_profile_edit`](super::profile_write_admission::admit_profile_edit) /
//! [`admit_avatar_upload`](super::profile_write_admission::admit_avatar_upload)) into a
//! fully-validated edit or a terminal refusal; `DELETE` carries no body, so its whole
//! algebra is the clear/no-op of the write unit of work. The validated edit is mapped to
//! the core's [`InternalProfileEdit`] and applied by [`update_internal_profile`] as ONE
//! row unit-of-work firing EXACTLY ONE `agent_changed` announce; on success the response
//! is reprojected by RE-READING through the canonical profile read port (never from the
//! write fact), so all three routes emit the single `AgentProfileDto` the CLI consumes.
//!
//! The three envelopes mirror the product exactly: `POST /profile` → `{ profile }`,
//! `POST /avatar` → `{ avatar_url, agent }`, `DELETE /avatar` → `{ agent }`.

use axum::{
    Json, Router,
    extract::{Extension, Request, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::post,
};
use serde::Serialize;
use silverhand_backend_core::{
    agent_avatar::{AgentAvatarBlobPointer, AgentAvatarBlobStore},
    agent_profile_read::{AgentProfileReadModel, ProfileReadFault, read_self_profile},
    agent_profile_write::{
        AgentChangedAnnounce, AgentChangedSink, AgentProfileWriteError,
        AgentProfileWriteUnitOfWork, RequiredEdit,
    },
    avatar::BlobCleanup,
    identity::AgentId,
    internal_profile_write::{
        InternalAvatarEdit, InternalProfileEdit, InternalProfileWriteOutcome,
        update_internal_profile,
    },
    runtime_credential::RuntimePrincipal,
};

use super::{
    profile::SELF_PROFILE_PATH,
    profile_write_admission::{
        AvatarAction, ValidatedProfileEdit, admit_avatar_upload, admit_profile_edit,
    },
    wire::{AgentProfileDto, agent_profile_dto},
};
use crate::{clock::ProcessClock, error};

/// The internal avatar route template. `{aid}` is self-pinned by the credential layer.
pub const SELF_AVATAR_PATH: &str = "/internal/agents/{aid}/avatar";

/// The unmapped-error body: a bare `text/plain` `500`, never a JSON envelope — the same
/// shape a thrown Hono handler yields.
const INTERNAL_ERROR_BODY: &str = "Internal Server Error";

/// The ports the write routes drive: the canonical row writer, the avatar blob store, the
/// `agent_changed` sink, the profile read port (for the post-commit reproject), and the
/// process clock (the write instant the writer stamps and the seal verifies). Cloneable
/// so Axum can hold it in router state.
#[derive(Clone)]
pub struct InternalProfileWriteState<W, B, S, R, C> {
    pub writes: W,
    pub blobs: B,
    pub announce: S,
    pub reader: R,
    pub clock: C,
}

/// Mount the three write routes generic over their ports, so tests drive them with
/// driver-free fakes and the composition root wires the SQLite/blob/announce adapters AND
/// the runtime-credential layer that self-pins `{aid}`. `GET /profile` is the read lane's
/// (`self_profile_router`); Axum merges the two method handlers on the shared path.
pub fn internal_profile_write_router<W, B, S, R, C>(
    state: InternalProfileWriteState<W, B, S, R, C>,
) -> Router
where
    W: AgentProfileWriteUnitOfWork + Clone + Send + Sync + 'static,
    B: AgentAvatarBlobStore + Clone + Send + Sync + 'static,
    S: AgentChangedSink + Clone + Send + Sync + 'static,
    R: AgentProfileReadModel + Clone + Send + Sync + 'static,
    C: ProcessClock,
{
    Router::new()
        .route(SELF_PROFILE_PATH, post(post_profile::<W, B, S, R, C>))
        .route(
            SELF_AVATAR_PATH,
            post(post_avatar::<W, B, S, R, C>).delete(delete_avatar::<W, B, S, R, C>),
        )
        .with_state(state)
}

/// Which envelope a committed/no-op write reprojects into. The DTO is identical across
/// all three; only the surrounding keys differ.
#[derive(Clone, Copy)]
enum Envelope {
    /// `POST /profile` → `{ profile: <dto> }`.
    Profile,
    /// `POST /avatar` → `{ avatar_url: <dto.avatar_url>, agent: <dto> }`.
    AvatarWithAgent,
    /// `DELETE /avatar` → `{ agent: <dto> }`.
    Agent,
}

#[derive(Serialize)]
struct ProfileResponse {
    profile: AgentProfileDto,
}

#[derive(Serialize)]
struct AvatarResponse {
    avatar_url: Option<String>,
    agent: AgentProfileDto,
}

#[derive(Serialize)]
struct AgentResponse {
    agent: AgentProfileDto,
}

async fn post_profile<W, B, S, R, C>(
    credential: Option<Extension<RuntimePrincipal>>,
    State(state): State<InternalProfileWriteState<W, B, S, R, C>>,
    request: Request,
) -> Response
where
    W: AgentProfileWriteUnitOfWork,
    B: AgentAvatarBlobStore,
    S: AgentChangedSink,
    R: AgentProfileReadModel,
    C: ProcessClock,
{
    let Some(subject) = pinned_subject(credential) else {
        return composition_fault("self-profile write");
    };
    let validated = match admit_profile_edit(request).await {
        Ok(validated) => validated,
        Err(refusal) => return refusal.into_response(),
    };
    let edit = profile_edit_to_core(validated);
    run_and_reproject(&state, &subject, edit, Envelope::Profile).await
}

async fn post_avatar<W, B, S, R, C>(
    credential: Option<Extension<RuntimePrincipal>>,
    State(state): State<InternalProfileWriteState<W, B, S, R, C>>,
    request: Request,
) -> Response
where
    W: AgentProfileWriteUnitOfWork,
    B: AgentAvatarBlobStore,
    S: AgentChangedSink,
    R: AgentProfileReadModel,
    C: ProcessClock,
{
    let Some(subject) = pinned_subject(credential) else {
        return composition_fault("self-avatar upload");
    };
    let validated = match admit_avatar_upload(request).await {
        Ok(validated) => validated,
        Err(refusal) => return refusal.into_response(),
    };
    // An avatar-only edit: the text columns are left untouched, the avatar is set to the
    // validated payload the core will put and repoint in the SAME row write.
    let edit = InternalProfileEdit {
        display_name: RequiredEdit::Leave,
        description: RequiredEdit::Leave,
        avatar: InternalAvatarEdit::Set {
            content_type: validated.content_type(),
            bytes: validated.bytes().to_vec(),
        },
    };
    run_and_reproject(&state, &subject, edit, Envelope::AvatarWithAgent).await
}

async fn delete_avatar<W, B, S, R, C>(
    credential: Option<Extension<RuntimePrincipal>>,
    State(state): State<InternalProfileWriteState<W, B, S, R, C>>,
) -> Response
where
    W: AgentProfileWriteUnitOfWork,
    B: AgentAvatarBlobStore,
    S: AgentChangedSink,
    R: AgentProfileReadModel,
    C: ProcessClock,
{
    let Some(subject) = pinned_subject(credential) else {
        return composition_fault("self-avatar clear");
    };
    // A body-less clear: leave the text columns, clear the avatar. A clear on an
    // already-absent avatar is the write UoW's warranted no-op (still a `200`).
    let edit = InternalProfileEdit {
        display_name: RequiredEdit::Leave,
        description: RequiredEdit::Leave,
        avatar: InternalAvatarEdit::Clear,
    };
    run_and_reproject(&state, &subject, edit, Envelope::Agent).await
}

/// The pinned subject, read from the credential the self-pin layer injected. Absent means
/// the layer was not composed in front of this route.
fn pinned_subject(credential: Option<Extension<RuntimePrincipal>>) -> Option<AgentId> {
    credential.map(|Extension(principal)| principal.agent().clone())
}

/// Apply the edit as one row write and, on success, reproject by re-reading the profile.
async fn run_and_reproject<W, B, S, R, C>(
    state: &InternalProfileWriteState<W, B, S, R, C>,
    subject: &AgentId,
    edit: InternalProfileEdit,
    envelope: Envelope,
) -> Response
where
    W: AgentProfileWriteUnitOfWork,
    B: AgentAvatarBlobStore,
    S: AgentChangedSink,
    R: AgentProfileReadModel,
    C: ProcessClock,
{
    let now_ms = state.clock.now_unix_millis();
    let outcome = update_internal_profile(
        &state.writes,
        &state.blobs,
        &state.announce,
        subject,
        edit,
        now_ms,
    )
    .await;

    match outcome {
        InternalProfileWriteOutcome::Committed(effect) => {
            // The announce and blob-cleanup are best-effort residues: a failure is logged
            // but never downgrades the committed write (the row is authoritative and
            // clients coalesce the refresh). Reproject from the read port, not the fact.
            let (agent_id, announce, cleanup) = effect.into_parts();
            note_announce(subject, announce);
            note_cleanup(subject, cleanup);
            reproject(&state.reader, &agent_id, envelope).await
        }
        // The one warranted no-op (avatar clear on an absent avatar, no text): nothing
        // changed, but the product still answers `200` with the current profile.
        InternalProfileWriteOutcome::NoOp { agent_id } => {
            reproject(&state.reader, &agent_id, envelope).await
        }
        // The row vanished before the write — the product `404`. Any fresh blob was
        // already cleaned by the core; log its fate.
        InternalProfileWriteOutcome::NoSuchAgent { orphan_cleanup } => {
            note_cleanup(subject, orphan_cleanup);
            not_found()
        }
        // A blob-store I/O failure with no row written and nothing persisted: the safe
        // `500` (the product's un-statused avatar-service throw).
        InternalProfileWriteOutcome::StorageFailed(failure) => {
            tracing::error!(
                error_chain = %error::describe(&failure),
                "internal-profile write: avatar blob storage failed"
            );
            internal_error()
        }
        // A pre-commit fault, or a durable-but-untrustworthy commit: both are the lane's
        // safe `500`. The core already carried the orphan/retained-blob discipline.
        InternalProfileWriteOutcome::WriteFaulted {
            cause,
            orphan_cleanup,
        } => {
            note_cleanup(subject, orphan_cleanup);
            note_write_fault(subject, &cause);
            internal_error()
        }
        InternalProfileWriteOutcome::CommitUntrustworthy { retained_fresh } => {
            note_untrustworthy(subject, retained_fresh);
            internal_error()
        }
    }
}

/// Re-read the just-written profile and project it into the route's envelope. An absent
/// row (a concurrent delete between the write and the read) is the product `404`; a
/// persistence or source-binding fault is the safe `500`.
async fn reproject<R>(reader: &R, subject: &AgentId, envelope: Envelope) -> Response
where
    R: AgentProfileReadModel,
{
    match read_self_profile(reader, subject).await {
        Ok(Some(fact)) => {
            let dto = agent_profile_dto(&fact);
            match envelope {
                Envelope::Profile => Json(ProfileResponse { profile: dto }).into_response(),
                Envelope::AvatarWithAgent => {
                    let avatar_url = dto.avatar_url.clone();
                    Json(AvatarResponse {
                        avatar_url,
                        agent: dto,
                    })
                    .into_response()
                }
                Envelope::Agent => Json(AgentResponse { agent: dto }).into_response(),
            }
        }
        Ok(None) => not_found(),
        Err(fault) => {
            let cause: &dyn std::error::Error = match &fault {
                ProfileReadFault::Persistence(failure) => failure,
                ProfileReadFault::Source(violation) => violation,
            };
            tracing::error!(
                error_chain = %error::describe(cause),
                "internal-profile write: post-commit reproject failed"
            );
            internal_error()
        }
    }
}

fn profile_edit_to_core(validated: ValidatedProfileEdit) -> InternalProfileEdit {
    let display_name = match validated.display_name() {
        Some(display_name) => RequiredEdit::Set(display_name.as_str().to_owned()),
        None => RequiredEdit::Leave,
    };
    let description = match validated.description() {
        Some(description) => RequiredEdit::Set(description.as_str().to_owned()),
        None => RequiredEdit::Leave,
    };
    let avatar = match validated.avatar() {
        AvatarAction::Leave => InternalAvatarEdit::Leave,
        AvatarAction::Clear => InternalAvatarEdit::Clear,
        AvatarAction::Set(validated) => InternalAvatarEdit::Set {
            content_type: validated.content_type(),
            bytes: validated.bytes().to_vec(),
        },
    };
    InternalProfileEdit {
        display_name,
        description,
        avatar,
    }
}

fn not_found() -> Response {
    (
        StatusCode::NOT_FOUND,
        Json(serde_json::json!({ "error": "agent not found" })),
    )
        .into_response()
}

fn internal_error() -> Response {
    (StatusCode::INTERNAL_SERVER_ERROR, INTERNAL_ERROR_BODY).into_response()
}

fn composition_fault(route: &str) -> Response {
    tracing::error!("{route} route reached without its runtime credential");
    internal_error()
}

/// Log a failed `agent_changed` announce; a delivered one is silent. Best-effort: never
/// changes the response.
fn note_announce(subject: &AgentId, announce: AgentChangedAnnounce) {
    if let AgentChangedAnnounce::Failed(failure) = announce {
        tracing::warn!(
            agent = subject.as_str(),
            error_chain = %error::describe(&failure),
            "internal-profile write committed but the agent_changed announce failed"
        );
    }
}

/// Log a failed best-effort blob cleanup; a clean/nothing-to-clean is silent.
fn note_cleanup(subject: &AgentId, cleanup: BlobCleanup) {
    if let BlobCleanup::Failed(failure) = cleanup {
        tracing::warn!(
            agent = subject.as_str(),
            error_chain = %error::describe(&failure),
            "internal-profile write: best-effort avatar blob cleanup failed (possible orphan)"
        );
    }
}

fn note_write_fault(subject: &AgentId, cause: &AgentProfileWriteError) {
    tracing::error!(
        agent = subject.as_str(),
        cause = ?cause,
        "internal-profile write faulted before a trustworthy commit"
    );
}

fn note_untrustworthy(subject: &AgentId, retained_fresh: Option<AgentAvatarBlobPointer>) {
    tracing::error!(
        agent = subject.as_str(),
        retained_fresh = retained_fresh.as_ref().map(AgentAvatarBlobPointer::as_str),
        "internal-profile write committed durably but the witness was untrustworthy; \
         a fresh avatar blob (if any) was retained to avoid a dangling pointer"
    );
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{
        body::{Body, to_bytes},
        http::{Request as HttpRequest, header::AUTHORIZATION},
    };
    use serde_json::{Value, json};
    use silverhand_backend_core::{
        agent_avatar::{AgentAvatarBlobRead, AgentAvatarRow, OwnedAgentAvatarBlob},
        agent_profile_read::AgentProfileFact,
        agent_profile_write::{
            AdmittedAgentProfileEdit, AgentChangedAnnounceFailure, AgentProfileRowWrite,
            AgentRowBefore, AgentTuningContext, CommittedAgentRow,
        },
        agents::runtime::RuntimeKind,
        avatar::{AvatarBlobReadOutcome, AvatarContentType, AvatarStorageFailure},
        identity::DaemonInstanceId,
        messaging::AvatarRevision,
        persistence::PersistenceFailure,
        runtime_credential::{RuntimeCustody, RuntimeGeneration, RuntimePrincipal, RuntimeScope},
    };
    use std::sync::{
        Arc, Mutex,
        atomic::{AtomicUsize, Ordering},
    };
    use tower::ServiceExt;

    const NOW: i64 = 1_700_000_000_123;
    const FRESH: &str = "agents/mint/blob-0";

    fn agent() -> AgentId {
        AgentId::parse("a1").unwrap()
    }

    fn ptr(raw: &str) -> AgentAvatarBlobPointer {
        AgentAvatarBlobPointer::parse(raw).unwrap()
    }

    // ---- clock ----

    #[derive(Clone, Copy)]
    struct FixedClock;
    impl ProcessClock for FixedClock {
        fn now_unix_millis(&self) -> i64 {
            NOW
        }
    }

    // ---- blob store ----

    #[derive(Clone)]
    struct FakeBlobs {
        next: Arc<AtomicUsize>,
        deletes: Arc<Mutex<Vec<String>>>,
    }
    impl FakeBlobs {
        fn new() -> Self {
            Self {
                next: Arc::new(AtomicUsize::new(0)),
                deletes: Arc::new(Mutex::new(Vec::new())),
            }
        }
        fn deleted(&self) -> Vec<String> {
            self.deletes.lock().unwrap().clone()
        }
    }
    impl AgentAvatarBlobRead for FakeBlobs {
        async fn read(
            &self,
            _blob: &OwnedAgentAvatarBlob,
        ) -> Result<AvatarBlobReadOutcome, AvatarStorageFailure> {
            Ok(AvatarBlobReadOutcome::Missing)
        }
    }
    impl AgentAvatarBlobStore for FakeBlobs {
        async fn put(
            &self,
            _agent_id: &AgentId,
            _content_type: AvatarContentType,
            _bytes: Vec<u8>,
        ) -> Result<AgentAvatarBlobPointer, AvatarStorageFailure> {
            let n = self.next.fetch_add(1, Ordering::SeqCst);
            Ok(ptr(&format!("agents/mint/blob-{n}")))
        }
        async fn delete(&self, blob: &OwnedAgentAvatarBlob) -> Result<(), AvatarStorageFailure> {
            self.deletes
                .lock()
                .unwrap()
                .push(blob.pointer().as_str().to_owned());
            Ok(())
        }
    }

    // ---- writer ----

    #[allow(clippy::large_enum_variant)]
    #[derive(Clone)]
    enum FakeWrites {
        Row(AgentProfileRowWrite),
    }
    impl AgentProfileWriteUnitOfWork for FakeWrites {
        async fn write_agent_row<D>(
            &self,
            _agent: &AgentId,
            _decide: D,
            _now_ms: i64,
        ) -> Result<AgentProfileRowWrite, PersistenceFailure>
        where
            D: FnOnce(&AgentRowBefore) -> Option<AdmittedAgentProfileEdit> + Send,
        {
            let FakeWrites::Row(row) = self;
            Ok(row.clone())
        }
    }

    // ---- announce sink ----

    #[derive(Clone)]
    struct FakeSink {
        calls: Arc<AtomicUsize>,
    }
    impl FakeSink {
        fn new() -> Self {
            Self {
                calls: Arc::new(AtomicUsize::new(0)),
            }
        }
        fn calls(&self) -> usize {
            self.calls.load(Ordering::SeqCst)
        }
    }
    impl AgentChangedSink for FakeSink {
        async fn agent_changed(&self, _agent: &AgentId) -> Result<(), AgentChangedAnnounceFailure> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            Ok(())
        }
    }

    // ---- reader (reproject source) ----

    #[derive(Clone)]
    struct FakeReader {
        fact: Option<AgentProfileFact>,
        consulted: Arc<AtomicUsize>,
    }
    impl FakeReader {
        fn with(fact: Option<AgentProfileFact>) -> Self {
            Self {
                fact,
                consulted: Arc::new(AtomicUsize::new(0)),
            }
        }
        fn reads(&self) -> usize {
            self.consulted.load(Ordering::SeqCst)
        }
    }
    impl AgentProfileReadModel for FakeReader {
        async fn read_agent_profile(
            &self,
            _agent: &AgentId,
        ) -> Result<Option<AgentProfileFact>, PersistenceFailure> {
            self.consulted.fetch_add(1, Ordering::SeqCst);
            Ok(self.fact.clone())
        }
        async fn read_agent_profile_by_handle(
            &self,
            _handle: &str,
        ) -> Result<Option<AgentProfileFact>, PersistenceFailure> {
            unreachable!("the write routes never read by handle")
        }
    }

    // ---- builders ----

    fn ctx() -> AgentTuningContext {
        AgentTuningContext {
            runtime: RuntimeKind::Claude,
            model: None,
            reasoning_effort: None,
        }
    }

    fn before(display_name: &str, avatar: AgentAvatarRow) -> AgentRowBefore {
        AgentRowBefore {
            agent_id: agent(),
            display_name: display_name.to_owned(),
            description: None,
            fast_mode: None,
            avatar,
            context: ctx(),
        }
    }

    fn committed(display_name: &str, avatar: AgentAvatarRow) -> CommittedAgentRow {
        CommittedAgentRow {
            id: agent(),
            display_name: display_name.to_owned(),
            description: None,
            model: None,
            reasoning_effort: None,
            fast_mode: None,
            avatar,
            updated_at: NOW,
        }
    }

    fn present(raw: &str) -> AgentAvatarRow {
        AgentAvatarRow::Present {
            pointer: ptr(raw),
            content_type: AvatarContentType::Png,
        }
    }

    fn fact(name: &str, avatar: Option<i64>) -> AgentProfileFact {
        AgentProfileFact {
            id: agent(),
            name: name.to_owned(),
            display_name: name.to_owned(),
            description: Some("a bio".to_owned()),
            avatar: avatar.map(AvatarRevision::at),
        }
    }

    fn principal(id: &str) -> RuntimePrincipal {
        RuntimePrincipal::for_scope(
            RuntimeScope::AgentSlot {
                agent: AgentId::parse(id).unwrap(),
            },
            RuntimeCustody::new(
                RuntimeGeneration::new(1).unwrap(),
                DaemonInstanceId::parse("daemon-1").unwrap(),
            ),
        )
    }

    fn state(
        writes: AgentProfileRowWrite,
        reader: FakeReader,
    ) -> (
        InternalProfileWriteState<FakeWrites, FakeBlobs, FakeSink, FakeReader, FixedClock>,
        FakeBlobs,
        FakeSink,
    ) {
        let blobs = FakeBlobs::new();
        let sink = FakeSink::new();
        let state = InternalProfileWriteState {
            writes: FakeWrites::Row(writes),
            blobs: blobs.clone(),
            announce: sink.clone(),
            reader,
            clock: FixedClock,
        };
        (state, blobs, sink)
    }

    /// A multipart body with the given text parts (name, value) and an optional file part
    /// under `file`. Built by hand so the boundary's real `multer` decode runs.
    fn multipart_body(parts: &[(&str, &str)], file: Option<&[u8]>) -> (String, Vec<u8>) {
        const BOUNDARY: &str = "X-TEST-BOUNDARY";
        let mut body: Vec<u8> = Vec::new();
        for (name, value) in parts {
            body.extend_from_slice(format!("--{BOUNDARY}\r\n").as_bytes());
            body.extend_from_slice(
                format!("Content-Disposition: form-data; name=\"{name}\"\r\n\r\n").as_bytes(),
            );
            body.extend_from_slice(value.as_bytes());
            body.extend_from_slice(b"\r\n");
        }
        if let Some(bytes) = file {
            body.extend_from_slice(format!("--{BOUNDARY}\r\n").as_bytes());
            body.extend_from_slice(
                b"Content-Disposition: form-data; name=\"file\"; filename=\"avatar.png\"\r\n",
            );
            body.extend_from_slice(b"Content-Type: image/png\r\n\r\n");
            body.extend_from_slice(bytes);
            body.extend_from_slice(b"\r\n");
        }
        body.extend_from_slice(format!("--{BOUNDARY}--\r\n").as_bytes());
        (format!("multipart/form-data; boundary={BOUNDARY}"), body)
    }

    /// A tiny valid PNG header (enough bytes to pass the size floor; MIME is declared).
    fn png_bytes() -> Vec<u8> {
        vec![0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]
    }

    async fn body_json(response: Response) -> Value {
        let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        serde_json::from_slice(&bytes).unwrap_or(Value::Null)
    }

    fn router(
        state: InternalProfileWriteState<FakeWrites, FakeBlobs, FakeSink, FakeReader, FixedClock>,
    ) -> Router {
        internal_profile_write_router(state)
    }

    // ================= POST /profile =================

    #[tokio::test]
    async fn post_profile_combined_text_and_avatar_projects_the_profile_envelope() {
        // before Absent; combined display_name + avatar Set. The committed row names the
        // fresh pointer so the core seal passes; the reader returns the post-write fact.
        let writes = AgentProfileRowWrite::Committed {
            before: before("Old", AgentAvatarRow::Absent),
            row: committed("New", present(FRESH)),
        };
        let reader = FakeReader::with(Some(fact("agent-one", Some(NOW))));
        let (state, blobs, sink) = state(writes, reader.clone());
        let (content_type, body) = multipart_body(
            &[("display_name", "New"), ("avatar_action", "set")],
            Some(&png_bytes()),
        );
        let request = HttpRequest::builder()
            .method("POST")
            .uri("/internal/agents/a1/profile")
            .header("content-type", content_type)
            .extension(principal("a1"))
            .body(Body::from(body))
            .unwrap();
        let response = router(state).oneshot(request).await.unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(sink.calls(), 1, "a combined edit announces exactly once");
        assert!(
            blobs.deleted().is_empty(),
            "no prior blob to clean on a first set"
        );
        assert!(
            reader.reads() >= 1,
            "the response reprojects from the read port"
        );
        assert_eq!(
            body_json(response).await,
            json!({
                "profile": {
                    "id": "a1",
                    "name": "agent-one",
                    "display_name": "agent-one",
                    "description": "a bio",
                    "avatar_url": format!("/api/agents/a1/avatar?v={NOW}")
                }
            })
        );
    }

    #[tokio::test]
    async fn post_profile_with_nothing_to_update_is_the_admission_400_and_never_writes() {
        // No text and no avatar_action → admission's NothingToUpdate, before any write.
        let writes = AgentProfileRowWrite::NoSuchAgent; // must never be consulted
        let reader = FakeReader::with(None);
        let (state, blobs, sink) = state(writes, reader.clone());
        let (content_type, body) = multipart_body(&[("ignored", "x")], None);
        let request = HttpRequest::builder()
            .method("POST")
            .uri("/internal/agents/a1/profile")
            .header("content-type", content_type)
            .extension(principal("a1"))
            .body(Body::from(body))
            .unwrap();
        let response = router(state).oneshot(request).await.unwrap();
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        assert_eq!(
            body_json(response).await,
            json!({ "error": "no fields to update" })
        );
        assert_eq!(sink.calls(), 0);
        assert!(blobs.deleted().is_empty());
        assert_eq!(reader.reads(), 0, "a refused request never reprojects");
    }

    // ================= POST /avatar =================

    #[tokio::test]
    async fn post_avatar_projects_avatar_url_and_agent() {
        let writes = AgentProfileRowWrite::Committed {
            before: before("Name", present("agents/prior/blob-9")),
            row: committed("Name", present(FRESH)),
        };
        let reader = FakeReader::with(Some(fact("agent-one", Some(NOW))));
        let (state, blobs, sink) = state(writes, reader);
        let (content_type, body) = multipart_body(&[], Some(&png_bytes()));
        let request = HttpRequest::builder()
            .method("POST")
            .uri("/internal/agents/a1/avatar")
            .header("content-type", content_type)
            .extension(principal("a1"))
            .body(Body::from(body))
            .unwrap();
        let response = router(state).oneshot(request).await.unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(sink.calls(), 1);
        assert_eq!(
            blobs.deleted(),
            vec!["agents/prior/blob-9".to_owned()],
            "the prior blob is cleaned on a replacement"
        );
        let expected_url = format!("/api/agents/a1/avatar?v={NOW}");
        assert_eq!(
            body_json(response).await,
            json!({
                "avatar_url": expected_url,
                "agent": {
                    "id": "a1",
                    "name": "agent-one",
                    "display_name": "agent-one",
                    "description": "a bio",
                    "avatar_url": expected_url
                }
            })
        );
    }

    #[tokio::test]
    async fn post_avatar_without_a_file_is_the_admission_400() {
        let writes = AgentProfileRowWrite::NoSuchAgent;
        let reader = FakeReader::with(None);
        let (state, _blobs, sink) = state(writes, reader);
        let (content_type, body) = multipart_body(&[("nope", "x")], None);
        let request = HttpRequest::builder()
            .method("POST")
            .uri("/internal/agents/a1/avatar")
            .header("content-type", content_type)
            .extension(principal("a1"))
            .body(Body::from(body))
            .unwrap();
        let response = router(state).oneshot(request).await.unwrap();
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        assert_eq!(
            body_json(response).await,
            json!({ "error": "file field required" })
        );
        assert_eq!(sink.calls(), 0);
    }

    // ================= DELETE /avatar =================

    #[tokio::test]
    async fn delete_avatar_present_clears_the_blob_and_projects_agent() {
        let writes = AgentProfileRowWrite::Committed {
            before: before("Name", present("agents/prior/blob-9")),
            row: committed("Name", AgentAvatarRow::Absent),
        };
        let reader = FakeReader::with(Some(fact("agent-one", None)));
        let (state, blobs, sink) = state(writes, reader);
        let request = HttpRequest::builder()
            .method("DELETE")
            .uri("/internal/agents/a1/avatar")
            .extension(principal("a1"))
            .body(Body::empty())
            .unwrap();
        let response = router(state).oneshot(request).await.unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(sink.calls(), 1);
        assert_eq!(blobs.deleted(), vec!["agents/prior/blob-9".to_owned()]);
        assert_eq!(
            body_json(response).await,
            json!({
                "agent": {
                    "id": "a1",
                    "name": "agent-one",
                    "display_name": "agent-one",
                    "description": "a bio",
                    "avatar_url": Value::Null
                }
            })
        );
    }

    #[tokio::test]
    async fn delete_avatar_absent_is_a_noop_but_still_200() {
        let writes = AgentProfileRowWrite::Unchanged {
            before: before("Name", AgentAvatarRow::Absent),
        };
        let reader = FakeReader::with(Some(fact("agent-one", None)));
        let (state, blobs, sink) = state(writes, reader);
        let request = HttpRequest::builder()
            .method("DELETE")
            .uri("/internal/agents/a1/avatar")
            .extension(principal("a1"))
            .body(Body::empty())
            .unwrap();
        let response = router(state).oneshot(request).await.unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(sink.calls(), 0, "a genuine no-op announces nothing");
        assert!(blobs.deleted().is_empty());
        assert_eq!(
            body_json(response).await["agent"]["avatar_url"],
            Value::Null
        );
    }

    // ================= failure & self-pin wiring =================

    #[tokio::test]
    async fn an_absent_credential_is_a_safe_500_and_never_writes() {
        let writes = AgentProfileRowWrite::NoSuchAgent;
        let reader = FakeReader::with(None);
        let (state, _blobs, sink) = state(writes, reader.clone());
        let request = HttpRequest::builder()
            .method("DELETE")
            .uri("/internal/agents/a1/avatar")
            .body(Body::empty())
            .unwrap();
        let response = router(state).oneshot(request).await.unwrap();
        assert_eq!(response.status(), StatusCode::INTERNAL_SERVER_ERROR);
        assert_eq!(sink.calls(), 0);
        assert_eq!(reader.reads(), 0);
    }

    #[tokio::test]
    async fn a_vanished_row_is_a_404() {
        let writes = AgentProfileRowWrite::NoSuchAgent;
        let reader = FakeReader::with(None);
        let (state, _blobs, _sink) = state(writes, reader);
        let request = HttpRequest::builder()
            .method("DELETE")
            .uri("/internal/agents/a1/avatar")
            .extension(principal("a1"))
            .body(Body::empty())
            .unwrap();
        let response = router(state).oneshot(request).await.unwrap();
        assert_eq!(response.status(), StatusCode::NOT_FOUND);
        assert_eq!(
            body_json(response).await,
            json!({ "error": "agent not found" })
        );
    }

    #[tokio::test]
    async fn an_untrustworthy_commit_is_a_safe_500() {
        // A commit whose before-image names another agent: durable but untrustworthy.
        let mut other = before("Old", AgentAvatarRow::Absent);
        other.agent_id = AgentId::parse("someone-else").unwrap();
        let writes = AgentProfileRowWrite::Committed {
            before: other,
            row: committed("Name", AgentAvatarRow::Absent),
        };
        let reader = FakeReader::with(Some(fact("agent-one", None)));
        let (state, _blobs, sink) = state(writes, reader.clone());
        let request = HttpRequest::builder()
            .method("DELETE")
            .uri("/internal/agents/a1/avatar")
            .extension(principal("a1"))
            .body(Body::empty())
            .unwrap();
        let response = router(state).oneshot(request).await.unwrap();
        assert_eq!(response.status(), StatusCode::INTERNAL_SERVER_ERROR);
        assert_eq!(sink.calls(), 0, "an untrustworthy commit never announces");
        assert_eq!(reader.reads(), 0, "and never reprojects");
    }

    /// A faithful self-pin authority stand-in (the production rule is in
    /// `runtime_credential.rs`): admit ONLY when the route `{aid}` equals the enrolled
    /// agent. Proves the write routes sit BEHIND the credential layer.
    #[derive(Clone)]
    struct PinnedAuthority {
        enrolled: AgentId,
    }
    impl crate::runtime_credential::AuthenticateRuntimeCredential for PinnedAuthority {
        async fn authenticate_runtime(
            &self,
            _bearer: crate::runtime_credential::RuntimeBearer,
            route_agent: AgentId,
        ) -> Result<Option<RuntimePrincipal>, PersistenceFailure> {
            if route_agent == self.enrolled {
                Ok(Some(principal(self.enrolled.as_str())))
            } else {
                Ok(None)
            }
        }
    }

    #[tokio::test]
    async fn a_non_self_aid_is_401_before_any_write() {
        let writes = AgentProfileRowWrite::NoSuchAgent;
        let reader = FakeReader::with(None);
        let (state, _blobs, sink) = state(writes, reader.clone());
        let authority = PinnedAuthority { enrolled: agent() };
        let router =
            crate::runtime_credential::require_runtime_credential(router(state), authority);
        let request = HttpRequest::builder()
            .method("DELETE")
            .uri("/internal/agents/someone-else/avatar")
            .header(AUTHORIZATION, "Bearer test-secret")
            .body(Body::empty())
            .unwrap();
        let response = router.oneshot(request).await.unwrap();
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
        assert_eq!(sink.calls(), 0, "a non-self caller never reaches the write");
        assert_eq!(reader.reads(), 0);
    }
}
