//! Authenticated cold face for `GET /api/presence`: every viewer's presence now.
//!
//! The route is AUTHENTICATED. In the TypeScript source the composition perimeter
//! — the public-bearer middleware and the registered-viewer gate — fronts every
//! `/api/*` path that is not on its small allowlist, and `/api/presence` is on
//! neither list, so an anonymous caller is refused at that perimeter and never
//! reaches this handler. The answer itself is caller-INDEPENDENT (it lists ALL
//! viewers, not the caller's own row), so the principal is not read as a filter;
//! it is required only as proof the authenticating perimeter ran. Its ABSENCE is
//! therefore a composition fault, not a product request error, and takes the
//! lane's safe `500` — a fail-closed refusal that reads nothing — rather than a
//! product answer that would leak the whole set past a missing perimeter. Mounting
//! the real bearer perimeter that turns that fault into the external
//! `401 {"error":"unauthorized"}` is the composition root's job (#task:2197), not
//! this factory's.
//!
//! The answer joins two authorities: the durable last-seen facts from
//! [`UserPresenceReadModel`] and the live liveness from [`OnlineViewers`], sealed
//! into a [`PresenceSnapshot`] and merged by the driver-free [`read_user_presence`].
//! The two must observe ONE fact — the `OnlineViewers` must be the registry the
//! `user_presence` event publishes from — an obligation on the composition (see
//! [`crate::viewer_read_model::online_viewers`]), not enforced here.

