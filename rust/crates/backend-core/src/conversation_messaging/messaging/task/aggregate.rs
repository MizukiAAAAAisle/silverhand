//! The committed task-row fact and the strict decode boundary that produces it.
//!
//! A [`TaskAggregate`] is the ONE committed `tasks` row, decoded ONCE through
//! [`TaskAggregate::decode`]. That function is the corruption gate for every
//! invariant the tasks row constrains WITHIN ITSELF: a value or intra-row
//! combination a correct writer could not have produced (a status token outside
//! the closed set, a title not stored canonical, a broken creator triple, an
//! assignee in both columns, a half-populated last-editor triple, a `closed_at`
//! that disagrees with the status, a board key whose namespace disagrees with
//! `workspace_id`) fails HERE with a named [`TaskRowCorruption`] the adapter
//! routes to a safe-500 — BEFORE any DTO, write witness, or product refusal is
//! built from it. It does NOT police invariants that need a SECOND row's
//! authority (the board coordinate vs the conversation's placement): that
//! cross-row consistency is a hard gate the SQLite read/UoW owns, run before
//! product logic, and is called out where it applies below. There is no other
//! constructor: the fields are private and the doctest gates keep them so — a
//! caller can neither forge an aggregate from parts nor reassign a field on one
//! it holds — so nothing can hold a `TaskAggregate` whose row-local invariants
//! were never checked. This is why the read path and the write path share the
//! aggregate — they consume the SAME committed row fact, not merely the same
//! table.
//!
//! Two kinds of invariant live here, and the difference is deliberate:
//!
//!  - **Cross-column combinations that a single newtype cannot rule out** are
//!    sealed as sum types so the illegal shapes are UNCONSTRUCTABLE, not
//!    decode-then-trust: [`BoardKey`] carries its `workspace_id` inside the
//!    `Workspace` arm (the `pair` arm carries none), so the two board-arc
//!    biconditionals `(board_key LIKE 'ws:%') = (workspace_id IS NOT NULL)` and
//!    its `pair` twin cannot be violated by a value that exists; [`LastEdit`]
//!    binds the editor and the `last_edited_at` instant together, so the
//!    all-null-or-complete-triple CHECK cannot be half-satisfied. [`Creator`] and
//!    [`Assignee`] (in [`super::spec`]) already do the same for their columns.
//!
//!  - **The remaining couplings the DDL enforces across columns** — the
//!    `creator_kind` triple, the assignee XOR, the last-editor triple's
//!    population, and the `(status = 'closed') = (closed_at IS NOT NULL)`
//!    biconditional — are asserted inside `decode`, each failing to a distinctly
//!    named `TaskRowCorruption` arm so an operator can find the offending column.
//!    They are not further folded into a lifecycle sum type: `TaskStatus` is one
//!    alphabet owned beside the enum and consumed by the transition witnesses, and
//!    forking it into "closed vs the other four" to move the biconditional into
//!    the type system would create a second status vocabulary for no product gain.
//!
//! Pure domain data: no driver, no clock. `created_at` / `closed_at` are the
//! stored instants carried verbatim; the SQLite adapter fills a [`TaskRow`] with
//! raw columns and hands it to `decode`, keeping every engine detail out of the
//! domain. The per-viewer navigation projection (source vs created-event vs
//! unavailable) reads message access and is therefore a read-model concern over
//! this fact, NOT baked into the aggregate — the raw provenance coordinates
//! ([`TaskAggregate::source_message`], [`TaskAggregate::created_event_message`])
//! travel here, their resolution does not.
//!
//! The authority for every arm is the `tasks` DDL CHECK set
//! (`packages/backend/tests/migration-baseline/schema-current.sql`), cited per
//! coupling below; the tests exhaustively falsify each. There is no TS parity
//! fixture because TS decode trusts these CHECKs (it only fails loud on a missing
//! place coordinate) — this decoder is stricter by design, asserting what TS
//! leaves to the database.

use crate::foundation::identity::{AgentId, ConversationId, UserId, WorkspaceId};

use super::spec::{Assignee, Creator, TaskContent, TaskId, TaskNumber, TaskStatus, TaskTitle};

