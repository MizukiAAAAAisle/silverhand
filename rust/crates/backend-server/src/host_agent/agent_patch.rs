//! Authenticated write face for `PATCH /api/agents/{id}`: the public agent-tuning
//! edit — profile text plus model/reasoning/fast-mode — behind the visibility and
//! authority ladder.
//!
//! The route is a public MANAGEMENT-plane surface (creator-or-system on the human
//! side), so it composes the same two-authority ladder the sibling reads do, but with
//! an authority stage the read faces lack:
//!
//!  1. VISIBILITY ([`can_view_agent`], active-only) — may this caller see this agent
//!     at all? Absence, a caller outside the ACL, and a non-active stage all collapse
//!     to ONE `404 {"error":"agent not found"}`, so the surface is never an existence
//!     oracle for an agent the caller may not even see.
//!  2. AUTHORITY ([`can_edit_agent`]) — may this caller CHANGE it? Only the creator
//!     (or system) may; anyone else who could merely *see* it gets `403
//!     {"error":"forbidden"}`. Access precedes product: a refused caller never reaches
//!     the body.
//!  3. WIRE ADMISSION — parse the body against `UpdateAgentInputSchema`'s field rules.
//!     A malformed body, an out-of-range value, a `runtime` key (the product's
//!     `z.never()`), and a body naming no known field all collapse to ONE terminal
//!     `400 {"error":"invalid input"}`. (See the module note below: the Zod `issues`
//!     array is deliberately dropped, matching the ratified `PATCH /api/me`
//!     precedent — no consumer branches on it.)
//!  4. WRITE + ANNOUNCE ([`update_agent_profile_and_announce`]) — hand the RAW request
//!     to the write unit of work, which admits tuning legality UNDER its own write
//!     lock against the runtime/model/effort as they stand THERE, then commits and
//!     fires the best-effort app-scope `agent_changed` hint. Deciding legality here
//!     against the pre-read snapshot would let two concurrent PATCHes compose an
//!     illegal final runtime; under the lock the fact judged is the fact committed. A
//!     tuning rejection is the product's typed `400 {"error":<message>,"code":<code>}`
//!     with zero write and zero announce; a row that vanished before the write is the
//!     same `404`.
//!  5. PROJECT — re-read through the canonical `agent_detail` projector and return the
//!     FULL `{ "agent": AgentDto }`, so the response (its `avatar_url` cache-buster
//!     included) reflects the just-committed `updated_at`. A concurrent delete that
//!     races the projection is honest post-commit residue: the write is durable, but
//!     no trustworthy DTO can be projected, so it takes the lane's safe `500`.
//!
//! Like the read faces, the human principal is proof the authenticating perimeter
//! ran; its ABSENCE is a composition fault, not a product request, so it takes a
//! fail-closed `500` reading nothing. Mounting the real bearer perimeter is the
//! composition root's job, not this factory's — this route stays UNMOUNTED.
//!
//! ## One wire divergence, reachability-priced (flagged for review)
//!
//! The `400` body is terminally `{ "error": "invalid input" }`, WITHOUT the Zod
//! `issues` array the TS route also emits, and the `.refine` "no fields to update"
//! case collapses into it rather than a distinct body. This mirrors the ratified
//! `PATCH /api/me` decision ([`crate::human_auth`]): no shared response schema pins
//! `issues`, no agent-editing client branches on it, and reproducing the full Zod
//! issue projection would be a large, drift-prone surface with no reachable consumer.
//! The observable `error` string is preserved. The typed TUNING `400` (which DOES
//! carry a `code` a client can act on) is reproduced exactly.

