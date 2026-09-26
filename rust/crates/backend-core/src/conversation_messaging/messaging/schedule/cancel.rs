//! The pure cancel POLICY for an agent's own schedule, plus the single-atomic
//! unit-of-work port the SQLite adapter implements.
//!
//! Cancel is the OWNER's cleanup verb. The route's creator-or-system edit gate
//! runs first, but this policy re-binds the schedule's own `owner_agent_id`
//! (an edit-gate pass does not prove the caller owns THIS schedule) and grades
//! the `manage_schedules` capability against the target conversation's
//! workspace — the same axis create was gated on. Two deliberate asymmetries
//! with create, both from `schedule-service.ts::cancel`:
//!
//!  - a target with NO workspace (a direct-pair board, or a null workspace) is
//!    treated like a DELETED target: the capability gate is SKIPPED, because no
//!    `manage_schedules` grant can exist there and cancel must never strand an
//!    owner's own schedule;
//!  - withholding creation and withholding deletion are not the same choice, so
//!    a missing/workspace-less target permits owner cleanup rather than refusing.
//!
//! The policy is pure: it consumes already-read facts and returns a decision.
//! The adapter reads those facts and performs the CAS inside ONE
//! `BEGIN IMMEDIATE` transaction (see [`ScheduleCancelUnitOfWork`]); SQL only
//! reads facts, and the capability judgement lives HERE, never in SQL.

use std::future::Future;

use crate::foundation::identity::{AgentId, WorkspaceId};
use crate::foundation::persistence::PersistenceFailure;

use super::orchestrator::ScheduleId;
use super::read::ScheduleView;
use super::spec::ScheduleStatus;

/// How the schedule's target resolves, as read inside the cancel transaction.
/// The capability gate applies ONLY to a target that lives in a workspace;
/// everything else is owner cleanup.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum CancelTarget {
    /// The target conversation is gone, or has no workspace (a direct-pair
    /// board / null workspace). No `manage_schedules` axis exists, so the owner
    /// may always clean up.
    OwnerCleanup,
    /// The target lives in a workspace; `manage_schedules` was resolved for the
    /// schedule owner against it (agent-home owner arm OR an explicit grant).
    Workspace { manage_schedules: bool },
}

/// The owner-bind verdict, decided from the schedule's own `owner_agent_id`
/// ALONE — before any target or capability fact is read.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum OwnerBind {
    Proceed,
    NotOwner,
}

/// Owner-bind, the FIRST gate, decided from the schedule's own owner alone. The
/// adapter runs this immediately after loading the schedule row and BEFORE it
/// reads any target/capability fact, so a schedule the caller does not own is
/// refused without consulting — and without being able to fault on — its
/// target's placement or `manage_schedules` data. This is the sole owner rule.
pub fn bind_owner(expected_owner: &AgentId, schedule_owner: &AgentId) -> OwnerBind {
    if schedule_owner == expected_owner {
        OwnerBind::Proceed
    } else {
        OwnerBind::NotOwner
    }
}

/// The capability-stage verdict for a schedule the caller ALREADY owns. Its OWN
/// closed set — only `Proceed`/`Denied`, no `NotOwner` — so the compiler makes an
/// ownership verdict UNREPRESENTABLE here (ownership is decided upstream by
/// [`bind_owner`]); the SQLite adapter can then match it exhaustively with no
/// fail-open wildcard.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum CapabilityVerdict {
    Proceed,
    Denied,
}

/// The capability gate for a schedule the caller ALREADY owns (owner-bind
/// passed). Owner cleanup (a deleted / workspace-less target) and a workspace
/// target the owner holds `manage_schedules` for proceed; a workspace target
/// without the grant is denied.
pub fn evaluate_capability(target: &CancelTarget) -> CapabilityVerdict {
    match target {
        CancelTarget::OwnerCleanup
        | CancelTarget::Workspace {
            manage_schedules: true,
        } => CapabilityVerdict::Proceed,
        CancelTarget::Workspace {
            manage_schedules: false,
        } => CapabilityVerdict::Denied,
    }
}

/// The outcome of the cancel unit of work, mapping 1:1 to the route's wire
/// contract (`responses.ts::scheduleErrorStatusMap`):
/// `Cancelled`→200, `NotFound`→404, `NotOwner`→403, `CapabilityDenied`→403
/// (with the `manage_schedules` capability echoed), `NotCancellable`→409.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ScheduleCancelOutcome {
    /// The CAS flipped `pending|firing → cancelled`; the projected post-image is
    /// the 200 body. Boxed so a large view does not bloat every arm.
    Cancelled(Box<ScheduleView>),
    /// No schedule with that id.
    NotFound,
    /// The schedule is owned by another agent.
    NotOwner,
    /// The target's workspace exists and the owner lacks `manage_schedules`
    /// there; the workspace id carries into the refusal message.
    CapabilityDenied { workspace_id: WorkspaceId },
    /// The schedule is in a terminal state — the CAS matched no row. Carries the
    /// pre-image status the refusal message names.
    NotCancellable { current_status: ScheduleStatus },
}

/// The cancel unit of work: owner-bind, target-workspace facts, the
/// `manage_schedules` decision facts, and the final `pending|firing → cancelled`
/// CAS all inside ONE write transaction. The route agent (the edit-gate subject)
/// is passed as `owner` and re-bound against the schedule's own owner within the
/// transaction — the gate pass is not carried as proof. This port NEVER
/// repurposes the fire-path claim/settlement CAS.
pub trait ScheduleCancelUnitOfWork {
    fn cancel_owned_schedule(
        &self,
        schedule_id: &ScheduleId,
        owner: &AgentId,
    ) -> impl Future<Output = Result<ScheduleCancelOutcome, PersistenceFailure>> + Send;
}
