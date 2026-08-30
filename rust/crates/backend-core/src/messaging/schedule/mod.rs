//! Agent-owned schedule: the self-driven reminder capability for ONE agent.
//! A schedule has zero coupling to channels, tasks, or other agents — the
//! owner picks a time policy and is woken at each due time.
//!
//! This slice is the pure TIME-POLICY core: the recurrence decisions that
//! turn a fired occurrence into either a terminal state or a rearmed next
//! instant. It is driver-free and clock-free. Computing a cron instant is
//! delegated to [`recurrence::CronNextOccurrence`], an integration seam;
//! nothing here reads the wall clock, opens a transaction, or drives a timer.
//!
//! The durable claim/settle unit of work and the near-wake timer driver are
//! separate modules; product create/list/cancel never depend on the timer.

pub mod cancel;
pub mod orchestrator;
pub mod read;
pub mod recurrence;
pub mod settlement;
pub mod spec;

pub use cancel::{
    CancelDecision, CancelTarget, CapabilityVerdict, OwnerBind, ScheduleCancelFacts,
    ScheduleCancelOutcome, ScheduleCancelUnitOfWork, bind_owner, evaluate_capability,
    evaluate_cancel,
};
pub use orchestrator::{
    ClaimedSchedule, Clock, DeliveryMaterial, DueCandidate, EmptyScheduleId, InvalidDeliveryText,
    ProcessError, ProcessOutcome, SCHEDULE_MESSAGE_MAX_LEN, SCHEDULE_TITLE_MAX_LEN, ScheduleId,
    ScheduleMessage, ScheduleStore, ScheduleTitle, ScheduleWake, WakeContext, WakeFailed,
    process_one,
};
pub use read::{
    InvalidScheduleLimit, InvalidStatusFilter, ScheduleListLimit, ScheduleListQuery,
    ScheduleListReadModel, ScheduleStatusFilter, ScheduleView, target_label,
};
pub use recurrence::{
    AdvanceError, Advancement, CadenceFault, CronNextOccurrence, CronOutcome, CronQuery,
    FailureRearm, FailureRearmError, PolicyFault, estimate_missed_count, plan_advancement,
    plan_failure_rearm,
};
pub use settlement::{DeliveryOutcome, SettlementAction, plan_settlement};
pub use spec::{
    CronSpec, FiredCount, IntervalSeconds, InvalidCaps, NegativeFiredCount, NonPositiveInterval,
    ScheduleCaps, ScheduleSpec, ScheduleStatus,
};