/// Non-empty opaque coordinate newtypes local to the task board. Each only ever
/// originates from a stored row, so the sole invariant at the decode boundary is
/// non-emptiness; an empty value is corruption, never a legal coordinate.
macro_rules! task_coordinate {
    ($(#[$meta:meta])* $name:ident) => {
        $(#[$meta])*
        #[derive(Clone, Debug, Eq, Hash, PartialEq)]
        pub struct $name(String);

        impl $name {
            /// Parse a stored coordinate, rejecting the empty string as corruption.
            pub fn parse(raw: impl Into<String>) -> Result<Self, EmptyCoordinate> {
                let raw = raw.into();
                if raw.is_empty() {
                    return Err(EmptyCoordinate);
                }
                Ok(Self(raw))
            }

            pub fn as_str(&self) -> &str {
                &self.0
            }
        }
    };
}

/// A local coordinate decoded to the empty string — persistence corruption. It is
/// never surfaced directly; `decode` maps it to the offending column's
/// [`TaskRowCorruption`] arm so the operator reason names the column.
#[derive(Clone, Copy, Debug, Eq, PartialEq, thiserror::Error)]
#[error("stored task coordinate must not be empty")]
pub struct EmptyCoordinate;

task_coordinate! {
    /// A direct-pair board's `pair_key` — the suffix of a `pair:` board key.
    PairKey
}
task_coordinate! {
    /// `tasks.thread_root_id`: the reply-cluster root a task hangs under, if any.
    ThreadRootId
}
task_coordinate! {
    /// `tasks.source_message_id`: the immutable message a task was created FROM.
    /// Raw provenance, not a foreign key — it survives the message's deletion, so
    /// it is a coordinate, not a live reference.
    SourceMessageId
}
task_coordinate! {
    /// `tasks.created_event_message_id`: the `task_created` event message, the
    /// navigation fallback when the source is absent or unreadable.
    CreatedEventMessageId
}

/// A task's board coordinate. The board namespace and `workspace_id` null-ness are
/// two DDL biconditionals (`schema-current.sql`: `(board_key LIKE 'ws:%') =
/// (workspace_id IS NOT NULL)` and its `pair:` twin). Modeling the board as a sum
/// whose `Workspace` arm OWNS the workspace id (and whose `Pair` arm owns none)
/// makes both biconditionals unrepresentable: there is no separate `workspace_id`
/// field left to disagree with the namespace. `decode` additionally checks the
/// stored `board_key` string reproduces the ROW-LOCAL `ws:` suffix derivation
/// against the `workspace_id` column, so the two columns cannot be written
/// inconsistently with each other. It does NOT assert the trigger's fuller
/// derivation against the conversation's placement — that cross-row authority is
/// the adapter's gate (see [`decode_board`]).
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum BoardKey {
    /// A workspace channel board: `board_key = 'ws:' || workspace_id`.
    Workspace(WorkspaceId),
    /// A direct-pair board: `board_key = 'pair:' || pair_key`, `workspace_id` NULL.
    Pair(PairKey),
}

impl BoardKey {
    /// The workspace this board belongs to, or `None` for a direct-pair board.
    /// This is the ONLY `workspace_id` in the aggregate: it is derived from the
    /// board, never carried as an independent column that could drift.
    pub fn workspace_id(&self) -> Option<&WorkspaceId> {
        match self {
            BoardKey::Workspace(id) => Some(id),
            BoardKey::Pair(_) => None,
        }
    }
}

/// Who last edited a task's DEFINITION (title/content) — `agent` or `user`, never
/// `system` (unlike [`Creator`]): the `task edit` verb is the only writer of the
/// last-editor columns, and it is never system-initiated. Status and claim
/// changes do not move it.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum LastEditor {
    Agent(AgentId),
    User(UserId),
}

/// A completed last-edit fact: the editor and the instant it happened, bound
/// together. The DDL couples `last_editor_kind`, `last_editor_id`, and
/// `last_edited_at` as all-null (never edited) or a COMPLETE triple; representing
/// an edited task as `Option<LastEdit>` makes the half-populated states
/// unconstructable — you cannot have an editor without an instant or the reverse.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LastEdit {
    pub editor: LastEditor,
    /// `tasks.last_edited_at`, epoch-ms.
    pub at: i64,
}

/// Why a persisted `tasks` row could not be decoded into a legal
/// [`TaskAggregate`]. Every arm names its offending column(s) so the safe-500 the
/// adapter raises carries an operator reason, distinguishing a bad status TOKEN
/// from a bad TRIPLE from an empty coordinate. Each corresponds to a `tasks` DDL
/// CHECK (or the primary-key/derivation invariant) that a correct writer upholds,
/// so any occurrence is database corruption, never a caller's mistake.
#[derive(Clone, Copy, Debug, Eq, PartialEq, thiserror::Error)]
pub enum TaskRowCorruption {
    #[error("stored tasks.id is empty")]
    Id,
    #[error("stored tasks.task_number is not a positive integer at most Number.MAX_SAFE_INTEGER")]
    TaskNumber,
    #[error("stored tasks.conversation_id is empty")]
    ConversationId,
    #[error("stored tasks.status is not one of the five legal tokens")]
    Status,
    #[error("stored tasks.title is empty or over the length contract")]
    Title,
    /// The title parses but is not in the canonical form a correct writer stores
    /// (`create`/`edit` run `TaskTitleSchema` before persisting). Re-canonicalizing
    /// it here would silently rewrite a persisted fact and mask the corruption, so
    /// a non-canonical stored value is rejected, not normalized.
    #[error("stored tasks.title is not in canonical (trimmed/collapsed) form")]
    TitleNotCanonical,
    #[error("stored tasks.content exceeds the length contract")]
    Content,
    #[error(
        "stored tasks board_key / workspace_id violate the row-local board arc \
         (namespace vs workspace_id null-ness / ws-suffix derivation)"
    )]
    Board,
    #[error("stored tasks.thread_root_id is present but empty")]
    ThreadRootId,
    #[error("stored tasks.source_message_id is present but empty")]
    SourceMessageId,
    #[error("stored tasks.created_event_message_id is present but empty")]
    CreatedEventMessageId,
    #[error("stored tasks creator_kind / creator_*_id violate the creator triple")]
    Creator,
    #[error("stored tasks assignee columns are both set (assignee is at most one)")]
    Assignee,
    #[error("stored tasks last_editor_* columns violate the all-null-or-complete triple")]
    LastEditor,
    #[error("stored tasks.closed_at disagrees with the closed-status biconditional")]
    ClosedAt,
}