use axum::{
    Json, Router,
    extract::{Extension, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::get,
};
use serde::Serialize;
use silverhand_backend_core::{
    foundation::identity::UserId,
    viewer_read_model::presence::{
        LastSeenAt, OnlineViewers, PresenceSnapshot, UserPresence, UserPresenceRow,
        read_user_presence,
    },
    viewer_read_model::user_presence_cold_read::UserPresenceReadModel,
};

use crate::foundation::error;

pub const PRESENCE_PATH: &str = "/api/presence";

/// The unmapped-error body: the product route registers no `onError`, so an
/// unexpected failure falls to the framework default — a `500` with a bare
/// `text/plain` `Internal Server Error`, never a JSON envelope.
const INTERNAL_ERROR_BODY: &str = "Internal Server Error";

/// The two authorities bundled into one cloneable router state: the durable
/// last-seen loader and the live presence registry.
#[derive(Clone)]
struct PresenceState<U, O> {
    cold_read: U,
    online: O,
}

pub fn router<U, O>(cold_read: U, online: O) -> Router
where
    U: UserPresenceReadModel + Clone + Send + Sync + 'static,
    O: OnlineViewers + Clone + Send + Sync + 'static,
{
    Router::new()
        .route(PRESENCE_PATH, get(list::<U, O>))
        .with_state(PresenceState { cold_read, online })
}

async fn list<U, O>(
    State(state): State<PresenceState<U, O>>,
    viewer: Option<Extension<UserId>>,
) -> Response
where
    U: UserPresenceReadModel,
    O: OnlineViewers,
{
    let Some(Extension(_viewer)) = viewer else {
        tracing::error!("presence route reached without its human principal fact");
        return (StatusCode::INTERNAL_SERVER_ERROR, INTERNAL_ERROR_BODY).into_response();
    };
    let facts = match state.cold_read.list_user_presence_facts().await {
        Ok(facts) => facts,
        Err(cause) => {
            tracing::error!(
                error_chain =
                    crate::foundation::safe_log_field::safe_display(&(error::describe(&cause))),
                "presence cold read failed"
            );
            return (StatusCode::INTERNAL_SERVER_ERROR, INTERNAL_ERROR_BODY).into_response();
        }
    };
    match PresenceSnapshot::seal(facts) {
        Ok(snapshot) => {
            let rows = read_user_presence(&snapshot, &state.online);
            Json(PresenceResponse::from(rows.as_slice())).into_response()
        }
        Err(violation) => {
            tracing::error!(
                error_chain =
                    crate::foundation::safe_log_field::safe_display(&(error::describe(&violation))),
                "presence snapshot violated its closed contract"
            );
            (StatusCode::INTERNAL_SERVER_ERROR, INTERNAL_ERROR_BODY).into_response()
        }
    }
}

#[derive(Serialize)]
struct PresenceResponse {
    users: Vec<UserPresenceDto>,
}

impl From<&[UserPresenceRow]> for PresenceResponse {
    fn from(rows: &[UserPresenceRow]) -> Self {
        Self {
            users: rows.iter().map(UserPresenceDto::from).collect(),
        }
    }
}

/// The wire row. `presence` is the lowercase closed enum and `last_seen_at` is
/// present on the offline arm only — the online arm carries `null`, so a present
/// viewer's stored stamp is never leaked. The validated stamp is unwrapped to its
/// raw integer only here, at the wire.
#[derive(Serialize)]
struct UserPresenceDto {
    user_id: String,
    presence: &'static str,
    last_seen_at: Option<i64>,
}

impl From<&UserPresenceRow> for UserPresenceDto {
    fn from(row: &UserPresenceRow) -> Self {
        let (presence, last_seen_at) = match row.presence {
            UserPresence::Online => ("online", None),
            UserPresence::Offline { last_seen_at } => {
                ("offline", last_seen_at.map(LastSeenAt::get))
            }
        };
        Self {
            user_id: row.user_id.as_str().to_owned(),
            presence,
            last_seen_at,
        }
    }
}

#[cfg(test)]
mod tests {
    use std::sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    };

    use axum::{
        body::{Body, to_bytes},
        http::{Request, StatusCode},
    };
    use serde_json::{Value, json};
    use silverhand_backend_core::{
        foundation::identity::UserId,
        foundation::persistence::PersistenceFailure,
        viewer_read_model::presence::{LastSeenAt, OnlineViewers, UserPresenceFacts},
        viewer_read_model::user_presence_cold_read::UserPresenceReadModel,
    };
    use tower::ServiceExt;

    use super::{PRESENCE_PATH, router};

    fn user(id: &str) -> UserId {
        UserId::parse(id).unwrap()
    }

    fn facts(id: &str, last_seen_at: Option<i64>, created_at: i64) -> UserPresenceFacts {
        UserPresenceFacts {
            id: user(id),
            last_seen_at: last_seen_at.map(|value| LastSeenAt::from_stored(value).unwrap()),
            created_at,
        }
    }

    #[derive(Clone)]
    enum Outcome {
        Facts(Vec<UserPresenceFacts>),
        Fails,
    }

    /// Serves a fixed outcome and counts every read, so a path that answered
    /// WITHOUT reading (a missing principal) is distinguishable from one that read
    /// and then failed to seal.
    #[derive(Clone)]
    struct Recorder {
        outcome: Outcome,
        calls: Arc<AtomicUsize>,
    }

    impl UserPresenceReadModel for Recorder {
        async fn list_user_presence_facts(
            &self,
        ) -> Result<Vec<UserPresenceFacts>, PersistenceFailure> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            match &self.outcome {
                Outcome::Facts(facts) => Ok(facts.clone()),
                Outcome::Fails => Err(PersistenceFailure::from_source(std::io::Error::other(
                    "presence store gone",
                ))),
            }
        }
    }

    /// Live liveness double: only the named ids read present.
    #[derive(Clone)]
    struct Present(Vec<UserId>);

    impl OnlineViewers for Present {
        fn is_online(&self, user_id: &UserId) -> bool {
            self.0.contains(user_id)
        }
    }

    async fn get(
        outcome: Outcome,
        online: Present,
        with_principal: bool,
    ) -> (StatusCode, String, usize) {
        let calls = Arc::new(AtomicUsize::new(0));
        let recorder = Recorder {
            outcome,
            calls: calls.clone(),
        };
        let mut request = Request::get(PRESENCE_PATH);
        if with_principal {
            request = request.extension(user("viewer-1"));
        }
        let response = router(recorder, online)
            .oneshot(request.body(Body::empty()).unwrap())
            .await
            .unwrap();
        let status = response.status();
        let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        (
            status,
            String::from_utf8(body.to_vec()).unwrap(),
            calls.load(Ordering::SeqCst),
        )
    }

    #[tokio::test]
    async fn the_wire_shape_matches_the_shared_contract_in_listed_order() {
        // Order preserved from the loader; a present viewer suppresses its stamp,
        // an absent one with a stamp keeps it, and an absent one never seen is null.
        let outcome = Outcome::Facts(vec![
            facts("online-with-old-stamp", Some(1), 1),
            facts("offline-seen", Some(1_234), 2),
            facts("offline-never-seen", None, 3),
        ]);
        let online = Present(vec![user("online-with-old-stamp")]);

        let (status, body, calls) = get(outcome, online, true).await;

        assert_eq!(status, StatusCode::OK);
        assert_eq!(calls, 1);
        assert_eq!(
            serde_json::from_str::<Value>(&body).unwrap(),
            json!({
                "users": [
                    { "user_id": "online-with-old-stamp", "presence": "online", "last_seen_at": null },
                    { "user_id": "offline-seen", "presence": "offline", "last_seen_at": 1234 },
                    { "user_id": "offline-never-seen", "presence": "offline", "last_seen_at": null },
                ]
            })
        );
    }

    #[tokio::test]
    async fn a_read_failure_is_a_safe_500() {
        let (status, body, calls) = get(Outcome::Fails, Present(Vec::new()), true).await;
        assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR);
        assert_eq!(calls, 1);
        assert_eq!(body, "Internal Server Error");
    }

    #[tokio::test]
    async fn a_missing_principal_is_a_safe_500_and_never_reads() {
        // No perimeter ran, so no principal reached the handler: it must refuse
        // fail-closed BEFORE touching the store, never leaking the whole set.
        let (status, body, calls) = get(
            Outcome::Facts(vec![facts("u1", None, 1)]),
            Present(Vec::new()),
            false,
        )
        .await;
        assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR);
        assert_eq!(calls, 0);
        assert_eq!(body, "Internal Server Error");
    }

    #[tokio::test]
    async fn a_duplicate_identity_from_the_port_is_a_safe_500() {
        // A port that hands back the same viewer twice is corruption, not a listable
        // set: the read ran, but the seal refuses it rather than projecting a `200`.
        let outcome = Outcome::Facts(vec![facts("u1", None, 1), facts("u1", None, 2)]);
        let (status, body, calls) = get(outcome, Present(Vec::new()), true).await;
        assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR);
        assert_eq!(calls, 1);
        assert_eq!(body, "Internal Server Error");
    }

    #[tokio::test]
    async fn an_out_of_order_port_is_a_safe_500() {
        // Rows not in the contracted `(created_at, id)` order describe a broken port;
        // the seal refuses them rather than reordering silently into a `200`.
        let outcome = Outcome::Facts(vec![facts("u2", None, 2), facts("u1", None, 1)]);
        let (status, body, calls) = get(outcome, Present(Vec::new()), true).await;
        assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR);
        assert_eq!(calls, 1);
        assert_eq!(body, "Internal Server Error");
    }
}
