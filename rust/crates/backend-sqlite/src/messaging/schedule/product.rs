//! Shared row→[`ScheduleView`] projection for the product read/cancel adapters.
//!
//! Both the list SELECT and the cancel CAS `RETURNING` decode a `schedules` row
//! into the same [`ScheduleView`]. The decode boundary is the fire-path store's:
//! [`super::decode_spec`], [`super::corrupt`], and [`super::driver`] are reused
//! verbatim so there is ONE spelling of "a stored row the create contract could
//! not have written is a safe-500, not a legal fact." Only `id`, `owner_agent_id`,
//! `status`, and `spec_json` are decoded into domain values; every other column —
//! including `target_conversation_id`, which the schema back-fills to `""` — rides
//! raw, exactly as the TypeScript `rowToDto` echoes it.

use silverhand_backend_core::identity::AgentId;
use silverhand_backend_core::messaging::schedule::{
    ScheduleId, ScheduleStatus, ScheduleView, target_label,
};
use silverhand_backend_core::persistence::PersistenceFailure;
use sqlx::{Row, sqlite::SqliteRow};

use super::{corrupt, decode_spec, driver};

/// Project one `schedules` row into a [`ScheduleView`]. The target conversation's
/// `title`/`roster_policy` are passed separately — the list SELECT reads them from
/// its LEFT JOIN, the cancel path reads them from the conversation fact it loaded
/// earlier in the same transaction — and folded into `target_label` here so the
/// label rule lives in exactly one place.
pub(crate) fn project_schedule_view(
    row: &SqliteRow,
    target_title: Option<&str>,
    target_roster_policy: Option<&str>,
) -> Result<ScheduleView, PersistenceFailure> {
    let id: String = row.try_get("id").map_err(driver)?;
    let owner_agent_id: String = row.try_get("owner_agent_id").map_err(driver)?;
    let target_conversation_id: String = row.try_get("target_conversation_id").map_err(driver)?;
    let title: String = row.try_get("title").map_err(driver)?;
    let message: String = row.try_get("message").map_err(driver)?;
    let spec_json: String = row.try_get("spec_json").map_err(driver)?;
    let next_fire_at: i64 = row.try_get("next_fire_at").map_err(driver)?;
    let status: String = row.try_get("status").map_err(driver)?;
    let fired_count: i64 = row.try_get("fired_count").map_err(driver)?;
    let last_fired_at: Option<i64> = row.try_get("last_fired_at").map_err(driver)?;
    let max_occurrences: Option<i64> = row.try_get("max_occurrences").map_err(driver)?;
    let until_at: Option<i64> = row.try_get("until_at").map_err(driver)?;
    let failure_reason: Option<String> = row.try_get("failure_reason").map_err(driver)?;
    let cancelled_at: Option<i64> = row.try_get("cancelled_at").map_err(driver)?;
    let last_failure_reason: Option<String> = row.try_get("last_failure_reason").map_err(driver)?;
    let last_failure_at: Option<i64> = row.try_get("last_failure_at").map_err(driver)?;
    let consecutive_failure_count: i64 =
        row.try_get("consecutive_failure_count").map_err(driver)?;
    let created_at: i64 = row.try_get("created_at").map_err(driver)?;
    let updated_at: i64 = row.try_get("updated_at").map_err(driver)?;

    Ok(ScheduleView {
        id: ScheduleId::parse(id).map_err(|_| corrupt("schedules.id"))?,
        owner_agent_id: AgentId::parse(owner_agent_id)
            .map_err(|_| corrupt("schedules.owner_agent_id"))?,
        target_label: target_label(target_title, target_roster_policy),
        target_conversation_id,
        title,
        message,
        spec: decode_spec(&spec_json)?,
        next_fire_at,
        status: ScheduleStatus::from_token(&status).ok_or_else(|| corrupt("schedules.status"))?,
        fired_count,
        last_fired_at,
        max_occurrences,
        until_at,
        failure_reason,
        cancelled_at,
        last_failure_reason,
        last_failure_at,
        consecutive_failure_count,
        created_at,
        updated_at,
    })
}