/// The raw `tasks` columns as an engine decodes them, before any domain
/// validation. This is the decode boundary's INPUT — the SQLite adapter fills it
/// with `try_get` and hands it to [`TaskAggregate::decode`]; it carries no
/// display-name join columns because those are read-model presentation over the
/// fact, not the committed row fact itself.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TaskRow {
    pub id: String,
    pub task_number: i64,
    pub conversation_id: String,
    pub thread_root_id: Option<String>,
    pub board_key: String,
    pub workspace_id: Option<String>,
    pub title: String,
    pub content: String,
    pub status: String,
    pub assignee_agent_id: Option<String>,
    pub assignee_user_id: Option<String>,
    pub creator_kind: String,
    pub creator_agent_id: Option<String>,
    pub creator_user_id: Option<String>,
    pub source_message_id: Option<String>,
    pub created_event_message_id: Option<String>,
    pub last_editor_kind: Option<String>,
    pub last_editor_id: Option<String>,
    pub last_edited_at: Option<i64>,
    pub created_at: i64,
    pub closed_at: Option<i64>,
}

/// A decoded, invariant-checked `tasks` row: the single committed fact both the
/// read models and the write path consume.
///
/// The fields are private and [`TaskAggregate::decode`] is the sole constructor,
/// so holding one is proof that every row invariant — the value-object contracts
/// AND the cross-column couplings — held. Where [`super::super::schedule`]'s
/// `ClaimedSchedule` exposes public fields (each independently valid), this
/// aggregate seals construction because its legality is CROSS-field: public fields
/// would let a caller pair `status: Closed` with `closed_at: None` and reintroduce
/// exactly the decode-then-trust hole this boundary exists to close.
///
/// The aggregate cannot be fabricated from parts. Every field VALUE below is
/// built through a public constructor, so the ONLY thing that fails to compile is
/// the struct literal touching `TaskAggregate`'s private fields — not a missing
/// field or an unconstructable value.
///
/// ```compile_fail
/// use silverhand_backend_core::conversation_messaging::messaging::task::{
///     Assignee, BoardKey, Creator, TaskAggregate, TaskContent, TaskStatus, TaskTitle,
/// };
/// use silverhand_backend_core::foundation::identity::{ConversationId, WorkspaceId};
/// use silverhand_backend_core::conversation_messaging::messaging::task::{TaskId, TaskNumber};
///
/// let forged = TaskAggregate {
///     id: TaskId::parse("t").unwrap(),
///     task_number: TaskNumber::new(1).unwrap(),
///     board: BoardKey::Workspace(WorkspaceId::parse("w").unwrap()),
///     conversation_id: ConversationId::parse("c").unwrap(),
///     thread_root_id: None,
///     title: TaskTitle::parse("t").unwrap(),
///     content: TaskContent::empty(),
///     status: TaskStatus::Closed,
///     closed_at: None, // the biconditional a pub-field forge could violate
///     assignee: Assignee::Unassigned,
///     creator: Creator::System,
///     last_edit: None,
///     source_message: None,
///     created_event_message: None,
///     created_at: 0,
/// };
/// ```
///
/// The from-parts fence above catches a WHOLESALE forge, but it only turns red
/// while EVERY field is private — flip them all `pub` and it compiles. The
/// load-bearing regression is subtler: a single lifecycle field made `pub` would
/// let a holder of a legally-decoded aggregate REASSIGN one half of a
/// biconditional (`task.status = ...` or `task.closed_at = ...`) and break the
/// coupling `decode` guaranteed. Two more fences guard exactly that — each takes a
/// real `mut task` from `decode` and reassigns ONE field, so whichever field is
/// singly relaxed, its fence turns red. (Their discriminatory power was checked by
/// making ONLY `status` `pub`: the status fence went red, the `closed_at` fence
/// stayed compiling.)
///
/// ```compile_fail
/// use silverhand_backend_core::conversation_messaging::messaging::task::{TaskAggregate, TaskRow, TaskStatus};
///
/// let mut task = TaskAggregate::decode(TaskRow {
///     id: "task_1".into(), task_number: 7, conversation_id: "conv_1".into(),
///     thread_root_id: None, board_key: "ws:workspace_1".into(),
///     workspace_id: Some("workspace_1".into()), title: "hello world".into(),
///     content: String::new(), status: "todo".into(), assignee_agent_id: None,
///     assignee_user_id: None, creator_kind: "system".into(), creator_agent_id: None,
///     creator_user_id: None, source_message_id: None, created_event_message_id: None,
///     last_editor_kind: None, last_editor_id: None, last_edited_at: None,
///     created_at: 100, closed_at: None,
/// }).unwrap();
/// // `status` is private — a holder cannot reassign one half of the biconditional.
/// task.status = TaskStatus::Closed;
/// ```
///
/// ```compile_fail
/// use silverhand_backend_core::conversation_messaging::messaging::task::{TaskAggregate, TaskRow};
///
/// let mut task = TaskAggregate::decode(TaskRow {
///     id: "task_1".into(), task_number: 7, conversation_id: "conv_1".into(),
///     thread_root_id: None, board_key: "ws:workspace_1".into(),
///     workspace_id: Some("workspace_1".into()), title: "hello world".into(),
///     content: String::new(), status: "todo".into(), assignee_agent_id: None,
///     assignee_user_id: None, creator_kind: "system".into(), creator_agent_id: None,
///     creator_user_id: None, source_message_id: None, created_event_message_id: None,
///     last_editor_kind: None, last_editor_id: None, last_edited_at: None,
///     created_at: 100, closed_at: None,
/// }).unwrap();
/// // `closed_at` is private — the other half of the biconditional is equally sealed.
/// task.closed_at = Some(200);
/// ```
///
/// The same public path used positively — so the failures above are field privacy,
/// not a renamed type, and `decode` plus the accessors are live:
///
/// ```
/// use silverhand_backend_core::conversation_messaging::messaging::task::{BoardKey, TaskAggregate, TaskRow, TaskStatus};
///
/// let row = TaskRow {
///     id: "task_1".into(),
///     task_number: 7,
///     conversation_id: "conv_1".into(),
///     thread_root_id: None,
///     board_key: "ws:workspace_1".into(),
///     workspace_id: Some("workspace_1".into()),
///     title: "hello world".into(),
///     content: String::new(),
///     status: "closed".into(),
///     assignee_agent_id: None,
///     assignee_user_id: None,
///     creator_kind: "system".into(),
///     creator_agent_id: None,
///     creator_user_id: None,
///     source_message_id: None,
///     created_event_message_id: None,
///     last_editor_kind: None,
///     last_editor_id: None,
///     last_edited_at: None,
///     created_at: 100,
///     closed_at: Some(200),
/// };
/// let task = TaskAggregate::decode(row).unwrap();
/// assert_eq!(task.title().as_str(), "hello world");
/// assert_eq!(task.status(), TaskStatus::Closed);
/// assert_eq!(task.closed_at(), Some(200));
/// assert!(matches!(task.board(), BoardKey::Workspace(_)));
/// ```
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TaskAggregate {
    id: TaskId,
    task_number: TaskNumber,
    board: BoardKey,
    conversation_id: ConversationId,
    thread_root_id: Option<ThreadRootId>,
    title: TaskTitle,
    content: TaskContent,
    status: TaskStatus,
    closed_at: Option<i64>,
    assignee: Assignee,
    creator: Creator,
    last_edit: Option<LastEdit>,
    source_message: Option<SourceMessageId>,
    created_event_message: Option<CreatedEventMessageId>,
    created_at: i64,
}

