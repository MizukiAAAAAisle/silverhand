use sqlx::{Connection, Row};

#[path = "support/current_schema_snapshot.rs"]
mod current_schema;

#[tokio::test]
async fn materializes_the_full_snapshot_with_constraints_and_triggers() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("current.sqlite");
    let mut connection = current_schema::create_current_schema(&path).await;

    let counts = sqlx::query(
        "SELECT
            sum(type = 'table' AND name NOT LIKE 'sqlite_%') AS tables,
            sum(type = 'index' AND name NOT LIKE 'sqlite_%') AS indexes,
            sum(type = 'trigger') AS triggers
           FROM sqlite_schema",
    )
    .fetch_one(&mut connection)
    .await
    .unwrap();
    assert_eq!(counts.get::<i64, _>("tables"), 33);
    assert_eq!(counts.get::<i64, _>("indexes"), 73);
    assert_eq!(counts.get::<i64, _>("triggers"), 47);

    let foreign_key = sqlx::query(
        "INSERT INTO hosts
            (id, name, kind, created_at, user_id, provisioning_source)
         VALUES ('host-1', 'host-1', 'remote', 1, 'missing-user', 'user_invite')",
    )
    .execute(&mut connection)
    .await
    .unwrap_err();
    assert!(
        foreign_key
            .to_string()
            .contains("FOREIGN KEY constraint failed")
    );

    sqlx::query(
        "INSERT INTO agent_runtime_control_events
            (agent_id, generation, actor_user_id, reason, was_running, occurred_at)
         VALUES ('agent-1', 0, 'user-1', 'session_cleared', 0, 1)",
    )
    .execute(&mut connection)
    .await
    .unwrap();
    let trigger = sqlx::query("DELETE FROM agent_runtime_control_events")
        .execute(&mut connection)
        .await
        .unwrap_err();
    assert!(
        trigger
            .to_string()
            .contains("agent_runtime_control_events is append-only")
    );

    connection.close().await.unwrap();
}
