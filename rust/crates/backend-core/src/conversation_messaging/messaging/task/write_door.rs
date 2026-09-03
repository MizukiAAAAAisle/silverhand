//! The request-layer authorities a task-WRITE door consults BEFORE the write
//! transaction — the write parity of [`super::read`]'s board/capability ports.
//!
//! The DOOR (a server adapter) resolves which board a by-number write targets and
//! whether the acting agent may target it, then hands a canonical task id to the
//! write unit of work. These traits are the reads that resolution needs; like the
//! read board ports, they are consumer-defined here and implemented by the SQLite
//! store, so the server depends on this crate's vocabulary, never on the adapter's
//! SQL. The write unit of work re-reads and re-decides every mutable fact under its
//! own lock; these pre-write reads are refusal ordering and board selection only.

use std::future::Future;

use crate::foundation::identity::{AgentId, ConversationId, WorkspaceId};
use crate::foundation::persistence::PersistenceFailure;
use crate::identity_access::workspace_name::CanonicalWorkspaceName;

use super::aggregate::BoardKey;
use super::spec::TaskId;

/// Three-valued workspace membership for the write door: `Absent` (no such
/// workspace → the caller's `unknown_workspace`/404), `NotMember` (present but not
/// a member → `workspace_membership_required`/403), `Member`.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum WorkspaceMembership {
    Absent,
    NotMember,
    Member,
}

/// The task capability a workspace board gates a write behind. Each names its own
/// grant token; a token is never borrowed from another capability's name.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum TaskWriteCapability {
    /// `create_tasks` — filing a new task on a workspace board.
    Create,
    /// `write_tasks` — mutating an existing task (claim/unclaim/status/edit).
    Write,
    /// `read_tasks` — returning a task's full definition (the edit face needs it
    /// in addition to `write_tasks`).
    Read,
}

/// Capability bundle a by-id mutation must prove against the task's own board.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum TaskByIdCapability {
    Write,
    WriteAndRead,
}

/// The pre-write board/membership/capability/name reads the write door composes.
/// Implemented by the SQLite store over one connection; the door drives the fixed
/// TS branch/refusal order (see the server `resolve_write_board`), never these
/// reads' order.
pub trait TaskWriteDoorReads {
    /// Anti-enumerating by-id authorization. The implementation binds the global
    /// id to its own conversation/placement and returns only a verdict: unknown,
    /// nonparticipant, and missing capability are all `false`. The write UoW
    /// repeats the same mutable gates under its reserved writer.
    fn may_mutate_task_by_id(
        &mut self,
        task: &TaskId,
        agent: &AgentId,
        required: TaskByIdCapability,
    ) -> impl Future<Output = Result<bool, PersistenceFailure>> + Send;

    /// Resolve a canonical workspace name to its board candidates, in the
    /// deterministic `findAllByName` order (regular workspaces first, then
    /// `created_at ASC`). The door decides ambiguity (`len > 1`) from this BEFORE
    /// any membership read, so a candidate count is never rewritten by a later
    /// authorization result.
    fn workspaces_named(
        &mut self,
        canonical: &CanonicalWorkspaceName,
    ) -> impl Future<Output = Result<Vec<WorkspaceId>, PersistenceFailure>> + Send;

    /// The conversation's placement-derived board, for the no-selector arm; `None`
    /// = no such conversation.
    fn conversation_board(
        &mut self,
        conversation: &ConversationId,
    ) -> impl Future<Output = Result<Option<BoardKey>, PersistenceFailure>> + Send;

    /// The agent's 3-valued membership of a workspace board.
    fn workspace_membership(
        &mut self,
        workspace: &WorkspaceId,
        agent: &AgentId,
    ) -> impl Future<Output = Result<WorkspaceMembership, PersistenceFailure>> + Send;

    /// Whether the agent holds `capability` on a workspace board (owner arm ∨ an
    /// explicit grant of that capability's own token).
    fn has_capability(
        &mut self,
        capability: TaskWriteCapability,
        workspace: &WorkspaceId,
        agent: &AgentId,
    ) -> impl Future<Output = Result<bool, PersistenceFailure>> + Send;
}

/// Resolve an agent's display name for a task event's actor pill — the DB-backed
/// name (`display_name`/`name`) the `task_*` message records so a renderer draws the
/// "by @X" pill without parsing content. `None` = no such agent (a deleted/unlinked
/// actor); the caller falls back to the id, the parity of the TS `agentName`'s
/// `?? id`. A user actor needs no lookup (its label is the literal `user`), so this
/// port answers only the agent side.
pub trait AgentDisplayNameReader {
    fn agent_display_name(
        &self,
        agent: &AgentId,
    ) -> impl Future<Output = Result<Option<super::event::AgentEventNames>, PersistenceFailure>> + Send;
}

/// Aggregate-existence authority for an internal agent mutation. Kept separate
/// from [`AgentDisplayNameReader`]: event-name fallback is not proof that the
/// runtime principal still names a persisted agent.
pub trait AgentExistenceReader {
    fn agent_exists(
        &self,
        agent: &AgentId,
    ) -> impl Future<Output = Result<bool, PersistenceFailure>> + Send;
}

/// Resolve a per-board task NUMBER to its canonical [`TaskId`] — the by-number write
/// arm's pre-write id lookup (`(board_key, task_number)` → id). A narrow read port so
/// a write face depends on exactly this one read, not the whole store surface;
/// implemented by the SQLite task store (the trait lives in core so the impl is
/// orphan-rule-legal in the sqlite crate, exactly like [`TaskWriteDoorReads`]).
pub trait TaskNumberResolver {
    fn resolve_id_by_number(
        &self,
        board_key: &str,
        task_number: i64,
    ) -> impl Future<Output = Result<Option<TaskId>, PersistenceFailure>> + Send;
}
