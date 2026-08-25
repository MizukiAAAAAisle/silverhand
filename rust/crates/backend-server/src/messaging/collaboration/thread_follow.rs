//! Authenticated human thread-follow routes.

use std::sync::Arc;

use axum::{
    Json, Router,
    extract::{Extension, Path, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::get,
};
use serde::Deserialize;
use serde_json::json;
use silverhand_backend_core::{
    identity::{ConversationId, UserId},
    messaging::{
        ThreadRootId,
        collaboration::thread_follow::{
            BoundHumanFollow, BoundHumanUnfollow, BoundThreadFollowerState, HumanFollowRefusal,
            HumanUnfollowRefusal, ThreadFollowAftermath, ThreadFollowPort,
            ThreadFollowerStateRefusal, follow_human, unfollow_human,
        },
    },
};

pub const FOLLOWERS_PATH: &str = "/api/channels/{id}/threads/{root_message_id}/followers";
pub const FOLLOW_PATH: &str = "/api/channels/{id}/threads/{root_message_id}/follow";

struct Inner<P, A> {
    port: P,
    aftermath: A,
}

struct ThreadFollowState<P, A>(Arc<Inner<P, A>>);

impl<P, A> Clone for ThreadFollowState<P, A> {
    fn clone(&self) -> Self {
        Self(Arc::clone(&self.0))
    }
}

pub fn router<P, A>(port: P, aftermath: A) -> Router
where
    P: ThreadFollowPort + Send + Sync + 'static,
    A: ThreadFollowAftermath + Send + Sync + 'static,
{
    Router::new()
        .route(FOLLOWERS_PATH, get(read::<P, A>))
        .route(
            FOLLOW_PATH,
            axum::routing::post(follow::<P, A>).delete(unfollow::<P, A>),
        )
        .with_state(ThreadFollowState(Arc::new(Inner { port, aftermath })))
}

#[derive(Deserialize)]
struct ThreadPath {
    id: String,
    root_message_id: String,
}

fn coordinates(path: ThreadPath) -> Result<(ConversationId, ThreadRootId), ()> {
    let conversation = ConversationId::parse(path.id).map_err(|_| ())?;
    let root = ThreadRootId::parse(path.root_message_id).map_err(|_| ())?;
    Ok((conversation, root))
}

async fn read<P: ThreadFollowPort, A: ThreadFollowAftermath>(
    State(state): State<ThreadFollowState<P, A>>,
    principal: Option<Extension<UserId>>,
    Path(path): Path<ThreadPath>,
) -> Response {
    let Some(Extension(viewer)) = principal else {
        tracing::error!("thread-follower state route reached without human principal");
        return internal();
    };
    let (conversation, message) = match coordinates(path) {
        Ok(value) => value,
        Err(()) => return missing_coordinates(),
    };
    match state.0.port.state(&viewer, &conversation, &message).await {
        Ok(Ok(value)) => match value.bind(&viewer, &conversation, &message) {
            Ok(value) => state_success(&value),
            Err(error) => {
                tracing::error!(error_chain=%crate::error::describe(&error), "thread-follower state identity seal failed");
                internal()
            }
        },
        Ok(Err(refusal)) => state_refusal(refusal),
        Err(error) => {
            tracing::error!(error_chain=%crate::error::describe(&error), "thread-follower state failed");
            internal()
        }
    }
}

async fn follow<P: ThreadFollowPort, A: ThreadFollowAftermath>(
    State(state): State<ThreadFollowState<P, A>>,
    principal: Option<Extension<UserId>>,
    Path(path): Path<ThreadPath>,
) -> Response {
    let Some(Extension(viewer)) = principal else {
        tracing::error!("thread-follow route reached without human principal");
        return internal();
    };
    let (conversation, message) = match coordinates(path) {
        Ok(value) => value,
        Err(()) => return missing_coordinates(),
    };
    match follow_human(
        &state.0.port,
        &state.0.aftermath,
        viewer,
        conversation,
        message,
    )
    .await
    {
        Ok(Ok(execution)) => {
            if let Some(failure) = execution.publication_failure() {
                tracing::error!(error_chain=%crate::error::describe(failure), "committed thread-follow unread publication failed");
            }
            follow_success(execution.committed())
        }
        Ok(Err(refusal)) => follow_refusal(refusal),
        Err(error) => {
            tracing::error!(error_chain=%crate::error::describe(&error), "thread-follow write failed");
            internal()
        }
    }
}

async fn unfollow<P: ThreadFollowPort, A: ThreadFollowAftermath>(
    State(state): State<ThreadFollowState<P, A>>,
    principal: Option<Extension<UserId>>,
    Path(path): Path<ThreadPath>,
) -> Response {
    let Some(Extension(viewer)) = principal else {
        tracing::error!("thread-unfollow route reached without human principal");
        return internal();
    };
    let (conversation, message) = match coordinates(path) {
        Ok(value) => value,
        Err(()) => return missing_coordinates(),
    };
    match unfollow_human(
        &state.0.port,
        &state.0.aftermath,
        viewer,
        conversation,
        message,
    )
    .await
    {
        Ok(Ok(execution)) => {
            if let Some(failure) = execution.publication_failure() {
                tracing::error!(error_chain=%crate::error::describe(failure), "committed thread-unfollow unread publication failed");
            }
            unfollow_success(execution.committed())
        }
        Ok(Err(refusal)) => unfollow_refusal(refusal),
        Err(error) => {
            tracing::error!(error_chain=%crate::error::describe(&error), "thread-unfollow write failed");
            internal()
        }
    }
}

fn state_success(value: &BoundThreadFollowerState) -> Response {
    Json(json!({
        "thread_root_id": value.root().as_str(),
        "viewer_following": value.viewer_following(),
        "follower_agent_ids": value.agents().iter().map(|agent| agent.agent().as_str()).collect::<Vec<_>>(),
    }))
    .into_response()
}

fn follow_success(value: &BoundHumanFollow) -> Response {
    Json(json!({
        "thread_root_id": value.root().as_str(),
        "changed": value.changed(),
        "viewer_following": true,
    }))
    .into_response()
}

fn unfollow_success(value: &BoundHumanUnfollow) -> Response {
    Json(json!({
        "thread_root_id": value.root().as_str(),
        "changed": value.changed(),
        "viewer_following": false,
    }))
    .into_response()
}

fn state_refusal(refusal: ThreadFollowerStateRefusal) -> Response {
    match refusal {
        ThreadFollowerStateRefusal::ConversationNotFound => {
            error(StatusCode::NOT_FOUND, "channel not found")
        }
        ThreadFollowerStateRefusal::Forbidden => error(StatusCode::FORBIDDEN, "forbidden"),
        ThreadFollowerStateRefusal::RootNotFound => root_not_found(),
    }
}

fn follow_refusal(refusal: HumanFollowRefusal) -> Response {
    match refusal {
        HumanFollowRefusal::ConversationNotFound => {
            error(StatusCode::NOT_FOUND, "channel not found")
        }
        HumanFollowRefusal::Forbidden => error(StatusCode::FORBIDDEN, "forbidden"),
        HumanFollowRefusal::RootNotFound => root_not_found(),
    }
}

fn unfollow_refusal(refusal: HumanUnfollowRefusal) -> Response {
    match refusal {
        HumanUnfollowRefusal::ConversationNotFound => {
            error(StatusCode::NOT_FOUND, "channel not found")
        }
        HumanUnfollowRefusal::Forbidden => error(StatusCode::FORBIDDEN, "forbidden"),
        HumanUnfollowRefusal::RootNotFound => root_not_found(),
    }
}

fn root_not_found() -> Response {
    (
        StatusCode::NOT_FOUND,
        Json(json!({
            "error":"thread root message not found in conversation",
            "code":"reply_target_not_found"
        })),
    )
        .into_response()
}

fn missing_coordinates() -> Response {
    error(
        StatusCode::BAD_REQUEST,
        "channel id and root message id required",
    )
}

fn error(status: StatusCode, message: &'static str) -> Response {
    (status, Json(json!({"error":message}))).into_response()
}

fn internal() -> Response {
    error(StatusCode::INTERNAL_SERVER_ERROR, "internal error")
}

#[cfg(test)]
mod tests {
    use std::{
        convert::Infallible,
        sync::{Arc, Mutex},
    };

    use axum::{
        body::{Body, to_bytes},
        http::{Method, Request},
    };
    use serde_json::Value;
    use silverhand_backend_core::{
        identity::AgentId,
        messaging::collaboration::thread_follow::{
            CommittedHumanFollow, CommittedHumanUnfollow, FollowedAt, ThreadFollowChangedFact,
            ThreadFollowPublicationFailure, ThreadFollowerAgent, ThreadFollowerState,
        },
    };
    use silverhand_backend_sqlite::messaging::MessagingStore;
    use sqlx::{Connection, Executor, SqliteConnection, sqlite::SqliteConnectOptions};
    use tower::ServiceExt;

    use super::*;

    #[derive(Clone, Default)]
    struct RecordingAftermath {
        calls: Arc<Mutex<Vec<(String, String)>>>,
        fail: bool,
    }

    #[derive(Debug, thiserror::Error)]
    #[error("event hub unavailable")]
    struct HubDown;

    impl ThreadFollowAftermath for RecordingAftermath {
        async fn unread_changed(
            &self,
            fact: ThreadFollowChangedFact<'_>,
        ) -> Result<(), ThreadFollowPublicationFailure> {
            self.calls.lock().unwrap().push((
                fact.viewer().as_str().to_owned(),
                fact.conversation().as_str().to_owned(),
            ));
            if self.fail {
                Err(ThreadFollowPublicationFailure::from_source(HubDown))
            } else {
                Ok(())
            }
        }
    }

    #[derive(Clone)]
    struct SplicedPort {
        state_conversation: &'static str,
        state_agent_conversation: &'static str,
        state_requested: &'static str,
        mutation_conversation: &'static str,
        mutation_requested: &'static str,
    }

    impl ThreadFollowPort for SplicedPort {
        type Error = Infallible;

        async fn state(
            &self,
            viewer: &UserId,
            _: &ConversationId,
            _: &ThreadRootId,
        ) -> Result<Result<ThreadFollowerState, ThreadFollowerStateRefusal>, Self::Error> {
            Ok(Ok(ThreadFollowerState::projected(
                viewer.clone(),
                ConversationId::parse(self.state_conversation).unwrap(),
                ThreadRootId::parse(self.state_requested).unwrap(),
                ThreadRootId::parse(self.mutation_requested).unwrap(),
                true,
                vec![ThreadFollowerAgent::projected(
                    ConversationId::parse(self.state_agent_conversation).unwrap(),
                    ThreadRootId::parse("root").unwrap(),
                    AgentId::parse("agent-a").unwrap(),
                    FollowedAt::new(1).unwrap(),
                )],
            )
            .unwrap()))
        }

        async fn follow(
            &self,
            viewer: UserId,
            _: ConversationId,
            _: ThreadRootId,
        ) -> Result<Result<CommittedHumanFollow, HumanFollowRefusal>, Self::Error> {
            Ok(Ok(CommittedHumanFollow::committed(
                viewer,
                ConversationId::parse(self.mutation_conversation).unwrap(),
                ThreadRootId::parse(self.mutation_requested).unwrap(),
                ThreadRootId::parse("root").unwrap(),
                true,
            )))
        }

        async fn unfollow(
            &self,
            viewer: UserId,
            _: ConversationId,
            _: ThreadRootId,
        ) -> Result<Result<CommittedHumanUnfollow, HumanUnfollowRefusal>, Self::Error> {
            Ok(Ok(CommittedHumanUnfollow::committed(
                viewer,
                ConversationId::parse(self.mutation_conversation).unwrap(),
                ThreadRootId::parse(self.mutation_requested).unwrap(),
                ThreadRootId::parse("root").unwrap(),
                true,
            )))
        }
    }

    async fn response(
        router: Router,
        method: Method,
        uri: &str,
        authenticated: bool,
    ) -> (StatusCode, Value) {
        let mut request = Request::builder()
            .method(method)
            .uri(uri)
            .body(Body::empty())
            .unwrap();
        if authenticated {
            request
                .extensions_mut()
                .insert(UserId::parse("local").unwrap());
        }
        let response = router.oneshot(request).await.unwrap();
        let status = response.status();
        let body =
            serde_json::from_slice(&to_bytes(response.into_body(), usize::MAX).await.unwrap())
                .unwrap();
        (status, body)
    }

    #[tokio::test]
    async fn auth_and_every_returned_coordinate_bind_before_wire_or_effect() {
        let aftermath = RecordingAftermath::default();
        let base = SplicedPort {
            state_conversation: "c",
            state_agent_conversation: "c",
            state_requested: "root",
            mutation_conversation: "c",
            mutation_requested: "root",
        };
        let (status, _) = response(
            router(base.clone(), aftermath.clone()),
            Method::GET,
            "/api/channels/c/threads/root/followers",
            false,
        )
        .await;
        assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR);
        assert!(aftermath.calls.lock().unwrap().is_empty());

        for port in [
            SplicedPort {
                state_conversation: "other",
                ..base.clone()
            },
            SplicedPort {
                state_agent_conversation: "other",
                ..base.clone()
            },
            SplicedPort {
                state_requested: "other",
                ..base.clone()
            },
        ] {
            let (status, body) = response(
                router(port, aftermath.clone()),
                Method::GET,
                "/api/channels/c/threads/root/followers",
                true,
            )
            .await;
            assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR);
            assert_eq!(body, json!({"error":"internal error"}));
        }
        let (status, _) = response(
            router(
                SplicedPort {
                    mutation_conversation: "other",
                    ..base.clone()
                },
                aftermath.clone(),
            ),
            Method::POST,
            "/api/channels/c/threads/root/follow",
            true,
        )
        .await;
        assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR);
        assert!(aftermath.calls.lock().unwrap().is_empty());
        let (status, _) = response(
            router(
                SplicedPort {
                    mutation_requested: "other",
                    ..base.clone()
                },
                aftermath.clone(),
            ),
            Method::DELETE,
            "/api/channels/c/threads/root/follow",
            true,
        )
        .await;
        assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR);
        assert!(aftermath.calls.lock().unwrap().is_empty());

        let (status, body) = response(
            router(base, aftermath.clone()),
            Method::GET,
            "/api/channels/c/threads/root/followers",
            true,
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(
            body,
            json!({"thread_root_id":"root","viewer_following":true,"follower_agent_ids":["agent-a"]})
        );
    }

    async fn fixture_store(setup: &str) -> (tempfile::TempDir, MessagingStore) {
        const SCHEMA: &str = include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../../packages/backend/tests/migration-baseline/schema-current.sql"
        ));
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("thread-follow.sqlite");
        let options = SqliteConnectOptions::new()
            .filename(&path)
            .create_if_missing(true)
            .foreign_keys(true);
        let mut db = SqliteConnection::connect_with(&options).await.unwrap();
        db.execute(sqlx::raw_sql(SCHEMA)).await.unwrap();
        if setup != "missing_conversation" {
            db.execute(sqlx::raw_sql(
            "INSERT INTO users(id,name,display_name,created_at,updated_at) VALUES
             ('local','local-thread-follow','Local',1,1),('other','other-thread-follow','Other',1,1);
             INSERT INTO hosts(id,name,kind,created_at) VALUES('host','Host','local',1);
             INSERT INTO agents(id,name,runtime,host_id,created_at,updated_at,created_by_user_id) VALUES
             ('agent-a','agent-a-thread-follow','claude','host',1,1,'local'),
             ('agent-b','agent-b-thread-follow','claude','host',1,1,'local'),
             ('agent-x','agent-x-thread-follow','claude','host',1,1,'local');
             INSERT INTO workspaces(id,name,name_key,created_at,updated_at) VALUES('w','Workspace','thread-follow',1,1);
             INSERT INTO workspace_users(workspace_id,user_id,joined_at) VALUES('w','local',1);
             INSERT INTO conversations(id,workspace_id,placement_kind,roster_policy,title,title_key,status,visibility,created_at,updated_at)
             VALUES('c','w','workspace','open','General','thread-follow','idle','private',1,1);"
            )).await.unwrap();
            if setup == "forbidden" {
                sqlx::query(
                    "DELETE FROM conversation_users WHERE conversation_id='c' AND user_id='local'",
                )
                .execute(&mut db)
                .await
                .unwrap();
            } else {
                db.execute(sqlx::raw_sql(
                    "INSERT OR IGNORE INTO conversation_users(conversation_id,user_id,joined_at) VALUES('c','local',1);
                     INSERT INTO conversation_agents(conversation_id,agent_id,joined_at) VALUES('c','agent-a',1),('c','agent-b',1);
                     INSERT INTO messages(id,conversation_id,from_kind,from_user_id,content,seq,created_at,thread_root_id) VALUES
                     ('root','c','user','local','root',1,1,NULL),('reply','c','user','other','reply',2,2,'root');"
                )).await.unwrap();
                if setup == "state_member" {
                    db.execute(sqlx::raw_sql(
                        "INSERT INTO thread_followers(thread_root_id,conversation_id,principal_kind,principal_id,followed_at,source) VALUES
                         ('root','c','human','local',1,'manual'),('root','c','agent','agent-a',2,'mention'),
                         ('root','c','agent','agent-b',3,'reply'),('root','c','agent','agent-x',4,'manual');"
                    )).await.unwrap();
                } else if setup == "tie_order" {
                    db.execute(sqlx::raw_sql(
                        "INSERT INTO thread_followers(thread_root_id,conversation_id,principal_kind,principal_id,followed_at,source) VALUES
                         ('root','c','agent','agent-b',7,'reply'),('root','c','agent','agent-a',7,'mention'),
                         ('root','c','agent','agent-x',6,'manual');"
                    )).await.unwrap();
                } else if setup == "following" {
                    db.execute(sqlx::raw_sql(
                        "INSERT INTO thread_followers(thread_root_id,conversation_id,principal_kind,principal_id,followed_at,source)
                         VALUES('root','c','human','local',1,'manual');"
                    )).await.unwrap();
                }
            }
        }
        db.close().await.unwrap();
        let store = MessagingStore::open(path).await.unwrap();
        (dir, store)
    }

    #[tokio::test]
    async fn production_sqlite_and_router_consume_the_ts_signed_surface() {
        let fixture: Value = serde_json::from_str(include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../../packages/backend/tests/fixtures/thread-follow-wire.json"
        )))
        .unwrap();
        for case in fixture.as_array().unwrap() {
            let (_dir, store) = fixture_store(case["setup"].as_str().unwrap()).await;
            let method = match case["method"].as_str().unwrap() {
                "GET" => Method::GET,
                "POST" => Method::POST,
                "DELETE" => Method::DELETE,
                _ => unreachable!(),
            };
            let (status, body) = response(
                router(store.thread_follow(), RecordingAftermath::default()),
                method,
                case["path"].as_str().unwrap(),
                true,
            )
            .await;
            assert_eq!(
                status.as_u16(),
                case["status"].as_u64().unwrap() as u16,
                "{}",
                case["name"]
            );
            assert_eq!(body, case["body"], "{}", case["name"]);
        }
        assert_eq!(fixture.as_array().unwrap().len(), 8);
    }

    #[tokio::test]
    async fn deterministic_tie_order_and_changed_only_aftermath_are_separate_rust_gates() {
        let (_dir, store) = fixture_store("tie_order").await;
        let aftermath = RecordingAftermath::default();

        let (status, body) = response(
            router(store.thread_follow(), aftermath.clone()),
            Method::GET,
            "/api/channels/c/threads/reply/followers",
            true,
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(
            body,
            json!({"thread_root_id":"root","viewer_following":false,"follower_agent_ids":["agent-a","agent-b"]})
        );

        for expected_changed in [true, false] {
            let (status, body) = response(
                router(store.thread_follow(), aftermath.clone()),
                Method::POST,
                "/api/channels/c/threads/reply/follow",
                true,
            )
            .await;
            assert_eq!(status, StatusCode::OK);
            assert_eq!(
                body,
                json!({"thread_root_id":"root","changed":expected_changed,"viewer_following":true})
            );
        }
        assert_eq!(
            aftermath.calls.lock().unwrap().as_slice(),
            &[("local".into(), "c".into())]
        );
        for expected_changed in [true, false] {
            let (status, body) = response(
                router(store.thread_follow(), aftermath.clone()),
                Method::DELETE,
                "/api/channels/c/threads/root/follow",
                true,
            )
            .await;
            assert_eq!(status, StatusCode::OK);
            assert_eq!(
                body,
                json!({"thread_root_id":"root","changed":expected_changed,"viewer_following":false})
            );
        }
        assert_eq!(aftermath.calls.lock().unwrap().len(), 2);
    }

    #[tokio::test]
    async fn refusal_order_and_post_commit_publication_failure_are_fail_closed() {
        let (_dir, store) = fixture_store("normal").await;
        let failing = RecordingAftermath {
            calls: Arc::default(),
            fail: true,
        };
        let (status, body) = response(
            router(store.thread_follow(), failing.clone()),
            Method::POST,
            "/api/channels/c/threads/root/follow",
            true,
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(
            body,
            json!({"thread_root_id":"root","changed":true,"viewer_following":true})
        );
        assert_eq!(failing.calls.lock().unwrap().len(), 1);
        let (status, body) = response(
            router(store.thread_follow(), RecordingAftermath::default()),
            Method::GET,
            "/api/channels/c/threads/root/followers",
            true,
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["viewer_following"], true);
        let (status, body) = response(
            router(store.thread_follow(), RecordingAftermath::default()),
            Method::GET,
            "/api/channels/c/threads/missing/followers",
            true,
        )
        .await;
        assert_eq!(status, StatusCode::NOT_FOUND);
        assert_eq!(
            body,
            json!({"error":"thread root message not found in conversation","code":"reply_target_not_found"})
        );
        let (status, body) = response(
            router(store.thread_follow(), RecordingAftermath::default()),
            Method::GET,
            "/api/channels/missing/threads/root/followers",
            true,
        )
        .await;
        assert_eq!(status, StatusCode::NOT_FOUND);
        assert_eq!(body, json!({"error":"channel not found"}));
    }

    #[tokio::test]
    async fn every_selected_follower_is_strictly_decoded_before_filtering() {
        let (dir, store) = fixture_store("normal").await;
        let options = SqliteConnectOptions::new()
            .filename(dir.path().join("thread-follow.sqlite"))
            .foreign_keys(false);
        let mut db = SqliteConnection::connect_with(&options).await.unwrap();
        sqlx::query(
            "INSERT INTO thread_followers(thread_root_id,conversation_id,principal_kind,principal_id,followed_at,source) \
             VALUES('root','c','agent','',1,'manual')",
        )
        .execute(&mut db)
        .await
        .unwrap();
        db.close().await.unwrap();
        let (status, body) = response(
            router(store.thread_follow(), RecordingAftermath::default()),
            Method::GET,
            "/api/channels/c/threads/root/followers",
            true,
        )
        .await;
        assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR);
        assert_eq!(body, json!({"error":"internal error"}));
    }
}
