use super::*;
use axum::{body::{Body, to_bytes}, http::Request};
use silverhand_backend_core::{
    identity::{ConversationId, UserId, WorkspaceId},
    messaging::collaboration::{
        attention_preference::ChannelAttentionMode,
        attention_projection::{
            AttentionCount, ChannelAttentionTier, WorkspaceAttentionCount,
            WorkspaceAttentionModes,
        },
    },
};
use std::{collections::BTreeSet, convert::Infallible, sync::{Arc, atomic::{AtomicUsize, Ordering}}};
use tower::ServiceExt;

#[derive(Clone)]
struct Ports {
    setup: &'static str,
    calls: Arc<AtomicUsize>,
}

impl Ports {
    fn new(setup: &'static str) -> Self {
        Self {
            setup,
            calls: Arc::new(AtomicUsize::new(0)),
        }
    }
}

impl AttentionProjectionPort for Ports {
    type Error = Infallible;

    async fn badges(&self, _: &UserId) -> Result<AttentionBadgeRollup, Self::Error> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        if self.setup == "tiered" || self.setup == "tiered_unmuted" {
            let count = if self.setup == "tiered" { 1 } else { 2 };
            Ok(AttentionBadgeRollup::projected(
                vec![WorkspaceAttentionCount::projected(
                    WorkspaceId::parse("w").unwrap(),
                    AttentionCount::new(count).unwrap(),
                )],
                if self.setup == "tiered" {
                    vec![WorkspaceId::parse("w").unwrap()]
                } else {
                    vec![]
                },
            )
            .unwrap())
        } else {
            Ok(AttentionBadgeRollup::projected(vec![], vec![]).unwrap())
        }
    }

    async fn modes(
        &self,
        _: &UserId,
        workspace: &WorkspaceId,
    ) -> Result<Result<WorkspaceAttentionModes, AttentionModesRefusal>, Self::Error> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        if self.setup != "coordinate"
            && ((self.setup != "tiered" && self.setup != "tiered_unmuted")
                || workspace.as_str() != "w")
        {
            return Ok(Err(AttentionModesRefusal::Forbidden));
        }
        let muted = self.setup == "tiered";
        Ok(Ok(WorkspaceAttentionModes::projected(
            muted,
            vec![
                ChannelAttentionTier::projected(
                    ConversationId::parse("c-a").unwrap(),
                    ChannelAttentionMode::Mentions,
                    AttentionCount::new(1).unwrap(),
                ),
                ChannelAttentionTier::projected(
                    ConversationId::parse("c-c").unwrap(),
                    ChannelAttentionMode::Mute,
                    AttentionCount::new(0).unwrap(),
                ),
                ChannelAttentionTier::projected(
                    ConversationId::parse("c-b").unwrap(),
                    ChannelAttentionMode::All,
                    AttentionCount::new(0).unwrap(),
                ),
            ],
        )))
    }
}

async fn call(port: Ports, path: &str, auth: bool) -> (u16, Value) {
    let mut request = Request::builder().uri(path).body(Body::empty()).unwrap();
    if auth {
        request.extensions_mut().insert(UserId::parse("local").unwrap());
    }
    let response = router(port).oneshot(request).await.unwrap();
    let status = response.status().as_u16();
    let body = serde_json::from_slice(
        &to_bytes(response.into_body(), usize::MAX).await.unwrap(),
    )
    .unwrap();
    (status, body)
}

#[tokio::test]
async fn production_router_consumes_the_ts_signed_two_surface_closed_set() {
    let fixture: Value = serde_json::from_str(include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../../packages/backend/tests/fixtures/attention-projection-wire.json"
    )))
    .unwrap();
    let mut surfaces = BTreeSet::new();
    for entry in fixture.as_array().unwrap() {
        let setup = match entry["setup"].as_str().unwrap() {
            "tiered" => "tiered",
            "tiered_unmuted" => "tiered_unmuted",
            "nonmember" => "nonmember",
            _ => "empty",
        };
        let (status, body) = call(Ports::new(setup), entry["path"].as_str().unwrap(), true).await;
        assert_eq!(status, entry["status"].as_u64().unwrap() as u16, "{}", entry["name"]);
        assert_eq!(body, entry["body"], "{}", entry["name"]);
        surfaces.insert(entry["surface"].as_str().unwrap());
    }
    assert_eq!(surfaces, BTreeSet::from(["badges", "modes"]));
    assert_eq!(fixture.as_array().unwrap().len(), 11);
}

#[tokio::test]
async fn authentication_refusal_reaches_no_projection() {
    let port = Ports::new("tiered");
    let calls = port.calls.clone();
    let (status, body) = call(port, BADGES_PATH, false).await;
    assert_eq!(status, 500);
    assert_eq!(body, json!({"error":"internal error"}));
    assert_eq!(calls.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn modes_wire_uses_the_admitted_request_coordinate_not_a_port_return_channel() {
    let (status, body) = call(
        Ports::new("coordinate"),
        "/api/attention/modes?workspace_id=requested-b",
        true,
    )
    .await;
    assert_eq!(status, 200);
    assert_eq!(body["workspace_id"], "requested-b");
}
