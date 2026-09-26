//! Authenticated bulk list for `GET /api/hosts`: every computer the requester owns,
//! in the product's order, projected through the one host wire.
//!
//! Two authorities, in order:
//!
//!  1. NARROW — the owner-keyed index yields the requester's rows already ordered
//!     (live before revoked, then oldest first) and with unfinalized user-invite
//!     drafts hidden. That order and that filter are the adapter's, carried verbatim.
//!  2. ADMIT — [`owned_computers`] re-runs the ONE authorization authority over what
//!     the narrowing offered. A row it refuses is not this requester's, which the
//!     narrowing was supposed to guarantee: a fact-source drift, not a product
//!     refusal, so it takes a fail-closed `500` rather than quietly vanishing.
//!
//! The human principal is proof the authenticating perimeter ran; its ABSENCE is a
//! composition fault, not a product request, so it takes a fail-closed `500` having
//! read nothing. Mounting the real bearer perimeter is the composition root's job
//! (#task:2197), not this factory's.

use axum::{
    Json, Router,
    extract::{Extension, State},
    response::{IntoResponse, Response},
    routing::get,
};
use serde::Serialize;
use silverhand_backend_core::{
    foundation::identity::UserId,
    host_runtime::read::{ComputerReadModel, owned_computers},
};

use crate::foundation::error;

use super::{
    HOSTS_PATH,
    host_wire::{HostDto, host_wire},
    internal_error,
};

#[derive(Clone)]
struct ListState<R> {
    read_model: R,
}

pub fn router<R>(read_model: R) -> Router
where
    R: ComputerReadModel,
{
    Router::new()
        .route(HOSTS_PATH, get(host_list::<R>))
        .with_state(ListState { read_model })
}

async fn host_list<R>(
    requester: Option<Extension<UserId>>,
    State(state): State<ListState<R>>,
) -> Response
where
    R: ComputerReadModel,
{
    let Some(Extension(requester)) = requester else {
        tracing::error!("host-list route reached without its human principal fact");
        return internal_error();
    };

    let records = match state.read_model.list_for_owner(requester.clone()).await {
        Ok(records) => records,
        Err(cause) => {
            tracing::error!(
                error_chain =
                    crate::foundation::safe_log_field::safe_display(&(error::describe(&cause))),
                "host-list read failed"
            );
            return internal_error();
        }
    };

    // The narrowing already ordered and filtered; re-decide only authorization, and
    // keep its order untouched — re-sorting here would be a second, silent order.
    let owned = match owned_computers(&requester, &records) {
        Ok(owned) => owned,
        Err(mismatch) => {
            tracing::error!(
                computer = mismatch.computer().as_str(),
                "host-list narrowing offered a computer the requester does not own"
            );
            return internal_error();
        }
    };

    Json(HostListResponse {
        hosts: owned.into_iter().map(host_wire).collect(),
    })
    .into_response()
}

/// Success body: `{ "hosts": [HostDto] }`.
#[derive(Serialize)]
struct HostListResponse {
    hosts: Vec<HostDto>,
}

#[cfg(test)]
mod tests {
    use std::{
        io,
        sync::{
            Arc,
            atomic::{AtomicUsize, Ordering::SeqCst},
        },
    };

    use axum::{
        body::{Body, to_bytes},
        http::{Request, StatusCode},
    };
    use serde_json::{Value, json};
    use silverhand_backend_core::{
        foundation::identity::HostId,
        foundation::persistence::PersistenceFailure,
        host_runtime::computer::{ComputerRecord, HostKind, ProvisioningSource},
    };
    use tower::ServiceExt;

    use super::*;

    const REQUESTER: &str = "u-requester";

    fn user(id: &str) -> UserId {
        UserId::parse(id).expect("user id")
    }

    fn host(id: &str) -> HostId {
        HostId::parse(id).expect("host id")
    }

    /// A fully-active user-invite computer owned by `owner`.
    fn record(id: &str, owner: &str) -> ComputerRecord {
        ComputerRecord {
            id: host(id),
            name: format!("{id}-name"),
            kind: HostKind::Remote,
            created_at: 1,
            owner: Some(user(owner)),
            installation_id: None,
            last_seen_at: None,
            activated_at: Some(11),
            finalized_at: Some(12),
            revoked_at: None,
            provisioning_source: ProvisioningSource::UserInvite,
            display_label: None,
        }
    }

    #[derive(Clone)]
    enum ListOutcome {
        Rows(Vec<ComputerRecord>),
        Fails,
    }

    #[derive(Clone)]
    struct FakeComputers {
        outcome: ListOutcome,
        calls: Arc<AtomicUsize>,
    }

