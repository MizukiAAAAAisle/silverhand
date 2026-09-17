use super::*;
use silverhand_backend_core::identity_access::auth::SessionTokenHash;

async fn seed_peer(path: &Path, id: &str, token: &str) {
    let pool = SqlitePoolOptions::new()
        .connect(path.to_str().unwrap())
        .await
        .unwrap();
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_millis() as i64;
    sqlx::query("INSERT INTO users(id,name,display_name,created_at,updated_at) VALUES(?,?,?,1,1)")
        .bind(id)
        .bind(id)
        .bind(id)
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query(
        "INSERT INTO auth_sessions(id,user_id,token_hash,created_at,last_used_at) VALUES(?,?,?,?,?)",
    )
    .bind(id)
    .bind(id)
    .bind(SessionTokenHash::of_plaintext(token).as_str())
    .bind(now)
    .bind(now)
    .execute(&pool)
    .await
    .unwrap();
    pool.close().await;
}

async fn first_send(
    router: &Router,
    target: &str,
    bearer: Option<&str>,
    token: &str,
) -> (StatusCode, String) {
    request_with_body(
        router,
        "POST",
        &format!("/api/users/{target}/direct-messages"),
        bearer,
        Body::from(
            serde_json::json!({"content":"private hello", "client_message_id":token}).to_string(),
        ),
    )
    .await
}

#[tokio::test]
async fn human_first_send_is_authenticated_private_and_reuses_the_reverse_pair() {
    let fixture = fixture(true).await;
    seed_human(&fixture.path).await;
    seed_peer(&fixture.path, "user-2", "peer-token").await;
    seed_peer(&fixture.path, "user-3", "stranger-token").await;
    let app = prepare(&config(fixture.path.clone())).await.unwrap();
    let router = app.router;
    let viewer = format!("Bearer {TOKEN}");
    let peer = "Bearer peer-token";
    let stranger = "Bearer stranger-token";

    // Neither a common workspace nor a prior pair exists.
    assert_eq!(
        count(&fixture.path, "SELECT COUNT(*) FROM workspace_users").await,
        0
    );
    for (target, auth, status) in [
        ("user-2", None, StatusCode::UNAUTHORIZED),
        ("user-1", Some(viewer.as_str()), StatusCode::FORBIDDEN),
        ("missing", Some(viewer.as_str()), StatusCode::NOT_FOUND),
    ] {
        let result = first_send(&router, target, auth, "refused").await;
        assert_eq!(result.0, status, "{}", result.1);
    }
    assert_eq!(
        count(
            &fixture.path,
            "SELECT COUNT(*) FROM conversations WHERE placement_kind='direct_pair'"
        )
        .await,
        0
    );
    assert_eq!(
        count(&fixture.path, "SELECT COUNT(*) FROM messages").await,
        0
    );

    let first = first_send(
        &router,
        "user-2",
        Some(&viewer),
        "11111111-1111-4111-8111-111111111111",
    )
    .await;
    assert_eq!(first.0, StatusCode::CREATED, "{}", first.1);
    let conversation = direct_pair_conversation_id(&fixture.path).await;
    let retry = first_send(
        &router,
        "user-2",
        Some(&viewer),
        "11111111-1111-4111-8111-111111111111",
    )
    .await;
    assert_eq!(retry.0, StatusCode::CREATED, "{}", retry.1);
    assert_eq!(
        count(&fixture.path, "SELECT COUNT(*) FROM messages").await,
        1
    );
    let reverse = first_send(
        &router,
        "user-1",
        Some(peer),
        "22222222-2222-4222-8222-222222222222",
    )
    .await;
    assert_eq!(reverse.0, StatusCode::CREATED, "{}", reverse.1);
    assert_eq!(
        count(
            &fixture.path,
            "SELECT COUNT(*) FROM conversations WHERE placement_kind='direct_pair'"
        )
        .await,
        1
    );
    assert_eq!(
        count(&fixture.path, "SELECT COUNT(*) FROM messages").await,
        2
    );

    for auth in [viewer.as_str(), peer] {
        let (status, body) = request(&router, "GET", "/api/direct-pairs", Some(auth)).await;
        assert_eq!(status, StatusCode::OK, "{body}");
        let parsed: serde_json::Value = serde_json::from_str(&body).unwrap();
        assert_eq!(parsed["direct_pairs"].as_array().unwrap().len(), 1);
        assert_eq!(parsed["direct_pairs"][0]["conversation_id"], conversation);
        let messages = request(
            &router,
            "GET",
            &format!("/api/channels/{conversation}/messages"),
            Some(auth),
        )
        .await;
        assert_eq!(messages.0, StatusCode::OK, "{}", messages.1);
    }
    let list = request(&router, "GET", "/api/direct-pairs", Some(stranger)).await;
    assert_eq!(list.0, StatusCode::OK);
    assert_eq!(list.1, r#"{"direct_pairs":[]}"#);
    let messages = request(
        &router,
        "GET",
        &format!("/api/channels/{conversation}/messages"),
        Some(stranger),
    )
    .await;
    assert_eq!(messages.0, StatusCode::FORBIDDEN, "{}", messages.1);
}

#[tokio::test]
async fn human_directory_discovers_unrelated_registered_users_without_pagination_or_secrets() {
    let fixture = fixture(true).await;
    seed_human(&fixture.path).await;
    for i in 0..25 {
        seed_peer(
            &fixture.path,
            &format!("unrelated-{i}"),
            &format!("private-token-{i}"),
        )
        .await;
    }
    let app = prepare(&remote_config(fixture.path.clone())).await.unwrap();
    let bearer = format!("Bearer {TOKEN}");

    let (status, body) = request(&app.router, "GET", "/api/users", Some(&bearer)).await;
    assert_eq!(status, StatusCode::OK);
    let value: serde_json::Value = serde_json::from_str(&body).unwrap();
    let users = value["users"].as_array().unwrap();
    assert_eq!(users.len(), 26);
    for i in 0..25 {
        assert!(
            users
                .iter()
                .any(|user| user["id"] == format!("unrelated-{i}"))
        );
    }
    for user in users {
        let keys: std::collections::BTreeSet<_> = user
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect();
        assert_eq!(
            keys,
            [
                "id",
                "name",
                "display_name",
                "avatar_url",
                "created_at",
                "updated_at"
            ]
            .into_iter()
            .collect()
        );
    }
    assert!(!body.contains("private-token"));
    assert_eq!(
        count(&fixture.path, "SELECT COUNT(*) FROM workspace_users").await,
        0
    );
    assert_eq!(
        count(
            &fixture.path,
            "SELECT COUNT(*) FROM conversations WHERE placement_kind='direct_pair'"
        )
        .await,
        0
    );
}