use axum::{
    Json, Router,
    body::Bytes,
    extract::{Extension, Path, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::patch,
};
use serde::Serialize;
use serde_json::{Map, Value};
use silverhand_backend_core::{
    agent_detail_read::AgentDetailReadModel,
    agent_profile_write::{
        AgentChangedAnnounce, AgentChangedSink, AgentProfileUpdateOutcome, AgentProfileWriteError,
        AgentProfileWriteUnitOfWork, AgentTuningEdit, FieldEdit, RequiredEdit, TuningRejection,
        update_agent_profile_and_announce,
    },
    capability::{
        agent_authority::{AgentAuthority, can_edit_agent},
        agent_view::{VisibleStages, can_view_agent},
    },
    identity::{AgentId, Principal, UserId},
    user_identity::DisplayName,
};

use crate::clock::ProcessClock;
use crate::error;

use super::agent_wire::{AgentDto, agent_dto};

/// The product route template, in axum's `{id}` capture syntax.
pub const AGENT_PATCH_PATH: &str = "/api/agents/{id}";

/// The anti-enumeration refusal string, pinned to the TypeScript handler.
const AGENT_NOT_FOUND: &str = "agent not found";
/// The authority-refusal string (`c.json({ error: 'forbidden' }, 403)`).
const FORBIDDEN: &str = "forbidden";
/// The one terminal wire-admission refusal string (see the module note).
const INVALID_INPUT: &str = "invalid input";
/// The unmapped-error body: an unexpected failure falls to the framework default —
/// a bare `text/plain` `500`, never a JSON envelope.
const INTERNAL_ERROR_BODY: &str = "Internal Server Error";

/// `z.string().max(2000)` on the description, measured in UTF-16 code units (JS
/// `.length`).
const DESCRIPTION_MAX_UTF16: usize = 2000;
/// `ReasoningEffortTokenSchema` bounds: `.min(1).max(32)` code units.
const REASONING_TOKEN_MIN: usize = 1;
const REASONING_TOKEN_MAX: usize = 32;

#[derive(Clone)]
struct PatchState<R, W, S, C> {
    reads: R,
    writes: W,
    sink: S,
    clock: C,
}

pub fn router<R, W, S, C>(reads: R, writes: W, sink: S, clock: C) -> Router
where
    R: AgentDetailReadModel + Clone + Send + Sync + 'static,
    W: AgentProfileWriteUnitOfWork,
    S: AgentChangedSink,
    C: ProcessClock,
{
    Router::new()
        .route(AGENT_PATCH_PATH, patch(agent_patch::<R, W, S, C>))
        .with_state(PatchState {
            reads,
            writes,
            sink,
            clock,
        })
}

async fn agent_patch<R, W, S, C>(
    Path(agent_id): Path<String>,
    viewer: Option<Extension<UserId>>,
    State(state): State<PatchState<R, W, S, C>>,
    body: Bytes,
) -> Response
where
    R: AgentDetailReadModel,
    W: AgentProfileWriteUnitOfWork,
    S: AgentChangedSink,
    C: ProcessClock,
{
    let Some(Extension(viewer)) = viewer else {
        tracing::error!("agent-patch route reached without its human principal fact");
        return internal_error();
    };
    let principal = Principal::human(viewer);

    // A malformed id names no agent — the same 404 an absent row gets.
    let Ok(agent) = AgentId::parse(agent_id) else {
        return not_found();
    };

    // ONE snapshot decides visibility AND supplies the stored runtime/model/effort the
    // tuning legality is judged against, read BEFORE either gate.
    let detail = match state.reads.read_agent_detail(&agent).await {
        Ok(detail) => detail,
        Err(cause) => {
            tracing::error!(
                error_chain = %error::describe(&cause),
                "agent-patch pre-write read failed"
            );
            return internal_error();
        }
    };

    // Bind the resolved row to the request before either gate: a bundle decoded for
    // another agent is a resolver defect, the lane's safe 500.
    if let Some(detail) = detail.as_ref()
        && detail.source() != &agent
    {
        tracing::error!(
            requested = agent.as_str(),
            resolved = detail.source().as_str(),
            "agent-patch resolved for the wrong agent"
        );
        return internal_error();
    }

    // VISIBILITY (active-only): absence, non-membership, and a non-active stage all
    // collapse to one anti-enumeration 404.
    let decision = can_view_agent(
        &principal,
        &agent,
        detail
            .as_ref()
            .map(silverhand_backend_core::agent_detail_read::AgentDetailFacts::visibility),
        &VisibleStages::active_only(),
    );
    let Some(detail) = detail.filter(|_| decision.is_allowed()) else {
        return not_found();
    };

    // AUTHORITY: only the creator (or system) may change it; a viewer who is not the
    // creator gets 403.
    let authority = AgentAuthority {
        created_by_user_id: Some(detail.created_by_user_id().clone()),
    };
    if !can_edit_agent(&principal, &agent, Some(&authority)).is_allowed() {
        return forbidden();
    }

    // WIRE ADMISSION: parse against the field rules; every malformed shape is one
    // terminal `invalid input`.
    let request = match parse_patch_body(&body) {
        PatchBody::Edit(request) => request,
        PatchBody::Invalid => return invalid_input(),
    };

    // WRITE + ANNOUNCE. Tuning legality is NOT decided here against the pre-read
    // snapshot — that verdict could go stale before the write. The write unit of work
    // re-admits the raw request UNDER its own lock against the current runtime, so the
    // fact it judges is the fact it commits (a typed rejection returns below with zero
    // UPDATE, zero announce).
    let now_ms = state.clock.now_unix_millis();
    let outcome = match update_agent_profile_and_announce(
        &state.writes,
        &state.sink,
        &agent,
        &request,
        now_ms,
    )
    .await
    {
        Ok(outcome) => outcome,
        Err(err) => {
            let leaked = match &err {
                AgentProfileWriteError::Persistence(cause) => error::describe(cause),
                AgentProfileWriteError::UntrustworthyWriteFact => err.to_string(),
            };
            tracing::error!(error_chain = %leaked, "agent-patch write failed");
            return internal_error();
        }
    };
    let committed = match outcome {
        // The row vanished between the read and the write — the same 404 an absent row
        // gets at the gate.
        AgentProfileUpdateOutcome::NoSuchAgent => return not_found(),
        // Re-admitted illegal under the write lock: the product's typed 400, judged
        // against the runtime as it actually stood when the write ran.
        AgentProfileUpdateOutcome::TuningRejected(rejection) => {
            return tuning_rejected(&rejection);
        }
        AgentProfileUpdateOutcome::Committed(committed) => committed,
    };

    // The write is durable regardless of the announce; a failed hint is logged, never
    // a refusal.
    let (id, announce) = committed.into_parts();
    if let AgentChangedAnnounce::Failed(failure) = announce {
        tracing::error!(
            agent_id = id.as_str(),
            error_chain = %error::describe(&failure),
            "agent-patch committed but the agent_changed announce failed"
        );
    }

    // PROJECT: re-read the committed row through the canonical projector so the wire
    // (avatar_url cache-buster included) reflects the just-stamped `updated_at`.
    let projected = match state.reads.read_agent_detail(&id).await {
        Ok(Some(detail)) => detail,
        Ok(None) => {
            // A concurrent delete raced the projection. The write is durable, but no
            // trustworthy DTO exists — honest post-commit residue, the safe 500.
            tracing::error!(
                agent_id = id.as_str(),
                "agent-patch committed but the row was gone before it could be projected"
            );
            return internal_error();
        }
        Err(cause) => {
            tracing::error!(
                error_chain = %error::describe(&cause),
                "agent-patch post-write projection read failed"
            );
            return internal_error();
        }
    };
    if projected.source() != &id {
        tracing::error!(
            requested = id.as_str(),
            resolved = projected.source().as_str(),
            "agent-patch projection resolved for the wrong agent"
        );
        return internal_error();
    }

    Json(AgentUpdateResponse {
        agent: agent_dto(&projected),
    })
    .into_response()
}

// ===========================================================================
// Wire admission — `UpdateAgentInputSchema`
// ===========================================================================

/// The admission verdict for the PATCH body. Every malformed shape — bad JSON, a
/// non-object, an out-of-range value, a `runtime` key, or no known field — collapses
/// to [`Invalid`](PatchBody::Invalid), the one terminal `400`.
enum PatchBody {
    Edit(AgentTuningEdit),
    Invalid,
}

/// The three-valued read of one optional+nullable key: absent (leave), explicit null
/// (clear), or a present value (set).
enum Tri<'a> {
    Absent,
    Null,
    Value(&'a Value),
}

fn tri<'a>(object: &'a Map<String, Value>, key: &str) -> Tri<'a> {
    match object.get(key) {
        None => Tri::Absent,
        Some(Value::Null) => Tri::Null,
        Some(value) => Tri::Value(value),
    }
}