impl TaskAggregate {
    pub fn id(&self) -> &TaskId {
        &self.id
    }

    pub fn task_number(&self) -> TaskNumber {
        self.task_number
    }

    pub fn board(&self) -> &BoardKey {
        &self.board
    }

    pub fn conversation_id(&self) -> &ConversationId {
        &self.conversation_id
    }

    pub fn thread_root_id(&self) -> Option<&ThreadRootId> {
        self.thread_root_id.as_ref()
    }

    pub fn title(&self) -> &TaskTitle {
        &self.title
    }

    pub fn content(&self) -> &TaskContent {
        &self.content
    }

    pub fn status(&self) -> TaskStatus {
        self.status
    }

    /// The close instant. `decode` guarantees this is `Some` exactly when
    /// [`Self::status`] is [`TaskStatus::Closed`] — the biconditional holds for
    /// every value that exists, so a reader never re-checks it.
    pub fn closed_at(&self) -> Option<i64> {
        self.closed_at
    }

    pub fn assignee(&self) -> &Assignee {
        &self.assignee
    }

    pub fn creator(&self) -> &Creator {
        &self.creator
    }

    /// The last-edit fact, or `None` if the task was never edited.
    pub fn last_edit(&self) -> Option<&LastEdit> {
        self.last_edit.as_ref()
    }

    pub fn source_message(&self) -> Option<&SourceMessageId> {
        self.source_message.as_ref()
    }

    pub fn created_event_message(&self) -> Option<&CreatedEventMessageId> {
        self.created_event_message.as_ref()
    }