    impl ComputerReadModel for FakeComputers {
        async fn list_for_owner(
            &self,
            owner: UserId,
        ) -> Result<Vec<ComputerRecord>, PersistenceFailure> {
            assert_eq!(owner.as_str(), REQUESTER);
            self.calls.fetch_add(1, SeqCst);
            match &self.outcome {
                ListOutcome::Rows(rows) => Ok(rows.clone()),
                ListOutcome::Fails => Err(PersistenceFailure::from_source(io::Error::other(
                    "hosts gone",
                ))),
            }
        }

        async fn read_computer(
            &self,
            _computer: HostId,
        ) -> Result<Option<ComputerRecord>, PersistenceFailure> {
            unreachable!("the bulk list never reads a single computer by id")
        }
    }

    struct Reply {
        status: StatusCode,
        body: String,
        calls: usize,
    }

    async fn get_list(outcome: ListOutcome, with_principal: bool) -> Reply {
        let calls = Arc::new(AtomicUsize::new(0));
        let reads = FakeComputers {
            outcome,
            calls: calls.clone(),
        };
        let mut request = Request::get(HOSTS_PATH);
        if with_principal {
            request = request.extension(user(REQUESTER));
        }
        let response = router(reads)
            .oneshot(request.body(Body::empty()).unwrap())
            .await
            .unwrap();
        let status = response.status();
        let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        Reply {
            status,
            body: String::from_utf8(body.to_vec()).unwrap(),
            calls: calls.load(SeqCst),
        }
    }

    fn parsed(body: &str) -> Value {
        serde_json::from_str::<Value>(body).unwrap()
    }

    /// The owner's rows are projected through the one wire, in the order the index
    /// gave them — the route adds no order of its own.
    #[tokio::test]
    async fn the_owner_gets_every_owned_computer_projected_in_the_order_read() {
        let reply = get_list(
            ListOutcome::Rows(vec![record("h2", REQUESTER), record("h1", REQUESTER)]),
            true,
        )
        .await;
        assert_eq!(reply.status, StatusCode::OK);
        assert_eq!(
            parsed(&reply.body),
            json!({
                "hosts": [
                    {
                        "id": "h2",
                        "name": "h2-name",
                        "kind": "remote",
                        "created_at": 1,
                        "revoked_at": null,
                        "last_seen_at": null,
                        "activated_at": 11,
                        "finalized_at": 12,
                        "connected_host_name": null,
                        "provisioning_source": "user_invite",
                        "status": "active",
                        "placeable": true,
                        "creator_user_id": "u-requester",
                        "display_label": null
                    },
                    {
                        "id": "h1",
                        "name": "h1-name",
                        "kind": "remote",
                        "created_at": 1,
                        "revoked_at": null,
                        "last_seen_at": null,
                        "activated_at": 11,
                        "finalized_at": 12,
                        "connected_host_name": null,
                        "provisioning_source": "user_invite",
                        "status": "active",
                        "placeable": true,
                        "creator_user_id": "u-requester",
                        "display_label": null
                    }
                ]
            })
        );
        assert_eq!(reply.calls, 1);
    }

    /// An owner with no rows is a `200` empty list, never a refusal.
    #[tokio::test]
    async fn no_owned_computers_is_an_empty_list() {
        let reply = get_list(ListOutcome::Rows(vec![]), true).await;
        assert_eq!(reply.status, StatusCode::OK);
        assert_eq!(parsed(&reply.body), json!({ "hosts": [] }));
        assert_eq!(reply.calls, 1);
    }

    /// The principal is the perimeter's contribution; without it the route reads
    /// NOTHING and fails closed, rather than guessing a requester.
    #[tokio::test]
    async fn a_missing_principal_reads_nothing_and_fails_closed() {
        let reply = get_list(ListOutcome::Rows(vec![record("h1", REQUESTER)]), false).await;
        assert_eq!(reply.status, StatusCode::INTERNAL_SERVER_ERROR);
        assert_eq!(reply.body, "Internal Server Error");
        assert_eq!(reply.calls, 0);
    }

    #[tokio::test]
    async fn a_failed_read_is_the_frameworks_plain_500() {
        let reply = get_list(ListOutcome::Fails, true).await;
        assert_eq!(reply.status, StatusCode::INTERNAL_SERVER_ERROR);
        assert_eq!(reply.body, "Internal Server Error");
    }

    /// A row the owner-keyed narrowing offered that authorization then refuses is a
    /// fact-source drift — it must fail closed, not vanish from the list.
    #[tokio::test]
    async fn a_foreign_row_in_the_narrowing_is_a_500_not_a_quiet_drop() {
        let reply = get_list(
            ListOutcome::Rows(vec![
                record("h1", REQUESTER),
                record("h2", "u-someone-else"),
            ]),
            true,
        )
        .await;
        assert_eq!(reply.status, StatusCode::INTERNAL_SERVER_ERROR);
        assert_eq!(reply.body, "Internal Server Error");
    }
}
