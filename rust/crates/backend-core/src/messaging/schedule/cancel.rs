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

use crate::identity::{AgentId, WorkspaceId};
use crate::persistence::PersistenceFailure;

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

/// The facts the cancel policy grades: the schedule's own owner (for the
/// owner-bind) and its resolved target.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ScheduleCancelFacts {
    pub owner_agent_id: AgentId,
    pub target: CancelTarget,
}

/// The owner-bind verdict, decided from the schedule's own `owner_agent_id`
/// ALONE — before any target or capability fact is read.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum OwnerBind {
    Proceed,
    NotOwner,
}

/// The policy verdict for a schedule that EXISTS: proceed to the CAS, or refuse.
/// Existence, terminal-state (CAS miss), and the resulting view are the
/// adapter's concern; this decides only owner-bind and capability.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum CancelDecision {
    Proceed,
    NotOwner,
    CapabilityDenied,
}

/// Owner-bind, the FIRST gate, decided from the schedule's own owner alone. The
/// adapter runs this immediately after loading the schedule row and BEFORE it
/// reads any target/capability fact, so a schedule the caller does not own is
/// refused without consulting — and without being able to fault on — its
/// target's placement or `manage_schedules` data. This is the SOLE owner rule;
/// [`evaluate_cancel`] delegates to it rather than re-comparing.
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

/// Grade a loaded schedule against the caller as ONE pure composition: owner-bind
/// first ([`bind_owner`]), then the capability gate ([`evaluate_capability`]) for
/// a workspace-resident target. The SQLite adapter does NOT call this; it invokes
/// the two stages separately so the owner gate physically precedes the
/// target/capability read (a fault on target facts can never mask a `NotOwner`).
/// This composition documents the whole policy and backs the pure tests.
pub fn evaluate_cancel(expected_owner: &AgentId, facts: &ScheduleCancelFacts) -> CancelDecision {
    match bind_owner(expected_owner, &facts.owner_agent_id) {
        OwnerBind::NotOwner => CancelDecision::NotOwner,
        OwnerBind::Proceed => match evaluate_capability(&facts.target) {
            CapabilityVerdict::Proceed => CancelDecision::Proceed,
            CapabilityVerdict::Denied => CancelDecision::CapabilityDenied,
        },
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

#[cfg(test)]
mod tests {
    use super::*;

    fn agent(id: &str) -> AgentId {
        AgentId::parse(id).expect("agent id")
    }

    #[test]
    fn a_schedule_owned_by_another_agent_is_refused_before_capability() {
        let facts = ScheduleCancelFacts {
            owner_agent_id: agent("owner"),
            // Even a granted workspace does not rescue a non-owner.
            target: CancelTarget::Workspace {
                manage_schedules: true,
            },
        };
        assert_eq!(
            evaluate_cancel(&agent("someone-else"), &facts),
            CancelDecision::NotOwner
        );
    }

    #[test]
    fn the_owner_needs_manage_schedules_for_a_workspace_target() {
        let denied = ScheduleCancelFacts {
            owner_agent_id: agent("owner"),
            target: CancelTarget::Workspace {
                manage_schedules: false,
            },
        };
        assert_eq!(
            evaluate_cancel(&agent("owner"), &denied),
            CancelDecision::CapabilityDenied
        );

        let granted = ScheduleCancelFacts {
            owner_agent_id: agent("owner"),
            target: CancelTarget::Workspace {
                manage_schedules: true,
            },
        };
        assert_eq!(
            evaluate_cancel(&agent("owner"), &granted),
            CancelDecision::Proceed
        );
    }

    #[test]
    fn an_owner_may_always_clean_up_a_targetless_schedule() {
        // A deleted / workspace-less target skips the capability gate entirely —
        // the owner-bind is the only guard.
        let facts = ScheduleCancelFacts {
            owner_agent_id: agent("owner"),
            target: CancelTarget::OwnerCleanup,
        };
        assert_eq!(
            evaluate_cancel(&agent("owner"), &facts),
            CancelDecision::Proceed
        );
    }

    #[test]
    fn bind_owner_decides_from_the_owner_alone() {
        // The SOLE owner rule: identity match, no target input at all.
        assert_eq!(
            bind_owner(&agent("owner"), &agent("owner")),
            OwnerBind::Proceed
        );
        assert_eq!(
            bind_owner(&agent("someone-else"), &agent("owner")),
            OwnerBind::NotOwner
        );
    }

    #[test]
    fn evaluate_capability_is_a_closed_two_verdict_gate() {
        // Ownership is upstream; this stage only grades the capability axis, and
        // its verdict set is closed to Proceed/Denied. The exhaustive match below
        // has NO wildcard — a new arm would fail to compile here, which is the
        // compile-time guard against a fail-open capability stage.
        for (target, expected) in [
            (CancelTarget::OwnerCleanup, CapabilityVerdict::Proceed),
            (
                CancelTarget::Workspace {
                    manage_schedules: true,
                },
                CapabilityVerdict::Proceed,
            ),
            (
                CancelTarget::Workspace {
                    manage_schedules: false,
                },
                CapabilityVerdict::Denied,
            ),
        ] {
            let verdict = evaluate_capability(&target);
            let same = match verdict {
                CapabilityVerdict::Proceed => matches!(expected, CapabilityVerdict::Proceed),
                CapabilityVerdict::Denied => matches!(expected, CapabilityVerdict::Denied),
            };
            assert!(same, "{target:?} must grade to {expected:?}");
        }
    }
}
