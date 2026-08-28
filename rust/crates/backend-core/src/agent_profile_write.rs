//! The canonical `agents`-row write authority for the public tuning `PATCH
//! /api/agents/{id}` — the ONE place a mutable agent column is admitted, sealed,
//! and committed, with the `agent_changed` announce it owes.
//!
//! ## Why this is a single authority, entered only through a sealed edit
//!
//! Every mutable `agents` column (`display_name`, `description`, `model`,
//! `reasoning_effort`, `fast_mode`, and later the avatar pointer) is written here
//! and nowhere else, so a value legal for one capability (the public tuning PATCH)
//! can never be smuggled through a path meant for another (the internal profile
//! POST, the avatar routes). That guarantee does NOT come from a wide, freely
//! constructible edit struct — that would let any caller hand-craft a write that
//! silently changes `model` alongside an avatar. It comes from an OPAQUE
//! [`AdmittedAgentProfileEdit`] with no public constructor: the only way to mint one
//! is a per-capability admission fn (this module ships [`admit_public_tuning_edit`];
//! the internal-profile and avatar constructors land with their own routes), each
//! of which can express only the columns that capability is allowed to touch. The
//! persistence port therefore sees a SEALED edit plus a clock witness — never a raw
//! column bag.
//!
//! ## Legality is enforced at admission, against the CURRENT stored runtime
//!
//! PATCH cannot change `runtime` (the product's `z.never()`), so the tuning legality
//! ([`crate::agents::runtime_capability`]) is judged against the stored runtime and
//! the post-edit model/effort: `reasoning_effort` first, then `fast_mode`, mirroring
//! `agent-service.ts`'s `normalizeRuntimeTuning`. A refusal is a product `400`
//! carried in [`TuningRejection`], not a write attempt.
//!
//! ## The committed fact is NARROW; the DTO is composed post-commit
//!
//! The write seals only what it actually committed — the agent id, the write
//! instant, and the touched column values — and returns the announce fate. It does
//! NOT carry the host `LEFT JOIN` label or the avatar-URL derivation: those are wire
//! projections the server layer composes by re-reading through the canonical
//! `agent_detail` read projector after the commit. A response field is not a write
//! fact.

use std::future::Future;

use thiserror::Error;

use crate::{
    agents::{
        runtime::RuntimeKind,
        runtime_capability::{reasoning_effort_valid_for_runtime, runtime_supports_fast_mode},
    },
    identity::AgentId,
    persistence::PersistenceFailure,
};

// ===========================================================================
// The edit algebra: three-valued for nullable columns, two-valued for the
// non-nullable display name.
// ===========================================================================

/// A three-valued edit for a NULLABLE column: absent leaves it untouched, an
/// explicit null clears it, a value sets it — the product's `absent | null | value`
/// PATCH algebra for `description`, `model`, `reasoning_effort`, `fast_mode`.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum FieldEdit<T> {
    Leave,
    Clear,
    Set(T),
}

impl<T> FieldEdit<T> {
    /// Whether this edit names the column at all — `true` for `Clear`/`Set`. Used to
    /// decide when the tuning legality must be re-judged, mirroring the product's
    /// `reasoning_effort !== undefined || model !== undefined` guard.
    pub fn is_present(&self) -> bool {
        !matches!(self, FieldEdit::Leave)
    }
}

/// A two-valued edit for the NON-nullable `display_name`: absent leaves it, a value
/// sets it. It can never be cleared — the product models it `z.string().optional()`
/// with no null arm.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum RequiredEdit<T> {
    Leave,
    Set(T),
}

// ===========================================================================
// The public request and the current-state witness admission reads.
// ===========================================================================

/// The parsed, format-valid PATCH body — the columns the public tuning route may
/// touch. Format admission (trim, length, the `runtime: z.never()` refusal) is a
/// wire concern settled in the server layer before this is built; this struct
/// carries only the shape the domain admits for legality.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AgentTuningEdit {
    pub display_name: RequiredEdit<String>,
    pub description: FieldEdit<String>,
    pub model: FieldEdit<String>,
    pub reasoning_effort: FieldEdit<String>,
    pub fast_mode: FieldEdit<bool>,
}