    pub fn created_at(&self) -> i64 {
        self.created_at
    }

    /// Decode a raw `tasks` row into the committed fact, rejecting any row a
    /// correct writer could not have produced. Each field passes its value-object
    /// contract and the cross-column couplings are asserted here; the first
    /// violation wins and names its column via [`TaskRowCorruption`].
    pub fn decode(row: TaskRow) -> Result<Self, TaskRowCorruption> {
        use TaskRowCorruption as E;

        let id = TaskId::parse(row.id).map_err(|_| E::Id)?;
        let task_number = TaskNumber::new(row.task_number).map_err(|_| E::TaskNumber)?;
        let conversation_id =
            ConversationId::parse(row.conversation_id).map_err(|_| E::ConversationId)?;
        let board = decode_board(row.board_key, row.workspace_id)?;
        let thread_root_id = decode_optional(row.thread_root_id, ThreadRootId::parse)
            .map_err(|_| E::ThreadRootId)?;
        // A correct writer persists a title already run through the create/edit
        // canonicalizer, so a stored value is corruption unless it is BOTH within
        // the contract AND already canonical. `TaskTitle::parse` is that
        // canonicalizer (trim + collapse); using its output as the decode gate
        // would silently rewrite a persisted fact (turning `"  a   b  "`, or raw
        // whitespace-padded junk that collapses short, into a different committed
        // title). Instead: parse for the length/emptiness contract, then require
        // the stored bytes already equal the canonical form.
        let title = TaskTitle::parse(&row.title).map_err(|_| E::Title)?;
        if title.as_str() != row.title {
            return Err(E::TitleNotCanonical);
        }
        let content = TaskContent::parse(row.content).map_err(|_| E::Content)?;

        let status = TaskStatus::parse(&row.status).map_err(|_| E::Status)?;
        // `(status = 'closed') = (closed_at IS NOT NULL)` (schema-current.sql):
        // closed carries an instant; every other status carries none. Neither the
        // orphan instant nor the un-stamped close is a legal row.
        if (status == TaskStatus::Closed) != row.closed_at.is_some() {
            return Err(E::ClosedAt);
        }

        let assignee = decode_assignee(row.assignee_agent_id, row.assignee_user_id)?;
        let creator = decode_creator(&row.creator_kind, row.creator_agent_id, row.creator_user_id)?;
        let last_edit =
            decode_last_edit(row.last_editor_kind, row.last_editor_id, row.last_edited_at)?;
        let source_message = decode_optional(row.source_message_id, SourceMessageId::parse)
            .map_err(|_| E::SourceMessageId)?;
        let created_event_message =
            decode_optional(row.created_event_message_id, CreatedEventMessageId::parse)
                .map_err(|_| E::CreatedEventMessageId)?;

        Ok(Self {
            id,
            task_number,
            board,
            conversation_id,
            thread_root_id,
            title,
            content,
            status,
            closed_at: row.closed_at,
            assignee,
            creator,
            last_edit,
            source_message,
            created_event_message,
            created_at: row.created_at,
        })
    }
}

/// Parse an optional stored coordinate: `None` stays `None`, a present value must
/// pass the coordinate contract. A present-but-empty column is corruption, not an
/// absent coordinate — the two are distinct states the caller must not conflate.
fn decode_optional<T>(
    raw: Option<String>,
    parse: impl Fn(String) -> Result<T, EmptyCoordinate>,
) -> Result<Option<T>, EmptyCoordinate> {
    raw.map(parse).transpose()
}

/// Decode `board_key` + `workspace_id` into a [`BoardKey`], asserting the
/// ROW-LOCAL board arc: a `ws:` key must reproduce a non-null `workspace_id`
/// exactly, and a `pair:` key must have a null one. A namespace/column mismatch,
/// an unknown namespace, or an empty suffix is corruption.
///
/// This is only the arc BETWEEN these two columns. The insert trigger's full
/// derivation also binds them to the placement of the row's `conversation_id`
/// (`ws:` iff the conversation is workspace-placed, with the same workspace), and
/// that authority is a SECOND row this tasks-row decode does not carry — so a row
/// pointing at a direct-pair conversation but self-consistently written `ws:w`
/// passes here. Re-judging the task's board coordinate against the authoritative
/// conversation placement is a hard gate the SQLite read/UoW owns, before any
/// product logic; it is NOT claimed by this row-local seal.
fn decode_board(
    board_key: String,
    workspace_id: Option<String>,
) -> Result<BoardKey, TaskRowCorruption> {
    if let Some(ws) = board_key.strip_prefix("ws:") {
        // The trigger writes `board_key = 'ws:' || workspace_id`, so the suffix
        // must equal the non-null workspace_id column exactly; a mismatch means the
        // two columns were written inconsistently.
        match workspace_id {
            Some(w) if w == ws => Ok(BoardKey::Workspace(
                WorkspaceId::parse(w).map_err(|_| TaskRowCorruption::Board)?,
            )),
            _ => Err(TaskRowCorruption::Board),
        }
    } else if let Some(pair) = board_key.strip_prefix("pair:") {
        if workspace_id.is_some() {
            return Err(TaskRowCorruption::Board);
        }
        Ok(BoardKey::Pair(
            PairKey::parse(pair).map_err(|_| TaskRowCorruption::Board)?,
        ))
    } else {
        Err(TaskRowCorruption::Board)
    }
}