/// Parse the body against `UpdateAgentInputSchema`: every field optional, nullable
/// fields three-valued, `runtime` forbidden (`z.never()`), and at least one KNOWN
/// field required (`.refine(keys > 0)`). A malformed body (`c.req.json().catch(() =>
/// ({}))` → refine fails) collapses to the same `Invalid`.
fn parse_patch_body(body: &Bytes) -> PatchBody {
    let Ok(value) = serde_json::from_slice::<Value>(body) else {
        return PatchBody::Invalid;
    };
    let Some(object) = value.as_object() else {
        return PatchBody::Invalid;
    };

    // `runtime: z.never().optional()` — present with ANY value (null included) fails.
    if object.contains_key("runtime") {
        return PatchBody::Invalid;
    }

    // `display_name: DisplayNameSchema.optional()` — NOT nullable. A value is trimmed
    // and bounded by the shared authority; null or non-string is invalid.
    let display_name = match object.get("display_name") {
        None => RequiredEdit::Leave,
        Some(Value::String(raw)) => match DisplayName::parse(raw) {
            Ok(name) => RequiredEdit::Set(name.into_inner()),
            Err(_) => return PatchBody::Invalid,
        },
        Some(_) => return PatchBody::Invalid,
    };

    // `description: z.string().max(2000).nullable().optional()` — no trim, no min.
    let description = match tri(object, "description") {
        Tri::Absent => FieldEdit::Leave,
        Tri::Null => FieldEdit::Clear,
        Tri::Value(Value::String(raw)) if within_utf16_max(raw, DESCRIPTION_MAX_UTF16) => {
            FieldEdit::Set(raw.clone())
        }
        Tri::Value(_) => return PatchBody::Invalid,
    };

    // `model: z.string().nullable().optional()` — any string, no bound.
    let model = match tri(object, "model") {
        Tri::Absent => FieldEdit::Leave,
        Tri::Null => FieldEdit::Clear,
        Tri::Value(Value::String(raw)) => FieldEdit::Set(raw.clone()),
        Tri::Value(_) => return PatchBody::Invalid,
    };

    // `reasoning_effort: ReasoningEffortTokenSchema.nullable().optional()` — structural
    // token format only; per-runtime legality is the later tuning gate.
    let reasoning_effort = match tri(object, "reasoning_effort") {
        Tri::Absent => FieldEdit::Leave,
        Tri::Null => FieldEdit::Clear,
        Tri::Value(Value::String(raw)) if is_reasoning_token(raw) => FieldEdit::Set(raw.clone()),
        Tri::Value(_) => return PatchBody::Invalid,
    };

    // `fast_mode: z.boolean().nullable().optional()`.
    let fast_mode = match tri(object, "fast_mode") {
        Tri::Absent => FieldEdit::Leave,
        Tri::Null => FieldEdit::Clear,
        Tri::Value(Value::Bool(value)) => FieldEdit::Set(*value),
        Tri::Value(_) => return PatchBody::Invalid,
    };

    // `.refine(Object.keys(v).length > 0)` — on the STRIPPED object, so unknown-only
    // bodies count as empty. At least one KNOWN field must be named (a null clear
    // counts as named).
    let names_a_field = !matches!(display_name, RequiredEdit::Leave)
        || description.is_present()
        || model.is_present()
        || reasoning_effort.is_present()
        || fast_mode.is_present();
    if !names_a_field {
        return PatchBody::Invalid;
    }

    PatchBody::Edit(AgentTuningEdit {
        display_name,
        description,
        model,
        reasoning_effort,
        fast_mode,
    })
}

/// `z.string().max(max)` on the UTF-16 code-unit length (JS `.length`).
fn within_utf16_max(value: &str, max: usize) -> bool {
    value.encode_utf16().count() <= max
}