/// The stored state the tuning legality is judged against. `runtime` is fixed (PATCH
/// cannot change it); `model`/`reasoning_effort` are the current values a left-alone
/// column falls back to when computing the post-edit pair.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AgentTuningContext {
    pub runtime: RuntimeKind,
    pub model: Option<String>,
    pub reasoning_effort: Option<String>,
}

/// Why a tuning edit was refused at admission — the product's two runtime-legality
/// `400`s. No blob or row was touched.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum TuningRejection {
    /// The post-edit `reasoning_effort` is not legal for the stored runtime/model —
    /// the product's `reasoning_effort_invalid_for_runtime`.
    ReasoningEffortInvalidForRuntime,
    /// `fast_mode` was set on a runtime that does not support it — the product's
    /// `fast_mode_invalid_for_runtime`.
    FastModeInvalidForRuntime,
}

impl TuningRejection {
    /// The stable public error code, unchanged from the product's `AgentServiceError`.
    pub const fn code(self) -> &'static str {
        match self {
            Self::ReasoningEffortInvalidForRuntime => "reasoning_effort_invalid_for_runtime",
            Self::FastModeInvalidForRuntime => "fast_mode_invalid_for_runtime",
        }
    }
}

// ===========================================================================
// The sealed, capability-scoped edit the persistence port consumes.
// ===========================================================================

/// An admitted `agents`-row edit — the ONLY thing the persistence port accepts.
///
/// It has NO public constructor: a value exists only if a per-capability admission
/// fn ([`admit_public_tuning_edit`] today) minted it, so a caller cannot fabricate a
/// write that touches columns its capability may not. Its accessors are public so
/// the persistence adapter can read which columns to `SET`, but the shape is
/// otherwise opaque — the adapter learns the intended values, never gains the power
/// to construct an intent. The avatar arm is carried as `Leave` here because the
/// tuning capability never touches it; the avatar and internal-profile constructors
/// (their own routes) set it.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AdmittedAgentProfileEdit {
    display_name: RequiredEdit<String>,
    description: FieldEdit<String>,
    model: FieldEdit<String>,
    reasoning_effort: FieldEdit<String>,
    fast_mode: FieldEdit<bool>,
}

impl AdmittedAgentProfileEdit {
    pub fn display_name(&self) -> &RequiredEdit<String> {
        &self.display_name
    }
    pub fn description(&self) -> &FieldEdit<String> {
        &self.description
    }
    pub fn model(&self) -> &FieldEdit<String> {
        &self.model
    }
    pub fn reasoning_effort(&self) -> &FieldEdit<String> {
        &self.reasoning_effort
    }
    pub fn fast_mode(&self) -> &FieldEdit<bool> {
        &self.fast_mode
    }
}

