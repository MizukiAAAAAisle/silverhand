//! Operator-console product aggregates.
//!
//! This is a deliberately small read model: it exposes bounded counts, never
//! message bodies, source conversations, or arbitrary SQL. User activity exposes
//! only the identity required for operator drill-down and bounded statistics.

use crate::foundation::persistence::PersistenceFailure;
use chrono::{Duration, NaiveDate};
use std::future::Future;

pub const TIME_ZONE: &str = "Asia/Shanghai";
pub const TREND_DAYS: i64 = 30;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ConsoleTotals {
    pub users: i64,
    pub agents: i64,
    pub regular_workspaces: i64,
    pub active_channels: i64,
    pub archived_channels: i64,
    pub messages: i64,
    pub active_computers: i64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ActivityWindow {
    pub days: i64,
    pub authenticated_users: i64,
    pub speaking_users: i64,
    pub human_messages: i64,
    pub agent_messages: i64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DailyActivity {
    pub date: String,
    pub speaking_users: i64,
    pub human_messages: i64,
    pub agent_messages: i64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CategoryCount {
    pub category: String,
    pub count: i64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ConsoleAnalyticsSnapshot {
    pub generated_at_ms: i64,
    pub totals: ConsoleTotals,
    pub windows: Vec<ActivityWindow>,
    pub daily_activity: Vec<DailyActivity>,
    pub agent_runtimes: Vec<CategoryCount>,
}

pub const USER_PAGE_SIZE: i64 = 25;
pub const TOP_USERS_LIMIT: i64 = 10;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ConsoleUserActivity {
    pub user_id: String,
    pub name: String,
    pub display_name: String,
    pub message_count: i64,
    pub active_days: i64,
    pub conversation_count: i64,
    pub last_message_at: Option<i64>,
    pub last_authenticated_at: Option<i64>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ConsoleUsersQuery {
    pub days: i64,
    pub search: String,
    pub page: i64,
}

impl ConsoleUsersQuery {
    pub fn is_valid(&self) -> bool {
        matches!(self.days, 7 | 30)
            && (1..=10_000).contains(&self.page)
            && self.search.chars().count() <= 128
            && !self.search.chars().any(char::is_control)
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ConsoleUsersSnapshot {
    pub generated_at_ms: i64,
    pub total_matching: i64,
    pub users: Vec<ConsoleUserActivity>,
    pub top_users: Vec<ConsoleUserActivity>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ConsoleUserDay {
    pub date: String,
    pub message_count: i64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ConsoleUserDetail {
    pub generated_at_ms: i64,
    pub user: ConsoleUserActivity,
    pub daily_activity: Vec<ConsoleUserDay>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CalendarWindow {
    pub dates: Vec<String>,
    pub bounds: Vec<(i64, i64)>,
}

impl CalendarWindow {
    pub fn ending_at(now_ms: i64, days: i64) -> Option<Self> {
        if !(1..=366).contains(&days) {
            return None;
        }

        let now = chrono::DateTime::from_timestamp_millis(now_ms)?
            .with_timezone(&chrono_tz::Asia::Shanghai);
        let end_date = now.date_naive() + Duration::days(1);
        let start_date = end_date - Duration::days(days);
        let midnight = |date: NaiveDate| {
            date.and_hms_opt(0, 0, 0)?
                .and_local_timezone(chrono_tz::Asia::Shanghai)
                .single()
                .map(|value| value.timestamp_millis())
        };

        let dates = (0..days)
            .map(|offset| (start_date + Duration::days(offset)).to_string())
            .collect();
        let bounds = (0..days)
            .map(|offset| {
                Some((
                    midnight(start_date + Duration::days(offset))?,
                    midnight(start_date + Duration::days(offset + 1))?,
                ))
            })
            .collect::<Option<Vec<_>>>()?;

        Some(Self { dates, bounds })
    }

    pub fn start_ms(&self) -> Option<i64> {
        self.bounds.first().map(|(start, _)| *start)
    }
}

pub trait ConsoleAnalyticsRead: Clone + Send + Sync + 'static {
    fn read_users(
        &self,
        query: ConsoleUsersQuery,
        now_ms: i64,
    ) -> impl Future<Output = Result<ConsoleUsersSnapshot, PersistenceFailure>> + Send;

    fn read_user(
        &self,
        user_id: String,
        days: i64,
        now_ms: i64,
    ) -> impl Future<Output = Result<Option<ConsoleUserDetail>, PersistenceFailure>> + Send;

    fn read_snapshot(
        &self,
        now_ms: i64,
    ) -> impl Future<Output = Result<ConsoleAnalyticsSnapshot, PersistenceFailure>> + Send;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn calendar_window_uses_complete_shanghai_days() {
        let now = chrono::DateTime::parse_from_rfc3339("2026-09-09T13:00:00+08:00")
            .unwrap()
            .timestamp_millis();
        let window = CalendarWindow::ending_at(now, 30).unwrap();

        assert_eq!(window.dates.len(), 30);
        assert_eq!(window.dates.first().unwrap(), "2026-08-11");
        assert_eq!(window.dates.last().unwrap(), "2026-09-09");
        assert_eq!(window.bounds[29].1 - window.bounds[29].0, 86_400_000);
    }

    #[test]
    fn calendar_window_rejects_unbounded_ranges() {
        assert!(CalendarWindow::ending_at(0, 0).is_none());
        assert!(CalendarWindow::ending_at(0, 367).is_none());
    }
}