/// `ReasoningEffortTokenSchema`: `.min(1).max(32).regex(/^[a-z][a-z0-9_-]*$/)`. The
/// regex admits only ASCII `[a-z0-9_-]`, so a code-unit count equals the char count;
/// the first char must be `[a-z]`, the rest `[a-z0-9_-]`.
fn is_reasoning_token(value: &str) -> bool {
    let length = value.chars().count();
    if !(REASONING_TOKEN_MIN..=REASONING_TOKEN_MAX).contains(&length) {
        return false;
    }
    let mut chars = value.chars();
    let Some(first) = chars.next() else {
        return false;
    };
    if !first.is_ascii_lowercase() {
        return false;
    }
    chars.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_' || c == '-')
}

// ===========================================================================
// Responses
// ===========================================================================

/// Success body: `{ "agent": {AgentDto} }`, the full DTO the canonical projector
/// builds — the same shape `GET /api/agents/{id}` returns.
#[derive(Serialize)]
struct AgentUpdateResponse {
    agent: AgentDto,
}

/// The flat `{ "error": ... }` refusal body for the static refusals.
#[derive(Serialize)]
struct ErrorBody {
    error: &'static str,
}

/// The typed tuning refusal body, `{ "error": <message>, "code": <code> }`, mirroring
/// `agentServiceErrorBody`.
#[derive(Serialize)]
struct TuningErrorBody {
    error: String,
    code: &'static str,
}

fn not_found() -> Response {
    (
        StatusCode::NOT_FOUND,
        Json(ErrorBody {
            error: AGENT_NOT_FOUND,
        }),
    )
        .into_response()
}

fn forbidden() -> Response {
    (StatusCode::FORBIDDEN, Json(ErrorBody { error: FORBIDDEN })).into_response()
}

fn invalid_input() -> Response {
    (
        StatusCode::BAD_REQUEST,
        Json(ErrorBody {
            error: INVALID_INPUT,
        }),
    )
        .into_response()
}

fn tuning_rejected(rejection: &TuningRejection) -> Response {
    (
        StatusCode::BAD_REQUEST,
        Json(TuningErrorBody {
            error: rejection.message(),
            code: rejection.code(),
        }),
    )
        .into_response()
}

fn internal_error() -> Response {
    (StatusCode::INTERNAL_SERVER_ERROR, INTERNAL_ERROR_BODY).into_response()
}

#[cfg(test)]
mod tests {
    use std::{
        io,
        sync::{
            Arc,
            atomic::{AtomicUsize, Ordering::SeqCst},
        },
    };

    use axum::{
        body::{Body, to_bytes},
        http::{Request, StatusCode},
    };
    use serde_json::{Value, json};
    use silverhand_backend_core::{
        agent_detail_read::{AgentDetailFacts, AgentDetailProjection, AgentDetailReadModel},
        agent_lifecycle::MaterializationStatus,
        agent_profile_write::{
            AgentProfileRowWrite, AgentProfileWriteUnitOfWork, AgentTuningContext,
            CommittedAgentRow, FieldEdit, RequiredEdit, admit_public_tuning_edit,
        },
        agents::runtime::RuntimeKind,
        identity::{AgentId, UserId},
        persistence::PersistenceFailure,
    };
    use tower::ServiceExt;

    use super::*;

    fn user(id: &str) -> UserId {
        UserId::parse(id).expect("user id")
    }

    fn agent(id: &str) -> AgentId {
        AgentId::parse(id).expect("agent id")
    }

    // ---- fakes ----

    #[derive(Clone)]
    struct FixedClock(i64);
    impl ProcessClock for FixedClock {
        fn now_unix_millis(&self) -> i64 {
            self.0
        }
    }
    const NOW: i64 = 5000;

    /// A read model that answers the pre-write read with `first` and every later read
    /// (the post-commit projection) with `rest`, so a test can make the projection
    /// race a delete or return the updated row.
    #[derive(Clone)]
    struct FakeReads {
        first: ReadOutcome,
        rest: ReadOutcome,
        calls: Arc<AtomicUsize>,
    }

    #[derive(Clone)]
    enum ReadOutcome {
        Present(Box<AgentDetailFacts>),
        Absent,
        Fails,
    }

    impl FakeReads {
        fn new(first: ReadOutcome, rest: ReadOutcome) -> Self {
            Self {
                first,
                rest,
                calls: Arc::new(AtomicUsize::new(0)),
            }
        }
    }

    impl AgentDetailReadModel for FakeReads {
        async fn read_agent_detail(
            &self,
            _agent: &AgentId,
        ) -> Result<Option<AgentDetailFacts>, PersistenceFailure> {
            let nth = self.calls.fetch_add(1, SeqCst);
            let outcome = if nth == 0 { &self.first } else { &self.rest };
            match outcome {
                ReadOutcome::Present(facts) => Ok(Some(facts.as_ref().clone())),
                ReadOutcome::Absent => Ok(None),
                ReadOutcome::Fails => {
                    Err(PersistenceFailure::from_source(io::Error::other("boom")))
                }
            }
        }
    }

    fn present(facts: AgentDetailFacts) -> ReadOutcome {
        ReadOutcome::Present(Box::new(facts))
    }