/// Admit a PUBLIC tuning PATCH into a sealed edit, or refuse it.
///
/// Legality is judged exactly as `normalizeRuntimeTuning`: compute the post-edit
/// model and effort (a left-alone column keeps its stored value), and — only when
/// the request names `reasoning_effort` OR `model` — require the pair legal for the
/// stored runtime. Then, independently, refuse a `fast_mode` SET on a runtime that
/// does not support it. `reasoning_effort` is judged before `fast_mode`, so a body
/// that trips both surfaces the reasoning refusal, matching the product order.
pub fn admit_public_tuning_edit(
    context: &AgentTuningContext,
    request: AgentTuningEdit,
) -> Result<AdmittedAgentProfileEdit, TuningRejection> {
    // The post-edit pair: a left-alone column falls back to the stored value; a
    // clear becomes absent; a set becomes the new value.
    let next_model: Option<&str> = match &request.model {
        FieldEdit::Leave => context.model.as_deref(),
        FieldEdit::Clear => None,
        FieldEdit::Set(value) => Some(value.as_str()),
    };
    let next_reasoning: Option<&str> = match &request.reasoning_effort {
        FieldEdit::Leave => context.reasoning_effort.as_deref(),
        FieldEdit::Clear => None,
        FieldEdit::Set(value) => Some(value.as_str()),
    };

    // Re-judge reasoning legality only when the request names either input — the
    // product's `reasoning_effort !== undefined || model !== undefined` guard.
    if (request.reasoning_effort.is_present() || request.model.is_present())
        && !reasoning_effort_valid_for_runtime(context.runtime, next_reasoning, next_model)
    {
        return Err(TuningRejection::ReasoningEffortInvalidForRuntime);
    }

    // A `fast_mode` SET (present, non-null) demands runtime support; a clear/leave
    // never does — the product's `!== undefined && !== null` guard.
    if matches!(request.fast_mode, FieldEdit::Set(_))
        && !runtime_supports_fast_mode(context.runtime)
    {
        return Err(TuningRejection::FastModeInvalidForRuntime);
    }

    Ok(AdmittedAgentProfileEdit {
        display_name: request.display_name,
        description: request.description,
        model: request.model,
        reasoning_effort: request.reasoning_effort,
        fast_mode: request.fast_mode,
    })
}

// ===========================================================================
// The persistence port and its raw outcome.
// ===========================================================================

/// The committed `agents`-row values a write returns for SEALING — the id, the write
/// instant, and every column the tuning capability can touch. This is NOT the wire
/// DTO: it carries no host `LEFT JOIN` label and no avatar URL. The adapter fills it
/// from the `UPDATE ... RETURNING` under its write lock.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CommittedAgentRow {
    pub id: AgentId,
    pub display_name: String,
    pub description: Option<String>,
    pub model: Option<String>,
    pub reasoning_effort: Option<String>,
    pub fast_mode: Option<bool>,
    pub updated_at: i64,
}

/// The raw outcome of applying a sealed edit, decided under the adapter's write lock.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum AgentProfileRowWrite {
    /// No such agent row — the route maps this to a product `404`.
    NoSuchAgent,
    /// The row was updated and `updated_at` stamped to `now_ms`; carries the
    /// committed columns for the seal. A tuning edit always writes (it always bumps
    /// `updated_at`), so it never reports a no-op; the avatar-clear capability, which
    /// CAN be an idempotent no-op, gets its own `Unchanged` arm when it lands.
    Committed(CommittedAgentRow),
}

/// The atomic `agents`-row write on the tuning capability. The adapter applies the
/// sealed edit's `SET` columns, stamps `updated_at = now_ms`, and returns the
/// committed columns via `RETURNING`, all under one write lock.
pub trait AgentProfileWriteUnitOfWork: Clone + Send + Sync + 'static {
    fn apply_profile_edit(
        &self,
        agent: &AgentId,
        edit: &AdmittedAgentProfileEdit,
        now_ms: i64,
    ) -> impl Future<Output = Result<AgentProfileRowWrite, PersistenceFailure>> + Send;
}

// ===========================================================================
// The announce seam.
// ===========================================================================

/// A mutating agent write owes the app-scope `agent_changed` announce carrying
/// `{ agent_id }`. The production sink is a mount-time integration residual; this
/// module defines the port and drives it as a best-effort, carried hint.
pub trait AgentChangedSink: Clone + Send + Sync + 'static {
    fn agent_changed(
        &self,
        agent: &AgentId,
    ) -> impl Future<Output = Result<(), AgentChangedAnnounceFailure>> + Send;
}

/// A best-effort `agent_changed` announce could not be delivered. Opaque; a failed
/// hint never downgrades an already-committed write.
#[derive(Debug, Error)]
#[error("agent_changed announce failed")]
pub struct AgentChangedAnnounceFailure {
    #[source]
    source: Box<dyn std::error::Error + Send + Sync + 'static>,
}

impl AgentChangedAnnounceFailure {
    pub fn from_source<E>(source: E) -> Self
    where
        E: std::error::Error + Send + Sync + 'static,
    {
        Self {
            source: Box::new(source),
        }
    }
}

