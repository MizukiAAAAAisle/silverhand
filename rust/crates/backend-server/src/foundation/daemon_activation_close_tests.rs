//! Real websocket cancellation while activation is blocked after hydration.
use super::*;
use futures_util::{SinkExt, StreamExt};
use tokio_tungstenite::{
    connect_async,
    tungstenite::{Message as ClientMessage, client::IntoClientRequest},
};

#[derive(Default)]
struct BlockedActivation {
    entered: Notify,
    released: Notify,
}

impl DaemonHostAuthentication for BlockedActivation {
    fn authenticate<'a>(
        &'a self,
        _: String,
        _: i64,
    ) -> Pin<
        Box<
            dyn Future<Output = Result<Option<AuthenticatedDaemonHost>, DaemonOwnerFailure>>
                + Send
                + 'a,
        >,
    > {
        Box::pin(async {
            Ok(Some(AuthenticatedDaemonHost {
                host_id: "test-host".into(),
                owner_user_id: UserId::parse("test-user").unwrap(),
                credential_id: "test-credential".into(),
            }))
        })
    }

    fn activate<'a>(
        &'a self,
        _: &'a str,
        _: &'a UserId,
        _: &'a str,
        _: i64,
    ) -> Pin<Box<dyn Future<Output = Result<bool, DaemonOwnerFailure>> + Send + 'a>> {
        Box::pin(async {
            self.entered.notify_one();
            std::future::pending().await
        })
    }
}

impl DaemonRuntimeHydration for BlockedActivation {
    fn hydrate<'a>(
        &'a self,
        _: AttachedHostDataPlane,
    ) -> Pin<Box<dyn Future<Output = Result<(), DaemonOwnerFailure>> + Send + 'a>> {
        Box::pin(async { Ok(()) })
    }
}

impl DaemonProtocolAdmission for BlockedActivation {
    fn incompatible(&self, _: &str, _: &str, _: u32, _: u32, _: i64) {
        panic!("valid protocol")
    }

    fn attached(&self, _: &str) {
        panic!("cancelled activation must not announce admission")
    }
}

impl DaemonHostReadyEffect for BlockedActivation {
    fn attached(&self, _: &HostId, _: &str) {
        panic!("cancelled activation must not start ready effects")
    }
}

impl DaemonStatusSeedEffect for BlockedActivation {
    fn attached(
        &self,
        _: HostId,
        _: DaemonInstanceId,
        _: String,
        _: UserId,
        _: DaemonConnectionAuthority,
    ) {
        panic!("cancelled activation must not seed status")
    }
}

impl DaemonRuntimeEventEffects for BlockedActivation {
    fn handle<'a>(
        &'a self,
        _: &'a str,
        _: &'a str,
        _: &'a DaemonInstanceId,
        _: String,
        _: Value,
    ) -> Pin<Box<dyn Future<Output = DaemonRuntimeEventDisposition> + Send + 'a>> {
        panic!("no runtime events expected")
    }

    fn detached(&self, _: &str, _: &DaemonInstanceId, _: &str) {
        // Compatible but not attached connections still run normal cleanup.
    }

    fn release_connection<'a>(
        &'a self,
        _: &'a str,
    ) -> Pin<Box<dyn Future<Output = ()> + Send + 'a>> {
        Box::pin(async { self.released.notify_one() })
    }
}

async fn close_during_activation(reason: HostCloseReason, expected_reason: &str) {
    let transport = DaemonTransport::new(DaemonDeliveryConfig::production()).unwrap();
    let effects = Arc::new(BlockedActivation::default());
    let router = transport.router(
        effects.clone(),
        effects.clone(),
        effects.clone(),
        effects.clone(),
        effects.clone(),
        effects.clone(),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });

    let result = tokio::time::timeout(Duration::from_secs(5), async {
        let mut request = format!("ws://{address}{HOST_WEBSOCKET_PATH}")
            .into_client_request()
            .unwrap();
        request
            .headers_mut()
            .insert("authorization", "Bearer isolated-test".parse().unwrap());
        let (mut socket, _) = connect_async(request).await.unwrap();
        socket
            .send(ClientMessage::Text(
                json!({
                    "direction":"daemon_to_server", "type":"event", "kind":"ready",
                    "protocol_version":OUTBOUND_PROTOCOL_VERSION, "daemon_version":"test",
                    "daemon_id":"activation-test", "instance_id":"activation-instance",
                    "host_descriptor":{"name":"Test computer", "kind":"remote"},
                    "capabilities":[], "daemon_pid":7, "started_at":100
                })
                .to_string()
                .into(),
            ))
            .await
            .unwrap();

        // Wait for activation itself: no sleep or pre-hydration cancellation.
        effects.entered.notified().await;
        let host = HostId::parse("test-host").unwrap();
        assert!(
            transport
                .controller()
                .connection_authority()
                .request_host_close(&host, reason)
                .unwrap()
        );
        let frame = socket.next().await.unwrap().unwrap();
        let ClientMessage::Close(Some(close)) = frame else {
            panic!("expected terminal close, received {frame:?}");
        };
        assert_eq!(u16::from(close.code), 1001);
        assert_eq!(close.reason, expected_reason);

        effects.released.notified().await;
        assert!(
            transport
                .registry
                .attachment(host.as_str())
                .unwrap()
                .is_none()
        );
        assert!(
            transport
                .registry
                .slot_connection_id(host.as_str())
                .unwrap()
                .is_none()
        );
    })
    .await;

    server.abort();
    let _ = server.await;
    result.expect("activation close did not finish");
}

#[tokio::test]
async fn revoked_during_activation_preserves_terminal_close_and_skips_attachment_effects() {
    close_during_activation(HostCloseReason::Revoked, "host_revoked").await;
}

#[tokio::test]
async fn disconnect_during_activation_preserves_terminal_close_and_skips_attachment_effects() {
    close_during_activation(HostCloseReason::UserManaged, "host_disconnected").await;
}