    /// A write unit of work that models the real adapter: it admits the RAW request
    /// UNDER the lock against a configured current tuning `context` (defaulting to the
    /// codex/`gpt-5.6-sol` full state) to decide the branch, then reports only the
    /// WITNESSES the real port does — the before-image it read, plus, on an admit, a
    /// base row sealed so every touched column, the id, and `updated_at = now` match the
    /// core replay's seal. It never returns a product verdict; the core re-derives that
    /// from the before-image. The authoritative under-lock enforcement (and its
    /// concurrent falsifier) lives in the sqlite adapter's tests; here we only need a
    /// faithful outcome to check the handler's response mapping.
    #[derive(Clone)]
    struct SealingWrites {
        outcome: WriteOutcome,
        context: AgentTuningContext,
        calls: Arc<AtomicUsize>,
    }

    #[derive(Clone)]
    enum WriteOutcome {
        Commits,
        NoSuchAgent,
        Fails,
    }

    impl SealingWrites {
        fn new(outcome: WriteOutcome) -> Self {
            Self {
                outcome,
                context: codex_context(),
                calls: Arc::new(AtomicUsize::new(0)),
            }
        }

        /// Set the locked current context the fake admits against — e.g. a claude agent
        /// so a `fast_mode` edit is re-rejected under the lock.
        fn with_context(mut self, context: AgentTuningContext) -> Self {
            self.context = context;
            self
        }
    }

    impl AgentProfileWriteUnitOfWork for SealingWrites {
        async fn admit_and_apply_tuning_edit(
            &self,
            agent: &AgentId,
            request: &AgentTuningEdit,
            now_ms: i64,
        ) -> Result<AgentProfileRowWrite, PersistenceFailure> {
            self.calls.fetch_add(1, SeqCst);
            match self.outcome {
                WriteOutcome::NoSuchAgent => Ok(AgentProfileRowWrite::NoSuchAgent),
                WriteOutcome::Fails => Err(PersistenceFailure::from_source(io::Error::other(
                    "write boom",
                ))),
                WriteOutcome::Commits => {
                    // The lock is held: admit against the current context to decide the
                    // branch, then report only the WITNESS — the before-image, plus the
                    // committed row on an admit. The verdict itself is the core's to
                    // re-derive from `before`; this fake never returns it.
                    match admit_public_tuning_edit(&self.context, request.clone()) {
                        Err(_rejection) => Ok(AgentProfileRowWrite::Unchanged {
                            before: self.context.clone(),
                        }),
                        Ok(edit) => {
                            let display_name = match edit.display_name() {
                                RequiredEdit::Leave => "Base Name".to_owned(),
                                RequiredEdit::Set(value) => value.clone(),
                            };
                            let row = CommittedAgentRow {
                                id: agent.clone(),
                                display_name,
                                description: apply_str(edit.description(), Some("base desc")),
                                model: apply_str(edit.model(), Some("gpt-5.6-sol")),
                                reasoning_effort: apply_str(edit.reasoning_effort(), Some("ultra")),
                                fast_mode: apply_bool(edit.fast_mode(), Some(true)),
                                updated_at: now_ms,
                            };
                            Ok(AgentProfileRowWrite::Committed {
                                before: self.context.clone(),
                                row,
                            })
                        }
                    }
                }
            }
        }
    }

    fn codex_context() -> AgentTuningContext {
        AgentTuningContext {
            runtime: RuntimeKind::Codex,
            model: Some("gpt-5.6-sol".to_owned()),
            reasoning_effort: Some("ultra".to_owned()),
        }
    }

    fn claude_context() -> AgentTuningContext {
        AgentTuningContext {
            runtime: RuntimeKind::Claude,
            model: None,
            reasoning_effort: None,
        }
    }

    fn apply_str(edit: &FieldEdit<String>, base: Option<&str>) -> Option<String> {
        match edit {
            FieldEdit::Leave => base.map(str::to_owned),
            FieldEdit::Clear => None,
            FieldEdit::Set(value) => Some(value.clone()),
        }
    }

    fn apply_bool(edit: &FieldEdit<bool>, base: Option<bool>) -> Option<bool> {
        match edit {
            FieldEdit::Leave => base,
            FieldEdit::Clear => None,
            FieldEdit::Set(value) => Some(*value),
        }
    }

    /// A `agent_changed` sink recording its calls; `fail` makes the announce fail (the
    /// commit must still succeed).
    #[derive(Clone)]
    struct FakeSink {
        calls: Arc<AtomicUsize>,
        fail: bool,
    }
    impl FakeSink {
        fn new(fail: bool) -> Self {
            Self {
                calls: Arc::new(AtomicUsize::new(0)),
                fail,
            }
        }
    }
    impl AgentChangedSink for FakeSink {
        async fn agent_changed(
            &self,
            _agent: &AgentId,
        ) -> Result<(), silverhand_backend_core::agent_profile_write::AgentChangedAnnounceFailure>
        {
            self.calls.fetch_add(1, SeqCst);
            if self.fail {
                Err(
                    silverhand_backend_core::agent_profile_write::AgentChangedAnnounceFailure::from_source(
                        io::Error::other("bus down"),
                    ),
                )
            } else {
                Ok(())
            }
        }
    }

    // ---- fixtures ----

    /// A codex projection: model gpt-5.6-sol, reasoning ultra, fast_mode true — a full
    /// tuning state the edits below stay legal against.
    fn codex_projection() -> AgentDetailProjection {
        AgentDetailProjection {
            name: "agent-one".to_owned(),
            display_name: "Base Name".to_owned(),
            runtime: RuntimeKind::Codex,
            model: Some("gpt-5.6-sol".to_owned()),
            reasoning_effort: Some("ultra".to_owned()),
            fast_mode: Some(true),
            host_id: "h1".to_owned(),
            host_display_label: Some("Host One".to_owned()),
            host_name: Some("host-one".to_owned()),
            description: Some("base desc".to_owned()),
            session_scope: "agent".to_owned(),
            avatar_storage_key: Some("avatars/a1.png".to_owned()),
            materialization_failed_code: None,
            materialization_failed_at: None,
            deletion_started_at: None,
            created_at: 1000,
            updated_at: 2000,
        }
    }