/// The fate of the best-effort `agent_changed` announce fired after the row was
/// already committed — carried, never dropped, so the boundary can log a failed hint
/// without turning a committed write into a refusal.
#[derive(Debug)]
#[must_use = "a committed agent write owes an agent_changed announce whose fate must be handled"]
pub enum AgentChangedAnnounce {
    Delivered,
    Failed(AgentChangedAnnounceFailure),
}

// ===========================================================================
// The public write use case.
// ===========================================================================

/// The closed outcome of [`update_agent_profile_and_announce`].
#[derive(Debug)]
pub enum AgentProfileUpdateOutcome {
    /// No such agent — the route's product `404`.
    NoSuchAgent,
    /// The tuning was committed; carries the agent id (for the post-commit DTO
    /// re-read) and the announce fate.
    Committed(CommittedAgentProfile),
}

/// A committed tuning change together with the fate of its `agent_changed` announce.
/// Reachable only through [`into_parts`](Self::into_parts), so a boundary taking the
/// id for the wire re-read receives the announce residue in the same move and cannot
/// drop it. It deliberately carries only the id: the full/narrow DTO is composed by
/// re-reading through the canonical `agent_detail` projector, not from this fact.
#[derive(Debug)]
#[must_use = "a committed agent tuning carries an announce fate that must be handled"]
pub struct CommittedAgentProfile {
    agent_id: AgentId,
    announce: AgentChangedAnnounce,
}

impl CommittedAgentProfile {
    pub fn into_parts(self) -> (AgentId, AgentChangedAnnounce) {
        (self.agent_id, self.announce)
    }
}

