//! The wire projection shared by the two schedule-management faces: the
//! `ScheduleDto` shape (`packages/shared/src/api/schedule.ts::ScheduleDtoSchema`)
//! and the tagged `spec` union it embeds.
//!
//! [`ScheduleView`] (the core read fact) maps to [`ScheduleDto`] here — the ONE
//! place the 20-field wire shape is spelled — so the list and cancel handlers
//! both serialize identically. Nullable columns are emitted as JSON `null`
//! (matching `rowToDto`); the interval spec's optional `start_at` is OMITTED when
//! absent (matching `ScheduleSpecSchema`, where it is `.optional()`, not
//! nullable).

use serde::Serialize;
use silverhand_backend_core::conversation_messaging::messaging::schedule::{
    ScheduleSpec, ScheduleView,
};

/// The `spec` union, tagged by `kind`. Field names and tag values mirror
/// `ScheduleSpecSchema`; `every_seconds`/`start_at` are the interval wire names,
/// distinct from the domain `IntervalSeconds`.
#[derive(Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
enum WireScheduleSpec {
    Once {
        fire_at: i64,
    },
    Interval {
        every_seconds: i64,
        /// Optional, not nullable: the create wire never sends `null`, so an
        /// absent first instant is an absent key, not a present `null`.
        #[serde(skip_serializing_if = "Option::is_none")]
        start_at: Option<i64>,
    },
    Cron {
        expression: String,
        timezone: String,
    },
}

impl From<&ScheduleSpec> for WireScheduleSpec {
    fn from(spec: &ScheduleSpec) -> Self {
        match spec {
            ScheduleSpec::Once { fire_at } => WireScheduleSpec::Once { fire_at: *fire_at },
            ScheduleSpec::Interval { every, start_at } => WireScheduleSpec::Interval {
                every_seconds: every.get(),
                start_at: *start_at,
            },
            ScheduleSpec::Cron(cron) => WireScheduleSpec::Cron {
                expression: cron.expression().to_owned(),
                timezone: cron.timezone().to_owned(),
            },
        }
    }
}

/// The full schedule DTO — the exact 20-field shape both faces return.
#[derive(Serialize)]
pub(super) struct ScheduleDto {
    id: String,
    owner_agent_id: String,
    target_conversation_id: String,
    target_label: String,
    title: String,
    message: String,
    spec: WireScheduleSpec,
    next_fire_at: i64,
    status: &'static str,
    fired_count: i64,
    last_fired_at: Option<i64>,
    max_occurrences: Option<i64>,
    until_at: Option<i64>,
    failure_reason: Option<String>,
    cancelled_at: Option<i64>,
    last_failure_reason: Option<String>,
    last_failure_at: Option<i64>,
    consecutive_failure_count: i64,
    created_at: i64,
    updated_at: i64,
}

impl From<ScheduleView> for ScheduleDto {
    fn from(view: ScheduleView) -> Self {
        ScheduleDto {
            id: view.id.as_str().to_owned(),
            owner_agent_id: view.owner_agent_id.as_str().to_owned(),
            target_conversation_id: view.target_conversation_id,
            target_label: view.target_label,
            title: view.title,
            message: view.message,
            spec: WireScheduleSpec::from(&view.spec),
            next_fire_at: view.next_fire_at,
            status: view.status.as_token(),
            fired_count: view.fired_count,
            last_fired_at: view.last_fired_at,
            max_occurrences: view.max_occurrences,
            until_at: view.until_at,
            failure_reason: view.failure_reason,
            cancelled_at: view.cancelled_at,
            last_failure_reason: view.last_failure_reason,
            last_failure_at: view.last_failure_at,
            consecutive_failure_count: view.consecutive_failure_count,
            created_at: view.created_at,
            updated_at: view.updated_at,
        }
    }
}
