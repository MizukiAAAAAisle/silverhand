//! `GET /api/server/info` — what this server BUILD is, before anyone has logged in.
//!
//! The one anonymous discovery face. A client reads it to decide whether it can talk
//! to this server at all: whether signup is open, how exposed the bind is, which
//! outbound daemon protocol the build speaks, and which application API epochs it
//! accepts. Everything here is fixed for the life of the process — there is no read
//! model, no probe and no clock.
//!
//! ## The three version numbers are generated, never restated
//!
//! `outbound_protocol_version` and the two epochs come from the shared admission
//! manifests through this crate's build script, the same constants the WebSocket
//! handshake and the REST epoch middleware enforce. A face that advertises a number
//! it spelled itself can drift from the gate that enforces it, and the failure mode is
//! the worst kind: a client is told it is compatible and then refused. The build script
//! also refuses a manifest whose minima exceed the current epoch, so this face has no
//! unsatisfiable range to guard against.
//!
//! This advertisement is DISCOVERY only. Nothing admits or refuses on the strength of
//! it; the transports remain the authoritative gates.

use axum::{
    Json, Router, extract::State, response::IntoResponse, response::Response, routing::get,
};
use serde::Serialize;

use crate::{
    application_orchestration::daemon_delivery::OUTBOUND_PROTOCOL_VERSION,
    foundation::{
        bind_address_scope::BindAddressScope,
        scope_event_transport::{DESKTOP_SERVER_API_EPOCH, MINIMUM_CLIENT_API_EPOCH},
    },
};

pub const SERVER_INFO_PATH: &str = "/api/server/info";

/// The boot facts this face advertises. Both are settled before the listener opens and
/// neither changes afterwards, so they are values rather than ports: `signup_enabled`
/// is read-only configuration, and the bind scope is classified once at boot so this
/// response and the boot WARN can never describe different exposure.
#[derive(Clone, Copy, Debug)]
pub struct ServerAdvertisement {
    pub signup_enabled: bool,
    pub password_recovery_enabled: bool,
    pub account_deletion_enabled: bool,
    pub bind_address_scope: BindAddressScope,
}

pub fn router(advertisement: ServerAdvertisement) -> Router {
    Router::new()
        .route(SERVER_INFO_PATH, get(server_info))
        .with_state(advertisement)
}

async fn server_info(State(advertisement): State<ServerAdvertisement>) -> Response {
    Json(ServerInfoResponse {
        signup_enabled: advertisement.signup_enabled,
        features: ServerFeatures {
            signup_enabled: advertisement.signup_enabled,
            password_recovery_enabled: advertisement.password_recovery_enabled,
            account_deletion_enabled: advertisement.account_deletion_enabled,
        },
        bind_address_scope: advertisement.bind_address_scope.as_str(),
        outbound_protocol_version: OUTBOUND_PROTOCOL_VERSION,
        desktop_api: DesktopApiAdvertisement {
            current_epoch: DESKTOP_SERVER_API_EPOCH,
            minimum_client_epoch: MINIMUM_CLIENT_API_EPOCH,
        },
    })
    .into_response()
}

/// The wire body, field-for-field the TypeScript registrar.
///
/// Every field is emitted unconditionally. `ServerInfoSchema` marks three of them
/// optional so a NEW client can still parse an OLD server; a current server has no
/// reason to omit any of them, and the product's registrar does not.
#[derive(Serialize)]
struct ServerInfoResponse {
    /// Kept for clients that predate `features`; always equals `features.signup_enabled`.
    signup_enabled: bool,
    features: ServerFeatures,
    bind_address_scope: &'static str,
    outbound_protocol_version: u32,
    desktop_api: DesktopApiAdvertisement,
}

/// Capabilities a client may offer. Discovery only: every route still enforces its own.
#[derive(Serialize)]
struct ServerFeatures {
    signup_enabled: bool,
    password_recovery_enabled: bool,
    account_deletion_enabled: bool,
}

#[derive(Serialize)]
struct DesktopApiAdvertisement {
    current_epoch: u32,
    minimum_client_epoch: u32,
}

#[cfg(test)]
mod tests {
    use axum::{
        body::{Body, to_bytes},
        http::{Request, StatusCode},
    };
    use serde_json::{Value, json};
    use tower::ServiceExt;

    use super::*;

    async fn get(advertisement: ServerAdvertisement) -> (StatusCode, Value) {
        let response = router(advertisement)
            .oneshot(Request::get(SERVER_INFO_PATH).body(Body::empty()).unwrap())
            .await
            .unwrap();
        let status = response.status();
        let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        (status, serde_json::from_slice(&body).unwrap())
    }

    /// The whole body, including the version numbers read from the generated
    /// constants — so this asserts the SHAPE without becoming a second place that says
    /// what the epochs are.
    #[tokio::test]
    async fn the_advertisement_is_the_boot_facts_plus_the_builds_own_versions() {
        let (status, body) = get(ServerAdvertisement {
            signup_enabled: true,
            password_recovery_enabled: false,
            account_deletion_enabled: false,
            bind_address_scope: BindAddressScope::Loopback,
        })
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(
            body,
            json!({
                "signup_enabled": true,
                "features": {
                    "signup_enabled": true,
                    "password_recovery_enabled": false,
                    "account_deletion_enabled": false
                },
                "bind_address_scope": "loopback",
                "outbound_protocol_version": OUTBOUND_PROTOCOL_VERSION,
                "desktop_api": {
                    "current_epoch": DESKTOP_SERVER_API_EPOCH,
                    "minimum_client_epoch": MINIMUM_CLIENT_API_EPOCH
                }
            })
        );
    }

    /// The two boot facts are reported as configured — the combination
    /// `signup_enabled` + a non-loopback scope is precisely what ops tooling reads to
    /// decide a server is open to strangers, so neither may be normalised away.
    #[tokio::test]
    async fn a_public_bind_with_open_signup_is_reported_as_such() {
        let (_, body) = get(ServerAdvertisement {
            signup_enabled: true,
            password_recovery_enabled: true,
            account_deletion_enabled: true,
            bind_address_scope: BindAddressScope::Public,
        })
        .await;
        assert_eq!(body["signup_enabled"], true);
        assert_eq!(body["bind_address_scope"], "public");

        assert_eq!(body["features"]["password_recovery_enabled"], true);

        let (_, closed) = get(ServerAdvertisement {
            signup_enabled: false,
            password_recovery_enabled: false,
            account_deletion_enabled: false,
            bind_address_scope: BindAddressScope::Lan,
        })
        .await;
        assert_eq!(closed["signup_enabled"], false);
        assert_eq!(closed["features"]["signup_enabled"], false);
        assert_eq!(closed["bind_address_scope"], "lan");
    }
}