/// Why an agent tuning write could not yield a trustworthy answer — all safe-500s.
#[derive(Debug, Error)]
pub enum AgentProfileWriteError {
    #[error(transparent)]
    Persistence(#[from] PersistenceFailure),
    #[error("agent profile write returned a fact that does not match the request")]
    UntrustworthyWriteFact,
}

/// Apply a sealed tuning edit and, on a genuine commit, fire the `agent_changed`
/// announce. The committed row is SEALED against the request — same id, `updated_at`
/// stamped to `now_ms`, and every touched column equal to the intent — before the
/// announce fires; a mismatch is an untrustworthy write (safe-500), never a silent
/// success.
pub async fn update_agent_profile_and_announce<W, S>(
    writes: &W,
    announce_sink: &S,
    subject: &AgentId,
    edit: &AdmittedAgentProfileEdit,
    now_ms: i64,
) -> Result<AgentProfileUpdateOutcome, AgentProfileWriteError>
where
    W: AgentProfileWriteUnitOfWork,
    S: AgentChangedSink,
{
    match writes.apply_profile_edit(subject, edit, now_ms).await? {
        AgentProfileRowWrite::NoSuchAgent => Ok(AgentProfileUpdateOutcome::NoSuchAgent),
        AgentProfileRowWrite::Committed(committed) => {
            seal_profile_write(subject, edit, &committed, now_ms)?;
            let announce = announce(announce_sink, subject).await;
            Ok(AgentProfileUpdateOutcome::Committed(
                CommittedAgentProfile {
                    agent_id: committed.id,
                    announce,
                },
            ))
        }
    }
}

/// Seal a committed tuning fact against the request: the row is the one asked for,
/// the write stamped `updated_at` to `now_ms` (a tuning edit always writes), and
/// every touched column carries exactly the intended value. A left-alone column is
/// not asserted — there is no before-image to compare, and the product leaves it be.
fn seal_profile_write(
    subject: &AgentId,
    edit: &AdmittedAgentProfileEdit,
    committed: &CommittedAgentRow,
    now_ms: i64,
) -> Result<(), AgentProfileWriteError> {
    let ok = committed.id == *subject
        && committed.updated_at == now_ms
        && column_matches(&edit.display_name, &committed.display_name)
        && nullable_matches(&edit.description, &committed.description)
        && nullable_matches(&edit.model, &committed.model)
        && nullable_matches(&edit.reasoning_effort, &committed.reasoning_effort)
        && nullable_matches(&edit.fast_mode, &committed.fast_mode);
    if ok {
        Ok(())
    } else {
        Err(AgentProfileWriteError::UntrustworthyWriteFact)
    }
}

/// A non-nullable column matches: a `Set` must equal the committed value; a `Leave`
/// is not asserted (kept as stored).
fn column_matches<T: PartialEq>(edit: &RequiredEdit<T>, committed: &T) -> bool {
    match edit {
        RequiredEdit::Leave => true,
        RequiredEdit::Set(value) => value == committed,
    }
}

/// A nullable column matches: a `Set` must equal `Some(value)`, a `Clear` must be
/// `None`, a `Leave` is not asserted.
fn nullable_matches<T: PartialEq>(edit: &FieldEdit<T>, committed: &Option<T>) -> bool {
    match edit {
        FieldEdit::Leave => true,
        FieldEdit::Clear => committed.is_none(),
        FieldEdit::Set(value) => committed.as_ref() == Some(value),
    }
}

/// Fire the changed-only `agent_changed` announce and fold its result into the
/// carried value (a failed hint never downgrades the committed write).
async fn announce<S>(sink: &S, agent: &AgentId) -> AgentChangedAnnounce
where
    S: AgentChangedSink,
{
    match sink.agent_changed(agent).await {
        Ok(()) => AgentChangedAnnounce::Delivered,
        Err(failure) => AgentChangedAnnounce::Failed(failure),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    };

    const NOW: i64 = 9_000;

    fn agent() -> AgentId {
        AgentId::parse("agent-1").unwrap()
    }

    fn ctx(runtime: RuntimeKind) -> AgentTuningContext {
        AgentTuningContext {
            runtime,
            model: None,
            reasoning_effort: None,
        }
    }

    fn leave_all() -> AgentTuningEdit {
        AgentTuningEdit {
            display_name: RequiredEdit::Leave,
            description: FieldEdit::Leave,
            model: FieldEdit::Leave,
            reasoning_effort: FieldEdit::Leave,
            fast_mode: FieldEdit::Leave,
        }
    }

    // ---- admission legality ----

    #[test]
    fn a_reasoning_effort_illegal_for_the_stored_runtime_is_refused() {
        // Claude exposes no reasoning control, so any concrete effort is out of range.
        let request = AgentTuningEdit {
            reasoning_effort: FieldEdit::Set("high".to_owned()),
            ..leave_all()
        };
        assert_eq!(
            admit_public_tuning_edit(&ctx(RuntimeKind::Claude), request),
            Err(TuningRejection::ReasoningEffortInvalidForRuntime)
        );
    }

    #[test]
    fn a_model_change_re_judges_a_left_alone_effort_against_the_new_model() {
        // Stored codex effort `ultra` is only legal for the sol model. Clearing the
        // model (→ baseline) while leaving the effort makes the pair illegal, even
        // though the effort itself was not named.
        let context = AgentTuningContext {
            runtime: RuntimeKind::Codex,
            model: Some("gpt-5.6-sol".to_owned()),
            reasoning_effort: Some("ultra".to_owned()),
        };
        let request = AgentTuningEdit {
            model: FieldEdit::Clear,
            ..leave_all()
        };
        assert_eq!(
            admit_public_tuning_edit(&context, request),
            Err(TuningRejection::ReasoningEffortInvalidForRuntime)
        );
    }

    #[test]
    fn leaving_both_reasoning_inputs_absent_never_re_judges_a_stored_illegal_pair() {
        // A stored pair that would be illegal today is NOT re-judged when neither
        // reasoning_effort nor model is named — matching the product's guard. Only a
        // fast_mode edit is present, and codex supports it.
        let context = AgentTuningContext {
            runtime: RuntimeKind::Codex,
            model: None,
            reasoning_effort: Some("ultra".to_owned()), // illegal on baseline, but untouched
        };
        let request = AgentTuningEdit {
            fast_mode: FieldEdit::Set(true),
            ..leave_all()
        };
        assert!(admit_public_tuning_edit(&context, request).is_ok());
    }

    #[test]
    fn fast_mode_set_on_an_unsupported_runtime_is_refused() {
        let request = AgentTuningEdit {
            fast_mode: FieldEdit::Set(false),
            ..leave_all()
        };
        // Qoder does not support fast mode; even a `false` set is refused (present,
        // non-null).
        assert_eq!(
            admit_public_tuning_edit(&ctx(RuntimeKind::Qoder), request),
            Err(TuningRejection::FastModeInvalidForRuntime)
        );
    }

    #[test]
    fn clearing_fast_mode_is_allowed_even_on_an_unsupported_runtime() {
        let request = AgentTuningEdit {
            fast_mode: FieldEdit::Clear,
            ..leave_all()
        };
        assert!(admit_public_tuning_edit(&ctx(RuntimeKind::Claude), request).is_ok());
    }

    #[test]
    fn reasoning_is_judged_before_fast_mode_when_a_body_trips_both() {
        // Claude: reasoning `high` is illegal AND fast_mode is unsupported. The
        // reasoning refusal wins, matching the product's order.
        let request = AgentTuningEdit {
            reasoning_effort: FieldEdit::Set("high".to_owned()),
            fast_mode: FieldEdit::Set(true),
            ..leave_all()
        };
        assert_eq!(
            admit_public_tuning_edit(&ctx(RuntimeKind::Claude), request),
            Err(TuningRejection::ReasoningEffortInvalidForRuntime)
        );
    }

    #[test]
    fn a_legal_tuning_admits_and_preserves_the_column_intents() {
        let request = AgentTuningEdit {
            display_name: RequiredEdit::Set("New Name".to_owned()),
            description: FieldEdit::Clear,
            model: FieldEdit::Set("gpt-5.6-sol".to_owned()),
            reasoning_effort: FieldEdit::Set("ultra".to_owned()),
            fast_mode: FieldEdit::Set(true),
        };
        let admitted = admit_public_tuning_edit(&ctx(RuntimeKind::Codex), request).unwrap();
        assert_eq!(
            admitted.display_name(),
            &RequiredEdit::Set("New Name".to_owned())
        );
        assert_eq!(admitted.description(), &FieldEdit::Clear);
        assert_eq!(
            admitted.reasoning_effort(),
            &FieldEdit::Set("ultra".to_owned())
        );
        assert_eq!(admitted.fast_mode(), &FieldEdit::Set(true));
    }

    // ---- write orchestration ----

    #[derive(Clone)]
    struct FakeWrites(AgentProfileRowWrite);
    impl AgentProfileWriteUnitOfWork for FakeWrites {
        async fn apply_profile_edit(
            &self,
            _agent: &AgentId,
            _edit: &AdmittedAgentProfileEdit,
            _now_ms: i64,
        ) -> Result<AgentProfileRowWrite, PersistenceFailure> {
            Ok(self.0.clone())
        }
    }

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
        fn calls(&self) -> usize {
            self.calls.load(Ordering::SeqCst)
        }
    }
    impl AgentChangedSink for FakeSink {
        async fn agent_changed(&self, _agent: &AgentId) -> Result<(), AgentChangedAnnounceFailure> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            if self.fail {
                #[derive(Debug, Error)]
                #[error("bus down")]
                struct BusDown;
                Err(AgentChangedAnnounceFailure::from_source(BusDown))
            } else {
                Ok(())
            }
        }
    }

    fn committed_row(now: i64) -> CommittedAgentRow {
        CommittedAgentRow {
            id: agent(),
            display_name: "New Name".to_owned(),
            description: None,
            model: Some("gpt-5.6-sol".to_owned()),
            reasoning_effort: Some("ultra".to_owned()),
            fast_mode: Some(true),
            updated_at: now,
        }
    }

    fn admitted() -> AdmittedAgentProfileEdit {
        admit_public_tuning_edit(
            &ctx(RuntimeKind::Codex),
            AgentTuningEdit {
                display_name: RequiredEdit::Set("New Name".to_owned()),
                description: FieldEdit::Clear,
                model: FieldEdit::Set("gpt-5.6-sol".to_owned()),
                reasoning_effort: FieldEdit::Set("ultra".to_owned()),
                fast_mode: FieldEdit::Set(true),
            },
        )
        .unwrap()
    }

    #[tokio::test]
    async fn a_missing_row_is_no_such_agent_and_never_announces() {
        let writes = FakeWrites(AgentProfileRowWrite::NoSuchAgent);
        let sink = FakeSink::new(false);
        let outcome = update_agent_profile_and_announce(&writes, &sink, &agent(), &admitted(), NOW)
            .await
            .unwrap();
        assert!(matches!(outcome, AgentProfileUpdateOutcome::NoSuchAgent));
        assert_eq!(sink.calls(), 0);
    }

    #[tokio::test]
    async fn a_committed_write_seals_and_announces_once() {
        let writes = FakeWrites(AgentProfileRowWrite::Committed(committed_row(NOW)));
        let sink = FakeSink::new(false);
        let outcome = update_agent_profile_and_announce(&writes, &sink, &agent(), &admitted(), NOW)
            .await
            .unwrap();
        let AgentProfileUpdateOutcome::Committed(committed) = outcome else {
            panic!("expected Committed");
        };
        let (id, ann) = committed.into_parts();
        assert_eq!(id, agent());
        assert!(matches!(ann, AgentChangedAnnounce::Delivered));
        assert_eq!(sink.calls(), 1);
    }

    #[tokio::test]
    async fn a_failed_announce_is_carried_without_flipping_the_commit() {
        let writes = FakeWrites(AgentProfileRowWrite::Committed(committed_row(NOW)));
        let sink = FakeSink::new(true);
        let outcome = update_agent_profile_and_announce(&writes, &sink, &agent(), &admitted(), NOW)
            .await
            .unwrap();
        let AgentProfileUpdateOutcome::Committed(committed) = outcome else {
            panic!("a failed announce must not turn the commit into a refusal");
        };
        let (_id, ann) = committed.into_parts();
        assert!(matches!(ann, AgentChangedAnnounce::Failed(_)));
    }

    #[tokio::test]
    async fn a_write_that_did_not_stamp_now_is_untrustworthy() {
        let writes = FakeWrites(AgentProfileRowWrite::Committed(committed_row(NOW - 1)));
        let sink = FakeSink::new(false);
        let result =
            update_agent_profile_and_announce(&writes, &sink, &agent(), &admitted(), NOW).await;
        assert!(matches!(
            result,
            Err(AgentProfileWriteError::UntrustworthyWriteFact)
        ));
        assert_eq!(sink.calls(), 0);
    }

    #[tokio::test]
    async fn a_write_whose_touched_column_disagrees_is_untrustworthy() {
        // The row came back with a display_name other than the one we set.
        let mut row = committed_row(NOW);
        row.display_name = "Someone Else".to_owned();
        let writes = FakeWrites(AgentProfileRowWrite::Committed(row));
        let sink = FakeSink::new(false);
        let result =
            update_agent_profile_and_announce(&writes, &sink, &agent(), &admitted(), NOW).await;
        assert!(matches!(
            result,
            Err(AgentProfileWriteError::UntrustworthyWriteFact)
        ));
        assert_eq!(sink.calls(), 0);
    }

    #[tokio::test]
    async fn a_write_for_a_different_agent_is_untrustworthy() {
        let mut row = committed_row(NOW);
        row.id = AgentId::parse("agent-other").unwrap();
        let writes = FakeWrites(AgentProfileRowWrite::Committed(row));
        let sink = FakeSink::new(false);
        let result =
            update_agent_profile_and_announce(&writes, &sink, &agent(), &admitted(), NOW).await;
        assert!(matches!(
            result,
            Err(AgentProfileWriteError::UntrustworthyWriteFact)
        ));
    }
}