/// Decode the assignee columns, enforcing the at-most-one XOR the DDL guarantees.
/// Both null is unassigned; exactly one is that arm; both set is corruption.
fn decode_assignee(
    agent_id: Option<String>,
    user_id: Option<String>,
) -> Result<Assignee, TaskRowCorruption> {
    match (agent_id, user_id) {
        (None, None) => Ok(Assignee::Unassigned),
        (Some(agent), None) => Ok(Assignee::Agent(
            AgentId::parse(agent).map_err(|_| TaskRowCorruption::Assignee)?,
        )),
        (None, Some(user)) => Ok(Assignee::User(
            UserId::parse(user).map_err(|_| TaskRowCorruption::Assignee)?,
        )),
        (Some(_), Some(_)) => Err(TaskRowCorruption::Assignee),
    }
}

/// Decode the creator triple, enforcing the DDL's kind-pairs-with-its-id CHECK:
/// `agent` carries only an agent id, `user` only a user id, `system` neither.
fn decode_creator(
    kind: &str,
    agent_id: Option<String>,
    user_id: Option<String>,
) -> Result<Creator, TaskRowCorruption> {
    match (kind, agent_id, user_id) {
        ("agent", Some(agent), None) => Ok(Creator::Agent(
            AgentId::parse(agent).map_err(|_| TaskRowCorruption::Creator)?,
        )),
        ("user", None, Some(user)) => Ok(Creator::User(
            UserId::parse(user).map_err(|_| TaskRowCorruption::Creator)?,
        )),
        ("system", None, None) => Ok(Creator::System),
        _ => Err(TaskRowCorruption::Creator),
    }
}