    /// The creator arm admits `viewer-1`; active stage; codex projection.
    fn creator_facts() -> AgentDetailFacts {
        AgentDetailFacts::from_source(
            agent("a1"),
            user("viewer-1"),
            [],
            [],
            MaterializationStatus::Active,
            codex_projection(),
        )
    }

    /// A workspace-member arm: `viewer-1` may SEE it but did not create it (creator is
    /// `creator-user`), so authority refuses.
    fn workspace_only_facts() -> AgentDetailFacts {
        AgentDetailFacts::from_source(
            agent("a1"),
            user("creator-user"),
            [],
            [user("viewer-1")],
            MaterializationStatus::Active,
            codex_projection(),
        )
    }

    /// The committed projection the post-write read returns: the renamed display name,
    /// `high` effort, and the bumped `updated_at` the wire's avatar cache-buster reads.
    fn committed_projection() -> AgentDetailProjection {
        let mut projection = codex_projection();
        projection.display_name = "Renamed".to_owned();
        projection.reasoning_effort = Some("high".to_owned());
        projection.updated_at = NOW;
        projection
    }

    fn committed_facts() -> AgentDetailFacts {
        AgentDetailFacts::from_source(
            agent("a1"),
            user("viewer-1"),
            [],
            [],
            MaterializationStatus::Active,
            committed_projection(),
        )
    }

    struct Reply {
        status: StatusCode,
        body: String,
        reads: usize,
        writes: usize,
        announces: usize,
    }

    async fn patch_with(
        reads: FakeReads,
        writes: SealingWrites,
        sink: FakeSink,
        path_id: &str,
        body: &str,
        with_principal: bool,
    ) -> Reply {
        let read_calls = reads.calls.clone();
        let write_calls = writes.calls.clone();
        let announce_calls = sink.calls.clone();
        let uri = format!("/api/agents/{path_id}");
        let mut request = Request::patch(&uri).header("content-type", "application/json");
        if with_principal {
            request = request.extension(user("viewer-1"));
        }
        let response = router(reads, writes, sink, FixedClock(NOW))
            .oneshot(request.body(Body::from(body.to_owned())).unwrap())
            .await
            .unwrap();
        let status = response.status();
        let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        Reply {
            status,
            body: String::from_utf8(bytes.to_vec()).unwrap(),
            reads: read_calls.load(SeqCst),
            writes: write_calls.load(SeqCst),
            announces: announce_calls.load(SeqCst),
        }
    }

    /// The ordinary admitting run: creator sees the row, writes commit and re-project.
    async fn ok_run(body: &str) -> Reply {
        patch_with(
            FakeReads::new(present(creator_facts()), present(committed_facts())),
            SealingWrites::new(WriteOutcome::Commits),
            FakeSink::new(false),
            "a1",
            body,
            true,
        )
        .await
    }

    fn parsed(body: &str) -> Value {
        serde_json::from_str::<Value>(body).unwrap()
    }

    // ---- the happy path ----

