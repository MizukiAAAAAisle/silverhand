//! Explicit, stable statement identities. Timing includes pool/lock wait and row
//! fetching; neither SQL nor bindings are accepted by this observation boundary.
use std::{future::Future, time::Instant};

pub(crate) fn outcome(error: Option<&sqlx::Error>) -> &'static str {
    match error {
        None => "ok",
        Some(sqlx::Error::Database(error)) => match error
            .code()
            .and_then(|code| code.parse::<i32>().ok())
            .map(|code| code & 0xff)
        {
            Some(5) => "busy",
            Some(6) => "locked",
            _ => "error",
        },
        Some(_) => "error",
    }
}

pub(crate) async fn statement<T>(
    name: &'static str,
    operation: &'static str,
    query: impl Future<Output = Result<T, sqlx::Error>>,
) -> Result<T, sqlx::Error> {
    let started = Instant::now();
    let result = query.await;

    metrics::histogram!(
        "silverhand_db_statement_duration_seconds",
        "query_name" => name,
        "operation" => operation,
        "outcome" => outcome(result.as_ref().err()),
    )
    .record(started.elapsed().as_secs_f64());

    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use sqlx::{
        Connection,
        sqlite::{SqliteConnectOptions, SqliteConnection},
    };

    #[tokio::test]
    async fn real_busy_failure_is_counted_and_original_error_survives() {
        let dir = tempfile::tempdir().unwrap();
        let options = SqliteConnectOptions::new()
            .filename(dir.path().join("test.db"))
            .create_if_missing(true)
            .busy_timeout(std::time::Duration::from_millis(5));
        let mut writer = SqliteConnection::connect_with(&options).await.unwrap();
        let mut blocked = SqliteConnection::connect_with(&options).await.unwrap();
        sqlx::query("CREATE TABLE test (value INTEGER)")
            .execute(&mut writer)
            .await
            .unwrap();
        sqlx::query("BEGIN IMMEDIATE")
            .execute(&mut writer)
            .await
            .unwrap();

        let recorder = metrics_exporter_prometheus::PrometheusBuilder::new()
            .set_buckets(&[0.001, 0.01])
            .unwrap()
            .build_recorder();
        let _guard = metrics::set_default_local_recorder(&recorder);

        let result = statement(
            "hosts.test_write",
            "run",
            sqlx::query("INSERT INTO test VALUES (42)").execute(&mut blocked),
        )
        .await;
        assert_eq!(outcome(result.as_ref().err()), "busy");
        let error = result.unwrap_err();
        assert!(matches!(error, sqlx::Error::Database(_)));

        sqlx::query("ROLLBACK").execute(&mut writer).await.unwrap();
        statement(
            "hosts.test_write",
            "run",
            sqlx::query("INSERT INTO test VALUES (42)").execute(&mut blocked),
        )
        .await
        .unwrap();

        let text = recorder.handle().render();
        for outcome in ["busy", "ok"] {
            let line = text
                .lines()
                .find(|line| {
                    line.starts_with("silverhand_db_statement_duration_seconds_count{")
                        && line.contains(&format!("outcome=\"{outcome}\""))
                })
                .unwrap();
            assert!(line.ends_with(" 1"));
        }
        assert!(!text.contains("INSERT"));
        assert!(!text.contains("VALUES"));
    }
}
