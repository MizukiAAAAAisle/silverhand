//! `POST /api/hosts/{id}/disconnect` — availability-only connection kick.

use axum::{
    Json, Router,
    extract::{Extension, Path, State},
    response::{IntoResponse, Response},
    routing::post,
};
use serde::Serialize;
use silverhand_backend_core::{
    host_runtime::aftermath::{CustodyEffectFailure, DaemonConnectionControl},
    host_runtime::read::{ComputerReadModel, find_owned_computer},
    identity::{HostId, UserId},
};

use crate::{
    daemon_delivery::{DaemonDeliveryController, DaemonRegistryError},
    error,
    foundation::daemon_transport::{DaemonConnectionAuthority, HostCloseReason},
    host_runtime::host_wire::{HostDto, host_wire},
};

use super::{computer_times_are_js_safe, internal_error};

pub const HOST_DISCONNECT_PATH: &str = "/api/hosts/{id}/disconnect";

#[derive(Clone)]
pub struct DaemonConnectionControlHandle {
    authority: DaemonConnectionAuthority,
}

impl DaemonConnectionControlHandle {
    pub(crate) fn new(authority: DaemonConnectionAuthority) -> Self {
        Self { authority }
    }

    pub fn disconnect_user_managed(&self, computer: &HostId) -> Result<bool, DaemonRegistryError> {
        self.authority
            .request_host_close(computer, HostCloseReason::UserManaged)
    }
}

impl DaemonConnectionControl for DaemonConnectionControlHandle {
    async fn disconnect(&self, computer: HostId) -> Result<(), CustodyEffectFailure> {
        self.authority
            .request_host_close(&computer, HostCloseReason::Revoked)
            .map(|_| ())
            .map_err(CustodyEffectFailure::from_source)
    }
}

impl DaemonDeliveryController {
    pub fn connection_control(&self) -> DaemonConnectionControlHandle {
        DaemonConnectionControlHandle::new(self.connection_authority())
    }
}

#[derive(Clone)]
struct DisconnectState<R> {
    computers: R,
    connections: DaemonConnectionControlHandle,
}

pub fn router<R>(computers: R, connections: DaemonConnectionControlHandle) -> Router
where
    R: ComputerReadModel,
{
    Router::new()
        .route(HOST_DISCONNECT_PATH, post(disconnect::<R>))
        .with_state(DisconnectState {
            computers,
            connections,
        })
}

async fn disconnect<R>(
    Path(raw_host): Path<String>,
    principal: Option<Extension<UserId>>,
    State(state): State<DisconnectState<R>>,
) -> Response
where
    R: ComputerReadModel,
{
    let Some(Extension(requester)) = principal else {
        tracing::error!("host-disconnect route reached without its human principal fact");
        return internal_error();
    };
    let Ok(host) = HostId::parse(raw_host) else {
        return not_found();
    };
    let record = match state.computers.read_computer(host.clone()).await {
        Ok(record) => record,
        Err(cause) => {
            tracing::error!(error_chain = %error::describe(&cause), "host-disconnect read failed");
            return internal_error();
        }
    };
    let Some(owned) = find_owned_computer(&requester, record) else {
        return not_found();
    };
    let record = owned.record();
    if record.revoked_at.is_some() {
        return coded("host has been revoked", "host_revoked", 409);
    }
    if !record.is_user_managed() {
        return coded(
            "disconnect is only supported for active user-managed computers",
            "provisioning_source_not_supported",
            409,
        );
    }
    if record.finalized_at.is_none() {
        return coded("host is not active", "host_not_active", 409);
    }
    if !computer_times_are_js_safe(record) {
        tracing::error!(host_id = %host.as_str(), "host timestamps are not JS-safe");
        return internal_error();
    }
    let disconnected = match state.connections.disconnect_user_managed(&host) {
        Ok(disconnected) => disconnected,
        Err(cause) => {
            tracing::warn!(error = %cause, host_id = %host.as_str(), "user-managed disconnect failed");
            return coded("disconnect failed", "disconnect_failed", 502);
        }
    };
    Json(DisconnectResponse {
        host_id: host.as_str().to_owned(),
        host: host_wire(record),
        disconnected,
    })
    .into_response()
}

#[derive(Serialize)]
struct DisconnectResponse {
    host_id: String,
    host: HostDto,
    disconnected: bool,
}

fn not_found() -> Response {
    coded("host not found", "host_not_found", 404)
}

fn coded(message: &'static str, code: &'static str, status: u16) -> Response {
    let status = axum::http::StatusCode::from_u16(status).expect("static status");
    (
        status,
        Json(serde_json::json!({ "error": message, "error_code": code })),
    )
        .into_response()
}