    #[tokio::test]
    async fn a_legal_edit_commits_announces_and_returns_the_reprojected_dto() {
        let reply = ok_run(r#"{"display_name":"Renamed","reasoning_effort":"high"}"#).await;
        assert_eq!(reply.status, StatusCode::OK);
        // The response is the FULL DTO, re-read post-commit: the new name/effort and
        // the avatar cache-buster on the just-stamped updated_at.
        let dto = &parsed(&reply.body)["agent"];
        assert_eq!(dto["display_name"], "Renamed");
        assert_eq!(dto["reasoning_effort"], "high");
        assert_eq!(dto["updated_at"], NOW);
        assert_eq!(dto["avatar_url"], format!("/api/agents/a1/avatar?v={NOW}"));
        // One write, one announce, and two reads (pre-write gate + post-commit project).
        assert_eq!(reply.writes, 1);
        assert_eq!(reply.announces, 1);
        assert_eq!(reply.reads, 2);
    }

    #[tokio::test]
    async fn a_failed_announce_does_not_flip_the_committed_write() {
        let reply = patch_with(
            FakeReads::new(present(creator_facts()), present(committed_facts())),
            SealingWrites::new(WriteOutcome::Commits),
            FakeSink::new(true),
            "a1",
            r#"{"display_name":"Renamed"}"#,
            true,
        )
        .await;
        assert_eq!(reply.status, StatusCode::OK);
        assert_eq!(reply.announces, 1);
    }

    #[tokio::test]
    async fn display_name_is_trimmed_by_the_shared_authority_before_the_write() {
        // The admission trims, so the sealed edit — and the committed row the write
        // must match — carries the trimmed name.
        let reply = patch_with(
            FakeReads::new(present(creator_facts()), present(committed_facts())),
            SealingWrites::new(WriteOutcome::Commits),
            FakeSink::new(false),
            "a1",
            "{\"display_name\":\"  Renamed  \"}",
            true,
        )
        .await;
        assert_eq!(reply.status, StatusCode::OK);
    }

    // ---- the ladder ----

    #[tokio::test]
    async fn a_missing_principal_is_a_safe_500_that_never_reads() {
        let reply = patch_with(
            FakeReads::new(present(creator_facts()), present(committed_facts())),
            SealingWrites::new(WriteOutcome::Commits),
            FakeSink::new(false),
            "a1",
            r#"{"display_name":"Renamed"}"#,
            false,
        )
        .await;
        assert_eq!(reply.status, StatusCode::INTERNAL_SERVER_ERROR);
        assert_eq!(reply.body, "Internal Server Error");
        assert_eq!(reply.reads, 0);
        assert_eq!(reply.writes, 0);
    }

    #[tokio::test]
    async fn an_absent_row_is_the_anti_enumeration_404_and_never_writes() {
        let reply = patch_with(
            FakeReads::new(ReadOutcome::Absent, ReadOutcome::Absent),
            SealingWrites::new(WriteOutcome::Commits),
            FakeSink::new(false),
            "a1",
            r#"{"display_name":"Renamed"}"#,
            true,
        )
        .await;
        assert_eq!(reply.status, StatusCode::NOT_FOUND);
        assert_eq!(parsed(&reply.body), json!({ "error": "agent not found" }));
        assert_eq!(reply.writes, 0);
    }

    #[tokio::test]
    async fn a_viewer_who_cannot_see_it_is_the_same_404() {
        // A caller in no arm at all: creator is someone else, no pair, no shared ws.
        let facts = AgentDetailFacts::from_source(
            agent("a1"),
            user("someone-else"),
            [],
            [],
            MaterializationStatus::Active,
            codex_projection(),
        );
        let reply = patch_with(
            FakeReads::new(present(facts.clone()), present(facts)),
            SealingWrites::new(WriteOutcome::Commits),
            FakeSink::new(false),
            "a1",
            r#"{"display_name":"Renamed"}"#,
            true,
        )
        .await;
        assert_eq!(reply.status, StatusCode::NOT_FOUND);
        assert_eq!(parsed(&reply.body), json!({ "error": "agent not found" }));
        assert_eq!(reply.writes, 0);
    }

    #[tokio::test]
    async fn a_non_active_stage_is_the_same_404() {
        let facts = AgentDetailFacts::from_source(
            agent("a1"),
            user("viewer-1"),
            [],
            [],
            MaterializationStatus::Failed,
            codex_projection(),
        );
        let reply = patch_with(
            FakeReads::new(present(facts.clone()), present(facts)),
            SealingWrites::new(WriteOutcome::Commits),
            FakeSink::new(false),
            "a1",
            r#"{"display_name":"Renamed"}"#,
            true,
        )
        .await;
        assert_eq!(reply.status, StatusCode::NOT_FOUND);
        assert_eq!(reply.writes, 0);
    }

    #[tokio::test]
    async fn a_viewer_who_is_not_the_creator_is_forbidden_and_never_writes() {
        let reply = patch_with(
            FakeReads::new(present(workspace_only_facts()), present(committed_facts())),
            SealingWrites::new(WriteOutcome::Commits),
            FakeSink::new(false),
            "a1",
            r#"{"display_name":"Renamed"}"#,
            true,
        )
        .await;
        assert_eq!(reply.status, StatusCode::FORBIDDEN);
        assert_eq!(parsed(&reply.body), json!({ "error": "forbidden" }));
        assert_eq!(reply.writes, 0);
    }

    // ---- wire admission (400 invalid input) ----

    #[tokio::test]
    async fn every_malformed_body_is_one_terminal_invalid_input() {
        for body in [
            "not json",
            "[]",
            "5",
            "{}",                             // no fields (refine)
            r#"{"unknown":1}"#,               // unknown-only → stripped → empty
            r#"{"runtime":"codex"}"#,         // z.never()
            r#"{"display_name":null}"#,       // not nullable
            r#"{"display_name":""}"#,         // trimmed to empty → min(1) fails
            r#"{"display_name":123}"#,        // not a string
            r#"{"description":5}"#,           // not a string
            r#"{"model":5}"#,                 // not a string
            r#"{"reasoning_effort":"BAD"}"#,  // uppercase → regex fails
            r#"{"reasoning_effort":"1bad"}"#, // leading digit → regex fails
            r#"{"fast_mode":"yes"}"#,         // not a boolean
        ] {
            let reply = patch_with(
                FakeReads::new(present(creator_facts()), present(committed_facts())),
                SealingWrites::new(WriteOutcome::Commits),
                FakeSink::new(false),
                "a1",
                body,
                true,
            )
            .await;
            assert_eq!(
                reply.status,
                StatusCode::BAD_REQUEST,
                "body {body:?} must be 400"
            );
            assert_eq!(
                parsed(&reply.body),
                json!({ "error": "invalid input" }),
                "body {body:?} must be terminal invalid input"
            );
            assert_eq!(reply.writes, 0, "body {body:?} must not write");
        }
    }

    #[tokio::test]
    async fn a_description_over_two_thousand_units_is_invalid_but_at_the_bound_is_ok() {
        let at_bound = "x".repeat(2000);
        let over = "x".repeat(2001);
        let ok = ok_run(&format!(r#"{{"description":"{at_bound}"}}"#)).await;
        assert_eq!(ok.status, StatusCode::OK);
        let bad = ok_run(&format!(r#"{{"description":"{over}"}}"#)).await;
        assert_eq!(bad.status, StatusCode::BAD_REQUEST);
        assert_eq!(parsed(&bad.body), json!({ "error": "invalid input" }));
    }

    #[tokio::test]
    async fn a_null_clears_a_nullable_field() {
        // description: null is a Clear, a valid edit → 200 (not invalid input).
        let reply = ok_run(r#"{"description":null}"#).await;
        assert_eq!(reply.status, StatusCode::OK);
        assert_eq!(reply.writes, 1);
    }

    // ---- tuning legality (typed 400) ----

    #[tokio::test]
    async fn an_illegal_reasoning_effort_is_the_typed_tuning_400() {
        // `none` is qoder's token; against the write's locked codex/sol context it is
        // out of range, so the UoW re-admits and returns a typed rejection.
        let reply = ok_run(r#"{"reasoning_effort":"none"}"#).await;
        assert_eq!(reply.status, StatusCode::BAD_REQUEST);
        assert_eq!(
            parsed(&reply.body),
            json!({
                "error": "reasoning_effort 'none' is not valid for runtime 'codex' and model 'gpt-5.6-sol'",
                "code": "reasoning_effort_invalid_for_runtime"
            })
        );
        // The UoW WAS consulted (that is where legality is now judged), but it committed
        // nothing: no `agent_changed` announce fired.
        assert_eq!(reply.writes, 1);
        assert_eq!(reply.announces, 0);
    }

    #[tokio::test]
    async fn a_fast_mode_set_on_a_claude_agent_is_the_typed_tuning_400() {
        // The write's locked context is a claude agent, which does not support fast
        // mode, so the raw `fast_mode: true` request is re-rejected under the lock.
        let reply = patch_with(
            FakeReads::new(present(creator_facts()), present(committed_facts())),
            SealingWrites::new(WriteOutcome::Commits).with_context(claude_context()),
            FakeSink::new(false),
            "a1",
            r#"{"fast_mode":true}"#,
            true,
        )
        .await;
        assert_eq!(reply.status, StatusCode::BAD_REQUEST);
        assert_eq!(
            parsed(&reply.body),
            json!({
                "error": "fast_mode is not valid for runtime 'claude'",
                "code": "fast_mode_invalid_for_runtime"
            })
        );
        assert_eq!(reply.writes, 1);
        assert_eq!(reply.announces, 0);
    }

    // ---- write-stage outcomes ----

    #[tokio::test]
    async fn a_row_deleted_between_read_and_write_is_a_404() {
        let reply = patch_with(
            FakeReads::new(present(creator_facts()), present(committed_facts())),
            SealingWrites::new(WriteOutcome::NoSuchAgent),
            FakeSink::new(false),
            "a1",
            r#"{"display_name":"Renamed"}"#,
            true,
        )
        .await;
        assert_eq!(reply.status, StatusCode::NOT_FOUND);
        assert_eq!(parsed(&reply.body), json!({ "error": "agent not found" }));
        assert_eq!(reply.announces, 0);
    }

    #[tokio::test]
    async fn a_write_persistence_failure_is_a_safe_500() {
        let reply = patch_with(
            FakeReads::new(present(creator_facts()), present(committed_facts())),
            SealingWrites::new(WriteOutcome::Fails),
            FakeSink::new(false),
            "a1",
            r#"{"display_name":"Renamed"}"#,
            true,
        )
        .await;
        assert_eq!(reply.status, StatusCode::INTERNAL_SERVER_ERROR);
        assert_eq!(reply.body, "Internal Server Error");
        assert!(!reply.body.contains("write boom"));
    }

    #[tokio::test]
    async fn a_delete_that_races_the_projection_is_honest_post_commit_residue_500() {
        // The write commits, but the row is gone before the DTO can be re-read: the
        // write is durable, yet no trustworthy DTO exists → safe 500.
        let reply = patch_with(
            FakeReads::new(present(creator_facts()), ReadOutcome::Absent),
            SealingWrites::new(WriteOutcome::Commits),
            FakeSink::new(false),
            "a1",
            r#"{"display_name":"Renamed"}"#,
            true,
        )
        .await;
        assert_eq!(reply.status, StatusCode::INTERNAL_SERVER_ERROR);
        assert_eq!(reply.body, "Internal Server Error");
        // It DID write and announce; only the projection failed.
        assert_eq!(reply.writes, 1);
        assert_eq!(reply.announces, 1);
    }

    #[tokio::test]
    async fn a_pre_write_read_failure_is_a_safe_500_that_never_writes() {
        let reply = patch_with(
            FakeReads::new(ReadOutcome::Fails, ReadOutcome::Fails),
            SealingWrites::new(WriteOutcome::Commits),
            FakeSink::new(false),
            "a1",
            r#"{"display_name":"Renamed"}"#,
            true,
        )
        .await;
        assert_eq!(reply.status, StatusCode::INTERNAL_SERVER_ERROR);
        assert_eq!(reply.writes, 0);
    }

    #[tokio::test]
    async fn a_bundle_resolved_for_another_agent_is_a_safe_500() {
        let spliced = AgentDetailFacts::from_source(
            agent("a2"),
            user("viewer-1"),
            [],
            [],
            MaterializationStatus::Active,
            codex_projection(),
        );
        let reply = patch_with(
            FakeReads::new(present(spliced.clone()), present(spliced)),
            SealingWrites::new(WriteOutcome::Commits),
            FakeSink::new(false),
            "a1",
            r#"{"display_name":"Renamed"}"#,
            true,
        )
        .await;
        assert_eq!(reply.status, StatusCode::INTERNAL_SERVER_ERROR);
        assert_eq!(reply.writes, 0);
    }
}
