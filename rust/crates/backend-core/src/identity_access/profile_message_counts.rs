//! Bounded, source-free profile contribution counts. Subjects reuse Principal.
use crate::foundation::{identity::Principal, persistence::PersistenceFailure};
use chrono::{DateTime, Datelike, Duration, NaiveDate};
use std::future::Future;

pub const TIME_ZONE: &str = "Asia/Shanghai";

#[derive(Clone, Debug)]
pub struct MessageCountYear {
    pub year: i32,
    pub start_ms: i64,
    pub end_ms: i64,
    pub dates: Vec<String>,
    pub day_bounds: Vec<(i64, i64)>,
}
impl MessageCountYear {
    pub fn new(year: i32) -> Option<Self> {
        if !(1970..=9998).contains(&year) {
            return None;
        }
        let start = NaiveDate::from_ymd_opt(year, 1, 1)?;
        let end = NaiveDate::from_ymd_opt(year + 1, 1, 1)?;
        let midnight = |date: NaiveDate| {
            date.and_hms_opt(0, 0, 0)?
                .and_local_timezone(chrono_tz::Asia::Shanghai)
                .single()
                .map(|d| d.timestamp_millis())
        };
        let day_bounds = (0..(end - start).num_days())
            .map(|n| {
                Some((
                    midnight(start + Duration::days(n))?,
                    midnight(start + Duration::days(n + 1))?,
                ))
            })
            .collect::<Option<Vec<_>>>()?;
        Some(Self {
            year,
            start_ms: midnight(start)?,
            end_ms: midnight(end)?,
            dates: (0..(end - start).num_days())
                .map(|n| (start + Duration::days(n)).to_string())
                .collect(),
            day_bounds,
        })
    }
}
pub fn shanghai_year(ms: i64) -> Option<i32> {
    DateTime::from_timestamp_millis(ms).map(|d| d.with_timezone(&chrono_tz::Asia::Shanghai).year())
}
#[derive(Clone, Debug)]
pub struct ProfileMessageCounts {
    pub earliest_ms: Option<i64>,
    /// Zero-based day within the requested year; SQL aggregates before returning.
    pub days: Vec<(i64, i64)>,
}
pub trait ProfileMessageCountRead: Clone + Send + Sync + 'static {
    fn read_counts(
        &self,
        subject: &Principal,
        year: &MessageCountYear,
    ) -> impl Future<Output = Result<ProfileMessageCounts, PersistenceFailure>> + Send;
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn year_bounds_are_shanghai_and_leap_days_are_explicit() {
        let y = MessageCountYear::new(2024).unwrap();
        assert_eq!(y.dates.len(), 366);
        assert_eq!(y.dates[59], "2024-02-29");
        assert_eq!(
            (y.start_ms, y.end_ms),
            (1_704_038_400_000, 1_735_660_800_000)
        );
        for (instant, expected) in [
            (1_704_038_399_999, 2023),
            (1_704_038_400_000, 2024),
            (1_735_660_799_999, 2024),
            (1_735_660_800_000, 2025),
        ] {
            assert_eq!(shanghai_year(instant), Some(expected));
        }
        assert_eq!(MessageCountYear::new(2023).unwrap().dates.len(), 365);
        for year in [1969, 9999] {
            assert!(MessageCountYear::new(year).is_none());
        }
        assert!(MessageCountYear::new(1970).is_some());
        assert!(MessageCountYear::new(9998).is_some());
        let historical = MessageCountYear::new(1988).unwrap();
        for (date, bounds) in [
            ("1988-04-17", (577_209_600_000, 577_292_400_000)),
            ("1988-09-11", (589_906_800_000, 589_996_800_000)),
        ] {
            let index = historical.dates.iter().position(|d| d == date).unwrap();
            assert_eq!(historical.day_bounds[index], bounds);
        }
    }
}