/// Decode the last-editor triple: all-null is "never edited" (`None`); a complete
/// `(kind ∈ {agent,user}, id, at)` triple is a [`LastEdit`]; any partial
/// population or unknown kind is corruption.
fn decode_last_edit(
    kind: Option<String>,
    id: Option<String>,
    at: Option<i64>,
) -> Result<Option<LastEdit>, TaskRowCorruption> {
    match (kind, id, at) {
        (None, None, None) => Ok(None),
        (Some(kind), Some(id), Some(at)) => {
            let editor = match kind.as_str() {
                "agent" => LastEditor::Agent(
                    AgentId::parse(id).map_err(|_| TaskRowCorruption::LastEditor)?,
                ),
                "user" => {
                    LastEditor::User(UserId::parse(id).map_err(|_| TaskRowCorruption::LastEditor)?)
                }
                _ => return Err(TaskRowCorruption::LastEditor),
            };
            Ok(Some(LastEdit { editor, at }))
        }
        _ => Err(TaskRowCorruption::LastEditor),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A minimal valid row: a `todo` task on a workspace board, system creator,
    /// unassigned, never edited, no provenance. Individual tests mutate one facet
    /// to falsify exactly one coupling.
    fn valid_row() -> TaskRow {
        TaskRow {
            id: "task_1".into(),
            task_number: 1,
            conversation_id: "conv_1".into(),
            thread_root_id: None,
            board_key: "ws:workspace_1".into(),
            workspace_id: Some("workspace_1".into()),
            title: "a title".into(),
            content: String::new(),
            status: "todo".into(),
            assignee_agent_id: None,
            assignee_user_id: None,
            creator_kind: "system".into(),
            creator_agent_id: None,
            creator_user_id: None,
            source_message_id: None,
            created_event_message_id: None,
            last_editor_kind: None,
            last_editor_id: None,
            last_edited_at: None,
            created_at: 100,
            closed_at: None,
        }
    }

    fn decode(row: TaskRow) -> Result<TaskAggregate, TaskRowCorruption> {
        TaskAggregate::decode(row)
    }

    #[test]
    fn a_clean_row_decodes_into_the_committed_fact() {
        let task = decode(valid_row()).unwrap();
        assert_eq!(task.id().as_str(), "task_1");
        assert_eq!(task.task_number().get(), 1);
        assert_eq!(task.conversation_id().as_str(), "conv_1");
        assert_eq!(task.status(), TaskStatus::Todo);
        assert_eq!(task.closed_at(), None);
        assert_eq!(task.assignee(), &Assignee::Unassigned);
        assert_eq!(task.creator(), &Creator::System);
        assert!(task.last_edit().is_none());
        assert_eq!(task.created_at(), 100);
        assert!(matches!(task.board(), BoardKey::Workspace(_)));
        assert_eq!(
            task.board().workspace_id().map(WorkspaceId::as_str),
            Some("workspace_1")
        );
    }

    #[test]
    fn value_object_contracts_are_enforced_per_column() {
        type Falsify = fn(&mut TaskRow);
        let cases: [(Falsify, TaskRowCorruption); 6] = [
            (|r| r.id = String::new(), TaskRowCorruption::Id),
            (|r| r.task_number = 0, TaskRowCorruption::TaskNumber),
            // Past Number.MAX_SAFE_INTEGER the JSON-number wire would round, so a
            // persisted value above the domain ceiling is corruption the strict
            // decode refuses — it never projects as an imprecise number.
            (
                |r| r.task_number = TaskNumber::MAX_SAFE + 1,
                TaskRowCorruption::TaskNumber,
            ),
            (
                |r| r.conversation_id = String::new(),
                TaskRowCorruption::ConversationId,
            ),
            (|r| r.status = "cancelled".into(), TaskRowCorruption::Status),
            (|r| r.title = "   ".into(), TaskRowCorruption::Title),
        ];
        for (mutate, expected) in cases {
            let mut row = valid_row();
            mutate(&mut row);
            assert_eq!(decode(row), Err(expected));
        }
    }

    #[test]
    fn a_canonical_title_round_trips_verbatim_and_content_is_verbatim() {
        // A correct writer stores the title already canonical (trimmed, interior
        // runs collapsed to a single space); it decodes byte-for-byte, NOT
        // re-normalized. Content is carried verbatim, whitespace and all.
        let mut row = valid_row();
        row.title = "hello world".into();
        row.content = "  body  ".into();
        let task = decode(row).unwrap();
        assert_eq!(task.title().as_str(), "hello world");
        assert_eq!(task.content().as_str(), "  body  ");
    }

    #[test]
    fn a_non_canonical_stored_title_is_corruption_not_silently_renormalized() {
        // Padded / interior-run titles are exactly what `TaskTitle::parse` would
        // silently rewrite; the decode boundary must REJECT them instead, so a
        // persisted fact a correct writer could not have produced never masquerades
        // as a legal (rewritten) one.
        for non_canonical in ["  hello world", "hello world  ", "hello   world"] {
            let mut row = valid_row();
            row.title = non_canonical.into();
            assert_eq!(
                decode(row),
                Err(TaskRowCorruption::TitleNotCanonical),
                "{non_canonical:?} should be rejected, not renormalized"
            );
        }

        // The decisive case: raw EXCEEDS the title ceiling (over 200 UTF-16 units
        // of whitespace padding) while its canonical collapse (`"a b"`) is tiny and
        // well within it. A correct decoder canonicalizes first, so length passes
        // and the `as_str() == raw` gate reports `TitleNotCanonical`. A decoder that
        // wrongly precheck-rejected on RAW length would instead report `Title` — so
        // this row tells the two failures apart, pinning that the length contract is
        // measured on the canonical form and canonicity is a separate gate.
        let mut row = valid_row();
        row.title = format!("a{}b", " ".repeat(201));
        assert_eq!(decode(row), Err(TaskRowCorruption::TitleNotCanonical));
    }

    #[test]
    fn closed_status_and_closed_at_are_a_biconditional_both_ways() {
        // closed without an instant is corruption.
        let mut row = valid_row();
        row.status = "closed".into();
        assert_eq!(decode(row), Err(TaskRowCorruption::ClosedAt));

        // a non-closed status carrying an instant is corruption.
        let mut row = valid_row();
        row.closed_at = Some(200);
        assert_eq!(decode(row), Err(TaskRowCorruption::ClosedAt));

        // closed WITH an instant is legal, and the instant is carried verbatim.
        let mut row = valid_row();
        row.status = "closed".into();
        row.closed_at = Some(200);
        let task = decode(row).unwrap();
        assert_eq!(task.status(), TaskStatus::Closed);
        assert_eq!(task.closed_at(), Some(200));
    }

    #[test]
    fn board_arc_couples_namespace_to_workspace_id_and_reproduces_the_derivation() {
        // ws: namespace requires a matching non-null workspace_id.
        let mut row = valid_row();
        row.workspace_id = None;
        assert_eq!(decode(row), Err(TaskRowCorruption::Board));

        // the ws: suffix must EQUAL the workspace_id column (derivation), not just
        // both be present.
        let mut row = valid_row();
        row.board_key = "ws:other".into();
        row.workspace_id = Some("workspace_1".into());
        assert_eq!(decode(row), Err(TaskRowCorruption::Board));

        // pair: namespace requires a NULL workspace_id.
        let mut row = valid_row();
        row.board_key = "pair:pair_1".into();
        row.workspace_id = Some("workspace_1".into());
        assert_eq!(decode(row), Err(TaskRowCorruption::Board));

        // an unknown namespace is corruption.
        let mut row = valid_row();
        row.board_key = "chan:whatever".into();
        row.workspace_id = None;
        assert_eq!(decode(row), Err(TaskRowCorruption::Board));

        // a well-formed pair board decodes and carries no workspace id.
        let mut row = valid_row();
        row.board_key = "pair:pair_1".into();
        row.workspace_id = None;
        let task = decode(row).unwrap();
        assert_eq!(
            task.board(),
            &BoardKey::Pair(PairKey::parse("pair_1").unwrap())
        );
        assert!(task.board().workspace_id().is_none());
    }

    #[test]
    fn assignee_is_at_most_one_column() {
        // both set is corruption.
        let mut row = valid_row();
        row.assignee_agent_id = Some("agent_1".into());
        row.assignee_user_id = Some("user_1".into());
        assert_eq!(decode(row), Err(TaskRowCorruption::Assignee));

        // the agent arm — the only one live mutations write.
        let mut row = valid_row();
        row.assignee_agent_id = Some("agent_1".into());
        let task = decode(row).unwrap();
        assert_eq!(
            task.assignee(),
            &Assignee::Agent(AgentId::parse("agent_1").unwrap())
        );

        // a legacy user assignee still round-trips.
        let mut row = valid_row();
        row.assignee_user_id = Some("user_1".into());
        let task = decode(row).unwrap();
        assert_eq!(
            task.assignee(),
            &Assignee::User(UserId::parse("user_1").unwrap())
        );
    }

    #[test]
    fn creator_kind_pairs_exactly_with_its_id_column() {
        // agent kind without an agent id is corruption.
        let mut row = valid_row();
        row.creator_kind = "agent".into();
        assert_eq!(decode(row), Err(TaskRowCorruption::Creator));

        // agent kind carrying a user id is corruption.
        let mut row = valid_row();
        row.creator_kind = "agent".into();
        row.creator_user_id = Some("user_1".into());
        assert_eq!(decode(row), Err(TaskRowCorruption::Creator));

        // system kind carrying any id is corruption.
        let mut row = valid_row();
        row.creator_agent_id = Some("agent_1".into());
        assert_eq!(decode(row), Err(TaskRowCorruption::Creator));

        // each legal kind round-trips.
        let mut row = valid_row();
        row.creator_kind = "agent".into();
        row.creator_agent_id = Some("agent_1".into());
        assert_eq!(
            decode(row).unwrap().creator(),
            &Creator::Agent(AgentId::parse("agent_1").unwrap())
        );

        let mut row = valid_row();
        row.creator_kind = "user".into();
        row.creator_user_id = Some("user_1".into());
        assert_eq!(
            decode(row).unwrap().creator(),
            &Creator::User(UserId::parse("user_1").unwrap())
        );
    }

    #[test]
    fn last_editor_is_all_null_or_a_complete_triple() {
        // a partial triple (kind + id, no instant) is corruption.
        let mut row = valid_row();
        row.last_editor_kind = Some("agent".into());
        row.last_editor_id = Some("agent_1".into());
        assert_eq!(decode(row), Err(TaskRowCorruption::LastEditor));

        // an instant with no editor is corruption.
        let mut row = valid_row();
        row.last_edited_at = Some(150);
        assert_eq!(decode(row), Err(TaskRowCorruption::LastEditor));

        // an unknown editor kind is corruption (note: `system` is not a valid
        // editor, unlike a creator).
        let mut row = valid_row();
        row.last_editor_kind = Some("system".into());
        row.last_editor_id = Some("x".into());
        row.last_edited_at = Some(150);
        assert_eq!(decode(row), Err(TaskRowCorruption::LastEditor));

        // a complete agent triple binds editor and instant together.
        let mut row = valid_row();
        row.last_editor_kind = Some("agent".into());
        row.last_editor_id = Some("agent_1".into());
        row.last_edited_at = Some(150);
        let task = decode(row).unwrap();
        assert_eq!(
            task.last_edit(),
            Some(&LastEdit {
                editor: LastEditor::Agent(AgentId::parse("agent_1").unwrap()),
                at: 150,
            })
        );
    }

    #[test]
    fn optional_provenance_coordinates_distinguish_absent_from_empty() {
        // present-but-empty is corruption, not an absent coordinate.
        let mut row = valid_row();
        row.thread_root_id = Some(String::new());
        assert_eq!(decode(row), Err(TaskRowCorruption::ThreadRootId));

        let mut row = valid_row();
        row.source_message_id = Some(String::new());
        assert_eq!(decode(row), Err(TaskRowCorruption::SourceMessageId));

        let mut row = valid_row();
        row.created_event_message_id = Some(String::new());
        assert_eq!(decode(row), Err(TaskRowCorruption::CreatedEventMessageId));

        // present-and-nonempty round-trips; absent stays absent.
        let mut row = valid_row();
        row.thread_root_id = Some("thread_1".into());
        row.source_message_id = Some("msg_1".into());
        let task = decode(row).unwrap();
        assert_eq!(
            task.thread_root_id().map(ThreadRootId::as_str),
            Some("thread_1")
        );
        assert_eq!(
            task.source_message().map(SourceMessageId::as_str),
            Some("msg_1")
        );
        assert!(task.created_event_message().is_none());
    }
}
